import { describe, expect, it } from "vitest";
import { INVITE_CODE_LENGTH } from "./sisterTeam";
import {
  clearedEvidence,
  EVIDENCE_KINDS,
  EVIDENCE_LABELS,
  isEvidenceKind,
  newFreshnessCode,
  requiresFreshnessCode,
} from "./teamClaims";

describe("requiresFreshnessCode", () => {
  it("demands one of anything photographed", () => {
    // A robot photo proves nothing on its own — TBA and Instagram are full of
    // them. The code is what makes a picture evidence rather than decoration.
    expect(requiresFreshnessCode("pit-photo")).toBe(true);
    expect(requiresFreshnessCode("pit-pass")).toBe(true);
  });

  it("exempts a screenshot, which has nowhere to hold a piece of paper", () => {
    expect(requiresFreshnessCode("dashboard")).toBe(false);
    expect(requiresFreshnessCode("other")).toBe(false);
  });
});

describe("newFreshnessCode", () => {
  it("leads with the team it belongs to", () => {
    const code = newFreshnessCode("5806", () => 0);
    expect(code.startsWith("5806-")).toBe(true);
    expect(code).toHaveLength("5806-".length + INVITE_CODE_LENGTH);
  });

  it("avoids characters that are ambiguous when handwritten", () => {
    // Inherited from generateInviteCode, which drops 0/O/1/I/L because codes
    // get read aloud between pits. Here they get written on paper and read
    // back off a photograph, which is at least as unforgiving.
    const codes = Array.from({ length: 50 }, () => newFreshnessCode("5806"));
    for (const code of codes) {
      expect(code.slice("5806-".length)).not.toMatch(/[01OIL]/);
    }
  });

  it("does not repeat itself", () => {
    const codes = new Set(
      Array.from({ length: 100 }, () => newFreshnessCode("5806")),
    );
    expect(codes.size).toBeGreaterThan(90);
  });
});

describe("the accepted evidence kinds", () => {
  it("never asks for a student or school ID", () => {
    // Deliberate: those would prove membership just as well, but the people
    // signing up are minors and a pit pass proves it without us holding a
    // photograph of a child's identity document.
    const text = JSON.stringify(EVIDENCE_KINDS) + JSON.stringify(EVIDENCE_LABELS);
    expect(text.toLowerCase()).not.toMatch(/student|school id|passport|licen[cs]e/);
  });

  it("labels every kind it accepts", () => {
    for (const kind of EVIDENCE_KINDS) {
      expect(EVIDENCE_LABELS[kind]).toBeTruthy();
    }
  });

  it("rejects anything not on the list", () => {
    expect(isEvidenceKind("dashboard")).toBe(true);
    expect(isEvidenceKind("student-id")).toBe(false);
    expect(isEvidenceKind(undefined)).toBe(false);
  });
});

describe("clearedEvidence", () => {
  it("strips both the image and the note, and nothing else", () => {
    // The audit shell — who claimed, which kind, when, decided by whom — has
    // to survive, or an approved team has no record of why it was approved.
    expect(Object.keys(clearedEvidence()).sort()).toEqual([
      "evidenceImage",
      "evidenceNote",
    ]);
  });
});
