"use client";

import { useAuth } from "@/lib/auth/AuthProvider";
import type { EventData, EventMatch } from "@/lib/eventData";
import { liveEventKey } from "@/lib/manualEvent";
import { db } from "@/lib/firebase/client";
import {
  QUEUE_ALERT_MS,
  currentMatch,
  formatCountdown,
  lastPlayedMatch,
  matchLabel,
  msUntilMatch,
  nextTeamMatch,
} from "@/lib/pitDashboard";
import type { NexusMatchStatus, QueueMatch, QueueStatus } from "@/lib/nexus";
import {
  normalizeStatus,
  STATUS_LABELS,
  type TalkieStatus,
} from "@/lib/talkie";
import Link from "next/link";
import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  Timestamp,
} from "firebase/firestore";
import { useEffect, useState } from "react";

const LIVE_REFRESH_MS = 60_000;
// Queue status is the number the pit crew acts on and it moves in minutes,
// not the hour TBA's schedule does — poll it twice as often.
const QUEUE_REFRESH_MS = 30_000;

interface PitTodoItem {
  id: string;
  text: string;
  done: boolean;
}

interface PitTodoDoc {
  items: PitTodoItem[];
  updatedAt: number;
}

interface LiveResponse {
  matches?: EventMatch[];
  fetchedAt?: number;
  error?: string;
}

interface QueueResponse {
  /** Null when the event doesn't run Nexus queue management. */
  status?: QueueStatus | null;
  fetchedAt?: number;
  error?: string;
}

export default function PitDashboardPage() {
  const { profile, dataTeamId } = useAuth();
  const isAdmin = profile?.role === "admin";

  const [event, setEvent] = useState<EventData | null>(null);
  const [eventLoaded, setEventLoaded] = useState(false);
  const [liveMatches, setLiveMatches] = useState<EventMatch[] | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // The synced event doc supplies the event key (and a match-list fallback
  // until the first live poll lands).
  useEffect(() => {
    if (!dataTeamId || !isAdmin) return;
    return onSnapshot(
      doc(db, "teams", dataTeamId, "config", "event"),
      (snapshot) => {
        setEvent(snapshot.exists() ? (snapshot.data() as EventData) : null);
        setEventLoaded(true);
      },
    );
  }, [dataTeamId, isAdmin]);

  // Live match feed from The Blue Alliance, refreshed every minute.
  // Null for a manual event — nothing upstream to ask about it.
  const liveKey = liveEventKey(event);
  useEffect(() => {
    if (!isAdmin || !liveKey) return;
    let cancelled = false;

    async function load(eventKey: string) {
      try {
        const res = await fetch(`/api/event/${encodeURIComponent(eventKey)}/live`);
        const body = (await res.json()) as LiveResponse;
        if (cancelled) return;
        if (!res.ok || !body.matches) {
          setLiveError(body.error ?? "Could not load live match data.");
          return;
        }
        setLiveMatches(body.matches);
        setFetchedAt(body.fetchedAt ?? Date.now());
        setLiveError(null);
      } catch {
        if (!cancelled) setLiveError("Could not load live match data — are you online?");
      }
    }

    void load(liveKey);
    const timer = setInterval(() => void load(liveKey), LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isAdmin, liveKey]);

  // Live queueing from FRC Nexus — what the lead queuer is actually calling,
  // which TBA doesn't publish at all. Only events running Nexus queue
  // management have it, so a null status is normal, not an error.
  useEffect(() => {
    if (!isAdmin || !liveKey) return;
    const team = profile?.teamId ?? "";
    let cancelled = false;

    async function load(eventKey: string) {
      try {
        const res = await fetch(
          `/api/event/${encodeURIComponent(eventKey)}/queue?team=${encodeURIComponent(team)}`,
        );
        const body = (await res.json()) as QueueResponse;
        if (cancelled) return;
        if (!res.ok) {
          setQueueError(body.error ?? "Could not load Nexus queueing.");
          return;
        }
        setQueue(body.status ?? null);
        setQueueError(null);
      } catch {
        if (!cancelled) setQueueError("Could not reach Nexus — are you online?");
      }
    }

    void load(liveKey);
    const timer = setInterval(() => void load(liveKey), QUEUE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isAdmin, liveKey, profile?.teamId]);

  // One-second tick drives the queue countdown and the blink threshold.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (profile && !isAdmin) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-8 md:px-6">
        <div className="rounded-lg border border-dashed border-graphite-300 bg-graphite-50 px-6 py-12 text-center text-sm text-graphite-500">
          The Pit Dashboard is only available to admins.
        </div>
      </main>
    );
  }

  const matches = liveMatches ?? event?.matches ?? [];
  const teamNumber = Number(profile?.teamId ?? "");
  const onField = currentMatch(matches);
  const lastPlayed = lastPlayedMatch(matches);
  const ourNext = nextTeamMatch(matches, teamNumber);

  // Our upcoming match: Nexus when the event runs its queueing (it knows when
  // the match is actually being called, not just when it was scheduled), TBA's
  // published schedule otherwise.
  const upNext = queue?.ourNext
    ? {
        label: queue.ourNext.label,
        msToQueue:
          queue.ourNext.queueTime !== null ? queue.ourNext.queueTime - now : null,
        status: queue.ourNext.status,
        live: true,
      }
    : ourNext
      ? {
          label: matchLabel(ourNext),
          msToQueue: msUntilMatch(ourNext, now),
          status: null,
          live: false,
        }
      : null;

  // Nexus calling the match is the real "go now" signal; the countdown
  // threshold only has to stand in when the event isn't on Nexus.
  const queueAlert =
    upNext !== null &&
    ((upNext.status !== null && upNext.status !== "Queuing soon") ||
      (upNext.msToQueue !== null && upNext.msToQueue < QUEUE_ALERT_MS));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 md:px-6">
      <div>
        <h1 className="page-title">
          <span aria-hidden className="page-rule" />
          Pit Dashboard
        </h1>
        <p className="page-lede">
          {event
            ? `${event.eventName} — live from ${queue ? "Nexus + The Blue Alliance" : "The Blue Alliance"}${
                fetchedAt !== null
                  ? `, updated ${new Date(fetchedAt).toLocaleTimeString()}`
                  : ""
              }.`
            : "Live match tracking and pit tasks for admins."}
        </p>
      </div>

      {liveError && (
        <p className="badge-error rounded-md px-3 py-2 text-sm normal-case tracking-normal">
          {liveError}
        </p>
      )}

      {queueError && (
        <p className="badge-warning rounded-md px-3 py-2 text-sm normal-case tracking-normal">
          {queueError} Falling back to the TBA schedule.
        </p>
      )}

      {eventLoaded && !event && (
        <div className="rounded-lg border border-dashed border-graphite-300 bg-graphite-50 px-6 py-12 text-center text-sm text-graphite-500">
          No event synced yet — sync one on the Event tab to light up the
          dashboard.
        </div>
      )}

      {event && (
        <div className="grid gap-4 md:grid-cols-2">
          <CurrentMatchCard
            onField={onField}
            lastPlayed={lastPlayed}
            ourNext={ourNext}
            hasSchedule={matches.length > 0}
            queue={queue}
          />
          <QueueingCard upNext={upNext} alert={queueAlert} />
          {queue && (
            <div className="md:col-span-2">
              <QueueBoardCard queue={queue} myTeam={profile?.teamId ?? ""} />
            </div>
          )}
          <div className="md:col-span-2">
            <OpenTalkieCard teamId={dataTeamId ?? ""} />
          </div>
          <div className="md:col-span-2">
            <TodoCard teamId={dataTeamId ?? ""} />
          </div>
        </div>
      )}
    </main>
  );
}

function CurrentMatchCard({
  onField,
  lastPlayed,
  ourNext,
  hasSchedule,
  queue,
}: {
  onField: EventMatch | null;
  lastPlayed: EventMatch | null;
  ourNext: EventMatch | null;
  hasSchedule: boolean;
  queue: QueueStatus | null;
}) {
  return (
    <section className="surface-card flex flex-col gap-3 p-5">
      <h2 className="section-title">Current match</h2>
      {hasSchedule ? (
        <>
          <p className="stat text-5xl font-bold text-graphite-900">
            {/* Nexus knows which match the field is actually running; TBA only
                knows which one hasn't been scored yet. */}
            {queue?.onField?.label ??
              (onField ? matchLabel(onField) : "Done")}
          </p>
          {queue?.nowQueuing && (
            <p className="text-sm text-graphite-600">
              Now queuing:{" "}
              <span className="stat font-semibold text-maroon-700 dark:text-maroon-300">
                {queue.nowQueuing}
              </span>
            </p>
          )}
          <div className="flex flex-col gap-1 text-sm text-graphite-600">
            <span>
              Last played:{" "}
              <span className="stat font-semibold">
                {lastPlayed ? matchLabel(lastPlayed) : "—"}
              </span>
            </span>
            <span>
              Our next match:{" "}
              <span className="stat font-semibold">
                {ourNext ? matchLabel(ourNext) : "none left"}
              </span>
              {ourNext?.scheduledTime && (
                <span className="text-graphite-500">
                  {" "}
                  at{" "}
                  {new Date(ourNext.scheduledTime * 1000).toLocaleTimeString(
                    undefined,
                    { hour: "numeric", minute: "2-digit" },
                  )}
                </span>
              )}
            </span>
          </div>
        </>
      ) : (
        <p className="py-4 text-sm text-graphite-500">
          Schedule not posted yet — TBA publishes it shortly before quals.
        </p>
      )}
    </section>
  );
}

/** Our upcoming match, from Nexus when the event runs it and TBA otherwise. */
interface UpNext {
  label: string;
  msToQueue: number | null;
  /** Nexus queueing status; null when this came from the TBA schedule. */
  status: NexusMatchStatus | null;
  live: boolean;
}

function QueueingCard({ upNext, alert }: { upNext: UpNext | null; alert: boolean }) {
  return (
    <section
      className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 p-5 text-center transition ${
        alert
          ? "animate-queue-blink border-red-600"
          : "border-graphite-200 bg-surface"
      }`}
    >
      <h2 className="text-xs font-semibold uppercase tracking-widest opacity-70">
        Queuing
      </h2>
      {upNext === null ? (
        <p className="py-3 text-sm text-graphite-500">
          No upcoming match — nothing to queue for.
        </p>
      ) : (
        <>
          {/* Once Nexus is calling the match, its status IS the headline —
              a countdown to a moment that already arrived reads as noise. */}
          {upNext.status !== null && upNext.status !== "Queuing soon" ? (
            <p className="text-3xl font-bold uppercase tracking-tight">
              {upNext.status}
            </p>
          ) : upNext.msToQueue === null ? (
            <p className="py-3 text-sm text-graphite-500">
              {upNext.label} has no {upNext.live ? "queue" : "scheduled"} time
              yet.
            </p>
          ) : (
            <p className="stat text-5xl font-bold">
              {formatCountdown(upNext.msToQueue)}
            </p>
          )}
          <p className="text-sm font-medium">
            {alert
              ? `QUEUE NOW for ${upNext.label}!`
              : `until ${upNext.label} — head to queue 5 min out.`}
          </p>
          {upNext.live && (
            <p className="text-xs opacity-70">Live queueing from Nexus</p>
          )}
        </>
      )}
    </section>
  );
}

const QUEUE_STATUS_STYLES: Record<NexusMatchStatus, string> = {
  "Queuing soon": "bg-graphite-100 text-graphite-600",
  "Now queuing": "bg-amber-100 text-amber-900 dark:text-amber-200",
  "On deck": "bg-maroon-50 text-maroon-700 dark:text-maroon-300",
  "On field": "bg-green-100 text-green-500 dark:text-green-400",
};

function queueTimeLabel(match: QueueMatch): string {
  const at = match.queueTime ?? match.startTime;
  if (at === null) return "—";
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The next few matches with the queuer's live status on each — the pit-side
 * view of the same board the field crew is working from.
 */
function QueueBoardCard({
  queue,
  myTeam,
}: {
  queue: QueueStatus;
  myTeam: string;
}) {
  return (
    <section className="surface-card flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="section-title">Up next — live from Nexus</h2>
        <a
          href="https://frc.nexus"
          target="_blank"
          rel="noreferrer"
          className="text-xs font-medium text-maroon-700 transition hover:text-maroon-800 dark:text-maroon-300"
        >
          frc.nexus ↗
        </a>
      </div>

      {queue.upcoming.length === 0 ? (
        <p className="rounded-lg border border-dashed border-graphite-300 px-4 py-6 text-center text-sm text-graphite-400">
          Nothing queued right now.
        </p>
      ) : (
        <ul className="divide-y divide-graphite-100">
          {queue.upcoming.map((match) => {
            const ours =
              myTeam !== "" &&
              (match.redTeams.includes(myTeam) ||
                match.blueTeams.includes(myTeam));
            return (
              <li key={match.label} className="flex items-center gap-3 py-2.5">
                <span
                  className={`stat shrink-0 text-sm font-semibold ${
                    ours
                      ? "text-maroon-700 dark:text-maroon-300"
                      : "text-graphite-800"
                  }`}
                >
                  {match.label}
                </span>
                <span className="stat min-w-0 flex-1 truncate text-xs text-graphite-500">
                  {match.redTeams.join(" ")} vs {match.blueTeams.join(" ")}
                </span>
                <span className="stat shrink-0 text-xs text-graphite-500">
                  {queueTimeLabel(match)}
                </span>
                <span
                  className={`shrink-0 rounded px-2 py-1 text-xs font-semibold ${QUEUE_STATUS_STYLES[match.status]}`}
                >
                  {match.status}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

interface OpenTalkie {
  id: string;
  title: string;
  status: TalkieStatus;
  assigneeName: string | null;
  forTeamNumbers: string[];
  createdByName: string;
  createdAtMs: number;
}

// Only the two not-done statuses ever render here; keeps the badge palette in
// step with the Talkie board.
const OPEN_STATUS_STYLES: Record<"open" | "assigned", string> = {
  open: "bg-amber-100 text-amber-900 dark:text-amber-200",
  assigned: "bg-sky-50 text-sky-700 dark:text-sky-300",
};

/**
 * Live roll-up of every unfinished Talkie request (status ≠ done) so the pit
 * crew sees outstanding asks without leaving the dashboard. Read-only — actions
 * live on the Talkie board, one tap away via the header link.
 */
function OpenTalkieCard({ teamId }: { teamId: string }) {
  const [open, setOpen] = useState<OpenTalkie[]>([]);

  useEffect(() => {
    if (!teamId) return;
    return onSnapshot(
      query(
        collection(db, "teams", teamId, "talkie"),
        orderBy("createdAt", "desc"),
      ),
      (snapshot) =>
        setOpen(
          snapshot.docs
            .map((d) => {
              const data = d.data();
              const createdAt = data.createdAt as Timestamp | null;
              return {
                id: d.id,
                title: (data.title as string) ?? "",
                status: normalizeStatus(data.status),
                assigneeName: (data.assigneeName as string | null) ?? null,
                forTeamNumbers: (data.forTeamNumbers as string[]) ?? [],
                createdByName: (data.createdByName as string) ?? "",
                createdAtMs: createdAt ? createdAt.toMillis() : Date.now(),
              };
            })
            .filter((r) => r.status !== "done"),
        ),
    );
  }, [teamId]);

  return (
    <section className="surface-card flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="section-title">
          Open Talkie requests
          {open.length > 0 && (
            <span className="stat ml-2 text-graphite-500">({open.length})</span>
          )}
        </h2>
        <Link
          href="/talkie"
          className="text-xs font-medium text-maroon-700 transition hover:text-maroon-800 dark:text-maroon-300"
        >
          Open board →
        </Link>
      </div>

      {open.length === 0 ? (
        <p className="rounded-lg border border-dashed border-graphite-300 px-4 py-6 text-center text-sm text-graphite-400">
          Nothing outstanding — every Talkie request is done.
        </p>
      ) : (
        <ul className="divide-y divide-graphite-100">
          {open.map((request) => (
            <li key={request.id} className="flex items-center gap-3 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-graphite-800">
                  {request.title}
                </span>
                <span className="text-xs text-graphite-500">
                  {request.assigneeName
                    ? `Assigned to ${request.assigneeName}`
                    : `Unassigned · from ${request.createdByName}`}
                </span>
              </div>
              {request.forTeamNumbers.length > 0 && (
                <span className="stat shrink-0 rounded bg-graphite-100 px-2 py-1 text-xs font-semibold text-graphite-600">
                  {request.forTeamNumbers.join(" & ")}
                </span>
              )}
              <span
                className={`shrink-0 rounded px-2 py-1 text-xs font-semibold ${
                  OPEN_STATUS_STYLES[request.status as "open" | "assigned"]
                }`}
              >
                {STATUS_LABELS[request.status]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function TodoCard({ teamId }: { teamId: string }) {
  const [items, setItems] = useState<PitTodoItem[]>([]);
  const [draft, setDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) return;
    return onSnapshot(doc(db, "teams", teamId, "config", "pitTodo"), (s) => {
      setItems(s.exists() ? (s.data() as PitTodoDoc).items : []);
    });
  }, [teamId]);

  async function save(next: PitTodoItem[]): Promise<void> {
    setItems(next);
    setSaveError(null);
    try {
      await setDoc(doc(db, "teams", teamId, "config", "pitTodo"), {
        items: next,
        updatedAt: Date.now(),
      } satisfies PitTodoDoc);
    } catch {
      setSaveError("Could not save the list — check your connection.");
    }
  }

  function addItem(): void {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void save([...items, { id: crypto.randomUUID(), text, done: false }]);
  }

  return (
    <section className="surface-card flex flex-col gap-3 p-5">
      <h2 className="section-title">Pit to-do list</h2>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          addItem();
        }}
        className="flex items-center gap-2"
      >
        <input
          type="text"
          placeholder="e.g. Swap intake belts before Q34"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="field-input flex-1"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="btn-primary px-4 py-2"
        >
          Add
        </button>
      </form>

      {saveError && (
        <p className="badge-error rounded-md px-3 py-2 text-sm normal-case tracking-normal">
          {saveError}
        </p>
      )}

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-graphite-300 px-4 py-6 text-center text-sm text-graphite-400">
          Nothing on the list — add tasks for the pit crew above.
        </p>
      ) : (
        <ul className="divide-y divide-graphite-100">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 py-2">
              <input
                type="checkbox"
                checked={item.done}
                onChange={() =>
                  void save(
                    items.map((i) =>
                      i.id === item.id ? { ...i, done: !i.done } : i,
                    ),
                  )
                }
                className="h-4 w-4 accent-maroon-600"
              />
              <span
                className={`flex-1 text-sm ${
                  item.done
                    ? "text-graphite-400 line-through"
                    : "text-graphite-800"
                }`}
              >
                {item.text}
              </span>
              <button
                type="button"
                aria-label={`Remove "${item.text}"`}
                onClick={() =>
                  void save(items.filter((i) => i.id !== item.id))
                }
                className="rounded px-2 py-1 text-xs font-medium text-graphite-400 transition hover:bg-maroon-50 hover:text-maroon-700 dark:hover:text-maroon-300"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
