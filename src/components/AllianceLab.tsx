"use client";

import {
  histogram,
  rankPartners,
  SIMULATIONS,
  simulateMatchup,
  type TeamSampler,
} from "@/lib/allianceLab";
import type { PickRow } from "@/lib/pickScore";
import type { PickBoardData } from "@/lib/usePickBoard";
import { useMemo, useState } from "react";

// Two questions before alliance selection: "would this alliance beat that
// one?" and "who should we add?". Both are answered by replaying each robot's
// real scouted matches (see allianceLab.ts), so a streaky team widens the
// range instead of hiding behind its average.

const PARTNER_ROWS = 15;
const RED = "#c04a56";
const BLUE = "#3b6fc4";

function fmt(value: number): string {
  return value.toFixed(1);
}

function teamLabel(row: PickRow | undefined, teamNumber: number, ourTeam: number | null): string {
  const us = teamNumber === ourTeam ? " (us)" : "";
  return row ? `${teamNumber}${us}, ${row.role}` : `${teamNumber}${us}`;
}

function TeamSelect({
  value,
  onChange,
  rows,
  ourTeam,
  allowNone,
  label,
}: {
  value: number | null;
  onChange: (team: number | null) => void;
  rows: readonly PickRow[];
  ourTeam: number | null;
  allowNone?: string;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      className="field-input py-2"
    >
      {allowNone !== undefined && <option value="">{allowNone}</option>}
      {rows.map((row) => (
        <option key={row.teamNumber} value={row.teamNumber}>
          {teamLabel(row, row.teamNumber, ourTeam)}
        </option>
      ))}
    </select>
  );
}

function SpreadChart({ redTotals, blueTotals }: { redTotals: number[]; blueTotals: number[] }) {
  const bins = histogram(redTotals, blueTotals);
  const W = 640;
  const H = 150;
  const PAD = 22;
  const peak = Math.max(1, ...bins.flatMap((b) => [b.red, b.blue]));
  const barW = (W - PAD * 2) / Math.max(1, bins.length);
  const ticks = bins.length ? [bins[0].from, bins[Math.floor(bins.length / 2)].from, bins[bins.length - 1].to] : [];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Simulated score distribution for both alliances">
      {bins.map((bin, i) =>
        (["red", "blue"] as const).map((side) => {
          const h = (bin[side] / peak) * (H - PAD - 8);
          return (
            <rect
              key={`${i}-${side}`}
              x={PAD + i * barW}
              y={H - PAD - h}
              width={barW}
              height={h}
              fill={side === "red" ? RED : BLUE}
              fillOpacity={0.35}
              stroke={side === "red" ? RED : BLUE}
              strokeWidth={1}
            />
          );
        }),
      )}
      <line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} className="stroke-graphite-300" />
      {ticks.map((t, i) => (
        <text
          key={i}
          x={i === 0 ? PAD : i === 1 ? W / 2 : W - PAD}
          y={H - 6}
          textAnchor={i === 0 ? "start" : i === 1 ? "middle" : "end"}
          fontSize={11}
          className="stat fill-graphite-500"
        >
          {Math.round(t)}
        </text>
      ))}
    </svg>
  );
}

export function AllianceLab({ data, rows }: { data: PickBoardData; rows: readonly PickRow[] }) {
  const { stats, ourTeam, taken } = data;
  const byTeam = useMemo(() => new Map(rows.map((r) => [r.teamNumber, r])), [rows]);
  const samplers = useMemo(
    () => new Map<number, TeamSampler>(stats.map((s) => [s.teamNumber, s])),
    [stats],
  );
  const listed = useMemo(
    () => [...rows].sort((a, b) => a.teamNumber - b.teamNumber),
    [rows],
  );

  // Default matchup: us plus the two best untaken partners against the next
  // three — the alliance we'd build versus the one most likely to stop it.
  const defaults = useMemo(() => {
    const ranked = rows.filter((r) => r.teamNumber !== ourTeam && !taken.has(r.teamNumber));
    const fill = rows.map((r) => r.teamNumber);
    const pick = (list: number[], n: number) => list.slice(0, n);
    const red = ourTeam !== null && byTeam.has(ourTeam)
      ? [ourTeam, ...pick(ranked.map((r) => r.teamNumber), 2)]
      : pick(fill, 3);
    const blue = pick(fill.filter((t) => !red.includes(t)), 3);
    return { red, blue };
  }, [rows, ourTeam, taken, byTeam]);

  const [chosen, setChosen] = useState<{ red: (number | null)[]; blue: (number | null)[] } | null>(null);
  const lineup = chosen ?? defaults;
  const setSlot = (side: "red" | "blue", i: number, team: number | null) => {
    const next = { red: [...lineup.red], blue: [...lineup.blue] };
    next[side][i] = team;
    setChosen(next);
  };

  const result = useMemo(() => {
    const side = (teams: readonly (number | null)[]) =>
      teams
        .filter((t): t is number => t !== null)
        .map((t) => samplers.get(t))
        .filter((s): s is TeamSampler => s !== undefined);
    return simulateMatchup(side(lineup.red), side(lineup.blue));
  }, [lineup, samplers]);

  // Partner finder
  const [captain, setCaptain] = useState<number | null>(null);
  const [firstPick, setFirstPick] = useState<number | null>(null);
  const [onlyUntaken, setOnlyUntaken] = useState(true);
  const effectiveCaptain = captain ?? ourTeam ?? rows[0]?.teamNumber ?? null;
  const partners = useMemo(() => {
    if (effectiveCaptain === null) return [];
    const alliance = [effectiveCaptain, firstPick]
      .filter((t): t is number => t !== null)
      .map((t) => samplers.get(t))
      .filter((s): s is TeamSampler => s !== undefined);
    const inAlliance = new Set([effectiveCaptain, firstPick]);
    const candidates = stats.filter(
      (s) => !inAlliance.has(s.teamNumber) && (!onlyUntaken || !taken.has(s.teamNumber)),
    );
    return rankPartners(alliance, candidates).slice(0, PARTNER_ROWS);
  }, [effectiveCaptain, firstPick, onlyUntaken, samplers, stats, taken]);

  const redPct = Math.round(result.redWin * 100);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-graphite-900">
            <span aria-hidden className="h-4 w-1 bg-maroon-600" />
            Hypothetical match
          </h2>
          <p className="mt-0.5 text-sm text-graphite-500">
            Pick six robots. Each matchup is simulated {SIMULATIONS.toLocaleString()} times from their real scouted
            matches; teams nobody scouted play their EPA every time.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr] md:items-center">
          {(["red", "blue"] as const).map((side, sideIndex) => (
            <div key={side} className={`flex flex-col gap-2 ${sideIndex === 1 ? "md:order-3" : ""}`}>
              <p className="flex items-center gap-2 text-sm font-semibold text-graphite-900">
                <span aria-hidden className="h-3 w-3 rounded-sm" style={{ background: side === "red" ? RED : BLUE }} />
                {side === "red" ? "Red" : "Blue"}
              </p>
              {[0, 1, 2].map((i) => (
                <TeamSelect
                  key={i}
                  label={`${side} robot ${i + 1}`}
                  value={lineup[side][i] ?? null}
                  onChange={(t) => setSlot(side, i, t)}
                  rows={listed}
                  ourTeam={ourTeam}
                  allowNone="Empty slot"
                />
              ))}
            </div>
          ))}
          <div className="flex flex-col items-center gap-1 md:order-2 md:px-4">
            <p className="text-xs text-graphite-500">Red wins</p>
            <p className="stat text-5xl font-semibold text-graphite-900">{redPct}%</p>
            <div className="flex h-1.5 w-32 overflow-hidden rounded-full" aria-hidden>
              <span style={{ width: `${redPct}%`, background: RED }} />
              <span style={{ width: `${100 - redPct}%`, background: BLUE }} />
            </div>
            <p className="stat text-xs text-graphite-500">
              {Math.round(result.red.mean)} to {Math.round(result.blue.mean)} on average
            </p>
          </div>
        </div>

        {result.unknownTeams.length > 0 && (
          <p className="badge-warning rounded-md px-3 py-2 text-sm normal-case tracking-normal">
            No scouting or EPA for {result.unknownTeams.join(", ")} — they count as zero.
          </p>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          {(["red", "blue"] as const).map((side) => {
            const summary = result[side];
            return (
              <div key={side} className="surface-card flex flex-col p-4">
                <p className="mb-2 flex items-center gap-2 font-semibold text-graphite-900">
                  <span aria-hidden className="h-3 w-3 rounded-sm" style={{ background: side === "red" ? RED : BLUE }} />
                  {side === "red" ? "Red" : "Blue"}
                </p>
                <dl className="divide-y divide-graphite-100 text-sm">
                  {lineup[side]
                    .filter((t): t is number => t !== null)
                    .map((t) => (
                      <div key={t} className="flex justify-between py-2">
                        <dt className="text-graphite-700">{teamLabel(byTeam.get(t), t, ourTeam)}</dt>
                        <dd className="stat font-semibold text-graphite-900">
                          {byTeam.get(t)?.points != null ? fmt(byTeam.get(t)!.points!) : "—"}
                        </dd>
                      </div>
                    ))}
                  <div className="flex justify-between py-2">
                    <dt className="text-graphite-700">Average score</dt>
                    <dd className="stat font-semibold text-graphite-900">{fmt(summary.mean)}</dd>
                  </div>
                  <div className="flex justify-between py-2">
                    <dt className="text-graphite-700">80% of matches between</dt>
                    <dd className="stat font-semibold text-graphite-900">
                      {Math.round(summary.low)} and {Math.round(summary.high)}
                    </dd>
                  </div>
                  <div className="flex justify-between py-2">
                    <dt className="text-graphite-700">Bad day (1 in 5 matches)</dt>
                    <dd className="stat font-semibold text-graphite-900">{fmt(summary.badDay)}</dd>
                  </div>
                </dl>
              </div>
            );
          })}
        </div>

        <div className="surface-card p-4">
          <p className="font-semibold text-graphite-900">Score spread</p>
          <p className="mb-2 text-xs text-graphite-500">
            {SIMULATIONS.toLocaleString()} simulated matches per alliance. More overlap means a closer match.
          </p>
          <SpreadChart redTotals={result.redTotals} blueTotals={result.blueTotals} />
        </div>
      </section>

      <section className="surface-card flex flex-col gap-3 p-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-graphite-900">
            <span aria-hidden className="h-4 w-1 bg-maroon-600" />
            Partner finder
          </h2>
          <p className="mt-0.5 text-sm text-graphite-500">
            Who adds the most to this alliance, rewarding partners whose bad days are still good. The value is
            the simulated average and bad-day score, weighted equally.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm text-graphite-700">
          <span>Captain</span>
          <div className="w-56">
            <TeamSelect label="Captain" value={effectiveCaptain} onChange={setCaptain} rows={listed} ourTeam={ourTeam} />
          </div>
          <span>First pick</span>
          <div className="w-56">
            <TeamSelect
              label="First pick"
              value={firstPick}
              onChange={setFirstPick}
              rows={listed.filter((r) => r.teamNumber !== effectiveCaptain)}
              ourTeam={ourTeam}
              allowNone="None yet"
            />
          </div>
          <button
            type="button"
            aria-pressed={onlyUntaken}
            onClick={() => setOnlyUntaken((v) => !v)}
            className={`rounded-md border px-3 py-2 text-sm font-medium transition ${
              onlyUntaken
                ? "border-maroon-600 bg-maroon-600 text-white"
                : "border-graphite-200 bg-surface text-graphite-700 hover:border-graphite-300"
            }`}
          >
            Only untaken
          </button>
        </div>
        <ul className="divide-y divide-graphite-100">
          {partners.map((p) => {
            const row = byTeam.get(p.teamNumber);
            return (
              <li key={p.teamNumber} className="flex items-baseline gap-3 py-2 text-sm">
                <span className="stat w-14 font-semibold text-graphite-900">{p.teamNumber}</span>
                <span className="min-w-0 flex-1 text-graphite-500">
                  <span className="stat font-semibold text-graphite-800">avg {fmt(p.mean)}</span>, bad day{" "}
                  <span className="stat">{fmt(p.badDay)}</span>. {row?.role ?? ""}
                  {row && row.flags.length > 0 ? `, ${row.flags.join(", ").toLowerCase()}` : ""}.
                </span>
                <span className="stat font-semibold text-graphite-900">{fmt(p.value)}</span>
              </li>
            );
          })}
          {partners.length === 0 && (
            <li className="py-6 text-center text-sm text-graphite-500">No partners left to rank.</li>
          )}
        </ul>
      </section>
    </div>
  );
}
