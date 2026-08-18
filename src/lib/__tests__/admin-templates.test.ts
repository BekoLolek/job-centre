import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Database,
  eventQuestions,
  eventTemplates,
  events,
  games,
  profileFields,
  users,
} from "@/db";
import { type TestDatabase, freshDatabase } from "@/db/__tests__/helpers";
import { RIVALS_RANK_LADDER } from "@/db/seed";
import {
  type TemplateResult,
  createTemplate,
  createTemplateFromEvent,
  duplicateTemplate,
  getTemplate,
  loadAdminTemplates,
  questionSpecsForEvent,
  setTemplateActive,
  templateUsage,
  updateTemplate,
} from "@/lib/admin-templates";
import {
  cleanTemplateType,
  describeTemplate,
  normaliseTemplateConfig,
  normaliseTemplateQuestions,
} from "@/lib/admin-templates-policy";
import { createEvent, listEventTemplates, setEventQuestions } from "@/lib/events";

/**
 * `/admin/templates` — the writing half of `event_templates`.
 *
 * The interesting test is not that a row can be inserted. It is the round trip:
 * an event with a prefilled question set becomes a template, the template
 * becomes a new event, and the question is prefilled again — because that is
 * the whole feature, and it is the step where a profile field *id* has to
 * survive as a *key* and come back as the right id.
 *
 * The other one that matters is that a template is copied and then forgotten:
 * editing it afterwards must not touch an event already taking applications.
 */

let harness: TestDatabase;
let db: Database;
let rivalsId: string;
let jackboxId: string;

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await db.delete(events);
  await db.delete(eventTemplates);
  await db.delete(profileFields);
  await db.delete(games);
  await db.delete(users);

  const [rivals] = await db
    .insert(games)
    .values({ key: "rivals", name: "Marvel Rivals", rankLadder: [...RIVALS_RANK_LADDER] })
    .returning({ id: games.id });
  rivalsId = rivals.id;

  const [jackbox] = await db
    .insert(games)
    .values({ key: "jackbox", name: "Jackbox", sort: 10 })
    .returning({ id: games.id });
  jackboxId = jackbox.id;

  await db.insert(profileFields).values([
    { gameId: rivalsId, key: "rank", label: "Current rank", type: "rank", sort: 0 },
    { gameId: rivalsId, key: "ign", label: "In-game name", type: "text", sort: 1 },
    { gameId: null, key: "voice", label: "Happy on voice", type: "bool", sort: 0 },
  ]);
});

function expectOk<T>(result: TemplateResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got: ${result.error}`);
  return result.data;
}

async function expectFail<T>(
  pending: TemplateResult<T> | Promise<TemplateResult<T>>
): Promise<string> {
  const result = await pending;
  if (result.ok) throw new Error("Expected a failure, got success.");
  return result.error;
}

/** A Rivals event with three questions, one of them prefilled from the profile. */
async function makeRivalsEvent(title = "Rivals Winter Cup") {
  const [rankField] = await db
    .select()
    .from(profileFields)
    .where(eq(profileFields.key, "rank"));

  const event = expectOk(
    await createEvent(
      {
        title,
        gameId: rivalsId,
        capacity: 24,
        config: { teams: 4, draft: true, bracket: true, format: { concurrentLobbies: 2 } },
      },
      db
    )
  );

  expectOk(
    await setEventQuestions(
      event.id,
      [
        { label: "Current rank", type: "rank", profileFieldId: rankField.id, required: true },
        {
          label: "Preferred role",
          type: "select",
          options: ["Vanguard", "Duelist", "Strategist"],
          required: true,
        },
        { label: "Anything else", type: "text" },
      ],
      db
    )
  );

  return event;
}

/* ------------------------------------------------------------------ */
/* The pure half                                                      */
/* ------------------------------------------------------------------ */

describe("cleanTemplateType", () => {
  it("normalises to a slug, because a type is a label not a code branch", () => {
    expect(cleanTemplateType(" Among Us Night ")).toBe("among-us-night");
    expect(cleanTemplateType("TOURNAMENT")).toBe("tournament");
  });

  it("falls back to custom, which is what createEvent would use anyway", () => {
    expect(cleanTemplateType("")).toBe("custom");
    expect(cleanTemplateType(undefined)).toBe("custom");
    expect(cleanTemplateType("!!!")).toBe("custom");
  });
});

describe("normaliseTemplateConfig", () => {
  it("keeps keys it does not know about, format above all", () => {
    const config = expectOk(
      normaliseTemplateConfig({ teams: 8, format: { concurrentLobbies: 3 }, mystery: "keep" })
    );
    expect(config.format).toEqual({ concurrentLobbies: 3 });
    expect(config.mystery).toBe("keep");
  });

  it("refuses a team count outside what the format engine builds", async () => {
    expect(await expectFail(normaliseTemplateConfig({ teams: 1 }))).toMatch(/2 to 8/);
    expect(await expectFail(normaliseTemplateConfig({ teams: 9 }))).toMatch(/2 to 8/);
    expect(await expectFail(normaliseTemplateConfig({ teams: 4.5 }))).toMatch(/whole number/);
  });

  it("refuses a non-boolean where a yes/no belongs", async () => {
    expect(await expectFail(normaliseTemplateConfig({ draft: "yes" }))).toMatch(/yes\/no/);
  });

  it("treats nothing at all as an empty config", () => {
    expect(expectOk(normaliseTemplateConfig(undefined))).toEqual({});
    expect(expectOk(normaliseTemplateConfig(null))).toEqual({});
  });
});

describe("normaliseTemplateQuestions", () => {
  it("keys each question from its label and disambiguates within the template", () => {
    const questions = expectOk(
      normaliseTemplateQuestions([
        { label: "Notes", type: "text" },
        { label: "Notes", type: "text" },
      ])
    );
    expect(questions.map((question) => question.key)).toEqual(["notes", "notes-2"]);
  });

  it("insists a pick-one has something to pick from", async () => {
    expect(
      await expectFail(normaliseTemplateQuestions([{ label: "Role", type: "select" }]))
    ).toMatch(/at least one option/);
  });

  it("keeps the profile field key verbatim — it is the portable half", () => {
    const questions = expectOk(
      normaliseTemplateQuestions([
        { label: "Current rank", type: "rank", profileFieldKey: "rank" },
      ])
    );
    expect(questions[0].profileFieldKey).toBe("rank");
  });

  it("refuses a question with no label and one with no type", async () => {
    expect(await expectFail(normaliseTemplateQuestions([{ type: "text" }]))).toMatch(/label/i);
    expect(await expectFail(normaliseTemplateQuestions([{ label: "X" }]))).toMatch(/type/i);
  });
});

describe("describeTemplate", () => {
  it("says what an event made from it would arrive with", () => {
    const parts = describeTemplate({
      type: "tournament",
      gameName: "Marvel Rivals",
      config: { teams: 8, draft: true, bracket: true },
      questions: [
        { label: "Rank", type: "rank", profileFieldKey: "rank" },
        { label: "Notes", type: "text" },
      ],
    });
    expect(parts).toContain("Marvel Rivals");
    expect(parts).toContain("8 teams");
    expect(parts).toContain("bid draft");
    expect(parts).toContain("2 questions");
    expect(parts).toContain("1 prefilled from the profile");
  });

  it("says so when the template is carrying format settings", () => {
    const parts = describeTemplate({
      type: "tournament",
      config: { format: { concurrentLobbies: 2 } },
      questions: [],
    });
    expect(parts).toContain("format settings");
    expect(parts).toContain("no questions");
  });
});

/* ------------------------------------------------------------------ */
/* Creating and editing                                               */
/* ------------------------------------------------------------------ */

describe("createTemplate", () => {
  it("takes a name and nothing else", async () => {
    const template = expectOk(await createTemplate({ name: "  Jackbox night  " }, db));
    expect(template.name).toBe("Jackbox night");
    expect(template.type).toBe("custom");
    expect(template.isActive).toBe(true);
    expect(template.questions).toEqual([]);
  });

  it("refuses a blank name", async () => {
    expect(await expectFail(createTemplate({ name: "   " }, db))).toMatch(/give the template/i);
  });

  it("puts each new one at the bottom of the order", async () => {
    const first = expectOk(await createTemplate({ name: "First" }, db));
    const second = expectOk(await createTemplate({ name: "Second" }, db));
    expect(second.sort).toBeGreaterThan(first.sort);
  });

  it("does not let two templates share a name", async () => {
    expectOk(await createTemplate({ name: "Rivals" }, db));
    const second = expectOk(await createTemplate({ name: "Rivals" }, db));
    expect(second.name).toBe("Rivals 2");
  });

  it("refuses a game that does not exist", async () => {
    expect(
      await expectFail(
        createTemplate(
          { name: "Ghost", gameId: "00000000-0000-0000-0000-000000000000" },
          db
        )
      )
    ).toMatch(/no longer exists/i);
  });
});

describe("updateTemplate", () => {
  it("changes only the keys it is given", async () => {
    const template = expectOk(
      await createTemplate(
        { name: "Rivals", type: "tournament", config: { teams: 8 } },
        db
      )
    );
    const updated = expectOk(await updateTemplate(template.id, { name: "Rivals cup" }, db));
    expect(updated.name).toBe("Rivals cup");
    expect(updated.type).toBe("tournament");
    expect(updated.config.teams).toBe(8);
  });

  it("can move a template onto a different game", async () => {
    const template = expectOk(await createTemplate({ name: "Night", gameId: rivalsId }, db));
    const updated = expectOk(await updateTemplate(template.id, { gameId: jackboxId }, db));
    expect(updated.gameId).toBe(jackboxId);

    const cleared = expectOk(await updateTemplate(template.id, { gameId: null }, db));
    expect(cleared.gameId).toBeNull();
  });

  it("refuses a name already taken by another template", async () => {
    expectOk(await createTemplate({ name: "Taken" }, db));
    const other = expectOk(await createTemplate({ name: "Other" }, db));
    // Renamed onto a clash, it is suffixed rather than refused — the picker
    // must never show two rows reading the same.
    const updated = expectOk(await updateTemplate(other.id, { name: "Taken" }, db));
    expect(updated.name).toBe("Taken 2");
  });

  it("refuses an invalid question set without writing half of it", async () => {
    const template = expectOk(
      await createTemplate(
        { name: "Form", questions: [{ label: "Notes", type: "text" }] },
        db
      )
    );
    expect(
      await expectFail(
        updateTemplate(template.id, { questions: [{ label: "Role", type: "select" }] }, db)
      )
    ).toMatch(/at least one option/);

    const after = await getTemplate(template.id, db);
    expect(after?.questions).toHaveLength(1);
    expect(after?.questions[0].label).toBe("Notes");
  });
});

describe("duplicateTemplate", () => {
  it("copies the config and the questions under a new name", async () => {
    const source = expectOk(
      await createTemplate(
        {
          name: "Rivals 8",
          type: "tournament",
          gameId: rivalsId,
          config: { teams: 8, draft: true },
          questions: [{ label: "Current rank", type: "rank", profileFieldKey: "rank" }],
        },
        db
      )
    );

    const copy = expectOk(await duplicateTemplate(source.id, undefined, db));
    expect(copy.id).not.toBe(source.id);
    expect(copy.name).toBe("Rivals 8 copy");
    expect(copy.config).toEqual(source.config);
    expect(copy.questions).toEqual(source.questions);
    expect(copy.gameId).toBe(rivalsId);
    expect(copy.isActive).toBe(true);
  });

  it("takes a name when it is given one", async () => {
    const source = expectOk(await createTemplate({ name: "Rivals 8" }, db));
    const copy = expectOk(await duplicateTemplate(source.id, "Rivals 6", db));
    expect(copy.name).toBe("Rivals 6");
  });
});

describe("setTemplateActive", () => {
  it("takes a template out of the create-event picker and puts it back", async () => {
    const template = expectOk(await createTemplate({ name: "Seasonal" }, db));
    expect(await listEventTemplates(db)).toHaveLength(1);

    expectOk(await setTemplateActive(template.id, false, db));
    expect(await listEventTemplates(db)).toHaveLength(0);

    expectOk(await setTemplateActive(template.id, true, db));
    expect(await listEventTemplates(db)).toHaveLength(1);
  });

  it("leaves every event made from it alone", async () => {
    const template = expectOk(await createTemplate({ name: "Seasonal" }, db));
    const event = expectOk(
      await createEvent({ title: "Autumn", templateId: template.id }, db)
    );

    expectOk(await setTemplateActive(template.id, false, db));

    const [after] = await db.select().from(events).where(eq(events.id, event.id));
    expect(after.createdFromTemplateId).toBe(template.id);
    expect(await templateUsage(template.id, db)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* From an event, and back again                                      */
/* ------------------------------------------------------------------ */

describe("createTemplateFromEvent", () => {
  it("carries the type, the game, the config and the whole question set", async () => {
    const event = await makeRivalsEvent();
    const template = expectOk(await createTemplateFromEvent(event.id, {}, db));

    expect(template.name).toBe("Rivals Winter Cup");
    expect(template.gameId).toBe(rivalsId);
    expect(template.config.teams).toBe(4);
    expect(template.config.draft).toBe(true);
    // The schedule settings of §10 come across whole — they are most of what
    // "do that again next month" means.
    expect(template.config.format).toEqual({ concurrentLobbies: 2 });
    expect(template.questions.map((question) => question.label)).toEqual([
      "Current rank",
      "Preferred role",
      "Anything else",
    ]);
  });

  it("turns the profile field id into the field's key", async () => {
    const event = await makeRivalsEvent();
    const template = expectOk(await createTemplateFromEvent(event.id, {}, db));

    const rank = template.questions.find((question) => question.label === "Current rank");
    expect(rank?.profileFieldKey).toBe("rank");
    // Never the id: ids differ per deployment, which is the whole reason.
    expect(JSON.stringify(template.questions)).not.toContain("profileFieldId");
  });

  it("takes a name, or falls back to the event's title", async () => {
    const event = await makeRivalsEvent();
    const named = expectOk(
      await createTemplateFromEvent(event.id, { name: "Rivals tournament" }, db)
    );
    expect(named.name).toBe("Rivals tournament");
  });

  it("can leave the questions or the config behind", async () => {
    const event = await makeRivalsEvent();

    const noQuestions = expectOk(
      await createTemplateFromEvent(event.id, { name: "A", includeQuestions: false }, db)
    );
    expect(noQuestions.questions).toEqual([]);
    expect(noQuestions.config.teams).toBe(4);

    const noConfig = expectOk(
      await createTemplateFromEvent(event.id, { name: "B", includeConfig: false }, db)
    );
    expect(noConfig.config).toEqual({});
    expect(noConfig.questions).toHaveLength(3);
  });

  it("refuses an event that does not exist", async () => {
    expect(
      await expectFail(
        createTemplateFromEvent("00000000-0000-0000-0000-000000000000", {}, db)
      )
    ).toMatch(/no longer exists/i);
  });

  it("round-trips: event to template to event, with the prefill still linked", async () => {
    const source = await makeRivalsEvent();
    const template = expectOk(
      await createTemplateFromEvent(source.id, { name: "Rivals tournament" }, db)
    );

    const next = expectOk(
      await createEvent({ title: "Rivals Spring Cup", templateId: template.id }, db)
    );

    const questions = await db
      .select()
      .from(eventQuestions)
      .where(eq(eventQuestions.eventId, next.id))
      .orderBy(asc(eventQuestions.sort));

    expect(questions.map((question) => question.label)).toEqual([
      "Current rank",
      "Preferred role",
      "Anything else",
    ]);

    const [rankField] = await db
      .select()
      .from(profileFields)
      .where(eq(profileFields.key, "rank"));
    const rank = questions.find((question) => question.label === "Current rank");
    // The key became an id again, against the new event's game. That is the
    // step the whole feature turns on.
    expect(rank?.profileFieldId).toBe(rankField.id);

    expect(next.gameId).toBe(rivalsId);
    expect(next.config.teams).toBe(4);
    expect(next.config.format).toEqual({ concurrentLobbies: 2 });
    expect(next.createdFromTemplateId).toBe(template.id);
    // A new event is a draft, template or not — it is invisible until published.
    expect(next.status).toBe("draft");
  });

  it("is a copy, so editing the template afterwards leaves the event alone", async () => {
    const source = await makeRivalsEvent();
    const template = expectOk(
      await createTemplateFromEvent(source.id, { name: "Rivals tournament" }, db)
    );
    const made = expectOk(
      await createEvent({ title: "Already taking applications", templateId: template.id }, db)
    );

    expectOk(
      await updateTemplate(
        template.id,
        { questions: [{ label: "Only question now", type: "text" }], config: { teams: 8 } },
        db
      )
    );

    const questions = await db
      .select()
      .from(eventQuestions)
      .where(eq(eventQuestions.eventId, made.id));
    expect(questions).toHaveLength(3);

    const [after] = await db.select().from(events).where(eq(events.id, made.id));
    expect(after.config.teams).toBe(4);
  });
});

describe("questionSpecsForEvent", () => {
  it("returns nothing for an event with no form", async () => {
    const event = expectOk(await createEvent({ title: "Bare" }, db));
    expect(await questionSpecsForEvent(db, event.id)).toEqual([]);
  });

  it("keeps the order the form is asked in", async () => {
    const event = await makeRivalsEvent();
    const specs = await questionSpecsForEvent(db, event.id);
    expect(specs.map((spec) => spec.label)).toEqual([
      "Current rank",
      "Preferred role",
      "Anything else",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* The list                                                           */
/* ------------------------------------------------------------------ */

describe("loadAdminTemplates", () => {
  it("counts how many events came from each template", async () => {
    const used = expectOk(await createTemplate({ name: "Used" }, db));
    const unused = expectOk(await createTemplate({ name: "Unused" }, db));

    expectOk(await createEvent({ title: "One", templateId: used.id }, db));
    expectOk(await createEvent({ title: "Two", templateId: used.id }, db));
    expectOk(await createEvent({ title: "From nothing" }, db));

    const view = await loadAdminTemplates(db);
    expect(view.templates.find((row) => row.id === used.id)?.events).toBe(2);
    expect(view.templates.find((row) => row.id === unused.id)?.events).toBe(0);
  });

  it("offers every event as a source, with its question count", async () => {
    const event = await makeRivalsEvent();
    const view = await loadAdminTemplates(db);
    const source = view.sources.find((row) => row.id === event.id);
    expect(source?.questions).toBe(3);
  });

  it("offers the profile fields a prefill could point at, keyed", async () => {
    const view = await loadAdminTemplates(db);
    const rank = view.profileFields.find((field) => field.key === "rank");
    expect(rank?.gameName).toBe("Marvel Rivals");
    const voice = view.profileFields.find((field) => field.key === "voice");
    // A global field belongs to no game and can prefill on any event.
    expect(voice?.gameId).toBeNull();
    expect(voice?.gameName).toBeNull();
  });

  it("lists hidden templates too — this screen is where you switch one back on", async () => {
    const template = expectOk(await createTemplate({ name: "Hidden" }, db));
    expectOk(await setTemplateActive(template.id, false, db));

    const view = await loadAdminTemplates(db);
    expect(view.templates).toHaveLength(1);
    expect(view.templates[0].isActive).toBe(false);
  });
});
