"use client";

import { useAuth } from "@/lib/auth/AuthProvider";
import { db } from "@/lib/firebase/client";
import {
  addPicklistColumnId,
  ALWAYS_ON_COLUMNS,
  availablePicklistColumns,
  DEFAULT_PICKLIST_COLUMN_IDS,
  sanitizePicklistColumnIds,
  type PicklistColumn,
} from "@/lib/picklistColumns";
import { useScoutForms } from "@/lib/useScoutForms";
import { doc, onSnapshot, serverTimestamp, setDoc } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";

type Status =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved" }
  | { state: "error"; message: string };

/**
 * Which criteria the Picklist table shows. The metric list is not a fixed
 * menu — it is built from the team's live Match Scout schema, so adding,
 * striking, or deleting a question on the Match Scout tab changes what's on
 * offer here immediately, for everyone.
 *
 * Unlike its neighbours on this page, this writes teams/{profile.teamId},
 * NOT dataTeamId: the picklist is the one thing a sister pair does not share
 * (firestore.rules:155 blocks it by name), so its settings stay home too.
 */
export function PicklistSettings() {
  const { profile, user } = useAuth();
  const { matchSections } = useScoutForms();
  const teamId = profile?.teamId;

  const [saved, setSaved] = useState<string[] | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [status, setStatus] = useState<Status>({ state: "idle" });

  useEffect(() => {
    if (!teamId) return;
    return onSnapshot(doc(db, "teams", teamId, "config", "picklist"), (snap) =>
      setSaved(
        sanitizePicklistColumnIds(snap.data()?.columns) ?? [
          ...DEFAULT_PICKLIST_COLUMN_IDS,
        ],
      ),
    );
  }, [teamId]);

  const available = useMemo(
    () => availablePicklistColumns(matchSections),
    [matchSections],
  );
  // Edits stay local until Save, the same as the form tabs beside this one.
  const working = draft ?? saved;

  const groups = useMemo(() => {
    const fixed = available.filter((column) => !column.fieldId);
    const bySection = new Map<string, PicklistColumn[]>();
    for (const column of available) {
      if (!column.fieldId) continue;
      const title = column.section || "Other";
      bySection.set(title, [...(bySection.get(title) ?? []), column]);
    }
    return { fixed, bySection };
  }, [available]);

  function toggle(id: string) {
    if (!working) return;
    setDraft(
      working.includes(id)
        ? working.filter((chosen) => chosen !== id)
        : addPicklistColumnId(working, id),
    );
    if (status.state !== "idle") setStatus({ state: "idle" });
  }

  async function handleSave() {
    if (!working || !teamId || !user || !profile) return;
    setStatus({ state: "saving" });
    try {
      // Merge, always: the ranking, the Do Not Pick list, and every scout's
      // notes live on this same doc. A plain setDoc here would wipe them.
      await setDoc(
        doc(db, "teams", teamId, "config", "picklist"),
        {
          columns: working,
          updatedAt: serverTimestamp(),
          updatedByUid: user.uid,
          updatedByName: profile.fullName,
        },
        { merge: true },
      );
      setDraft(null);
      setStatus({ state: "saved" });
    } catch (err) {
      setStatus({
        state: "error",
        message: err instanceof Error ? err.message : "Save failed",
      });
    }
  }

  if (!working) {
    return (
      <div className="surface-panel px-6 py-10 text-center text-sm text-graphite-500">
        Loading your team&apos;s picklist settings…
      </div>
    );
  }

  const chosen = new Set(working);

  return (
    <section className="flex flex-col gap-5">
      <p className="surface-panel px-4 py-3 text-xs text-graphite-500">
        Team, name, and My rank are always shown — My rank is the picklist
        itself. Everything below is optional, and the metrics come straight
        from your Match Scout questions: add or delete one there and this list
        follows.
      </p>

      <div className="surface-card flex flex-col gap-2 p-4">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-maroon-700 dark:text-maroon-300">
          <span aria-hidden className="h-2.5 w-1 bg-maroon-600" />
          Table columns
        </h3>
        {groups.fixed.map((column) => (
          <ColumnCheckbox
            key={column.id}
            column={column}
            checked={chosen.has(column.id)}
            onToggle={() => toggle(column.id)}
          />
        ))}
      </div>

      {[...groups.bySection].map(([title, sectionColumns]) => (
        <div key={title} className="surface-card flex flex-col gap-2 p-4">
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-maroon-700 dark:text-maroon-300">
            <span aria-hidden className="h-2.5 w-1 bg-maroon-600" />
            {title}
          </h3>
          {sectionColumns.map((column) => (
            <ColumnCheckbox
              key={column.id}
              column={column}
              checked={chosen.has(column.id)}
              onToggle={() => toggle(column.id)}
            />
          ))}
        </div>
      ))}

      {groups.bySection.size === 0 && (
        <p className="rounded-lg border border-dashed border-graphite-300 bg-graphite-50 px-4 py-6 text-center text-sm text-graphite-500">
          No match scouting metrics yet — add a tally counter or a dropdown on
          the Match Scout tab and it will show up here.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={status.state === "saving" || draft === null}
          className="rounded-md bg-maroon-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-maroon-700 disabled:opacity-40"
        >
          {status.state === "saving" ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft([...DEFAULT_PICKLIST_COLUMN_IDS]);
            if (status.state !== "idle") setStatus({ state: "idle" });
          }}
          className="rounded-md border border-graphite-200 px-3 py-2 text-sm font-medium text-graphite-600 transition hover:border-graphite-300"
        >
          Reset to defaults
        </button>
        {status.state === "saved" && (
          <span className="text-sm text-graphite-500">
            Saved — everyone&rsquo;s picklist updated.
          </span>
        )}
        {status.state === "error" && (
          <span className="badge-error rounded-md px-3 py-1.5 text-sm normal-case tracking-normal">
            {status.message}
          </span>
        )}
      </div>

      <p className="text-xs text-graphite-500">
        Always shown:{" "}
        {ALWAYS_ON_COLUMNS.map((column) => column.label).join(", ")}.
      </p>
    </section>
  );
}

function ColumnCheckbox({
  column,
  checked,
  onToggle,
}: {
  column: PicklistColumn;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex items-center gap-2.5 text-sm text-graphite-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-4 w-4 accent-maroon-600"
      />
      <span>{column.label}</span>
      {column.fullLabel !== column.label && (
        <span className="text-xs text-graphite-400">{column.fullLabel}</span>
      )}
    </label>
  );
}
