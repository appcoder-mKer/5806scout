// Who is actually allowed into a team's data.
//
// Signing up proves nothing but that an address is real (see
// src/lib/emailVerification.ts). It doesn't prove the person behind it is on
// the team whose number they typed, and until this module shipped nothing
// did — anyone who knew a team number could join it, and tick a box to arrive
// as its admin.
//
// So membership is now granted, not claimed:
//
//  - the first member of a new team files a claim with evidence, which the
//    app's operator reviews (src/lib/teamClaims.ts);
//  - everyone after that is approved by one of their own team's admins, who
//    needs no evidence because they already know their own roster.
//
// The flag lives on users/{uid}.status and is pinned by firestore.rules: a
// member may edit their own profile but never their own status, so this is a
// real boundary and not the advisory hint emailVerified is.

/** Where a member stands with their team. */
export type MemberStatus = "pending" | "approved" | "denied";

/** The slice of a profile this decision reads. */
export interface ApprovableMember {
  status?: MemberStatus;
}

/**
 * A member's standing, defaulting to "pending".
 *
 * The default is the whole migration. Every profile written before this
 * shipped has no status field, and treating those as pending means the gate
 * closes over the existing roster the moment it deploys — which is the point:
 * an app that was open to anyone has no way to tell which of its existing
 * accounts were ever vouched for, so all of them get re-approved by hand.
 *
 * Note this is the opposite of showsInRoster's missing-flag rule, which keeps
 * grandfathered accounts VISIBLE. That one hides rows; this one opens a
 * season of data, so it fails closed where the other fails open.
 */
export function memberStatus(member: ApprovableMember): MemberStatus {
  return member.status ?? "pending";
}

/** Is this member through the gate? */
export function isApprovedMember(member: ApprovableMember): boolean {
  return memberStatus(member) === "approved";
}

/** Should this member be held at the approval screen? */
export function needsApproval(member: ApprovableMember): boolean {
  return memberStatus(member) !== "approved";
}
