"use client";

import {
  matchingPreset,
  PICK_PRESETS,
  presetWeights,
  scorePicklist,
  TREND_FLAG_POINTS,
  type PickRow,
  type PickWeights,
  type Tier,
} from "@/lib/pickScore";
import type { PickBoardData } from "@/lib/usePickBoard";
import Link from "next/link";
import { useMemo, useState } from "react";

// "What are we picking for?" — presets and weight sliders that re-rank the
// whole event live, tiers by draft round, and Taken / DNP marks that every
// screen on the team sees. A lens over the data; the hand ranking on the
// Picklist view is the record and nothing here moves it.

const MAX_WEIGHT = 10;

const TIER_STYLE: Record<Tier, string> = {
  S: "bg-maroon-600 text-white",
  A: "bg-maroon-100 text-maroon-700 dark:bg-maroon-800 dark:text-maroon-100",
  B: "bg-graphite-200 text-graphite-800",
  C: "bg-graphite-100 text-graphite-500",
};

const TIER_HINT =
  "One tier per round of an 8-alliance draft: S is the top 8 by pick score, A the next 8, B the 8 after, C everyone else.";

function fmt(value: number | null, digits = 1): string {
  return value === null ? "—" : value.toFixed(digits);
}

/**
 * An "i" that explains a header. A real popover rather than a title
 * attribute: title never shows on a phone and takes a second to appear on a
 * laptop. Opens on hover and on focus, so a tap or Tab reaches it too.
 */
export function Info({ text }: { text: string }) {
  return (
    <span className="group relative ml-1 inline-flex align-middle">
      <button
        type="button"
        aria-label={text}
        className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-graphite-300 text-[10px] font-semibold normal-case text-graphite-500 transition hover:border-maroon-400 hover:text-maroon-600 focus:border-maroon-400 focus:text-maroon-600 focus:outline-none"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute left-1/2 top-full z-30 mt-1.5 w-64 -translate-x-1/2 rounded-md border border-graphite-200 bg-surface px-3 py-2 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-graphite-700 opacity-0 transition group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

const ROLE_HINT =
  "From where a team's points come from. Bottom 35% of the event in expected points: Support, or Defender if their defense rating is in the top third. Otherwise the form section that earns most of their points (e.g. Teleop scorer), All-round scorer when a second section earns 35%+ of them, or Scorer for a team known only by EPA.";

const FLAGS_HINT =
  "Disabled N× — scouts flagged a breakdown in N matches. Trending up / down — the last 3 matches are 2+ points a match above or below the earlier ones. Few matches — fewer than 3 scouted. EPA only — never scouted, ranked on Statbotics EPA. DNP — on your Do Not Pick list.";

/** Points with a hairline under it spanning the team's worst to best match. */
function PointsCell({ row, max }: { row: PickRow; max: number }) {
  const lo = row.perMatch.length ? Math.min(...row.perMatch) : null;
  const hi = row.perMatch.length ? Math.max(...row.perMatch) : null;
  const x = (v: number) => (max > 0 ? (v / max) * 56 : 0);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="stat font-semibold text-graphite-900">
        {fmt(row.points)}
      </span>
      {lo !== null && hi !== null && row.points !== null && (
        <svg width={56} height={4} aria-hidden>
          <title>{`Matches ranged ${fmt(lo)} to ${fmt(hi)}`}</title>
          <line
            x1={x(lo)}
            x2={x(hi)}
            y1={2}
            y2={2}
            className="stroke-graphite-300"
            strokeWidth={2}
          />
          <circle cx={x(row.points)} cy={2} r={2} className="fill-maroon-600" />
        </svg>
      )}
    </div>
  );
}

export function PickBoard({ data }: { data: PickBoardData }) {
  const { metrics, stats, taken, doNotPick, onBoard, ourTeam, isAdmin } = data;
  const [weights, setWeights] = useState<PickWeights | null>(null);
  const [search, setSearch] = useState("");
  const [hideTaken, setHideTaken] = useState(false);

  // Until someone touches a control, follow the Balanced preset — and keep
  // following it if the form (and so the metric list) changes underneath.
  const effective = useMemo(
    () => weights ?? presetWeights(PICK_PRESETS[0], metrics),
    [weights, metrics],
  );
  const activePreset = matchingPreset(effective, metrics);

  const rows = useMemo(
    () => scorePicklist(stats, metrics, effective),
    [stats, metrics, effective],
  );
  const phaseMetrics = metrics.filter((m) => m.kind === "phase");
  const maxPoints = Math.max(
    0,
    ...rows.map((r) => Math.max(r.points ?? 0, ...r.perMatch)),
  );
  const dnp = useMemo(() => new Set(doNotPick), [doNotPick]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    let list = rows;
    if (hideTaken) list = list.filter((r) => !taken.has(r.teamNumber));
    if (needle) {
      list = list.filter((r) =>
        [String(r.teamNumber), r.role, ...r.flags, `tier ${r.tier}`]
          .join(" ")
          .toLowerCase()
          .includes(needle),
      );
    }
    return list;
  }, [rows, search, hideTaken, taken]);

  const available = rows.filter((r) => !taken.has(r.teamNumber)).length;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-graphite-900">
            <span aria-hidden className="h-4 w-1 bg-maroon-600" />
            What are we picking for?
            <Info text="Pick score blends every metric below, each scaled 0–1 across the event, by the weights you set. Tiers and order re-rank as you drag." />
          </h2>
          <p className="mt-0.5 text-sm text-graphite-500">
            Choose a preset or drag the weights. Mark teams as they get taken
            during selection — marks are saved for the whole team.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {PICK_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              aria-pressed={activePreset === preset.id}
              onClick={() => setWeights(presetWeights(preset, metrics))}
              className={`rounded-full border px-3.5 py-1.5 text-sm font-medium transition ${
                activePreset === preset.id
                  ? "border-maroon-600 bg-maroon-600 text-white"
                  : "border-graphite-200 bg-surface text-graphite-700 hover:border-graphite-300"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
          {metrics.map((metric) => (
            <div
              key={metric.id}
              className="flex items-center gap-3 text-sm text-graphite-700"
            >
              <span className="flex w-32 shrink-0 items-center">
                <span className="truncate">{metric.label}</span>
                <Info text={metric.hint} />
              </span>
              <input
                type="range"
                min={0}
                max={MAX_WEIGHT}
                step={1}
                value={effective[metric.id] ?? 0}
                onChange={(e) =>
                  setWeights({
                    ...effective,
                    [metric.id]: Number(e.target.value),
                  })
                }
                className="h-1.5 min-w-0 flex-1 accent-maroon-600"
                aria-label={`${metric.label} weight`}
              />
              <span className="stat w-5 text-right text-graphite-900">
                {effective[metric.id] ?? 0}
              </span>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search team, role, flag"
            className="field-input w-56 py-2"
          />
          <button
            type="button"
            aria-pressed={hideTaken}
            onClick={() => setHideTaken((v) => !v)}
            className={`rounded-md border px-3 py-2 text-sm font-medium transition ${
              hideTaken
                ? "border-maroon-600 bg-maroon-600 text-white"
                : "border-graphite-200 bg-surface text-graphite-700 hover:border-graphite-300"
            }`}
          >
            Hide taken
          </button>
          {isAdmin && (
            <button
              type="button"
              onClick={data.clearTaken}
              disabled={data.struck.length === 0}
              className="rounded-md border border-graphite-200 bg-surface px-3 py-2 text-sm font-medium text-graphite-700 transition hover:border-graphite-300 disabled:opacity-40"
            >
              Clear taken
            </button>
          )}
          <span className="ml-auto text-xs text-graphite-500">
            <span className="stat">{available}</span> of{" "}
            <span className="stat">{rows.length}</span> available
            {onBoard.size > 0 &&
              " — teams on the alliance board count as taken"}
          </span>
        </div>
      </div>

      {data.saveError && (
        <p className="badge-error rounded-md px-3 py-2 text-sm normal-case tracking-normal">
          {data.saveError}
        </p>
      )}

      <div className="surface-card table-scroll overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th className="w-8">#</th>
              <th>Team</th>
              <th>
                Tier
                <Info text={TIER_HINT} />
              </th>
              <th>
                Pick score
                <Info text="0–100: the weighted blend of every metric, scaled across the event." />
              </th>
              <th>
                Role
                <Info text={ROLE_HINT} />
              </th>
              <th>
                Points
                <Info text="Expected points per match. The line under it runs from the team's worst scouted match to its best." />
              </th>
              {phaseMetrics.map((m) => (
                <th key={m.id}>
                  {m.label}
                  <Info text={m.hint} />
                </th>
              ))}
              <th>
                Reliability
                <Info
                  text={
                    metrics.find((m) => m.kind === "reliability")?.hint ?? ""
                  }
                />
              </th>
              <th>Trend</th>
              <th>Matches</th>
              <th>
                Flags
                <Info text={FLAGS_HINT} />
              </th>
              <th>Mark</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-graphite-100">
            {visible.map((row) => {
              const isTaken = taken.has(row.teamNumber);
              const isDnp = dnp.has(row.teamNumber);
              const ours = row.teamNumber === ourTeam;
              return (
                <tr
                  key={row.teamNumber}
                  className={`${ours ? "bg-amber-100/60" : ""} ${isTaken ? "opacity-45" : ""}`}
                >
                  <td className="stat text-graphite-500">{row.scoreRank}</td>
                  <td>
                    <Link
                      href={`/teams/${row.teamNumber}`}
                      className={`stat font-semibold hover:underline ${
                        ours ? "text-amber-500" : "text-graphite-900"
                      } ${isTaken ? "line-through" : ""}`}
                    >
                      {row.teamNumber}
                    </Link>
                  </td>
                  <td>
                    <span
                      className={`stat inline-flex h-5 w-5 items-center justify-center rounded text-xs font-bold ${TIER_STYLE[row.tier]}`}
                    >
                      {row.tier}
                    </span>
                  </td>
                  <td>
                    <span className="flex items-center gap-2">
                      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-graphite-100">
                        <span
                          className="block h-full bg-graphite-800"
                          style={{ width: `${row.pickScore}%` }}
                        />
                      </span>
                      <span className="stat w-7 text-graphite-900">
                        {row.pickScore}
                      </span>
                    </span>
                  </td>
                  <td>
                    <span className="whitespace-nowrap rounded-full bg-graphite-100 px-2 py-0.5 text-xs text-graphite-700">
                      {row.role}
                    </span>
                  </td>
                  <td>
                    <PointsCell row={row} max={maxPoints} />
                  </td>
                  {phaseMetrics.map((m) => (
                    <td key={m.id} className="stat text-graphite-700">
                      {row.matches > 0 ? fmt(row.phases[m.id] ?? 0) : "—"}
                    </td>
                  ))}
                  <td className="stat text-graphite-700">
                    {row.reliability ?? "—"}
                  </td>
                  <td
                    className={`stat ${
                      row.trend !== null && row.trend >= TREND_FLAG_POINTS
                        ? "text-green-500"
                        : row.trend !== null && row.trend <= -TREND_FLAG_POINTS
                          ? "text-maroon-600 dark:text-maroon-300"
                          : "text-graphite-700"
                    }`}
                  >
                    {row.trend === null
                      ? "—"
                      : `${row.trend > 0 ? "+" : ""}${fmt(row.trend)}`}
                  </td>
                  <td className="stat text-graphite-700">{row.matches}</td>
                  <td className="max-w-56 text-xs text-graphite-500">
                    {[isDnp ? "DNP" : null, ...row.flags]
                      .filter(Boolean)
                      .join(", ")}
                  </td>
                  <td>
                    {isAdmin ? (
                      <span className="flex gap-1">
                        <button
                          type="button"
                          aria-pressed={data.struck.includes(row.teamNumber)}
                          disabled={onBoard.has(row.teamNumber)}
                          title={
                            onBoard.has(row.teamNumber)
                              ? "Placed on the alliance board"
                              : undefined
                          }
                          onClick={() => data.toggleTaken(row.teamNumber)}
                          className={`rounded border px-2 py-1 text-xs font-medium transition disabled:opacity-60 ${
                            isTaken
                              ? "border-graphite-700 bg-graphite-700 text-white"
                              : "border-graphite-200 text-graphite-600 hover:border-graphite-300"
                          }`}
                        >
                          Taken
                        </button>
                        <button
                          type="button"
                          aria-pressed={isDnp}
                          onClick={() => data.toggleDoNotPick(row.teamNumber)}
                          className={`rounded border px-2 py-1 text-xs font-medium transition ${
                            isDnp
                              ? "border-maroon-600 bg-maroon-600 text-white"
                              : "border-graphite-200 text-graphite-600 hover:border-graphite-300"
                          }`}
                        >
                          DNP
                        </button>
                      </span>
                    ) : (
                      <span className="text-xs text-graphite-500">
                        {isTaken ? "Taken" : isDnp ? "DNP" : ""}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td
                  colSpan={20}
                  className="py-8 text-center text-sm text-graphite-500"
                >
                  {rows.length === 0
                    ? "No teams at this event yet."
                    : "No teams match."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
