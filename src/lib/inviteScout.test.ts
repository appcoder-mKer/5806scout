import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  config: {
    firebase: {
      apiKey: "test-api-key",
      projectId: "test-project",
      authDomain: "test.firebaseapp.com",
      storageBucket: "test.appspot.com",
      messagingSenderId: "1",
      appId: "1:1:web:1",
    },
  },
}));

import { InviteError, generateThrowawayPassword, inviteScout } from "./inviteScout";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

/** Builds a fetch mock that dispatches on the identitytoolkit `endpoint`
 *  segment or on the Firestore REST doc URL, matching inviteScout.ts's
 *  actual call sequence. */
function mockFetchSequence(
  handlers: Partial<{
    lookup: () => Response;
    getProfile: () => Response;
    signUp: () => Response;
    update: () => Response;
    createProfile: () => Response;
    sendOobCode: () => Response;
    deleteAccount: () => Response;
  }>,
) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    if (url.includes("accounts:lookup")) {
      return handlers.lookup?.() ?? jsonResponse({ users: [{ localId: "caller-uid" }] });
    }
    if (url.includes("accounts:signUp")) {
      return (
        handlers.signUp?.() ??
        jsonResponse({ localId: "new-uid", idToken: "new-id-token" })
      );
    }
    if (url.includes("accounts:update")) {
      return handlers.update?.() ?? jsonResponse({});
    }
    if (url.includes("accounts:sendOobCode")) {
      return handlers.sendOobCode?.() ?? jsonResponse({});
    }
    if (url.includes("accounts:delete")) {
      return handlers.deleteAccount?.() ?? jsonResponse({});
    }
    if (url.includes("firestore.googleapis.com")) {
      if (init?.method === "PATCH") {
        return handlers.createProfile?.() ?? jsonResponse({});
      }
      return handlers.getProfile?.() ?? jsonResponse({
        fields: {
          role: { stringValue: "admin" },
          teamId: { stringValue: "team-1" },
          status: { stringValue: "approved" },
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url} ${JSON.stringify(body)}`);
  });
}

describe("inviteScout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the scout end-to-end and returns their email", async () => {
    vi.stubGlobal("fetch", mockFetchSequence({}));

    const result = await inviteScout("caller-token", "Ada Lovelace", "ada@team.org");
    expect(result).toEqual({ email: "ada@team.org" });
  });

  it("writes the invitee's profile unverified, so the roster waits for them", async () => {
    const fetchMock = mockFetchSequence({});
    vi.stubGlobal("fetch", fetchMock);

    await inviteScout("caller-token", "Ada Lovelace", "ada@team.org");

    const write = fetchMock.mock.calls.find(
      ([url, init]) =>
        (url as string).includes("firestore.googleapis.com") &&
        (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(write).toBeDefined();
    const body = JSON.parse((write![1] as RequestInit).body as string);
    expect(body.fields.emailVerified).toEqual({ booleanValue: false });
  });

  it("throws 401 when the caller's ID token doesn't resolve to a user", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({ lookup: () => jsonResponse({ users: [] }) }),
    );

    await expect(
      inviteScout("bad-token", "Ada", "ada@team.org"),
    ).rejects.toMatchObject({ status: 401 } satisfies Partial<InviteError>);
  });

  it("throws 403 when the caller is not an admin", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({
        getProfile: () =>
          jsonResponse({
            fields: {
              role: { stringValue: "scout" },
              teamId: { stringValue: "team-1" },
            },
          }),
      }),
    );

    await expect(
      inviteScout("caller-token", "Ada", "ada@team.org"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses an admin who is not approved yet", async () => {
    // Role alone is no longer the whole answer: an account can hold role
    // "admin" while still sitting at the approval gate, and this route runs
    // outside the rules that would otherwise stop it.
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({
        getProfile: () =>
          jsonResponse({
            fields: {
              role: { stringValue: "admin" },
              teamId: { stringValue: "team-1" },
              status: { stringValue: "pending" },
            },
          }),
      }),
    );

    await expect(
      inviteScout("caller-token", "Ada", "ada@team.org"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses an admin whose profile predates the status field", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({
        getProfile: () =>
          jsonResponse({
            fields: {
              role: { stringValue: "admin" },
              teamId: { stringValue: "team-1" },
            },
          }),
      }),
    );

    await expect(
      inviteScout("caller-token", "Ada", "ada@team.org"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("approves the invitee with the admin's own token, and only that field", async () => {
    // An admin who typed someone's address has already vouched for them, so
    // the invitee skips the queue. Two things have to be right: the write uses
    // the CALLER's token (the invitee's own could never lift its own status),
    // and it carries an updateMask — a Firestore REST PATCH without one
    // REPLACES the document, which would reduce the profile to a lone field.
    const fetchMock = mockFetchSequence({});
    vi.stubGlobal("fetch", fetchMock);

    await inviteScout("caller-token", "Ada Lovelace", "ada@team.org");

    const approve = fetchMock.mock.calls.find(
      ([url, init]) =>
        typeof url === "string" &&
        url.includes("firestore.googleapis.com") &&
        url.includes("updateMask.fieldPaths=status") &&
        init?.method === "PATCH",
    );
    expect(approve).toBeDefined();

    const init = approve![1] as RequestInit;
    expect(
      (init.headers as Record<string, string>).Authorization,
    ).toBe("Bearer caller-token");
    expect(JSON.parse(init.body as string)).toEqual({
      fields: { status: { stringValue: "approved" } },
    });
  });

  it("throws 403 when the caller has no teamId", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({
        getProfile: () =>
          jsonResponse({ fields: { role: { stringValue: "admin" } } }),
      }),
    );

    await expect(
      inviteScout("caller-token", "Ada", "ada@team.org"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("throws 409 when the email already has an account", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({
        signUp: () =>
          jsonResponse({ error: { message: "EMAIL_EXISTS" } }, false, 400),
      }),
    );

    await expect(
      inviteScout("caller-token", "Ada", "ada@team.org"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("throws 400 for an invalid email", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({
        signUp: () =>
          jsonResponse({ error: { message: "INVALID_EMAIL" } }, false, 400),
      }),
    );

    await expect(
      inviteScout("caller-token", "Ada", "not-an-email"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rolls back the created auth account when profile creation fails", async () => {
    const deleteAccount = vi.fn(() => jsonResponse({}));
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({
        createProfile: () => jsonResponse({}, false, 500),
        deleteAccount,
      }),
    );

    await expect(
      inviteScout("caller-token", "Ada", "ada@team.org"),
    ).rejects.toMatchObject({ status: 502 });
    expect(deleteAccount).toHaveBeenCalled();
  });

  it("does not roll back the account when only the invite email fails to send", async () => {
    const deleteAccount = vi.fn(() => jsonResponse({}));
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({
        sendOobCode: () => jsonResponse({}, false, 500),
        deleteAccount,
      }),
    );

    await expect(
      inviteScout("caller-token", "Ada", "ada@team.org"),
    ).rejects.toThrow(/invite email failed to send/);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("swallows rollback failures and still surfaces the original error", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({
        createProfile: () => jsonResponse({}, false, 500),
        deleteAccount: () => jsonResponse({ error: { message: "UNKNOWN" } }, false, 500),
      }),
    );

    await expect(
      inviteScout("caller-token", "Ada", "ada@team.org"),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("throws 401 when the caller's session has expired mid-flow", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({
        lookup: () =>
          jsonResponse(
            { error: { message: "INVALID_ID_TOKEN" } },
            false,
            400,
          ),
      }),
    );

    await expect(
      inviteScout("expired-token", "Ada", "ada@team.org"),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("signs the invitee up with a password that meets Firebase's policy", async () => {
    const fetchMock = mockFetchSequence({});
    vi.stubGlobal("fetch", fetchMock);

    await inviteScout("caller-token", "Ada Lovelace", "ada@team.org");

    const signUp = fetchMock.mock.calls.find(([url]) =>
      (url as string).includes("accounts:signUp"),
    );
    expect(signUp).toBeDefined();
    const { password } = JSON.parse((signUp![1] as RequestInit).body as string);
    // The project enforces lower + upper + numeric + non-alphanumeric. A
    // randomUUID-based password is all lowercase and fails the third check.
    expect(password.length).toBeGreaterThanOrEqual(32);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[^a-zA-Z0-9]/);
  });

  it("uses a different throwaway password for each invite", async () => {
    const fetchMock = mockFetchSequence({});
    vi.stubGlobal("fetch", fetchMock);

    await inviteScout("caller-token", "Ada", "ada@team.org");
    await inviteScout("caller-token", "Grace", "grace@team.org");

    const passwords = fetchMock.mock.calls
      .filter(([url]) => (url as string).includes("accounts:signUp"))
      .map(([, init]) => JSON.parse((init as RequestInit).body as string).password);
    expect(passwords).toHaveLength(2);
    expect(passwords[0]).not.toBe(passwords[1]);
  });

  it("never blames the admin when Firebase rejects our throwaway password", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({
        signUp: () =>
          jsonResponse(
            {
              error: {
                message:
                  "PASSWORD_DOES_NOT_MEET_REQUIREMENTS : Missing password requirements: [Password must contain an upper case character]",
              },
            },
            false,
            400,
          ),
      }),
    );

    const promise = inviteScout("caller-token", "Ada", "ada@team.org");
    await expect(promise).rejects.toMatchObject({ status: 500 });
    await expect(promise).rejects.toThrow(
      /^Couldn't set up the account — try again/,
    );
  });
});

describe("generateThrowawayPassword", () => {
  it("always emits every character class the policy requires", () => {
    for (let i = 0; i < 200; i++) {
      const password = generateThrowawayPassword();
      expect(password).toHaveLength(32);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[!@#$%^&*_-]/);
    }
  });

  it("does not pin the guaranteed classes to fixed positions", () => {
    // A shuffle bug would leave the digit stuck at index 2 every time.
    const digitPositions = new Set(
      Array.from({ length: 100 }, () =>
        generateThrowawayPassword().search(/[0-9]/),
      ),
    );
    expect(digitPositions.size).toBeGreaterThan(1);
  });
});
