"use client";

import { DrawingPad } from "@/components/DrawingPad";
import { DeepLinkParams } from "@/components/DeepLinkParams";
import { MyMatchAssignments } from "@/components/MyAssignments";
import { ReliabilityWarning } from "@/components/ReliabilityFlags";
import { SchemaField } from "@/components/SchemaForm";
import { slotKey, type MatchSlot } from "@/lib/assignments";
import { useAuth } from "@/lib/auth/AuthProvider";
import { MATCH_LINK_PARAMS, slotFromParams } from "@/lib/dashboard";
import { db } from "@/lib/firebase/client";
import {
  emptyValues,
  missingRequiredFields,
  type FieldDef,
  type FormSection,
  type FormValues,
} from "@/lib/formSchema";
import { MATCH_SCOUT_SECTIONS } from "@/lib/matchScoutSchema";
import {
  formatClock,
  IDLE_CLOCK,
  isRunning,
  shiftAt,
  TELEOP_SECONDS,
  toggleMatch,
  toggleTimer,
  watchSeconds,
  type MatchClock,
  type TimedKind,
} from "@/lib/matchTimer";
import { RELIABILITY_FLAGS_DOC_ID } from "@/lib/reliability";
import { submitLocally } from "@/lib/offlineSync";
import { SyncStatus } from "@/components/SyncStatus";
import { useScoutForms } from "@/lib/useScoutForms";
import {
  addDoc,
  arrayUnion,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from "firebase/firestore";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";

// Bespoke REBUILT (2026) match scout screen. The generic schema-driven form
// couldn't keep up with this game — fuel arrives hundreds of balls at a time,
// so counting needs ±5/±10 buttons, and climbs/ratings want one-tap segmented
// pickers. Field ids and options stay in lockstep with MATCH_SCOUT_SECTIONS
// (the data dictionary the Data/Drive/Teams/Picklist pages aggregate from).
//
// The season questions below are hand-rendered, but the form a team actually
// sees is the customized one (useScoutForms): a question the team deleted from
// Form Setup renders nothing here, and questions the team added render
// generically at the end of their section.

type Alliance = "red" | "blue";

interface RecentSubmission {
  id: string;
  matchNumber: number;
  scoutedTeam: string;
  alliance: Alliance;
  scoutName: string;
}

type Status =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved" }
  | { state: "error"; message: string };

// Answers a scout shouldn't have to tap for the common case — "nothing bad
// happened". Anything observational (start position, leave, climbs, pick
// call) starts unanswered instead so silence never fakes a data point.
const PRESET_VALUES: FormValues = {
  noShow: "No",
  tipped: "No",
  card: "None",
};

function freshValues(sections: readonly FormSection[]): FormValues {
  // Presets only apply to the season questions they name; a team that deleted
  // one just never gets that key, which is what emptyValues already implies.
  return { ...emptyValues(sections), ...PRESET_VALUES };
}

/** Season ids this screen hand-renders — everything else renders generically. */
const BESPOKE_FIELD_IDS = new Set(
  MATCH_SCOUT_SECTIONS.flatMap((section) =>
    section.fields.map((field) => field.id),
  ),
);

const DEFAULT_SECTION_TITLES = MATCH_SCOUT_SECTIONS.map(
  (section) => section.title,
);

/** Section header matching the app's fieldset-legend convention. */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-maroon-700 dark:text-maroon-300">
      <span aria-hidden className="h-2.5 w-1 bg-maroon-600" />
      {children}
    </h2>
  );
}

/** One-tap choice row — REBUILT has too little time for dropdowns. */
function Segmented({
  label,
  options,
  value,
  onChange,
  columns,
}: {
  label: string;
  options: readonly string[];
  value: string | null;
  onChange: (value: string | null) => void;
  /** Buttons per row; defaults to one row with every option. */
  columns?: number;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-graphite-700">{label}</span>
      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))`,
        }}
      >
        {options.map((option) => {
          const isOn = value === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={isOn}
              onClick={() => onChange(isOn ? null : option)}
              className={`min-h-11 rounded-md border px-2 py-2 text-sm font-semibold transition ${
                isOn
                  ? "border-maroon-600 bg-maroon-600 text-white"
                  : "border-graphite-200 bg-surface text-graphite-700 hover:border-graphite-300"
              }`}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Toggle chips for the "check all that apply" fields. */
function Chips({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-graphite-700">{label}</span>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const isOn = value.includes(option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={isOn}
              onClick={() =>
                onChange(
                  isOn
                    ? value.filter((item) => item !== option)
                    : [...value, option],
                )
              }
              className={`rounded-full border px-3.5 py-2 text-sm font-medium transition ${
                isOn
                  ? "border-maroon-600 bg-maroon-600 text-white"
                  : "border-graphite-200 bg-surface text-graphite-700 hover:border-graphite-300"
              }`}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Increment step buttons sized for counting fuel by the handful. */
const FUEL_STEPS = [-5, -1, +1, +5, +10] as const;

function FuelCounter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="surface-card flex flex-col gap-2 px-3 py-2.5"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-graphite-700">{label}</span>
        <span className="stat text-2xl font-semibold text-graphite-900">
          {value}
        </span>
      </div>
      <div className="grid grid-cols-5 gap-1.5">
        {FUEL_STEPS.map((step) => {
          const disabled = step < 0 && value + step < 0;
          return (
            <button
              key={step}
              type="button"
              aria-label={`${step > 0 ? "Add" : "Remove"} ${Math.abs(step)} — ${label}`}
              disabled={disabled}
              onClick={() => onChange(Math.max(0, value + step))}
              className={`stat min-h-11 rounded-md text-base font-semibold transition disabled:opacity-40 ${
                step > 0
                  ? "bg-maroon-600 text-white hover:bg-maroon-700 active:bg-maroon-800"
                  : "border border-graphite-200 text-graphite-700 hover:border-graphite-300 active:bg-graphite-100"
              }`}
            >
              {step > 0 ? `+${step}` : step}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 0–5 tap scale for the postmatch judgment calls. */
function RatingScale({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-graphite-700">{label}</span>
      <div className="grid grid-cols-6 gap-1.5">
        {[0, 1, 2, 3, 4, 5].map((rating) => (
          <button
            key={rating}
            type="button"
            aria-pressed={value === rating}
            onClick={() => onChange(rating)}
            className={`stat min-h-11 rounded-md border text-base font-semibold transition ${
              value === rating
                ? "border-maroon-600 bg-maroon-600 text-white"
                : "border-graphite-200 bg-surface text-graphite-700 hover:border-graphite-300"
            }`}
          >
            {rating}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Shooter rate on a 1–25 slider, in tenths — the difference between a 7.5 and
 * an 8.2 robot is a real one at the top of a picklist. Zero isn't on the scale
 * — it means the scout never set it — so the readout stays a dash until the
 * slider moves rather than reporting a robot at 1 ball/sec it never earned.
 */
function RateSlider({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  const isSet = value >= min;
  // Tenths throughout, so 8 and 8.0 never render as different-looking answers.
  const decimals = step < 1 ? 1 : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label
          htmlFor="fuelRate"
          className="text-sm font-medium text-graphite-700"
        >
          {label}
        </label>
        <span className="stat text-lg font-semibold text-graphite-900">
          {isSet ? value.toFixed(decimals) : "—"}
        </span>
      </div>
      <input
        id="fuelRate"
        type="range"
        min={min}
        max={max}
        step={step}
        value={isSet ? value : min}
        // Snapped to the step so no float noise ("8.200000000000001") can
        // reach the submission and throw off a per-team average.
        onChange={(e) =>
          onChange(Number(Number(e.target.value).toFixed(decimals)))
        }
        className="h-11 w-full accent-maroon-600"
      />
      <div className="stat flex justify-between text-xs text-graphite-400">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

/** The stopwatch buttons the clock drives, and the field each one fills. */
const TIMED_BUTTONS: readonly {
  kind: TimedKind;
  fieldId: string;
  label: string;
}[] = [
  { kind: "played", fieldId: "defenseSeconds", label: "Playing defense" },
  { kind: "against", fieldId: "defendedSeconds", label: "Being defended" },
  {
    kind: "immobilized",
    fieldId: "immobilizedSeconds",
    label: "Immobilized / dead",
  },
];

/**
 * The teleop clock and the stopwatches it drives. The clock counts down like
 * the arena's, and each button below is a hold — armed while the thing is
 * happening, disarmed when it stops. Seconds accumulate only while the match
 * is running, so pausing for a field fault costs nothing.
 */
function MatchClockPanel({
  clock,
  now,
  buttons,
  onToggleMatch,
  onToggleTimer,
  onReset,
}: {
  clock: MatchClock;
  now: number;
  buttons: readonly { kind: TimedKind; label: string }[];
  onToggleMatch: () => void;
  onToggleTimer: (kind: TimedKind) => void;
  onReset: () => void;
}) {
  const elapsed = watchSeconds(clock.match, now);
  const remaining = Math.max(0, TELEOP_SECONDS - elapsed);
  const running = isRunning(clock.match);
  const anyArmed = buttons.some((button) => clock.armed[button.kind]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-graphite-200 bg-graphite-50 p-3">
      <div className="flex items-center gap-3">
        <div className="flex flex-col">
          <span className="stat text-3xl font-semibold leading-none text-graphite-900">
            {formatClock(remaining)}
          </span>
          <span className="mt-1 text-xs uppercase tracking-wider text-graphite-500">
            {elapsed === 0 && !running ? "Teleop" : shiftAt(elapsed)}
          </span>
        </div>
        <button
          type="button"
          onClick={onToggleMatch}
          className={`ml-auto min-h-11 rounded-md border px-4 text-sm font-semibold transition ${
            running
              ? "border-amber-500 bg-amber-100/60 text-graphite-900"
              : "border-maroon-600 bg-maroon-600 text-white"
          }`}
        >
          {running ? "Pause" : elapsed > 0 ? "Resume" : "Start"}
        </button>
        <button
          type="button"
          onClick={onReset}
          className="min-h-11 rounded-md border border-graphite-200 bg-surface px-3 text-sm font-medium text-graphite-600 transition hover:border-graphite-300"
        >
          Reset
        </button>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {buttons.map((button) => {
          const armed = clock.armed[button.kind];
          const seconds = watchSeconds(clock[button.kind], now);
          return (
            <button
              key={button.kind}
              type="button"
              aria-pressed={armed}
              onClick={() => onToggleTimer(button.kind)}
              className={`flex min-h-14 items-center justify-between gap-2 rounded-md border px-3 text-sm font-semibold transition ${
                armed
                  ? "border-maroon-600 bg-maroon-600 text-white"
                  : "border-graphite-200 bg-surface text-graphite-700 hover:border-graphite-300"
              }`}
            >
              <span>{button.label}</span>
              <span className="stat text-lg">{formatClock(seconds)}</span>
            </button>
          );
        })}
      </div>

      {/* An armed button that isn't counting is the one way this can quietly
          lose data, so say so instead of looking like it's recording. */}
      {!running && anyArmed && (
        <p className="text-xs text-amber-700 dark:text-amber-500">
          A stopwatch is held but the match clock is paused — press Start to
          keep counting.
        </p>
      )}
    </div>
  );
}

export default function MatchScoutPage() {
  const { profile, user, dataTeamId } = useAuth();
  const { matchSections } = useScoutForms();
  const [matchNumber, setMatchNumber] = useState("");
  const [scoutedTeam, setScoutedTeam] = useState("");
  const [alliance, setAlliance] = useState<Alliance | null>(null);
  // What the scout has actually touched. The form's live values are this laid
  // over the effective schema's blanks (see `values`), so a question the team
  // added mid-session appears with a default instead of undefined.
  const [entered, setEntered] = useState<FormValues>(() =>
    freshValues(MATCH_SCOUT_SECTIONS),
  );
  // The teleop clock and the stopwatches it drives. Kept out of `entered`
  // because it isn't something the scout typed — the seconds it produces are
  // folded into `values` below.
  const [clock, setClock] = useState<MatchClock>(IDLE_CLOCK);
  const [now, setNow] = useState<number>(() => Date.now());
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [reliabilityIssue, setReliabilityIssue] = useState(false);
  const [recent, setRecent] = useState<RecentSubmission[]>([]);
  // The assignment row the scout loaded this form from, so a successful
  // submit can cross it off. Submitting clears it; if the scout edited the
  // match or team in between, the guard at submit time skips the cross-off.
  const [pickedSlot, setPickedSlot] = useState<MatchSlot | null>(null);

  // Which questions this team's form actually asks, and where the team-added
  // ones belong. Both drive what renders below.
  const shownFieldIds = useMemo(
    () =>
      new Set(
        matchSections.flatMap((section) =>
          section.fields.map((field) => field.id),
        ),
      ),
    [matchSections],
  );
  const extrasBySection = useMemo(() => {
    const bySection = new Map<string, FieldDef[]>();
    for (const section of matchSections) {
      const extras = section.fields.filter(
        (field) => !BESPOKE_FIELD_IDS.has(field.id),
      );
      if (extras.length > 0) bySection.set(section.title, extras);
    }
    return bySection;
  }, [matchSections]);
  // Sections the team invented — they render after the season's Post-Match
  // block, in the order Form Setup arranged them.
  const extraSections = useMemo(
    () =>
      matchSections.filter(
        (section) => !DEFAULT_SECTION_TITLES.includes(section.title),
      ),
    [matchSections],
  );

  // The config snapshot lands after first paint, so blanks for the team's own
  // questions get filled in here rather than by a reset that would wipe
  // whatever the scout has already tapped in.
  const values = useMemo<FormValues>(
    () => ({
      ...freshValues(matchSections),
      ...entered,
      // The stopwatches are the source of truth for these three fields — they
      // aren't tappable numbers, so nothing in `entered` can shadow them.
      defenseSeconds: watchSeconds(clock.played, now),
      defendedSeconds: watchSeconds(clock.against, now),
      immobilizedSeconds: watchSeconds(clock.immobilized, now),
    }),
    [matchSections, entered, clock, now],
  );

  // Only tick while something is actually counting; a stopped stopwatch reads
  // straight off its banked total, so re-rendering it would be busywork.
  const clockRunning = isRunning(clock.match);
  useEffect(() => {
    if (!clockRunning) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [clockRunning]);

  useEffect(() => {
    // Submissions land in the shared store so a sister pair pools its data.
    if (!dataTeamId) return;
    return onSnapshot(
      query(
        collection(db, "teams", dataTeamId, "matchScouting"),
        orderBy("createdAt", "desc"),
        limit(10),
      ),
      (snapshot) =>
        setRecent(
          snapshot.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              matchNumber: data.matchNumber as number,
              scoutedTeam: data.scoutedTeam as string,
              alliance: data.alliance as Alliance,
              scoutName: data.scoutName as string,
            };
          }),
        ),
    );
  }, [dataTeamId]);

  function setValue(id: string, value: FormValues[string]) {
    setEntered((prev) => ({ ...prev, [id]: value }));
    if (status.state !== "idle" && status.state !== "saving") {
      setStatus({ state: "idle" });
    }
  }

  // Every clock transition stamps the same `now` it applies, so the display
  // never shows a frame computed against a stale tick.
  function handleToggleMatch() {
    const stamp = Date.now();
    setNow(stamp);
    setClock((prev) => toggleMatch(prev, stamp));
  }

  function handleToggleTimer(kind: TimedKind) {
    const stamp = Date.now();
    setNow(stamp);
    setClock((prev) => toggleTimer(prev, kind, stamp));
  }

  function resetClock() {
    setNow(Date.now());
    setClock(IDLE_CLOCK);
  }

  const noShow = values.noShow === "Yes";

  function handleSubmit() {
    if (!profile || !user || !dataTeamId) return;

    const match = Number(matchNumber.trim());
    const team = scoutedTeam.trim();
    if (!match || !team || !alliance) {
      setStatus({
        state: "error",
        message: "Match number, team number, and alliance are required.",
      });
      return;
    }

    // Only team-added questions can carry a required flag; the season ones
    // stay optional so a scout is never blocked mid-match.
    const missing = missingRequiredFields(matchSections, values);
    if (!noShow && missing.length > 0) {
      setStatus({
        state: "error",
        message: `Answer required: ${missing.join(", ")}.`,
      });
      return;
    }

    // Drop answers to questions the team has since deleted, so a submission
    // only carries keys the form currently asks about.
    const submittedValues: FormValues = Object.fromEntries(
      Object.entries(values).filter(([id]) => shownFieldIds.has(id)),
    );

    setStatus({ state: "saving" });
    try {
      // Not awaited, deliberately: Firestore applies this to its IndexedDB
      // cache at once but only settles the promise when the SERVER acks it,
      // which never happens in an arena with no signal. Awaiting stranded the
      // form on "Submitting…" and stopped the scout recording the next match.
      // See submitLocally() in src/lib/offlineSync.ts.
      submitLocally(
        addDoc(collection(db, "teams", dataTeamId, "matchScouting"), {
          matchNumber: match,
          scoutedTeam: team,
          alliance,
          values: submittedValues,
          reliabilityIssue,
          scoutName: profile.fullName,
          scoutUid: user.uid,
          createdAt: serverTimestamp(),
        }),
      );

      // Every submission bumps the team's scouted-match counter — that's the
      // denominator that decides whether a flag stays scoped to this match or
      // escalates to a team-wide warning. A checked flag also records the match
      // it came from. arrayUnion keeps concurrent scouts from clobbering each
      // other and collapses duplicate submissions for the same match; merge
      // keeps other teams' counters intact.
      submitLocally(
        setDoc(
          doc(db, "teams", dataTeamId, "config", RELIABILITY_FLAGS_DOC_ID),
          {
            teams: {
              [team]: {
                scoutedMatches: arrayUnion(match),
                ...(reliabilityIssue
                  ? {
                      flaggedMatches: arrayUnion(match),
                      flaggedByName: profile.fullName,
                      updatedAtMs: Date.now(),
                    }
                  : {}),
              },
            },
          },
          { merge: true },
        ),
      );

      // Submitting is what "done" means for the assignment row this form was
      // loaded from — cross it off so the scout's list shrinks as they work.
      if (
        pickedSlot &&
        pickedSlot.matchNumber === match &&
        String(pickedSlot.teamNumber) === team
      ) {
        // Silent on failure, and not counted as a sync failure: no
        // assignment set may have been generated at all. The submission
        // landed regardless; the scout can tick the row.
        void updateDoc(
          doc(db, "teams", dataTeamId, "config", "matchAssignments"),
          { completedSlots: arrayUnion(slotKey(pickedSlot)) },
        ).catch(() => undefined);
      }
      setPickedSlot(null);

      // Reset for the next match: bump match number, keep alliance (a scout
      // usually watches the same station), clear team + tallies + the flag.
      setMatchNumber(String(match + 1));
      setScoutedTeam("");
      setEntered(freshValues(matchSections));
      resetClock();
      setReliabilityIssue(false);
      setStatus({ state: "saved" });
    } catch (err) {
      setStatus({
        state: "error",
        message: err instanceof Error ? err.message : "Submit failed",
      });
    }
  }

  const inputClass = "field-input stat";

  const has = (fieldId: string) => shownFieldIds.has(fieldId);
  // A team that dropped one of the timed questions from Form Setup loses that
  // button, and dropping all three hides the clock panel entirely.
  const timedButtons = TIMED_BUTTONS.filter((button) => has(button.fieldId));

  /** The team's own questions for one of the season's sections. */
  const renderExtras = (title: string) =>
    (extrasBySection.get(title) ?? []).map((field) => (
      <SchemaField
        key={field.id}
        field={field}
        value={values[field.id]}
        onChange={(value) => setValue(field.id, value)}
      />
    ));

  /**
   * The season's sections, each built as its own node so they can render in
   * whatever order the team arranged in Form Setup. Match #, team # and
   * alliance aren't in here — they say which match this is, not how it went,
   * so they stay pinned above wherever the sections land.
   */
  const seasonBlocks: Record<string, ReactNode> = {
    "Pre-Match": (
      <>
        <SectionTitle>Pre-Match</SectionTitle>

        {has("startPos") && (
          <Segmented
            label="Starting position"
            options={[
              "Depot side bump",
              "Outpost side bump",
              "Depot side trench",
              "Outpost side trench",
              "Center (Hub)",
            ]}
            columns={2}
            value={values.startPos as string | null}
            onChange={(v) => setValue("startPos", v)}
          />
        )}

        {has("noShow") && (
          <label
            className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2.5 transition ${
              noShow
                ? "border-amber-500 bg-amber-100/50"
                : "border-graphite-200 hover:border-graphite-300"
            }`}
          >
            <input
              type="checkbox"
              checked={noShow}
              onChange={(e) =>
                setValue("noShow", e.target.checked ? "Yes" : "No")
              }
              className="h-4 w-4 shrink-0 accent-amber-500"
            />
            <span className="text-sm font-semibold text-graphite-700">
              No show — robot never took the field
            </span>
          </label>
        )}

        {renderExtras("Pre-Match")}
      </>
    ),
    "Autonomous": (
      <>
        <SectionTitle>Autonomous</SectionTitle>

        {has("autoLeave") && (
          <Segmented
            label="Left starting zone"
            options={["Yes", "No"]}
            value={values.autoLeave as string | null}
            onChange={(v) => setValue("autoLeave", v)}
          />
        )}

        {has("autoScoredFuel") && (
          <FuelCounter
            label="Fuel scored — auto"
            value={(values.autoScoredFuel as number) ?? 0}
            onChange={(v) => setValue("autoScoredFuel", v)}
          />
        )}

        {has("autoFuelSource") && (
          <Chips
            label="Collected fuel from"
            options={["Preload", "Depot", "Outpost", "Neutral zone"]}
            value={(values.autoFuelSource as string[]) ?? []}
            onChange={(v) => setValue("autoFuelSource", v)}
          />
        )}

        {has("autoClimb") && (
          <Segmented
            label="Auto climb — Level 1 (15 pts)"
            options={["No attempt", "Climbed (L1)", "Failed"]}
            value={values.autoClimb as string | null}
            onChange={(v) => setValue("autoClimb", v)}
          />
        )}

        {has("autoPath") && (
          <DrawingPad
            label="Auto path"
            hint="Trace the route the robot drove during auto."
            value={(values.autoPath as string) ?? null}
            onChange={(v) => setValue("autoPath", v)}
          />
        )}

        {renderExtras("Autonomous")}
      </>
    ),
    "Teleop": (
      <>
        <SectionTitle>Teleop</SectionTitle>

        {timedButtons.length > 0 && (
          <MatchClockPanel
            clock={clock}
            now={now}
            buttons={timedButtons}
            onToggleMatch={handleToggleMatch}
            onToggleTimer={handleToggleTimer}
            onReset={resetClock}
          />
        )}

        {has("teleopScoredFuel") && (
          <FuelCounter
            label="Fuel scored — teleop"
            value={(values.teleopScoredFuel as number) ?? 0}
            onChange={(v) => setValue("teleopScoredFuel", v)}
          />
        )}

        {has("teleopFuelFed") && (
          <FuelCounter
            label="Fuel fed / passed"
            value={(values.teleopFuelFed as number) ?? 0}
            onChange={(v) => setValue("teleopFuelFed", v)}
          />
        )}

        {has("teleopFuelSource") && (
          <Chips
            label="Collected fuel from"
            options={["Depot", "Outpost", "Neutral zone", "Opposing zone"]}
            value={(values.teleopFuelSource as string[]) ?? []}
            onChange={(v) => setValue("teleopFuelSource", v)}
          />
        )}

        {has("crossings") && (
          <Chips
            label="Crossed during match"
            options={["Bump", "Trench"]}
            value={(values.crossings as string[]) ?? []}
            onChange={(v) => setValue("crossings", v)}
          />
        )}

        {/* The defense and immobilized fields are timed by the clock
            at the top of this section, so there's nothing to tap for
            them here. */}

        {renderExtras("Teleop")}
      </>
    ),
    "Endgame": (
      <>
        <SectionTitle>Endgame</SectionTitle>

        {has("endgame") && (
          <Segmented
            label="Tower climb (L1 10 · L2 20 · L3 30)"
            options={[
              "None",
              "Level 1",
              "Level 2",
              "Level 3",
              "Failed attempt",
            ]}
            value={values.endgame as string | null}
            onChange={(v) => setValue("endgame", v)}
            columns={3}
          />
        )}

        {renderExtras("Endgame")}
      </>
    ),
    "Post-Match": (
      <>
        <SectionTitle>Post-Match</SectionTitle>

        {has("fuelRate") && (
          <RateSlider
            label="Fuel rate (balls/sec)"
            min={1}
            max={25}
            step={0.1}
            value={(values.fuelRate as number) ?? 0}
            onChange={(v) => setValue("fuelRate", v)}
          />
        )}

        {has("driverSkill") && (
          <RatingScale
            label="Driver skill (0–5)"
            value={(values.driverSkill as number) ?? 0}
            onChange={(v) => setValue("driverSkill", v)}
          />
        )}

        {has("defenseSkill") && (
          <RatingScale
            label="Defense skill (0–5)"
            value={(values.defenseSkill as number) ?? 0}
            onChange={(v) => setValue("defenseSkill", v)}
          />
        )}

        {has("tipped") && (
          <Segmented
            label="Tipped / fell over"
            options={["No", "Yes"]}
            value={values.tipped as string | null}
            onChange={(v) => setValue("tipped", v)}
          />
        )}

        {has("card") && (
          <Segmented
            label="Card"
            options={["None", "Yellow", "Red"]}
            value={values.card as string | null}
            onChange={(v) => setValue("card", v)}
          />
        )}

        {has("wouldPick") && (
          <Segmented
            label="Would you pick them?"
            options={["Yes", "Maybe", "No"]}
            value={values.wouldPick as string | null}
            onChange={(v) => setValue("wouldPick", v)}
          />
        )}

        {renderExtras("Post-Match")}
      </>
    ),
  };

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 md:px-6">
      <div>
        <h1 className="page-title">
          <span aria-hidden className="page-rule" />
          Match Scout
        </h1>
        <p className="page-lede">
          REBUILT — one submission per robot per match. Count fuel by the
          handful with the +5/+10 buttons.
        </p>
      </div>

      <DeepLinkParams
        names={MATCH_LINK_PARAMS}
        onRead={(values) => {
          if (values.match) setMatchNumber(values.match);
          if (values.team) setScoutedTeam(values.team);
          if (values.alliance === "red" || values.alliance === "blue") {
            setAlliance(values.alliance);
          }
          // Only set when the link carried a full slot; a partial one leaves
          // pickedSlot null so submitting can't cross off the wrong row.
          setPickedSlot(slotFromParams(values, user?.uid ?? ""));
        }}
      />

      <MyMatchAssignments
        onPick={(slot) => {
          setMatchNumber(String(slot.matchNumber));
          setScoutedTeam(String(slot.teamNumber));
          setAlliance(slot.alliance);
          setPickedSlot(slot);
          if (status.state !== "saving") setStatus({ state: "idle" });
        }}
      />

      <div className="surface-card flex flex-col gap-5 p-4 md:p-6">
        {/* Which match and which robot — pinned above the sections so it
            stays put however the team orders them. */}
        <SectionTitle>Match</SectionTitle>

        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-graphite-700">
              Match #<span className="ml-0.5 text-maroon-600 dark:text-maroon-400">*</span>
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={matchNumber}
              onChange={(e) => setMatchNumber(e.target.value)}
              className={inputClass}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-graphite-700">
              Team #<span className="ml-0.5 text-maroon-600 dark:text-maroon-400">*</span>
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={scoutedTeam}
              onChange={(e) => setScoutedTeam(e.target.value)}
              className={inputClass}
            />
          </label>
        </div>

        <div
          role="group"
          aria-label="Alliance"
          className="flex flex-col gap-1.5"
        >
          <span className="text-sm font-medium text-graphite-700">
            Alliance<span className="ml-0.5 text-maroon-600 dark:text-maroon-400">*</span>
          </span>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              aria-pressed={alliance === "red"}
              onClick={() => setAlliance("red")}
              className={`rounded-md border px-4 py-2.5 text-sm font-semibold transition ${
                alliance === "red"
                  ? "border-maroon-600 bg-maroon-600 text-white"
                  : "border-graphite-200 bg-surface text-graphite-700 hover:border-graphite-300"
              }`}
            >
              Red
            </button>
            <button
              type="button"
              aria-pressed={alliance === "blue"}
              onClick={() => setAlliance("blue")}
              className={`rounded-md border px-4 py-2.5 text-sm font-semibold transition ${
                alliance === "blue"
                  ? "border-sky-700 bg-sky-700 text-white"
                  : "border-graphite-200 bg-surface text-graphite-700 hover:border-graphite-300"
              }`}
            >
              Blue
            </button>
          </div>
        </div>

        {/* The season's sections in the order the team arranged them. A
            no-show has nothing to scout, so everything past Pre-Match is
            skipped — the notes below stay, which is the point. */}
        {matchSections.map((section) => {
          const block = seasonBlocks[section.title];
          if (!block) return null;
          if (noShow && section.title !== "Pre-Match") return null;
          return <Fragment key={section.title}>{block}</Fragment>;
        })}


        {has("notes") && (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-graphite-700">Notes</span>
            <textarea
              rows={3}
              placeholder="Shooting range, cycle speed, driver skill, anything unusual…"
              value={(values.notes as string) ?? ""}
              onChange={(e) => setValue("notes", e.target.value || null)}
              className="field-input"
            />
          </label>
        )}

        {/* The team's own sections stay outside the no-show gate — a question
            like "why didn't they show?" is exactly what they're for. */}
        {extraSections.map((section) => (
          <div key={section.title} className="flex flex-col gap-5">
            <SectionTitle>{section.title}</SectionTitle>
            {section.fields.map((field) => (
              <SchemaField
                key={field.id}
                field={field}
                value={values[field.id]}
                onChange={(value) => setValue(field.id, value)}
              />
            ))}
          </div>
        ))}

        <label
          className={`flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2.5 transition ${
            reliabilityIssue
              ? "border-red-500 bg-red-50 dark:bg-red-950/30"
              : "border-graphite-200 hover:border-red-300"
          }`}
        >
          <input
            type="checkbox"
            checked={reliabilityIssue}
            onChange={(e) => {
              setReliabilityIssue(e.target.checked);
              if (status.state !== "idle" && status.state !== "saving") {
                setStatus({ state: "idle" });
              }
            }}
            className="h-4 w-4 shrink-0 accent-red-600"
          />
          <span className="flex items-center gap-1.5 text-sm font-semibold text-red-600 dark:text-red-400">
            <svg
              aria-hidden
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
            </svg>
            Reliability Issue
          </span>
        </label>

        <SyncStatus />

        {status.state === "error" && (
          <p className="badge-error rounded-md px-3 py-2 text-sm normal-case tracking-normal">
            {status.message}
          </p>
        )}
        {status.state === "saved" && (
          <p className="badge-success rounded-md px-3 py-2 text-sm normal-case tracking-normal">
            Saved — form reset for the next match.
          </p>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={status.state === "saving"}
          className="btn-primary"
        >
          {status.state === "saving" ? "Submitting…" : "Submit match"}
        </button>
      </div>

      {recent.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="section-title">Recent submissions</h2>
          <ul className="surface-card divide-y divide-graphite-100">
            {recent.map((submission) => (
              <li
                key={submission.id}
                className="flex items-center justify-between px-4 py-2.5 text-sm"
              >
                <span className="stat flex items-center gap-1.5 text-graphite-900">
                  Q{submission.matchNumber} · Team {submission.scoutedTeam}
                  <ReliabilityWarning
                    teamNumber={submission.scoutedTeam}
                    matchNumber={submission.matchNumber}
                  />
                </span>
                <span className="flex items-center gap-2 text-graphite-500">
                  <span
                    aria-hidden
                    className={`h-2 w-2 rounded-full ${
                      submission.alliance === "red" ? "bg-maroon-500" : "bg-sky-600"
                    }`}
                  />
                  {submission.scoutName}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
