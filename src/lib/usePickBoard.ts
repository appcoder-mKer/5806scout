"use client";

import { useReliabilityFlags } from "@/components/ReliabilityFlags";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  aggregateByTeam,
  type MatchSubmission,
  type TeamAggregate,
} from "@/lib/aggregate";
import { normalizeSlots, takenTeams, type AllianceBoardDoc } from "@/lib/alliances";
import { buildTeamProfiles, SCORING_WEIGHTS } from "@/lib/drive";
import type { EventData } from "@/lib/eventData";
import { db } from "@/lib/firebase/client";
import {
  moveToDoNotPick,
  reconcileOrder,
  restoreFromDoNotPick,
  splitDoNotPick,
  toggleStruck,
  type PicklistDoc,
} from "@/lib/picklist";
import { buildPickMetrics, buildTeamPickStats } from "@/lib/pickScore";
import { useScoutForms } from "@/lib/useScoutForms";
import { collection, doc, onSnapshot, setDoc } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";

// Everything the weighted picklist, the hero, and the alliance lab read, in
// one subscription set — the Picklist page and the admin dashboard both mount
// it, so the two can never disagree about a team.
//
// Marks are durable and shared: "Taken" is PicklistDoc.struck (the field the
// old Struck toggle wrote, kept for exactly this) and DNP is the admin's own
// Do Not Pick list, so a mark made on one laptop during alliance selection is
// on every other screen a moment later and survives a reload. Teams already
// placed on the alliance board count as taken too.

export function usePickBoard() {
  const { profile, team, dataTeamId } = useAuth();
  const { matchSections } = useScoutForms();
  const flags = useReliabilityFlags();
  const [event, setEvent] = useState<EventData | null>(null);
  const [picklist, setPicklist] = useState<PicklistDoc | null>(null);
  const [board, setBoard] = useState<AllianceBoardDoc | null>(null);
  const [submissions, setSubmissions] = useState<MatchSubmission[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile || !dataTeamId) return;
    // Same split as the Picklist page: event and scouting from the shared
    // store, the picklist and board from our own team doc.
    const unsubs = [
      onSnapshot(doc(db, "teams", dataTeamId, "config", "event"), (s) => {
        setEvent(s.exists() ? (s.data() as EventData) : null);
        setLoaded(true);
      }),
      onSnapshot(doc(db, "teams", profile.teamId, "config", "picklist"), (s) =>
        setPicklist(s.exists() ? (s.data() as PicklistDoc) : null),
      ),
      onSnapshot(doc(db, "teams", profile.teamId, "config", "alliances"), (s) =>
        setBoard(s.exists() ? (s.data() as AllianceBoardDoc) : null),
      ),
      onSnapshot(collection(db, "teams", dataTeamId, "matchScouting"), (snapshot) =>
        setSubmissions(
          snapshot.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              matchNumber: data.matchNumber as number,
              scoutedTeam: data.scoutedTeam as string,
              alliance: data.alliance as "red" | "blue",
              values: data.values ?? {},
              scoutName: (data.scoutName as string) ?? "",
            };
          }),
        ),
      ),
    ];
    return () => unsubs.forEach((unsub) => unsub());
  }, [profile, dataTeamId]);

  const eventTeams = useMemo(() => event?.teams ?? [], [event]);
  const aggregateList = useMemo(
    () => aggregateByTeam(matchSections, submissions),
    [matchSections, submissions],
  );
  const aggregates = useMemo(() => {
    const byTeam = new Map<string, TeamAggregate>();
    for (const agg of aggregateList) byTeam.set(agg.team, agg);
    return byTeam;
  }, [aggregateList]);
  const profiles = useMemo(
    () => buildTeamProfiles(matchSections, aggregateList, SCORING_WEIGHTS, eventTeams),
    [matchSections, aggregateList, eventTeams],
  );
  const metrics = useMemo(
    () => buildPickMetrics(matchSections, SCORING_WEIGHTS),
    [matchSections],
  );
  const stats = useMemo(
    () =>
      buildTeamPickStats(
        matchSections,
        submissions,
        aggregates,
        profiles,
        flags,
        eventTeams,
        SCORING_WEIGHTS,
      ),
    [matchSections, submissions, aggregates, profiles, flags, eventTeams],
  );

  const { order, doNotPick } = useMemo(
    () =>
      splitDoNotPick(
        reconcileOrder(picklist?.order ?? [], eventTeams),
        picklist?.doNotPick ?? [],
      ),
    [picklist, eventTeams],
  );
  const struck = useMemo(() => picklist?.struck ?? [], [picklist]);
  const onBoard = useMemo(() => takenTeams(normalizeSlots(board?.slots)), [board]);
  const taken = useMemo(() => new Set([...struck, ...onBoard]), [struck, onBoard]);

  const ourTeam = team?.teamNumber ? Number(team.teamNumber) : null;

  async function write(patch: Partial<PicklistDoc>, failure: string) {
    if (!profile) return;
    setSaveError(null);
    try {
      // Merge: notes, columns and the ranking share this doc and are written
      // by other screens — a mark must never replace them.
      await setDoc(
        doc(db, "teams", profile.teamId, "config", "picklist"),
        { ...patch, updatedAt: Date.now() },
        { merge: true },
      );
    } catch {
      setSaveError(failure);
    }
  }

  function toggleTaken(teamNumber: number) {
    void write(
      { struck: toggleStruck(struck, teamNumber) },
      "Could not save that mark — check your connection.",
    );
  }

  function toggleDoNotPick(teamNumber: number) {
    const next = doNotPick.includes(teamNumber)
      ? restoreFromDoNotPick(order, doNotPick, teamNumber)
      : moveToDoNotPick(order, doNotPick, teamNumber);
    void write(next, "Could not save that mark — check your connection.");
  }

  function clearTaken() {
    void write({ struck: [] }, "Could not clear the marks — check your connection.");
  }

  return {
    loaded,
    event,
    submissions,
    metrics,
    stats,
    ourTeam,
    doNotPick,
    struck,
    onBoard,
    taken,
    saveError,
    isAdmin: profile?.role === "admin",
    toggleTaken,
    toggleDoNotPick,
    clearTaken,
  };
}

export type PickBoardData = ReturnType<typeof usePickBoard>;
