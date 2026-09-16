// Manually created events. An off-season event often has no Blue Alliance
// page — or has one with no team list — so there is nothing to sync and the
// whole app (assignments, picklist, pit dashboard) sits idle. An admin can
// instead name the event and paste the team list, and each team is then
// enriched one at a time from TBA (nickname, city) and Statbotics (season
// EPA) by /api/manual-event.
//
// A manual event still lives in the same teams/{id}/config/event doc as a
// synced one, so everything downstream reads it without knowing the
// difference. What it can't do is answer to upstream: rankings, queueing,
// match videos and the Nexus pit map are all keyed on a real TBA event code.
// Hence the synthetic key below and `liveEventKey`, which hands those callers
// null so they don't poll a 404 every thirty seconds.

import type { EventData } from "@/lib/eventData";

/**
 * Prefix marking an event key as locally made up. A TBA event key is
 * `{year}{code}` — all alphanumeric, no hyphen — so this can never collide
 * with a real one, and the key is its own flag: no second field to keep in
 * sync with it.
 */
export const MANUAL_EVENT_KEY_PREFIX = "manual-";

/** Upper bound on a pasted list. A district championship runs ~60 teams. */
export const MAX_MANUAL_TEAMS = 200;

/** Highest plausible FRC team number — comfortably ahead of the real roster. */
const MAX_TEAM_NUMBER = 99999;

export function isManualEventKey(eventKey: string): boolean {
  return eventKey.startsWith(MANUAL_EVENT_KEY_PREFIX);
}

export function isManualEvent(
  event: Pick<EventData, "eventKey"> | null | undefined,
): boolean {
  return !!event && isManualEventKey(event.eventKey);
}

/**
 * The TBA event code to ask upstream about, or null when there isn't one.
 * Every live lookup — rankings, queueing, videos, the pit map — is keyed on a
 * real event code, and a manual event has none. Callers already guard on a
 * missing key, so routing through this turns "manual event" into "no live
 * data" without a second branch at each call site.
 */
export function liveEventKey(
  event: Pick<EventData, "eventKey"> | null | undefined,
): string | null {
  if (!event?.eventKey || isManualEvent(event)) return null;
  return event.eventKey;
}

export interface ParsedTeamNumbers {
  /** Valid, de-duplicated team numbers in the order they were written. */
  teamNumbers: number[];
  /** Tokens that weren't a team number, kept verbatim so we can show them. */
  invalid: string[];
  /** How many valid numbers were repeats of one already seen. */
  duplicates: number;
}

/**
 * Parse a pasted or uploaded team list. Deliberately forgiving about
 * separators — the list comes off a whiteboard, a spreadsheet column, a
 * Discord message or a CSV, so commas, tabs, newlines and plain spaces all
 * separate, and TBA-style "frc5806" keys are accepted as themselves.
 *
 * Anything that isn't a team number is reported rather than dropped: a typo'd
 * entry the admin never hears about is a team that silently goes unscouted.
 */
export function parseTeamNumbers(text: string): ParsedTeamNumbers {
  const teamNumbers: number[] = [];
  const invalid: string[] = [];
  const seen = new Set<number>();
  let duplicates = 0;

  for (const raw of text.split(/[\s,;]+/)) {
    const token = raw.trim();
    if (token === "") continue;
    // A CSV row can carry quotes around the number, and a TBA key carries the
    // "frc" prefix; both name a team perfectly well.
    const cleaned = token.replace(/^["']|["']$/g, "").replace(/^frc/i, "");
    const parsed = Number(cleaned);
    if (
      cleaned === "" ||
      !Number.isInteger(parsed) ||
      parsed <= 0 ||
      parsed > MAX_TEAM_NUMBER
    ) {
      invalid.push(token);
      continue;
    }
    if (seen.has(parsed)) {
      duplicates += 1;
      continue;
    }
    seen.add(parsed);
    teamNumbers.push(parsed);
  }

  return { teamNumbers, invalid, duplicates };
}

/** The team list as text, for pre-filling the editor with what's saved. */
export function formatTeamNumbers(teamNumbers: readonly number[]): string {
  return teamNumbers.join(", ");
}

/**
 * A stable-ish key for a new manual event: a slug of its name plus a random
 * suffix. The suffix is what makes re-creating an event under the same name a
 * genuinely new event rather than a silent overwrite of the old one's key.
 */
export function makeManualEventKey(
  eventName: string,
  random: () => number = Math.random,
): string {
  const slug =
    eventName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "event";
  const suffix = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `${MANUAL_EVENT_KEY_PREFIX}${slug}-${suffix}`;
}
