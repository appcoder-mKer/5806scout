import { counterFieldIds, selectFieldIds } from "@/lib/aggregate";
import type { FormSection } from "@/lib/formSchema";

// Which columns the Picklist table shows, and how each one sorts.
//
// The metric columns are NOT a fixed list: they are derived from the team's
// effective Match Scout schema (useScoutForms -> config/scoutForms), so a
// question added, struck, or deleted in Form Setup changes what Picklist
// Settings offers on every open client, with no rebuild and no migration.
// Every counter becomes a per-match average; every select becomes the team's
// most common answer — the same two things aggregateByTeam already computes.

export type PicklistColumnKind =
  | "team"
  | "name"
  | "myRank"
  | "eventRank"
  | "epa"
  | "avgAuto"
  | "avgTeleop"
  | "matches"
  | "notes"
  | "avg"
  | "mode";

export interface PicklistColumn {
  /** Stable id stored in PicklistDoc.columns. */
  id: string;
  /** Short header text. */
  label: string;
  /** "Section: Label" — the tooltip, and how Picklist Settings lists it. */
  fullLabel: string;
  kind: PicklistColumnKind;
  /** Set for kinds "avg" and "mode" — the schema field this column reads. */
  fieldId?: string;
  /** Renders in the monospace stat font (DESIGN.md's Telemetry Rule). */
  numeric: boolean;
  sortable: boolean;
  /** The Match Scout section this metric came from; absent for fixed columns. */
  section?: string;
}

/** Prefixes that keep schema-derived ids from colliding with the fixed ones. */
const AVG_PREFIX = "avg:";
const MODE_PREFIX = "mode:";

/**
 * Always on the table, never in the Settings checklist. Team and Name are how
 * you find a row at all; My Rank is the picklist itself.
 */
export const ALWAYS_ON_COLUMNS: readonly PicklistColumn[] = [
  { id: "team", label: "Team", fullLabel: "Team number", kind: "team", numeric: true, sortable: true },
  { id: "name", label: "Name", fullLabel: "Team name", kind: "name", numeric: false, sortable: true },
  { id: "myRank", label: "My rank", fullLabel: "My rank", kind: "myRank", numeric: true, sortable: true },
];

/** The optional non-schema columns, in the order they render. */
const FIXED_OPTIONAL_COLUMNS: readonly PicklistColumn[] = [
  { id: "eventRank", label: "Event rank", fullLabel: "Event rank", kind: "eventRank", numeric: true, sortable: true },
  { id: "epa", label: "EPA", fullLabel: "EPA (Statbotics)", kind: "epa", numeric: true, sortable: true },
  { id: "avgAuto", label: "Avg auto", fullLabel: "Avg auto scored", kind: "avgAuto", numeric: true, sortable: true },
  { id: "avgTeleop", label: "Avg teleop", fullLabel: "Avg teleop scored", kind: "avgTeleop", numeric: true, sortable: true },
  { id: "matches", label: "Matches", fullLabel: "Matches scouted", kind: "matches", numeric: true, sortable: true },
  // Free text — sorting a column of paragraphs helps nobody.
  { id: "notes", label: "Notes", fullLabel: "Notes", kind: "notes", numeric: false, sortable: false },
];

/**
 * Today's table, exactly. A team that never opens Picklist Settings must see
 * no change, so this list reproduces the previously hardcoded headers.
 */
export const DEFAULT_PICKLIST_COLUMN_IDS: readonly string[] = [
  "eventRank",
  "epa",
  "avgAuto",
  "avgTeleop",
  `${MODE_PREFIX}endgame`,
  `${AVG_PREFIX}driverSkill`,
  `${AVG_PREFIX}defenseSkill`,
  "matches",
  "notes",
];

function labelsBySection(
  sections: readonly FormSection[],
): Map<string, { label: string; section: string }> {
  const map = new Map<string, { label: string; section: string }>();
  for (const section of sections) {
    for (const field of section.fields) {
      map.set(field.id, { label: field.label, section: section.title });
    }
  }
  return map;
}

/**
 * Every column this team could put on the picklist: the fixed ones, then one
 * per counter (its per-match average) and one per select (its most common
 * answer), in schema order.
 */
export function availablePicklistColumns(
  sections: readonly FormSection[],
): PicklistColumn[] {
  const labels = labelsBySection(sections);
  const describe = (
    fieldId: string,
    prefix: string,
    kind: "avg" | "mode",
    suffix: string,
  ): PicklistColumn => {
    const found = labels.get(fieldId);
    const label = found?.label ?? fieldId;
    const section = found?.section ?? "";
    return {
      id: `${prefix}${fieldId}`,
      label: kind === "avg" ? `Avg ${label.toLowerCase()}` : label,
      fullLabel: `${section ? `${section}: ` : ""}${label}${suffix}`,
      kind,
      fieldId,
      numeric: kind === "avg",
      sortable: true,
      section,
    };
  };

  return [
    ...FIXED_OPTIONAL_COLUMNS,
    ...counterFieldIds(sections).map((id) =>
      describe(id, AVG_PREFIX, "avg", " (average per match)"),
    ),
    ...selectFieldIds(sections).map((id) =>
      describe(id, MODE_PREFIX, "mode", " (most common answer)"),
    ),
  ];
}

/**
 * The columns to render: the always-on three, then the saved selection in the
 * saved order. Ids whose question no longer exists are dropped here, which is
 * how deleting a Match Scout question removes its column everywhere without a
 * migration. `undefined` (never configured) falls back to the default set.
 */
export function resolvePicklistColumns(
  sections: readonly FormSection[],
  savedIds: readonly string[] | undefined,
): PicklistColumn[] {
  const available = new Map(
    availablePicklistColumns(sections).map((column) => [column.id, column]),
  );
  const wanted = savedIds ?? DEFAULT_PICKLIST_COLUMN_IDS;
  const seen = new Set<string>();
  const chosen: PicklistColumn[] = [];
  for (const id of wanted) {
    const column = available.get(id);
    if (!column || seen.has(id)) continue;
    seen.add(id);
    chosen.push(column);
  }
  return [...ALWAYS_ON_COLUMNS, ...chosen];
}

/**
 * Parse PicklistDoc.columns. Any teammate can write this doc (see the
 * subcollection wildcard in firestore.rules), so the shape is re-checked on
 * read rather than trusted — the same discipline as sanitizeScoutFormsConfig.
 * Returns undefined for "never configured", which means the defaults.
 */
export function sanitizePicklistColumnIds(
  value: unknown,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((id): id is string => typeof id === "string" && id !== "");
}

/** One row's worth of everything a column might display or sort by. */
export interface PicklistRow {
  teamNumber: number;
  /** 1-based position in the saved ranking; null for a Do Not Pick team. */
  rank: number | null;
  name: string | null;
  eventRank: number | null;
  epa: number | null;
  avgAuto: number | null;
  avgTeleop: number | null;
  matches: number;
  /** Per-match averages by counter field id; absent when never scouted. */
  averages: Readonly<Record<string, number>> | null;
  /** Most common answer by select field id. */
  modes: Readonly<Record<string, string | null>> | null;
  note: string;
}

/**
 * What a column sorts on. null means "no value" — an unscouted team, a rank
 * the event hasn't published — and always sinks to the bottom, in either
 * direction, rather than pretending to be a zero.
 */
export function picklistSortValue(
  column: PicklistColumn,
  row: PicklistRow,
): number | string | null {
  switch (column.kind) {
    case "team":
      return row.teamNumber;
    case "name":
      return row.name;
    case "myRank":
      return row.rank;
    case "eventRank":
      return row.eventRank;
    case "epa":
      return row.epa;
    case "avgAuto":
      return row.avgAuto;
    case "avgTeleop":
      return row.avgTeleop;
    case "matches":
      return row.matches;
    case "avg":
      return row.averages?.[column.fieldId ?? ""] ?? null;
    case "mode":
      return row.modes?.[column.fieldId ?? ""] ?? null;
    case "notes":
      return null;
  }
}

/**
 * A comparator for one column. Sorting is a display lens only — nothing here
 * touches the saved ranking.
 */
export function comparePicklistRows(
  column: PicklistColumn,
  dir: "asc" | "desc",
): (a: PicklistRow, b: PicklistRow) => number {
  const factor = dir === "asc" ? 1 : -1;
  return (a, b) => {
    const left = picklistSortValue(column, a);
    const right = picklistSortValue(column, b);
    // Missing values sink regardless of direction.
    if (left === null && right === null) return a.teamNumber - b.teamNumber;
    if (left === null) return 1;
    if (right === null) return -1;
    if (typeof left === "number" && typeof right === "number") {
      return factor * (left - right) || a.teamNumber - b.teamNumber;
    }
    return (
      factor * String(left).localeCompare(String(right)) ||
      a.teamNumber - b.teamNumber
    );
  };
}
