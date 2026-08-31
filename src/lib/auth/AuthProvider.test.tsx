import { render, screen, waitFor } from "@testing-library/react";
import type { User } from "firebase/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthProvider";

const { onAuthStateChangedMock, onSnapshotMock, docMock } = vi.hoisted(() => ({
  onAuthStateChangedMock: vi.fn(),
  onSnapshotMock: vi.fn(),
  docMock: vi.fn(),
}));

vi.mock("@/lib/firebase/client", () => ({
  auth: {},
  db: {},
}));

vi.mock("firebase/auth", () => ({
  onAuthStateChanged: onAuthStateChangedMock,
}));

vi.mock("firebase/firestore", () => ({
  doc: docMock,
  onSnapshot: onSnapshotMock,
}));

function Probe() {
  const { user, profile, loading, dataTeamId, isOwner } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="uid">{user?.uid ?? "none"}</span>
      <span data-testid="profile-name">{profile?.fullName ?? "none"}</span>
      <span data-testid="data-team">{dataTeamId ?? "none"}</span>
      <span data-testid="is-owner">{String(isOwner)}</span>
    </div>
  );
}

beforeEach(() => {
  onAuthStateChangedMock.mockReset();
  onSnapshotMock.mockReset();
  docMock.mockReset();
});

type Snap = { exists: () => boolean; data: () => unknown };

/**
 * Route snapshot callbacks by the collection they subscribed to.
 *
 * The provider subscribes to users/, owners/ and teams/, and the order it
 * happens to do that in is not something a test should depend on — indexing
 * into a flat array meant adding one subscription silently repointed the
 * others.
 */
function mockSnapshotsByCollection() {
  const callbacks = new Map<string, (snap: Snap) => void>();
  docMock.mockImplementation((_db, collection: string, id: string) => ({
    collection,
    id,
  }));
  onSnapshotMock.mockImplementation(
    (ref: { collection: string }, cb: (snap: Snap) => void) => {
      callbacks.set(ref.collection, cb);
      return () => {};
    },
  );
  return {
    emit(collection: string, snap: Snap) {
      const cb = callbacks.get(collection);
      if (!cb) throw new Error(`No subscription on ${collection}`);
      cb(snap);
    },
    has: (collection: string) => callbacks.has(collection),
  };
}

describe("AuthProvider", () => {
  it("starts loading and resolves to signed-out state when no user", async () => {
    let authCallback: (user: User | null) => void = () => {};
    onAuthStateChangedMock.mockImplementation((_auth, cb) => {
      authCallback = cb;
      return () => {};
    });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    expect(screen.getByTestId("loading").textContent).toBe("true");

    authCallback(null);

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("uid").textContent).toBe("none");
  });

  it("loads the Firestore profile and team once a user signs in", async () => {
    let authCallback: (user: User | null) => void = () => {};
    onAuthStateChangedMock.mockImplementation((_auth, cb) => {
      authCallback = cb;
      return () => {};
    });

    const snaps = mockSnapshotsByCollection();

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    authCallback({ uid: "abc123" } as User);
    expect(screen.getByTestId("loading").textContent).toBe("true");

    await waitFor(() => expect(onSnapshotMock).toHaveBeenCalled());

    // The operator lookup resolves for everyone; almost nobody is one.
    snaps.emit("owners", { exists: () => false, data: () => undefined });
    snaps.emit("users", {
      exists: () => true,
      data: () => ({
        email: "scout@example.com",
        fullName: "Jane Scout",
        teamId: "5806",
        role: "scout",
        active: true,
      }),
    });

    // Loading holds until the team doc lands — pages need the sister-link
    // state before they can pick the right data store.
    await waitFor(() => expect(snaps.has("teams")).toBe(true));
    expect(screen.getByTestId("loading").textContent).toBe("true");

    snaps.emit("teams", {
      exists: () => true,
      data: () => ({ teamNumber: "5806", teamName: "Test Team" }),
    });

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("profile-name").textContent).toBe("Jane Scout");
    // Unlinked team: shared data lives in its own subtree.
    expect(screen.getByTestId("data-team").textContent).toBe("5806");
  });

  it("routes shared data to the canonical store when a sister team is linked", async () => {
    let authCallback: (user: User | null) => void = () => {};
    onAuthStateChangedMock.mockImplementation((_auth, cb) => {
      authCallback = cb;
      return () => {};
    });

    const snaps = mockSnapshotsByCollection();

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    authCallback({ uid: "abc123" } as User);
    await waitFor(() => expect(onSnapshotMock).toHaveBeenCalled());

    snaps.emit("owners", { exists: () => false, data: () => undefined });
    snaps.emit("users", {
      exists: () => true,
      data: () => ({
        email: "scout@example.com",
        fullName: "Jane Scout",
        teamId: "5806",
        role: "scout",
        active: true,
      }),
    });

    await waitFor(() => expect(snaps.has("teams")).toBe(true));
    snaps.emit("teams", {
      exists: () => true,
      data: () => ({
        teamNumber: "5806",
        teamName: "Test Team",
        sisterTeamId: "254",
        sisterTeamNumber: "254",
        sisterTeamName: "Sister",
      }),
    });

    // 254 < 5806, so the sister team's subtree is the shared store.
    await waitFor(() => expect(screen.getByTestId("data-team").textContent).toBe("254"));
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("reports operator rights, and holds loading until it knows", async () => {
    let authCallback: (user: User | null) => void = () => {};
    onAuthStateChangedMock.mockImplementation((_auth, cb) => {
      authCallback = cb;
      return () => {};
    });
    const snaps = mockSnapshotsByCollection();

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    authCallback({ uid: "abc123" } as User);
    await waitFor(() => expect(snaps.has("owners")).toBe(true));

    snaps.emit("users", {
      exists: () => true,
      data: () => ({
        email: "boss@example.com",
        fullName: "The Operator",
        teamId: "5806",
        role: "admin",
        active: true,
        status: "approved",
      }),
    });
    await waitFor(() => expect(snaps.has("teams")).toBe(true));
    snaps.emit("teams", {
      exists: () => true,
      data: () => ({ teamNumber: "5806", teamName: "Test Team" }),
    });

    // Still loading: /owner must not flash a denial at the person who runs the
    // app while their owners doc is in flight.
    expect(screen.getByTestId("loading").textContent).toBe("true");

    snaps.emit("owners", { exists: () => true, data: () => ({}) });

    await waitFor(() =>
      expect(screen.getByTestId("loading").textContent).toBe("false"),
    );
    expect(screen.getByTestId("is-owner").textContent).toBe("true");
  });

  it("treats a refused owners read as not an owner", async () => {
    // Non-owners are allowed to read their own missing doc, so this is the
    // belt-and-braces path: whatever goes wrong, nobody gets operator rights
    // by accident.
    let authCallback: (user: User | null) => void = () => {};
    onAuthStateChangedMock.mockImplementation((_auth, cb) => {
      authCallback = cb;
      return () => {};
    });
    const errorCallbacks: Array<(err: unknown) => void> = [];
    docMock.mockImplementation((_db, collection: string) => ({ collection }));
    onSnapshotMock.mockImplementation(
      (ref: { collection: string }, _cb: unknown, onError: (e: unknown) => void) => {
        if (ref.collection === "owners") errorCallbacks.push(onError);
        return () => {};
      },
    );

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    authCallback({ uid: "abc123" } as User);
    await waitFor(() => expect(errorCallbacks).toHaveLength(1));
    errorCallbacks[0](new Error("permission-denied"));

    await waitFor(() =>
      expect(screen.getByTestId("is-owner").textContent).toBe("false"),
    );
  });

  it("throws when useAuth is called outside a provider", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(
      "useAuth must be used within an AuthProvider",
    );
    consoleError.mockRestore();
  });
});
