import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OperatorLink } from "./OperatorLink";

const { useAuthMock, onSnapshotMock } = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
  onSnapshotMock: vi.fn(),
}));

vi.mock("@/lib/auth/AuthProvider", () => ({ useAuth: useAuthMock }));
vi.mock("@/lib/firebase/client", () => ({ db: {} }));
vi.mock("firebase/firestore", () => ({
  collection: () => "teamClaims",
  query: (...args: unknown[]) => args,
  where: () => "where",
  onSnapshot: onSnapshotMock,
}));

beforeEach(() => {
  useAuthMock.mockReset();
  onSnapshotMock.mockReset();
  onSnapshotMock.mockImplementation((_q: unknown, cb: (s: unknown) => void) => {
    cb({ size: 0 });
    return () => {};
  });
});

describe("OperatorLink", () => {
  it("shows nothing to an ordinary member", () => {
    useAuthMock.mockReturnValue({ isOwner: false });
    render(<OperatorLink />);
    expect(screen.queryByText("Operator")).not.toBeInTheDocument();
  });

  it("never subscribes when the reader isn't an owner", () => {
    // Only owners may list teamClaims, so subscribing as anyone else would be
    // a guaranteed permission error on every single session.
    useAuthMock.mockReturnValue({ isOwner: false });
    render(<OperatorLink />);
    expect(onSnapshotMock).not.toHaveBeenCalled();
  });

  it("gives the operator a door, with no badge when nothing is waiting", () => {
    useAuthMock.mockReturnValue({ isOwner: true });
    render(<OperatorLink />);
    const link = screen.getByRole("link", { name: "Operator" });
    expect(link).toHaveAttribute("href", "/owner");
  });

  it("counts the teams waiting to be let in", () => {
    // The whole reason the badge exists: without it this is a link to a page
    // that is usually empty, and nobody clicks one of those.
    useAuthMock.mockReturnValue({ isOwner: true });
    onSnapshotMock.mockImplementation((_q: unknown, cb: (s: unknown) => void) => {
      cb({ size: 3 });
      return () => {};
    });
    render(<OperatorLink />);
    expect(
      screen.getByRole("link", { name: "Operator — 3 teams waiting" }),
    ).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("says one team, not one teams", () => {
    useAuthMock.mockReturnValue({ isOwner: true });
    onSnapshotMock.mockImplementation((_q: unknown, cb: (s: unknown) => void) => {
      cb({ size: 1 });
      return () => {};
    });
    render(<OperatorLink />);
    expect(
      screen.getByRole("link", { name: "Operator — 1 team waiting" }),
    ).toBeInTheDocument();
  });

  it("shows no count rather than a wrong one when the read fails", () => {
    useAuthMock.mockReturnValue({ isOwner: true });
    onSnapshotMock.mockImplementation(
      (_q: unknown, _cb: unknown, onError: (e: unknown) => void) => {
        onError(new Error("permission-denied"));
        return () => {};
      },
    );
    render(<OperatorLink />);
    expect(screen.getByRole("link", { name: "Operator" })).toBeInTheDocument();
  });
});
