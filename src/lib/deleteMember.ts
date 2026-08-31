import { config } from "@/lib/config";
import { getAccessToken, readServiceAccount } from "@/lib/googleServiceAccount";

// Permanent removal of a teammate, the counterpart to inviteScout.ts.
//
// "Permanent" is the point: both the Firebase Auth account and the
// users/{uid} profile go, which frees the email address so the person can
// sign up again or be invited back later. Deleting only the profile would
// strand the auth account and leave that email permanently unusable —
// accounts:signUp and the invite flow would both fail with EMAIL_EXISTS.
//
// An admin may delete themselves as well as a teammate, with one condition:
// the team must not be left without an admin. Nobody outside the team can
// hand out the role, so an adminless team is a dead end rather than an
// inconvenience — hence the last-admin guard below.
//
// Deleting another user's auth account is privileged, so unlike inviteScout
// this needs the service account (see googleServiceAccount.ts). The profile
// doc is deleted with that same token, which is why firestore.rules can keep
// `allow delete: if false` on users/{uid} — no client may ever delete a
// profile, only this route acting for a verified admin.

const IDENTITY_BASE = "https://identitytoolkit.googleapis.com/v1";

export class DeleteMemberError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function runQueryUrl(): string {
  return `https://firestore.googleapis.com/v1/projects/${config.firebase.projectId}/databases/(default)/documents:runQuery`;
}

function firestoreDocUrl(uid: string): string {
  // Encoded, not interpolated raw: this URL is handed to a DELETE that runs
  // with service-account credentials outranking firestore.rules, so a uid
  // carrying "/" or ".." must not be able to normalize into another
  // document's path. The route validates the shape too — belt and braces,
  // because the checks that happen to stop it today (the same-team guard,
  // identitytoolkit rejecting a non-uid) are incidental, not a boundary.
  return `https://firestore.googleapis.com/v1/projects/${config.firebase.projectId}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
}

interface MemberProfile {
  role: string;
  teamId: string;
  fullName: string;
  status: string;
}

/** Read a profile with the service account, so one lookup shape works for the
 *  caller and the target alike regardless of what rules would allow. */
async function getProfile(
  uid: string,
  accessToken: string,
): Promise<MemberProfile | null> {
  const res = await fetch(firestoreDocUrl(uid), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new DeleteMemberError("Could not load that member's profile.", 502);
  }
  const doc = (await res.json()) as {
    fields?: {
      role?: { stringValue?: string };
      teamId?: { stringValue?: string };
      fullName?: { stringValue?: string };
      status?: { stringValue?: string };
    };
  };
  return {
    role: doc.fields?.role?.stringValue ?? "",
    teamId: doc.fields?.teamId?.stringValue ?? "",
    fullName: doc.fields?.fullName?.stringValue ?? "",
    // Absent means pending, matching memberStatus() and the
    // .get('status','pending') default in firestore.rules.
    status: doc.fields?.status?.stringValue ?? "pending",
  };
}

/** Is there an admin on this team other than `uid`?
 *
 *  Asked only when an admin is deleting themselves. A team with no admin can
 *  never regain one — nobody left could promote anybody — so this is the
 *  check that stops the last admin walking out the door. Two results are
 *  enough to answer it: the caller is necessarily one of them, so a second
 *  row means somebody else can take over.
 */
async function otherAdminExists(
  teamId: string,
  uid: string,
  accessToken: string,
): Promise<boolean> {
  const res = await fetch(runQueryUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "users" }],
        where: {
          compositeFilter: {
            op: "AND",
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: "teamId" },
                  op: "EQUAL",
                  value: { stringValue: teamId },
                },
              },
              {
                fieldFilter: {
                  field: { fieldPath: "role" },
                  op: "EQUAL",
                  value: { stringValue: "admin" },
                },
              },
            ],
          },
        },
        limit: 2,
      },
    }),
  });
  if (!res.ok) {
    throw new DeleteMemberError(
      "Could not check who else administers this team — nothing was changed.",
      502,
    );
  }
  // runQuery streams result rows; rows carrying only a readTime (the "no
  // matches" shape) have no `document` and must not be counted.
  const rows = (await res.json()) as Array<{ document?: { name?: string } }>;
  return rows.some(
    (row) => row.document?.name && !row.document.name.endsWith(`/users/${uid}`),
  );
}

/** Resolve the caller's ID token to a uid, proving they are who they claim. */
async function resolveCallerUid(idToken: string): Promise<string> {
  const res = await fetch(
    `${IDENTITY_BASE}/accounts:lookup?key=${config.firebase.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    },
  );
  if (!res.ok) {
    throw new DeleteMemberError("Your session has expired — log in again.", 401);
  }
  const body = (await res.json()) as { users?: Array<{ localId: string }> };
  const uid = body.users?.[0]?.localId;
  if (!uid) {
    throw new DeleteMemberError("Your session has expired — log in again.", 401);
  }
  return uid;
}

export interface DeleteMemberResult {
  fullName: string;
}

export async function deleteMember(
  callerIdToken: string,
  targetUid: string,
): Promise<DeleteMemberResult> {
  const account = readServiceAccount();
  if (!account) {
    throw new DeleteMemberError(
      "Permanent deletion isn't configured on this deployment — set FIREBASE_SERVICE_ACCOUNT_KEY. You can still deactivate the member instead.",
      501,
    );
  }

  const callerUid = await resolveCallerUid(callerIdToken);

  let accessToken: string;
  try {
    accessToken = await getAccessToken(account);
  } catch {
    throw new DeleteMemberError(
      "Could not authenticate with Firebase — check FIREBASE_SERVICE_ACCOUNT_KEY.",
      502,
    );
  }

  const caller = await getProfile(callerUid, accessToken);
  // An admin still waiting on approval is not yet an admin — and this route
  // runs on the service account, which bypasses the rules that would otherwise
  // have caught it.
  if (
    !caller ||
    caller.role !== "admin" ||
    !caller.teamId ||
    caller.status !== "approved"
  ) {
    throw new DeleteMemberError("Only team admins can delete members.", 403);
  }

  const target = await getProfile(targetUid, accessToken);
  if (!target) {
    throw new DeleteMemberError("That member no longer exists.", 404);
  }
  // Same team only. A sister-team link pools scouting data, not roster
  // authority — each team's admin removes their own people.
  if (target.teamId !== caller.teamId) {
    throw new DeleteMemberError(
      "You can only delete members of your own team.",
      403,
    );
  }

  // Leaving the team yourself is allowed — walking out with the only set of
  // keys is not. Deleting another admin never needs this check: the caller is
  // an admin of the same team, so one always remains.
  if (
    callerUid === targetUid &&
    !(await otherAdminExists(caller.teamId, callerUid, accessToken))
  ) {
    throw new DeleteMemberError(
      "You're the only admin on this team. Make someone else an admin first, then delete your account.",
      409,
    );
  }

  // Auth account first: while it exists the email stays claimed, so failing
  // here must leave the profile in place rather than stranding a roster entry
  // nobody can log in as — the same ordering rule inviteScout.ts follows.
  const authRes = await fetch(
    `${IDENTITY_BASE}/projects/${config.firebase.projectId}/accounts:delete`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ localId: targetUid }),
    },
  );
  // A 404/USER_NOT_FOUND means the auth account was already gone; the profile
  // still needs clearing, so that isn't an error worth stopping for.
  if (!authRes.ok && authRes.status !== 404) {
    throw new DeleteMemberError(
      "Could not delete that member's login — nothing was changed.",
      502,
    );
  }

  const profileRes = await fetch(firestoreDocUrl(targetUid), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!profileRes.ok && profileRes.status !== 404) {
    // The login is already gone, so this can't be rolled back. Say so plainly
    // rather than reporting a clean delete over a half-finished one.
    throw new DeleteMemberError(
      "Their login was deleted but the roster entry could not be removed. Try again, or deactivate the leftover entry.",
      502,
    );
  }

  return { fullName: target.fullName };
}
