import { describe, expect, it } from "vitest";
import {
  formatTeamNumbers,
  isManualEvent,
  isManualEventKey,
  liveEventKey,
  makeManualEventKey,
  MANUAL_EVENT_KEY_PREFIX,
  parseTeamNumbers,
} from "./manualEvent";

describe("parseTeamNumbers", () => {
  it("accepts commas, spaces, tabs and newlines as separators", () => {
    const result = parseTeamNumbers("5806, 1257\t25\n303  341");
    expect(result.teamNumbers).toEqual([5806, 1257, 25, 303, 341]);
    expect(result.invalid).toEqual([]);
    expect(result.duplicates).toBe(0);
  });

  it("keeps the order the list was written in", () => {
    expect(parseTeamNumbers("303, 25, 5806").teamNumbers).toEqual([303, 25, 5806]);
  });

  it("strips TBA team-key prefixes and CSV quotes", () => {
    const result = parseTeamNumbers('frc5806, "1257", FRC25');
    expect(result.teamNumbers).toEqual([5806, 1257, 25]);
    expect(result.invalid).toEqual([]);
  });

  it("counts repeats instead of listing a team twice", () => {
    const result = parseTeamNumbers("5806, 1257, 5806, frc5806");
    expect(result.teamNumbers).toEqual([5806, 1257]);
    expect(result.duplicates).toBe(2);
  });

  it("reports unparseable tokens rather than dropping them silently", () => {
    const result = parseTeamNumbers("5806, Basement Lions, 12.5, -3, 0");
    expect(result.teamNumbers).toEqual([5806]);
    expect(result.invalid).toEqual(["Basement", "Lions", "12.5", "-3", "0"]);
  });

  it("rejects numbers past any plausible team number", () => {
    expect(parseTeamNumbers("999999").invalid).toEqual(["999999"]);
  });

  it("returns nothing for blank input", () => {
    expect(parseTeamNumbers("   \n\t  ").teamNumbers).toEqual([]);
    expect(parseTeamNumbers("").invalid).toEqual([]);
  });

  it("round-trips through formatTeamNumbers", () => {
    const teams = [5806, 1257, 25];
    expect(parseTeamNumbers(formatTeamNumbers(teams)).teamNumbers).toEqual(teams);
  });
});

describe("makeManualEventKey", () => {
  it("slugs the name behind the manual prefix", () => {
    const key = makeManualEventKey("Ramp Riot 2026", () => 0);
    expect(key).toBe(`${MANUAL_EVENT_KEY_PREFIX}ramp-riot-2026-0000`);
    expect(isManualEventKey(key)).toBe(true);
  });

  it("falls back to a placeholder slug when the name has no usable characters", () => {
    expect(makeManualEventKey("!!!", () => 0)).toBe(
      `${MANUAL_EVENT_KEY_PREFIX}event-0000`,
    );
  });

  it("gives two events of the same name different keys", () => {
    let n = 0;
    const next = () => [0.1, 0.9][n++] ?? 0;
    expect(makeManualEventKey("Off Season", next)).not.toBe(
      makeManualEventKey("Off Season", next),
    );
  });
});

describe("isManualEventKey", () => {
  it("never matches a real TBA event key", () => {
    expect(isManualEventKey("2026njski")).toBe(false);
    expect(isManualEventKey("2026cmptx")).toBe(false);
  });

  it("matches a key this app minted", () => {
    expect(isManualEventKey(makeManualEventKey("Ramp Riot"))).toBe(true);
  });
});

describe("liveEventKey", () => {
  it("passes a synced event's key through to upstream callers", () => {
    expect(liveEventKey({ eventKey: "2026njski" })).toBe("2026njski");
  });

  it("withholds a manual event's key so nothing polls TBA for it", () => {
    expect(liveEventKey({ eventKey: "manual-ramp-riot-abcd" })).toBeNull();
    expect(isManualEvent({ eventKey: "manual-ramp-riot-abcd" })).toBe(true);
  });

  it("handles no event at all", () => {
    expect(liveEventKey(null)).toBeNull();
    expect(liveEventKey(undefined)).toBeNull();
    expect(isManualEvent(null)).toBe(false);
  });
});
