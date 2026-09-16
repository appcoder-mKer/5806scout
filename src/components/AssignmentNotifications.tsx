"use client";

import { useAuth } from "@/lib/auth/AuthProvider";
import {
  upcomingSlots,
  type MatchAssignmentsDoc,
  type MatchSlot,
} from "@/lib/assignments";
import type { EventData, EventMatch } from "@/lib/eventData";
import { liveEventKey } from "@/lib/manualEvent";
import { db } from "@/lib/firebase/client";
import { COMP_LEVEL_LABELS } from "@/lib/pitDashboard";
import {
  collection,
  doc,
  onSnapshot,
  query,
  updateDoc,
  where,
} from "firebase/firestore";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const LIVE_REFRESH_MS = 60_000;

interface PendingAssignment {
  id: string;
  title: string;
  createdByName: string;
}

interface PendingConfirmation {
  id: string;
  title: string;
  markedByName: string;
}

// Dashboard-wide banners, both driven by seen-flags on talkie request docs
// (equality-only queries — no composite index needed):
// - assigneeSeen=false → the assigned scout sees "new assignment" here on
//   every page until they dismiss it or open the request.
// - adminConfirmSeen=false → a scout gave their done sign-off; every admin
//   sees "ready for your sign-off" until confirmed or dismissed.
export function AssignmentNotifications() {
  const { profile, user, dataTeamId } = useAuth();
  const [pending, setPending] = useState<PendingAssignment[]>([]);
  const [confirmations, setConfirmations] = useState<PendingConfirmation[]>([]);
  const [matchDoc, setMatchDoc] = useState<MatchAssignmentsDoc | null>(null);
  const [eventKey, setEventKey] = useState<string | null>(null);
  const [liveMatches, setLiveMatches] = useState<EventMatch[]>([]);
  // Locally dismissed "match up" banners, keyed by match key — a live status
  // rather than a persisted notification, so no Firestore write needed.
  const [dismissedMatches, setDismissedMatches] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    if (!dataTeamId || !user) return;
    return onSnapshot(
      query(
        collection(db, "teams", dataTeamId, "talkie"),
        where("assigneeUid", "==", user.uid),
        where("assigneeSeen", "==", false),
      ),
      (snapshot) =>
        setPending(
          snapshot.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              title: (data.title as string) ?? "",
              createdByName: (data.createdByName as string) ?? "",
            };
          }),
        ),
    );
  }, [dataTeamId, user]);

  useEffect(() => {
    if (!profile || !dataTeamId || profile.role !== "admin") return;
    return onSnapshot(
      query(
        collection(db, "teams", dataTeamId, "talkie"),
        where("doneByUser", "==", true),
        where("doneByAdmin", "==", false),
        where("adminConfirmSeen", "==", false),
      ),
      (snapshot) =>
        setConfirmations(
          snapshot.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              title: (data.title as string) ?? "",
              markedByName:
                (data.assigneeName as string | null) ??
                (data.createdByName as string) ??
                "A scout",
            };
          }),
        ),
    );
  }, [profile, dataTeamId]);

  // Match-scouting "you're up" banner: needs the assignment doc, the synced
  // event key, and a live view of which matches have been played.
  useEffect(() => {
    if (!dataTeamId) return;
    const teamId = dataTeamId;
    const unsubMatch = onSnapshot(
      doc(db, "teams", teamId, "config", "matchAssignments"),
      (s) => setMatchDoc(s.exists() ? (s.data() as MatchAssignmentsDoc) : null),
    );
    const unsubEvent = onSnapshot(doc(db, "teams", teamId, "config", "event"), (s) =>
      // liveEventKey, not eventKey: a manual event has no TBA page to poll.
      setEventKey(s.exists() ? liveEventKey(s.data() as EventData) : null),
    );
    return () => {
      unsubMatch();
      unsubEvent();
    };
  }, [dataTeamId]);

  useEffect(() => {
    // Only poll TBA while this user actually has match assignments.
    if (!eventKey || !user || !matchDoc?.slots.some((s) => s.uid === user.uid)) {
      return;
    }
    let cancelled = false;

    async function load(key: string) {
      try {
        const res = await fetch(`/api/event/${encodeURIComponent(key)}/live`);
        const body = (await res.json()) as { matches?: EventMatch[] };
        if (!cancelled && res.ok && body.matches) setLiveMatches(body.matches);
      } catch {
        // Keep the last known matches; the banner is best-effort.
      }
    }

    void load(eventKey);
    const timer = setInterval(() => void load(eventKey), LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [eventKey, user, matchDoc]);

  const myUpcoming = useMemo(() => {
    if (!user || !matchDoc || liveMatches.length === 0) return [];
    return upcomingSlots(matchDoc.slots, liveMatches, user.uid).filter(
      ({ slot }) => !dismissedMatches.has(slot.matchKey),
    );
  }, [user, matchDoc, liveMatches, dismissedMatches]);

  async function dismiss(id: string, field: "assigneeSeen" | "adminConfirmSeen") {
    if (!dataTeamId) return;
    try {
      await updateDoc(doc(db, "teams", dataTeamId, "talkie", id), {
        [field]: true,
      });
    } catch {
      // Banner stays if the write fails — the user can retry.
    }
  }

  if (
    pending.length === 0 &&
    confirmations.length === 0 &&
    myUpcoming.length === 0
  ) {
    return null;
  }

  function slotLabel(slot: MatchSlot): string {
    return `${COMP_LEVEL_LABELS[slot.compLevel] ?? slot.compLevel}${slot.matchNumber}`;
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-2 px-4 pt-3 md:px-6">
      {myUpcoming.map(({ slot, position }) => (
        <div
          key={`${slot.matchKey}-${slot.teamNumber}`}
          role="status"
          className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-4 py-2.5 ${
            position === 0
              ? "border-red-300 bg-red-50"
              : "border-green-200 dark:border-green-900 bg-green-100/50"
          }`}
        >
          <p
            className={`text-sm ${position === 0 ? "text-red-900" : "text-green-900"}`}
          >
            <span className="font-semibold">
              {position === 0
                ? `Your scouting match ${slotLabel(slot)} is up now:`
                : `You're up next in ${slotLabel(slot)}:`}
            </span>{" "}
            scout team <span className="stat font-semibold">{slot.teamNumber}</span>{" "}
            ({slot.alliance} alliance).
          </p>
          <span className="flex items-center gap-2">
            <Link
              href="/match-scout"
              className="rounded-md bg-maroon-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-maroon-700"
            >
              Open Match Scout
            </Link>
            <button
              type="button"
              onClick={() =>
                setDismissedMatches((prev) => new Set(prev).add(slot.matchKey))
              }
              className="btn-ghost border border-graphite-200 px-3 py-1"
            >
              Dismiss
            </button>
          </span>
        </div>
      ))}
      {pending.map((assignment) => (
        <div
          key={assignment.id}
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-sky-200 bg-sky-50 px-4 py-2.5"
        >
          <p className="text-sm text-sky-900">
            <span className="font-semibold">New talkie assignment:</span>{" "}
            {assignment.title}
            {assignment.createdByName && (
              <span className="text-sky-700 dark:text-sky-300"> — from {assignment.createdByName}</span>
            )}
          </p>
          <span className="flex items-center gap-2">
            <Link
              href="/talkie"
              onClick={() => void dismiss(assignment.id, "assigneeSeen")}
              className="rounded-md bg-sky-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-sky-700"
            >
              View
            </Link>
            <button
              type="button"
              onClick={() => void dismiss(assignment.id, "assigneeSeen")}
              className="rounded-md border border-sky-200 px-3 py-1 text-xs font-medium text-sky-700 dark:text-sky-300 transition hover:border-sky-300"
            >
              Dismiss
            </button>
          </span>
        </div>
      ))}
      {confirmations.map((confirmation) => (
        <div
          key={confirmation.id}
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5"
        >
          <p className="text-sm text-amber-900 dark:text-amber-200">
            <span className="font-semibold">Ready for your sign-off:</span>{" "}
            {confirmation.title}
            <span className="text-amber-700">
              {" "}
              — {confirmation.markedByName} marked it done
            </span>
          </p>
          <span className="flex items-center gap-2">
            <Link
              href="/talkie"
              onClick={() => void dismiss(confirmation.id, "adminConfirmSeen")}
              className="rounded-md bg-amber-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-amber-700"
            >
              View
            </Link>
            <button
              type="button"
              onClick={() => void dismiss(confirmation.id, "adminConfirmSeen")}
              className="rounded-md border border-amber-200 px-3 py-1 text-xs font-medium text-amber-700 transition hover:border-amber-300"
            >
              Dismiss
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}
