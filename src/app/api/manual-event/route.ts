// Build an event from a team list the admin typed in, for an off-season
// event TBA has no team list for (see src/lib/manualEvent.ts). Each team is
// looked up one at a time — TBA for nickname and city, Statbotics for season
// EPA — and mapped through the same mapTeams() a synced event uses, so the
// Event tab, assignments, picklist and Teams pages can't tell the difference.

import {
  mapTeams,
  type StatboticsTeamEvent,
  type TbaTeamSimple,
} from "@/lib/eventData";
import {
  isManualEventKey,
  makeManualEventKey,
  MAX_MANUAL_TEAMS,
} from "@/lib/manualEvent";
import { fetchTeamYear } from "@/lib/statbotics";
import { getServerConfig } from "@/lib/serverConfig";

const TBA_BASE = "https://www.thebluealliance.com/api/v3";

/**
 * Teams looked up at once. Firing 200 teams × 2 upstreams all at once is how a
 * polite read key starts getting throttled; eight teams at a time (both of a
 * team's lookups run together) finishes a district-sized list in seconds.
 */
const LOOKUP_CONCURRENCY = 8;

/**
 * Per-request ceiling on the TBA side. A hung connection would otherwise hold
 * a worker until the platform kills the whole function, and with a bulk list
 * that means the admin's save never comes back at all.
 */
const TBA_TIMEOUT_MS = 8000;

/**
 * Season-EPA lookups retry less than a one-off request does. An outage hits
 * every team in the list identically, so the full 3-attempt curve just
 * multiplies one failure by the length of the list — 200 teams × 1.5s of
 * backoff is minutes of waiting to learn what the first few already showed.
 */
const EPA_MAX_ATTEMPTS = 2;

/**
 * Consecutive Statbotics failures after which this request stops asking. An
 * outage hits every team identically, so without this a 200-team list spends
 * 200 × the timeout learning what the first eight already proved — long
 * enough that the platform kills the function and the admin's list is lost.
 * Tripping the breaker means EPA is missing, which the response already
 * reports honestly; it never costs the team list itself.
 */
const EPA_FAILURE_LIMIT = 8;

const MAX_EVENT_NAME = 80;

/**
 * Enriching a long list is two upstream calls per team. The platform default
 * would cut a district-sized list off mid-flight while an upstream is slow.
 */
export const maxDuration = 300;

/** Run `task` over `items`, at most `limit` in flight, preserving order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await task(items[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/**
 * One team's TBA record, or null when TBA doesn't have it. A team that isn't
 * on TBA is almost always a typo in the pasted list, so the caller keeps it
 * (under its own number) and reports it rather than quietly dropping a team
 * that then goes unscouted all weekend.
 */
async function tbaTeam(
  teamNumber: number,
  apiKey: string,
): Promise<TbaTeamSimple | null> {
  try {
    const res = await fetch(`${TBA_BASE}/team/frc${teamNumber}/simple`, {
      headers: { "X-TBA-Auth-Key": apiKey },
      cache: "no-store",
      signal: AbortSignal.timeout(TBA_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<TbaTeamSimple>;
    if (typeof body.team_number !== "number") return null;
    return {
      team_number: body.team_number,
      nickname: body.nickname ?? null,
      city: body.city ?? null,
    };
  } catch {
    return null;
  }
}

interface ManualEventRequest {
  eventName?: unknown;
  teamNumbers?: unknown;
  eventKey?: unknown;
  year?: unknown;
}

export async function POST(req: Request): Promise<Response> {
  const { tbaApiKey } = getServerConfig();
  if (!tbaApiKey) {
    return Response.json(
      {
        error:
          "TBA_API_KEY is not configured. Get a read key at thebluealliance.com/account and add it to .env.local.",
      },
      { status: 503 },
    );
  }

  let body: ManualEventRequest;
  try {
    body = (await req.json()) as ManualEventRequest;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const eventName =
    typeof body.eventName === "string" ? body.eventName.trim() : "";
  if (eventName === "" || eventName.length > MAX_EVENT_NAME) {
    return Response.json(
      { error: `The event needs a name (up to ${MAX_EVENT_NAME} characters).` },
      { status: 400 },
    );
  }

  // The client parses the pasted list (so it can show what it found before
  // anyone commits); this re-checks the result rather than trusting it.
  const raw = Array.isArray(body.teamNumbers) ? body.teamNumbers : [];
  const teamNumbers = [
    ...new Set(
      raw.filter(
        (n): n is number => Number.isInteger(n) && n > 0 && n <= 99999,
      ),
    ),
  ];
  if (teamNumbers.length === 0) {
    return Response.json(
      { error: "Add at least one team number." },
      { status: 400 },
    );
  }
  if (teamNumbers.length > MAX_MANUAL_TEAMS) {
    return Response.json(
      { error: `That's more than ${MAX_MANUAL_TEAMS} teams — check the list.` },
      { status: 400 },
    );
  }

  // Re-enriching an existing manual event keeps its key, so anything already
  // keyed to it stays keyed to it. Anything else mints a new one — a real TBA
  // key must never arrive here and get treated as locally made up.
  const eventKey =
    typeof body.eventKey === "string" && isManualEventKey(body.eventKey)
      ? body.eventKey
      : makeManualEventKey(eventName);

  const year =
    typeof body.year === "number" && Number.isInteger(body.year)
      ? body.year
      : new Date().getFullYear();

  // Both of a team's lookups go out together — they don't depend on each
  // other, and running them as two sequential passes doubled the wall clock a
  // long list already costs. Statbotics has no rows for an event it's never
  // heard of, so EPA comes from each team's season instead.
  let epaFailures = 0;
  const looked = await mapWithConcurrency(
    teamNumbers,
    LOOKUP_CONCURRENCY,
    async (teamNumber) => {
      const [tba, epa] = await Promise.all([
        tbaTeam(teamNumber, tbaApiKey),
        // Once the breaker has tripped, skip the call and record the failure
        // it would have been — the team list is still worth finishing.
        epaFailures >= EPA_FAILURE_LIMIT
          ? Promise.resolve({ ok: false as const, status: null })
          : fetchTeamYear(teamNumber, year, { maxAttempts: EPA_MAX_ATTEMPTS }),
      ]);
      if (!epa.ok) epaFailures += 1;
      return [tba, epa] as const;
    },
  );

  const unknownTeams = teamNumbers.filter((_, i) => looked[i][0] === null);
  const resolvedTeams: TbaTeamSimple[] = teamNumbers.map(
    (teamNumber, i) =>
      looked[i][0] ?? { team_number: teamNumber, nickname: null, city: null },
  );

  // Same contract as the synced route: a failure is reported, never persisted
  // as a column of nulls.
  const epaResults = looked.map(([, epa]) => epa);
  const statbotics = epaResults.flatMap((result) =>
    result.ok && result.data ? [result.data satisfies StatboticsTeamEvent] : [],
  );
  // Every lookup has to have come back cleanly — a success or an honest "no
  // row for this team" — before the client is allowed to persist this column
  // over what it already had. `some` would let 59 failures and one success
  // blank 59 good EPAs; being conservative here costs nothing, because
  // preserveEpa only ever fills a null back in.
  const epaAvailable = epaResults.every((result) => result.ok);

  return Response.json({
    eventKey,
    eventName,
    teams: mapTeams(resolvedTeams, statbotics, null),
    matches: [],
    venue: null,
    epaAvailable,
    // A manual event has no matches, so TBA could not compute an OPR for it
    // even if it knew the event — the column is permanently empty here.
    oprAvailable: false,
    epaYear: year,
    unknownTeams,
  });
}
