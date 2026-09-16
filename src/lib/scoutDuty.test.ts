import { describe, expect, it } from "vitest";
import {
  clampMatchesPerScout,
  DEFAULT_ADMIN_DUTY,
  DEFAULT_DUTY,
  DEFAULT_MATCHES_PER_SCOUT,
  dutyFor,
  eligibleUids,
  emptyScoutDutiesDoc,
  sanitizeScoutDutiesDoc,
  scoutsMatch,
  scoutsPit,
  type ScoutDuty,
} from "./scoutDuty";

describe("dutyFor", () => {
  it("falls back to the default for an unlabelled scout", () => {
    expect(dutyFor({}, "a")).toBe(DEFAULT_DUTY);
    expect(dutyFor({ a: "viewer" }, "b")).toBe(DEFAULT_DUTY);
  });

  it("returns the stored duty", () => {
    expect(dutyFor({ a: "driveTeam" }, "a")).toBe("driveTeam");
  });

  it("keeps an unlabelled admin out of the rotations", () => {
    expect(DEFAULT_ADMIN_DUTY).toBe("viewer");
    expect(dutyFor({}, "a", "admin")).toBe(DEFAULT_ADMIN_DUTY);
    expect(dutyFor({}, "a", "scout")).toBe(DEFAULT_DUTY);
  });

  it("returns an admin's stored duty like anyone else's", () => {
    expect(dutyFor({ a: "match" }, "a", "admin")).toBe("match");
    expect(dutyFor({ a: "both" }, "a", "admin")).toBe("both");
  });
});

describe("scoutsMatch / scoutsPit", () => {
  it("only counts the three scouting duties", () => {
    const matchers: ScoutDuty[] = ["match", "both"];
    const pitters: ScoutDuty[] = ["pit", "both"];
    const idle: ScoutDuty[] = ["viewer", "driveTeam", "pitCrew"];

    for (const duty of matchers) expect(scoutsMatch(duty)).toBe(true);
    for (const duty of pitters) expect(scoutsPit(duty)).toBe(true);
    for (const duty of idle) {
      expect(scoutsMatch(duty)).toBe(false);
      expect(scoutsPit(duty)).toBe(false);
    }
    expect(scoutsMatch("pit")).toBe(false);
    expect(scoutsPit("match")).toBe(false);
  });
});

describe("eligibleUids", () => {
  const duties: Record<string, ScoutDuty> = {
    a: "both",
    b: "match",
    c: "pit",
    d: "viewer",
    e: "driveTeam",
    f: "pitCrew",
  };

  const scouts = (...uids: string[]) =>
    uids.map((uid) => ({ uid, role: "scout" as const }));
  const admins = (...uids: string[]) =>
    uids.map((uid) => ({ uid, role: "admin" as const }));

  it("keeps only the scouts whose duty covers the job", () => {
    const crew = scouts("a", "b", "c", "d", "e", "f");
    expect(eligibleUids("match", duties, crew)).toEqual(["a", "b"]);
    expect(eligibleUids("pit", duties, crew)).toEqual(["a", "c"]);
  });

  it("includes unlabelled scouts in both jobs", () => {
    expect(eligibleUids("match", {}, scouts("x", "y"))).toEqual(["x", "y"]);
    expect(eligibleUids("pit", {}, scouts("x", "y"))).toEqual(["x", "y"]);
  });

  it("leaves unlabelled admins out of both jobs", () => {
    expect(eligibleUids("match", {}, admins("x"))).toEqual([]);
    expect(eligibleUids("pit", {}, admins("x"))).toEqual([]);
  });

  it("puts an admin into whichever job their duty covers", () => {
    const crew = admins("a", "b", "c", "d");
    expect(eligibleUids("match", duties, crew)).toEqual(["a", "b"]);
    expect(eligibleUids("pit", duties, crew)).toEqual(["a", "c"]);
  });

  it("preserves the order it was given", () => {
    expect(eligibleUids("match", duties, scouts("b", "a"))).toEqual(["b", "a"]);
  });

  it("can come back empty when the whole crew is off scouting duty", () => {
    expect(eligibleUids("match", duties, scouts("d", "e", "f"))).toEqual([]);
  });
});

describe("clampMatchesPerScout", () => {
  it("holds the value inside the allowed range", () => {
    expect(clampMatchesPerScout(12)).toBe(12);
    expect(clampMatchesPerScout(0)).toBe(1);
    expect(clampMatchesPerScout(9999)).toBe(200);
    expect(clampMatchesPerScout(7.9)).toBe(7);
  });

  it("falls back to the default for a non-number", () => {
    expect(clampMatchesPerScout(NaN)).toBe(DEFAULT_MATCHES_PER_SCOUT);
    expect(clampMatchesPerScout(Infinity)).toBe(DEFAULT_MATCHES_PER_SCOUT);
  });
});

describe("sanitizeScoutDutiesDoc", () => {
  it("returns an empty doc for junk", () => {
    expect(sanitizeScoutDutiesDoc(null)).toEqual(emptyScoutDutiesDoc());
    expect(sanitizeScoutDutiesDoc("nope")).toEqual(emptyScoutDutiesDoc());
    expect(sanitizeScoutDutiesDoc(undefined)).toEqual(emptyScoutDutiesDoc());
  });

  it("drops duties it doesn't recognize rather than trusting them", () => {
    const doc = sanitizeScoutDutiesDoc({
      duties: { a: "match", b: "captain", c: 7, d: "viewer" },
      matchesPerScout: 6,
    });
    expect(doc.duties).toEqual({ a: "match", d: "viewer" });
    expect(doc.matchesPerScout).toBe(6);
  });

  it("clamps a stored block size that's out of range", () => {
    expect(sanitizeScoutDutiesDoc({ matchesPerScout: 0 }).matchesPerScout).toBe(
      1,
    );
    expect(
      sanitizeScoutDutiesDoc({ duties: {} }).matchesPerScout,
    ).toBe(DEFAULT_MATCHES_PER_SCOUT);
  });

  it("an unrecognized duty leaves the scout on the default, not out of the rotation", () => {
    const doc = sanitizeScoutDutiesDoc({ duties: { a: "bogus" } });
    expect(eligibleUids("match", doc.duties, [{ uid: "a", role: "scout" }])).toEqual(["a"]);
  });
});
