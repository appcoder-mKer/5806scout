import { describe, expect, it } from "vitest";
import type { TeamAggregate } from "@/lib/aggregate";
import type { EventMatch, EventTeam } from "@/lib/eventData";
import type { FormSection } from "@/lib/formSchema";
import {
  buildTeamProfiles,
  counterWeight,
  eventFieldAverages,
  missingPredictionFields,
  pastTeamMatches,
  predictAlliance,
  predictMatch,
  redWinProbability,
  reviewMatch,
  scoredOptionsFor,
  scoutedPoints,
  upcomingTeamMatches,
} from "@/lib/drive";
import { MATCH_SCOUT_SECTIONS } from "@/lib/matchScoutSchema";

const SECTIONS: FormSection[] = [
  {
    title: "Teleop",
    fields: [
      { kind: "counter", id: "low", label: "Scored — low" },
      { kind: "counter", id: "high", label: "Scored — high" },
      { kind: "select", id: "endgame", label: "Endgame", options: ["None", "Climb"] },
    ],
  },
];

function aggregate(
  team: string,
  averages: Record<string, number>,
  matches = 4,
): TeamAggregate {
  return { team, matches, averages, modes: { endgame: "Climb" }, samples: {} };
}

function eventTeam(teamNumber: number, epa: number | null): EventTeam {
  return { teamNumber, nickname: `Team ${teamNumber}`, city: "", epa, epaRank: null };
}

function match(overrides: Partial<EventMatch>): EventMatch {
  return {
    key: "2026test_qm1",
    compLevel: "qm",
    matchNumber: 1,
    red: [1, 2, 3],
    blue: [4, 5, 6],
    redScore: null,
    blueScore: null,
    winner: null,
    scheduledTime: null,
    ...overrides,
  };
}

describe("scoutedPoints", () => {
  it("weights counter averages, defaulting unset weights to 1", () => {
    const agg = aggregate("100", { low: 3, high: 2 });
    expect(scoutedPoints(SECTIONS, agg, { high: 5 })).toBe(3 * 1 + 2 * 5);
  });

  it("ignores select fields and missing averages", () => {
    const agg = aggregate("100", { low: 4 });
    expect(scoutedPoints(SECTIONS, agg, {})).toBe(4);
  });

  it("adds REBUILT climb points from the modal select answers", () => {
    const agg: TeamAggregate = {
      team: "100",
      matches: 4,
      averages: { low: 3 },
      modes: { endgame: "Level 2", autoClimb: "Climbed (L1)" },
      samples: {},
    };
    expect(scoutedPoints(SECTIONS, agg, {})).toBe(3 + 20 + 15);
  });

  it("scores unlisted climb answers (failed, none) as zero", () => {
    const agg: TeamAggregate = {
      team: "100",
      matches: 4,
      averages: {},
      modes: { endgame: "Failed attempt", autoClimb: "No attempt" },
      samples: {},
    };
    expect(scoutedPoints(SECTIONS, agg, {})).toBe(0);
  });
});

describe("eventFieldAverages", () => {
  it("averages each counter across scouted teams", () => {
    const baseline = eventFieldAverages(SECTIONS, [
      aggregate("1", { low: 2, high: 4 }),
      aggregate("2", { low: 6, high: 0 }),
    ]);
    expect(baseline).toEqual({ low: 4, high: 2 });
  });

  it("is empty with no data", () => {
    expect(eventFieldAverages(SECTIONS, [])).toEqual({});
  });
});

describe("buildTeamProfiles", () => {
  const aggregates = [
    aggregate("1", { low: 8, high: 4 }), // strong everywhere
    aggregate("2", { low: 2, high: 1 }), // weak everywhere
    aggregate("3", { low: 5, high: 2.5 }), // dead average
  ];

  it("leaves zero-weighted counters out of the strength and weakness chips", () => {
    // Regression: edges were built from every counter in the baseline, so a
    // robot that simply got defended a lot surfaced "Defended against" as a
    // top strength, and a custom tally could outrank a real scoring field.
    const profiles = buildTeamProfiles(SECTIONS, aggregates, { high: 0 }, []);
    const strong = profiles.get(1)!;
    expect(strong.strengths.map((e) => e.fieldId)).toEqual(["low"]);
    expect(profiles.get(2)!.weaknesses.map((e) => e.fieldId)).toEqual(["low"]);
  });

  it("keeps custom counters out of the chips — they are never scoring fields", () => {
    const sections: FormSection[] = [
      {
        title: "Teleop",
        fields: [
          { kind: "counter", id: "low", label: "Scored — low" },
          { kind: "counter", id: "custom_tally", label: "Our own tally" },
        ],
      },
    ];
    const profiles = buildTeamProfiles(
      sections,
      [
        aggregate("1", { low: 8, custom_tally: 40 }),
        aggregate("2", { low: 2, custom_tally: 1 }),
      ],
      {},
      [],
    );
    expect(profiles.get(1)!.strengths.map((e) => e.fieldId)).not.toContain(
      "custom_tally",
    );
  });

  it("marks scouted teams with weighted points and flags edges", () => {
    const profiles = buildTeamProfiles(SECTIONS, aggregates, { high: 2 }, []);
    const strong = profiles.get(1)!;
    expect(strong.source).toBe("scouted");
    expect(strong.points).toBe(8 + 4 * 2);
    expect(strong.strengths.map((e) => e.fieldId).sort()).toEqual(["high", "low"]);
    expect(strong.weaknesses).toEqual([]);

    const weak = profiles.get(2)!;
    expect(weak.weaknesses.length).toBeGreaterThan(0);
    expect(weak.strengths).toEqual([]);

    const mid = profiles.get(3)!;
    expect(mid.strengths).toEqual([]);
    expect(mid.weaknesses).toEqual([]);
  });

  it("falls back to EPA for unscouted teams, none when EPA is missing", () => {
    const profiles = buildTeamProfiles(SECTIONS, aggregates, {}, [
      eventTeam(1, 99), // scouted — EPA must not override
      eventTeam(7, 31.5),
      eventTeam(8, null),
    ]);
    expect(profiles.get(1)!.source).toBe("scouted");
    expect(profiles.get(7)).toMatchObject({ points: 31.5, source: "epa", matches: 0 });
    expect(profiles.get(8)).toMatchObject({ points: null, source: "none" });
  });

  it("skips aggregates whose team id is not numeric", () => {
    const profiles = buildTeamProfiles(
      SECTIONS,
      [aggregate("frc1", { low: 1 })],
      {},
      [],
    );
    expect(profiles.size).toBe(0);
  });
});

describe("predictAlliance / predictMatch", () => {
  const profiles = buildTeamProfiles(
    SECTIONS,
    [aggregate("1", { low: 10, high: 0 }), aggregate("2", { low: 20, high: 0 })],
    {},
    [eventTeam(4, 25), eventTeam(5, null)],
  );

  it("sums known teams and reports unknown ones", () => {
    const p = predictAlliance([1, 2, 3], profiles);
    expect(p.points).toBe(30);
    expect(p.unknownTeams).toEqual([3]);
  });

  it("is null when nothing is known", () => {
    expect(predictAlliance([8, 9], profiles)).toEqual({
      points: null,
      unknownTeams: [8, 9],
    });
  });

  it("mixes scouted and EPA sources in one alliance", () => {
    expect(predictAlliance([1, 4], profiles).points).toBe(35);
  });

  it("predictMatch only computes a probability with both sides known", () => {
    const withBoth = predictMatch(match({ red: [1], blue: [4] }), profiles);
    expect(withBoth.redWinProbability).not.toBeNull();
    expect(withBoth.redWinProbability!).toBeLessThan(0.5); // 10 vs 25

    const oneSided = predictMatch(match({ red: [1], blue: [9] }), profiles);
    expect(oneSided.redWinProbability).toBeNull();
  });
});

describe("redWinProbability", () => {
  it("is symmetric around 0.5", () => {
    expect(redWinProbability(50, 50)).toBeCloseTo(0.5);
    expect(redWinProbability(60, 50) + redWinProbability(50, 60)).toBeCloseTo(1);
  });

  it("grows with the point edge", () => {
    expect(redWinProbability(60, 50)).toBeGreaterThan(0.5);
    expect(redWinProbability(80, 50)).toBeGreaterThan(redWinProbability(60, 50));
  });
});

describe("upcomingTeamMatches", () => {
  it("keeps only unplayed matches including the team, in order", () => {
    const matches = [
      match({ key: "qm1", matchNumber: 1, red: [1, 2, 3], redScore: 50, blueScore: 40 }),
      match({ key: "qm2", matchNumber: 2, red: [1, 7, 8] }),
      match({ key: "qm3", matchNumber: 3, red: [9, 7, 8], blue: [4, 5, 6] }),
      match({ key: "qm4", matchNumber: 4, blue: [1, 5, 6], red: [9, 7, 8] }),
    ];
    expect(upcomingTeamMatches(matches, 1).map((m) => m.key)).toEqual([
      "qm2",
      "qm4",
    ]);
  });
});

describe("counterWeight", () => {
  it("uses the season weight, falling back to 1 point per unit", () => {
    expect(counterWeight("high", { high: 5 })).toBe(5);
    expect(counterWeight("low", { high: 5 })).toBe(1);
    expect(counterWeight("teleopFuelFed", { teleopFuelFed: 0 })).toBe(0);
  });

  it("scores team-added counters at zero", () => {
    // A team tallying something of their own must not move the predictor,
    // which DEFAULT_WEIGHT would otherwise do.
    expect(counterWeight("custom_cycles", {})).toBe(0);
    expect(counterWeight("custom_cycles", { custom_cycles: 3 })).toBe(0);
  });
});

describe("scoutedPoints with team-added counters", () => {
  it("leaves a custom counter out of the points total", () => {
    const sections: FormSection[] = [
      {
        title: "Teleop",
        fields: [
          { kind: "counter", id: "low", label: "Scored — low" },
          { kind: "counter", id: "custom_cycles", label: "Cycles" },
        ],
      },
    ];
    const agg: TeamAggregate = {
      team: "100",
      matches: 4,
      averages: { low: 3, custom_cycles: 9 },
      modes: {},
      samples: {},
    };
    expect(scoutedPoints(sections, agg, {})).toBe(3);
  });
});

describe("missingPredictionFields", () => {
  it("is empty when the form still asks every predictor input", () => {
    expect(missingPredictionFields(MATCH_SCOUT_SECTIONS)).toEqual([]);
  });

  it("names the inputs a customized form dropped", () => {
    const trimmed = MATCH_SCOUT_SECTIONS.map((section) => ({
      ...section,
      fields: section.fields.filter(
        (field) => field.id !== "teleopScoredFuel" && field.id !== "endgame",
      ),
    }));
    expect(missingPredictionFields(trimmed).sort()).toEqual([
      "endgame",
      "teleopScoredFuel",
    ]);
  });

  it("ignores fields the predictor scores at zero", () => {
    // teleopFuelFed and the 0–5 ratings weigh nothing, so losing them costs
    // the predictor nothing either.
    const trimmed = MATCH_SCOUT_SECTIONS.map((section) => ({
      ...section,
      fields: section.fields.filter(
        (field) => field.id !== "teleopFuelFed" && field.id !== "driverSkill",
      ),
    }));
    expect(missingPredictionFields(trimmed)).toEqual([]);
  });
});

describe("pastTeamMatches", () => {
  const played = [
    match({ key: "qm1", matchNumber: 1, redScore: 50, blueScore: 40, winner: "red" }),
    match({ key: "qm2", matchNumber: 2, red: [7, 8, 9], redScore: 10, blueScore: 20, winner: "blue" }),
    match({ key: "qm3", matchNumber: 3, redScore: 30, blueScore: 30, winner: "tie" }),
    match({ key: "qm4", matchNumber: 4 }),
  ];

  it("returns only the team's finished matches, most recent first", () => {
    expect(pastTeamMatches(played, 1).map((m) => m.key)).toEqual(["qm3", "qm1"]);
  });

  it("matches on either alliance", () => {
    expect(pastTeamMatches(played, 5).map((m) => m.key)).toEqual([
      "qm3",
      "qm2",
      "qm1",
    ]);
  });
});

describe("reviewMatch", () => {
  const profiles = buildTeamProfiles(
    SECTIONS,
    [aggregate("1", { high: 10 }), aggregate("4", { high: 1 })],
    {},
    [eventTeam(2, 5), eventTeam(3, 5), eventTeam(5, 5), eventTeam(6, 5)],
  );

  it("marks a prediction that matched the result as called", () => {
    const review = reviewMatch(
      match({ redScore: 60, blueScore: 20, winner: "red" }),
      profiles,
    );
    expect(review.prediction.redWinProbability).toBeGreaterThan(0.5);
    expect(review.called).toBe(true);
    expect(review.winner).toBe("red");
  });

  it("marks a prediction that went the other way as missed", () => {
    const review = reviewMatch(
      match({ redScore: 10, blueScore: 60, winner: "blue" }),
      profiles,
    );
    expect(review.called).toBe(false);
  });

  it("scores neither a hit nor a miss on a tie", () => {
    expect(reviewMatch(match({ winner: "tie" }), profiles).called).toBeNull();
  });

  it("scores nothing when an alliance has no data at all", () => {
    const review = reviewMatch(
      match({ red: [900, 901, 902], winner: "red" }),
      new Map(),
    );
    expect(review.prediction.redWinProbability).toBeNull();
    expect(review.called).toBeNull();
  });
});

describe("scoredOptionsFor", () => {
  it("names the option strings the predictor pays out for", () => {
    // Editing these in Form Setup is what the editor's warning is guarding:
    // the mapping is by exact text, so a rename scores nothing.
    expect(scoredOptionsFor("endgame")).toEqual(["Level 1", "Level 2", "Level 3"]);
    expect(scoredOptionsFor("autoClimb")).toEqual(["Climbed (L1)"]);
  });

  it("is empty for a field the predictor doesn't score by option", () => {
    expect(scoredOptionsFor("notes")).toEqual([]);
    expect(scoredOptionsFor("custom_anything")).toEqual([]);
  });
});
