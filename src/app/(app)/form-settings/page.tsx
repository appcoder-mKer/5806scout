"use client";

import { AppearanceEditor } from "@/components/AppearanceEditor";
import { PicklistSettings } from "@/components/PicklistSettings";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  CUSTOM_SECTION_TITLE,
  makeCustomFieldId,
  removeSectionFromCustomization,
  SCOUT_FORMS_DOC_ID,
  type CustomField,
  type CustomFieldKind,
  type FormCustomization,
} from "@/lib/customForms";
import { PREDICTION_FIELD_IDS } from "@/lib/drive";
import { db } from "@/lib/firebase/client";
import type { FormSection } from "@/lib/formSchema";
import {
  MATCH_FIELD_LABELS,
  MATCH_SCOUT_SECTIONS,
} from "@/lib/matchScoutSchema";
import { PIT_SCOUT_SECTIONS } from "@/lib/pitScoutSchema";
import { useScoutForms } from "@/lib/useScoutForms";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { useState } from "react";

// Match Scout is a bespoke REBUILT screen (see match-scout/page.tsx), so its
// season questions can be struck or deleted here but not restyled — and the
// ones the Drive Dash predictor reads get a warning before they go.
type FormKey = "pitScout" | "matchScout";
type Tab = FormKey | "picklist" | "website";

const TAB_LABELS: Record<Tab, string> = {
  pitScout: "Pit Scout",
  matchScout: "Match Scout",
  picklist: "Picklist",
  website: "Website Customization",
};

/** Tabs that edit a scout form; the rest own their own editor and save. */
function isFormTab(tab: Tab): tab is FormKey {
  return tab === "pitScout" || tab === "matchScout";
}

const FORMS: Record<
  FormKey,
  { label: string; sections: readonly FormSection[] }
> = {
  pitScout: { label: "Pit Scout", sections: PIT_SCOUT_SECTIONS },
  matchScout: { label: "Match Scout", sections: MATCH_SCOUT_SECTIONS },
};

/** Match Scout fields whose loss degrades Drive Dash predictions. */
const PREDICTION_FIELDS = new Set(PREDICTION_FIELD_IDS);

const KIND_LABELS: Record<CustomFieldKind, string> = {
  text: "Short text",
  textarea: "Long text",
  select: "Dropdown",
  multiselect: "Multi-select",
  counter: "Tally counter",
  number: "Number",
  drawing: "Drawing / map",
  photo: "Photo",
};

/** Kinds whose FieldDef supports the required flag. */
const REQUIRABLE_KINDS: readonly CustomFieldKind[] = [
  "text",
  "textarea",
  "select",
  "number",
  "drawing",
  "photo",
];

type Status =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved" }
  | { state: "error"; message: string };

/** Small trash-can glyph, matching the app's inline-SVG icon convention. */
function TrashIcon() {
  return (
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
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6m5 5v6m4-6v6" />
    </svg>
  );
}

/** Counter-clockwise arrow — restores a removed default question. */
function RestoreIcon() {
  return (
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
      <path d="M3 3v5h5M3.05 13a9 9 0 1 0 2.6-6.4L3 8" />
    </svg>
  );
}

export default function FormSettingsPage() {
  const { profile, user, dataTeamId } = useAuth();
  const { config } = useScoutForms();

  const [tab, setTab] = useState<Tab>("pitScout");
  // Form editing only ever operates on a real form; on the other tabs this
  // falls back to pitScout but the form body below isn't rendered.
  const formKey: FormKey = isFormTab(tab) ? tab : "pitScout";
  // Local working copy of both customizations — null until the first edit,
  // when it forks from the live config. Edits stay local until Save writes
  // the whole doc back.
  const [drafts, setDrafts] = useState<Record<
    FormKey,
    FormCustomization
  > | null>(null);
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const working =
    drafts ??
    (config
      ? { pitScout: config.pitScout, matchScout: config.matchScout }
      : null);

  // New-question builder state.
  const [newLabel, setNewLabel] = useState("");
  const [newKind, setNewKind] = useState<CustomFieldKind>("text");
  const [newSection, setNewSection] = useState<string>(CUSTOM_SECTION_TITLE);
  const [newOptions, setNewOptions] = useState("");
  const [newRequired, setNewRequired] = useState(false);
  const [newSectionTitle, setNewSectionTitle] = useState("");

  const isAdmin = profile?.role === "admin";

  if (profile && !isAdmin) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 md:px-6">
        <div className="rounded-lg border border-dashed border-graphite-300 bg-graphite-50 px-6 py-12 text-center text-sm text-graphite-500">
          Form Setup is only available to admins.
        </div>
      </main>
    );
  }

  const draft = working?.[formKey];
  const defaults = FORMS[formKey].sections;
  const hidden = new Set(draft?.hiddenFieldIds ?? []);
  const removed = new Set(draft?.removedFieldIds ?? []);
  const removedDefaults = defaults
    .flatMap((section) => section.fields)
    .filter((field) => removed.has(field.id));
  const customSections = draft?.customSections ?? [];
  const sectionChoices = [
    ...new Set([
      ...defaults.map((s) => s.title),
      ...customSections,
      CUSTOM_SECTION_TITLE,
    ]),
  ];
  // Switching between the Pit and Match tabs can strand the picker on a
  // section the other form doesn't have — fall back to the catch-all.
  const selectedSection = sectionChoices.includes(newSection)
    ? newSection
    : CUSTOM_SECTION_TITLE;

  // Predictor inputs this draft drops. Only Match Scout feeds the Drive Dash,
  // so the Pit tab never has any.
  const droppedPredictionFields =
    formKey === "matchScout"
      ? PREDICTION_FIELD_IDS.filter(
          (fieldId) => hidden.has(fieldId) || removed.has(fieldId),
        )
      : [];
  const droppedPredictionLabels = droppedPredictionFields.map(
    (fieldId) => MATCH_FIELD_LABELS[fieldId] ?? fieldId,
  );

  /**
   * Confirm before an edit costs the predictor a field it reads. Returns true
   * when the edit should go ahead — the admin is never blocked, only warned.
   */
  function confirmPredictionLoss(fieldIds: readonly string[]): boolean {
    if (formKey !== "matchScout") return true;
    const atRisk = fieldIds.filter(
      (fieldId) => PREDICTION_FIELDS.has(fieldId) && !hidden.has(fieldId) && !removed.has(fieldId),
    );
    if (atRisk.length === 0) return true;
    const labels = atRisk
      .map((fieldId) => `“${MATCH_FIELD_LABELS[fieldId] ?? fieldId}”`)
      .join(", ");
    return window.confirm(
      `${labels} feeds the match predictions on the Drive Dash. Dropping it means those predictions stop counting its points. Continue?`,
    );
  }

  function updateDraft(update: (prev: FormCustomization) => FormCustomization) {
    if (working) {
      setDrafts({ ...working, [formKey]: update(working[formKey]) });
    }
    if (status.state !== "idle") setStatus({ state: "idle" });
  }

  function toggleFieldVisible(fieldId: string) {
    const striking = !hidden.has(fieldId);
    if (striking && !confirmPredictionLoss([fieldId])) return;
    updateDraft((prev) => ({
      ...prev,
      hiddenFieldIds: prev.hiddenFieldIds.includes(fieldId)
        ? prev.hiddenFieldIds.filter((id) => id !== fieldId)
        : [...prev.hiddenFieldIds, fieldId],
    }));
  }

  function addQuestion() {
    if (!draft) return;
    const label = newLabel.trim();
    if (!label) {
      setStatus({ state: "error", message: "The question needs a label." });
      return;
    }
    const options = newOptions
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const needsOptions = newKind === "select" || newKind === "multiselect";
    if (needsOptions && options.length === 0) {
      setStatus({
        state: "error",
        message: "Add at least one option (one per line).",
      });
      return;
    }

    const taken = new Set([
      ...defaults.flatMap((s) => s.fields.map((f) => f.id)),
      ...draft.customFields.map((f) => f.id),
    ]);
    const field: CustomField = {
      id: makeCustomFieldId(label, taken),
      kind: newKind,
      label,
      section: selectedSection,
      ...(needsOptions ? { options } : {}),
      ...(newRequired && REQUIRABLE_KINDS.includes(newKind)
        ? { required: true }
        : {}),
    };
    updateDraft((prev) => ({
      ...prev,
      customFields: [...prev.customFields, field],
    }));
    setNewLabel("");
    setNewOptions("");
    setNewRequired(false);
  }

  function addSection() {
    const title = newSectionTitle.trim();
    if (!title) {
      setStatus({ state: "error", message: "The section needs a name." });
      return;
    }
    if (sectionChoices.some((choice) => choice === title)) {
      setStatus({
        state: "error",
        message: `“${title}” is already a section on this form.`,
      });
      return;
    }
    updateDraft((prev) => ({
      ...prev,
      customSections: [...prev.customSections, title],
    }));
    setNewSectionTitle("");
    // Point the question builder at the section the admin just made — adding
    // one is almost always the first half of "and now put questions in it".
    setNewSection(title);
  }

  /**
   * Delete a whole section and everything in it. Default questions land in
   * the "Removed questions" drawer so the admin can put them back one by one;
   * team-added ones are gone for good, so the confirm spells out the count.
   */
  function removeSection(title: string) {
    if (!draft) return;
    const defaultFields =
      defaults
        .find((section) => section.title === title)
        ?.fields.filter((field) => !removed.has(field.id)) ?? [];
    const customFields = draft.customFields.filter(
      (field) => field.section === title,
    );
    const total = defaultFields.length + customFields.length;
    if (
      total > 0 &&
      !window.confirm(
        `Delete “${title}” and its ${total} question${total === 1 ? "" : "s"}?` +
          (defaultFields.length > 0
            ? " Default questions can be restored from “Removed questions”."
            : "") +
          (customFields.length > 0
            ? ` ${customFields.length} question${
                customFields.length === 1 ? "" : "s"
              } your team added will be deleted permanently.`
            : ""),
      )
    ) {
      return;
    }
    if (!confirmPredictionLoss(defaultFields.map((field) => field.id))) return;

    updateDraft((prev) =>
      removeSectionFromCustomization(prev, title, defaults),
    );
  }

  function removeDefaultQuestion(fieldId: string) {
    if (!confirmPredictionLoss([fieldId])) return;
    updateDraft((prev) => ({
      ...prev,
      // Clear any strike so a later restore brings the question back active.
      hiddenFieldIds: prev.hiddenFieldIds.filter((id) => id !== fieldId),
      removedFieldIds: [...prev.removedFieldIds, fieldId],
    }));
  }

  function restoreDefaultQuestion(fieldId: string) {
    updateDraft((prev) => ({
      ...prev,
      removedFieldIds: prev.removedFieldIds.filter((id) => id !== fieldId),
    }));
  }

  function removeQuestion(fieldId: string) {
    updateDraft((prev) => ({
      ...prev,
      customFields: prev.customFields.filter((f) => f.id !== fieldId),
    }));
  }

  async function handleSave() {
    if (!working || !profile || !user || !dataTeamId) return;
    // Last chance to back out: this is the point where every scout's form —
    // and the Drive Dash — actually changes.
    if (
      droppedPredictionLabels.length > 0 &&
      !window.confirm(
        `Saving drops ${droppedPredictionLabels
          .map((label) => `“${label}”`)
          .join(", ")} from Match Scout. The Drive Dash will show degraded ` +
          `predictions until you restore ${
            droppedPredictionLabels.length === 1 ? "it" : "them"
          }. Save anyway?`,
      )
    ) {
      return;
    }
    setStatus({ state: "saving" });
    try {
      await setDoc(
        doc(db, "teams", dataTeamId, "config", SCOUT_FORMS_DOC_ID),
        {
          pitScout: working.pitScout,
          matchScout: working.matchScout,
          updatedAt: serverTimestamp(),
          updatedByUid: user.uid,
          updatedByName: profile.fullName,
        },
        { merge: true },
      );
      setStatus({ state: "saved" });
    } catch (err) {
      setStatus({
        state: "error",
        message: err instanceof Error ? err.message : "Save failed",
      });
    }
  }

  const needsOptions = newKind === "select" || newKind === "multiselect";

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 md:px-6">
      <div>
        <h1 className="page-title">
          <span aria-hidden className="page-rule" />
          Settings
        </h1>
        <p className="page-lede">
          {tab === "website"
            ? "Brand the app for your team — accent color, background, font, and the top-left logo. Changes apply to everyone."
            : tab === "picklist"
              ? "Choose which criteria the Picklist table shows. The metrics come from your Match Scout questions, so this list follows whatever you set up there."
              : `Tune the ${FORMS[formKey].label} form for your team — uncheck a question to strike it out, trash it to remove it, delete a whole section, add your own sections and questions. Changes apply to everyone on the team.`}
        </p>
      </div>

      <div className="surface-card flex flex-wrap self-start p-0.5">
        {(Object.keys(TAB_LABELS) as Tab[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded px-3.5 py-1.5 text-sm font-medium transition ${
              tab === key
                ? "bg-maroon-600 text-white"
                : "text-graphite-600 hover:text-graphite-900"
            }`}
          >
            {TAB_LABELS[key]}
          </button>
        ))}
      </div>

      {tab === "website" && <AppearanceEditor />}

      {tab === "picklist" && <PicklistSettings />}

      {isFormTab(tab) && !draft && (
        <div className="surface-panel px-6 py-10 text-center text-sm text-graphite-500">
          Loading your team&apos;s form settings…
        </div>
      )}

      {isFormTab(tab) && draft && (
        <>
          {formKey === "matchScout" && (
            <p className="surface-panel px-4 py-3 text-xs text-graphite-500">
              Match Scout is a bespoke screen built for this season&apos;s game,
              so its default questions keep their fast one-tap controls — you
              can strike or delete them, and questions you add render below the
              section they belong to. Questions your team adds are tracked in
              the Data and Teams tabs but never count toward match predictions.
            </p>
          )}

          {droppedPredictionLabels.length > 0 && (
            <p className="badge-error flex items-start gap-2 rounded-md px-3 py-2 text-sm normal-case tracking-normal">
              <span aria-hidden>⚠</span>
              <span>
                Match predictions on the Drive Dash are degraded:{" "}
                {droppedPredictionLabels.join(", ")}{" "}
                {droppedPredictionLabels.length === 1 ? "is" : "are"} no longer
                scouted, so {droppedPredictionLabels.length === 1 ? "its" : "their"}{" "}
                points drop out of every prediction. Restore from “Removed
                questions” below to fix.
              </span>
            </p>
          )}

          <section className="flex flex-col gap-3">
            <h2 className="section-title">Default questions</h2>
            {defaults.map((section) => {
              const visibleFields = section.fields.filter(
                (field) => !removed.has(field.id),
              );
              if (visibleFields.length === 0) return null;
              return (
                <div key={section.title} className="surface-card p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-maroon-700 dark:text-maroon-300">
                      <span aria-hidden className="h-2.5 w-1 bg-maroon-600" />
                      {section.title}
                    </h3>
                    <button
                      type="button"
                      onClick={() => removeSection(section.title)}
                      aria-label={`Delete section ${section.title}`}
                      title="Delete this section and its questions"
                      className="shrink-0 rounded-md p-1.5 text-graphite-500 transition hover:bg-maroon-50 hover:text-maroon-600 dark:hover:text-maroon-400"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                  <ul className="flex flex-col divide-y divide-graphite-100">
                    {visibleFields.map((field) => {
                      const isHidden = hidden.has(field.id);
                      return (
                        <li
                          key={field.id}
                          className="flex items-center justify-between gap-3 py-2"
                        >
                          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                            <input
                              type="checkbox"
                              checked={!isHidden}
                              onChange={() => toggleFieldVisible(field.id)}
                              aria-label={`${isHidden ? "Include" : "Strike"} ${field.label}`}
                              className="h-4 w-4 shrink-0 accent-maroon-600"
                            />
                            <span
                              className={`truncate text-sm ${
                                isHidden
                                  ? "text-graphite-400 line-through"
                                  : "text-graphite-700"
                              }`}
                            >
                              {field.label}
                            </span>
                            <span className="badge bg-graphite-100 text-graphite-500">
                              {KIND_LABELS[field.kind]}
                            </span>
                            {formKey === "matchScout" &&
                              PREDICTION_FIELDS.has(field.id) && (
                                <span
                                  className="badge shrink-0 bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
                                  title="The Drive Dash match predictor reads this question"
                                >
                                  Predicts
                                </span>
                              )}
                          </label>
                          <button
                            type="button"
                            onClick={() => removeDefaultQuestion(field.id)}
                            aria-label={`Remove ${field.label}`}
                            title="Remove question"
                            className="shrink-0 rounded-md p-1.5 text-graphite-500 transition hover:bg-maroon-50 hover:text-maroon-600 dark:hover:text-maroon-400"
                          >
                            <TrashIcon />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}

            {removedDefaults.length > 0 && (
              <details className="surface-card p-4">
                <summary className="cursor-pointer text-sm text-graphite-500 transition hover:text-graphite-700">
                  Removed questions ({removedDefaults.length})
                </summary>
                <ul className="mt-2 flex flex-col divide-y divide-graphite-100">
                  {removedDefaults.map((field) => (
                    <li
                      key={field.id}
                      className="flex items-center justify-between gap-3 py-2"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <span className="truncate text-sm text-graphite-400">
                          {field.label}
                        </span>
                        <span className="badge bg-graphite-100 text-graphite-500">
                          {KIND_LABELS[field.kind]}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => restoreDefaultQuestion(field.id)}
                        aria-label={`Restore ${field.label}`}
                        title="Restore question"
                        className="shrink-0 rounded-md p-1.5 text-graphite-400 transition hover:bg-graphite-100 hover:text-graphite-700"
                      >
                        <RestoreIcon />
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="section-title">Your team&apos;s sections</h2>
            <p className="-mt-1 text-xs text-graphite-500">
              Sections you add render after the default ones, in this order. A
              section shows up on the {FORMS[formKey].label} form once it has at
              least one question.
            </p>

            {customSections.length > 0 && (
              <ul className="surface-card divide-y divide-graphite-100">
                {customSections.map((title) => {
                  const questionCount = draft.customFields.filter(
                    (field) => field.section === title,
                  ).length;
                  return (
                    <li
                      key={title}
                      className="flex items-center justify-between gap-3 px-4 py-2.5"
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm text-graphite-900">
                          {title}
                        </span>
                        <span className="text-xs text-graphite-500">
                          {questionCount} question
                          {questionCount === 1 ? "" : "s"}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeSection(title)}
                        aria-label={`Delete section ${title}`}
                        title={
                          questionCount > 0
                            ? "Delete this section and its questions"
                            : "Delete section"
                        }
                        className="shrink-0 rounded-md p-1.5 text-graphite-500 transition hover:bg-maroon-50 hover:text-maroon-600 dark:hover:text-maroon-400"
                      >
                        <TrashIcon />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <form
              className="surface-panel flex flex-col gap-3 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                addSection();
              }}
            >
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-graphite-700">
                  Section name
                </span>
                <input
                  type="text"
                  value={newSectionTitle}
                  onChange={(e) => setNewSectionTitle(e.target.value)}
                  placeholder="e.g. Defense"
                  className="field-input"
                />
              </label>
              <button type="submit" className="btn-secondary self-start">
                Add section
              </button>
            </form>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="section-title">Your team&apos;s questions</h2>
            {draft.customFields.length > 0 && (
              <ul className="surface-card divide-y divide-graphite-100">
                {draft.customFields.map((field) => (
                  <li
                    key={field.id}
                    className="flex items-center justify-between gap-3 px-4 py-2.5"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm text-graphite-900">
                        {field.label}
                        {field.required && (
                          <span className="ml-0.5 text-maroon-600 dark:text-maroon-400">*</span>
                        )}
                      </span>
                      <span className="text-xs text-graphite-500">
                        {KIND_LABELS[field.kind]} · {field.section}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeQuestion(field.id)}
                      aria-label={`Remove ${field.label}`}
                      title="Remove question"
                      className="shrink-0 rounded-md p-1.5 text-graphite-500 transition hover:bg-maroon-50 hover:text-maroon-600 dark:hover:text-maroon-400"
                    >
                      <TrashIcon />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <form
              className="surface-panel flex flex-col gap-3 p-4"
              onSubmit={(e) => {
                e.preventDefault();
                addQuestion();
              }}
            >
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-graphite-700">
                  Question
                </span>
                <input
                  type="text"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  placeholder="e.g. Can they score in the trap?"
                  className="field-input"
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-graphite-700">
                    Answer type
                  </span>
                  <select
                    value={newKind}
                    onChange={(e) =>
                      setNewKind(e.target.value as CustomFieldKind)
                    }
                    className="field-input"
                  >
                    {(Object.keys(KIND_LABELS) as CustomFieldKind[]).map(
                      (kind) => (
                        <option key={kind} value={kind}>
                          {KIND_LABELS[kind]}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-graphite-700">
                    Section
                  </span>
                  <select
                    value={selectedSection}
                    onChange={(e) => setNewSection(e.target.value)}
                    className="field-input"
                  >
                    {sectionChoices.map((title) => (
                      <option key={title} value={title}>
                        {title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {needsOptions && (
                <label className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-graphite-700">
                    Options — one per line
                  </span>
                  <textarea
                    rows={3}
                    value={newOptions}
                    onChange={(e) => setNewOptions(e.target.value)}
                    placeholder={"Yes\nNo\nSometimes"}
                    className="field-input"
                  />
                </label>
              )}

              {REQUIRABLE_KINDS.includes(newKind) && (
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={newRequired}
                    onChange={(e) => setNewRequired(e.target.checked)}
                    className="h-4 w-4 accent-maroon-600"
                  />
                  <span className="text-sm text-graphite-700">
                    Required answer
                  </span>
                </label>
              )}

              <button type="submit" className="btn-secondary self-start">
                Add question
              </button>
            </form>
          </section>

          {status.state === "error" && (
            <p className="badge-error rounded-md px-3 py-2 text-sm normal-case tracking-normal">
              {status.message}
            </p>
          )}
          {status.state === "saved" && (
            <p className="badge-success rounded-md px-3 py-2 text-sm normal-case tracking-normal">
              Saved — scouts see the updated form immediately.
            </p>
          )}

          <button
            type="button"
            onClick={handleSave}
            disabled={status.state === "saving"}
            className="btn-primary"
          >
            {status.state === "saving" ? "Saving…" : "Save form settings"}
          </button>
        </>
      )}
    </main>
  );
}
