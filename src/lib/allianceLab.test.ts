import { describe, expect, it } from "vitest";
import {
  histogram,
  rankPartners,
  seededRandom,
  simulateMatchup,
  summarize,
  type TeamSampler,
} from "./allianceLab";

function team(teamNumber: number, perMatch: number[], points: number | null = null): TeamSampler {
  return { teamNumber, perMatch, points };
}

describe("seededRandom", () => {
  it("repeats for the same seed and stays in [0, 1)", () => {
    const a = seededRandom(1);
    const b = seededRandom(1);
    for (let i = 0; i < 100; i++) {
      const value = a();
      expect(value).toBe(b());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("summarize", () => {
  it("reports mean and the 80% band", () => {
    const totals = Array.from({ length: 11 }, (_, i) => i * 10);
    expect(summarize(totals)).toEqual({ mean: 50, low: 10, high: 90, badDay: 20 });
  });
});

describe("simulateMatchup", () => {
  it("is deterministic and favours the stronger alliance", () => {
    const red = [team(1, [30, 40, 50]), team(2, [30, 40]), team(3, [], 25)];
    const blue = [team(4, [10, 20]), team(5, [10, 15]), team(6, [5, 10])];
    const first = simulateMatchup(red, blue, 500);
    const again = simulateMatchup(red, blue, 500);
    expect(first.redWin).toBe(again.redWin);
    expect(first.redWin).toBe(1);
    expect(first.red.mean).toBeGreaterThan(first.blue.mean);
  });

  it("counts ties as half a win and reports robots with no data", () => {
    const result = simulateMatchup([team(1, [10])], [team(2, [10]), team(3, [])], 50);
    expect(result.redWin).toBe(0.5);
    expect(result.unknownTeams).toEqual([3]);
  });
});

describe("rankPartners", () => {
  it("prefers the partner whose bad days are still good", () => {
    const captain = [team(1, [40, 40])];
    const steady = team(2, [30, 30, 30, 30]);
    const swingy = team(3, [0, 0, 60, 70]);
    const ranked = rankPartners(captain, [swingy, steady], 400);
    expect(ranked[0].teamNumber).toBe(2);
    expect(ranked[0].badDay).toBe(70);
  });
});

describe("histogram", () => {
  it("bins both alliances on shared edges", () => {
    const bins = histogram([0, 10], [10, 20], 2);
    expect(bins).toHaveLength(2);
    expect(bins.reduce((n, b) => n + b.red + b.blue, 0)).toBe(4);
    expect(bins[1].blue).toBe(2);
  });
});
