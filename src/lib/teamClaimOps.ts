import { db } from "@/lib/firebase/client";
import { clearedEvidence } from "@/lib/teamClaims";
import { doc, serverTimestamp, writeBatch } from "firebase/firestore";

// The operator's two decisions, kept out of the page for the same reason
// sisterTeamOps.ts is: each one spans several documents and has to land whole.

/**
 * Give a team its first admin.
 *
 * One batch, because a half-applied decision is the worst outcome on offer.
 * An approved claim whose profile stayed pending would strand the founder at
 * the gate with no way to ask again — the claim already exists, so they can't
 * file another. A promoted profile whose claim kept its evidence would leave a
 * photograph of a student in the database after it had served its purpose.
 *
 * `claimId` is absent for the migration path, where a team predates claims
 * entirely and the operator simply picks one of its existing members.
 */
export async function foundTeam({
  teamId,
  memberUid,
  decidedByUid,
  claimId,
}: {
  teamId: string;
  memberUid: string;
  decidedByUid: string;
  claimId?: string;
}): Promise<void> {
  const batch = writeBatch(db);
  batch.update(doc(db, "users", memberUid), {
    status: "approved",
    role: "admin",
  });
  // The stamp a pending member reads to know whether to file a claim or just
  // wait for one of their own admins. serverTimestamp() rather than Date.now()
  // to match createdAt everywhere else, and because the value is only ever
  // tested for presence.
  batch.update(doc(db, "teams", teamId), { claimedAt: serverTimestamp() });
  if (claimId) {
    batch.update(doc(db, "teamClaims", claimId), {
      status: "approved",
      decidedAt: serverTimestamp(),
      decidedByUid,
      ...clearedEvidence(),
    });
  }
  await batch.commit();
}

/**
 * Turn a claim down. The evidence goes here too: deciding we don't trust it is
 * no reason to keep holding it.
 */
export async function declineClaim({
  claimId,
  decidedByUid,
}: {
  claimId: string;
  decidedByUid: string;
}): Promise<void> {
  const batch = writeBatch(db);
  batch.update(doc(db, "teamClaims", claimId), {
    status: "denied",
    decidedAt: serverTimestamp(),
    decidedByUid,
    ...clearedEvidence(),
  });
  await batch.commit();
}
