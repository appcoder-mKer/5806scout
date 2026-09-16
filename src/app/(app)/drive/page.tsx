"use client";

import { PitAnswerList } from "@/components/PitAnswers";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  aggregateByTeam,
  counterFieldIds,
  selectFieldIds,
  type MatchSubmission,
  type TeamAggregate,
} from "@/lib/aggregate";
import {
  buildTeamProfiles,
  missingPredictionFields,
  pastTeamMatches,
  predictMatch,
  reviewMatch,
  SCORING_WEIGHTS,
  upcomingTeamMatches,
  type MatchPrediction,
  type MatchReview,
  type TeamStrengthProfile,
} from "@/lib/drive";
import type { EventData, EventMatch } from "@/lib/eventData";
import { db } from "@/lib/firebase/client";
import type { FormSection, FormValues } from "@/lib/formSchema";
import { MATCH_FIELD_LABELS } from "@/lib/matchScoutSchema";
import { formatCountdown, matchLabel, msUntilMatch } from "@/lib/pitDashboard";
import { PIT_MEDIA_COLLECTION } from "@/lib/pitScoutSchema";
import { useScoutForms } from "@/lib/useScoutForms";
import { collection, doc, onSnapshot, orderBy, query } from "firebase/firestore";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

export default function DrivePage() {
  const { profile, team, dataTeamId } = useAuth();
  const { matchSections, pitSections } = useScoutForms();
  const isAdmin = profile?.role === "admin";

  const [event, setEvent] = useState<EventData | null>(null);
  const [eventLoaded, setEventLoaded] = useState(false);
  const [submissions, setSubmissions] = useState<MatchSubmission[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!dataTeamId || !isAdmin) return;
    return onSnapshot(doc(db, "teams", dataTeamId, "config", "event"), (s) => {
      setEvent(s.exists() ? (s.data() as EventData) : null);
      setEventLoaded(true);
    });
  }, [dataTeamId, isAdmin]);

  useEffect(() => {
    if (!dataTeamId || !isAdmin) return;
    return onSnapshot(
      query(
        collection(db, "teams", dataTeamId, "matchScouting"),
        orderBy("matchNumber", "asc"),
      ),
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
  }, [dataTeamId, isAdmin]);

  // Tick the countdown once a second while a scheduled match is coming up.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // NaN until the auth team doc resolves, and for a non-numeric team number.
  // Anything user-visible that reads it has to guard first — isOwnTeam is
  // false against NaN, which would otherwise offer "Back to Team NaN".
  const myTeamNumber = Number(team?.teamNumber);
  // Which team the dashboard is following. Null means "whoever's signed in" —
  // kept null rather than seeded so the default survives the team doc loading
  // after first paint.
  const [focusTeam, setFocusTeam] = useState<number | null>(null);
  const viewedTeamNumber = focusTeam ?? myTeamNumber;
  const isOwnTeam = viewedTeamNumber === myTeamNumber;

  // Every team at the event, plus ours if the sync hasn't listed it — the
  // picker should never be missing the team that's using the app.
  const teamChoices = useMemo(() => {
    const numbers = new Set((event?.teams ?? []).map((t) => t.teamNumber));
    if (Number.isInteger(myTeamNumber)) numbers.add(myTeamNumber);
    return [...numbers].sort((a, b) => a - b);
  }, [event, myTeamNumber]);

  const aggregates = useMemo(
    () => aggregateByTeam(matchSections, submissions),
    [matchSections, submissions],
  );

  const profiles = useMemo(
    () =>
      buildTeamProfiles(
        matchSections,
        aggregates,
        SCORING_WEIGHTS,
        event?.teams ?? [],
      ),
    [matchSections, aggregates, event],
  );

  // Scouted averages per team, for the drawer that opens under a team number.
  const aggregateByNumber = useMemo(
    () => new Map(aggregates.map((a) => [a.team, a])),
    [aggregates],
  );

  const predictions = useMemo<MatchPrediction[]>(() => {
    if (!event || !Number.isInteger(viewedTeamNumber)) return [];
    return upcomingTeamMatches(event.matches, viewedTeamNumber).map((m) =>
      predictMatch(m, profiles),
    );
  }, [event, viewedTeamNumber, profiles]);

  const reviews = useMemo<MatchReview[]>(() => {
    if (!event || !Number.isInteger(viewedTeamNumber)) return [];
    return pastTeamMatches(event.matches, viewedTeamNumber).map((m) =>
      reviewMatch(m, profiles),
    );
  }, [event, viewedTeamNumber, profiles]);

  // Short labels for strength/weakness chips, from the live schema.
  const fieldLabels = useMemo<Record<string, string>>(
    () =>
      Object.fromEntries(
        matchSections.flatMap((s) => s.fields.map((f) => [f.id, f.label])),
      ),
    [matchSections],
  );

  // Predictor inputs this team's Match Scout form no longer collects — the
  // points they used to carry are silently missing from every number below.
  const missingInputs = useMemo(
    () => missingPredictionFields(matchSections),
    [matchSections],
  );

  if (profile && !isAdmin) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 md:px-6">
        <div className="rounded-lg border border-dashed border-graphite-300 bg-graphite-50 px-6 py-12 text-center text-sm text-graphite-500">
          The Drive dashboard is only available to admins.
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-8 md:px-6">
      <div>
        <h1 className="page-title">
          <span aria-hidden className="page-rule" />
          Drive Dash
        </h1>
        <p className="page-lede">
          Team {viewedTeamNumber || "—"}&apos;s upcoming matches, predicted from
          your scouts&apos; data — EPA fills in for teams nobody has scouted
          yet.
        </p>
      </div>

      {missingInputs.length > 0 && (
        <p className="badge-error flex items-start gap-2 rounded-md px-3 py-2 text-sm normal-case tracking-normal">
          <span aria-hidden>⚠</span>
          <span>
            Predictions are degraded —{" "}
            {missingInputs
              .map((fieldId) => MATCH_FIELD_LABELS[fieldId] ?? fieldId)
              .join(", ")}{" "}
            {missingInputs.length === 1 ? "is" : "are"} no longer scouted, so{" "}
            {missingInputs.length === 1 ? "its" : "their"} points are missing
            from every number below.{" "}
            <Link href="/form-settings" className="underline underline-offset-2">
              Restore it in Settings → Match Scout
            </Link>
            .
          </span>
        </p>
      )}

      {teamChoices.length > 1 && (
        // Not a <label> around the whole row: that would steal the accessible
        // name of the reset button sitting next to the select.
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="flex items-center gap-2.5">
            <span className="text-sm font-medium text-graphite-700">
              Following
            </span>
            <select
              value={Number.isInteger(viewedTeamNumber) ? viewedTeamNumber : ""}
              onChange={(e) => setFocusTeam(Number(e.target.value))}
              className="field-input stat w-auto"
            >
              {teamChoices.map((teamNumber) => (
                <option key={teamNumber} value={teamNumber}>
                  {teamNumber}
                  {teamNumber === myTeamNumber ? " (us)" : ""}
                </option>
              ))}
            </select>
          </label>
          {!isOwnTeam && Number.isInteger(myTeamNumber) && (
            <button
              type="button"
              onClick={() => setFocusTeam(null)}
              className="btn-secondary"
            >
              Back to Team {myTeamNumber}
            </button>
          )}
        </div>
      )}

      {eventLoaded && !event && (
        <div className="rounded-lg border border-dashed border-graphite-300 bg-graphite-50 px-6 py-12 text-center text-sm text-graphite-500">
          Sync an event on the Event tab to see the schedule here.
        </div>
      )}

      {event && predictions.length === 0 && (
        <div className="rounded-lg border border-dashed border-graphite-300 bg-graphite-50 px-6 py-12 text-center text-sm text-graphite-500">
          No upcoming matches for Team {viewedTeamNumber} —{" "}
          {isOwnTeam ? "you're " : "they're "} done for the day (or the schedule
          hasn&apos;t been posted yet).
        </div>
      )}

      {predictions.map((prediction, index) => (
        <MatchCard
          key={prediction.match.key}
          prediction={prediction}
          isNext={index === 0}
          now={now}
          focusTeamNumber={viewedTeamNumber}
          isOwnTeam={isOwnTeam}
          profiles={profiles}
          fieldLabels={fieldLabels}
          matchSections={matchSections}
          pitSections={pitSections}
          aggregates={aggregateByNumber}
        />
      ))}

      {reviews.length > 0 && (
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="section-title">Played matches</h2>
            <p className="mt-1 text-xs text-graphite-500">
              What the predictor says about each finished match, next to the
              real result. These run on today&apos;s scouting data — including
              the match itself — so treat a hit as a sanity check, not a
              backtest.
            </p>
          </div>
          {reviews.map((review) => (
            <PastMatchRow
              key={review.prediction.match.key}
              review={review}
              focusTeamNumber={viewedTeamNumber}
              matchSections={matchSections}
              pitSections={pitSections}
              aggregates={aggregateByNumber}
            />
          ))}
        </section>
      )}
    </main>
  );
}

/**
 * Both alliances' predicted win chance. The favourite is drawn in its own
 * colour and the underdog is muted, so which way the match leans reads at a
 * glance from the drive station. An exact 50/50 has no favourite.
 */
function WinChance({ redProbability }: { redProbability: number }) {
  const redPercent = Math.round(redProbability * 100);
  const bluePercent = 100 - redPercent;
  const favourite =
    redPercent === bluePercent ? null : redPercent > bluePercent ? "red" : "blue";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <p
          className={`stat text-lg font-bold ${
            favourite === "red"
              ? "text-maroon-700 dark:text-maroon-300"
              : "text-graphite-400"
          }`}
        >
          {redPercent}%
          <span className="ml-1.5 font-sans text-xs font-semibold uppercase tracking-widest">
            red
          </span>
        </p>
        <p
          className={`stat text-lg font-bold ${
            favourite === "blue"
              ? "text-sky-700 dark:text-sky-300"
              : "text-graphite-400"
          }`}
        >
          <span className="mr-1.5 font-sans text-xs font-semibold uppercase tracking-widest">
            blue
          </span>
          {bluePercent}%
        </p>
      </div>
      <div
        className="flex h-2 overflow-hidden rounded-full bg-graphite-100"
        role="img"
        aria-label={`Predicted win chance: red ${redPercent} percent, blue ${bluePercent} percent`}
      >
        <div
          className={
            favourite === "red" ? "h-full bg-maroon-600" : "h-full bg-graphite-300"
          }
          style={{ width: `${redPercent}%` }}
        />
        <div
          className={
            favourite === "blue" ? "h-full bg-sky-700" : "h-full bg-graphite-300"
          }
          style={{ width: `${bluePercent}%` }}
        />
      </div>
    </div>
  );
}

/** One finished match: predicted win chance vs. what actually happened. */
function PastMatchRow({
  review,
  focusTeamNumber,
  matchSections,
  pitSections,
  aggregates,
}: {
  review: MatchReview;
  focusTeamNumber: number;
  matchSections: readonly FormSection[];
  pitSections: readonly FormSection[];
  aggregates: ReadonlyMap<string, TeamAggregate>;
}) {
  const [openTeam, setOpenTeam] = useState<number | null>(null);
  const { prediction, winner, called } = review;
  const { match, red, blue, redWinProbability } = prediction;
  const theyAreRed = match.red.includes(focusTeamNumber);
  const ourProbability =
    redWinProbability === null
      ? null
      : theyAreRed
        ? redWinProbability
        : 1 - redWinProbability;
  const theyWon = winner === (theyAreRed ? "red" : "blue");

  return (
    <div className="surface-card flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-2.5">
          <span className="stat text-sm font-semibold text-graphite-900">
            {matchLabel(match)}
          </span>
          {winner !== null && (
            <span
              className={
                winner === "tie"
                  ? "badge bg-graphite-100 text-graphite-500"
                  : theyWon
                    ? "badge-success badge"
                    : "badge-error badge"
              }
            >
              {winner === "tie" ? "Tie" : theyWon ? "Won" : "Lost"}
            </span>
          )}
        </div>

        <div className="flex items-baseline gap-4">
          <p className="stat text-sm text-graphite-500">
            <span className="text-maroon-700 dark:text-maroon-300">
              {match.redScore ?? "—"}
            </span>
            {" – "}
            <span className="text-sky-700 dark:text-sky-300">
              {match.blueScore ?? "—"}
            </span>
            <span className="ml-1.5 font-sans text-xs uppercase tracking-widest">
              actual
            </span>
          </p>
          <p className="stat text-sm text-graphite-500">
            <span className="text-maroon-700 dark:text-maroon-300">
              {red.points !== null ? red.points.toFixed(0) : "—"}
            </span>
            {" – "}
            <span className="text-sky-700 dark:text-sky-300">
              {blue.points !== null ? blue.points.toFixed(0) : "—"}
            </span>
            <span className="ml-1.5 font-sans text-xs uppercase tracking-widest">
              predicted
            </span>
          </p>
          {ourProbability !== null && (
            <p
              className="stat text-sm font-semibold text-graphite-900"
              title={`Predicted ${Math.round(ourProbability * 100)}% win chance for Team ${focusTeamNumber}`}
            >
              {Math.round(ourProbability * 100)}%
              {called !== null && (
                <span
                  aria-label={called ? "Predictor called it" : "Predictor missed"}
                  className={`ml-1.5 ${
                    called
                      ? "text-green-700 dark:text-green-400"
                      : "text-red-600 dark:text-red-400"
                  }`}
                >
                  {called ? "✓" : "✗"}
                </span>
              )}
            </p>
          )}
        </div>
      </div>

      <Lineup
        match={match}
        focusTeamNumber={focusTeamNumber}
        openTeam={openTeam}
        onToggle={(teamNumber) =>
          setOpenTeam((open) => (open === teamNumber ? null : teamNumber))
        }
      />

      {openTeam !== null && (
        <TeamDrawer
          teamNumber={openTeam}
          matchSections={matchSections}
          pitSections={pitSections}
          aggregate={aggregates.get(String(openTeam))}
        />
      )}
    </div>
  );
}

/**
 * Both alliances' team numbers on one line, each opening that robot's data.
 * A played match is where the drive team asks "who was that?", so the numbers
 * are the point of the row — not decoration on it.
 */
function Lineup({
  match,
  focusTeamNumber,
  openTeam,
  onToggle,
}: {
  match: EventMatch;
  focusTeamNumber: number;
  openTeam: number | null;
  onToggle: (teamNumber: number) => void;
}) {
  const side = (teams: readonly number[], alliance: "red" | "blue") =>
    teams.map((teamNumber) => {
      const isFocus = teamNumber === focusTeamNumber;
      const isOpen = teamNumber === openTeam;
      return (
        <button
          key={teamNumber}
          type="button"
          aria-expanded={isOpen}
          onClick={() => onToggle(teamNumber)}
          className={`stat rounded px-1.5 py-0.5 text-xs font-semibold transition ${
            isOpen ? "ring-1 ring-graphite-300" : ""
          } ${
            alliance === "red"
              ? "text-maroon-700 hover:bg-maroon-50 dark:text-maroon-300"
              : "text-sky-700 hover:bg-sky-50 dark:text-sky-300 dark:hover:bg-sky-950/40"
          } ${isFocus ? "underline underline-offset-2" : ""}`}
        >
          {teamNumber}
        </button>
      );
    });

  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-t border-graphite-100 pt-2">
      {side(match.red, "red")}
      <span className="px-1 text-xs text-graphite-400">vs</span>
      {side(match.blue, "blue")}
    </div>
  );
}

function MatchCard({
  prediction,
  isNext,
  now,
  focusTeamNumber,
  isOwnTeam,
  profiles,
  fieldLabels,
  matchSections,
  pitSections,
  aggregates,
}: {
  prediction: MatchPrediction;
  isNext: boolean;
  now: number;
  /** The team this card is written from the point of view of. */
  focusTeamNumber: number;
  /** Whether that team is the one signed in — decides "us" vs. their number. */
  isOwnTeam: boolean;
  profiles: ReadonlyMap<number, TeamStrengthProfile>;
  fieldLabels: Record<string, string>;
  matchSections: readonly FormSection[];
  pitSections: readonly FormSection[];
  aggregates: ReadonlyMap<string, TeamAggregate>;
}) {
  const { match, red, blue, redWinProbability } = prediction;
  const untilMs = msUntilMatch(match, now);

  return (
    <section
      className={`surface-card flex flex-col gap-4 p-4 md:p-5 ${
        isNext ? "border-maroon-600" : ""
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-baseline gap-2 text-base font-semibold text-graphite-900">
          <span className="stat text-lg">{matchLabel(match)}</span>
          {isNext && (
            <span className="badge bg-maroon-600 text-white">Next up</span>
          )}
        </h2>
        <p className="stat text-sm text-graphite-500">
          {untilMs !== null
            ? untilMs > 0
              ? `in ${formatCountdown(untilMs)}`
              : "now"
            : "no scheduled time"}
        </p>
      </div>

      {redWinProbability !== null && (
        <WinChance redProbability={redWinProbability} />
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {(["red", "blue"] as const).map((color) => {
          const alliance = color === "red" ? red : blue;
          const teams = color === "red" ? match.red : match.blue;
          const ours = teams.includes(focusTeamNumber);
          return (
            <div
              key={color}
              className={`flex flex-col gap-3 rounded-md border p-3 ${
                color === "red"
                  ? "border-maroon-200 dark:border-maroon-700"
                  : "border-sky-200 dark:border-sky-800"
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <p
                  className={`text-xs font-semibold uppercase tracking-widest ${
                    color === "red"
                      ? "text-maroon-700 dark:text-maroon-300"
                      : "text-sky-700 dark:text-sky-300"
                  }`}
                >
                  {color} alliance
                  {ours ? (isOwnTeam ? " — us" : ` — ${focusTeamNumber}`) : ""}
                </p>
                <p className="stat text-sm font-semibold text-graphite-900">
                  {alliance.points !== null
                    ? `~${alliance.points.toFixed(0)} pts`
                    : "—"}
                </p>
              </div>
              {teams.map((teamNumber) => (
                <TeamRow
                  key={teamNumber}
                  teamNumber={teamNumber}
                  isUs={teamNumber === focusTeamNumber}
                  profile={profiles.get(teamNumber)}
                  fieldLabels={fieldLabels}
                  matchSections={matchSections}
                  pitSections={pitSections}
                  aggregate={aggregates.get(String(teamNumber))}
                />
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TeamRow({
  teamNumber,
  isUs,
  profile,
  fieldLabels,
  matchSections,
  pitSections,
  aggregate,
}: {
  teamNumber: number;
  isUs: boolean;
  profile: TeamStrengthProfile | undefined;
  fieldLabels: Record<string, string>;
  matchSections: readonly FormSection[];
  pitSections: readonly FormSection[];
  aggregate: TeamAggregate | undefined;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-1 border-t border-graphite-100 pt-2 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((wasOpen) => !wasOpen)}
          aria-expanded={open}
          className={`stat flex items-center gap-1.5 rounded px-1 py-0.5 -ml-1 text-sm font-semibold transition hover:bg-graphite-100 ${
            isUs ? "text-maroon-700 dark:text-maroon-300" : "text-graphite-900"
          }`}
        >
          <span
            aria-hidden
            className={`font-sans text-[0.65rem] text-graphite-400 transition-transform ${
              open ? "rotate-90" : ""
            }`}
          >
            ▶
          </span>
          {teamNumber}
        </button>
        <p className="stat text-xs text-graphite-500">
          {profile?.points != null ? (
            <>
              {profile.points.toFixed(1)} pts
              <span className="ml-1.5 rounded bg-graphite-100 px-1 py-0.5 font-sans text-xs font-semibold uppercase text-graphite-500">
                {profile.source === "scouted"
                  ? `${profile.matches} scouted`
                  : "EPA"}
              </span>
            </>
          ) : (
            "no data"
          )}
        </p>
      </div>
      {profile && (profile.strengths.length > 0 || profile.weaknesses.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {profile.strengths.map((edge) => (
            <span
              key={edge.fieldId}
              title={`${edge.avg.toFixed(1)}/match vs ${edge.eventAvg.toFixed(1)} event avg`}
              className="badge-success rounded px-1.5 py-0.5 text-xs normal-case tracking-normal"
            >
              ▲ {fieldLabels[edge.fieldId] ?? edge.fieldId}
            </span>
          ))}
          {profile.weaknesses.map((edge) => (
            <span
              key={edge.fieldId}
              title={`${edge.avg.toFixed(1)}/match vs ${edge.eventAvg.toFixed(1)} event avg`}
              className="badge-error rounded px-1.5 py-0.5 text-xs normal-case tracking-normal"
            >
              ▼ {fieldLabels[edge.fieldId] ?? edge.fieldId}
            </span>
          ))}
        </div>
      )}
      {open && (
        <TeamDrawer
          teamNumber={teamNumber}
          matchSections={matchSections}
          pitSections={pitSections}
          aggregate={aggregate}
        />
      )}
    </div>
  );
}

/**
 * What we know about one robot, opened under its number in a match card. Pit
 * answers are fetched only once a drawer is opened — a pit report carries
 * photos and drawings as data URLs, and pulling every team’s at once would
 * make the dashboard expensive to load on venue wifi.
 */
function TeamDrawer({
  teamNumber,
  matchSections,
  pitSections,
  aggregate,
}: {
  teamNumber: number;
  matchSections: readonly FormSection[];
  pitSections: readonly FormSection[];
  aggregate: TeamAggregate | undefined;
}) {
  const { dataTeamId } = useAuth();
  const [pit, setPit] = useState<{
    values: FormValues;
    scoutName: string | null;
  } | null>(null);
  const [media, setMedia] = useState<FormValues>({});
  const [pitLoaded, setPitLoaded] = useState(false);

  useEffect(() => {
    if (!dataTeamId) return;
    const teamId = String(teamNumber);
    const unsubPit = onSnapshot(
      doc(db, "teams", dataTeamId, "pitScouting", teamId),
      (snapshot) => {
        const data = snapshot.data();
        setPit(
          data
            ? {
                values: (data.values as FormValues | undefined) ?? {},
                scoutName: (data.scoutName as string | undefined) ?? null,
              }
            : null,
        );
        setPitLoaded(true);
      },
      // A failed read still has to resolve the drawer: without this the
      // listener errors silently and the panel sits on "Loading…" forever
      // with nothing to tell the drive team it won't arrive.
      () => setPitLoaded(true),
    );
    const unsubMedia = onSnapshot(
      doc(db, "teams", dataTeamId, PIT_MEDIA_COLLECTION, teamId),
      (snapshot) =>
        setMedia((snapshot.data()?.values as FormValues | undefined) ?? {}),
      () => setMedia({}),
    );
    return () => {
      unsubPit();
      unsubMedia();
    };
  }, [dataTeamId, teamNumber]);

  // Only the fields this team actually has numbers for — a drawer full of
  // zeroes tells the drive team nothing.
  const counters = counterFieldIds(matchSections)
    .map((id) => ({ id, avg: aggregate?.averages[id] ?? 0 }))
    .filter((entry) => entry.avg > 0);
  const modes = selectFieldIds(matchSections)
    .map((id) => ({ id, mode: aggregate?.modes[id] ?? null }))
    .filter((entry): entry is { id: string; mode: string } => !!entry.mode);

  const pitValues = { ...(pit?.values ?? {}), ...media };
  const hasPit = Object.keys(pitValues).length > 0;

  // Labels off the effective schema, not the season constant: a question the
  // team renamed in Form Setup has to read the same here as on the form.
  const fieldLabels = new Map(
    matchSections.flatMap((s) => s.fields.map((f) => [f.id, f.label] as const)),
  );
  const labelFor = (fieldId: string) =>
    fieldLabels.get(fieldId) ?? MATCH_FIELD_LABELS[fieldId] ?? fieldId;

  return (
    <div className="mt-1.5 flex flex-col gap-3 rounded-md border border-graphite-200 bg-graphite-50 p-3 dark:bg-graphite-900/40">
      <section className="flex flex-col gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-widest text-graphite-500">
          Scouted — {aggregate ? `${aggregate.matches} match${aggregate.matches === 1 ? "" : "es"}` : "no matches yet"}
        </h4>
        {counters.length === 0 && modes.length === 0 ? (
          <p className="text-xs text-graphite-500">
            Nobody has match scouted this robot yet.
          </p>
        ) : (
          <dl className="flex flex-col gap-1">
            {counters.map((entry) => (
              <div
                key={entry.id}
                className="flex items-baseline justify-between gap-3"
              >
                <dt className="text-xs text-graphite-500">
                  {labelFor(entry.id)}
                </dt>
                <dd className="stat text-sm font-semibold text-graphite-900">
                  {entry.avg.toFixed(1)}
                  <span className="ml-1 font-sans text-xs font-normal text-graphite-400">
                    /match
                  </span>
                </dd>
              </div>
            ))}
            {modes.map((entry) => (
              <div
                key={entry.id}
                className="flex items-baseline justify-between gap-3"
              >
                <dt className="text-xs text-graphite-500">
                  {labelFor(entry.id)}
                </dt>
                <dd className="text-sm text-graphite-900">{entry.mode}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <section className="flex flex-col gap-2 border-t border-graphite-200 pt-2.5">
        <h4 className="text-xs font-semibold uppercase tracking-widest text-graphite-500">
          Pit scouting
          {pit?.scoutName ? (
            <span className="ml-1.5 font-sans normal-case tracking-normal text-graphite-400">
              by {pit.scoutName}
            </span>
          ) : null}
        </h4>
        {!pitLoaded ? (
          <p className="text-xs text-graphite-500">Loading…</p>
        ) : hasPit ? (
          <PitAnswerList sections={pitSections} values={pitValues} dense />
        ) : (
          <p className="text-xs text-graphite-500">
            This robot hasn’t been pit scouted yet.
          </p>
        )}
      </section>
    </div>
  );
}
