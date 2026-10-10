// Alliance lab: "what if these robots played together?", answered by
// replaying each team's own scouted matches. Every simulated match draws one
// real match per robot (a bootstrap) and adds them up, so a team that swings
// between 10 and 50 points widens the alliance's range in a way an average
// never would.
//
// The generator is seeded, so the same six robots always give the same
// numbers — a percentage that flickers on every render reads as broken.

import { percentileOfSorted } from "@/lib/aggregate";

/** Matches simulated per alliance. */
export const SIMULATIONS = 4000;
/** Cheaper run per candidate when ranking every partner at once. */
export const PARTNER_SIMULATIONS = 800;
const SEED = 5806;

/** mulberry32 — small, fast, and good enough for dice. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * What a team can score in one match. `perMatch` is its scouted history;
 * with fewer than two matches there's nothing to resample, so the team
 * plays its expected points every time (EPA for a team nobody scouted).
 */
export interface TeamSampler {
  teamNumber: number;
  perMatch: readonly number[];
  points: number | null;
}

function draw(team: TeamSampler, random: () => number): number {
  if (team.perMatch.length >= 2) {
    return team.perMatch[Math.floor(random() * team.perMatch.length)];
  }
  return team.perMatch[0] ?? team.points ?? 0;
}

export function simulateAlliance(
  teams: readonly TeamSampler[],
  runs: number,
  random: () => number,
): number[] {
  const totals = new Array<number>(runs);
  for (let i = 0; i < runs; i++) {
    let total = 0;
    for (const team of teams) total += draw(team, random);
    totals[i] = total;
  }
  return totals;
}

export interface ScoreSummary {
  mean: number;
  /** 10th and 90th percentile: 80% of simulated matches land between. */
  low: number;
  high: number;
  /** 20th percentile — what this alliance scores on a bad day. */
  badDay: number;
}

export function summarize(totals: readonly number[]): ScoreSummary {
  if (totals.length === 0) return { mean: 0, low: 0, high: 0, badDay: 0 };
  const sorted = [...totals].sort((a, b) => a - b);
  return {
    mean: totals.reduce((sum, v) => sum + v, 0) / totals.length,
    low: percentileOfSorted(sorted, 0.1) ?? 0,
    high: percentileOfSorted(sorted, 0.9) ?? 0,
    badDay: percentileOfSorted(sorted, 0.2) ?? 0,
  };
}

export interface MatchupResult {
  red: ScoreSummary;
  blue: ScoreSummary;
  redTotals: number[];
  blueTotals: number[];
  /** Share of simulated matches red wins; ties count half. */
  redWin: number;
  /** Robots with no scouting and no EPA — their slot counts as zero. */
  unknownTeams: number[];
}

export function simulateMatchup(
  red: readonly TeamSampler[],
  blue: readonly TeamSampler[],
  runs: number = SIMULATIONS,
): MatchupResult {
  const random = seededRandom(SEED);
  const redTotals = simulateAlliance(red, runs, random);
  const blueTotals = simulateAlliance(blue, runs, random);
  let wins = 0;
  for (let i = 0; i < runs; i++) {
    if (redTotals[i] > blueTotals[i]) wins += 1;
    else if (redTotals[i] === blueTotals[i]) wins += 0.5;
  }
  const unknownTeams = [...red, ...blue]
    .filter((t) => t.perMatch.length === 0 && t.points === null)
    .map((t) => t.teamNumber);
  return {
    red: summarize(redTotals),
    blue: summarize(blueTotals),
    redTotals,
    blueTotals,
    redWin: runs > 0 ? wins / runs : 0.5,
    unknownTeams,
  };
}

export interface PartnerOption {
  teamNumber: number;
  /** Simulated alliance average with this partner added. */
  mean: number;
  /** The alliance's 20th-percentile match with this partner. */
  badDay: number;
  /** Mean and bad day weighted equally — rewards partners whose bad days are still good. */
  value: number;
}

/**
 * Rank every candidate by what it adds to the alliance so far (the captain,
 * and the first pick if one's chosen). Each candidate gets its own seeded
 * run so the order doesn't depend on who else is in the list.
 */
export function rankPartners(
  alliance: readonly TeamSampler[],
  candidates: readonly TeamSampler[],
  runs: number = PARTNER_SIMULATIONS,
): PartnerOption[] {
  return candidates
    .map((candidate) => {
      const totals = simulateAlliance(
        [...alliance, candidate],
        runs,
        seededRandom(SEED + candidate.teamNumber),
      );
      const summary = summarize(totals);
      return {
        teamNumber: candidate.teamNumber,
        mean: summary.mean,
        badDay: summary.badDay,
        value: (summary.mean + summary.badDay) / 2,
      };
    })
    .sort((a, b) => b.value - a.value || a.teamNumber - b.teamNumber);
}

export interface HistogramBin {
  from: number;
  to: number;
  red: number;
  blue: number;
}

/** Shared bins for both alliances, so the two shapes overlay honestly. */
export function histogram(
  redTotals: readonly number[],
  blueTotals: readonly number[],
  binCount = 24,
): HistogramBin[] {
  const all = [...redTotals, ...blueTotals];
  if (all.length === 0) return [];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const width = max > min ? (max - min) / binCount : 1;
  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => ({
    from: min + i * width,
    to: min + (i + 1) * width,
    red: 0,
    blue: 0,
  }));
  const place = (value: number) =>
    Math.min(binCount - 1, Math.floor((value - min) / width));
  for (const v of redTotals) bins[place(v)].red += 1;
  for (const v of blueTotals) bins[place(v)].blue += 1;
  return bins;
}
