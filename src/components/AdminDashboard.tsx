"use client";

import { useAuth } from "@/lib/auth/AuthProvider";
import type {
  MatchAssignmentsDoc,
  PitAssignmentsDoc,
} from "@/lib/assignments";
import {
  buildScoutStatuses,
  formatQuiet,
  needsAttention,
  type ScoutState,
  type ScoutStatus,
} from "@/lib/dashboard";
import type { EventData, EventMatch } from "@/lib/eventData";
import { liveEventKey } from "@/lib/manualEvent";
import { db } from "@/lib/firebase/client";
import {
  DUTY_LABELS,
  sanitizeScoutDutiesDoc,
  SCOUT_DUTIES_DOC_ID,
  type ScoutDutiesDoc,
} from "@/lib/scoutDuty";
import { showsInRoster } from "@/lib/emailVerification";
import { normalizeStatus } from "@/lib/talkie";
import type { UserProfile } from "@/lib/types";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

// The admin's two questions at an event, answered without leaving the page:
// what work is sitting unclaimed, and is anyone falling behind.

const LIVE_REFRESH_MS = 60_000;

/**
 * How many recent match submissions to watch for the "last seen" clock. A
 * scout whose newest submission is older than this window is, by definition,
 * far enough behind the crew that flagging them as stalled is the right call
 * — so the cap can't produce a false "on track".
 */
const RECENT_SUBMISSION_LIMIT = 300;

const STATE_BADGE: Record<ScoutState, string> = {
  behind: "badge-error",
  stalled: "badge-warning",
  ontrack: "badge-success",
  clear: "badge-success",
  idle: "",
};

const STATE_LABEL: Record<ScoutState, string> = {
  behind: "behind",
  stalled: "quiet",
  ontrack: "on track",
  clear: "all done",
  idle: "unassigned",
};

interface UnassignedTalkie {
  id: string;
  title: string;
  details: string;
  createdByName: string;
  createdAtMs: number;
}

/** Roster for both teams of a sister pair, which pool their scouts. */
function useCrew(): { roster: UserProfile[]; failed: boolean } {
  const { profile, team } = useAuth();
  const [roster, setRoster] = useState<UserProfile[]>([]);
  // Keyed by team rather than a plain boolean, so switching team clears the
  // warning as a derived value instead of a reset written from the effect.
  const [failedFor, setFailedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!profile) return;
    const teamIds = [profile.teamId, team?.sisterTeamId].filter(
      (id): id is string => !!id,
    );
    const byTeam = new Map<string, UserProfile[]>();
    const unsubs = teamIds.map((teamId) =>
      onSnapshot(
        query(collection(db, "users"), where("teamId", "==", teamId)),
        (snapshot) => {
          byTeam.set(
            teamId,
            snapshot.docs
              .map((d) => {
                const data = d.data();
                return {
                  uid: d.id,
                  email: (data.email as string) ?? "",
                  fullName: (data.fullName as string) ?? "",
                  teamId: (data.teamId as string) ?? "",
                  role: (data.role as UserProfile["role"]) ?? "scout",
                  active: (data.active as boolean) ?? true,
                  emailVerified: data.emailVerified as boolean | undefined,
                };
              })
              .filter(showsInRoster),
          );
          setRoster(
            [...byTeam.values()]
              .flat()
              .filter((member) => member.active)
              .sort((a, b) => a.fullName.localeCompare(b.fullName)),
          );
        },
        // A half-loaded roster silently shortens the crew list, which reads
        // as "fewer people to chase" rather than as a failure.
        () => setFailedFor(profile.teamId),
      ),
    );
    return () => unsubs.forEach((unsub) => unsub());
  }, [profile, team?.sisterTeamId]);

  return {
    roster,
    failed: failedFor !== null && failedFor === profile?.teamId,
  };
}

function UnassignedTalkies({ roster }: { roster: UserProfile[] }) {
  const { dataTeamId } = useAuth();
  const [talkies, setTalkies] = useState<UnassignedTalkie[]>([]);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!dataTeamId) return;
    // Whole board, filtered client-side: legacy docs predate assigneeUid and
    // wouldn't match an equality query on null.
    return onSnapshot(
      query(
        collection(db, "teams", dataTeamId, "talkie"),
        orderBy("createdAt", "desc"),
      ),
      (snapshot) =>
        setTalkies(
          snapshot.docs
            .filter((d) => {
              const data = d.data();
              return (
                !data.assigneeUid && normalizeStatus(data.status) !== "done"
              );
            })
            .map((d) => {
              const data = d.data();
              const createdAt = data.createdAt as Timestamp | null;
              return {
                id: d.id,
                title: (data.title as string) ?? "",
                details: (data.details as string) ?? "",
                createdByName: (data.createdByName as string) ?? "",
                createdAtMs: createdAt ? createdAt.toMillis() : Date.now(),
              };
            }),
        ),
      () => setLoadError(true),
    );
  }, [dataTeamId]);

  async function assign(id: string, uid: string) {
    if (!dataTeamId) return;
    const member = roster.find((m) => m.uid === uid);
    if (!member) return;
    try {
      await updateDoc(doc(db, "teams", dataTeamId, "talkie", id), {
        assigneeUid: member.uid,
        assigneeName: member.fullName,
        // false so the assigned scout gets the banner AssignmentNotifications
        // raises until they open or dismiss it.
        assigneeSeen: false,
        status: "assigned",
        doneByUser: false,
        updatedAt: serverTimestamp(),
      });
    } catch {
      // The row stays in the list if the write fails — try again.
    }
  }

  return (
    <section className="surface-card flex flex-col gap-3 p-4">
      <h2 className="flex items-baseline justify-between gap-2">
        <span className="section-title">Unassigned talkies</span>
        <span className="stat text-xs text-graphite-500">{talkies.length}</span>
      </h2>

      {loadError ? (
        <p className="badge-error rounded-md px-3 py-2 text-sm normal-case tracking-normal">
          Couldn&apos;t load the talkie board — this list may be incomplete.
        </p>
      ) : talkies.length === 0 ? (
        <p className="text-sm text-graphite-500">
          Every request has someone on it.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-graphite-100">
          {talkies.map((talkie) => (
            <li
              key={talkie.id}
              className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0"
            >
              <div>
                <p className="text-sm font-medium text-graphite-900">
                  {talkie.title}
                </p>
                {talkie.details && (
                  <p className="line-clamp-2 text-xs text-graphite-500">
                    {talkie.details}
                  </p>
                )}
                <p className="text-xs text-graphite-400">
                  from {talkie.createdByName || "a teammate"}
                </p>
              </div>
              <label className="flex items-center gap-2">
                <span className="sr-only">Assign “{talkie.title}” to</span>
                <select
                  className="field-input py-1.5 text-xs"
                  value=""
                  onChange={(e) => void assign(talkie.id, e.target.value)}
                >
                  <option value="">Assign to…</option>
                  {roster.map((member) => (
                    <option key={member.uid} value={member.uid}>
                      {member.fullName}
                    </option>
                  ))}
                </select>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function StatusRow({ status }: { status: ScoutStatus }) {
  const detail =
    status.state === "behind"
      ? `${status.behindCount} played ${status.behindCount === 1 ? "match" : "matches"} not logged`
      : status.state === "stalled"
        ? `nothing submitted in ${formatQuiet(status.quietForMs)}`
        : status.state === "idle"
          ? "no assignments"
          : `${status.remaining} of ${status.assigned} left`;

  return (
    <li className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-graphite-900">
          {status.name}
        </p>
        <p className="text-xs text-graphite-500">
          {DUTY_LABELS[status.duty]} · {detail}
        </p>
      </div>
      <span className={`badge ${STATE_BADGE[status.state]} shrink-0`}>
        {STATE_LABEL[status.state]}
      </span>
    </li>
  );
}

function CrewStatus({
  roster,
  rosterFailed,
}: {
  roster: UserProfile[];
  rosterFailed: boolean;
}) {
  const { dataTeamId } = useAuth();
  const [duties, setDuties] = useState<ScoutDutiesDoc | null>(null);
  const [pitDoc, setPitDoc] = useState<PitAssignmentsDoc | null>(null);
  const [matchDoc, setMatchDoc] = useState<MatchAssignmentsDoc | null>(null);
  const [event, setEvent] = useState<EventData | null>(null);
  const [liveMatches, setLiveMatches] = useState<EventMatch[]>([]);
  const [lastByUid, setLastByUid] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  // A failed read must never read as good news: with matchAssignments missing
  // every scout computes as unassigned, nobody needs chasing, and the panel
  // would cheerfully say "Everyone is keeping up" — the precise false
  // negative this section exists to prevent.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const loadFailed = failedFor !== null && failedFor === dataTeamId;

  useEffect(() => {
    if (!dataTeamId) return;
    const teamId = dataTeamId;
    const fail = () => setFailedFor(teamId);
    const unsubs = [
      onSnapshot(
        doc(db, "teams", teamId, "config", SCOUT_DUTIES_DOC_ID),
        (s) => setDuties(sanitizeScoutDutiesDoc(s.data())),
        fail,
      ),
      onSnapshot(
        doc(db, "teams", teamId, "config", "pitAssignments"),
        (s) => setPitDoc(s.exists() ? (s.data() as PitAssignmentsDoc) : null),
        fail,
      ),
      onSnapshot(
        doc(db, "teams", teamId, "config", "matchAssignments"),
        (s) =>
          setMatchDoc(s.exists() ? (s.data() as MatchAssignmentsDoc) : null),
        fail,
      ),
      onSnapshot(
        doc(db, "teams", teamId, "config", "event"),
        (s) => setEvent(s.exists() ? (s.data() as EventData) : null),
        fail,
      ),
    ];
    return () => unsubs.forEach((unsub) => unsub());
  }, [dataTeamId]);

  // Last submission per scout, pooled from both forms. Pit docs are one per
  // robot (a few dozen); match submissions are capped at the most recent few
  // hundred, which is deep enough that anyone outside the window is stalled.
  useEffect(() => {
    if (!dataTeamId) return;
    const teamId = dataTeamId;
    const byCollection = new Map<string, Record<string, number>>();

    function merge(name: string, entries: Record<string, number>) {
      byCollection.set(name, entries);
      const combined: Record<string, number> = {};
      for (const group of byCollection.values()) {
        for (const [uid, ms] of Object.entries(group)) {
          combined[uid] = Math.max(combined[uid] ?? 0, ms);
        }
      }
      setLastByUid(combined);
    }

    function collect(
      docs: Array<{ data(): Record<string, unknown> }>,
      field: string,
    ): Record<string, number> {
      const entries: Record<string, number> = {};
      for (const d of docs) {
        const data = d.data();
        const uid = data.scoutUid as string | undefined;
        const stamp = data[field] as Timestamp | null | undefined;
        // serverTimestamp() reads back null until the write is acked; an
        // in-flight submission just isn't counted yet.
        if (!uid || !stamp) continue;
        entries[uid] = Math.max(entries[uid] ?? 0, stamp.toMillis());
      }
      return entries;
    }

    const fail = () => setFailedFor(teamId);
    const unsubs = [
      onSnapshot(
        collection(db, "teams", teamId, "pitScouting"),
        (snapshot) => merge("pit", collect(snapshot.docs, "updatedAt")),
        fail,
      ),
      onSnapshot(
        query(
          collection(db, "teams", teamId, "matchScouting"),
          orderBy("createdAt", "desc"),
          limit(RECENT_SUBMISSION_LIMIT),
        ),
        (snapshot) => merge("match", collect(snapshot.docs, "createdAt")),
        fail,
      ),
    ];
    return () => unsubs.forEach((unsub) => unsub());
  }, [dataTeamId]);

  // Poll TBA for which matches have actually been played — the synced event
  // doc's scores go stale the moment the event moves on.
  const eventKey = liveEventKey(event);
  useEffect(() => {
    if (!eventKey) return;
    let cancelled = false;

    async function load(key: string) {
      try {
        const res = await fetch(`/api/event/${encodeURIComponent(key)}/live`);
        const body = (await res.json()) as { matches?: EventMatch[] };
        if (!cancelled && res.ok && body.matches) setLiveMatches(body.matches);
      } catch {
        // Fall back to the synced doc below; this view is best-effort.
      }
    }

    void load(eventKey);
    const timer = setInterval(() => void load(eventKey), LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [eventKey]);

  // The stalled clock has to advance on its own — nothing else re-renders
  // this when a scout simply stops submitting.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const statuses = useMemo(
    () =>
      buildScoutStatuses(
        roster.map((member) => ({
          uid: member.uid,
          name: member.fullName,
          role: member.role,
        })),
        duties?.duties ?? {},
        pitDoc,
        matchDoc,
        liveMatches.length > 0 ? liveMatches : (event?.matches ?? []),
        lastByUid,
        now,
      ),
    [roster, duties, pitDoc, matchDoc, liveMatches, event, lastByUid, now],
  );

  const chasing = needsAttention(statuses);
  const incomplete = loadFailed || rosterFailed;

  return (
    <section className="surface-card flex flex-col gap-3 p-4">
      <h2 className="flex items-baseline justify-between gap-2">
        <span className="section-title">Crew status</span>
        {!incomplete && (
          <span className="stat text-xs text-graphite-500">
            {chasing.length} of {statuses.length} need chasing
          </span>
        )}
      </h2>

      {incomplete ? (
        <p className="badge-error rounded-md px-3 py-2 text-sm normal-case tracking-normal">
          Couldn&apos;t load assignments or submissions, so this list is
          incomplete — don&apos;t read it as everyone being on track.
        </p>
      ) : statuses.length === 0 ? (
        <p className="text-sm text-graphite-500">
          Nobody is in a scouting rotation yet — set duties on the{" "}
          <Link href="/team" className="underline">
            Team tab
          </Link>
          .
        </p>
      ) : (
        <>
          {chasing.length === 0 && (
            <p className="text-sm text-graphite-500">
              Everyone is keeping up.
            </p>
          )}
          <ul className="flex flex-col divide-y divide-graphite-100">
            {statuses.map((status) => (
              <StatusRow key={status.uid} status={status} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function AdminDashboard() {
  const { profile } = useAuth();
  const { roster, failed: rosterFailed } = useCrew();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="page-title">
          <span aria-hidden className="page-rule" />
          {profile ? `Hey, ${profile.fullName.split(" ")[0]}` : "Command"}
        </h1>
        <p className="page-lede">
          What needs handing out, and who needs chasing.
        </p>
      </div>

      <UnassignedTalkies roster={roster} />
      <CrewStatus roster={roster} rosterFailed={rosterFailed} />
    </div>
  );
}
