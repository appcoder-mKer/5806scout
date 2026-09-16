import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventTeam } from "@/lib/eventData";
import { MANUAL_EVENT_KEY_PREFIX } from "@/lib/manualEvent";
import { POST } from "./route";

vi.mock("@/lib/serverConfig", () => ({
  getServerConfig: vi.fn(),
}));

import { getServerConfig, type ServerConfig } from "@/lib/serverConfig";

const mockGetServerConfig = vi.mocked(getServerConfig);

interface ManualEventBody {
  eventKey: string;
  eventName: string;
  teams: EventTeam[];
  matches: unknown[];
  epaAvailable: boolean;
  oprAvailable: boolean;
  epaYear: number;
  unknownTeams: number[];
  error?: string;
}

function serverConfig(tbaApiKey: string | null): ServerConfig {
  return {
    tbaApiKey,
    nexusApiKey: null,
    manualQaRagUrl: null,
    cfAccountId: null,
    cfAiSearchInstance: null,
    cfAiSearchToken: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function request(body: unknown): Request {
  return new Request("http://localhost/api/manual-event", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const TBA_TEAMS: Record<string, unknown> = {
  frc5806: { team_number: 5806, nickname: "Basement Lions", city: "Bronx" },
  frc254: { team_number: 254, nickname: "The Cheesy Poofs", city: "San Jose" },
};

const SEASON_EPA: Record<string, unknown> = {
  "5806": { team: 5806, epa: { total_points: 41.7 } },
  "254": { team: 254, epa: { total_points: 88.2 } },
};

/**
 * Answer both upstreams by URL. `missing` names teams TBA 404s and `epaDown`
 * makes every Statbotics call fail the way the live outage does.
 */
function mockUpstreams({
  missing = [] as number[],
  epaDown = false,
} = {}) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      const tba = url.match(/\/team\/(frc\d+)\/simple$/);
      if (tba) {
        const teamNumber = Number(tba[1].replace("frc", ""));
        if (missing.includes(teamNumber)) return jsonResponse({}, 404);
        return jsonResponse(TBA_TEAMS[tba[1]] ?? {}, 200);
      }
      const statbotics = url.match(/\/team_year\/(\d+)\/(\d+)$/);
      if (statbotics) {
        if (epaDown) return jsonResponse({}, 500);
        const row = SEASON_EPA[statbotics[1]];
        return row ? jsonResponse(row) : jsonResponse({}, 404);
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
}

describe("POST /api/manual-event", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds an event from a team list, enriched from both upstreams", async () => {
    mockGetServerConfig.mockReturnValue(serverConfig("key"));
    mockUpstreams();

    const res = await POST(
      request({ eventName: "Ramp Riot 2026", teamNumbers: [5806, 254], year: 2026 }),
    );
    const body = (await res.json()) as ManualEventBody;

    expect(res.status).toBe(200);
    expect(body.eventName).toBe("Ramp Riot 2026");
    expect(body.eventKey.startsWith(MANUAL_EVENT_KEY_PREFIX)).toBe(true);
    // mapTeams sorts by team number, and ranks EPA within the event.
    expect(body.teams).toEqual([
      {
        teamNumber: 254,
        nickname: "The Cheesy Poofs",
        city: "San Jose",
        epa: 88.2,
        epaRank: 1,
        opr: null,
      },
      {
        teamNumber: 5806,
        nickname: "Basement Lions",
        city: "Bronx",
        epa: 41.7,
        epaRank: 2,
        opr: null,
      },
    ]);
    expect(body.matches).toEqual([]);
    expect(body.epaAvailable).toBe(true);
    expect(body.oprAvailable).toBe(false);
    expect(body.epaYear).toBe(2026);
    expect(body.unknownTeams).toEqual([]);
  });

  it("keeps a team TBA has never heard of, and names it as unknown", async () => {
    mockGetServerConfig.mockReturnValue(serverConfig("key"));
    mockUpstreams({ missing: [9999] });

    const res = await POST(
      request({ eventName: "Off Season", teamNumbers: [5806, 9999] }),
    );
    const body = (await res.json()) as ManualEventBody;

    expect(body.unknownTeams).toEqual([9999]);
    const unknown = body.teams.find((t) => t.teamNumber === 9999);
    // Falls back to its own number rather than vanishing from the list.
    expect(unknown).toMatchObject({ nickname: "9999", city: "", epa: null });
  });

  it("stops asking Statbotics once it has clearly gone down", async () => {
    mockGetServerConfig.mockReturnValue(serverConfig("key"));
    let epaCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        if (/\/team_year\//.test(String(input))) {
          epaCalls += 1;
          return jsonResponse({}, 500);
        }
        return jsonResponse({ team_number: 1, nickname: "T", city: "C" });
      },
    );

    const res = await POST(
      request({
        eventName: "Off Season",
        teamNumbers: Array.from({ length: 60 }, (_, i) => i + 1),
      }),
    );
    const body = (await res.json()) as ManualEventBody;

    // The breaker trips after 8 failed teams; the rest are skipped rather
    // than each burning two attempts and a timeout.
    expect(epaCalls).toBeLessThan(60 * 2);
    expect(body.epaAvailable).toBe(false);
    // The team list still comes back in full — EPA is the only casualty.
    expect(body.teams).toHaveLength(60);
  });

  it("withholds epaAvailable when even one lookup failed", async () => {
    mockGetServerConfig.mockReturnValue(serverConfig("key"));
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = String(input);
        const epa = url.match(/\/team_year\/(\d+)\//);
        if (epa) {
          // 254 answers; 5806 fails the way a throttled upstream does.
          return epa[1] === "254"
            ? jsonResponse({ team: 254, epa: { total_points: 88.2 } })
            : jsonResponse({}, 503);
        }
        const tba = url.match(/\/team\/(frc\d+)\/simple$/);
        return jsonResponse(TBA_TEAMS[tba![1]] ?? {}, 200);
      },
    );

    const res = await POST(
      request({ eventName: "Off Season", teamNumbers: [5806, 254] }),
    );
    const body = (await res.json()) as ManualEventBody;

    // One success must not license overwriting the other team's known EPA
    // with null — the client's preserveEpa guard keys off this flag.
    expect(body.epaAvailable).toBe(false);
    expect(body.teams.find((t) => t.teamNumber === 254)?.epa).toBe(88.2);
  });

  it("flags Statbotics being down instead of reporting an EPA-less event", async () => {
    mockGetServerConfig.mockReturnValue(serverConfig("key"));
    mockUpstreams({ epaDown: true });

    const res = await POST(
      request({ eventName: "Off Season", teamNumbers: [5806] }),
    );
    const body = (await res.json()) as ManualEventBody;

    expect(body.epaAvailable).toBe(false);
    expect(body.teams[0].epa).toBeNull();
  });

  it("reuses an existing manual key so a re-enrich edits the same event", async () => {
    mockGetServerConfig.mockReturnValue(serverConfig("key"));
    mockUpstreams();

    const res = await POST(
      request({
        eventName: "Ramp Riot",
        teamNumbers: [5806],
        eventKey: "manual-ramp-riot-abcd",
      }),
    );

    expect(((await res.json()) as ManualEventBody).eventKey).toBe(
      "manual-ramp-riot-abcd",
    );
  });

  it("refuses to adopt a real TBA event key as a manual one", async () => {
    mockGetServerConfig.mockReturnValue(serverConfig("key"));
    mockUpstreams();

    const res = await POST(
      request({ eventName: "Ski", teamNumbers: [5806], eventKey: "2026njski" }),
    );
    const body = (await res.json()) as ManualEventBody;

    expect(body.eventKey).not.toBe("2026njski");
    expect(body.eventKey.startsWith(MANUAL_EVENT_KEY_PREFIX)).toBe(true);
  });

  it("drops junk in the team list rather than looking it up", async () => {
    mockGetServerConfig.mockReturnValue(serverConfig("key"));
    const fetchMock = mockUpstreams();

    const res = await POST(
      request({
        eventName: "Off Season",
        teamNumbers: [5806, "254", 0, -3, 12.5, 5806, null],
      }),
    );
    const body = (await res.json()) as ManualEventBody;

    expect(body.teams.map((t) => t.teamNumber)).toEqual([5806]);
    // One TBA call and one Statbotics call — the junk never reached upstream.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an event with no name", async () => {
    mockGetServerConfig.mockReturnValue(serverConfig("key"));
    const res = await POST(request({ eventName: "  ", teamNumbers: [5806] }));
    expect(res.status).toBe(400);
  });

  it("rejects an empty team list", async () => {
    mockGetServerConfig.mockReturnValue(serverConfig("key"));
    const res = await POST(request({ eventName: "Off Season", teamNumbers: [] }));
    expect(res.status).toBe(400);
  });

  it("rejects a list longer than any real event", async () => {
    mockGetServerConfig.mockReturnValue(serverConfig("key"));
    const res = await POST(
      request({
        eventName: "Off Season",
        teamNumbers: Array.from({ length: 201 }, (_, i) => i + 1),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("reports a missing TBA key as setup, not as a failed lookup", async () => {
    mockGetServerConfig.mockReturnValue(serverConfig(null));
    const res = await POST(
      request({ eventName: "Off Season", teamNumbers: [5806] }),
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as ManualEventBody).error).toContain("TBA_API_KEY");
  });

  it("keeps no more than 8 teams' lookups in flight at once", async () => {
    mockGetServerConfig.mockReturnValue(serverConfig("key"));
    let inFlight = 0;
    let peak = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return jsonResponse({}, 404);
    });

    await POST(
      request({
        eventName: "Off Season",
        teamNumbers: Array.from({ length: 30 }, (_, i) => i + 1),
      }),
    );

    // 8 teams in flight, each with its TBA and Statbotics call running
    // together — so 16 requests, and nowhere near the 60 an unbounded
    // fan-out over 30 teams would open.
    expect(peak).toBeLessThanOrEqual(16);
    expect(peak).toBeGreaterThan(8);
  });
});
