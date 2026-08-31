import { generateInviteCode } from "@/lib/sisterTeam";
import { deleteField } from "firebase/firestore";

// The evidence a team's first member sends to prove the team is theirs.
//
// Nothing about "team 5806" is secret — the number is on the robot, and TBA
// lists every team's name, photos and event history. So a claim can't be
// checked against public facts; it has to carry something only a member of
// that team could produce, and a person has to look at it.
//
// What that rules OUT is as deliberate as what it allows: no student or
// school ID. Those would prove membership just as well, but the people
// signing up are minors, and holding photographs of their identity documents
// buys nothing a pit pass doesn't. Every accepted kind below is a TEAM-level
// artefact.
//
// Evidence is deleted the moment a decision is made (see clearedEvidence) —
// it has done its whole job by then.

/** What a founder can send. */
export type EvidenceKind = "dashboard" | "pit-photo" | "pit-pass" | "other";

export const EVIDENCE_KINDS: readonly EvidenceKind[] = [
  "dashboard",
  "pit-photo",
  "pit-pass",
  "other",
];

export const EVIDENCE_LABELS: Record<EvidenceKind, string> = {
  dashboard: "FIRST Dashboard roster",
  "pit-photo": "Photo at your pit or with the robot",
  "pit-pass": "Event pit pass or team badge",
  other: "Something else",
};

export const EVIDENCE_HINTS: Record<EvidenceKind, string> = {
  dashboard:
    "A screenshot of your team's roster in the FIRST Dashboard. Only a lead mentor or coach can see this, which is exactly why it's the strongest thing you can send.",
  "pit-photo":
    "You at your pit or with the robot, team number visible on the bumper.",
  "pit-pass": "Your event credential — the one with the team number on it.",
  other:
    "Anything that shows you're on this team, plus a note explaining what we're looking at.",
};

/**
 * Does this kind of evidence have to show the freshness code?
 *
 * A robot photo proves nothing on its own: TBA and Instagram between them
 * hold thousands, and a stranger can download one in seconds. Requiring a
 * code that didn't exist until the claim started makes every photo already
 * on the internet useless, which is the difference between evidence and
 * decoration.
 *
 * Screenshots are exempt because there's nowhere to hold a piece of paper in
 * one, and "other" is exempt because we don't know what it is.
 */
export function requiresFreshnessCode(kind: EvidenceKind): boolean {
  return kind === "pit-photo" || kind === "pit-pass";
}

/**
 * A one-off code for this claim, shown to the founder and written on the
 * claim doc so a reviewer can check the photo against it.
 *
 * Reuses the sister-team code generator for its alphabet, which drops 0/O/1/I/L
 * — chosen there because codes get read aloud between two pits, and just as
 * useful here, where the code gets written on paper by hand and read back off
 * a photo.
 */
export function newFreshnessCode(
  teamId: string,
  rng: () => number = Math.random,
): string {
  return `${teamId}-${generateInviteCode(rng)}`;
}

/** A claim as stored at teamClaims/{teamId}. */
export interface TeamClaim {
  teamId: string;
  teamNumber: string;
  teamName: string;
  requestedByUid: string;
  requestedByEmail: string;
  requestedByName: string;
  evidenceKind: EvidenceKind;
  freshnessCode: string;
  status: "pending" | "approved" | "denied";
  /** Absent once decided — see clearedEvidence(). */
  evidenceNote?: string;
  /** A data URL. Absent once decided — see clearedEvidence(). */
  evidenceImage?: string;
  decidedByUid?: string;
}

/** Is `value` one of the kinds we accept? Guards data read back from Firestore. */
export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return (
    typeof value === "string" &&
    (EVIDENCE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * The patch that strips a claim's evidence, applied in the same batch as the
 * decision itself.
 *
 * Approving is the moment the evidence stops being useful, and it's a
 * photograph of a student either way — so it goes then, not on a schedule
 * nobody remembers to run. What survives is the audit shell: who claimed the
 * team, which kind of evidence they sent, when, and who decided.
 */
export function clearedEvidence(): Record<string, ReturnType<typeof deleteField>> {
  return {
    evidenceImage: deleteField(),
    evidenceNote: deleteField(),
  };
}
