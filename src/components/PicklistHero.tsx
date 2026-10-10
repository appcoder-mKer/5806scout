"use client";

import { rankPartners } from "@/lib/allianceLab";
import type { PickRow } from "@/lib/pickScore";
import type { PickBoardData } from "@/lib/usePickBoard";
import Link from "next/link";
import { useMemo, useState } from "react";

// The banner over the picklist: who leads the event, where we sit, and which
// partner adds the most to us — the three things a strategy lead says out
// loud before alliance selection — over a "feather" of every team's points.

const FEATHER_W = 640;
const FEATHER_H = 180;
const ORIGIN = { x: 24, y: 164 };

function fmt(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

export function ordinal(n: number): string {
  const tail = n % 100;
  if (tail >= 11 && tail <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** Every team is a feather: longer and higher means more points per match. */
function Feather({
  rows,
  ourTeam,
  highlight,
}: {
  rows: readonly PickRow[];
  ourTeam: number | null;
  highlight: ReadonlySet<number>;
}) {
  const [hover, setHover] = useState<PickRow | null>(null);
  const known = rows
    .filter((r) => r.points !== null)
    .sort((a, b) => (a.points ?? 0) - (b.points ?? 0));
  const max = Math.max(1, ...known.map((r) => r.points ?? 0));
  const byPoints = [...known].sort((a, b) => (b.points ?? 0) - (a.points ?? 0));
  const pointsRank = new Map(byPoints.map((r, i) => [r.teamNumber, i + 1]));

  // Length is points; height is rank, so the barbs fan out instead of
  // stacking on top of each other where the field is close.
  const tip = (row: PickRow) => {
    const frac = (row.points ?? 0) / max;
    const rankFrac =
      known.length > 1 ? ((pointsRank.get(row.teamNumber) ?? 1) - 1) / (known.length - 1) : 0;
    return {
      x: ORIGIN.x + 40 + frac * (FEATHER_W - ORIGIN.x - 110),
      y: 14 + rankFrac * (ORIGIN.y - 40),
    };
  };

  return (
    <div className="relative w-full">
      <svg
        viewBox={`0 0 ${FEATHER_W} ${FEATHER_H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Points per match for every team at the event"
      >
        {known.map((row) => {
          const end = tip(row);
          const ours = row.teamNumber === ourTeam;
          const lit = highlight.has(row.teamNumber);
          const control = { x: end.x * 0.55, y: ORIGIN.y - 4 };
          return (
            <g key={row.teamNumber}>
              <path
                d={`M ${ORIGIN.x} ${ORIGIN.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`}
                fill="none"
                stroke={ours ? "#f5b544" : lit ? "#d8737d" : "#b3b7bb"}
                strokeOpacity={ours || lit ? 1 : 0.35}
                strokeWidth={ours || lit ? 2 : 1}
              />
              {/* A fat invisible twin so a one-pixel line is still hoverable. */}
              <path
                d={`M ${ORIGIN.x} ${ORIGIN.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`}
                fill="none"
                stroke="transparent"
                strokeWidth={8}
                onMouseEnter={() => setHover(row)}
                onMouseLeave={() => setHover(null)}
              />
              {(ours || lit) && (
                <text
                  x={end.x + 6}
                  y={end.y + 4}
                  fontSize={12}
                  className="stat"
                  fill={ours ? "#f5b544" : "#f4f4f5"}
                >
                  {row.teamNumber}
                  {ours ? `, ${ordinal(pointsRank.get(row.teamNumber) ?? 0)}` : ""}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-md border border-white/15 bg-[#232629] px-3 py-2 text-xs text-white">
          <p className="stat font-semibold">
            {hover.teamNumber}, {ordinal(pointsRank.get(hover.teamNumber) ?? 0)} of {known.length}
          </p>
          <p className="flex justify-between gap-4 text-white/60">
            Expected points <span className="stat text-white">{fmt(hover.points)}</span>
          </p>
          <p className="flex justify-between gap-4 text-white/60">
            Reliability <span className="stat text-white">{hover.reliability ?? "—"}</span>
          </p>
          <p className="flex justify-between gap-4 text-white/60">
            Role <span className="text-white">{hover.role}</span>
          </p>
        </div>
      )}
    </div>
  );
}

export function PicklistHero({
  data,
  rows,
}: {
  data: PickBoardData;
  /** Scored rows (any weights) — the hero only reads points off them. */
  rows: readonly PickRow[];
}) {
  const { event, submissions, ourTeam, stats } = data;

  const byPoints = useMemo(
    () =>
      rows
        .filter((r) => r.points !== null)
        .sort((a, b) => (b.points ?? 0) - (a.points ?? 0)),
    [rows],
  );
  const leader = byPoints[0] ?? null;
  const ourIndex = byPoints.findIndex((r) => r.teamNumber === ourTeam);
  const ours = ourIndex >= 0 ? byPoints[ourIndex] : null;

  // The partner who adds the most to us, by the same simulation the Alliance
  // lab's partner finder runs — bad days count.
  const bestPartner = useMemo(() => {
    const us = stats.find((s) => s.teamNumber === ourTeam);
    if (!us) return null;
    const others = stats.filter(
      (s) => s.teamNumber !== ourTeam && !data.taken.has(s.teamNumber),
    );
    return rankPartners([us], others, 300)[0]?.teamNumber ?? null;
  }, [stats, ourTeam, data.taken]);

  const counts = useMemo(() => {
    const quals = (event?.matches ?? []).filter(
      (m) => m.compLevel === "qm" && m.redScore !== null,
    ).length;
    const scouts = new Set(submissions.map((s) => s.scoutName).filter(Boolean)).size;
    return [
      { label: "teams", value: event?.teams.length ?? 0 },
      { label: "scouting entries", value: submissions.length },
      { label: "quals played", value: quals },
      { label: "scouts", value: scouts },
    ];
  }, [event, submissions]);

  const highlight = useMemo(
    () => new Set(byPoints.slice(0, 3).map((r) => r.teamNumber)),
    [byPoints],
  );

  if (!event) return null;

  return (
    <section className="grid gap-4 overflow-hidden rounded-lg border border-[#33373a] bg-[#17181a] p-5 text-white md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] md:p-6">
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-maroon-300">
            {ourTeam ? `Team ${ourTeam} picklist` : "Picklist"}
          </p>
          <h2 className="mt-1 text-xl font-semibold leading-tight">{event.eventName}</h2>
        </div>
        {leader ? (
          <p className="max-w-md text-sm leading-relaxed text-white/80">
            <Link href={`/teams/${leader.teamNumber}`} className="stat font-semibold text-[#f5b544] hover:underline">
              {leader.teamNumber}
            </Link>{" "}
            leads at <span className="stat text-white">{fmt(leader.points)}</span> points a match.
            {ours && (
              <>
                {" "}We&apos;re {ordinal(ourIndex + 1)} at{" "}
                <span className="stat text-white">{fmt(ours.points)}</span>
              </>
            )}
            {ours && bestPartner !== null && (
              <>
                , and the partner who adds the most to us is{" "}
                <Link href={`/teams/${bestPartner}`} className="stat font-semibold text-[#f5b544] hover:underline">
                  {bestPartner}
                </Link>
              </>
            )}
            {ours ? "." : ""}
          </p>
        ) : (
          <p className="text-sm text-white/60">
            No points to rank yet — scout a few matches or sync EPA on the Event tab.
          </p>
        )}
        <dl className="flex flex-wrap gap-x-5 gap-y-2">
          {counts.map((c) => (
            <div key={c.label} className="flex items-baseline gap-1.5">
              <dd className="stat text-lg font-semibold">{c.value}</dd>
              <dt className="text-xs text-white/55">{c.label}</dt>
            </div>
          ))}
        </dl>
        {ours && (
          <p className="text-sm text-white/60">
            <span className="stat text-2xl font-semibold text-white">{ourIndex + 1}</span>{" "}
            of {byPoints.length} is where {ourTeam} ranks
          </p>
        )}
      </div>
      <div className="flex flex-col justify-between gap-2">
        <Feather rows={rows} ourTeam={ourTeam} highlight={highlight} />
        <p className="text-right text-xs text-white/45">
          Every team is a feather: longer means more points per match. Hover one.
        </p>
      </div>
    </section>
  );
}
