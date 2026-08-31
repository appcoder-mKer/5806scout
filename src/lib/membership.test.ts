import { describe, expect, it } from "vitest";
import { isApprovedMember, memberStatus, needsApproval } from "./membership";

describe("memberStatus", () => {
  it("reads the stored status", () => {
    expect(memberStatus({ status: "approved" })).toBe("approved");
    expect(memberStatus({ status: "denied" })).toBe("denied");
  });

  it("treats a profile with no status as pending", () => {
    // The whole migration lives in this line: every account written before the
    // gate shipped lands here, and gets re-approved by hand rather than waved
    // through on the strength of having existed first.
    expect(memberStatus({})).toBe("pending");
  });
});

describe("isApprovedMember", () => {
  it("lets an approved member through", () => {
    expect(isApprovedMember({ status: "approved" })).toBe(true);
  });

  it("holds everyone else, including grandfathered profiles", () => {
    expect(isApprovedMember({ status: "pending" })).toBe(false);
    expect(isApprovedMember({ status: "denied" })).toBe(false);
    expect(isApprovedMember({})).toBe(false);
  });

  it("fails closed where showsInRoster fails open", () => {
    // Both read a missing field; they must disagree about it. A missing
    // verification flag only hides a roster row, so it defaults to visible. A
    // missing approval opens a season of scouting data, so it defaults to no.
    expect(isApprovedMember({})).toBe(false);
    expect(needsApproval({})).toBe(true);
  });
});
