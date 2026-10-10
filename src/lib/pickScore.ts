// Weighted pick score: the "what are we picking for?" lens over the picklist.
//
// Every metric is derived from the team's own Match Scout schema, the same way
// picklistColumns.ts derives its columns — one per scoring phase (a form
// section whose questions are worth points), plus expected points,
// reliability, trend and, when the form asks about it, defense. Nothing here is
// a fixed season field list, so a team that rewrites its form gets sliders
// that match it with no rebuild.
//
// The score is a lens, not the record: the admin's hand ranking (PicklistDoc
// .order) is untouched by anything in this file. Pure functions only — the
// React views and their Firestore subscriptions live elsewhere.

import {
  counterNumber,
  percentileOfSorted,
  type MatchSubmission,
  type TeamAggregate,
} from "@/lib/aggregate";
import {
  counterWeight,
  SELECT_MODE_POINTS,
  type ScoringWeights,
  type TeamStrengthProfile,
} from "@/lib/drive";
import type { EventTeam } from "@/lib/eventData";
import type { FormSection, FormValues } from "@/lib/formSchema";
import type { TeamReliability } from "@/lib/reliability";

/** Teams per tier: one tier per round of an 8-alliance draft. */
export const TIER_SIZE = 8;
export const TIERS = ["S", "A", "B", "C"] as const;
export type Tier = (typeof TIERS)[number];

/** The share of a team's matches it falls below on a bad day (20th percentile). */
const BAD_DAY_PERCENTILE = 0.2;
/** Matches needed before a trend means anything. */
const TREND_MIN_MATCHES = 4;
/** How many of the latest matches the trend compares against the rest. */
const TREND_RECENT = 3;
/** A trend this many points per match either way earns a flag. */
export const TREND_FLAG_POINTS = 2;
/** Fewer scouted matches than this and the numbers are a guess. */
const FEW_MATCHES = 3;

export type PickMetricKind = "points" | "phase" | "reliability" | "trend" | "defense";

export interface PickMetric {
  /** Stable within a session: "points", "phase:<section title>", … */
  id: string;
  kind: PickMetricKind;
  label: string;
  /** One sentence for the slider's tooltip. */
  hint: string;
  /** For kind "phase": the Match Scout section this metric totals. */
  section?: string;
}

export type PickWeights = Record<string, number>;

/** Points a single submission's answers are worth, using the predictor's scoring. */
function fieldPoints(
  fields: FormSection["fields"],
  values: FormValues,
  weights: ScoringWeights,
): number {
  let points = 0;
  for (const field of fields) {
    if (field.kind === "counter") {
      points += counterNumber(values[field.id]) * counterWeight(field.id, weights);
    } else if (field.kind === "select") {
      const answer = values[field.id];
      if (typeof answer === "string") {
        points += SELECT_MODE_POINTS[field.id]?.[answer] ?? 0;
      }
    }
  }
  return points;
}

/** What one scouted match was worth, every section together. */
export function submissionPoints(
  sections: readonly FormSection[],
  values: FormValues,
  weights: ScoringWeights,
): number {
  return sections.reduce(
    (sum, section) => sum + fieldPoints(section.fields, values, weights),
    0,
  );
}

/** True when any question in the section can score points. */
function sectionScores(section: FormSection, weights: ScoringWeights): boolean {
  return section.fields.some(
    (field) =>
      (field.kind === "counter" && counterWeight(field.id, weights) > 0) ||
      (field.kind === "select" && field.id in SELECT_MODE_POINTS),
  );
}

/**
 * The counter that measures defense, if the form has one: a defense rating
 * first (it judges quality), then time spent defending. "Defended" counters
 * are about being on the receiving end and never count.
 */
export function defenseFieldId(sections: readonly FormSection[]): string | null {
  const counters = sections.flatMap((s) =>
    s.fields.filter((f) => f.kind === "counter"),
  );
  const about = (f: (typeof counters)[number]) => `${f.id} ${f.label}`;
  const playsDefense = counters.filter(
    (f) => /defen[cs]e/i.test(about(f)) && !/defended/i.test(about(f)),
  );
  const rating = playsDefense.find((f) => /skill|rating/i.test(about(f)));
  return (rating ?? playsDefense[0])?.id ?? null;
}

/** The sliders this team's form supports, in display order. */
export function buildPickMetrics(
  sections: readonly FormSection[],
  weights: ScoringWeights,
): PickMetric[] {
  const metrics: PickMetric[] = [
    {
      id: "points",
      kind: "points",
      label: "Expected points",
      hint: "Points a team adds per match — scouted where we have data, Statbotics EPA where we don't.",
    },
  ];
  for (const section of sections) {
    if (!sectionScores(section, weights)) continue;
    metrics.push({
      id: `phase:${section.title}`,
      kind: "phase",
      label: section.title,
      hint: `Average points per match from the ${section.title} questions on your Match Scout form.`,
      section: section.title,
    });
  }
  metrics.push(
    {
      id: "reliability",
      kind: "reliability",
      label: "Reliability",
      hint: "0–100. How close a team's bad day (its 20th-percentile match) is to its average, docked for every match a scout flagged a breakdown.",
    },
    {
      id: "trend",
      kind: "trend",
      label: "Trend",
      hint: `Points per match over the last ${TREND_RECENT} matches compared with the ones before.`,
    },
  );
  if (defenseFieldId(sections) !== null) {
    metrics.push({
      id: "defense",
      kind: "defense",
      label: "Defense",
      hint: "The team's average on your form's defense question.",
    });
  }
  return metrics;
}

export interface PickPreset {
  id: string;
  label: string;
  /** Weight per metric kind; every phase metric shares the "phase" weight. */
  weights: Record<PickMetricKind, number>;
}

export const PICK_PRESETS: readonly PickPreset[] = [
  {
    id: "balanced",
    label: "Balanced",
    weights: { points: 6, phase: 2, reliability: 3, trend: 1, defense: 0 },
  },
  {
    id: "firstPick",
    label: "First pick",
    weights: { points: 8, phase: 2, reliability: 2, trend: 1, defense: 0 },
  },
  {
    id: "secondPickDefender",
    label: "Second pick, defender",
    weights: { points: 2, phase: 0, reliability: 4, trend: 0, defense: 8 },
  },
  {
    id: "safeFloor",
    label: "Safe floor",
    weights: { points: 3, phase: 0, reliability: 8, trend: 0, defense: 0 },
  },
];

/** Expand a preset into one weight per metric the form actually has. */
export function presetWeights(
  preset: PickPreset,
  metrics: readonly PickMetric[],
): PickWeights {
  return Object.fromEntries(metrics.map((m) => [m.id, preset.weights[m.kind]]));
}

/** Which preset these weights match exactly, if any — so the chip stays lit. */
export function matchingPreset(
  weights: PickWeights,
  metrics: readonly PickMetric[],
): string | null {
  const found = PICK_PRESETS.find((preset) =>
    metrics.every((m) => (weights[m.id] ?? 0) === preset.weights[m.kind]),
  );
  return found?.id ?? null;
}

export interface TeamPickStats {
  teamNumber: number;
  /** Expected points per match; null when we know nothing. */
  points: number | null;
  source: TeamStrengthProfile["source"];
  /** Scouted matches (distinct match numbers). */
  matches: number;
  /** Average points per match by phase metric id. */
  phases: Record<string, number>;
  /** Points per scouted match, in match order — scouts on the same match averaged. */
  perMatch: number[];
  reliability: number | null;
  trend: number | null;
  defense: number | null;
  /** Matches a scout flagged a breakdown in. */
  flaggedMatches: number;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** One number per match: two scouts on the same robot in the same match are averaged, not double-counted. */
function pointsByMatch(
  sections: readonly FormSection[],
  submissions: readonly MatchSubmission[],
  weights: ScoringWeights,
): number[] {
  const byMatch = new Map<number, number[]>();
  for (const submission of submissions) {
    const list = byMatch.get(submission.matchNumber) ?? [];
    list.push(submissionPoints(sections, submission.values, weights));
    byMatch.set(submission.matchNumber, list);
  }
  return [...byMatch.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, points]) => mean(points));
}

/**
 * 0–100: bad-day points over average points, times the share of matches
 * nobody flagged. A robot that scores the same every match and never breaks
 * is 100; one whose 20th-percentile match is half its average is 50.
 */
export function reliabilityScore(
  perMatch: readonly number[],
  flaggedMatches: number,
): number | null {
  if (perMatch.length === 0) return null;
  const average = mean(perMatch);
  const badDay = percentileOfSorted(
    [...perMatch].sort((a, b) => a - b),
    BAD_DAY_PERCENTILE,
  ) ?? 0;
  const consistency = average > 0 ? Math.min(1, Math.max(0, badDay / average)) : 1;
  const healthy = Math.max(0, 1 - flaggedMatches / perMatch.length);
  return Math.round(100 * consistency * healthy);
}

/** Recent matches minus the earlier ones, in points per match. */
export function trendOf(perMatch: readonly number[]): number | null {
  if (perMatch.length < TREND_MIN_MATCHES) return null;
  const recent = perMatch.slice(-TREND_RECENT);
  const earlier = perMatch.slice(0, -TREND_RECENT);
  return mean(recent) - mean(earlier);
}

export function buildTeamPickStats(
  sections: readonly FormSection[],
  submissions: readonly MatchSubmission[],
  aggregates: ReadonlyMap<string, TeamAggregate>,
  profiles: ReadonlyMap<number, TeamStrengthProfile>,
  reliability: Readonly<Record<string, TeamReliability>>,
  eventTeams: readonly EventTeam[],
  weights: ScoringWeights,
): TeamPickStats[] {
  const byTeam = new Map<string, MatchSubmission[]>();
  for (const submission of submissions) {
    const list = byTeam.get(submission.scoutedTeam) ?? [];
    list.push(submission);
    byTeam.set(submission.scoutedTeam, list);
  }
  const scoringSections = sections.filter((s) => sectionScores(s, weights));
  const defenseId = defenseFieldId(sections);

  return eventTeams.map((team) => {
    const key = String(team.teamNumber);
    const teamSubmissions = byTeam.get(key) ?? [];
    const perMatch = pointsByMatch(sections, teamSubmissions, weights);
    const flagged = reliability[key]?.flaggedMatches.length ?? 0;
    const profile = profiles.get(team.teamNumber);
    const aggregate = aggregates.get(key);

    const phases: Record<string, number> = {};
    for (const section of scoringSections) {
      const perSection = teamSubmissions.map((s) =>
        fieldPoints(section.fields, s.values, weights),
      );
      phases[`phase:${section.title}`] =
        perSection.length > 0 ? mean(perSection) : 0;
    }

    return {
      teamNumber: team.teamNumber,
      points: profile?.points ?? null,
      source: profile?.source ?? "none",
      matches: perMatch.length,
      phases,
      perMatch,
      reliability: reliabilityScore(perMatch, flagged),
      trend: trendOf(perMatch),
      defense:
        defenseId !== null && aggregate ? (aggregate.averages[defenseId] ?? 0) : null,
      flaggedMatches: flagged,
    };
  });
}

/** The raw value a metric reads off a team, before normalising. */
export function metricValue(metric: PickMetric, stats: TeamPickStats): number | null {
  switch (metric.kind) {
    case "points":
      return stats.points;
    case "phase":
      return stats.matches > 0 ? (stats.phases[metric.id] ?? 0) : null;
    case "reliability":
      return stats.reliability;
    case "trend":
      return stats.trend;
    case "defense":
      return stats.matches > 0 ? stats.defense : null;
  }
}

export interface PickRow extends TeamPickStats {
  /** 0–100 weighted blend of the normalised metrics. */
  pickScore: number;
  /** 1-based position by pick score among every team at the event. */
  scoreRank: number;
  tier: Tier;
  role: string;
  flags: string[];
}

/**
 * Min–max scale each metric across the event, then blend by the weights.
 * A team with no value for a metric gets the event's median for it — an
 * unscouted team shouldn't be buried or boosted by data nobody collected.
 */
export function scorePicklist(
  stats: readonly TeamPickStats[],
  metrics: readonly PickMetric[],
  weights: PickWeights,
): PickRow[] {
  const normalised = new Map<string, Map<number, number>>();
  for (const metric of metrics) {
    const values = stats
      .map((s) => [s.teamNumber, metricValue(metric, s)] as const)
      .filter((entry): entry is readonly [number, number] => entry[1] !== null);
    const scaled = new Map<number, number>();
    if (values.length > 0) {
      const nums = values.map(([, v]) => v);
      const min = Math.min(...nums);
      const max = Math.max(...nums);
      for (const [team, v] of values) {
        scaled.set(team, max > min ? (v - min) / (max - min) : 0.5);
      }
      const median = percentileOfSorted([...scaled.values()].sort((a, b) => a - b), 0.5) ?? 0.5;
      for (const s of stats) {
        if (!scaled.has(s.teamNumber)) scaled.set(s.teamNumber, median);
      }
    }
    normalised.set(metric.id, scaled);
  }

  const totalWeight = metrics.reduce((sum, m) => sum + Math.max(0, weights[m.id] ?? 0), 0);
  const pointsMetric = metrics.find((m) => m.kind === "points");
  const blend = (team: number): number => {
    // Every slider at zero still has to rank something; points is the honest default.
    if (totalWeight === 0) {
      return pointsMetric ? (normalised.get(pointsMetric.id)?.get(team) ?? 0) : 0;
    }
    let sum = 0;
    for (const metric of metrics) {
      const weight = Math.max(0, weights[metric.id] ?? 0);
      sum += weight * (normalised.get(metric.id)?.get(team) ?? 0);
    }
    return sum / totalWeight;
  };

  const scored = stats
    .map((s) => ({ stats: s, raw: blend(s.teamNumber) }))
    .sort(
      (a, b) =>
        b.raw - a.raw ||
        (b.stats.points ?? -Infinity) - (a.stats.points ?? -Infinity) ||
        a.stats.teamNumber - b.stats.teamNumber,
    );

  const pointsRanked = stats
    .map((s) => s.points)
    .filter((p): p is number => p !== null)
    .sort((a, b) => a - b);
  const defenseMetric = metrics.find((m) => m.kind === "defense");
  const phaseMetrics = metrics.filter((m) => m.kind === "phase");

  return scored.map(({ stats: s, raw }, index) => ({
    ...s,
    pickScore: Math.round(raw * 100),
    scoreRank: index + 1,
    tier: TIERS[Math.min(Math.floor(index / TIER_SIZE), TIERS.length - 1)],
    role: roleOf(s, phaseMetrics, pointsRanked, defenseMetric ? normalised.get(defenseMetric.id) : undefined),
    flags: flagsOf(s),
  }));
}

/** Where a value sits among sorted values, 0–1. */
function percentileRank(sorted: readonly number[], value: number): number {
  if (sorted.length <= 1) return 0.5;
  const below = sorted.filter((v) => v < value).length;
  return below / (sorted.length - 1);
}

/**
 * A two-word read on what the robot does: the phase most of its points come
 * from, "All-round" when two phases split them, or Defender / Support when
 * it doesn't score much.
 */
export function roleOf(
  stats: TeamPickStats,
  phaseMetrics: readonly PickMetric[],
  pointsSorted: readonly number[],
  defenseScaled: ReadonlyMap<number, number> | undefined,
): string {
  if (stats.points === null) return "Unknown";
  const pointsPct = percentileRank(pointsSorted, stats.points);
  if (pointsPct < 0.35) {
    if (stats.matches > 0 && (defenseScaled?.get(stats.teamNumber) ?? 0) >= 0.66) {
      return "Defender";
    }
    return "Support";
  }
  if (stats.matches === 0) return "Scorer";
  const shares = phaseMetrics
    .map((m) => ({ label: m.label, points: stats.phases[m.id] ?? 0 }))
    .sort((a, b) => b.points - a.points);
  const total = shares.reduce((sum, s) => sum + s.points, 0);
  if (total <= 0 || shares.length === 0) return "Scorer";
  if (shares.length > 1 && shares[1].points / total >= 0.35) return "All-round scorer";
  return `${shares[0].label} scorer`;
}

export function flagsOf(stats: TeamPickStats): string[] {
  const flags: string[] = [];
  if (stats.matches === 0) {
    flags.push(stats.source === "epa" ? "EPA only" : "No data");
    return flags;
  }
  if (stats.flaggedMatches > 0) flags.push(`Disabled ${stats.flaggedMatches}×`);
  if (stats.trend !== null && stats.trend >= TREND_FLAG_POINTS) flags.push("Trending up");
  if (stats.trend !== null && stats.trend <= -TREND_FLAG_POINTS) flags.push("Trending down");
  if (stats.matches < FEW_MATCHES) flags.push("Few matches");
  return flags;
}
