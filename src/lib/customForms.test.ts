import { describe, expect, it } from "vitest";
import {
  applyCustomization,
  CUSTOM_SECTION_TITLE,
  emptyCustomization,
  makeCustomFieldId,
  removeSectionFromCustomization,
  sanitizeScoutFormsConfig,
  setFieldOverride,
  updateCustomField,
  type CustomField,
} from "./customForms";
import { emptyValues, missingRequiredFields, type FormSection } from "./formSchema";

const DEFAULTS: readonly FormSection[] = [
  {
    title: "Autonomous",
    fields: [
      { kind: "select", id: "autoMobility", label: "Left zone", options: ["Yes", "No"] },
      { kind: "counter", id: "autoScoredLow", label: "Scored — low" },
    ],
  },
  {
    title: "Endgame",
    fields: [
      { kind: "select", id: "endgame", label: "Endgame", options: ["None", "Park"] },
    ],
  },
];

function custom(overrides: Partial<CustomField>): CustomField {
  return {
    id: "custom_q",
    kind: "text",
    label: "Custom Q",
    section: CUSTOM_SECTION_TITLE,
    ...overrides,
  };
}

describe("applyCustomization", () => {
  it("returns defaults untouched with no customization", () => {
    expect(applyCustomization(DEFAULTS, undefined)).toEqual(DEFAULTS);
    expect(applyCustomization(DEFAULTS, emptyCustomization())).toEqual(DEFAULTS);
  });

  it("hides fields and drops sections left empty", () => {
    const result = applyCustomization(DEFAULTS, {
      hiddenFieldIds: ["endgame", "autoScoredLow"],
      removedFieldIds: [],
      customSections: [],
      fieldOverrides: {},
      customFields: [],
    });
    expect(result).toEqual([
      {
        title: "Autonomous",
        fields: [
          { kind: "select", id: "autoMobility", label: "Left zone", options: ["Yes", "No"] },
        ],
      },
    ]);
  });

  it("drops removed fields from the form just like hidden ones", () => {
    const result = applyCustomization(DEFAULTS, {
      hiddenFieldIds: ["autoScoredLow"],
      removedFieldIds: ["endgame"],
      customSections: [],
      fieldOverrides: {},
      customFields: [],
    });
    expect(result).toEqual([
      {
        title: "Autonomous",
        fields: [
          { kind: "select", id: "autoMobility", label: "Left zone", options: ["Yes", "No"] },
        ],
      },
    ]);
  });

  it("appends custom fields to an existing section by title", () => {
    const result = applyCustomization(DEFAULTS, {
      hiddenFieldIds: [],
      removedFieldIds: [],
      customSections: [],
      fieldOverrides: {},
      customFields: [custom({ id: "custom_climb", section: "Endgame", kind: "counter" })],
    });
    const endgame = result.find((s) => s.title === "Endgame");
    expect(endgame?.fields.map((f) => f.id)).toEqual(["endgame", "custom_climb"]);
  });

  it("collects unknown-section customs into a trailing section", () => {
    const result = applyCustomization(DEFAULTS, {
      hiddenFieldIds: [],
      removedFieldIds: [],
      customSections: [],
      fieldOverrides: {},
      customFields: [custom({ id: "custom_a" }), custom({ id: "custom_b" })],
    });
    const last = result[result.length - 1];
    expect(last.title).toBe(CUSTOM_SECTION_TITLE);
    expect(last.fields.map((f) => f.id)).toEqual(["custom_a", "custom_b"]);
  });

  it("keeps a section alive via customs even when all defaults are hidden", () => {
    const result = applyCustomization(DEFAULTS, {
      hiddenFieldIds: ["endgame"],
      removedFieldIds: [],
      customSections: [],
      fieldOverrides: {},
      customFields: [custom({ id: "custom_climb", section: "Endgame" })],
    });
    const endgame = result.find((s) => s.title === "Endgame");
    expect(endgame?.fields.map((f) => f.id)).toEqual(["custom_climb"]);
  });

  it("skips customs whose id collides with a default or earlier custom", () => {
    const result = applyCustomization(DEFAULTS, {
      hiddenFieldIds: [],
      removedFieldIds: [],
      customSections: [],
      fieldOverrides: {},
      customFields: [
        custom({ id: "endgame", label: "Impostor" }),
        custom({ id: "custom_a", label: "First" }),
        custom({ id: "custom_a", label: "Duplicate" }),
      ],
    });
    const last = result[result.length - 1];
    expect(last.fields).toHaveLength(1);
    expect(last.fields[0].label).toBe("First");
  });

  it("renders team-added sections after the defaults, in declared order", () => {
    const result = applyCustomization(DEFAULTS, {
      hiddenFieldIds: [],
      removedFieldIds: [],
      customSections: ["Defense", "Strategy"],
      fieldOverrides: {},
      customFields: [
        custom({ id: "custom_strat", section: "Strategy" }),
        custom({ id: "custom_def", section: "Defense" }),
      ],
    });
    expect(result.map((s) => s.title)).toEqual([
      "Autonomous",
      "Endgame",
      "Defense",
      "Strategy",
    ]);
  });

  it("drops a team-added section that has no questions yet", () => {
    const result = applyCustomization(DEFAULTS, {
      hiddenFieldIds: [],
      removedFieldIds: [],
      customSections: ["Empty"],
      fieldOverrides: {},
      customFields: [],
    });
    expect(result.map((s) => s.title)).toEqual(["Autonomous", "Endgame"]);
  });

  it("keeps a team-added section titled like a default from duplicating it", () => {
    const result = applyCustomization(DEFAULTS, {
      hiddenFieldIds: [],
      removedFieldIds: [],
      customSections: ["Endgame"],
      fieldOverrides: {},
      customFields: [custom({ id: "custom_climb", section: "Endgame" })],
    });
    expect(result.filter((s) => s.title === "Endgame")).toHaveLength(1);
    expect(
      result.find((s) => s.title === "Endgame")?.fields.map((f) => f.id),
    ).toEqual(["endgame", "custom_climb"]);
  });

  it("maps drawing and photo customs to their field defs", () => {
    const result = applyCustomization(DEFAULTS, {
      hiddenFieldIds: [],
      removedFieldIds: [],
      customSections: [],
      fieldOverrides: {},
      customFields: [
        custom({ id: "custom_map", kind: "drawing", required: true }),
        custom({ id: "custom_pic", kind: "photo" }),
      ],
    });
    const last = result[result.length - 1];
    expect(last.fields).toEqual([
      {
        kind: "drawing",
        id: "custom_map",
        label: "Custom Q",
        required: true,
      },
      { kind: "photo", id: "custom_pic", label: "Custom Q", required: undefined },
    ]);
    // A photo/drawing answer is a data URL string, so required validation
    // treats an untaken photo (null) as missing like any other field.
    expect(missingRequiredFields(result, emptyValues(result))).toContain(
      "Custom Q",
    );
  });

  it("produces fields that work with emptyValues and required validation", () => {
    const sections = applyCustomization(DEFAULTS, {
      hiddenFieldIds: [],
      removedFieldIds: [],
      customSections: [],
      fieldOverrides: {},
      customFields: [
        custom({ id: "custom_req", required: true }),
        custom({ id: "custom_tally", kind: "counter" }),
      ],
    });
    const values = emptyValues(sections);
    expect(values.custom_req).toBeNull();
    expect(values.custom_tally).toBe(0);
    expect(missingRequiredFields(sections, values)).toContain("Custom Q");
  });
});

describe("sanitizeScoutFormsConfig", () => {
  it("returns empty customizations for garbage input", () => {
    for (const garbage of [undefined, null, 42, "nope", [], { pitScout: 7 }]) {
      const config = sanitizeScoutFormsConfig(garbage);
      expect(config.pitScout).toEqual(emptyCustomization());
      expect(config.matchScout).toEqual(emptyCustomization());
    }
  });

  it("keeps valid entries and drops malformed ones", () => {
    const config = sanitizeScoutFormsConfig({
      matchScout: {
        hiddenFieldIds: ["fouls", 99, null],
        customFields: [
          { id: "custom_ok", kind: "text", label: "Fine", section: "Teleop" },
          { id: "", kind: "text", label: "No id" },
          { id: "custom_nolabel", kind: "text", label: "  " },
          { id: "custom_badkind", kind: "slider", label: "Bad kind" },
          { id: "custom_noopts", kind: "select", label: "Choices?", options: [] },
        ],
      },
    });
    expect(config.matchScout.hiddenFieldIds).toEqual(["fouls"]);
    expect(config.matchScout.removedFieldIds).toEqual([]);
    expect(config.matchScout.customFields).toEqual([
      { id: "custom_ok", kind: "text", label: "Fine", section: "Teleop" },
    ]);
  });

  it("trims custom section titles and drops blanks and duplicates", () => {
    const config = sanitizeScoutFormsConfig({
      pitScout: { customSections: ["  Defense ", "Defense", "", 7, null, "Pit"] },
    });
    expect(config.pitScout.customSections).toEqual(["Defense", "Pit"]);
  });

  it("keeps string removedFieldIds and drops malformed ones", () => {
    const config = sanitizeScoutFormsConfig({
      matchScout: { removedFieldIds: ["endgame", 7, null] },
    });
    expect(config.matchScout.removedFieldIds).toEqual(["endgame"]);
  });

  it("defaults a missing section to the custom section title", () => {
    const config = sanitizeScoutFormsConfig({
      pitScout: {
        customFields: [{ id: "custom_q", kind: "counter", label: "Q" }],
      },
    });
    expect(config.pitScout.customFields[0].section).toBe(CUSTOM_SECTION_TITLE);
  });

  it("keeps options and required only when meaningful", () => {
    const config = sanitizeScoutFormsConfig({
      pitScout: {
        customFields: [
          {
            id: "custom_pick",
            kind: "select",
            label: "Pick",
            section: "Robot Basics",
            options: ["A", "", "B", 3],
            required: true,
          },
        ],
      },
    });
    expect(config.pitScout.customFields[0]).toEqual({
      id: "custom_pick",
      kind: "select",
      label: "Pick",
      section: "Robot Basics",
      options: ["A", "B"],
      required: true,
    });
  });
});

describe("makeCustomFieldId", () => {
  it("slugifies the label with a custom_ prefix", () => {
    expect(makeCustomFieldId("Can they climb?", new Set())).toBe(
      "custom_can_they_climb",
    );
  });

  it("falls back for empty labels and dedupes taken ids", () => {
    expect(makeCustomFieldId("!!!", new Set())).toBe("custom_question");
    const taken = new Set(["custom_q", "custom_q_2"]);
    expect(makeCustomFieldId("Q", taken)).toBe("custom_q_3");
  });
});

describe("removeSectionFromCustomization", () => {
  it("removes a default section's questions and clears their strikes", () => {
    const result = removeSectionFromCustomization(
      {
        hiddenFieldIds: ["autoMobility"],
        removedFieldIds: [],
        customFields: [],
        customSections: [],
        fieldOverrides: {},
      },
      "Autonomous",
      DEFAULTS,
    );
    expect(result.removedFieldIds).toEqual(["autoMobility", "autoScoredLow"]);
    // The strike is dropped along with the question, so restoring it later
    // brings it back visible rather than struck out.
    expect(result.hiddenFieldIds).toEqual([]);
    expect(applyCustomization(DEFAULTS, result)).toEqual([
      {
        title: "Endgame",
        fields: [
          { kind: "select", id: "endgame", label: "Endgame", options: ["None", "Park"] },
        ],
      },
    ]);
  });

  it("deletes a team section's own questions along with the heading", () => {
    const result = removeSectionFromCustomization(
      {
        hiddenFieldIds: [],
        removedFieldIds: [],
        customFields: [
          custom({ id: "custom_a", section: "Defense" }),
          custom({ id: "custom_b", section: CUSTOM_SECTION_TITLE }),
        ],
        customSections: ["Defense", "Strategy"],
        fieldOverrides: {},
      },
      "Defense",
      DEFAULTS,
    );
    expect(result.customSections).toEqual(["Strategy"]);
    expect(result.customFields.map((f) => f.id)).toEqual(["custom_b"]);
  });

  it("doesn't double-list a question that was already removed", () => {
    const result = removeSectionFromCustomization(
      {
        hiddenFieldIds: [],
        removedFieldIds: ["autoScoredLow"],
        customFields: [],
        customSections: [],
        fieldOverrides: {},
      },
      "Autonomous",
      DEFAULTS,
    );
    expect(result.removedFieldIds).toEqual(["autoScoredLow", "autoMobility"]);
  });

  it("is a no-op for a section neither form has", () => {
    const before = emptyCustomization();
    expect(removeSectionFromCustomization(before, "Nope", DEFAULTS)).toEqual(
      before,
    );
  });
});

/** A customization carrying nothing but the overrides under test. */
function withOverrides(
  fieldOverrides: Record<string, { label?: string; options?: string[]; required?: boolean }>,
) {
  return { ...emptyCustomization(), fieldOverrides };
}

describe("applyCustomization — edits to default questions", () => {
  it("renames a question without touching its id", () => {
    const result = applyCustomization(
      DEFAULTS,
      withOverrides({ autoMobility: { label: "Crossed the line?" } }),
    );
    expect(result[0].fields[0]).toEqual({
      kind: "select",
      id: "autoMobility",
      label: "Crossed the line?",
      options: ["Yes", "No"],
      required: undefined,
    });
  });

  it("replaces a dropdown's choices", () => {
    const result = applyCustomization(
      DEFAULTS,
      withOverrides({ endgame: { options: ["None", "Park", "Deep climb"] } }),
    );
    const endgame = result[1].fields[0];
    expect(endgame).toMatchObject({
      label: "Endgame",
      options: ["None", "Park", "Deep climb"],
    });
  });

  it("makes a question required, and lets it be made optional again", () => {
    const required = applyCustomization(
      DEFAULTS,
      withOverrides({ autoMobility: { required: true } }),
    );
    expect(required[0].fields[0]).toMatchObject({ required: true });

    const withDefaultRequired: readonly FormSection[] = [
      {
        title: "Autonomous",
        fields: [
          { kind: "text", id: "notes", label: "Notes", required: true },
        ],
      },
    ];
    // `required: false` has to beat a season default of true — the bug an
    // `||` here would hide.
    const optional = applyCustomization(
      withDefaultRequired,
      withOverrides({ notes: { required: false } }),
    );
    expect(optional[0].fields[0]).toMatchObject({ required: false });
  });

  it("ignores parts of an override the field's kind doesn't have", () => {
    // A counter has neither options nor required in FieldDef.
    const result = applyCustomization(
      DEFAULTS,
      withOverrides({
        autoScoredLow: { label: "Low goal", options: ["a"], required: true },
      }),
    );
    expect(result[0].fields[1]).toEqual({
      kind: "counter",
      id: "autoScoredLow",
      label: "Low goal",
    });
  });

  it("leaves an override for a field that isn't on this form alone", () => {
    expect(
      applyCustomization(DEFAULTS, withOverrides({ notAField: { label: "X" } })),
    ).toEqual(DEFAULTS);
  });

  it("edits and strikes are independent — a struck field stays struck", () => {
    const result = applyCustomization(DEFAULTS, {
      ...emptyCustomization(),
      hiddenFieldIds: ["autoMobility"],
      fieldOverrides: { autoMobility: { label: "Renamed" } },
    });
    expect(result[0].fields.map((f) => f.id)).toEqual(["autoScoredLow"]);
  });

  it("a renamed question still carries a required answer under its own id", () => {
    const sections = applyCustomization(
      DEFAULTS,
      withOverrides({ autoMobility: { label: "Crossed the line?", required: true } }),
    );
    expect(missingRequiredFields(sections, emptyValues(sections))).toEqual([
      "Crossed the line?",
    ]);
  });
});

describe("setFieldOverride", () => {
  it("stores only the parts that carry a value", () => {
    const result = setFieldOverride(emptyCustomization(), "endgame", {
      label: "  Climb  ",
      options: [],
      required: undefined,
    });
    // Trimmed, and the empty options list is not stored at all — Firestore
    // rejects undefined, and an empty choice list is not an edit.
    expect(result.fieldOverrides).toEqual({ endgame: { label: "Climb" } });
  });

  it("drops the key entirely when an edit changes nothing", () => {
    const edited = setFieldOverride(emptyCustomization(), "endgame", {
      label: "Climb",
    });
    const cleared = setFieldOverride(edited, "endgame", {
      label: "",
      options: [],
    });
    expect(cleared.fieldOverrides).toEqual({});
  });

  it("leaves other fields' overrides alone", () => {
    const first = setFieldOverride(emptyCustomization(), "a", { label: "A" });
    const second = setFieldOverride(first, "b", { label: "B" });
    expect(second.fieldOverrides).toEqual({ a: { label: "A" }, b: { label: "B" } });
    // Pure: the input is not mutated.
    expect(first.fieldOverrides).toEqual({ a: { label: "A" } });
  });

  it("never writes an undefined value, which Firestore rejects", () => {
    const result = setFieldOverride(emptyCustomization(), "endgame", {
      label: "Climb",
      options: undefined,
      required: undefined,
    });
    expect(
      Object.values(result.fieldOverrides.endgame).some((v) => v === undefined),
    ).toBe(false);
  });
});

describe("updateCustomField", () => {
  it("rewrites a team question in place, keeping its id", () => {
    const start = {
      ...emptyCustomization(),
      customFields: [custom({ id: "custom_q", label: "Old", kind: "text" as const })],
    };
    const result = updateCustomField(start, "custom_q", {
      kind: "select",
      label: "New",
      section: "Endgame",
      options: ["Yes", "No"],
      required: true,
    });
    expect(result.customFields).toEqual([
      {
        id: "custom_q",
        kind: "select",
        label: "New",
        section: "Endgame",
        options: ["Yes", "No"],
        required: true,
      },
    ]);
  });

  it("ignores an id that isn't a team question", () => {
    const start = {
      ...emptyCustomization(),
      customFields: [custom({ id: "custom_q" })],
    };
    expect(
      updateCustomField(start, "custom_other", {
        kind: "text",
        label: "X",
        section: "Endgame",
      }).customFields,
    ).toEqual(start.customFields);
  });
});

describe("sanitizeScoutFormsConfig — field overrides", () => {
  it("keeps a well-formed override", () => {
    const config = sanitizeScoutFormsConfig({
      pitScout: {
        fieldOverrides: {
          drivetrain: { label: "Drive type", options: ["Tank", "Swerve"], required: true },
        },
      },
    });
    expect(config.pitScout.fieldOverrides).toEqual({
      drivetrain: { label: "Drive type", options: ["Tank", "Swerve"], required: true },
    });
  });

  it("drops junk without dropping the rest of the config", () => {
    const config = sanitizeScoutFormsConfig({
      pitScout: {
        fieldOverrides: {
          ok: { label: "Fine" },
          blankLabel: { label: "   " },
          emptyOptions: { options: [] },
          wrongTypes: { label: 7, options: "nope", required: "yes" },
          notAnObject: "nope",
          nothingLeft: {},
        },
      },
    });
    expect(config.pitScout.fieldOverrides).toEqual({ ok: { label: "Fine" } });
  });

  it("defaults to no overrides on a config saved before editing shipped", () => {
    const config = sanitizeScoutFormsConfig({ pitScout: { hiddenFieldIds: ["a"] } });
    expect(config.pitScout.fieldOverrides).toEqual({});
    expect(config.matchScout.fieldOverrides).toEqual({});
  });

  it("keeps required:false, which means 'no longer required'", () => {
    const config = sanitizeScoutFormsConfig({
      matchScout: { fieldOverrides: { notes: { required: false } } },
    });
    expect(config.matchScout.fieldOverrides).toEqual({ notes: { required: false } });
  });
});
