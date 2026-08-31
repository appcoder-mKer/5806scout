"use client";

// Column sort controls, shared by the Data tab's tables and the Picklist.
// Kept in one place so the two never drift: the same arrows, the same
// "press the active arrow to clear", the same aria-sort on the header.

export type SortDir = "asc" | "desc";

/**
 * Which column a table is ordered by; null means the table's natural order.
 * On the Picklist that natural order is the team's saved ranking, so clearing
 * the sort is how you get back to the picklist proper.
 */
export interface Sort {
  key: string;
  dir: SortDir;
}

/**
 * Up/down arrows that set the sort direction for one column. Pressing the
 * arrow that's already active clears the sort — it's the only way back to the
 * table's natural order.
 */
export function SortArrows({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: string;
  sort: Sort | null;
  onSort: (next: Sort | null) => void;
}) {
  const active = sort?.key === sortKey ? sort.dir : null;
  return (
    <span className="ml-1 inline-flex flex-col leading-[0.6]">
      {(["asc", "desc"] as const).map((dir) => (
        <button
          key={dir}
          type="button"
          aria-pressed={active === dir}
          aria-label={`Sort by ${label} ${
            dir === "asc" ? "ascending" : "descending"
          }`}
          onClick={() => onSort(active === dir ? null : { key: sortKey, dir })}
          title={`Sort ${label} ${dir === "asc" ? "ascending" : "descending"}`}
          className={`px-0.5 text-[9px] transition ${
            active === dir
              ? "text-maroon-600 dark:text-maroon-400"
              : "text-graphite-300 hover:text-graphite-600"
          }`}
        >
          <span aria-hidden>{dir === "asc" ? "▲" : "▼"}</span>
        </button>
      ))}
    </span>
  );
}

/** A column header with its sort controls. */
export function SortableTh({
  label,
  sortKey,
  sort,
  onSort,
  title,
}: {
  label: string;
  sortKey: string;
  sort: Sort | null;
  onSort: (next: Sort | null) => void;
  /** Longer description, when the header is abbreviated to fit. */
  title?: string;
}) {
  const active = sort?.key === sortKey ? sort.dir : null;
  return (
    <th
      className="px-3 py-2.5"
      aria-sort={
        active === "asc"
          ? "ascending"
          : active === "desc"
            ? "descending"
            : "none"
      }
    >
      <span className="inline-flex items-center whitespace-nowrap" title={title}>
        {label}
        <SortArrows
          label={label}
          sortKey={sortKey}
          sort={sort}
          onSort={onSort}
        />
      </span>
    </th>
  );
}
