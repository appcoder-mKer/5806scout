// One-time migration step: put the approval gate back to zero.
//
//   npm run reset-approvals -- --keep 5806            # dry run, prints the plan
//   npm run reset-approvals -- --keep 5806 --apply    # writes it
//
// src/lib/membership.ts is meant to close over the existing roster the moment
// it deploys: every profile written before it shipped has no `status`, and both
// memberStatus() and firestore.rules read a missing one as "pending". An app
// that was open to anyone can't tell which of its accounts were ever vouched
// for, so all of them get re-approved by hand.
//
// That didn't happen. /owner's "Teams with no admin" list was cleared in one
// pass — nineteen teams founded inside forty seconds — which handed each team's
// only admin seat to whoever had self-registered for it under the old open
// signup, and left the operator nothing to review. This script undoes that pass
// and hands every team back to the queue.
//
// WHAT IT DOES NOT UNDO
//
// Not the roles. foundTeam() writes `role: 'admin'` alongside the status, but
// most of those accounts were already admins from the old ADMIN_SIGNUP_CODE
// flow, so demoting them would be inventing a past that never happened. It
// doesn't matter: firestore.rules gates every read and write on isApproved(),
// and isAdminOfTeam() is isSameTeam() plus a role check — so a pending admin
// is exactly as shut out as a pending scout. Status alone is the whole gate.
//
// THE ONE TEAM THAT STAYS IN
//
// --keep names the team that runs the app, which can't be locked out while it
// does the letting-in. Only that team's ADMINS are approved; its scouts queue
// behind them like everyone else's, which puts the new approval flow in front
// of the people best placed to notice if it's broken.
//
// Runs on the service account (src/lib/googleServiceAccount.ts) because it
// writes `status`, the one field firestore.rules pins against its own owner.
// That credential outranks the rules, which is why this is a script you run
// once and read first rather than anything the app can reach.
//
// Runs on Node 22.6+ (built-in TypeScript type stripping; Node 24 needs no
// flag). Reads FIREBASE_SERVICE_ACCOUNT_KEY and NEXT_PUBLIC_FIREBASE_PROJECT_ID
// from .env.local, which the npm script passes via --env-file.

import {
  getAccessToken,
  readServiceAccount,
} from "../src/lib/googleServiceAccount.ts";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const keepTeam = args[args.indexOf("--keep") + 1];

if (!args.includes("--keep") || !keepTeam || keepTeam.startsWith("--")) {
  console.error(
    "Usage: npm run reset-approvals -- --keep <team-number> [--apply]\n" +
      "Without --apply it prints what it would do and writes nothing.",
  );
  process.exit(1);
}

const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
if (!projectId) {
  console.error(
    "Missing NEXT_PUBLIC_FIREBASE_PROJECT_ID — run this through `npm run reset-approvals`, which loads .env.local.",
  );
  process.exit(1);
}

const account = readServiceAccount();
if (!account) {
  console.error(
    "Missing or unreadable FIREBASE_SERVICE_ACCOUNT_KEY. This script writes `status`, which only the service account may do.",
  );
  process.exit(1);
}

const DOCS = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
const accessToken = await getAccessToken(account);
const authorized = { Authorization: `Bearer ${accessToken}` };

interface RestDocument {
  name: string;
  fields?: Record<string, { stringValue?: string; timestampValue?: string }>;
}

/** Every document in a collection, following pageToken to the end. */
async function listAll(collection: string): Promise<RestDocument[]> {
  const out: RestDocument[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${DOCS}/${collection}`);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: authorized });
    if (!res.ok) throw new Error(`Could not read ${collection} (${res.status}).`);
    const body = (await res.json()) as {
      documents?: RestDocument[];
      nextPageToken?: string;
    };
    out.push(...(body.documents ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return out;
}

const id = (doc: RestDocument): string => doc.name.split("/").pop() ?? "";
const str = (doc: RestDocument, key: string): string | undefined =>
  doc.fields?.[key]?.stringValue;

/**
 * Write one field, or clear it.
 *
 * An updateMask naming a field the body omits is how the REST API deletes it —
 * which is what un-founding a team needs, since ApprovalGate tests claimedAt
 * for presence and a falsy value would still be present.
 */
async function patch(
  path: string,
  fieldPath: string,
  value?: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${DOCS}/${path}?updateMask.fieldPaths=${fieldPath}`, {
    method: "PATCH",
    headers: { ...authorized, "Content-Type": "application/json" },
    body: JSON.stringify(value ? { fields: { [fieldPath]: value } } : {}),
  });
  if (!res.ok) {
    throw new Error(`Could not write ${path}.${fieldPath} (${res.status}).`);
  }
}

async function remove(path: string): Promise<void> {
  const res = await fetch(`${DOCS}/${path}`, {
    method: "DELETE",
    headers: authorized,
  });
  if (!res.ok) throw new Error(`Could not delete ${path} (${res.status}).`);
}

const [users, teams, claims] = await Promise.all([
  listAll("users"),
  listAll("teams"),
  listAll("teamClaims"),
]);

if (!teams.some((t) => id(t) === keepTeam)) {
  console.error(
    `There is no teams/${keepTeam} document. Check the number before running this — ` +
      "keeping the wrong team would lock every account out with nobody able to approve anyone.",
  );
  process.exit(1);
}

// An admin of the kept team is the only account that stays approved. Everyone
// else — including that team's own scouts — goes back to the queue.
//
// Except a denial, which stays a denial. This script exists to undo approvals
// that were never really decisions; a "denied" is the opposite of that — an
// admin looked at someone and said no. Sweeping it back to pending would put
// them in front of a queue they have already been turned away from, and hide
// that it ever happened.
function targetStatus(user: RestDocument): "approved" | "pending" | "denied" {
  if (str(user, "status") === "denied") return "denied";
  const isKept = str(user, "teamId") === keepTeam;
  return isKept && str(user, "role") === "admin" ? "approved" : "pending";
}

const statusChanges = users.flatMap((u) => {
  // Absent means pending, matching memberStatus() and firestore.rules.
  const from = str(u, "status") ?? "pending";
  const to = targetStatus(u);
  return from === to ? [] : [{ user: u, from, to }];
});

// claimedAt marks a team as founded — the stamp a pending member reads to know
// whether to file a claim or simply wait for one of their own admins. Only the
// kept team keeps it.
const teamChanges = teams.flatMap((t) => {
  const founded = Boolean(t.fields?.claimedAt);
  const shouldBeFounded = id(t) === keepTeam;
  return founded === shouldBeFounded ? [] : [{ team: t, founded }];
});

// An approved claim can't be re-filed — firestore.rules lets a founder resend
// evidence only while their claim is not already approved. Un-founding a team
// without clearing its claim would strand whoever files next.
const staleClaims = claims.filter((c) => id(c) !== keepTeam);

const keptAdmins = users.filter(
  (u) => str(u, "teamId") === keepTeam && str(u, "role") === "admin",
);
if (keptAdmins.length === 0) {
  console.error(
    `Nobody on team ${keepTeam} has role "admin", so keeping it would grandfather in nobody ` +
      "and leave no one able to approve anyone. Refusing to run.",
  );
  process.exit(1);
}

console.log(
  `${users.length} profiles across ${teams.length} teams. Keeping team ${keepTeam} (${keptAdmins.length} admins).\n`,
);

console.log(`Profiles to change (${statusChanges.length}):`);
for (const { user, from, to } of statusChanges) {
  const who = `${str(user, "fullName") ?? "(no name)"} <${str(user, "email") ?? "(no email)"}>`;
  console.log(
    `  team ${(str(user, "teamId") ?? "?").padEnd(6)} ${(str(user, "role") ?? "scout").padEnd(5)} ${who.padEnd(48)} ${from} -> ${to}`,
  );
}
if (statusChanges.length === 0) console.log("  (none)");

console.log(`\nTeams to un-found (${teamChanges.length}):`);
for (const { team, founded } of teamChanges) {
  console.log(`  teams/${id(team)}.claimedAt ${founded ? "-> cleared" : "-> now"}`);
}
if (teamChanges.length === 0) console.log("  (none)");

console.log(`\nStale claims to delete (${staleClaims.length}):`);
for (const c of staleClaims) {
  console.log(`  teamClaims/${id(c)} [${str(c, "status") ?? "?"}]`);
}
if (staleClaims.length === 0) console.log("  (none)");

console.log(
  `\nAfter this, /owner lists ${teams.length - 1} teams with no admin, waiting on you.`,
);

if (!apply) {
  console.log("\nDry run — nothing written. Re-run with --apply to commit this.");
  process.exit(0);
}

for (const { user, to } of statusChanges) {
  await patch(`users/${id(user)}`, "status", { stringValue: to });
}
console.log(`\nRewrote ${statusChanges.length} profile statuses.`);

for (const { team, founded } of teamChanges) {
  await patch(
    `teams/${id(team)}`,
    "claimedAt",
    founded ? undefined : { timestampValue: new Date().toISOString() },
  );
}
console.log(`Rewrote claimedAt on ${teamChanges.length} teams.`);

for (const c of staleClaims) {
  await remove(`teamClaims/${id(c)}`);
}
console.log(`Deleted ${staleClaims.length} stale claims.`);

console.log(
  `\nDone. Team ${keepTeam} is in; every other team is back in the queue at /owner.`,
);
