import type { MatchAssignmentsDoc, MatchSlot, PitAssignmentsDoc } from "@/lib/assignments";
import {
  behindSlots,
  buildScoutStatuses,
  formatQuiet,
  matchScoutHref,
  needsAttention,
  pitScoutHref,
  remainingMatchSlots,
  remainingPitTeams,
  slotFromParams,
  STALL_THRESHOLD_MS,
} from "@/lib/dashboard";
import type { EventMatch } from "@/lib/eventData";
import type { ScoutDuty } from "@/lib/scoutDuty";
import { describe, expect, it } from "vitest";

const NOW = 1_700_000_000_000;

function match(number: number, played: boolean): EventMatch {
  return {
    key: `2026test_qm${number}`,
    compLevel: "qm",
    matchNumber: number,
    red: [5806, 254, 1114],
    blue: [148, 2056, 971],
    redScore: played ? 90 : null,
    blueScore: played ? 60 : null,
    winner: played ? "red" : null,
    scheduledTime: null,
  };
}

function slot(matchNumber: number, teamNumber: number, uid: string): MatchSlot {
  return {
    matchKey: `2026test_qm${matchNumber}`,
    compLevel: "qm",
    matchNumber,
    teamNumber,
    alliance: "red",
    uid,
  };
}

describe("behindSlots", () => {
  const matches = [match(1, true), match(2, true), match(3, false)];
  const slots = [slot(1, 254, "ana"), slot(2, 254, "ana"), slot(3, 254, "ana")];

  it("counts played slots that were never crossed off", () => {
    expect(behindSlots(slots, matches, "ana")).toHaveLength(2);
  });

  it("ignores crossed-off slots", () => {
    const done = ["2026test_qm1:254"];
    expect(behindSlots(slots, matches, "ana", done)).toHaveLength(1);
  });

  it("does not count an unplayed match as late", () => {
    expect(
      behindSlots([slot(3, 254, "ana")], matches, "ana").length,
    ).toBe(0);
  });

  it("ignores a slot whose match TBA hasn't published yet", () => {
    expect(behindSlots([slot(99, 254, "ana")], matches, "ana")).toHaveLength(0);
  });

  it("only counts the given scout's slots", () => {
    expect(behindSlots([slot(1, 254, "raj")], matches, "ana")).toHaveLength(0);
  });
});

describe("remaining work", () => {
  const pitDoc: PitAssignmentsDoc = {
    byScout: { ana: [254, 1114, 2056] },
    scoutNames: { ana: "Ana" },
    completedTeams: [1114],
    generatedAt: 0,
  };

  it("drops crossed-off pit teams", () => {
    expect(remainingPitTeams(pitDoc, "ana")).toEqual([254, 2056]);
  });

  it("treats an unknown scout as having nothing assigned", () => {
    expect(remainingPitTeams(pitDoc, "nobody")).toEqual([]);
    expect(remainingPitTeams(null, "ana")).toEqual([]);
  });

  it("drops crossed-off match slots", () => {
    const matchDoc: MatchAssignmentsDoc = {
      slots: [slot(1, 254, "ana"), slot(2, 254, "ana")],
      scoutNames: { ana: "Ana" },
      completedSlots: ["2026test_qm1:254"],
      generatedAt: 0,
    };
    expect(remainingMatchSlots(matchDoc, "ana")).toHaveLength(1);
  });
});

describe("buildScoutStatuses", () => {
  const crew = [
    { uid: "ana", name: "Ana", role: "scout" as const },
    { uid: "raj", name: "Raj", role: "scout" as const },
  ];
  const duties: Record<string, ScoutDuty> = { ana: "both", raj: "both" };
  const matches = [match(1, true), match(2, false)];

  function matchDoc(completed: string[] = []): MatchAssignmentsDoc {
    return {
      slots: [slot(1, 254, "ana"), slot(2, 254, "ana"), slot(1, 148, "raj")],
      scoutNames: { ana: "Ana", raj: "Raj" },
      completedSlots: completed,
      generatedAt: 0,
    };
  }

  it("flags a scout whose played match was never crossed off", () => {
    const [first] = buildScoutStatuses(
      [crew[0]],
      duties,
      null,
      matchDoc(),
      matches,
      { ana: NOW },
      NOW,
    );
    expect(first.state).toBe("behind");
    expect(first.behindCount).toBe(1);
  });

  it("flags a quiet scout with work left as stalled", () => {
    const [first] = buildScoutStatuses(
      [crew[0]],
      duties,
      null,
      matchDoc(["2026test_qm1:254"]),
      matches,
      { ana: NOW - STALL_THRESHOLD_MS - 1 },
      NOW,
    );
    expect(first.state).toBe("stalled");
  });

  it("keeps a recently-active scout on track", () => {
    const [first] = buildScoutStatuses(
      [crew[0]],
      duties,
      null,
      matchDoc(["2026test_qm1:254"]),
      matches,
      { ana: NOW - 60_000 },
      NOW,
    );
    expect(first.state).toBe("ontrack");
  });

  it("treats a scout who has never submitted as stalled once work exists", () => {
    const [first] = buildScoutStatuses(
      [crew[0]],
      duties,
      null,
      matchDoc(["2026test_qm1:254"]),
      matches,
      {},
      NOW,
    );
    expect(first.state).toBe("stalled");
    expect(first.quietForMs).toBeNull();
  });

  it("ranks 'behind' above 'stalled' — a missed robot beats a quiet tablet", () => {
    const statuses = buildScoutStatuses(
      crew,
      duties,
      null,
      matchDoc(["2026test_qm1:254"]), // ana clear, raj still behind on qm1
      matches,
      { ana: NOW - STALL_THRESHOLD_MS - 1, raj: NOW },
      NOW,
    );
    expect(statuses[0]).toMatchObject({ uid: "raj", state: "behind" });
    expect(statuses[1]).toMatchObject({ uid: "ana", state: "stalled" });
  });

  it("marks a scout with everything crossed off as clear, not stalled", () => {
    const [first] = buildScoutStatuses(
      [crew[0]],
      duties,
      null,
      { ...matchDoc(), slots: [slot(1, 254, "ana")], completedSlots: ["2026test_qm1:254"] },
      matches,
      { ana: NOW - STALL_THRESHOLD_MS - 1 },
      NOW,
    );
    expect(first.state).toBe("clear");
  });

  it("lists an admin only once they carry a scouting duty", () => {
    const boss = { uid: "lee", name: "Lee", role: "admin" as const };
    expect(buildScoutStatuses([boss], {}, null, null, matches, {}, NOW)).toEqual([]);
    const [first] = buildScoutStatuses(
      [boss],
      { lee: "match" },
      null,
      null,
      matches,
      {},
      NOW,
    );
    expect(first).toMatchObject({ uid: "lee", state: "idle" });
  });

  it("marks an unassigned scout idle rather than stalled", () => {
    const [first] = buildScoutStatuses([crew[0]], duties, null, null, matches, {}, NOW);
    expect(first.state).toBe("idle");
  });

  it("leaves non-scouting duties out of the crew list entirely", () => {
    const statuses = buildScoutStatuses(
      crew,
      { ana: "driveTeam", raj: "viewer" },
      null,
      matchDoc(),
      matches,
      {},
      NOW,
    );
    expect(statuses).toEqual([]);
  });

  it("keeps pit-only scouts, who have no match slots to fall behind on", () => {
    const pitDoc: PitAssignmentsDoc = {
      byScout: { ana: [254] },
      scoutNames: { ana: "Ana" },
      completedTeams: [],
      generatedAt: 0,
    };
    const [first] = buildScoutStatuses(
      [crew[0]],
      { ana: "pit" },
      pitDoc,
      null,
      matches,
      { ana: NOW },
      NOW,
    );
    expect(first.state).toBe("ontrack");
    expect(first.remaining).toBe(1);
  });

  it("clamps a future-dated submission instead of reporting negative silence", () => {
    const [first] = buildScoutStatuses(
      [crew[0]],
      duties,
      null,
      matchDoc(["2026test_qm1:254"]),
      matches,
      { ana: NOW + 60_000 },
      NOW,
    );
    expect(first.quietForMs).toBe(0);
    expect(first.state).toBe("ontrack");
  });

  it("counts pit and match work together in remaining", () => {
    const pitDoc: PitAssignmentsDoc = {
      byScout: { ana: [254, 1114] },
      scoutNames: { ana: "Ana" },
      completedTeams: [254],
      generatedAt: 0,
    };
    const [first] = buildScoutStatuses(
      [crew[0]],
      duties,
      pitDoc,
      matchDoc(["2026test_qm1:254"]),
      matches,
      { ana: NOW },
      NOW,
    );
    expect(first.remaining).toBe(2); // 1114 pit + qm2 slot
    expect(first.assigned).toBe(4);
  });
});

describe("needsAttention", () => {
  it("keeps only behind and stalled crew", () => {
    const statuses = buildScoutStatuses(
      [
        { uid: "ana", name: "Ana", role: "scout" },
        { uid: "raj", name: "Raj", role: "scout" },
      ],
      { ana: "both", raj: "both" },
      null,
      {
        slots: [slot(1, 254, "ana"), slot(2, 148, "raj")],
        scoutNames: {},
        completedSlots: [],
        generatedAt: 0,
      },
      [match(1, true), match(2, false)],
      { ana: NOW, raj: NOW },
      NOW,
    );
    expect(needsAttention(statuses).map((s) => s.uid)).toEqual(["ana"]);
  });
});

describe("deep links", () => {
  it("points the pit form at a team", () => {
    expect(pitScoutHref(254)).toBe("/pit-scout?team=254");
  });

  it("carries match, team and alliance to the match form", () => {
    const href = matchScoutHref(slot(7, 1114, "ana"));
    const params = new URLSearchParams(href.split("?")[1]);
    expect(params.get("match")).toBe("7");
    expect(params.get("team")).toBe("1114");
    expect(params.get("alliance")).toBe("red");
  });

  it("round-trips a slot so a deep-linked submission still crosses off", () => {
    const original = slot(7, 1114, "ana");
    const values = Object.fromEntries(
      new URLSearchParams(matchScoutHref(original).split("?")[1]),
    );
    expect(slotFromParams(values, "ana")).toEqual(original);
  });

  it("returns null when the link predates slot round-tripping", () => {
    expect(
      slotFromParams({ match: "7", team: "1114", alliance: "red" }, "ana"),
    ).toBeNull();
  });

  it("rejects a hand-typed link with a junk alliance or team", () => {
    const base = { match: "7", matchKey: "k", compLevel: "qm" };
    expect(slotFromParams({ ...base, team: "1114", alliance: "green" }, "ana")).toBeNull();
    expect(slotFromParams({ ...base, team: "abc", alliance: "red" }, "ana")).toBeNull();
  });
});

describe("formatQuiet", () => {
  it("reads minutes under an hour", () => {
    expect(formatQuiet(41 * 60_000)).toBe("41m");
  });

  it("reads hours and padded minutes past one", () => {
    expect(formatQuiet(125 * 60_000)).toBe("2h 05m");
  });

  it("says never for a scout who has submitted nothing", () => {
    expect(formatQuiet(null)).toBe("never");
  });
});
