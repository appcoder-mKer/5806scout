import type { MemberStatus } from "@/lib/membership";

export type Role = "scout" | "admin";

export interface UserProfile {
  uid: string;
  email: string;
  fullName: string;
  teamId: string;
  role: Role;
  active: boolean;
  /**
   * Whether this account has cleared the email gate (see
   * src/lib/emailVerification.ts). Stamped on the profile by the owner's own
   * session, because a teammate can't read anyone else's Firebase auth
   * record — the roster needs it here or not at all. Absent on profiles
   * written before the field shipped.
   */
  emailVerified?: boolean;
  /**
   * Whether an admin (or, for a team's first member, the app's operator) has
   * let this person in — see src/lib/membership.ts. Absent means pending, so
   * profiles written before the gate shipped are held rather than waved
   * through. That is the opposite of emailVerified's rule directly above, and
   * deliberately: a missing verification flag only hides a roster row, while a
   * missing approval would hand over a season of scouting data.
   *
   * firestore.rules pins this field — a member may edit their own profile but
   * never their own status — which is what makes it a boundary rather than a
   * hint.
   */
  status?: MemberStatus;
}

export interface Team {
  teamNumber: string;
  teamName: string;
  /**
   * When this team got its first admin, stamped by the operator on /owner.
   * Its presence is what tells a pending member whether to file a claim or
   * simply wait for one of their own admins — the team doc is the only thing
   * they can still read once the gate closes (teams/{id} is publicly
   * gettable, so signup can resolve a team number before anyone is signed in).
   *
   * Only ever tested for presence, so the stored shape (a server timestamp) is
   * deliberately not spelled out here.
   */
  claimedAt?: unknown;
  /**
   * Sister-team link (see src/lib/sisterTeam.ts). Present on both linked
   * teams' docs, pointing at each other; absent when unlinked. Number/name
   * are snapshotted at link time for display without an extra read.
   */
  sisterTeamId?: string;
  sisterTeamNumber?: string;
  sisterTeamName?: string;
  sisterLinkedAt?: number;
}

/**
 * A team's first member asking for the team, with the evidence they sent.
 * Stored at teamClaims/{teamId}; see src/lib/teamClaims.ts for the shape and
 * why the evidence is deleted as soon as it is judged.
 */
export type { TeamClaim } from "@/lib/teamClaims";
