import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@/lib/googleServiceAccount", () => ({
  readServiceAccount: () => mockAccount,
  getAccessToken: async () => {
    if (tokenFails) throw new Error("token exchange failed");
    return "service-account-token";
  },
}));

let mockAccount: { clientEmail: string; privateKey: string } | null = null;
let tokenFails = false;

import { DeleteMemberError, deleteMember } from "./deleteMember";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as Response;
}

function profileDoc(
  role: string,
  teamId: string,
  fullName = "Ada Lovelace",
  status = "approved",
) {
  return jsonResponse({
    fields: {
      role: { stringValue: role },
      teamId: { stringValue: teamId },
      fullName: { stringValue: fullName },
      status: { stringValue: status },
    },
  });
}

/** A runQuery result row for an admin profile. */
function adminRow(uid: string) {
  return {
    document: {
      name: `projects/test-project/databases/(default)/documents/users/${uid}`,
    },
  };
}

/** Dispatches on deleteMember.ts's actual call sequence: lookup, then the
 *  caller's profile, the target's profile, the admin head-count (self-delete
 *  only), the auth delete, the doc delete. */
function mockFetchSequence(
  handlers: Partial<{
    lookup: () => Response;
    callerProfile: () => Response;
    targetProfile: () => Response;
    adminQuery: () => Response;
    authDelete: () => Response;
    docDelete: () => Response;
  }> = {},
) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("accounts:lookup")) {
      return (
        handlers.lookup?.() ?? jsonResponse({ users: [{ localId: "caller-uid" }] })
      );
    }
    if (url.includes("accounts:delete")) {
      return handlers.authDelete?.() ?? jsonResponse({});
    }
    if (url.includes(":runQuery")) {
      // Default: the caller is not the only admin.
      return (
        handlers.adminQuery?.() ??
        jsonResponse([adminRow("caller-uid"), adminRow("other-admin")])
      );
    }
    if (url.includes("firestore.googleapis.com")) {
      if (init?.method === "DELETE") {
        return handlers.docDelete?.() ?? jsonResponse({});
      }
      if (url.includes("/users/caller-uid")) {
        return handlers.callerProfile?.() ?? profileDoc("admin", "team-1", "Admin");
      }
      return handlers.targetProfile?.() ?? profileDoc("scout", "team-1");
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

describe("deleteMember", () => {
  beforeEach(() => {
    mockAccount = { clientEmail: "sa@test.iam.gserviceaccount.com", privateKey: "key" };
    tokenFails = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes the auth account and the profile, returning their name", async () => {
    const fetchMock = mockFetchSequence();
    vi.stubGlobal("fetch", fetchMock);

    const result = await deleteMember("caller-token", "target-uid");
    expect(result).toEqual({ fullName: "Ada Lovelace" });

    const calls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(calls.some((u) => u.includes("accounts:delete"))).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          (url as string).includes("/users/target-uid") &&
          (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(true);
  });

  it("deletes the auth account by localId, not by the caller's token", async () => {
    const fetchMock = mockFetchSequence();
    vi.stubGlobal("fetch", fetchMock);

    await deleteMember("caller-token", "target-uid");

    const authCall = fetchMock.mock.calls.find(([url]) =>
      (url as string).includes("accounts:delete"),
    );
    const body = JSON.parse((authCall?.[1] as RequestInit).body as string);
    expect(body).toEqual({ localId: "target-uid" });
  });

  it("throws 501 when no service account is configured", async () => {
    mockAccount = null;
    vi.stubGlobal("fetch", mockFetchSequence());

    await expect(
      deleteMember("caller-token", "target-uid"),
    ).rejects.toMatchObject({ status: 501 } satisfies Partial<DeleteMemberError>);
  });

  it("deletes yourself once another admin can take over", async () => {
    const fetchMock = mockFetchSequence();
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteMember("caller-token", "caller-uid")).resolves.toEqual({
      fullName: "Admin",
    });
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          (url as string).includes("/users/caller-uid") &&
          (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(true);
  });

  it("refuses to delete the last admin — nobody left could grant the role", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({
        adminQuery: () => jsonResponse([adminRow("caller-uid")]),
      }),
    );

    await expect(
      deleteMember("caller-token", "caller-uid"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("treats an empty runQuery result as having no other admin", async () => {
    // runQuery answers "no matches" with a row carrying only a readTime.
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({ adminQuery: () => jsonResponse([{ readTime: "t" }]) }),
    );

    await expect(
      deleteMember("caller-token", "caller-uid"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("changes nothing when the admin head-count itself fails", async () => {
    const fetchMock = mockFetchSequence({
      adminQuery: () => jsonResponse({}, false, 500),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deleteMember("caller-token", "caller-uid"),
    ).rejects.toMatchObject({ status: 502 });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        (url as string).includes("accounts:delete"),
      ),
    ).toBe(false);
  });

  it("skips the head-count when deleting someone else", async () => {
    const fetchMock = mockFetchSequence();
    vi.stubGlobal("fetch", fetchMock);

    await deleteMember("caller-token", "target-uid");

    expect(
      fetchMock.mock.calls.some(([url]) => (url as string).includes(":runQuery")),
    ).toBe(false);
  });

  it("throws 401 when the caller's ID token doesn't resolve", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({ lookup: () => jsonResponse({ users: [] }) }),
    );

    await expect(
      deleteMember("bad-token", "target-uid"),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("throws 403 when the caller is not an admin", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({ callerProfile: () => profileDoc("scout", "team-1") }),
    );

    await expect(
      deleteMember("caller-token", "target-uid"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("throws 403 when the target is on another team", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({ targetProfile: () => profileDoc("scout", "team-2") }),
    );

    await expect(
      deleteMember("caller-token", "target-uid"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("throws 404 when the target profile is already gone", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({
        targetProfile: () => jsonResponse({}, false, 404),
      }),
    );

    await expect(
      deleteMember("caller-token", "target-uid"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("still clears the profile when the auth account was already deleted", async () => {
    const fetchMock = mockFetchSequence({
      authDelete: () => jsonResponse({}, false, 404),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(deleteMember("caller-token", "target-uid")).resolves.toEqual({
      fullName: "Ada Lovelace",
    });
  });

  it("leaves the profile alone when the auth delete fails outright", async () => {
    const fetchMock = mockFetchSequence({
      authDelete: () => jsonResponse({}, false, 500),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deleteMember("caller-token", "target-uid"),
    ).rejects.toMatchObject({ status: 502 });

    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
      ),
    ).toBe(false);
  });

  it("reports the half-finished state when the profile delete fails", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchSequence({ docDelete: () => jsonResponse({}, false, 500) }),
    );

    await expect(
      deleteMember("caller-token", "target-uid"),
    ).rejects.toMatchObject({ status: 502 });
  });

  it("throws 502 when the service-account token exchange fails", async () => {
    tokenFails = true;
    vi.stubGlobal("fetch", mockFetchSequence());

    await expect(
      deleteMember("caller-token", "target-uid"),
    ).rejects.toMatchObject({ status: 502 });
  });
});
