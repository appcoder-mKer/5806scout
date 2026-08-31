import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUEST_TEAM_ID, guestModeAvailable, isGuestSession } from "./guestMode";

describe("isGuestSession", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is false for an ordinary visit", () => {
    expect(isGuestSession()).toBe(false);
  });

  it("is true once the flag is set", () => {
    window.sessionStorage.setItem("frc-scout:guest", "1");
    expect(isGuestSession()).toBe(true);
  });

  it("is false when sessionStorage throws", () => {
    // This is the one that matters. src/lib/firebase/client.ts asks this
    // question to decide whether to build a networked Firestore, so a browser
    // that won't answer must get the answer that keeps writes off the wire —
    // and guestModeAvailable() then hides the entry button rather than
    // offering a "guest" mode that quietly saves.
    vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(isGuestSession()).toBe(false);
    expect(guestModeAvailable()).toBe(false);
  });
});

describe("GUEST_TEAM_ID", () => {
  it("cannot collide with a real FRC team number", () => {
    expect(GUEST_TEAM_ID).not.toMatch(/^\d+$/);
  });
});
