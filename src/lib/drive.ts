// Drive Dashboard helpers: pure functions that turn match-scout aggregates,
// admin-set point weights, and Statbotics EPA into per-team strength profiles
// and alliance-vs-alliance predictions. Kept free of React and Firestore so
// the math is testable on its own (see drive.test.ts).

import type { TeamAggregate } from "@/lib/aggregate";
import { counterFieldIds } from "@/lib/aggregate";
import { isCustomFieldId } from "@/lib/customForms";
import type { EventMatch, EventTeam } from "@/lib/eventData";
import type { FormSection } from "@/lib/formSchema";

/** Points a counter is worth when it has no weight listed below. */
export const DEFAULT_WEIGHT = 1;

/** Point value per counter field id. */
export type ScoringWeights = Record<string, number>;

/**
 * What each Match Scout counter is worth, in points — REBUILT (2026) values.
 *
 * Set here rather than in the app: scoring is a property of the season's game,
 * the same for everyone, and not something an admin should be able to get
 * wrong mid-event. Keys are counter field ids from matchScoutSchema.ts. A
 * counter with no entry here is worth DEFAULT_WEIGHT.
 *
 * Fuel is 1 point apiece in auto and teleop alike. Fed/passed fuel scores
 * nothing until a partner shoots it (and then it lands in *their* fuel
 * count), and the 0–5 ratings are judgment calls, not points.
 */
export const SCORING_WEIGHTS: ScoringWeights = {
  autoScoredFuel: 1,
  teleopScoredFuel: 1,
  teleopFuelFed: 0,
  driverSkill: 0,
  defenseSkill: 0,
  // A rate, not a total — the fuel it produces is already counted as fuel.
  fuelRate: 0,
  // Seconds, not points — without these the default 1-point weight would
  // score a minute of defense as a minute's worth of fuel.
  defenseSeconds: 0,
  defendedSeconds: 0,
  immobilizedSeconds: 0,
};

/**
 * Climb points arrive through select fields, not counters, so the predictor
 * credits a team's *typical* (modal) answer: REBUILT pays 15 for a Level 1
 * climb in auto and 10/20/30 for Tower Levels 1/2/3 in endgame. Options
 * missing here (failed attempts, "None") are worth nothing.
 */
export const SELECT_MODE_POINTS: Record<string, Record<string, number>> = {
  autoClimb: { "Climbed (L1)": 15 },
  endgame: { "Level 1": 10, "Level 2": 20, "Level 3": 30 },
};

/**
 * What one unit of a counter is worth to the predictor. Team-added counters
 * score nothing: an admin who adds "cycles counted" from Form Setup is
 * tracking something for themselves, not redefining the season's scoring, and
 * DEFAULT_WEIGHT would otherwise fold it straight into predicted points.
 */
export function counterWeight(
  fieldId: string,
  weights: ScoringWeights,
): number {
  if (isCustomFieldId(fieldId)) return 0;
  return weights[fieldId] ?? DEFAULT_WEIGHT;
}

/**
 * Match Scout fields the predictor reads. Nothing errors when one goes
 * missing — the points it contributed just silently vanish from every
 * prediction — so Form Setup warns before saving an edit that drops one, and
 * the Drive Dash flags the gap (see missingPredictionFields).
 */
export const PREDICTION_FIELD_IDS: readonly string[] = [
  ...Object.entries(SCORING_WEIGHTS)
    .filter(([, points]) => points !== 0)
    .map(([fieldId]) => fieldId),
  ...Object.keys(SELECT_MODE_POINTS),
];

/**
 * The option strings the predictor scores for one select field, in the order
 * SELECT_MODE_POINTS lists them. Empty for a field it doesn't score.
 *
 * Form Setup lets an admin rewrite a default question's choices, and these are
 * matched by their exact text — rename "Level 2" and a scout picking it scores
 * nothing. The editor warns with this list rather than silently going quiet.
 */
export function scoredOptionsFor(fieldId: string): string[] {
  return Object.keys(SELECT_MODE_POINTS[fieldId] ?? {});
}

/**
 * Which predictor inputs this team's effective Match Scout form no longer
 * collects. Empty means predictions are running on complete data.
 */
export function missingPredictionFields(
  sections: readonly FormSection[],
): string[] {
  const present = new Set(
    sections.flatMap((section) => section.fields.map((field) => field.id)),
  );
  return PREDICTION_FIELD_IDS.filter((fieldId) => !present.has(fieldId));
}

/** A counter where a team clearly stands out from the event field. */
export interface FieldEdge {
  fieldId: string;
  /** Team's per-match average for the counter. */
  avg: number;
  /** Mean of that average across every team with scout data. */
  eventAvg: number;
  /** avg / eventAvg (eventAvg is always > 0 for emitted edges). */
  ratio: number;
}

export interface TeamStrengthProfile {
  teamNumber: number;
  /** Predicted points contributed per match. Null when nothing is known. */
  points: number | null;
  /** Where the points figure came from. */
  source: "scouted" | "epa" | "none";
  /** Scouted match count backing the figure (0 for EPA fallback). */
  matches: number;
  strengths: FieldEdge[];
  weaknesses: FieldEdge[];
}

/** A team reads as strong/weak on a counter beyond these ratios. */
const STRENGTH_RATIO = 1.2;
const WEAKNESS_RATIO = 0.8;
/** Cap per list so the dashboard shows the sharpest edges, not every field. */
const MAX_EDGES = 3;

/**
 * Mean of each counter's per-team average across all scouted teams — the
 * event-wide baseline a single team's numbers are judged against.
 */
export function eventFieldAverages(
  sections: readonly FormSection[],
  aggregates: readonly TeamAggregate[],
): Record<string, number> {
  const baseline: Record<string, number> = {};
  if (aggregates.length === 0) return baseline;
  for (const id of counterFieldIds(sections)) {
    const total = aggregates.reduce((sum, a) => sum + (a.averages[id] ?? 0), 0);
    baseline[id] = total / aggregates.length;
  }
  return baseline;
}

/**
 * Weighted points-per-match a team's scouted data adds up to: counter
 * averages times their weights, plus the point value of each climb select's
 * modal answer (see SELECT_MODE_POINTS).
 */
export function scoutedPoints(
  sections: readonly FormSection[],
  aggregate: TeamAggregate,
  weights: ScoringWeights,
): number {
  const counterPoints = counterFieldIds(sections).reduce(
    (sum, id) => sum + (aggregate.averages[id] ?? 0) * counterWeight(id, weights),
    0,
  );
  const climbPoints = Object.entries(SELECT_MODE_POINTS).reduce(
    (sum, [fieldId, byOption]) => {
      const mode = aggregate.modes[fieldId];
      return sum + (mode ? (byOption[mode] ?? 0) : 0);
    },
    0,
  );
  return counterPoints + climbPoints;
}

/**
 * Build one strength profile per team we know anything about. Scouted data
 * wins; teams nobody has scouted yet fall back to Statbotics EPA (also a
 * points-per-match figure, so the two sources sum comparably in an alliance).
 */
export function buildTeamProfiles(
  sections: readonly FormSection[],
  aggregates: readonly TeamAggregate[],
  weights: ScoringWeights,
  eventTeams: readonly EventTeam[],
): Map<number, TeamStrengthProfile> {
  const baseline = eventFieldAverages(sections, aggregates);
  const byTeam = new Map<number, TeamStrengthProfile>();

  for (const aggregate of aggregates) {
    const teamNumber = Number(aggregate.team);
    if (!Number.isInteger(teamNumber)) continue;

    const edges: FieldEdge[] = [];
    for (const [fieldId, eventAvg] of Object.entries(baseline)) {
      if (eventAvg <= 0) continue;
      // Only scoring counters can be a strength or a weakness. Without this
      // the zero-weighted ones — seconds defended, fuel rate, the 0–5 skill
      // ratings, and every custom tally — compete for the chips, so a robot
      // that simply got defended a lot reads as "strong at being defended".
      if (counterWeight(fieldId, weights) <= 0) continue;
      const avg = aggregate.averages[fieldId] ?? 0;
      edges.push({ fieldId, avg, eventAvg, ratio: avg / eventAvg });
    }
    const strengths = edges
      .filter((e) => e.ratio >= STRENGTH_RATIO)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, MAX_EDGES);
    const weaknesses = edges
      .filter((e) => e.ratio <= WEAKNESS_RATIO)
      .sort((a, b) => a.ratio - b.ratio)
      .slice(0, MAX_EDGES);

    byTeam.set(teamNumber, {
      teamNumber,
      points: scoutedPoints(sections, aggregate, weights),
      source: "scouted",
      matches: aggregate.matches,
      strengths,
      weaknesses,
    });
  }

  for (const team of eventTeams) {
    if (byTeam.has(team.teamNumber)) continue;
    byTeam.set(team.teamNumber, {
      teamNumber: team.teamNumber,
      points: team.epa,
      source: team.epa !== null ? "epa" : "none",
      matches: 0,
      strengths: [],
      weaknesses: [],
    });
  }

  return byTeam;
}

export interface AlliancePrediction {
  /** Sum of the alliance's per-team points. Null when no team is known. */
  points: number | null;
  /** Teams with neither scout data nor EPA — the number is partial. */
  unknownTeams: number[];
}

export function predictAlliance(
  teams: readonly number[],
  profiles: ReadonlyMap<number, TeamStrengthProfile>,
): AlliancePrediction {
  let points: number | null = null;
  const unknownTeams: number[] = [];
  for (const teamNumber of teams) {
    const profile = profiles.get(teamNumber);
    if (profile?.points != null) {
      points = (points ?? 0) + profile.points;
    } else {
      unknownTeams.push(teamNumber);
    }
  }
  return { points, unknownTeams };
}

/**
 * Chance the red alliance wins given both predicted point totals — a logistic
 * on the difference, matching the shape Statbotics uses for EPA (a 10-point
 * edge ≈ 64%, 30 ≈ 85%). Purely a readability aid, not a claim of rigor.
 */
export function redWinProbability(
  redPoints: number,
  bluePoints: number,
): number {
  return 1 / (1 + Math.pow(10, -(redPoints - bluePoints) / 40));
}

export interface MatchPrediction {
  match: EventMatch;
  red: AlliancePrediction;
  blue: AlliancePrediction;
  /** Null until both alliances have a points figure. */
  redWinProbability: number | null;
}

export function predictMatch(
  match: EventMatch,
  profiles: ReadonlyMap<number, TeamStrengthProfile>,
): MatchPrediction {
  const red = predictAlliance(match.red, profiles);
  const blue = predictAlliance(match.blue, profiles);
  return {
    match,
    red,
    blue,
    redWinProbability:
      red.points !== null && blue.points !== null
        ? redWinProbability(red.points, blue.points)
        : null,
  };
}

/** All of a team's unplayed matches, in schedule order. */
export function upcomingTeamMatches(
  matches: readonly EventMatch[],
  teamNumber: number,
): EventMatch[] {
  return matches.filter(
    (m) =>
      m.redScore === null &&
      m.blueScore === null &&
      (m.red.includes(teamNumber) || m.blue.includes(teamNumber)),
  );
}

/** A team's already-played matches, most recent first. */
export function pastTeamMatches(
  matches: readonly EventMatch[],
  teamNumber: number,
): EventMatch[] {
  return matches
    .filter(
      (m) =>
        (m.redScore !== null || m.blueScore !== null) &&
        (m.red.includes(teamNumber) || m.blue.includes(teamNumber)),
    )
    .reverse();
}

/**
 * How a played match turned out against what the predictor said. `called` is
 * null when the predictor had no opinion (an alliance with no data) or the
 * match was a tie — neither is a hit or a miss.
 */
export interface MatchReview {
  prediction: MatchPrediction;
  /** Who actually won, straight from the event feed. */
  winner: "red" | "blue" | "tie" | null;
  called: boolean | null;
}

export function reviewMatch(
  match: EventMatch,
  profiles: ReadonlyMap<number, TeamStrengthProfile>,
): MatchReview {
  const prediction = predictMatch(match, profiles);
  const probability = prediction.redWinProbability;
  let called: boolean | null = null;
  if (
    probability !== null &&
    (match.winner === "red" || match.winner === "blue")
  ) {
    called = (probability >= 0.5 ? "red" : "blue") === match.winner;
  }
  return { prediction, winner: match.winner, called };
}
