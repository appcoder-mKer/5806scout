import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VERIFICATION_REQUIRED_FROM } from "@/lib/emailVerification";
import { RequireAuth } from "./RequireAuth";

const {
  useAuthMock,
  replaceMock,
  sendEmailVerificationMock,
  signOutMock,
  updateDocMock,
  onSnapshotMock,
} = vi.hoisted(() => ({
  useAuthMock: vi.fn(),
  replaceMock: vi.fn(),
  sendEmailVerificationMock: vi.fn(),
  signOutMock: vi.fn(),
  updateDocMock: vi.fn(async () => {}),
  onSnapshotMock: vi.fn(),
}));

vi.mock("@/lib/auth/AuthProvider", () => ({
  useAuth: useAuthMock,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
}));

vi.mock("@/lib/firebase/client", () => ({ auth: {}, db: {} }));

vi.mock("firebase/auth", () => ({
  sendEmailVerification: sendEmailVerificationMock,
  signOut: signOutMock,
}));

vi.mock("firebase/firestore", () => ({
  doc: (_db: unknown, ...path: string[]) => path.join("/"),
  updateDoc: updateDocMock,
  onSnapshot: onSnapshotMock,
  serverTimestamp: () => "server-timestamp",
  setDoc: vi.fn(async () => {}),
}));

const AFTER_CUTOFF = new Date(VERIFICATION_REQUIRED_FROM + 1000).toISOString();
const BEFORE_CUTOFF = new Date(VERIFICATION_REQUIRED_FROM - 1000).toISOString();

/** A Firebase user, as much of one as RequireAuth actually touches. */
function fakeUser(overrides: Record<string, unknown> = {}) {
  return {
    uid: "abc123",
    email: "scout@example.com",
    emailVerified: true,
    providerData: [{ providerId: "password" }],
    metadata: { creationTime: AFTER_CUTOFF },
    reload: vi.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  useAuthMock.mockReset();
  replaceMock.mockReset();
  sendEmailVerificationMock.mockReset();
  signOutMock.mockReset();
  updateDocMock.mockClear();
  onSnapshotMock.mockReset();
  // Default: no claim on file for this team, and the read was allowed.
  onSnapshotMock.mockImplementation((_ref: unknown, cb: (s: unknown) => void) => {
    cb({ exists: () => false, data: () => undefined });
    return () => {};
  });
});

/**
 * A profile as the gates read it: emailVerified for the first, status for the
 * second. Approved by default so the email-gate tests below stay about the
 * email gate.
 */
function fakeProfile(emailVerified?: boolean, status = "approved") {
  return { uid: "abc123", teamId: "5806", emailVerified, status };
}

describe("RequireAuth", () => {
  it("shows a loading state and does not redirect while auth is resolving", () => {
    useAuthMock.mockReturnValue({ user: null, profile: null, loading: true });

    render(
      <RequireAuth>
        <div>secret content</div>
      </RequireAuth>,
    );

    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("redirects to /login when resolved and unauthenticated", () => {
    useAuthMock.mockReturnValue({ user: null, profile: null, loading: false });

    render(
      <RequireAuth>
        <div>secret content</div>
      </RequireAuth>,
    );

    expect(replaceMock).toHaveBeenCalledWith("/login");
    expect(screen.queryByText("secret content")).not.toBeInTheDocument();
  });

  it("renders children when authenticated and verified", () => {
    useAuthMock.mockReturnValue({
      user: fakeUser(),
      profile: fakeProfile(true),
      loading: false,
    });

    render(
      <RequireAuth>
        <div>secret content</div>
      </RequireAuth>,
    );

    expect(screen.getByText("secret content")).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});

describe("the email verification gate", () => {
  function renderUnverified(overrides: Record<string, unknown> = {}) {
    const user = fakeUser({ emailVerified: false, ...overrides });
    useAuthMock.mockReturnValue({
      user,
      profile: fakeProfile(true),
      loading: false,
    });
    render(
      <RequireAuth>
        <div>secret content</div>
      </RequireAuth>,
    );
    return user;
  }

  it("withholds the app from a new, unverified email/password account", () => {
    renderUnverified();

    expect(screen.getByText("Verify your email")).toBeInTheDocument();
    expect(screen.getByText("scout@example.com")).toBeInTheDocument();
    expect(screen.queryByText("secret content")).not.toBeInTheDocument();
  });

  it("lets a Google account past — the provider already proved the address", () => {
    renderUnverified({ providerData: [{ providerId: "google.com" }] });

    expect(screen.getByText("secret content")).toBeInTheDocument();
  });

  it("lets an account created before the gate shipped past", () => {
    renderUnverified({ metadata: { creationTime: BEFORE_CUTOFF } });

    expect(screen.getByText("secret content")).toBeInTheDocument();
  });

  it("opens the app once a re-check finds the link was clicked", async () => {
    const user = renderUnverified();
    // reload() mutates the Firebase user in place, which is what the gate
    // re-reads — so model that rather than returning a fresh object.
    user.reload = vi.fn(async () => {
      user.emailVerified = true;
    });

    await userEvent.click(screen.getByRole("button", { name: "I've verified" }));

    await waitFor(() =>
      expect(screen.getByText("secret content")).toBeInTheDocument(),
    );
  });

  it("says so plainly when the link still hasn't been clicked", async () => {
    renderUnverified();

    await userEvent.click(screen.getByRole("button", { name: "I've verified" }));

    await waitFor(() =>
      expect(
        screen.getByText("Still not verified — open the link in the email first."),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("secret content")).not.toBeInTheDocument();
  });

  it("resends the verification email on request", async () => {
    const user = renderUnverified();
    sendEmailVerificationMock.mockResolvedValue(undefined);

    await userEvent.click(screen.getByRole("button", { name: "Resend email" }));

    expect(sendEmailVerificationMock).toHaveBeenCalledWith(user);
    await waitFor(() =>
      expect(
        screen.getByText("Sent again — it can take a minute to arrive."),
      ).toBeInTheDocument(),
    );
  });

  it("reports a failed resend instead of pretending it went", async () => {
    renderUnverified();
    sendEmailVerificationMock.mockRejectedValue(new Error("too many requests"));

    await userEvent.click(screen.getByRole("button", { name: "Resend email" }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "Could not send another email just yet — wait a minute and try again.",
        ),
      ).toBeInTheDocument(),
    );
  });

  it("offers a way out for someone stuck at the gate", async () => {
    renderUnverified();

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(signOutMock).toHaveBeenCalled();
  });
});

describe("RequireAuth roster stamp", () => {
  it("marks the profile verified once the gate lets someone through", async () => {
    useAuthMock.mockReturnValue({
      user: fakeUser({ emailVerified: true }),
      profile: fakeProfile(false),
      loading: false,
    });

    render(
      <RequireAuth>
        <p>Scouting</p>
      </RequireAuth>,
    );

    await waitFor(() =>
      expect(updateDocMock).toHaveBeenCalledWith("users/abc123", {
        emailVerified: true,
      }),
    );
  });

  it("marks the profile unverified while the gate is still holding them", async () => {
    useAuthMock.mockReturnValue({
      user: fakeUser({ emailVerified: false }),
      profile: fakeProfile(true),
      loading: false,
    });

    render(
      <RequireAuth>
        <p>Scouting</p>
      </RequireAuth>,
    );

    await screen.findByText("Verify your email");
    await waitFor(() =>
      expect(updateDocMock).toHaveBeenCalledWith("users/abc123", {
        emailVerified: false,
      }),
    );
  });

  it("writes nothing when the profile already agrees with the gate", async () => {
    useAuthMock.mockReturnValue({
      user: fakeUser({ emailVerified: true }),
      profile: fakeProfile(true),
      loading: false,
    });

    render(
      <RequireAuth>
        <p>Scouting</p>
      </RequireAuth>,
    );

    await screen.findByText("Scouting");
    expect(updateDocMock).not.toHaveBeenCalled();
  });

  it("waits for the profile to load rather than writing blind", async () => {
    useAuthMock.mockReturnValue({
      user: fakeUser({ emailVerified: true }),
      profile: null,
      loading: false,
    });

    render(
      <RequireAuth>
        <p>Scouting</p>
      </RequireAuth>,
    );

    // No profile means no verdict to mirror — and, downstream, nothing for the
    // approval gate to read either, so the app stays behind a spinner rather
    // than guessing in either direction.
    await screen.findByText("Loading…");
    expect(updateDocMock).not.toHaveBeenCalled();
  });
});

describe("the approval gate", () => {
  function renderGate(auth: Record<string, unknown>) {
    useAuthMock.mockReturnValue({
      user: fakeUser({ emailVerified: true }),
      loading: false,
      isOwner: false,
      team: null,
      ...auth,
    });
    render(
      <RequireAuth>
        <p>Scouting</p>
      </RequireAuth>,
    );
  }

  it("opens the app to an approved member", async () => {
    renderGate({ profile: fakeProfile(true, "approved") });
    expect(await screen.findByText("Scouting")).toBeInTheDocument();
  });

  it("holds a member their team hasn't approved yet", async () => {
    renderGate({
      profile: fakeProfile(true, "pending"),
      team: { teamNumber: "5806", claimedAt: "stamped" },
    });

    expect(await screen.findByText("Waiting for an admin")).toBeInTheDocument();
    expect(screen.queryByText("Scouting")).not.toBeInTheDocument();
  });

  it("holds a profile written before approval existed", async () => {
    // The migration, seen from the member's side: no status field means
    // pending, so the gate closes over the existing roster on deploy rather
    // than waving through everyone who happened to sign up first.
    renderGate({
      profile: { uid: "abc123", teamId: "5806", emailVerified: true },
      team: { teamNumber: "5806", claimedAt: "stamped" },
    });

    expect(await screen.findByText("Waiting for an admin")).toBeInTheDocument();
    expect(screen.queryByText("Scouting")).not.toBeInTheDocument();
  });

  it("tells a declined member where they stand", async () => {
    renderGate({
      profile: fakeProfile(true, "denied"),
      team: { teamNumber: "5806", claimedAt: "stamped" },
    });

    expect(await screen.findByText("Not approved")).toBeInTheDocument();
  });

  it("offers the claim form when nobody has set the team up", async () => {
    // No claimedAt on the team doc: this member has no admin to ask, so they
    // get the evidence form and the operator reviews it.
    renderGate({
      profile: fakeProfile(true, "pending"),
      team: { teamNumber: "5806" },
    });

    expect(await screen.findByText("Set up your team")).toBeInTheDocument();
  });

  it("says so when someone else already claimed the team", async () => {
    // Being refused the read IS the answer: the rules let anyone read a claim
    // that doesn't exist, and only its requester read one that does.
    onSnapshotMock.mockImplementation(
      (_ref: unknown, _cb: unknown, onError: (e: unknown) => void) => {
        onError(new Error("permission-denied"));
        return () => {};
      },
    );
    renderGate({
      profile: fakeProfile(true, "pending"),
      team: { teamNumber: "5806" },
    });

    expect(await screen.findByText("Already requested")).toBeInTheDocument();
    expect(screen.queryByText("Set up your team")).not.toBeInTheDocument();
  });

  it("lets the operator past — they are the ones who review claims", async () => {
    renderGate({ profile: fakeProfile(true, "pending"), isOwner: true });
    expect(await screen.findByText("Scouting")).toBeInTheDocument();
  });

  it("runs after the email gate, not before it", async () => {
    // Otherwise a team's admins would be judging requests from addresses
    // nobody had confirmed yet.
    renderGate({
      user: fakeUser({ emailVerified: false }),
      profile: fakeProfile(false, "pending"),
      team: { teamNumber: "5806", claimedAt: "stamped" },
    });

    expect(await screen.findByText("Verify your email")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for an admin")).not.toBeInTheDocument();
  });
});
