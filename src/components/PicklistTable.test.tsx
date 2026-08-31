import { vi } from "vitest";

// The reliability triangle beside each team number reaches Firestore for its
// flags; the table itself never does. Stub the handle so this stays a render
// test (an unflagged team renders no triangle, which is the default here).
vi.mock("@/lib/firebase/client", () => ({ db: {} }));

import { resolvePicklistColumns, type PicklistRow } from "@/lib/picklistColumns";
import type { FormSection } from "@/lib/formSchema";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PicklistTable } from "./PicklistTable";

const sections: readonly FormSection[] = [
  {
    title: "Teleop",
    fields: [{ kind: "counter", id: "teleopScoredFuel", label: "Fuel scored" }],
  },
];

const columns = resolvePicklistColumns(sections, ["avg:teleopScoredFuel"]);

function row(
  teamNumber: number,
  rank: number | null,
  fuel: number | null,
): PicklistRow {
  return {
    teamNumber,
    rank,
    name: `Team ${teamNumber}`,
    eventRank: null,
    epa: null,
    avgAuto: null,
    avgTeleop: null,
    matches: fuel === null ? 0 : 4,
    averages: fuel === null ? null : { teleopScoredFuel: fuel },
    modes: null,
    note: "",
  };
}

// Ranks 1..3, but the weakest scorer is ranked first — so a sort by fuel puts
// the rows on screen in an order that disagrees with My rank. That gap is the
// whole point of the feature, and what these tests guard.
const ranked = [row(111, 1, 2), row(222, 2, 30), row(333, 3, 16)];
const sortedByFuel = [ranked[1], ranked[2], ranked[0]];

function rankInputs(): HTMLInputElement[] {
  return screen.getAllByRole("spinbutton") as HTMLInputElement[];
}

describe("PicklistTable", () => {
  it("shows each team's rank in the saved order, not its row position", async () => {
    render(
      <PicklistTable
        columns={columns}
        rows={sortedByFuel}
        sort={{ key: "avg:teleopScoredFuel", dir: "desc" }}
        onSort={vi.fn()}
        isAdmin
        draggable={false}
        onRankChange={vi.fn()}
        onNoteChange={vi.fn()}
        rankCount={3}
      />,
    );
    // Displayed top-to-bottom as 222, 333, 111 — but their ranks stay 2, 3, 1.
    expect(rankInputs().map((input) => input.value)).toEqual(["2", "3", "1"]);
  });

  it("reports the rank the user typed, not the sorted row index", async () => {
    const onRankChange = vi.fn();
    render(
      <PicklistTable
        columns={columns}
        rows={sortedByFuel}
        sort={{ key: "avg:teleopScoredFuel", dir: "desc" }}
        onSort={vi.fn()}
        isAdmin
        draggable={false}
        onRankChange={onRankChange}
        onNoteChange={vi.fn()}
        rankCount={3}
      />,
    );
    // Top row on screen is team 222, sitting at rank 2. Promote it to 1.
    const input = screen.getByLabelText("My rank for team 222");
    await userEvent.clear(input);
    await userEvent.type(input, "1");
    await userEvent.tab();
    expect(onRankChange).toHaveBeenCalledExactlyOnceWith(222, 1);
  });

  it("does not write when the typed rank is unchanged", async () => {
    const onRankChange = vi.fn();
    render(
      <PicklistTable
        columns={columns}
        rows={ranked}
        sort={null}
        isAdmin
        draggable
        onRankChange={onRankChange}
        onNoteChange={vi.fn()}
        rankCount={3}
      />,
    );
    const input = screen.getByLabelText("My rank for team 222");
    await userEvent.clear(input);
    await userEvent.type(input, "2");
    await userEvent.tab();
    expect(onRankChange).not.toHaveBeenCalled();
  });

  it("reverts a blank entry rather than moving the team", async () => {
    const onRankChange = vi.fn();
    render(
      <PicklistTable
        columns={columns}
        rows={ranked}
        sort={null}
        isAdmin
        draggable
        onRankChange={onRankChange}
        onNoteChange={vi.fn()}
        rankCount={3}
      />,
    );
    const input = screen.getByLabelText<HTMLInputElement>(
      "My rank for team 333",
    );
    await userEvent.clear(input);
    await userEvent.tab();
    expect(onRankChange).not.toHaveBeenCalled();
    expect(input.value).toBe("3");
  });

  it("gives scouts the rank as text, with no way to edit it", () => {
    render(
      <PicklistTable
        columns={columns}
        rows={ranked}
        sort={null}
        isAdmin={false}
        onNoteChange={vi.fn()}
        rankCount={3}
      />,
    );
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders the columns it is given, and only those", () => {
    render(
      <PicklistTable
        columns={columns}
        rows={ranked}
        sort={null}
        isAdmin
        onNoteChange={vi.fn()}
        rankCount={3}
      />,
    );
    expect(
      screen.getByRole("columnheader", { name: /Avg fuel scored/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: /EPA/i })).toBeNull();
    // The metric each team actually scored.
    expect(screen.getByText("30.0")).toBeInTheDocument();
  });

  it("omits the rank cell for a Do Not Pick team, which has no rank", () => {
    render(
      <PicklistTable
        columns={columns}
        rows={[row(444, null, 5)]}
        sort={null}
        isAdmin
        onRankChange={vi.fn()}
        onNoteChange={vi.fn()}
      />,
    );
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("only offers drag-to-reorder when the table is in rank order", () => {
    const { rerender, container } = render(
      <PicklistTable
        columns={columns}
        rows={ranked}
        sort={null}
        isAdmin
        draggable
        onDropRow={vi.fn()}
        onRankChange={vi.fn()}
        onNoteChange={vi.fn()}
        rankCount={3}
      />,
    );
    expect(container.querySelectorAll('tr[draggable="true"]')).toHaveLength(3);

    rerender(
      <PicklistTable
        columns={columns}
        rows={sortedByFuel}
        sort={{ key: "avg:teleopScoredFuel", dir: "desc" }}
        onSort={vi.fn()}
        isAdmin
        draggable={false}
        onDropRow={vi.fn()}
        onRankChange={vi.fn()}
        onNoteChange={vi.fn()}
        rankCount={3}
      />,
    );
    expect(container.querySelectorAll('tr[draggable="true"]')).toHaveLength(0);
  });
});
