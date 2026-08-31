"use client";

import { AllianceBoard } from "@/components/AllianceBoard";
import { PicklistTable } from "@/components/PicklistTable";
import { type Sort } from "@/components/SortableTh";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  aggregateByTeam,
  counterFieldIds,
  type MatchSubmission,
  type TeamAggregate,
} from "@/lib/aggregate";
import {
  allianceStrengths,
  assignSlot,
  boardOdds,
  emptySlots,
  normalizeSlots,
  type AllianceBoardDoc,
  type AllianceSlots,
} from "@/lib/alliances";
import { buildTeamProfiles, SCORING_WEIGHTS } from "@/lib/drive";
import type { EventData, EventRankingRow, EventTeam } from "@/lib/eventData";
import { db } from "@/lib/firebase/client";
import { useScoutForms } from "@/lib/useScoutForms";
import {
  moveItem,
  moveToDoNotPick,
  reconcileOrder,
  restoreFromDoNotPick,
  setRank,
  splitDoNotPick,
  type PicklistDoc,
} from "@/lib/picklist";
import {
  comparePicklistRows,
  resolvePicklistColumns,
  sanitizePicklistColumnIds,
  type PicklistRow,
} from "@/lib/picklistColumns";
import { collection, doc, onSnapshot, setDoc } from "firebase/firestore";
import { useCallback, useEffect, useMemo, useState } from "react";

function phaseAvg(agg: TeamAggregate | undefined, ids: string[]): number | null {
  if (!agg) return null;
  return ids.reduce((sum, id) => sum + (agg.averages[id] ?? 0), 0);
}

type View = "picklist" | "alliances" | "simulation";

const VIEW_LABELS: Record<View, string> = {
  picklist: "Picklist",
  alliances: "Alliance Selection",
  simulation: "Simulation",
};

export default function PicklistPage() {
  const { profile, dataTeamId } = useAuth();
  // Stats follow this team's customized schema, not the static defaults.
  const { matchSections } = useScoutForms();
  const [view, setView] = useState<View>("picklist");
  const [event, setEvent] = useState<EventData | null>(null);
  const [picklist, setPicklist] = useState<PicklistDoc | null>(null);
  const [board, setBoard] = useState<AllianceBoardDoc | null>(null);
  const [submissions, setSubmissions] = useState<MatchSubmission[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [eventRanks, setEventRanks] = useState<Map<number, number>>(new Map());
  // Which criteria column the table is ordered by. Deliberately component
  // state, not persisted: a sort is a lens for comparing teams, while the
  // ranking below it is the record. Clearing it returns to My Rank order.
  const [sort, setSort] = useState<Sort | null>(null);

  useEffect(() => {
    if (!profile || !dataTeamId) return;
    // Event + scouting data come from the shared store; the picklist itself
    // is the one thing a sister pair does NOT share — it stays on our own
    // team doc (and rules block the sister team from ever reading it).
    const unsubEvent = onSnapshot(
      doc(db, "teams", dataTeamId, "config", "event"),
      (s) => {
        setEvent(s.exists() ? (s.data() as EventData) : null);
        setLoaded(true);
      },
    );
    const unsubPicklist = onSnapshot(
      doc(db, "teams", profile.teamId, "config", "picklist"),
      (s) => setPicklist(s.exists() ? (s.data() as PicklistDoc) : null),
    );
    // The alliance board tracks what actually happens on the field, so it
    // lives beside the picklist and everyone on the team watches it fill in.
    const unsubBoard = onSnapshot(
      doc(db, "teams", profile.teamId, "config", "alliances"),
      (s) => setBoard(s.exists() ? (s.data() as AllianceBoardDoc) : null),
    );
    const unsubScouting = onSnapshot(
      collection(db, "teams", dataTeamId, "matchScouting"),
      (snapshot) =>
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
    );
    return () => {
      unsubEvent();
      unsubPicklist();
      unsubBoard();
      unsubScouting();
    };
  }, [profile, dataTeamId]);

  // Official qual ranks (Statbotics via the rankings route), refreshed every
  // minute like the Event tab's Ranking view. Missing data just renders "—".
  useEffect(() => {
    const eventKey = event?.eventKey;
    if (!eventKey) return;
    let cancelled = false;

    async function load(key: string) {
      try {
        const res = await fetch(`/api/event/${encodeURIComponent(key)}/rankings`);
        const body = (await res.json()) as { rankings?: EventRankingRow[] };
        if (cancelled || !res.ok || !body.rankings) return;
        setEventRanks(
          new Map(
            body.rankings
              .filter((r) => r.rank !== null)
              .map((r) => [r.teamNumber, r.rank as number]),
          ),
        );
      } catch {
        // Keep the last known ranks; the column is informational.
      }
    }

    void load(eventKey);
    const timer = setInterval(() => void load(eventKey), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [event?.eventKey]);

  const { order, doNotPick } = useMemo(() => {
    if (!event) return { order: [], doNotPick: [] };
    return splitDoNotPick(
      reconcileOrder(picklist?.order ?? [], event.teams),
      picklist?.doNotPick ?? [],
    );
  }, [event, picklist]);
  // Nothing sets or shows this any more — the Struck toggle is gone — but a
  // saved picklist still carries the field, so it rides along on every write
  // rather than being quietly dropped.
  const struck = useMemo(() => picklist?.struck ?? [], [picklist]);
  const notes = useMemo(() => picklist?.notes ?? {}, [picklist]);

  const teamsByNumber = useMemo(
    () => new Map((event?.teams ?? []).map((t) => [t.teamNumber, t])),
    [event],
  );
  const aggregateList = useMemo(
    () => aggregateByTeam(matchSections, submissions),
    [matchSections, submissions],
  );
  const aggregates = useMemo(() => {
    const byTeam = new Map<string, TeamAggregate>();
    for (const agg of aggregateList) byTeam.set(agg.team, agg);
    return byTeam;
  }, [aggregateList]);

  // Same points-per-match figures the Drive Dash predicts matches with, so an
  // alliance's odds and a match prediction never disagree about a team.
  const profiles = useMemo(
    () =>
      buildTeamProfiles(
        matchSections,
        aggregateList,
        SCORING_WEIGHTS,
        event?.teams ?? [],
      ),
    [matchSections, aggregateList, event],
  );

  // Reference stat columns: total scored per phase keeps the table readable —
  // the Data tab has the full per-goal breakdown.
  const autoIds = useMemo(
    () =>
      counterFieldIds(matchSections).filter((id) => id.startsWith("autoScored")),
    [matchSections],
  );
  const teleopIds = useMemo(
    () =>
      counterFieldIds(matchSections).filter((id) =>
        id.startsWith("teleopScored"),
      ),
    [matchSections],
  );

  // Which columns to show, chosen in Settings -> Picklist and stored on the
  // picklist doc. The metric columns are resolved against the team's live
  // Match Scout schema, so a question deleted in Form Setup takes its column
  // with it and one added becomes available with no rebuild.
  const columns = useMemo(
    () =>
      resolvePicklistColumns(
        matchSections,
        sanitizePicklistColumnIds(picklist?.columns),
      ),
    [matchSections, picklist],
  );
  // Do Not Pick teams are out of the ranking, so they have no rank to show.
  const dnpColumns = useMemo(
    () => columns.filter((column) => column.kind !== "myRank"),
    [columns],
  );

  const makeRow = useCallback(
    (teamNumber: number, rank: number | null): PicklistRow => {
      const info = teamsByNumber.get(teamNumber);
      const agg = aggregates.get(String(teamNumber));
      return {
        teamNumber,
        rank,
        name: info?.nickname ?? null,
        eventRank: eventRanks.get(teamNumber) ?? null,
        epa: info?.epa ?? null,
        avgAuto: phaseAvg(agg, autoIds),
        avgTeleop: phaseAvg(agg, teleopIds),
        matches: agg?.matches ?? 0,
        averages: agg?.averages ?? null,
        modes: agg?.modes ?? null,
        note: notes[String(teamNumber)] ?? "",
      };
    },
    [teamsByNumber, aggregates, eventRanks, autoIds, teleopIds, notes],
  );

  // Every row carries its rank in the SAVED order, not its position on
  // screen — that's what keeps My Rank meaningful under a sort.
  const rows = useMemo(
    () => order.map((teamNumber, index) => makeRow(teamNumber, index + 1)),
    [order, makeRow],
  );
  const dnpRows = useMemo(
    () => doNotPick.map((teamNumber) => makeRow(teamNumber, null)),
    [doNotPick, makeRow],
  );

  // A sort on a column the team has since hidden falls back to rank order
  // rather than leaving the table stuck in an ordering nothing explains.
  const sortColumn = useMemo(
    () => (sort ? (columns.find((c) => c.id === sort.key) ?? null) : null),
    [sort, columns],
  );
  const displayRows = useMemo(
    () =>
      sortColumn && sort
        ? [...rows].sort(comparePicklistRows(sortColumn, sort.dir))
        : rows,
    [rows, sortColumn, sort],
  );

  const isAdmin = profile?.role === "admin";

  // Alliances can and do pick teams we ranked low or wrote off, so the board
  // draws from the whole event — the picklist order just decides what's easy
  // to find near the top of the dropdown.
  const rankedTeams = useMemo(
    () => [...order, ...doNotPick],
    [order, doNotPick],
  );
  const liveSlots = useMemo(() => normalizeSlots(board?.slots), [board]);

  async function save(
    nextOrder: number[],
    nextStruck: number[],
    nextDoNotPick: number[],
  ) {
    if (!profile) return;
    setSaveError(null);
    try {
      // Merge, not overwrite: notes live on this same doc and are written
      // separately by every scout (see saveNotes). A plain setDoc here
      // replaces the document, so one admin reordering a row would wipe every
      // note on the board. The arrays below still replace wholesale, which is
      // what a ranking edit means.
      await setDoc(
        doc(db, "teams", profile.teamId, "config", "picklist"),
        makePicklistDoc(nextOrder, nextStruck, nextDoNotPick),
        { merge: true },
      );
    } catch {
      setSaveError("Could not save the picklist — check your connection.");
    }
  }

  async function saveNotes(nextNotes: Record<string, string>) {
    if (!profile) return;
    setSaveError(null);
    try {
      // Merge, not overwrite: notes are open to every scout while the ranking
      // is the admin's, and neither write may clobber the other.
      await setDoc(
        doc(db, "teams", profile.teamId, "config", "picklist"),
        makeNotesPatch(nextNotes),
        { merge: true },
      );
    } catch {
      setSaveError("Could not save the note — check your connection.");
    }
  }

  async function saveBoard(nextSlots: (number | null)[]) {
    if (!profile) return;
    setSaveError(null);
    try {
      await setDoc(
        doc(db, "teams", profile.teamId, "config", "alliances"),
        makeBoardDoc(nextSlots),
      );
    } catch {
      setSaveError("Could not save the alliance board — check your connection.");
    }
  }

  function handleMove(from: number, to: number) {
    void save(moveItem(order, from, to), [...struck], [...doNotPick]);
  }

  // The My Rank column's only write path. It moves the team within the saved
  // order, which is the picklist itself — sorting never calls this.
  function handleRankChange(team: number, rank: number) {
    void save(setRank(order, team, rank), [...struck], [...doNotPick]);
  }

  function handleNoteChange(team: number, text: string) {
    void saveNotes({ ...notes, [String(team)]: text });
  }

  function handleDoNotPick(team: number) {
    const next = moveToDoNotPick(order, doNotPick, team);
    void save(next.order, [...struck], next.doNotPick);
  }

  function handleRestore(team: number) {
    const next = restoreFromDoNotPick(order, doNotPick, team);
    void save(next.order, [...struck], next.doNotPick);
  }

  return (
    <main className="flex w-full flex-col gap-6 px-4 py-8 md:px-6">
      <div>
        <h1 className="page-title">
          <span aria-hidden className="page-rule" />
          Picklist
        </h1>
        <p className="page-lede">
          {isAdmin
            ? "Type a My rank to move a team, or drag rows to reorder. Sort any column to compare teams — sorting is a view only and never changes My rank. Tap a team number or name to open its summary, or DNP to move one to the Do Not Pick list."
            : "Live ranking maintained by your admin — updates in real time. Sort any column to compare teams; notes are open to everyone."}
        </p>
      </div>

      {saveError && (
        <p className="badge-error rounded-md px-3 py-2 text-sm normal-case tracking-normal">
          {saveError}
        </p>
      )}

      {loaded && !event && (
        <div className="rounded-lg border border-dashed border-graphite-300 bg-graphite-50 px-6 py-12 text-center text-sm text-graphite-500">
          Sync an event on the Event tab first — the picklist ranks the teams at
          your event.
        </div>
      )}

      {event && (
        <>
          <div className="surface-card flex w-fit p-0.5">
            {(["picklist", "alliances", "simulation"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className={`rounded px-3.5 py-1.5 text-sm font-medium transition ${
                  view === v
                    ? "bg-maroon-600 text-white"
                    : "text-graphite-600 hover:text-graphite-900"
                }`}
              >
                {VIEW_LABELS[v]}
              </button>
            ))}
          </div>

          {view === "picklist" && (
            <>
              {sortColumn && (
                <p className="surface-panel flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 text-xs text-graphite-500">
                  <span>
                    Sorted by {sortColumn.label} — a view, not the ranking. My
                    rank still says where each team really sits, and{" "}
                    {isAdmin
                      ? "is still editable; drag and the ↑↓ arrows are off until you clear the sort."
                      : "is unchanged by sorting."}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSort(null)}
                    className="rounded border border-graphite-200 px-2 py-0.5 font-medium text-graphite-600 transition hover:border-graphite-300"
                  >
                    Clear sort
                  </button>
                </p>
              )}

              <div className="surface-card overflow-x-auto">
                <PicklistTable
                  columns={columns}
                  rows={displayRows}
                  sort={sort}
                  onSort={setSort}
                  isAdmin={isAdmin}
                  draggable={sortColumn === null}
                  onDropRow={handleMove}
                  onRankChange={handleRankChange}
                  onNoteChange={handleNoteChange}
                  rankCount={order.length}
                  emptyMessage="No teams to rank yet."
                  renderActions={
                    isAdmin
                      ? (row) => {
                          const index = (row.rank ?? 1) - 1;
                          return (
                            <span className="flex gap-1">
                              {/* Up and down mean "one rank", which only reads
                                  as up and down while the table is in rank
                                  order — so they stand down under a sort and
                                  My Rank takes over. */}
                              {sortColumn === null && (
                                <>
                                  <button
                                    type="button"
                                    aria-label={`Move ${row.teamNumber} up`}
                                    disabled={index === 0}
                                    onClick={() => handleMove(index, index - 1)}
                                    className="rounded border border-graphite-200 px-2 py-1 text-xs text-graphite-600 transition hover:border-graphite-300 disabled:opacity-30"
                                  >
                                    ↑
                                  </button>
                                  <button
                                    type="button"
                                    aria-label={`Move ${row.teamNumber} down`}
                                    disabled={index === order.length - 1}
                                    onClick={() => handleMove(index, index + 1)}
                                    className="rounded border border-graphite-200 px-2 py-1 text-xs text-graphite-600 transition hover:border-graphite-300 disabled:opacity-30"
                                  >
                                    ↓
                                  </button>
                                </>
                              )}
                              <button
                                type="button"
                                aria-label={`Move ${row.teamNumber} to Do Not Pick`}
                                onClick={() => handleDoNotPick(row.teamNumber)}
                                className="rounded border border-maroon-200 dark:border-maroon-700 px-2 py-1 text-xs font-medium text-maroon-700 dark:text-maroon-300 transition hover:border-maroon-400"
                                title="Move to Do Not Pick"
                              >
                                DNP
                              </button>
                            </span>
                          );
                        }
                      : undefined
                  }
                />
              </div>

              <section className="flex flex-col gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-lg font-semibold text-graphite-900">
                    <span aria-hidden className="h-4 w-1 bg-maroon-600" />
                    Do Not Pick
                  </h2>
                  <p className="mt-0.5 text-sm text-graphite-500">
                    Teams your team has decided not to pick — kept out of the
                    ranking above.
                  </p>
                </div>
                {doNotPick.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-graphite-300 bg-graphite-50 px-4 py-6 text-center text-sm text-graphite-500">
                    No teams marked Do Not Pick.
                  </p>
                ) : (
                  <div className="surface-card overflow-x-auto border-maroon-200 dark:border-maroon-700">
                    <PicklistTable
                      columns={dnpColumns}
                      rows={dnpRows}
                      sort={null}
                      isAdmin={isAdmin}
                      onNoteChange={handleNoteChange}
                      renderActions={
                        isAdmin
                          ? (row) => (
                              <button
                                type="button"
                                onClick={() => handleRestore(row.teamNumber)}
                                className="rounded border border-graphite-200 px-2.5 py-1 text-xs font-medium text-graphite-600 transition hover:border-graphite-300"
                              >
                                Restore
                              </button>
                            )
                          : undefined
                      }
                    />
                  </div>
                )}
              </section>
            </>
          )}

          {view === "alliances" && (
            <AllianceSelectionView
              slots={liveSlots}
              rankedTeams={rankedTeams}
              teamsByNumber={teamsByNumber}
              profiles={profiles}
              editable={isAdmin}
              onChange={(next) => void saveBoard(next)}
            />
          )}

          {view === "simulation" && (
            <SimulationView
              liveSlots={liveSlots}
              rankedTeams={rankedTeams}
              teamsByNumber={teamsByNumber}
              profiles={profiles}
              aggregates={aggregates}
            />
          )}
        </>
      )}
    </main>
  );
}

function AllianceSelectionView({
  slots,
  rankedTeams,
  teamsByNumber,
  profiles,
  editable,
  onChange,
}: {
  slots: AllianceSlots;
  rankedTeams: readonly number[];
  teamsByNumber: ReadonlyMap<number, EventTeam>;
  profiles: ReturnType<typeof buildTeamProfiles>;
  editable: boolean;
  onChange: (slots: (number | null)[]) => void;
}) {
  const strengths = useMemo(
    () => allianceStrengths(slots, profiles),
    [slots, profiles],
  );
  const odds = useMemo(() => boardOdds(slots, profiles), [slots, profiles]);
  const available = useAvailableTeams(slots, rankedTeams);

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-graphite-900">
          <span aria-hidden className="h-4 w-1 bg-maroon-600" />
          Alliance Selection
        </h2>
        <p className="mt-0.5 text-sm text-graphite-500">
          {editable
            ? "Fill each slot as the alliances are announced. Everyone on your team sees the board live."
            : "Filled in by your admin as alliances are announced — updates live."}
        </p>
      </div>

      <OddsExplainer complete={odds !== null} />

      <AllianceBoard
        slots={slots}
        teamsByNumber={teamsByNumber}
        availableTeams={available}
        strengths={strengths}
        odds={odds}
        mode="select"
        editable={editable}
        onAssign={(alliance, slot, team) =>
          onChange(assignSlot(slots, alliance, slot, team))
        }
      />

      {editable && (
        <div>
          <button
            type="button"
            onClick={() => onChange(emptySlots())}
            className="rounded border border-graphite-200 px-3 py-1.5 text-xs font-medium text-graphite-600 transition hover:border-graphite-300"
          >
            Clear board
          </button>
        </div>
      )}
    </section>
  );
}

function SimulationView({
  liveSlots,
  rankedTeams,
  teamsByNumber,
  profiles,
  aggregates,
}: {
  liveSlots: AllianceSlots;
  rankedTeams: readonly number[];
  teamsByNumber: ReadonlyMap<number, EventTeam>;
  profiles: ReturnType<typeof buildTeamProfiles>;
  aggregates: ReadonlyMap<string, TeamAggregate>;
}) {
  // A scratchpad, not the record: kept on this device so nobody's what-if
  // overwrites the live board mid-selection.
  const [slots, setSlots] = useState<(number | null)[]>(emptySlots);
  const [pendingTeam, setPendingTeam] = useState<number | null>(null);

  const strengths = useMemo(
    () => allianceStrengths(slots, profiles),
    [slots, profiles],
  );
  const odds = useMemo(() => boardOdds(slots, profiles), [slots, profiles]);
  const available = useAvailableTeams(slots, rankedTeams);
  const placed = useMemo(
    () => new Set(slots.filter((t): t is number => t !== null)),
    [slots],
  );

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold text-graphite-900">
          <span aria-hidden className="h-4 w-1 bg-maroon-600" />
          Simulation
        </h2>
        <p className="mt-0.5 text-sm text-graphite-500">
          Tap a team on the left, then tap a slot to seat them. Nothing here is
          saved or shared — it&rsquo;s a what-if board for this device only.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => {
            setSlots(normalizeSlots(liveSlots));
            setPendingTeam(null);
          }}
          className="rounded border border-graphite-200 px-3 py-1.5 text-xs font-medium text-graphite-600 transition hover:border-graphite-300"
        >
          Copy live board
        </button>
        <button
          type="button"
          onClick={() => {
            setSlots(emptySlots());
            setPendingTeam(null);
          }}
          className="rounded border border-graphite-200 px-3 py-1.5 text-xs font-medium text-graphite-600 transition hover:border-graphite-300"
        >
          Clear
        </button>
      </div>

      <OddsExplainer complete={odds !== null} />

      <div className="grid gap-4 lg:grid-cols-[20rem_1fr]">
        <div className="surface-card flex max-h-[40rem] flex-col overflow-y-auto p-0">
          <p className="sticky top-0 border-b border-graphite-200 bg-graphite-50 px-3 py-2 text-xs uppercase tracking-wider text-graphite-500">
            Picklist order
          </p>
          <ul className="divide-y divide-graphite-100">
            {rankedTeams.map((teamNumber, index) => {
              const isPlaced = placed.has(teamNumber);
              const isPending = pendingTeam === teamNumber;
              const agg = aggregates.get(String(teamNumber));
              const points = profiles.get(teamNumber)?.points;
              return (
                <li key={teamNumber}>
                  <button
                    type="button"
                    disabled={isPlaced}
                    onClick={() =>
                      setPendingTeam(isPending ? null : teamNumber)
                    }
                    className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm transition ${
                      isPlaced
                        ? "text-graphite-400 line-through"
                        : isPending
                          ? "bg-maroon-600 text-white"
                          : "hover:bg-graphite-50"
                    }`}
                  >
                    <span className="stat w-6 shrink-0 text-xs text-graphite-400">
                      {index + 1}
                    </span>
                    <span className="stat w-12 shrink-0 font-semibold">
                      {teamNumber}
                    </span>
                    <span className="flex-1 truncate">
                      {teamsByNumber.get(teamNumber)?.nickname ?? "—"}
                    </span>
                    <span
                      className={`stat shrink-0 text-xs ${isPending ? "text-white/80" : "text-graphite-500"}`}
                      title={
                        agg
                          ? `${agg.matches} scouted matches`
                          : "No scout data — EPA fallback"
                      }
                    >
                      {points != null ? points.toFixed(0) : "—"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <AllianceBoard
          slots={slots}
          teamsByNumber={teamsByNumber}
          availableTeams={available}
          strengths={strengths}
          odds={odds}
          mode="place"
          editable
          pendingTeam={pendingTeam}
          onAssign={(alliance, slot, team) => {
            setSlots(assignSlot(slots, alliance, slot, team));
            if (team !== null) setPendingTeam(null);
          }}
        />
      </div>
    </section>
  );
}

function OddsExplainer({ complete }: { complete: boolean }) {
  if (!complete) {
    return (
      <p className="rounded-lg border border-dashed border-graphite-300 bg-graphite-50 px-4 py-3 text-sm text-graphite-500">
        Win odds appear once all eight alliances have three teams.
      </p>
    );
  }
  return (
    <p className="text-xs text-graphite-500">
      Chance of winning the event, from each alliance&rsquo;s predicted points
      run through the real double elimination bracket (game manual §10.6.2,
      thirteen MATCHES then a first-to-two Finals). Every way the bracket can
      play out is counted, so the numbers are exact for the model — not a
      guarantee about the day.
    </p>
  );
}

/** Teams not already seated somewhere on the board, in picklist order. */
function useAvailableTeams(
  slots: AllianceSlots,
  rankedTeams: readonly number[],
): number[] {
  return useMemo(() => {
    const taken = new Set(slots.filter((t): t is number => t !== null));
    return rankedTeams.filter((team) => !taken.has(team));
  }, [slots, rankedTeams]);
}

// Module scope so the React compiler's purity rule doesn't treat the
// Date.now() call as render-time work — save() only runs from handlers.
function makePicklistDoc(
  order: number[],
  struck: number[],
  doNotPick: number[],
): PicklistDoc {
  return { order, struck, doNotPick, updatedAt: Date.now() };
}

function makeNotesPatch(notes: Record<string, string>) {
  return { notes, updatedAt: Date.now() };
}

function makeBoardDoc(slots: (number | null)[]): AllianceBoardDoc {
  return { slots, updatedAt: Date.now() };
}
