import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTeamEvents, fetchTeamYear } from "./statbotics";

/** No-op sleep so retry backoff costs no wall-clock time in tests. */
const noSleep = () => Promise.resolve();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchTeamEvents", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends no auth header — the v3 API is keyless", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    await fetchTeamEvents("2026test", { sleep: noSleep });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.headers).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toContain("api.statbotics.io/v3");
  });

  it("returns parsed rows on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([{ team: 5806, epa: { total_points: 41.7 } }]),
      ),
    );

    const result = await fetchTeamEvents("2026test", { sleep: noSleep });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data[0].team).toBe(5806);
  });

  it("retries a transient 503 and succeeds on a later attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse([{ team: 254 }]));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTeamEvents("2026test", { sleep: noSleep });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it("gives up after maxAttempts and reports the upstream status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTeamEvents("2026test", { sleep: noSleep });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ ok: false, status: 500 });
  });

  it("does not retry a non-transient 400", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 400));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTeamEvents("2026test", { sleep: noSleep });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, status: 400 });
  });

  it("treats 404 as an empty list, not a failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 404)));

    const result = await fetchTeamEvents("2026nope", { sleep: noSleep });
    expect(result).toEqual({ ok: true, data: [] });
  });

  it("reports failure with a null status when every attempt throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const result = await fetchTeamEvents("2026test", { sleep: noSleep });
    expect(result).toEqual({ ok: false, status: null });
  });

  // The live outage on 2026-07-27 answered `{}` with a 500; a 200-shaped `{}`
  // would otherwise parse into "zero teams" and read as real data.
  it("rejects a non-array body rather than reporting zero teams", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));

    const result = await fetchTeamEvents("2026test", { sleep: noSleep });
    expect(result).toEqual({ ok: false, status: 200 });
  });

  it("reports failure when the body is not valid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>500</html>", { status: 200 })),
    );

    const result = await fetchTeamEvents("2026test", { sleep: noSleep });
    expect(result).toEqual({ ok: false, status: 200 });
  });
});

describe("fetchTeamYear", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("asks for the team's season row by team and year", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ team: 5806, epa: { total_points: 41.7 } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTeamYear(5806, 2026, { sleep: noSleep });

    expect(fetchMock.mock.calls[0][0]).toContain("/team_year/5806/2026");
    expect(result).toEqual({
      ok: true,
      data: { team: 5806, epa: { total_points: 41.7 } },
    });
  });

  it("treats a 404 as a team with no season row, not a failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 404)));

    expect(await fetchTeamYear(9999, 2026, { sleep: noSleep })).toEqual({
      ok: true,
      data: null,
    });
  });

  // Same outage shape as fetchTeamEvents guards against: `{}` with no team
  // number is the API being down, not a team without an EPA.
  it("rejects a body with no team number rather than reporting no EPA", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})));

    expect(await fetchTeamYear(5806, 2026, { sleep: noSleep })).toEqual({
      ok: false,
      status: 200,
    });
  });

  it("retries a transient 500 before giving up", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({ team: 254, epa: { total_points: 80 } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTeamYear(254, 2026, { sleep: noSleep });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it("reports failure when the network never answers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    expect(await fetchTeamYear(5806, 2026, { sleep: noSleep })).toEqual({
      ok: false,
      status: null,
    });
  });
});
