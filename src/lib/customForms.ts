import type { FieldDef, FormSection } from "@/lib/formSchema";

// Per-team form customization for Pit Scout and Match Scout. Admins tune the
// default schemas (hide questions that don't fit their strategy, add their
// own) from /form-settings; the result is stored at
// teams/{dataTeamId}/config/scoutForms so a linked sister pair scouts with
// one consistent form and the pooled data stays comparable.

export const SCOUT_FORMS_DOC_ID = "scoutForms";

/** Where custom questions land when they don't target an existing section. */
export const CUSTOM_SECTION_TITLE = "Team Questions";

/**
 * Every team-added question id starts with this. Downstream code keys off it
 * to tell a season field apart from one a team invented — most importantly
 * drive.ts, which scores custom counters at zero so a team's own tally can't
 * move the match predictor.
 */
export const CUSTOM_FIELD_ID_PREFIX = "custom_";

export function isCustomFieldId(id: string): boolean {
  return id.startsWith(CUSTOM_FIELD_ID_PREFIX);
}

export const CUSTOM_FIELD_KINDS = [
  "select",
  "number",
  "text",
  "textarea",
  "multiselect",
  "counter",
  "drawing",
  "photo",
] as const;

export type CustomFieldKind = (typeof CUSTOM_FIELD_KINDS)[number];

export interface CustomField {
  /** Stable value key in submissions — always prefixed "custom_". */
  id: string;
  kind: CustomFieldKind;
  label: string;
  /** Section title to render under; unknown titles become a trailing section. */
  section: string;
  /** Choices for select/multiselect kinds. */
  options?: string[];
  required?: boolean;
}

/**
 * An edit to a default-schema question, keyed by its field id. Only the parts
 * a team can safely change: the wording, the choices, and whether an answer is
 * required. The field's *kind* is deliberately not here — Match Scout is a
 * bespoke screen whose one-tap controls are built per kind, so turning a
 * counter into a textarea would render a control that screen doesn't have.
 *
 * The id never changes, which is the whole point: renaming a question leaves
 * every answer already collected under it attached to it.
 */
export interface FieldOverride {
  label?: string;
  options?: string[];
  required?: boolean;
}

export interface FormCustomization {
  /** Ids of default-schema fields this team has toggled off. */
  hiddenFieldIds: string[];
  /** Ids of default-schema fields this team has deleted from Form Setup. */
  removedFieldIds: string[];
  /** Questions this team added on top of the default schema. */
  customFields: CustomField[];
  /**
   * Section headings this team added, in the order they should render after
   * the default sections. A section only reaches the scout form once it has
   * at least one question.
   */
  customSections: string[];
  /**
   * Edits to default-schema questions, by field id. Absent on configs saved
   * before editing shipped, hence every reader goes through the sanitizer.
   */
  fieldOverrides: Record<string, FieldOverride>;
  /**
   * Default-schema section titles in the order this team renders them. Empty
   * means "the season's own order". Titles the schema no longer has are
   * ignored, and a section the team never ordered — a new one from a schema
   * update — keeps the slot the season gave it rather than being shoved to
   * the end. Team-added sections aren't in here; their order is the order of
   * `customSections`, and they always follow the defaults.
   */
  sectionOrder: string[];
}

export interface ScoutFormsConfig {
  pitScout: FormCustomization;
  matchScout: FormCustomization;
}

export function emptyCustomization(): FormCustomization {
  return {
    hiddenFieldIds: [],
    removedFieldIds: [],
    customFields: [],
    customSections: [],
    fieldOverrides: {},
    sectionOrder: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeCustomField(value: unknown): CustomField | null {
  if (!isRecord(value)) return null;
  const { id, kind, label, section, options, required } = value;
  if (typeof id !== "string" || id.trim() === "") return null;
  if (typeof label !== "string" || label.trim() === "") return null;
  if (!CUSTOM_FIELD_KINDS.includes(kind as CustomFieldKind)) return null;

  const cleanOptions = Array.isArray(options)
    ? options.filter((o): o is string => typeof o === "string" && o.trim() !== "")
    : [];
  // A choice field without choices can't be answered — drop it.
  if ((kind === "select" || kind === "multiselect") && cleanOptions.length === 0) {
    return null;
  }

  return {
    id,
    kind: kind as CustomFieldKind,
    label,
    section:
      typeof section === "string" && section.trim() !== ""
        ? section
        : CUSTOM_SECTION_TITLE,
    ...(cleanOptions.length > 0 ? { options: cleanOptions } : {}),
    ...(required === true ? { required: true } : {}),
  };
}

/**
 * One override, with every empty part dropped. An override with nothing left
 * in it returns null so the caller can delete the key rather than store an
 * empty object that means "no change" in a more expensive way.
 */
function sanitizeFieldOverride(value: unknown): FieldOverride | null {
  if (!isRecord(value)) return null;
  const override: FieldOverride = {};

  if (typeof value.label === "string" && value.label.trim() !== "") {
    override.label = value.label;
  }
  if (Array.isArray(value.options)) {
    const options = value.options.filter(
      (option): option is string => typeof option === "string" && option.trim() !== "",
    );
    // An empty list would blank a dropdown's choices and leave a question
    // nobody can answer — treat it as "no override", not as "no options".
    if (options.length > 0) override.options = options;
  }
  if (typeof value.required === "boolean") {
    override.required = value.required;
  }

  return Object.keys(override).length > 0 ? override : null;
}

function sanitizeFieldOverrides(value: unknown): Record<string, FieldOverride> {
  if (!isRecord(value)) return {};
  const overrides: Record<string, FieldOverride> = {};
  for (const [fieldId, raw] of Object.entries(value)) {
    if (fieldId.trim() === "") continue;
    const override = sanitizeFieldOverride(raw);
    if (override) overrides[fieldId] = override;
  }
  return overrides;
}

/**
 * Titles are the join key between a section and its questions, so trim them
 * and drop blanks/duplicates rather than letting two "Strategy " variants
 * split one section in half — or, in a section order, name the same section
 * twice and leave another one out.
 */
function sanitizeTitles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((title): title is string => typeof title === "string")
        .map((title) => title.trim())
        .filter((title) => title !== ""),
    ),
  ];
}

function sanitizeCustomization(value: unknown): FormCustomization {
  if (!isRecord(value)) return emptyCustomization();
  const hiddenFieldIds = Array.isArray(value.hiddenFieldIds)
    ? value.hiddenFieldIds.filter((id): id is string => typeof id === "string")
    : [];
  const removedFieldIds = Array.isArray(value.removedFieldIds)
    ? value.removedFieldIds.filter((id): id is string => typeof id === "string")
    : [];
  const customFields = Array.isArray(value.customFields)
    ? value.customFields
        .map(sanitizeCustomField)
        .filter((field): field is CustomField => field !== null)
    : [];
  return {
    hiddenFieldIds,
    removedFieldIds,
    customFields,
    customSections: sanitizeTitles(value.customSections),
    fieldOverrides: sanitizeFieldOverrides(value.fieldOverrides),
    sectionOrder: sanitizeTitles(value.sectionOrder),
  };
}

/**
 * Parse the raw Firestore doc into a safe config. The doc is writable by any
 * team member under current rules, so every shape assumption is re-checked
 * here rather than trusted.
 */
export function sanitizeScoutFormsConfig(data: unknown): ScoutFormsConfig {
  const record = isRecord(data) ? data : {};
  return {
    pitScout: sanitizeCustomization(record.pitScout),
    matchScout: sanitizeCustomization(record.matchScout),
  };
}

function customFieldToFieldDef(field: CustomField): FieldDef {
  switch (field.kind) {
    case "select":
      return {
        kind: "select",
        id: field.id,
        label: field.label,
        options: field.options ?? [],
        required: field.required,
      };
    case "multiselect":
      return {
        kind: "multiselect",
        id: field.id,
        label: field.label,
        options: field.options ?? [],
      };
    case "counter":
      return { kind: "counter", id: field.id, label: field.label };
    case "drawing":
      return {
        kind: "drawing",
        id: field.id,
        label: field.label,
        required: field.required,
      };
    case "photo":
      return {
        kind: "photo",
        id: field.id,
        label: field.label,
        required: field.required,
      };
    case "number":
      return {
        kind: "number",
        id: field.id,
        label: field.label,
        required: field.required,
      };
    case "text":
      return {
        kind: "text",
        id: field.id,
        label: field.label,
        required: field.required,
      };
    case "textarea":
      return {
        kind: "textarea",
        id: field.id,
        label: field.label,
        required: field.required,
      };
  }
}

/**
 * Apply one team's edit to a default question. Which parts land depends on the
 * kind — `multiselect` and `counter` have no `required` in FieldDef, and only
 * the two choice kinds have options — so an override carrying a part the kind
 * doesn't have is ignored rather than widening the field's own type.
 */
export function applyFieldOverride(
  field: FieldDef,
  override: FieldOverride | undefined,
): FieldDef {
  if (!override) return field;
  const label =
    override.label !== undefined && override.label.trim() !== ""
      ? override.label
      : field.label;
  const options =
    override.options && override.options.length > 0 ? override.options : null;

  switch (field.kind) {
    case "select":
      return {
        ...field,
        label,
        options: options ?? field.options,
        // `??` and not `||`: unchecking Required stores `false`, which has to
        // win over a season default of `true`.
        required: override.required ?? field.required,
      };
    case "multiselect":
      return { ...field, label, options: options ?? field.options };
    case "counter":
      return { ...field, label };
    default:
      return { ...field, label, required: override.required ?? field.required };
  }
}

/**
 * The season's section titles in the order this team arranged them.
 *
 * Only titles the schema still has are honoured, and they're slotted back into
 * the positions those same titles hold by default. That's what keeps a section
 * the team never touched — one this season's schema added after they saved
 * their order — sitting where the season put it instead of at the end.
 */
export function orderedSectionTitles(
  defaults: readonly FormSection[],
  sectionOrder: readonly string[] | undefined,
): string[] {
  const titles = defaults.map((section) => section.title);
  if (!sectionOrder || sectionOrder.length === 0) return titles;

  const known = new Set(titles);
  const placed = new Set<string>();
  const arranged = sectionOrder.filter((title) => {
    if (!known.has(title) || placed.has(title)) return false;
    placed.add(title);
    return true;
  });

  const ordered = [...titles];
  const slots = titles.flatMap((title, index) => (placed.has(title) ? [index] : []));
  slots.forEach((slot, i) => {
    ordered[slot] = arranged[i];
  });
  return ordered;
}

/** Swap two entries, or return the list untouched if either isn't in it. */
function swapTitles(titles: readonly string[], a: string, b: string): string[] {
  const i = titles.indexOf(a);
  const j = titles.indexOf(b);
  if (i === -1 || j === -1) return [...titles];
  const next = [...titles];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/**
 * Trade two sections' places.
 *
 * It takes the other section rather than a direction because Form Setup hides
 * a section whose questions are all deleted: an up arrow has to swap with the
 * section the admin can actually see above it, not with a hidden one in
 * between, or the button would look broken.
 *
 * A season section swaps with a season section and a team-added one with a
 * team-added one — team sections always render after the defaults, so a swap
 * across that line is a no-op.
 */
export function swapSections(
  customization: FormCustomization,
  defaults: readonly FormSection[],
  title: string,
  otherTitle: string,
): FormCustomization {
  const isDefault = (t: string) => defaults.some((section) => section.title === t);
  if (isDefault(title) && isDefault(otherTitle)) {
    const ordered = orderedSectionTitles(defaults, customization.sectionOrder);
    return { ...customization, sectionOrder: swapTitles(ordered, title, otherTitle) };
  }
  const { customSections } = customization;
  if (customSections.includes(title) && customSections.includes(otherTitle)) {
    return {
      ...customization,
      customSections: swapTitles(customSections, title, otherTitle),
    };
  }
  return customization;
}

/**
 * The team's effective form: default sections minus hidden fields and with
 * their edits applied, in the order the team arranged them, plus custom
 * questions appended to their target section (or a trailing section when the
 * target doesn't exist). Sections left with no fields disappear.
 */
export function applyCustomization(
  defaults: readonly FormSection[],
  customization: FormCustomization | undefined,
): FormSection[] {
  if (!customization) return [...defaults];

  // Hidden and removed both drop the question from the scout form; they only
  // differ in how Form Setup presents them (struck out vs. gone).
  const hidden = new Set([
    ...customization.hiddenFieldIds,
    ...customization.removedFieldIds,
  ]);
  const overrides = customization.fieldOverrides ?? {};
  const byTitle = new Map(defaults.map((section) => [section.title, section]));
  const sections: { title: string; description?: string; fields: FieldDef[] }[] =
    orderedSectionTitles(defaults, customization.sectionOrder)
      .map((title) => byTitle.get(title))
      .filter((section): section is FormSection => section !== undefined)
      .map((section) => ({
        title: section.title,
        ...(section.description ? { description: section.description } : {}),
        fields: section.fields
          .filter((field) => !hidden.has(field.id))
          .map((field) => applyFieldOverride(field, overrides[field.id])),
      }));

  // Team-added sections render after the defaults, in the order the admin
  // arranged them. Seeding them empty here (rather than letting the first
  // question create them) is what makes that order deterministic.
  for (const title of customization.customSections) {
    if (!sections.some((section) => section.title === title)) {
      sections.push({ title, fields: [] });
    }
  }

  const defaultIds = new Set(
    defaults.flatMap((section) => section.fields.map((field) => field.id)),
  );
  const seen = new Set<string>();
  for (const custom of customization.customFields) {
    // A custom id colliding with a default (or an earlier custom) would make
    // two questions write the same submission key — keep the first only.
    if (defaultIds.has(custom.id) || seen.has(custom.id)) continue;
    seen.add(custom.id);

    let target = sections.find((section) => section.title === custom.section);
    if (!target) {
      target = { title: custom.section, fields: [] };
      sections.push(target);
    }
    target.fields.push(customFieldToFieldDef(custom));
  }

  return sections.filter((section) => section.fields.length > 0);
}

/** Build a unique, readable submission key for a new custom question. */
export function makeCustomFieldId(
  label: string,
  takenIds: ReadonlySet<string>,
): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "question";
  let id = `${CUSTOM_FIELD_ID_PREFIX}${slug}`;
  let suffix = 2;
  while (takenIds.has(id)) {
    id = `${CUSTOM_FIELD_ID_PREFIX}${slug}_${suffix}`;
    suffix += 1;
  }
  return id;
}

/**
 * Delete a whole section: its default questions go to removedFieldIds (so the
 * "Removed questions" drawer can restore them one by one), its team-added
 * questions are dropped outright, and a team-added heading disappears.
 */
export function removeSectionFromCustomization(
  customization: FormCustomization,
  title: string,
  defaults: readonly FormSection[],
): FormCustomization {
  const defaultFieldIds =
    defaults
      .find((section) => section.title === title)
      ?.fields.map((field) => field.id) ?? [];
  const alreadyRemoved = new Set(customization.removedFieldIds);
  // A removed question keeps its override: restoring it from the drawer should
  // bring back the wording the team chose, not the season default.
  return {
    // A struck-out question that's now removed shouldn't stay struck, or
    // restoring it would bring it back invisible.
    hiddenFieldIds: customization.hiddenFieldIds.filter(
      (id) => !defaultFieldIds.includes(id),
    ),
    removedFieldIds: [
      ...customization.removedFieldIds,
      ...defaultFieldIds.filter((id) => !alreadyRemoved.has(id)),
    ],
    customFields: customization.customFields.filter(
      (field) => field.section !== title,
    ),
    customSections: customization.customSections.filter((s) => s !== title),
    fieldOverrides: customization.fieldOverrides ?? {},
    // A season section keeps its slot in the order: restoring one of its
    // questions from the drawer should bring it back where the team put it.
    sectionOrder: customization.sectionOrder ?? [],
  };
}

/**
 * Set or clear one default question's override. An edit that matches the
 * season default in every part removes the key outright, so a team that edits
 * a question and then puts it back is stored as never having edited it.
 */
export function setFieldOverride(
  customization: FormCustomization,
  fieldId: string,
  override: FieldOverride,
): FormCustomization {
  const next = { ...(customization.fieldOverrides ?? {}) };
  // Firestore rejects an `undefined` value outright, so the object written
  // here only ever carries keys that actually have one.
  const clean: FieldOverride = {};
  if (override.label !== undefined && override.label.trim() !== "") {
    clean.label = override.label.trim();
  }
  if (override.options !== undefined && override.options.length > 0) {
    clean.options = override.options;
  }
  if (override.required !== undefined) clean.required = override.required;

  if (Object.keys(clean).length === 0) {
    delete next[fieldId];
  } else {
    next[fieldId] = clean;
  }
  return { ...customization, fieldOverrides: next };
}

/** Update one team-added question in place, keeping its id and its answers. */
export function updateCustomField(
  customization: FormCustomization,
  fieldId: string,
  update: Omit<CustomField, "id">,
): FormCustomization {
  return {
    ...customization,
    customFields: customization.customFields.map((field) =>
      field.id === fieldId ? { ...update, id: field.id } : field,
    ),
  };
}
