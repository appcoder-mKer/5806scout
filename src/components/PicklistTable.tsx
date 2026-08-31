"use client";

import { ReliabilityWarning } from "@/components/ReliabilityFlags";
import { SortableTh, type Sort } from "@/components/SortableTh";
import type { PicklistColumn, PicklistRow } from "@/lib/picklistColumns";
import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";

// The picklist table, rendered from a column list rather than hardcoded
// headers — so the ranked list and the Do Not Pick list below it can never
// drift apart again, and Picklist Settings can change both at once.

function statCell(value: number | null, digits = 1): string {
  return value === null ? "—" : value.toFixed(digits);
}

export function PicklistTable({
  columns,
  rows,
  sort,
  onSort,
  isAdmin,
  draggable,
  onDropRow,
  onRankChange,
  onNoteChange,
  renderActions,
  rankCount,
  emptyMessage,
}: {
  columns: readonly PicklistColumn[];
  /** Already in display order — sorted by the page, or the ranking itself. */
  rows: readonly PicklistRow[];
  sort: Sort | null;
  onSort?: (next: Sort | null) => void;
  isAdmin: boolean;
  /** Off whenever a sort is applied: under one, the row above is no longer
   *  the rank above, so dropping a row somewhere would mean nothing. */
  draggable?: boolean;
  onDropRow?: (from: number, to: number) => void;
  onRankChange?: (teamNumber: number, rank: number) => void;
  onNoteChange: (teamNumber: number, text: string) => void;
  renderActions?: (row: PicklistRow) => ReactNode;
  /** How many teams are in the ranking, for the rank input's upper bound. */
  rankCount?: number;
  emptyMessage?: string;
}) {
  const dragFrom = useRef<number | null>(null);
  const canDrag = Boolean(draggable && isAdmin && onDropRow);

  return (
    <table className="data-table">
      <thead>
        <tr>
          {columns.map((column) =>
            column.sortable && onSort ? (
              <SortableTh
                key={column.id}
                label={column.label}
                title={column.fullLabel}
                sortKey={column.id}
                sort={sort}
                onSort={onSort}
              />
            ) : (
              <th key={column.id} className="px-3 py-2.5" title={column.fullLabel}>
                {column.label}
              </th>
            ),
          )}
          {renderActions && <th className="px-3 py-2.5" aria-label="Actions" />}
        </tr>
      </thead>
      <tbody className="divide-y divide-graphite-100">
        {rows.map((row, index) => (
          <tr
            key={row.teamNumber}
            draggable={canDrag}
            onDragStart={() => {
              dragFrom.current = index;
            }}
            onDragOver={(e) => {
              if (canDrag) e.preventDefault();
            }}
            onDrop={() => {
              if (
                canDrag &&
                dragFrom.current !== null &&
                dragFrom.current !== index
              ) {
                onDropRow?.(dragFrom.current, index);
              }
              dragFrom.current = null;
            }}
            className="transition hover:bg-graphite-50"
          >
            {columns.map((column) => (
              <td
                key={column.id}
                className={`px-3 py-2 ${column.numeric ? "stat" : ""}`}
              >
                <Cell
                  column={column}
                  row={row}
                  isAdmin={isAdmin}
                  rankCount={rankCount}
                  onRankChange={onRankChange}
                  onNoteChange={onNoteChange}
                />
              </td>
            ))}
            {renderActions && (
              <td className="px-3 py-2">{renderActions(row)}</td>
            )}
          </tr>
        ))}
        {rows.length === 0 && emptyMessage && (
          <tr>
            <td
              colSpan={columns.length + (renderActions ? 1 : 0)}
              className="px-3 py-8 text-center text-graphite-400"
            >
              {emptyMessage}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function Cell({
  column,
  row,
  isAdmin,
  rankCount,
  onRankChange,
  onNoteChange,
}: {
  column: PicklistColumn;
  row: PicklistRow;
  isAdmin: boolean;
  rankCount?: number;
  onRankChange?: (teamNumber: number, rank: number) => void;
  onNoteChange: (teamNumber: number, text: string) => void;
}) {
  switch (column.kind) {
    case "team":
      return (
        <span className="inline-flex items-center gap-1.5">
          <Link
            href={`/teams/${row.teamNumber}`}
            // Anchors drag themselves by default, which would hijack the
            // row's drag-to-reorder.
            draggable={false}
            className="font-semibold underline-offset-2 hover:text-maroon-600 hover:underline dark:hover:text-maroon-400"
            title={`Open ${row.teamNumber}'s summary`}
          >
            {row.teamNumber}
          </Link>
          <ReliabilityWarning teamNumber={row.teamNumber} />
        </span>
      );
    case "name":
      return (
        <Link
          href={`/teams/${row.teamNumber}`}
          draggable={false}
          className="text-left underline-offset-2 hover:text-maroon-600 hover:underline dark:hover:text-maroon-400"
          title={`Open ${row.teamNumber}'s summary`}
        >
          {row.name ?? "—"}
        </Link>
      );
    case "myRank":
      if (row.rank === null) return <>—</>;
      if (!isAdmin || !onRankChange) return <>{row.rank}</>;
      return (
        <RankInput
          teamNumber={row.teamNumber}
          rank={row.rank}
          max={rankCount ?? row.rank}
          onCommit={(next) => onRankChange(row.teamNumber, next)}
        />
      );
    case "eventRank":
      return <>{row.eventRank ?? "—"}</>;
    case "epa":
      return <>{statCell(row.epa)}</>;
    case "avgAuto":
      return <>{statCell(row.avgAuto)}</>;
    case "avgTeleop":
      return <>{statCell(row.avgTeleop)}</>;
    case "matches":
      return <>{row.matches}</>;
    case "avg":
      return <>{statCell(row.averages?.[column.fieldId ?? ""] ?? null)}</>;
    case "mode":
      return (
        <span className="text-graphite-600">
          {row.modes?.[column.fieldId ?? ""] ?? "—"}
        </span>
      );
    case "notes":
      return (
        <TeamNote
          teamNumber={row.teamNumber}
          saved={row.note}
          onSave={(text) => onNoteChange(row.teamNumber, text)}
        />
      );
  }
}

/**
 * The team's rank in our own picklist, typed directly. Kept as a local draft
 * while typing and committed on blur or Enter — the same discipline as
 * TeamNote, and for the same reason: the doc is under a live snapshot, so a
 * teammate reordering mid-keystroke would otherwise yank the value out from
 * under the caret.
 *
 * The value shown is always the rank in the saved order, never the row's
 * position on screen. Under a column sort those differ, which is the point:
 * you compare teams by a criterion and retype ranks against what you see.
 */
export function RankInput({
  teamNumber,
  rank,
  max,
  onCommit,
}: {
  teamNumber: number;
  rank: number;
  max: number;
  onCommit: (rank: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);

  function commit() {
    if (draft === null) return;
    const next = Number.parseInt(draft, 10);
    // A blank or unparseable entry reverts rather than moving the team
    // somewhere nobody asked for.
    if (Number.isFinite(next) && next !== rank) onCommit(next);
    setDraft(null);
  }

  return (
    <input
      type="number"
      inputMode="numeric"
      min={1}
      max={max}
      aria-label={`My rank for team ${teamNumber}`}
      value={draft ?? String(rank)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setDraft(null);
        }
      }}
      className="stat w-14 rounded border border-graphite-200 bg-transparent px-1.5 py-1 text-sm text-graphite-900 transition hover:border-graphite-300 focus:border-maroon-400 focus:outline-none"
    />
  );
}

/**
 * A team's picklist note. Kept as local draft state while typing and pushed
 * on blur, so a keystroke isn't a Firestore write and a remote edit can't
 * yank the caret mid-sentence.
 */
export function TeamNote({
  teamNumber,
  saved,
  onSave,
}: {
  teamNumber: number;
  saved: string;
  onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;
  return (
    <textarea
      aria-label={`Notes on team ${teamNumber}`}
      rows={2}
      value={value}
      placeholder="Notes…"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== saved) onSave(draft);
        setDraft(null);
      }}
      className="w-56 resize-y rounded border border-graphite-200 bg-transparent px-2 py-1 text-xs text-graphite-900 transition placeholder:text-graphite-400 hover:border-graphite-300 focus:border-maroon-400 focus:outline-none"
    />
  );
}
