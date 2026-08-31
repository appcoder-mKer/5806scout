import { describe, expect, it } from "vitest";
import type { FormSection } from "./formSchema";
import {
  ALWAYS_ON_COLUMNS,
  availablePicklistColumns,
  comparePicklistRows,
  DEFAULT_PICKLIST_COLUMN_IDS,
  picklistSortValue,
  resolvePicklistColumns,
  sanitizePicklistColumnIds,
  type PicklistColumn,
  type PicklistRow,
} from "./picklistColumns";

const sections: readonly FormSection[] = [
  {
    title: "Teleop",
    fields: [
      { kind: "counter", id: "teleopScoredFuel", label: "Fuel scored" },
      { kind: "counter", id: "defenseSeconds", label: "Defense played (sec)" },
      { kind: "textarea", id: "notes", label: "Notes" },
    ],
  },
  {
    title: "Endgame",
    fields: [
      {
        kind: "select",
        id: "endgame",
        label: "Tower climb",
        options: ["None", "Level 1"],
      },
    ],
  },
];

function row(partial: Partial<PicklistRow> & { teamNumber: number }): PicklistRow {
  return {
    rank: null,
    name: null,
    eventRank: null,
    epa: null,
    avgAuto: null,
    avgTeleop: null,
    matches: 0,
    averages: null,
    modes: null,
    note: "",
    ...partial,
  };
}

function byId(columns: readonly PicklistColumn[], id: string): PicklistColumn {
  const found = columns.find((column) => column.id === id);
  if (!found) throw new Error(`no column ${id}`);
  return found;
}

describe("availablePicklistColumns", () => {
  it("offers one average per counter and one mode per select", () => {
    const ids = availablePicklistColumns(sections).map((c) => c.id);
    expect(ids).toContain("avg:teleopScoredFuel");
    expect(ids).toContain("avg:defenseSeconds");
    expect(ids).toContain("mode:endgame");
  });

  it("ignores field kinds that produce no per-team metric", () => {
    const ids = availablePicklistColumns(sections).map((c) => c.id);
    // A textarea is never aggregated, so it can't be a column.
    expect(ids).not.toContain("avg:notes");
    expect(ids).not.toContain("mode:notes");
  });

  it("labels a metric with the section it came from", () => {
    const column = byId(availablePicklistColumns(sections), "avg:defenseSeconds");
    expect(column.fullLabel).toBe("Teleop: Defense played (sec) (average per match)");
    expect(column.section).toBe("Teleop");
  });

  it("follows the schema, so a question added in Form Setup appears", () => {
    const withCustom: readonly FormSection[] = [
      ...sections,
      {
        title: "Team Questions",
        fields: [{ kind: "counter", id: "custom_cycles", label: "Cycles" }],
      },
    ];
    expect(availablePicklistColumns(withCustom).map((c) => c.id)).toContain(
      "avg:custom_cycles",
    );
  });
});

describe("resolvePicklistColumns", () => {
  it("always leads with team, name, and my rank", () => {
    const ids = resolvePicklistColumns(sections, []).map((c) => c.id);
    expect(ids).toEqual(ALWAYS_ON_COLUMNS.map((c) => c.id));
  });

  it("falls back to the default set when never configured", () => {
    const ids = resolvePicklistColumns(sections, undefined).map((c) => c.id);
    expect(ids).toContain("eventRank");
    expect(ids).toContain("mode:endgame");
    // driverSkill isn't in this test schema, so the default id resolves to
    // nothing — the table degrades rather than rendering an empty column.
    expect(ids).not.toContain("avg:driverSkill");
  });

  it("drops a column whose question was deleted from Match Scouting", () => {
    const ids = resolvePicklistColumns(sections, [
      "avg:teleopScoredFuel",
      "avg:gone",
      "mode:endgame",
    ]).map((c) => c.id);
    expect(ids).toEqual([
      ...ALWAYS_ON_COLUMNS.map((c) => c.id),
      "avg:teleopScoredFuel",
      "mode:endgame",
    ]);
  });

  it("keeps the saved order and de-duplicates", () => {
    const ids = resolvePicklistColumns(sections, [
      "matches",
      "epa",
      "matches",
    ]).map((c) => c.id);
    expect(ids.slice(ALWAYS_ON_COLUMNS.length)).toEqual(["matches", "epa"]);
  });

  it("resolves every default id against the real season schema", () => {
    // Guards the defaults against a typo: with the full schema they must all
    // resolve, or the table would silently lose a column it used to have.
    const full: readonly FormSection[] = [
      {
        title: "Post-Match",
        fields: [
          { kind: "counter", id: "driverSkill", label: "Driver skill (0-5)" },
          { kind: "counter", id: "defenseSkill", label: "Defense skill (0-5)" },
        ],
      },
      ...sections,
    ];
    const ids = resolvePicklistColumns(full, DEFAULT_PICKLIST_COLUMN_IDS).map(
      (c) => c.id,
    );
    expect(ids.slice(ALWAYS_ON_COLUMNS.length)).toEqual([
      ...DEFAULT_PICKLIST_COLUMN_IDS,
    ]);
  });
});

describe("sanitizePicklistColumnIds", () => {
  it("reads undefined for anything that isn't a list", () => {
    expect(sanitizePicklistColumnIds(undefined)).toBeUndefined();
    expect(sanitizePicklistColumnIds("epa")).toBeUndefined();
    expect(sanitizePicklistColumnIds({ 0: "epa" })).toBeUndefined();
  });

  it("keeps an empty list distinct from never-configured", () => {
    expect(sanitizePicklistColumnIds([])).toEqual([]);
  });

  it("drops entries that aren't non-empty strings", () => {
    expect(sanitizePicklistColumnIds(["epa", 7, "", null, "matches"])).toEqual([
      "epa",
      "matches",
    ]);
  });
});

describe("picklistSortValue", () => {
  const columns = availablePicklistColumns(sections);

  it("reads a counter average and a select mode off the row", () => {
    const r = row({
      teamNumber: 5806,
      averages: { teleopScoredFuel: 12.5 },
      modes: { endgame: "Level 1" },
    });
    expect(picklistSortValue(byId(columns, "avg:teleopScoredFuel"), r)).toBe(12.5);
    expect(picklistSortValue(byId(columns, "mode:endgame"), r)).toBe("Level 1");
  });

  it("is null for an unscouted team rather than zero", () => {
    const r = row({ teamNumber: 5806 });
    expect(picklistSortValue(byId(columns, "avg:teleopScoredFuel"), r)).toBeNull();
  });

  it("never sorts the notes column", () => {
    expect(byId(columns, "notes").sortable).toBe(false);
  });
});

describe("comparePicklistRows", () => {
  const column = byId(availablePicklistColumns(sections), "avg:teleopScoredFuel");
  const rows = [
    row({ teamNumber: 1, averages: { teleopScoredFuel: 5 } }),
    row({ teamNumber: 2 }),
    row({ teamNumber: 3, averages: { teleopScoredFuel: 20 } }),
    row({ teamNumber: 4, averages: { teleopScoredFuel: 12 } }),
  ];

  it("orders ascending with unscouted teams last", () => {
    expect(
      [...rows].sort(comparePicklistRows(column, "asc")).map((r) => r.teamNumber),
    ).toEqual([1, 4, 3, 2]);
  });

  it("orders descending with unscouted teams still last", () => {
    expect(
      [...rows].sort(comparePicklistRows(column, "desc")).map((r) => r.teamNumber),
    ).toEqual([3, 4, 1, 2]);
  });

  it("breaks ties by team number so the order is stable to look at", () => {
    const tied = [
      row({ teamNumber: 30, averages: { teleopScoredFuel: 4 } }),
      row({ teamNumber: 10, averages: { teleopScoredFuel: 4 } }),
    ];
    expect(
      tied.sort(comparePicklistRows(column, "desc")).map((r) => r.teamNumber),
    ).toEqual([10, 30]);
  });

  it("compares text columns as text", () => {
    const name = byId(ALWAYS_ON_COLUMNS, "name");
    const named = [
      row({ teamNumber: 1, name: "Zebra" }),
      row({ teamNumber: 2, name: "Alpha" }),
    ];
    expect(
      named.sort(comparePicklistRows(name, "asc")).map((r) => r.name),
    ).toEqual(["Alpha", "Zebra"]);
  });

  it("leaves the saved ranking untouched — it only reorders a copy", () => {
    const original = [...rows];
    [...rows].sort(comparePicklistRows(column, "desc"));
    expect(rows).toEqual(original);
  });
});
