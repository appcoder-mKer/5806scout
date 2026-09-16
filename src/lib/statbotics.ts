// Statbotics v3 client.
//
// The API is public and read-only — there is NO API key, so nothing here sends
// an auth header (see https://api.statbotics.io/v3). What it does do is fail
// transiently: the same request intermittently returns 429/5xx and then
// succeeds on an immediate retry, and during an upstream outage every endpoint
// returns `500 {}` while the host itself still serves 200. So every request
// retries with exponential backoff, and callers get an explicit ok/failure
// result instead of an empty list they can't distinguish from "no data yet".

import type { StatboticsTeamEvent } from "@/lib/eventData";

export const STATBOTICS_BASE = "https://api.statbotics.io/v3";

const DEFAULT_MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * Per-request ceiling. Without one, a hung connection blocks until the
 * platform kills the whole function — which for a bulk fan-out (a manual
 * event's team list) means the admin's save never returns at all.
 */
const DEFAULT_TIMEOUT_MS = 8000;

/** Exponential backoff, matching the reference client's curve: 300 * attempt². */
function backoffMs(attempt: number): number {
  return 300 * attempt * attempt;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface StatboticsFetchOptions {
  maxAttempts?: number;
  /** Injectable for tests so retry backoff doesn't cost real wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-attempt timeout; 0 disables it. */
  timeoutMs?: number;
}

/**
 * Success carries the parsed payload; failure carries the last upstream status
 * (null when every attempt threw before producing a response, i.e. the network
 * or DNS failed). Callers must handle failure explicitly — an unreachable
 * Statbotics is not the same as an event with no EPA yet.
 */
export type StatboticsResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number | null };

/** Fetch, retrying transient upstream errors (429/5xx) and network faults. */
async function fetchWithRetry(
  url: string,
  {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    sleep = defaultSleep,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  }: StatboticsFetchOptions,
): Promise<Response | null> {
  let lastResponse: Response | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        cache: "no-store",
        ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
      // Non-retryable statuses (including 404) are the caller's to interpret.
      if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res;
      lastResponse = res;
    } catch {
      lastResponse = null;
    }
    if (attempt < maxAttempts) await sleep(backoffMs(attempt));
  }
  return lastResponse;
}

/**
 * Team-event rows (EPA + qual record) for one event. A 404 means Statbotics
 * has never heard of the event, which for a list endpoint is an empty result
 * rather than an error — same convention as the reference client.
 */
export async function fetchTeamEvents(
  eventKey: string,
  options: StatboticsFetchOptions = {},
): Promise<StatboticsResult<StatboticsTeamEvent[]>> {
  const res = await fetchWithRetry(
    `${STATBOTICS_BASE}/team_events?event=${encodeURIComponent(eventKey)}&limit=200`,
    options,
  );

  if (res === null) return { ok: false, status: null };
  if (res.status === 404) return { ok: true, data: [] };
  if (!res.ok) return { ok: false, status: res.status };

  try {
    const body: unknown = await res.json();
    // During the outage the API answers 200-shaped errors as `{}`; anything
    // that isn't an array is a failure, not an event with zero teams.
    if (!Array.isArray(body)) return { ok: false, status: res.status };
    return { ok: true, data: body as StatboticsTeamEvent[] };
  } catch {
    return { ok: false, status: res.status };
  }
}

/**
 * One team's season EPA. Used for manually created events: Statbotics has no
 * team_events rows for an event it has never heard of, so the per-event EPA
 * that backs a synced event simply doesn't exist there. The team's season EPA
 * is the honest stand-in — it's the same number, measured over the season
 * rather than over this event, and the Event tab labels it as such.
 *
 * A 404 means Statbotics has no row for that team and year (a rookie, or a
 * team that sat the season out), which is a real "no EPA" rather than a
 * failure — same convention as fetchTeamEvents.
 */
export async function fetchTeamYear(
  teamNumber: number,
  year: number,
  options: StatboticsFetchOptions = {},
): Promise<StatboticsResult<StatboticsTeamEvent | null>> {
  const res = await fetchWithRetry(
    `${STATBOTICS_BASE}/team_year/${teamNumber}/${year}`,
    options,
  );

  if (res === null) return { ok: false, status: null };
  if (res.status === 404) return { ok: true, data: null };
  if (!res.ok) return { ok: false, status: res.status };

  try {
    const body: unknown = await res.json();
    // The outage shape again: 200/500 with `{}`. A row without a team number
    // can't be matched to anything, so it counts as a failure, not as a team
    // with no EPA.
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      typeof (body as { team?: unknown }).team !== "number"
    ) {
      return { ok: false, status: res.status };
    }
    return { ok: true, data: body as StatboticsTeamEvent };
  } catch {
    return { ok: false, status: res.status };
  }
}
