import type { EventTeam } from "@/lib/eventData";

// Stored at teams/{teamId}/config/picklist. `order` is the ranked list of
// team numbers; `struck` marks teams already picked/unavailable during
// alliance selection (kept in place but crossed out); `doNotPick` is the
// ordered list of teams pulled out of the ranking entirely.
export interface PicklistDoc {
  order: number[];
  struck: number[];
  doNotPick?: number[];
  /**
   * Free-text scouting notes keyed by team number. Unlike the ranking these
   * are written by anyone on the team, so they're saved as their own merge
   * write — a scout typing a note must never overwrite the admin's order.
   */
  notes?: Record<string, string>;
  /**
   * Column ids shown on the picklist table, in order (see picklistColumns.ts).
   * Absent means the default set — a team that never opened Picklist Settings
   * keeps the table it has always had.
   */
  columns?: string[];
  updatedAt: number;
}

/**
 * Reconcile a saved ranking with the current event team list: keep the saved
 * relative order for teams still at the event, drop teams that left, and
 * append newly-appeared teams at the bottom sorted by EPA (best first) so
 * strong newcomers are easy to spot.
 */
export function reconcileOrder(
  savedOrder: readonly number[],
  eventTeams: readonly EventTeam[],
): number[] {
  const present = new Set(eventTeams.map((t) => t.teamNumber));
  const kept = savedOrder.filter((n) => present.has(n));
  const seen = new Set(kept);

  const added = eventTeams
    .filter((t) => !seen.has(t.teamNumber))
    .sort((a, b) => (b.epa ?? -Infinity) - (a.epa ?? -Infinity))
    .map((t) => t.teamNumber);

  return [...kept, ...added];
}

/** Move the item at `from` to position `to`, returning a new array. */
export function moveItem(list: readonly number[], from: number, to: number): number[] {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) {
    return [...list];
  }
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * Move `team` to the 1-based `rank`, clamped into range. The one write path
 * behind the My Rank column: it reads and writes this array, never the order
 * rows happen to be displayed in, which is what lets a column sort be a pure
 * display lens over the ranking.
 */
export function setRank(
  order: readonly number[],
  team: number,
  rank: number,
): number[] {
  const from = order.indexOf(team);
  if (from === -1 || !Number.isFinite(rank)) return [...order];
  const to = Math.min(Math.max(Math.trunc(rank) - 1, 0), order.length - 1);
  return moveItem(order, from, to);
}

export function toggleStruck(struck: readonly number[], team: number): number[] {
  return struck.includes(team)
    ? struck.filter((n) => n !== team)
    : [...struck, team];
}

/**
 * Split a reconciled ranking into the pickable order and the Do Not Pick
 * list. DNP teams keep their saved DNP order; teams that left the event are
 * dropped from both lists.
 */
export function splitDoNotPick(
  reconciled: readonly number[],
  savedDoNotPick: readonly number[],
): { order: number[]; doNotPick: number[] } {
  const present = new Set(reconciled);
  const doNotPick = savedDoNotPick.filter((n) => present.has(n));
  const dnpSet = new Set(doNotPick);
  return {
    order: reconciled.filter((n) => !dnpSet.has(n)),
    doNotPick,
  };
}

/** Move a team from the ranking to the bottom of the Do Not Pick list. */
export function moveToDoNotPick(
  order: readonly number[],
  doNotPick: readonly number[],
  team: number,
): { order: number[]; doNotPick: number[] } {
  if (!order.includes(team)) {
    return { order: [...order], doNotPick: [...doNotPick] };
  }
  return {
    order: order.filter((n) => n !== team),
    doNotPick: [...doNotPick.filter((n) => n !== team), team],
  };
}

/** Return a Do Not Pick team to the bottom of the ranking. */
export function restoreFromDoNotPick(
  order: readonly number[],
  doNotPick: readonly number[],
  team: number,
): { order: number[]; doNotPick: number[] } {
  if (!doNotPick.includes(team)) {
    return { order: [...order], doNotPick: [...doNotPick] };
  }
  return {
    order: [...order.filter((n) => n !== team), team],
    doNotPick: doNotPick.filter((n) => n !== team),
  };
}
