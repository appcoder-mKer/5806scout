// Per-person scouting duty. Every member of the crew carries one label, set
// by an admin on the Team tab, and only the three scouting labels put someone
// into the assignment rotations — a Viewer, the drive team, and the pit crew
// have a job already and shouldn't be handed matches to watch.
//
// Stored at teams/{dataTeamId}/config/scoutDuties, keyed by uid, rather than
// on each users/{uid} profile: a sister-team pair pools its scouts, and
// firestore.rules only lets an admin write profiles belonging to their OWN
// team. A shared config doc under the data team keeps one crew list for both.

import type { Role } from "@/lib/types";

export const SCOUT_DUTIES = [
  "both",
  "pit",
  "match",
  "viewer",
  "driveTeam",
  "pitCrew",
] as const;

export type ScoutDuty = (typeof SCOUT_DUTIES)[number];

export const DUTY_LABELS: Record<ScoutDuty, string> = {
  both: "Match and Pit",
  pit: "Pit",
  match: "Match",
  viewer: "Viewer",
  driveTeam: "Drive Team",
  pitCrew: "Pit crew",
};

/**
 * What an unlabelled scout counts as. "Match and Pit" keeps a freshly
 * invited scout in both rotations, which is what happened before duties
 * existed — nobody silently drops out of the schedule by default.
 */
export const DEFAULT_DUTY: ScoutDuty = "both";

/**
 * What an unlabelled admin counts as. Admins can carry a scouting duty like
 * anyone else, but only once someone opts them in: before admins had duties
 * they were never in a rotation, and every team's next assignment run should
 * look the way it did then.
 */
export const DEFAULT_ADMIN_DUTY: ScoutDuty = "viewer";

export const SCOUT_DUTIES_DOC_ID = "scoutDuties";

export interface ScoutDutiesDoc {
  /** uid → duty. Missing uids fall back to DEFAULT_DUTY. */
  duties: Record<string, ScoutDuty>;
  /** Consecutive matches one scout covers before rotating off. */
  matchesPerScout: number;
  updatedAt: number;
}

/**
 * A shift long enough to be worth walking to the stands for and short enough
 * that nobody misses lunch. Admins override it on the Team tab.
 */
export const DEFAULT_MATCHES_PER_SCOUT = 12;

export const MIN_MATCHES_PER_SCOUT = 1;
export const MAX_MATCHES_PER_SCOUT = 200;

export function clampMatchesPerScout(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MATCHES_PER_SCOUT;
  return Math.min(
    MAX_MATCHES_PER_SCOUT,
    Math.max(MIN_MATCHES_PER_SCOUT, Math.floor(value)),
  );
}

export function emptyScoutDutiesDoc(): ScoutDutiesDoc {
  return {
    duties: {},
    matchesPerScout: DEFAULT_MATCHES_PER_SCOUT,
    updatedAt: 0,
  };
}

function isScoutDuty(value: unknown): value is ScoutDuty {
  return SCOUT_DUTIES.includes(value as ScoutDuty);
}

/**
 * Parse the raw Firestore doc into a safe one. Any team member can write this
 * doc under current rules, so nothing about its shape is trusted — an
 * unreadable duty falls back to the default rather than dropping the scout.
 */
export function sanitizeScoutDutiesDoc(data: unknown): ScoutDutiesDoc {
  if (typeof data !== "object" || data === null) return emptyScoutDutiesDoc();
  const record = data as Record<string, unknown>;
  const rawDuties =
    typeof record.duties === "object" && record.duties !== null
      ? (record.duties as Record<string, unknown>)
      : {};
  const duties: Record<string, ScoutDuty> = {};
  for (const [uid, duty] of Object.entries(rawDuties)) {
    if (isScoutDuty(duty)) duties[uid] = duty;
  }
  return {
    duties,
    matchesPerScout: clampMatchesPerScout(Number(record.matchesPerScout)),
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
  };
}

export function dutyFor(
  duties: Readonly<Record<string, ScoutDuty>>,
  uid: string,
  role: Role = "scout",
): ScoutDuty {
  return duties[uid] ?? (role === "admin" ? DEFAULT_ADMIN_DUTY : DEFAULT_DUTY);
}

export function scoutsMatch(duty: ScoutDuty): boolean {
  return duty === "match" || duty === "both";
}

export function scoutsPit(duty: ScoutDuty): boolean {
  return duty === "pit" || duty === "both";
}

/**
 * The uids to feed an assignment generator: everyone whose duty covers that
 * job, in the order given. Viewers, drive team, and pit crew never appear.
 */
export function eligibleUids(
  job: "match" | "pit",
  duties: Readonly<Record<string, ScoutDuty>>,
  crew: readonly { uid: string; role: Role }[],
): string[] {
  const covers = job === "match" ? scoutsMatch : scoutsPit;
  return crew
    .filter(({ uid, role }) => covers(dutyFor(duties, uid, role)))
    .map(({ uid }) => uid);
}
