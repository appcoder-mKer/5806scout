// Dashboard logic: what a scout still owes, and whether the crew is keeping
// up. Kept pure and separate from the components so the "on track" rules are
// testable without Firestore or a live event.
//
// Two independent signals decide whether someone needs chasing, because they
// fail differently. "Behind" is ground truth from the field — the match was
// played and the slot was never crossed off, so that robot went unwatched.
// "Stalled" catches the case a completion count hides: a dead tablet or a
// scout who wandered off still looks fine at 60% until the matches they were
// meant to cover start going by.

import {
  slotKey,
  type MatchAssignmentsDoc,
  type MatchSlot,
  type PitAssignmentsDoc,
} from "@/lib/assignments";
import type { EventMatch } from "@/lib/eventData";
import { isPlayed } from "@/lib/pitDashboard";
import type { Role } from "@/lib/types";
import {
  dutyFor,
  scoutsMatch,
  scoutsPit,
  type ScoutDuty,
} from "@/lib/scoutDuty";

/**
 * How long a scout with work left can go without submitting anything before
 * the admin dashboard flags them. A qualification match cycle runs 6–8
 * minutes, so 25 tolerates a slow match plus a bathroom break without crying
 * wolf, and still catches a tablet that died two matches ago.
 */
export const STALL_THRESHOLD_MS = 25 * 60 * 1000;

/**
 * Ordered worst-first, which is also the order the dashboard sorts by — an
 * admin should never have to scroll to find who needs chasing.
 *
 * - `behind`   — a match they were assigned has been played and not crossed off.
 * - `stalled`  — work outstanding, nothing submitted inside the threshold.
 * - `ontrack`  — assigned work, keeping up.
 * - `clear`    — assigned work, all of it crossed off.
 * - `idle`     — no assignments at all.
 */
export type ScoutState = "behind" | "stalled" | "ontrack" | "clear" | "idle";

export const SCOUT_STATE_ORDER: readonly ScoutState[] = [
  "behind",
  "stalled",
  "ontrack",
  "clear",
  "idle",
];

export interface ScoutStatus {
  uid: string;
  name: string;
  duty: ScoutDuty;
  state: ScoutState;
  /** Assigned slots whose match is played but not crossed off. */
  behindCount: number;
  /** Pit teams + match slots still outstanding. */
  remaining: number;
  /** Total assigned across both rotations. */
  assigned: number;
  /** Most recent submission in unix ms, or null when they've submitted none. */
  lastSubmissionMs: number | null;
  /** Silence in ms, or null when they've never submitted. */
  quietForMs: number | null;
}

/**
 * A scout's assigned slots for matches that have already been played but
 * were never crossed off. Only counts matches present in `matches` — a slot
 * for a match TBA hasn't published yet isn't late, it just hasn't happened.
 */
export function behindSlots(
  slots: readonly MatchSlot[],
  matches: readonly EventMatch[],
  uid: string,
  completedSlots: readonly string[] = [],
): MatchSlot[] {
  const played = new Set(
    matches.filter((match) => isPlayed(match)).map((match) => match.key),
  );
  const done = new Set(completedSlots);
  return slots.filter(
    (slot) =>
      slot.uid === uid && played.has(slot.matchKey) && !done.has(slotKey(slot)),
  );
}

/** Pit teams assigned to `uid` that haven't been crossed off. */
export function remainingPitTeams(
  pitDoc: PitAssignmentsDoc | null,
  uid: string,
): number[] {
  const mine = pitDoc?.byScout[uid] ?? [];
  const done = new Set(pitDoc?.completedTeams ?? []);
  return mine.filter((team) => !done.has(team));
}

/** Match slots assigned to `uid` that haven't been crossed off. */
export function remainingMatchSlots(
  matchDoc: MatchAssignmentsDoc | null,
  uid: string,
): MatchSlot[] {
  const done = new Set(matchDoc?.completedSlots ?? []);
  return (matchDoc?.slots ?? []).filter(
    (slot) => slot.uid === uid && !done.has(slotKey(slot)),
  );
}

function stateFor(
  behindCount: number,
  remaining: number,
  assigned: number,
  quietForMs: number | null,
): ScoutState {
  if (behindCount > 0) return "behind";
  if (assigned === 0) return "idle";
  if (remaining === 0) return "clear";
  // Never having submitted counts as stalled once there's work to do: at an
  // event that has started, "nothing yet" is exactly what needs chasing.
  if (quietForMs === null || quietForMs > STALL_THRESHOLD_MS) return "stalled";
  return "ontrack";
}

export interface CrewMember {
  uid: string;
  name: string;
  /** Decides the fallback duty for someone with none set; see dutyFor. */
  role: Role;
}

/**
 * One row per crew member who is actually in a scouting rotation. Viewers,
 * drive team and pit crew are dropped — they have a job already, and listing
 * them as "idle" would bury the people who genuinely need chasing.
 */
export function buildScoutStatuses(
  crew: readonly CrewMember[],
  duties: Readonly<Record<string, ScoutDuty>>,
  pitDoc: PitAssignmentsDoc | null,
  matchDoc: MatchAssignmentsDoc | null,
  matches: readonly EventMatch[],
  lastSubmissionByUid: Readonly<Record<string, number>>,
  now: number,
): ScoutStatus[] {
  const rows = crew
    .filter(({ uid, role }) => {
      const duty = dutyFor(duties, uid, role);
      return scoutsMatch(duty) || scoutsPit(duty);
    })
    .map(({ uid, name, role }) => {
      const duty = dutyFor(duties, uid, role);
      const behindCount = behindSlots(
        matchDoc?.slots ?? [],
        matches,
        uid,
        matchDoc?.completedSlots ?? [],
      ).length;

      const pitAssigned = pitDoc?.byScout[uid]?.length ?? 0;
      const matchAssigned = (matchDoc?.slots ?? []).filter(
        (slot) => slot.uid === uid,
      ).length;
      const remaining =
        remainingPitTeams(pitDoc, uid).length +
        remainingMatchSlots(matchDoc, uid).length;

      const lastSubmissionMs = lastSubmissionByUid[uid] ?? null;
      // Clock skew between a tablet and the server can put a submission in
      // the future; clamp rather than report a negative silence.
      const quietForMs =
        lastSubmissionMs === null ? null : Math.max(0, now - lastSubmissionMs);

      return {
        uid,
        name,
        duty,
        state: stateFor(
          behindCount,
          remaining,
          pitAssigned + matchAssigned,
          quietForMs,
        ),
        behindCount,
        remaining,
        assigned: pitAssigned + matchAssigned,
        lastSubmissionMs,
        quietForMs,
      };
    });

  // Worst first, then most behind, then longest silent, then by name so the
  // list doesn't reshuffle between renders for equally-placed scouts.
  return rows.sort((a, b) => {
    const byState =
      SCOUT_STATE_ORDER.indexOf(a.state) - SCOUT_STATE_ORDER.indexOf(b.state);
    if (byState !== 0) return byState;
    if (a.behindCount !== b.behindCount) return b.behindCount - a.behindCount;
    const aQuiet = a.quietForMs ?? Number.POSITIVE_INFINITY;
    const bQuiet = b.quietForMs ?? Number.POSITIVE_INFINITY;
    if (aQuiet !== bQuiet) return bQuiet - aQuiet;
    return a.name.localeCompare(b.name);
  });
}

/** Crew who need chasing right now — drives the dashboard's summary line. */
export function needsAttention(
  statuses: readonly ScoutStatus[],
): ScoutStatus[] {
  return statuses.filter(
    (status) => status.state === "behind" || status.state === "stalled",
  );
}

// --- Deep links -------------------------------------------------------------
// Tapping an assignment on the dashboard lands on the form with the robot
// already loaded. The target pages read these params on mount (see
// DeepLinkParams), so the scout never re-keys a number they were just shown.

export function pitScoutHref(teamNumber: number | string): string {
  return `/pit-scout?team=${encodeURIComponent(String(teamNumber))}`;
}

export const MATCH_LINK_PARAMS = [
  "match",
  "team",
  "alliance",
  "matchKey",
  "compLevel",
] as const;

export function matchScoutHref(slot: MatchSlot): string {
  const params = new URLSearchParams({
    match: String(slot.matchNumber),
    team: String(slot.teamNumber),
    alliance: slot.alliance,
    // Carried so the form can rebuild the slot it was opened from: submitting
    // is what crosses an assignment off, and slotKey() needs the match key.
    // Without these a deep-linked submission would save but leave the row
    // sitting in the scout's list.
    matchKey: slot.matchKey,
    compLevel: slot.compLevel,
  });
  return `/match-scout?${params.toString()}`;
}

/**
 * Rebuild the assignment slot a deep link came from, or null when the link is
 * missing pieces (hand-typed, or from an older build). Callers fall back to
 * treating it as a free-form entry rather than crossing off the wrong row.
 */
export function slotFromParams(
  values: Readonly<Record<string, string>>,
  uid: string,
): MatchSlot | null {
  const matchNumber = Number(values.match);
  const teamNumber = Number(values.team);
  const alliance = values.alliance;
  if (!values.matchKey || !values.compLevel) return null;
  if (!Number.isInteger(matchNumber) || !Number.isInteger(teamNumber)) {
    return null;
  }
  if (alliance !== "red" && alliance !== "blue") return null;
  return {
    matchKey: values.matchKey,
    compLevel: values.compLevel,
    matchNumber,
    teamNumber,
    alliance,
    uid,
  };
}

/** Humanised silence for the admin dashboard ("41m", "2h 05m"). */
export function formatQuiet(ms: number | null): string {
  if (ms === null) return "never";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
