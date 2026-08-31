import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Rules tests for the sister-team link — the one place this app grants a
// signed-in user access to another team's data, and the one place a mistake
// either leaks a team's scouting or silently withholds it.
//
// The collections a linked pair pools are listed one by one in
// firestore.rules; the catch-all above them is same-team-only. That's the
// safe default, but it means a new pooled collection is easy to forget, which
// is exactly how pitScoutingMedia ended up shared in the app and not in the
// rules. This suite names every pooled collection so the next omission fails
// here instead of at an event.
//
// Needs the Firestore emulator: `npm run test:rules` starts one around it.

const PROJECT_ID = "scout-rules-test";

/** Collections a verified sister pair shares. */
const POOLED = [
  "pitScouting",
  "pitScoutingMedia",
  "matchScouting",
  "talkie",
] as const;

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  // Seeded with rules off: these are the documents the rules themselves read
  // (via get()) to decide anything at all.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    // teamA and teamB point at each other — a mutual, verified link.
    await setDoc(doc(db, "teams/teamA"), {
      teamNumber: "5806",
      sisterTeamId: "teamB",
    });
    await setDoc(doc(db, "teams/teamB"), {
      teamNumber: "9999",
      sisterTeamId: "teamA",
    });
    // teamC is unlinked, and teamD claims a link teamA never returns.
    await setDoc(doc(db, "teams/teamC"), { teamNumber: "1234" });
    await setDoc(doc(db, "teams/teamD"), {
      teamNumber: "4321",
      sisterTeamId: "teamA",
    });

    // Established members: approved is what everyone in these tests is unless
    // the test is about not being.
    const member = (teamId: string, role: string) => ({
      teamId,
      role,
      status: "approved",
    });
    await setDoc(doc(db, "users/alice"), member("teamA", "admin"));
    await setDoc(doc(db, "users/bob"), member("teamB", "scout"));
    await setDoc(doc(db, "users/bea"), member("teamB", "admin"));
    await setDoc(doc(db, "users/erin"), member("teamA", "scout"));
    await setDoc(doc(db, "users/carol"), member("teamC", "admin"));
    await setDoc(doc(db, "users/dave"), member("teamD", "admin"));

    // Waiting at the gate. Pat has a status and is pending; quinn's profile
    // predates the field entirely, which must amount to the same thing.
    await setDoc(doc(db, "users/pat"), {
      teamId: "teamA",
      role: "scout",
      status: "pending",
    });
    await setDoc(doc(db, "users/quinn"), { teamId: "teamA", role: "scout" });
    // Role without approval is not authority.
    await setDoc(doc(db, "users/mallory"), {
      teamId: "teamA",
      role: "admin",
      status: "pending",
    });

    // The operator. Created by hand in the console in production; there is no
    // code path anywhere that writes one.
    await setDoc(doc(db, "owners/olive"), { createdAt: 0 });
    await setDoc(doc(db, "users/olive"), {
      teamId: "teamC",
      role: "scout",
      status: "approved",
    });

    // teamA's scouting data, which teamB should reach and the others must not.
    for (const collection of POOLED) {
      await setDoc(doc(db, `teams/teamA/${collection}/doc1`), { seeded: true });
    }
    await setDoc(doc(db, "teams/teamA/config/scoutDuties"), { seeded: true });
    await setDoc(doc(db, "teams/teamA/config/picklist"), { seeded: true });
    // Not pooled: a pair shares what it observed, not the plan each side drew.
    await setDoc(doc(db, "teams/teamA/strategyBoards/qm1"), { seeded: true });
    // Talkie requests carry a poster, who may withdraw their own.
    await setDoc(doc(db, "teams/teamA/talkie/byErin"), { createdByUid: "erin" });
    await setDoc(doc(db, "teams/teamA/talkie/byBob"), { createdByUid: "bob" });
  });
});

const as = (uid: string) => testEnv.authenticatedContext(uid).firestore();

describe("a linked sister team", () => {
  it.each(POOLED)("reads teamA's %s", async (collection) => {
    await assertSucceeds(
      getDoc(doc(as("bob"), `teams/teamA/${collection}/doc1`)),
    );
  });

  it.each(POOLED)("writes teamA's %s", async (collection) => {
    await setDoc(doc(as("bob"), `teams/teamA/${collection}/doc2`), { x: 1 });
  });

  it("reads teamA's shared config", async () => {
    await assertSucceeds(
      getDoc(doc(as("bob"), "teams/teamA/config/scoutDuties")),
    );
  });

  it("never reads teamA's picklist — each team ranks alone", async () => {
    await assertFails(getDoc(doc(as("bob"), "teams/teamA/config/picklist")));
  });

  it("never reads teamA's strategy boards — each team plans alone", async () => {
    await assertFails(getDoc(doc(as("bob"), "teams/teamA/strategyBoards/qm1")));
  });

  it("never writes a strategy board into teamA", async () => {
    await assertFails(
      setDoc(doc(as("bob"), "teams/teamA/strategyBoards/qm2"), { x: 1 }),
    );
  });

  it("is not let in by being the sister team's admin either", async () => {
    await assertFails(getDoc(doc(as("bea"), "teams/teamA/strategyBoards/qm1")));
    await assertFails(
      deleteDoc(doc(as("bea"), "teams/teamA/strategyBoards/qm1")),
    );
  });
});

describe("a team's own strategy boards", () => {
  it("are read and written by its own members", async () => {
    await assertSucceeds(
      getDoc(doc(as("erin"), "teams/teamA/strategyBoards/qm1")),
    );
    await assertSucceeds(
      setDoc(doc(as("erin"), "teams/teamA/strategyBoards/qm3"), { x: 1 }),
    );
  });

  it("are not reachable by an unlinked team", async () => {
    await assertFails(
      getDoc(doc(as("carol"), "teams/teamA/strategyBoards/qm1")),
    );
  });
});

describe("an unlinked team", () => {
  it.each(POOLED)("cannot read teamA's %s", async (collection) => {
    await assertFails(getDoc(doc(as("carol"), `teams/teamA/${collection}/doc1`)));
  });

  it("cannot write teamA's scouting data", async () => {
    await assertFails(
      setDoc(doc(as("carol"), "teams/teamA/pitScouting/doc2"), { x: 1 }),
    );
  });
});

describe("a one-sided link", () => {
  // teamD's doc claims teamA as its sister; teamA's doc does not agree. Only
  // a mutual link may grant anything, or a team could help itself to another's
  // data by writing one field on its own doc.
  it.each(POOLED)("grants nothing on teamA's %s", async (collection) => {
    await assertFails(getDoc(doc(as("dave"), `teams/teamA/${collection}/doc1`)));
  });
});

// A team may have any number of admins, and any of them may arrive through
// signup rather than being promoted. What must stay shut is self-promotion —
// the rules are the only thing stopping a scout typing themselves a new role.
describe("who may become an admin", () => {
  it("no longer lets anyone sign up as an admin at all", async () => {
    // This test used to assert the opposite — that a second admin could just
    // sign up for a team that already had one — and that was the hole: the
    // team number is printed on the robot, so "knows the number" was the only
    // qualification anyone needed to become that team's admin.
    //
    // Admin is now granted only: by the operator to a team's founder, or by an
    // existing admin promoting a teammate (both covered below).
    await assertFails(
      setDoc(doc(as("frank"), "users/frank"), {
        teamId: "teamC",
        role: "admin",
        active: true,
      }),
    );
  });

  it("still refuses a profile created for somebody else", async () => {
    await assertFails(
      setDoc(doc(as("frank"), "users/mallory"), {
        teamId: "teamC",
        role: "admin",
        active: true,
      }),
    );
  });

  it("never lets a scout promote themselves", async () => {
    await assertFails(
      setDoc(doc(as("erin"), "users/erin"), { teamId: "teamA", role: "admin" }),
    );
  });

  it("lets an admin promote a teammate", async () => {
    await assertSucceeds(
      setDoc(doc(as("alice"), "users/erin"), { teamId: "teamA", role: "admin" }),
    );
  });

  // A scout CAN write their own team doc — the recursive `match /{document=**}`
  // nested under /teams/{teamId} matches the team doc itself, not just its
  // subcollections. That is worth knowing, but it grants no authority: the
  // role that gates everything lives on users/{uid}, which the same scout
  // cannot touch. This test pins that separation down.
  it("gains a scout nothing — the role lives on users/{uid}, not the team doc", async () => {
    await assertSucceeds(
      setDoc(doc(as("erin"), "teams/teamA"), {
        teamNumber: "5806",
        selfDeclaredAdmin: true,
      }),
    );
    await assertFails(
      deleteDoc(doc(as("erin"), "teams/teamA/pitScouting/doc1")),
    );
  });
});

// The Team tab's reset wipes an event in one action, so the rules — not just
// the UI — decide who may delete. Everything a team collects is admin-only,
// with one carve-out for withdrawing a talkie request you posted yourself.
describe("deleting collected data", () => {
  it.each(POOLED)("a teammate scout cannot delete teamA's %s", async (collection) => {
    await assertFails(deleteDoc(doc(as("erin"), `teams/teamA/${collection}/doc1`)));
  });

  it.each(POOLED)("teamA's own admin deletes its %s", async (collection) => {
    await assertSucceeds(
      deleteDoc(doc(as("alice"), `teams/teamA/${collection}/doc1`)),
    );
  });

  it("a teammate scout cannot delete teamA's assignments", async () => {
    await assertFails(deleteDoc(doc(as("erin"), "teams/teamA/config/scoutDuties")));
  });

  it("teamA's own admin deletes its assignments", async () => {
    await assertSucceeds(
      deleteDoc(doc(as("alice"), "teams/teamA/config/scoutDuties")),
    );
  });

  it.each(POOLED)("a sister scout cannot delete teamA's %s", async (collection) => {
    await assertFails(deleteDoc(doc(as("bob"), `teams/teamA/${collection}/doc1`)));
  });

  // A pair shares one store, so resetting from either side has to reach it.
  it.each(POOLED)("a sister admin deletes teamA's %s", async (collection) => {
    await assertSucceeds(
      deleteDoc(doc(as("bea"), `teams/teamA/${collection}/doc1`)),
    );
  });

  it("a sister admin still cannot touch teamA's picklist", async () => {
    await assertFails(deleteDoc(doc(as("bea"), "teams/teamA/config/picklist")));
  });

  it("lets a scout withdraw the talkie request they posted", async () => {
    await assertSucceeds(deleteDoc(doc(as("erin"), "teams/teamA/talkie/byErin")));
  });

  it("never lets a scout delete someone else's talkie request", async () => {
    await assertFails(deleteDoc(doc(as("erin"), "teams/teamA/talkie/byBob")));
  });

  it("lets a sister scout withdraw their own pooled talkie request", async () => {
    await assertSucceeds(deleteDoc(doc(as("bob"), "teams/teamA/talkie/byBob")));
  });

  it.each(POOLED)("an unlinked admin cannot delete teamA's %s", async (collection) => {
    await assertFails(deleteDoc(doc(as("carol"), `teams/teamA/${collection}/doc1`)));
  });
});

describe("signed-out access", () => {
  it("reads nothing", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, "teams/teamA/pitScouting/doc1")));
  });
});

describe("the pooled list", () => {
  it("names every collection the app reaches through dataTeamId", () => {
    // Guard against the rules and the app drifting apart: if a new pooled
    // collection appears in firestore.rules, it belongs in POOLED above (and
    // therefore in every assertion here) too.
    const rules = readFileSync("firestore.rules", "utf8");
    const sistered = [...rules.matchAll(/match \/([A-Za-z]+)\/\{docId\}/g)]
      .map((m) => m[1])
      .filter((name) => name !== "config");
    expect(sistered.sort()).toEqual([...POOLED].sort());
  });
});

describe("who may join a team", () => {
  it("holds a pending member out of their own team's data", async () => {
    // The whole point. Pat's profile says teamA, and that is now worth nothing
    // on its own — until an admin approves them they are a stranger with a
    // matching team number, which is exactly what the old signup form let
    // anyone become.
    await assertFails(getDoc(doc(as("pat"), "teams/teamA/matchScouting/doc1")));
    await assertFails(
      setDoc(doc(as("pat"), "teams/teamA/matchScouting/new"), { x: 1 }),
    );
  });

  it("holds a member whose profile predates the status field", async () => {
    // The migration. A missing approval is not an approval, or the gate would
    // wave through every account that happened to exist first.
    await assertFails(
      getDoc(doc(as("quinn"), "teams/teamA/matchScouting/doc1")),
    );
  });

  it("gives an unapproved admin no authority at all", async () => {
    // Role is granted at approval time, so this combination shouldn't arise —
    // but if it ever did, it must be inert rather than a way past the gate.
    await assertFails(
      setDoc(doc(as("mallory"), "users/erin"), {
        teamId: "teamA",
        role: "admin",
        status: "approved",
      }),
    );
    await assertFails(
      deleteDoc(doc(as("mallory"), "teams/teamA/matchScouting/doc1")),
    );
  });

  it("hides a pending member's teammates from them", async () => {
    await assertFails(getDoc(doc(as("pat"), "users/alice")));
  });

  it("still lets a pending member read their own profile", async () => {
    // Or the approval screen would have nothing to tell them.
    await assertSucceeds(getDoc(doc(as("pat"), "users/pat")));
  });

  it("never lets a member approve themselves", async () => {
    await assertFails(
      setDoc(doc(as("pat"), "users/pat"), {
        teamId: "teamA",
        role: "scout",
        status: "approved",
      }),
    );
  });

  it("never lets a member with no status quietly grant themselves one", async () => {
    // The .get('status','pending') default has to hold on BOTH sides of the
    // comparison, or a profile that predates the field could add an approved
    // one from nothing.
    await assertFails(
      setDoc(doc(as("quinn"), "users/quinn"), {
        teamId: "teamA",
        role: "scout",
        status: "approved",
      }),
    );
  });

  it("still lets a member edit the rest of their own profile", async () => {
    await assertSucceeds(
      setDoc(doc(as("quinn"), "users/quinn"), {
        teamId: "teamA",
        role: "scout",
        fullName: "Quinn Renamed",
      }),
    );
  });

  it("lets an approved admin approve a teammate", async () => {
    await assertSucceeds(
      setDoc(doc(as("alice"), "users/pat"), {
        teamId: "teamA",
        role: "scout",
        status: "approved",
      }),
    );
  });

  it("never lets another team's admin approve into teamA", async () => {
    await assertFails(
      setDoc(doc(as("carol"), "users/pat"), {
        teamId: "teamA",
        role: "scout",
        status: "approved",
      }),
    );
  });

  it("refuses a signup that awards itself admin", async () => {
    // This is the hole that was here: the old rule allowed role 'admin' at
    // create time, so anyone who knew a team number could sign up as its
    // admin.
    await assertFails(
      setDoc(doc(as("newcomer"), "users/newcomer"), {
        teamId: "teamA",
        role: "admin",
        status: "pending",
        active: true,
      }),
    );
  });

  it("refuses a signup that awards itself approval", async () => {
    await assertFails(
      setDoc(doc(as("newcomer"), "users/newcomer"), {
        teamId: "teamA",
        role: "scout",
        status: "approved",
        active: true,
      }),
    );
  });

  it("accepts an ordinary signup — pending, scout, active", async () => {
    await assertSucceeds(
      setDoc(doc(as("newcomer"), "users/newcomer"), {
        teamId: "teamA",
        role: "scout",
        status: "pending",
        active: true,
      }),
    );
  });
});

describe("the operator", () => {
  it("reads and approves a member on a team they don't belong to", async () => {
    await assertSucceeds(getDoc(doc(as("olive"), "users/pat")));
    await assertSucceeds(
      setDoc(doc(as("olive"), "users/pat"), {
        teamId: "teamA",
        role: "admin",
        status: "approved",
      }),
    );
  });

  it("stamps a team as claimed", async () => {
    await assertSucceeds(
      setDoc(
        doc(as("olive"), "teams/teamC"),
        { claimedAt: 1 },
        { merge: true },
      ),
    );
  });

  it("cannot be appointed from inside the app", async () => {
    // owners/{uid} is the one authority the app can't mint. If any of these
    // succeeded, a bug in the app could hand out operator rights.
    await assertFails(setDoc(doc(as("erin"), "owners/erin"), { x: 1 }));
    await assertFails(setDoc(doc(as("alice"), "owners/alice"), { x: 1 }));
    await assertFails(setDoc(doc(as("olive"), "owners/erin"), { x: 1 }));
  });

  it("keeps its own doc to itself", async () => {
    await assertSucceeds(getDoc(doc(as("olive"), "owners/olive")));
    await assertFails(getDoc(doc(as("erin"), "owners/olive")));
  });
});

describe("team claims", () => {
  const claim = (uid: string) => ({
    teamId: "teamE",
    teamNumber: "7777",
    requestedByUid: uid,
    evidenceKind: "pit-photo",
    evidenceImage: "data:image/jpeg;base64,AAAA",
    freshnessCode: "7777-ABCDEFGH",
    status: "pending",
  });

  it("lets a founder file one for themselves", async () => {
    await assertSucceeds(
      setDoc(doc(as("frank"), "teamClaims/teamE"), claim("frank")),
    );
  });

  it("never lets one be filed in someone else's name", async () => {
    await assertFails(
      setDoc(doc(as("frank"), "teamClaims/teamE"), claim("erin")),
    );
  });

  it("never lets a claim arrive pre-approved", async () => {
    await assertFails(
      setDoc(doc(as("frank"), "teamClaims/teamE"), {
        ...claim("frank"),
        status: "approved",
      }),
    );
  });

  it("gives the first claim the team — a second cannot overwrite it", async () => {
    await assertSucceeds(
      setDoc(doc(as("frank"), "teamClaims/teamE"), claim("frank")),
    );
    await assertFails(
      setDoc(doc(as("grace"), "teamClaims/teamE"), claim("grace")),
    );
  });

  it("lets a founder read their own claim but nobody else's", async () => {
    await setDoc(doc(as("frank"), "teamClaims/teamE"), claim("frank"));
    await assertSucceeds(getDoc(doc(as("frank"), "teamClaims/teamE")));
    // Being refused is itself the signal the approval gate reads: it means
    // someone got here first, as opposed to no claim existing at all.
    await assertFails(getDoc(doc(as("grace"), "teamClaims/teamE")));
  });

  it("lets anyone read a claim that does not exist", async () => {
    // Without this, "nobody has claimed this team" and "someone else did"
    // arrive as the same permission error and the gate can't tell them apart.
    await assertSucceeds(getDoc(doc(as("grace"), "teamClaims/teamZ")));
  });

  it("never lets a founder approve their own claim", async () => {
    await setDoc(doc(as("frank"), "teamClaims/teamE"), claim("frank"));
    await assertFails(
      setDoc(
        doc(as("frank"), "teamClaims/teamE"),
        { status: "approved" },
        { merge: true },
      ),
    );
  });

  it("lets a declined founder send better evidence", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), "teamClaims/teamE"), {
        ...claim("frank"),
        status: "denied",
      });
    });
    await assertSucceeds(
      setDoc(
        doc(as("frank"), "teamClaims/teamE"),
        { evidenceImage: "data:image/jpeg;base64,BBBB", status: "pending" },
        { merge: true },
      ),
    );
  });

  it("lets the operator decide, and nobody else", async () => {
    await setDoc(doc(as("frank"), "teamClaims/teamE"), claim("frank"));
    await assertFails(
      setDoc(
        doc(as("alice"), "teamClaims/teamE"),
        { status: "approved" },
        { merge: true },
      ),
    );
    await assertSucceeds(
      setDoc(
        doc(as("olive"), "teamClaims/teamE"),
        { status: "approved" },
        { merge: true },
      ),
    );
  });
});
