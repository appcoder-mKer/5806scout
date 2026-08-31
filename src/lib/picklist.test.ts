import { describe, expect, it } from "vitest";
import type { EventTeam } from "./eventData";
import {
  moveItem,
  moveToDoNotPick,
  reconcileOrder,
  restoreFromDoNotPick,
  setRank,
  splitDoNotPick,
  toggleStruck,
} from "./picklist";

function team(teamNumber: number, epa: number | null): EventTeam {
  return { teamNumber, nickname: String(teamNumber), city: "", epa, epaRank: null };
}

describe("reconcileOrder", () => {
  const eventTeams = [team(111, 30), team(222, 90), team(333, null), team(444, 60)];

  it("keeps saved order for teams still present", () => {
    expect(reconcileOrder([444, 111], eventTeams)).toEqual([444, 111, 222, 333]);
  });

  it("appends new teams sorted by EPA desc, null EPA last", () => {
    expect(reconcileOrder([], eventTeams)).toEqual([222, 444, 111, 333]);
  });

  it("drops saved teams that left the event", () => {
    expect(reconcileOrder([999, 222, 111, 444, 333], eventTeams)).toEqual([
      222, 111, 444, 333,
    ]);
  });
});

describe("moveItem", () => {
  it("moves an item down", () => {
    expect(moveItem([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4]);
  });

  it("moves an item up", () => {
    expect(moveItem([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3]);
  });

  it("returns a copy when indices are out of range", () => {
    expect(moveItem([1, 2], 5, 0)).toEqual([1, 2]);
  });
});

describe("toggleStruck", () => {
  it("adds when absent and removes when present", () => {
    expect(toggleStruck([], 254)).toEqual([254]);
    expect(toggleStruck([254, 111], 254)).toEqual([111]);
  });
});

describe("splitDoNotPick", () => {
  it("splits DNP teams out of the ranking, keeping DNP order", () => {
    expect(splitDoNotPick([222, 111, 444, 333], [444, 222])).toEqual({
      order: [111, 333],
      doNotPick: [444, 222],
    });
  });

  it("drops DNP teams that left the event", () => {
    expect(splitDoNotPick([222, 111], [999, 111])).toEqual({
      order: [222],
      doNotPick: [111],
    });
  });
});

describe("moveToDoNotPick / restoreFromDoNotPick", () => {
  it("moves a team to the bottom of the DNP list", () => {
    expect(moveToDoNotPick([1, 2, 3], [9], 2)).toEqual({
      order: [1, 3],
      doNotPick: [9, 2],
    });
  });

  it("restores a team to the bottom of the ranking", () => {
    expect(restoreFromDoNotPick([1, 3], [9, 2], 2)).toEqual({
      order: [1, 3, 2],
      doNotPick: [9],
    });
  });

  it("round-trips move + restore", () => {
    const moved = moveToDoNotPick([1, 2, 3], [], 1);
    const restored = restoreFromDoNotPick(moved.order, moved.doNotPick, 1);
    expect(restored).toEqual({ order: [2, 3, 1], doNotPick: [] });
  });

  it("is a no-op when the team is not in the source list", () => {
    expect(moveToDoNotPick([1, 2], [3], 7)).toEqual({ order: [1, 2], doNotPick: [3] });
    expect(restoreFromDoNotPick([1, 2], [3], 7)).toEqual({
      order: [1, 2],
      doNotPick: [3],
    });
  });
});

describe("setRank", () => {
  it("moves a team to the 1-based rank typed", () => {
    expect(setRank([10, 20, 30, 40], 40, 2)).toEqual([10, 40, 20, 30]);
    expect(setRank([10, 20, 30, 40], 10, 4)).toEqual([20, 30, 40, 10]);
  });

  it("clamps a rank below 1 or past the end", () => {
    expect(setRank([10, 20, 30], 30, 0)).toEqual([30, 10, 20]);
    expect(setRank([10, 20, 30], 30, -5)).toEqual([30, 10, 20]);
    expect(setRank([10, 20, 30], 10, 99)).toEqual([20, 30, 10]);
  });

  it("leaves the order alone when the rank is where the team already is", () => {
    expect(setRank([10, 20, 30], 20, 2)).toEqual([10, 20, 30]);
  });

  it("is a no-op for a team not in the ranking", () => {
    expect(setRank([10, 20], 99, 1)).toEqual([10, 20]);
  });

  it("ignores a non-numeric rank rather than dropping the team", () => {
    expect(setRank([10, 20, 30], 30, Number.NaN)).toEqual([10, 20, 30]);
  });

  it("does not mutate the array it was given", () => {
    const order = [10, 20, 30];
    setRank(order, 30, 1);
    expect(order).toEqual([10, 20, 30]);
  });
});
