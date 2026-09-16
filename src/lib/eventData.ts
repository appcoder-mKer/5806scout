// Shapes for synced event data (The Blue Alliance + Statbotics) and pure
// mappers from each API's raw payload into them. The API route fetches and
// maps; the Event page writes the mapped result to Firestore so the whole
// team shares one synced copy.

export interface EventTeam {
  teamNumber: number;
  nickname: string;
  city: string;
  /** Statbotics EPA (expected points added) — null when Statbotics has no data. */
  epa: number | null;
  epaRank: number | null;
  /**
   * TBA's Offensive Power Rating: the event's own least-squares estimate of
   * how many points this team adds to an alliance score. TBA can't compute it
   * until qualification matches have been played, and docs synced before OPR
   * support shipped don't carry it at all — hence optional as well as
   * nullable.
   */
  opr?: number | null;
}

export interface EventMatch {
  key: string;
  compLevel: string; // qm, qf, sf, f
  matchNumber: number;
  red: number[];
  blue: number[];
  redScore: number | null; // null until the match is played
  blueScore: number | null;
  winner: "red" | "blue" | "tie" | null;
  scheduledTime: number | null; // unix seconds
}

export interface EventVenue {
  name: string | null;
  address: string | null;
  city: string | null;
  gmapsUrl: string | null;
  lat: number | null;
  lng: number | null;
}

export interface EventData {
  eventKey: string;
  eventName: string;
  teams: EventTeam[];
  matches: EventMatch[];
  /** Missing on docs synced before venue support shipped. */
  venue?: EventVenue | null;
  /**
   * For a manually created event only: the season the EPA column was measured
   * over. A manual event has no Statbotics page, so its EPA is each team's
   * season number rather than this event's — and the Event tab says so.
   */
  epaYear?: number;
  syncedAt: number; // unix ms, set client-side on save
}

// --- TBA payload subsets (https://www.thebluealliance.com/apidocs/v3) ---

export interface TbaTeamSimple {
  team_number: number;
  nickname: string | null;
  city: string | null;
}

export interface TbaEvent {
  name: string;
  location_name: string | null;
  address: string | null;
  city: string | null;
  gmaps_url: string | null;
  lat: number | null;
  lng: number | null;
}

export function mapVenue(event: TbaEvent): EventVenue {
  return {
    name: event.location_name,
    address: event.address,
    city: event.city,
    gmapsUrl: event.gmaps_url,
    lat: event.lat,
    lng: event.lng,
  };
}

/** GET /event/{key}/oprs — keys are TBA team keys ("frc5806"). */
export interface TbaEventOprs {
  oprs: Record<string, number>;
}

export interface TbaMatchSimple {
  key: string;
  comp_level: string;
  match_number: number;
  alliances: {
    red: { team_keys: string[]; score: number };
    blue: { team_keys: string[]; score: number };
  };
  winning_alliance: "red" | "blue" | "";
  time: number | null;
  predicted_time: number | null;
}

// --- Statbotics payload subset (https://www.statbotics.io/api/rest) ---

export interface StatboticsTeamEvent {
  team: number;
  team_name?: string | null;
  // Observed live as a plain number; older payloads nested it as { mean }.
  epa: { total_points: number | { mean: number } | null } | null;
  record?: {
    qual?: {
      wins: number;
      losses: number;
      ties: number;
      rps_per_match?: number | null;
      rank?: number | null;
    } | null;
  } | null;
}

function epaTotal(entry: StatboticsTeamEvent): number | null {
  const total = entry.epa?.total_points;
  if (typeof total === "number") return total;
  if (total && typeof total.mean === "number") return total.mean;
  return null;
}

export function teamKeyToNumber(teamKey: string): number {
  // TBA team keys look like "frc5806".
  return Number(teamKey.replace(/^frc/, ""));
}

export function mapTeams(
  tbaTeams: readonly TbaTeamSimple[],
  statbotics: readonly StatboticsTeamEvent[],
  oprs?: TbaEventOprs | null,
): EventTeam[] {
  const oprByTeam = new Map<number, number>();
  for (const [teamKey, opr] of Object.entries(oprs?.oprs ?? {})) {
    const teamNumber = teamKeyToNumber(teamKey);
    if (Number.isInteger(teamNumber) && typeof opr === "number") {
      oprByTeam.set(teamNumber, opr);
    }
  }

  const epaByTeam = new Map<number, number>();
  for (const entry of statbotics) {
    const total = epaTotal(entry);
    if (total !== null) epaByTeam.set(entry.team, total);
  }

  const ranked = [...epaByTeam.entries()].sort((a, b) => b[1] - a[1]);
  const rankByTeam = new Map(ranked.map(([team], i) => [team, i + 1]));

  return tbaTeams
    .map((t) => ({
      teamNumber: t.team_number,
      nickname: t.nickname ?? String(t.team_number),
      city: t.city ?? "",
      epa: epaByTeam.get(t.team_number) ?? null,
      epaRank: rankByTeam.get(t.team_number) ?? null,
      opr: oprByTeam.get(t.team_number) ?? null,
    }))
    .sort((a, b) => a.teamNumber - b.teamNumber);
}

/**
 * Carry EPA and EPA rank forward from the previous sync for teams whose fresh
 * EPA is missing. Used when Statbotics was unreachable during a sync: the team
 * list and schedule from TBA are still fresh and worth saving, but every EPA
 * came back null, and blindly persisting those nulls would wipe the numbers the
 * whole team shares. A fresh non-null EPA always wins.
 */
export function preserveEpa(
  fresh: readonly EventTeam[],
  previous: readonly EventTeam[],
): EventTeam[] {
  const prior = new Map(previous.map((t) => [t.teamNumber, t]));
  return fresh.map((team) => {
    if (team.epa !== null) return team;
    const before = prior.get(team.teamNumber);
    if (!before || before.epa === null) return team;
    return { ...team, epa: before.epa, epaRank: before.epaRank };
  });
}

/**
 * The same guard for OPR: TBA has no OPRs to give until qualification
 * MATCHES have been played, so a pre-event sync legitimately returns none.
 * Persisting those nulls over a mid-event sync's real numbers would blank the
 * column for the whole team, so a fresh null defers to what we already had.
 */
export function preserveOpr(
  fresh: readonly EventTeam[],
  previous: readonly EventTeam[],
): EventTeam[] {
  const prior = new Map(previous.map((t) => [t.teamNumber, t]));
  return fresh.map((team) => {
    if (team.opr != null) return team;
    const before = prior.get(team.teamNumber);
    if (before?.opr == null) return team;
    return { ...team, opr: before.opr };
  });
}

export interface EventRankingRow {
  rank: number | null;
  teamNumber: number;
  teamName: string;
  wins: number | null;
  losses: number | null;
  ties: number | null;
  /** Ranking score — average RP per match, the field's own sort key. */
  rpsPerMatch: number | null;
  matchesPlayed: number | null;
}

// --- TBA rankings payload (https://www.thebluealliance.com/apidocs/v3) ---

export interface TbaRankingEntry {
  team_key: string;
  rank: number | null;
  record: { wins: number; losses: number; ties: number } | null;
  matches_played?: number | null;
  /**
   * The field's own sort keys, in the order described by `sort_order_info`.
   * Which slot holds the ranking score moves between seasons, so it's found
   * by name rather than assumed to be index 0.
   */
  sort_orders?: (number | null)[] | null;
}

export interface TbaEventRankings {
  rankings?: TbaRankingEntry[] | null;
  sort_order_info?: ({ name?: string | null } | null)[] | null;
}

/** Index of the ranking-score sort order, or 0 when TBA doesn't name one. */
function rankingScoreIndex(info: TbaEventRankings["sort_order_info"]): number {
  const found = (info ?? []).findIndex((entry) =>
    /ranking score/i.test(entry?.name ?? ""),
  );
  return found >= 0 ? found : 0;
}

/**
 * Map TBA's official event rankings into ranking rows, already in rank order.
 * These are the numbers on the field's own display — the same rank that
 * decides alliance selection — rather than a third party's model of them.
 *
 * TBA gives rankings by team key only, so nicknames come from the event's
 * team list; a team missing from it falls back to its number.
 */
export function mapRankings(
  payload: TbaEventRankings,
  tbaTeams: readonly TbaTeamSimple[] = [],
): EventRankingRow[] {
  const scoreIndex = rankingScoreIndex(payload.sort_order_info);
  const nameByTeam = new Map(
    tbaTeams.map((team) => [team.team_number, team.nickname]),
  );

  return (payload.rankings ?? [])
    .map((entry) => {
      const teamNumber = teamKeyToNumber(entry.team_key);
      return {
        rank: entry.rank ?? null,
        teamNumber,
        teamName: nameByTeam.get(teamNumber) ?? String(teamNumber),
        wins: entry.record?.wins ?? null,
        losses: entry.record?.losses ?? null,
        ties: entry.record?.ties ?? null,
        rpsPerMatch: entry.sort_orders?.[scoreIndex] ?? null,
        matchesPlayed: entry.matches_played ?? null,
      };
    })
    // TBA returns these in rank order, but sort anyway so a partial or
    // reordered payload can't render a table that reads as ranked and isn't.
    .sort((a, b) => {
      if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
      if (a.rank !== null) return -1;
      if (b.rank !== null) return 1;
      return a.teamNumber - b.teamNumber;
    });
}

export function mapMatches(tbaMatches: readonly TbaMatchSimple[]): EventMatch[] {
  const levelOrder: Record<string, number> = { qm: 0, ef: 1, qf: 2, sf: 3, f: 4 };
  return tbaMatches
    .map((m) => {
      const played = m.alliances.red.score >= 0 && m.alliances.blue.score >= 0;
      return {
        key: m.key,
        compLevel: m.comp_level,
        matchNumber: m.match_number,
        red: m.alliances.red.team_keys.map(teamKeyToNumber),
        blue: m.alliances.blue.team_keys.map(teamKeyToNumber),
        redScore: played ? m.alliances.red.score : null,
        blueScore: played ? m.alliances.blue.score : null,
        winner: played
          ? m.winning_alliance === ""
            ? ("tie" as const)
            : m.winning_alliance
          : null,
        scheduledTime: m.time ?? m.predicted_time,
      };
    })
    .sort(
      (a, b) =>
        (levelOrder[a.compLevel] ?? 9) - (levelOrder[b.compLevel] ?? 9) ||
        a.matchNumber - b.matchNumber,
    );
}

// --- Event search (TBA-style typeahead on the Event tab) ---

/** Subset of TBA `/events/{year}/simple`. */
export interface TbaEventSimple {
  key: string;
  name: string;
  city: string | null;
  state_prov: string | null;
  country: string | null;
  start_date: string; // "YYYY-MM-DD"
  end_date: string;
}

export interface EventSearchResult {
  key: string;
  name: string;
  /** "City, State" best-effort — empty string when TBA has neither. */
  location: string;
  startDate: string;
  endDate: string;
}

/**
 * Year the query targets: an explicit 4-digit year anywhere in the query
 * wins (e.g. "2025 hopper"), otherwise the current season.
 */
export function eventSearchYear(query: string, currentYear: number): number {
  const match = query.match(/\b(19|20)\d{2}\b/);
  return match ? Number(match[0]) : currentYear;
}

/**
 * Filter + rank a season's events for a typeahead query. Every whitespace
 * token must appear somewhere in the event's key/name/location; exact-ish
 * matches (key or name prefix) rank first, then alphabetical by name.
 */
export function searchEvents(
  events: readonly TbaEventSimple[],
  query: string,
  limit = 12,
): EventSearchResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const scored = events.flatMap((event) => {
    const key = event.key.toLowerCase();
    const name = event.name.toLowerCase();
    const haystack = [key, name, event.city, event.state_prov, event.country]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (!tokens.every((t) => haystack.includes(t))) return [];
    const first = tokens[0];
    const rank =
      key === first || key.replace(/^\d{4}/, "") === first
        ? 0
        : name.startsWith(first)
          ? 1
          : 2;
    return [{ event, rank }];
  });

  return scored
    .sort((a, b) => a.rank - b.rank || a.event.name.localeCompare(b.event.name))
    .slice(0, limit)
    .map(({ event }) => ({
      key: event.key,
      name: event.name,
      location: [event.city, event.state_prov].filter(Boolean).join(", "),
      startDate: event.start_date,
      endDate: event.end_date,
    }));
}
