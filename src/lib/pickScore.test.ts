import { describe, expect, it } from "vitest";
import type { MatchSubmission, TeamAggregate } from "./aggregate";
import type { TeamStrengthProfile } from "./drive";
import type { EventTeam } from "./eventData";
import type { FormSection } from "./formSchema";
import {
  buildPickMetrics,
  buildTeamPickStats,
  defenseFieldId,
  flagsOf,
  matchingPreset,
  PICK_PRESETS,
  presetWeights,
  reliabilityScore,
  scorePicklist,
  submissionPoints,
  trendOf,
  type TeamPickStats,
} from "./pickScore";

const sections: FormSection[] = [
  { title: "Pre-Match", fields: [{ kind: "select", id: "startPos", label: "Start", options: ["L", "R"] }] },
  { title: "Autonomous", fields: [{ kind: "counter", id: "autoScoredFuel", label: "Fuel scored" }] },
  {
    title: "Teleop",
    fields: [
      { kind: "counter", id: "teleopScoredFuel", label: "Fuel scored" },
      { kind: "counter", id: "defendedSeconds", label: "Defended (sec)" },
    ],
  },
  { title: "Endgame", fields: [{ kind: "select", id: "endgame", label: "Climb", options: ["None", "Level 2"] }] },
  { title: "Post-Match", fields: [{ kind: "counter", id: "defenseSkill", label: "Defense skill (0–5)" }] },
];
const weights = { autoScoredFuel: 1, teleopScoredFuel: 1, defendedSeconds: 0, defenseSkill: 0 };

function eventTeam(teamNumber: number, epa: number | null = null): EventTeam {
  return { teamNumber, nickname: String(teamNumber), city: "", epa, epaRank: null };
}

function stats(teamNumber: number, over: Partial<TeamPickStats> = {}): TeamPickStats {
  return {
    teamNumber,
    points: 20,
    source: "scouted",
    matches: 5,
    phases: {},
    perMatch: [20, 20, 20, 20, 20],
    reliability: 100,
    trend: 0,
    defense: 0,
    flaggedMatches: 0,
    ...over,
  };
}

describe("buildPickMetrics", () => {
  it("offers one slider per scoring section plus the fixed ones", () => {
    const ids = buildPickMetrics(sections, weights).map((m) => m.id);
    expect(ids).toEqual([
      "points",
      "phase:Autonomous",
      "phase:Teleop",
      "phase:Endgame",
      "reliability",
      "trend",
      "defense",
    ]);
  });

  it("drops defense when the form never asks about it", () => {
    const noDefense = sections.slice(0, 4);
    expect(buildPickMetrics(noDefense, weights).some((m) => m.kind === "defense")).toBe(false);
  });
});

describe("defenseFieldId", () => {
  it("prefers a rating and ignores being defended", () => {
    expect(defenseFieldId(sections)).toBe("defenseSkill");
    expect(defenseFieldId(sections.slice(0, 3))).toBeNull();
  });
});

describe("submissionPoints", () => {
  it("adds weighted counters and scored select answers", () => {
    expect(
      submissionPoints(sections, { autoScoredFuel: 3, teleopScoredFuel: 10, endgame: "Level 2", defendedSeconds: 40 }, weights),
    ).toBe(33);
  });
});

describe("reliabilityScore", () => {
  it("is 100 for a steady robot nobody flagged", () => {
    expect(reliabilityScore([20, 20, 20, 20], 0)).toBe(100);
  });

  it("drops with a weak bad day and with flagged breakdowns", () => {
    // Bad day (20th percentile) is 18 against a 30 average.
    expect(reliabilityScore([10, 20, 40, 40, 40], 0)).toBe(60);
    expect(reliabilityScore([20, 20, 20, 20], 1)).toBe(75);
  });

  it("is null without scouted matches", () => {
    expect(reliabilityScore([], 0)).toBeNull();
  });
});

describe("trendOf", () => {
  it("compares the last three matches with the earlier ones", () => {
    expect(trendOf([10, 10, 20, 20, 20])).toBe(10);
    expect(trendOf([10, 10, 10])).toBeNull();
  });
});

describe("buildTeamPickStats", () => {
  it("averages two scouts on the same match instead of counting it twice", () => {
    const submissions: MatchSubmission[] = [
      { id: "a", matchNumber: 1, scoutedTeam: "111", alliance: "red", values: { teleopScoredFuel: 10 }, scoutName: "A" },
      { id: "b", matchNumber: 1, scoutedTeam: "111", alliance: "red", values: { teleopScoredFuel: 20 }, scoutName: "B" },
      { id: "c", matchNumber: 2, scoutedTeam: "111", alliance: "red", values: { teleopScoredFuel: 30 }, scoutName: "A" },
    ];
    const profiles = new Map<number, TeamStrengthProfile>([
      [111, { teamNumber: 111, points: 20, source: "scouted", matches: 3, strengths: [], weaknesses: [] }],
      [222, { teamNumber: 222, points: 12, source: "epa", matches: 0, strengths: [], weaknesses: [] }],
    ]);
    const [scouted, epaOnly] = buildTeamPickStats(
      sections,
      submissions,
      new Map<string, TeamAggregate>(),
      profiles,
      { "111": { flaggedMatches: [2], scoutedMatches: [1, 2], flaggedByName: "", updatedAtMs: 0 } },
      [eventTeam(111), eventTeam(222, 12)],
      weights,
    );
    expect(scouted.perMatch).toEqual([15, 30]);
    expect(scouted.matches).toBe(2);
    expect(scouted.flaggedMatches).toBe(1);
    expect(epaOnly).toMatchObject({ matches: 0, points: 12, source: "epa", reliability: null });
  });
});

describe("scorePicklist", () => {
  const metrics = buildPickMetrics(sections, weights);

  it("ranks by the weighted blend and assigns tiers by rank", () => {
    const teams = Array.from({ length: 20 }, (_, i) => stats(100 + i, { points: i }));
    const rows = scorePicklist(teams, metrics, { points: 1 });
    expect(rows[0]).toMatchObject({ teamNumber: 119, pickScore: 100, scoreRank: 1, tier: "S" });
    expect(rows[8].tier).toBe("A");
    expect(rows[16].tier).toBe("B");
    expect(rows[19]).toMatchObject({ teamNumber: 100, pickScore: 0 });
  });

  it("re-ranks when the weights change", () => {
    const steady = stats(1, { points: 20, reliability: 100 });
    const flashy = stats(2, { points: 30, reliability: 40 });
    expect(scorePicklist([steady, flashy], metrics, { points: 1 })[0].teamNumber).toBe(2);
    expect(scorePicklist([steady, flashy], metrics, { reliability: 1 })[0].teamNumber).toBe(1);
  });

  it("gives a team missing a metric the event median, not zero", () => {
    const rows = scorePicklist(
      [stats(1, { reliability: 0 }), stats(2, { reliability: 100 }), stats(3, { reliability: 50 }), stats(4, { reliability: null })],
      metrics,
      { reliability: 1 },
    );
    expect(rows.find((r) => r.teamNumber === 4)?.pickScore).toBe(50);
  });

  it("falls back to points when every slider is zero", () => {
    const rows = scorePicklist([stats(1, { points: 5 }), stats(2, { points: 9 })], metrics, {});
    expect(rows[0].teamNumber).toBe(2);
  });
});

describe("presets", () => {
  it("round-trips through matchingPreset", () => {
    const metrics = buildPickMetrics(sections, weights);
    for (const preset of PICK_PRESETS) {
      expect(matchingPreset(presetWeights(preset, metrics), metrics)).toBe(preset.id);
    }
    expect(matchingPreset({ points: 99 }, metrics)).toBeNull();
  });
});

describe("flagsOf", () => {
  it("reads breakdowns, trend, and thin data", () => {
    expect(flagsOf(stats(1, { flaggedMatches: 2, trend: 3, matches: 2 }))).toEqual([
      "Disabled 2×",
      "Trending up",
      "Few matches",
    ]);
    expect(flagsOf(stats(1, { matches: 0, source: "epa" }))).toEqual(["EPA only"]);
  });
});
