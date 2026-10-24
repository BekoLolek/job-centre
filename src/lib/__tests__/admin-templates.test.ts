import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Database,
  applications,
  eventDays,
  eventQuestions,
  eventTemplates,
  events,
  games,
  profileFields,
  users,
} from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { RIVALS_RANK_LADDER } from "@/db/seed";
import {
  type TemplateResult,
  createTemplate,
  createTemplateFromEvent,
  deleteTemplate,
  duplicateTemplate,
  getTemplate,
  loadAdminTemplates,
  moveTemplate,
  questionSpecsForEvent,
  setTemplateActive,
  templateUsage,
  updateTemplate,
} from "@/lib/admin-templates";
import {
  TEMPLATE_OMITS,
  cleanTemplateType,
  describeTemplate,
  normaliseTemplateConfig,
  normaliseTemplateQuestions,
} from "@/lib/admin-templates-policy";
import {
  applyToEvent,
  createEvent,
  listEventTemplates,
  publishEvent,
  setEventQuestions,
} from "@/lib/events";
import { type RoundScoring, roundScoringFrom } from "@/lib/events-policy";
import { MAX_ROUNDS } from "@/lib/round-scoring";

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

/**
 * A six-round, highest-wins night with two bonuses — UC-44 5's example.
 * `satisfies` rather than a type annotation: `RoundScoring`'s arrays are
 * readonly, and a config literal has to be a mutable `SettingValue`.
 */
const POPSAUCE = {
  rounds: [
    { name: null },
    { name: null },
    { name: "Semis" },
    { name: null },
    { name: null },
    { name: "Final" },
  ],
  lowWins: false,
  bonuses: [
    { key: "Sub-0.5 answer", value: 2 },
    { key: "Gold run", value: 5 },
  ],
} satisfies RoundScoring;

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

  it("keeps the two entry modes and refuses anything else (R-27)", async () => {
    expect(expectOk(normaliseTemplateConfig({ entryMode: "approval" })).entryMode).toBe(
      "approval"
    );
    expect(expectOk(normaliseTemplateConfig({ entryMode: "first_come" })).entryMode).toBe(
      "first_come"
    );
    expect(await expectFail(normaliseTemplateConfig({ entryMode: "lottery" }))).toMatch(
      /first come or by approval/i
    );
  });

  it("carries a scoring setup through, exactly as stored (R-237)", () => {
    const config = expectOk(normaliseTemplateConfig({ roundScoring: POPSAUCE }));
    expect(config.roundScoring).toEqual(POPSAUCE);
    // Null is "no setup", the way `teams: null` is "no teams".
    expect(expectOk(normaliseTemplateConfig({ roundScoring: null })).roundScoring).toBeNull();
  });

  it("refuses a malformed scoring setup in the Scoring panel's own words, rather than stripping it", async () => {
    const worthless = await expectFail(
      normaliseTemplateConfig({
        roundScoring: { ...POPSAUCE, bonuses: [{ key: "Fast", value: 0 }] },
      })
    );
    expect(worthless).toBe('"Fast" has to be worth at least a point. A penalty is not a bonus.');
    expect(worthless).not.toContain("Two bonuses");

    const twice = await expectFail(
      normaliseTemplateConfig({
        roundScoring: { ...POPSAUCE, bonuses: [{ key: "Fast", value: 2 }, { key: " fast", value: 1 }] },
      })
    );
    expect(twice).toBe(
      'Two bonuses are called "fast". The scoring screen picks a bonus out by its name, so each needs its own.'
    );
    expect(twice).not.toContain("worth");

    expect(await expectFail(normaliseTemplateConfig({ roundScoring: { ...POPSAUCE, rounds: [] } }))).toBe(
      "A night has at least one round."
    );
    const tooMany = Array.from({ length: MAX_ROUNDS + 1 }, () => ({ name: null }));
    expect(
      await expectFail(normaliseTemplateConfig({ roundScoring: { ...POPSAUCE, rounds: tooMany } }))
    ).toBe(`A night has at most ${MAX_ROUNDS} rounds.`);
  });

  it("refuses a key that is not a setup at all, because carrying it would be stripping it quietly", async () => {
    // `roundScoringFrom` reads each of these as "not round-scored", so a
    // template that stored one would make events with no scoring and nothing
    // on the template saying so.
    for (const stored of ["rounds", [1, 2], { lowWins: true }, { rounds: "six" }]) {
      expect(
        await expectFail(normaliseTemplateConfig({ roundScoring: stored })),
        JSON.stringify(stored)
      ).toBe("The scoring setup has to say what the night's rounds are.");
    }
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

  it("says an approval template is by approval instead of naming its waitlist", () => {
    // UC-08 6a. The waitlist default is first-come's (R-170), so a template
    // carrying both must not preview as though the cap decided anything.
    const parts = describeTemplate({
      type: "custom",
      config: { entryMode: "approval", waitlist: false },
      questions: [],
    });
    expect(parts).toContain("by approval");
    expect(parts).not.toContain("no waitlist");
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

  it("says how a template's nights are scored, in the Scoring panel's sentence (R-237)", () => {
    // The honesty rule in the docblock: a template that makes every event from
    // it a round-scored night must not be described as though it did not.
    const parts = describeTemplate({
      type: "custom",
      config: { roundScoring: POPSAUCE },
      questions: [],
    });
    expect(parts).toContain("6 rounds, highest total wins, 2 bonuses");

    const silent = describeTemplate({ type: "custom", config: { teams: 4 }, questions: [] });
    expect(silent.some((part) => part.includes("total wins"))).toBe(false);
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

  /*
   * Rewritten for UC-28 4a, which says a name "already used" is *rejected*.
   * This used to assert the silent "Rivals 2", which is the behaviour the Gate
   * 2 amendment to UC-15 6a ruled against for the same reason: an automatic
   * name may be suffixed, a typed one is refused, because renaming what
   * somebody typed without telling them is worse than refusing it.
   */
  it("refuses a name another template already has (UC-28 4a)", async () => {
    expectOk(await createTemplate({ name: "Rivals" }, db));
    expect(await expectFail(createTemplate({ name: "Rivals" }, db))).toMatch(
      /already called "Rivals"/
    );
  });

  it("folds case and spaces before deciding a name is taken", async () => {
    expectOk(await createTemplate({ name: "Rivals cup" }, db));
    expect(await expectFail(createTemplate({ name: "  rivals   CUP " }, db))).toMatch(
      /already called/i
    );
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

  // Also rewritten for UC-28 4a: a rename is a typed name like any other, so
  // the rule has to hold on the way through as well as on the way in.
  it("refuses a rename onto a name another template has (UC-28 4a)", async () => {
    expectOk(await createTemplate({ name: "Taken" }, db));
    const other = expectOk(await createTemplate({ name: "Other" }, db));
    expect(await expectFail(updateTemplate(other.id, { name: "Taken" }, db))).toMatch(
      /already called "Taken"/
    );

    // And the old name is still standing — nothing was half-written.
    expect((await getTemplate(other.id, db))?.name).toBe("Other");
  });

  it("lets a template keep its own name, so saving an unchanged card works", async () => {
    const template = expectOk(await createTemplate({ name: "Rivals cup" }, db));
    const saved = expectOk(
      await updateTemplate(template.id, { name: "Rivals cup", type: "tournament" }, db)
    );
    expect(saved.name).toBe("Rivals cup");
    expect(saved.type).toBe("tournament");
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
/* Order (R-129 / UC-28 7, 8)                                         */
/* ------------------------------------------------------------------ */

describe("moveTemplate", () => {
  /** The templates as both screens read them: `sort`, then `name`. */
  async function order(): Promise<string[]> {
    const view = await loadAdminTemplates(db);
    return view.templates.map((template) => template.name);
  }

  it("swaps two templates and renumbers sort densely", async () => {
    expectOk(await createTemplate({ name: "First" }, db));
    const second = expectOk(await createTemplate({ name: "Second" }, db));
    expectOk(await createTemplate({ name: "Third" }, db));

    expectOk(await moveTemplate(second.id, "up", db));
    expect(await order()).toEqual(["Second", "First", "Third"]);

    const rows = await db
      .select({ sort: eventTemplates.sort })
      .from(eventTemplates)
      .orderBy(asc(eventTemplates.sort));
    expect(rows.map((row) => row.sort)).toEqual([0, 1, 2]);
  });

  it("does nothing at the ends", async () => {
    const first = expectOk(await createTemplate({ name: "First" }, db));
    const last = expectOk(await createTemplate({ name: "Second" }, db));

    expectOk(await moveTemplate(first.id, "up", db));
    expectOk(await moveTemplate(last.id, "down", db));
    expect(await order()).toEqual(["First", "Second"]);
  });

  it("recovers an order even when two rows arrived sharing a sort", async () => {
    // A seed, or any write that did not go through `createTemplate`, can leave
    // two rows on the same number — at which point the list falls back to the
    // alphabet and an arrow looks broken. One move renumbers the lot.
    await db.insert(eventTemplates).values([
      { name: "Beta", sort: 0 },
      { name: "Alpha", sort: 0 },
    ]);
    const [beta] = await db
      .select({ id: eventTemplates.id })
      .from(eventTemplates)
      .where(eq(eventTemplates.name, "Beta"));

    expect(await order()).toEqual(["Alpha", "Beta"]);
    expectOk(await moveTemplate(beta.id, "up", db));
    expect(await order()).toEqual(["Beta", "Alpha"]);
  });

  it("reports a template that is gone", async () => {
    expect(
      await expectFail(
        moveTemplate("00000000-0000-0000-0000-000000000000", "up", db)
      )
    ).toMatch(/no longer exists/i);
  });
});

/* ------------------------------------------------------------------ */
/* Deleting (UC-28 8a)                                                */
/* ------------------------------------------------------------------ */

describe("deleteTemplate", () => {
  /**
   * UC-28 8a: "Deleting a template events were created from - System keeps
   * those events and forgets only the link."
   *
   * The one flow in this use case where getting it wrong destroys something a
   * community spent a season on, so it is asserted on the event rows rather
   * than on the return value: the event is still there, it still has its
   * questions and its config, and the only thing that changed is that it no
   * longer names where it came from. The foreign key is `on delete set null`
   * (`drizzle/0006_puzzling_shockwave.sql`) and this is what proves it — a
   * cascade would take the whole event with it.
   */
  it("keeps every event made from it, and forgets only the link", async () => {
    const template = expectOk(
      await createTemplate(
        {
          name: "Rivals monthly",
          type: "tournament",
          gameId: rivalsId,
          config: { teams: 4, draft: true },
          questions: [{ label: "Current rank", type: "rank", profileFieldKey: "rank" }],
        },
        db
      )
    );

    const autumn = expectOk(
      await createEvent({ title: "Autumn cup", templateId: template.id }, db)
    );
    const winter = expectOk(
      await createEvent({ title: "Winter cup", templateId: template.id }, db)
    );
    expect(await templateUsage(template.id, db)).toBe(2);

    const removed = expectOk(await deleteTemplate(template.id, db));
    expect(removed.usedBy).toBe(2);
    expect(removed.name).toBe("Rivals monthly");

    // The template is gone from both reads.
    expect(await getTemplate(template.id, db)).toBeNull();
    expect(await listEventTemplates(db)).toHaveLength(0);

    // Both events are still here, with everything they copied.
    const rows = await db
      .select()
      .from(events)
      .where(inArray(events.id, [autumn.id, winter.id]));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.createdFromTemplateId).toBeNull();
      expect(row.gameId).toBe(rivalsId);
      expect(row.config.teams).toBe(4);
      expect(row.config.draft).toBe(true);
    }

    const questions = await db
      .select()
      .from(eventQuestions)
      .where(eq(eventQuestions.eventId, autumn.id));
    expect(questions).toHaveLength(1);
    expect(questions[0].label).toBe("Current rank");
  });

  it("keeps the applications on an event whose template went", async () => {
    // The sharpest version of the same property: a cascade would reach past the
    // event into the people who applied to it.
    const template = expectOk(await createTemplate({ name: "Open night" }, db));
    const event = expectOk(
      await createEvent(
        { ...PUBLISHABLE, title: "Open night one", templateId: template.id, capacity: 8 },
        db
      )
    );
    expectOk(await publishEvent(event.id, db));

    const member = await makeUser(db, { displayName: "Ada" });
    expectOk(await applyToEvent(event.id, member, {}, db));

    expectOk(await deleteTemplate(template.id, db));

    const rows = await db
      .select()
      .from(applications)
      .where(eq(applications.eventId, event.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(member);
  });

  it("closes the gap in sort so the arrows keep working", async () => {
    const first = expectOk(await createTemplate({ name: "First" }, db));
    expectOk(await createTemplate({ name: "Second" }, db));
    expectOk(await createTemplate({ name: "Third" }, db));

    expectOk(await deleteTemplate(first.id, db));

    const rows = await db
      .select({ name: eventTemplates.name, sort: eventTemplates.sort })
      .from(eventTemplates)
      .orderBy(asc(eventTemplates.sort));
    expect(rows).toEqual([
      { name: "Second", sort: 0 },
      { name: "Third", sort: 1 },
    ]);
  });

  it("frees the name it was using", async () => {
    const template = expectOk(await createTemplate({ name: "Rivals cup" }, db));
    expectOk(await deleteTemplate(template.id, db));
    expect(expectOk(await createTemplate({ name: "Rivals cup" }, db)).name).toBe(
      "Rivals cup"
    );
  });

  it("reports a template that is already gone", async () => {
    expect(
      await expectFail(deleteTemplate("00000000-0000-0000-0000-000000000000", db))
    ).toMatch(/no longer exists/i);
  });
});

/* ------------------------------------------------------------------ */
/* The whole of UC-28, step by step                                   */
/* ------------------------------------------------------------------ */

describe("maintaining templates (UC-28)", () => {
  it("1-2: lists them in order, with the usage count and whether each is on", async () => {
    const quiet = expectOk(await createTemplate({ name: "Quiz night" }, db));
    const busy = expectOk(await createTemplate({ name: "Rivals monthly" }, db));
    expectOk(await createEvent({ title: "March", templateId: busy.id }, db));
    expectOk(await createEvent({ title: "April", templateId: busy.id }, db));
    expectOk(await setTemplateActive(quiet.id, false, db));

    const view = await loadAdminTemplates(db);
    expect(view.templates.map((template) => template.name)).toEqual([
      "Quiz night",
      "Rivals monthly",
    ]);
    expect(view.templates.map((template) => template.events)).toEqual([0, 2]);
    expect(view.templates.map((template) => template.isActive)).toEqual([false, true]);
  });

  it("3-4: creates one from scratch with a kind, questions, entry mode and format", async () => {
    const template = expectOk(
      await createTemplate(
        {
          name: "Rivals monthly",
          type: "Tournament",
          gameId: rivalsId,
          config: {
            teams: 4,
            draft: true,
            bracket: true,
            entryMode: "approval",
            format: { concurrentLobbies: 2 },
          },
          questions: [
            { label: "Current rank", type: "rank", profileFieldKey: "rank", required: true },
            { label: "Preferred role", type: "select", options: ["Vanguard", "Duelist"] },
          ],
        },
        db
      )
    );

    expect(template.type).toBe("tournament");
    expect(template.gameId).toBe(rivalsId);
    expect(template.config.entryMode).toBe("approval");
    expect(template.config.format).toEqual({ concurrentLobbies: 2 });
    expect(template.questions.map((question) => question.label)).toEqual([
      "Current rank",
      "Preferred role",
    ]);
    // 4: saved, and offered to the create-event picker straight away.
    expect((await listEventTemplates(db)).map((row) => row.id)).toContain(template.id);
  });

  it("4a: refuses a name that is blank, and one another template has", async () => {
    expectOk(await createTemplate({ name: "Rivals monthly" }, db));
    expect(await expectFail(createTemplate({ name: "  " }, db))).toMatch(
      /give the template a name/i
    );
    expect(await expectFail(createTemplate({ name: "Rivals monthly" }, db))).toMatch(
      /already called/i
    );
    // One row, not two and not a "Rivals monthly 2" nobody asked for.
    expect(await db.select().from(eventTemplates)).toHaveLength(1);
  });

  it("5-6: duplicates one, edits the copy, and saves both", async () => {
    const original = expectOk(
      await createTemplate(
        { name: "Rivals 8", config: { teams: 8, draft: true } },
        db
      )
    );
    const copy = expectOk(await duplicateTemplate(original.id, undefined, db));
    expectOk(await updateTemplate(copy.id, { name: "Rivals 6", config: { teams: 6 } }, db));

    const view = await loadAdminTemplates(db);
    const names = view.templates.map((template) => template.name);
    expect(names).toEqual(["Rivals 8", "Rivals 6"]);

    // 6: *both* saved — the edit to the copy left the original where it was.
    const [eight] = view.templates.filter((template) => template.name === "Rivals 8");
    const [six] = view.templates.filter((template) => template.name === "Rivals 6");
    expect(eight.config.teams).toBe(8);
    expect(eight.config.draft).toBe(true);
    expect(six.config.teams).toBe(6);
  });

  it("7-8: switches the original off, moves the copy to the top, saves the order", async () => {
    const original = expectOk(await createTemplate({ name: "Rivals 8" }, db));
    const copy = expectOk(await duplicateTemplate(original.id, "Rivals 6", db));

    expectOk(await setTemplateActive(original.id, false, db));
    expectOk(await moveTemplate(copy.id, "up", db));

    // 8, first half: the original is no longer offered in UC-08 step 1.
    const offered = await listEventTemplates(db);
    expect(offered.map((row) => row.name)).toEqual(["Rivals 6"]);

    // 8, second half: the order is saved, and it is the order both screens read.
    expect((await loadAdminTemplates(db)).templates.map((row) => row.name)).toEqual([
      "Rivals 6",
      "Rivals 8",
    ]);

    // And the copy really is first in the picker once the original is back on.
    expectOk(await setTemplateActive(original.id, true, db));
    expect((await listEventTemplates(db)).map((row) => row.name)).toEqual([
      "Rivals 6",
      "Rivals 8",
    ]);
  });

  it("outcome: an event made from a template is unaffected by a later edit", async () => {
    const template = expectOk(
      await createTemplate(
        {
          name: "Rivals monthly",
          gameId: rivalsId,
          config: { teams: 4 },
          questions: [{ label: "Current rank", type: "rank", profileFieldKey: "rank" }],
        },
        db
      )
    );
    const event = expectOk(
      await createEvent({ title: "March cup", templateId: template.id }, db)
    );

    expectOk(
      await updateTemplate(
        template.id,
        { config: { teams: 8 }, questions: [{ label: "Something else", type: "text" }] },
        db
      )
    );

    const [after] = await db.select().from(events).where(eq(events.id, event.id));
    expect(after.config.teams).toBe(4);
    const questions = await db
      .select()
      .from(eventQuestions)
      .where(eq(eventQuestions.eventId, event.id));
    expect(questions.map((question) => question.label)).toEqual(["Current rank"]);
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

/* ------------------------------------------------------------------ */
/* UC-08 10a — saving an event's setup as a template                  */
/* ------------------------------------------------------------------ */

/**
 * The editor's "Save as template" (R-22 / UC-08 10a), from the library's side.
 *
 * The button in `EventEditor.tsx` calls `createTemplateFromEventAction`, which
 * calls `createTemplateFromEvent` — so what the editor captures is what this
 * function captures, and the acceptance criterion ("a template from an event
 * reproduces its setup on a new event") is a claim about this round trip.
 *
 * The round trip above already pins the game, the type, the questions and the
 * prefill. These add the sign-up rules, which nothing was checking, and they
 * pin the two sides of "a setup, not an event": the settings do come across,
 * and the applicants do not.
 */
describe("a template saved from an event (UC-08 10a)", () => {
  /** An approval event with the waitlist off, one applicant and a cap. */
  async function anEventThatRan() {
    const event = expectOk(
      await createEvent(
        {
          title: "Rivals Autumn Cup",
          gameId: rivalsId,
          capacity: 16,
          minRankToEnter: RIVALS_RANK_LADDER[2],
          minRankToCaptain: RIVALS_RANK_LADDER[4],
          // Three days rather than one, so "the day list comes across" is a
          // claim about an *order* as well as a count: a capture that read
          // `event_days` without ordering by `day_index` could hand the next
          // event a Finals on the Saturday.
          days: [
            { startsAt: new Date("2026-03-07T18:00:00Z"), label: "Group stage" },
            { startsAt: new Date("2026-03-08T18:00:00Z"), label: "Playoffs" },
            { startsAt: new Date("2026-03-09T18:00:00Z"), label: "Finals" },
          ],
          config: {
            // R-27 and R-170: how people get in, which is the part of the setup
            // most worth not retyping.
            entryMode: "approval",
            waitlist: false,
            teams: 6,
            draft: true,
            bracket: true,
            format: { concurrentLobbies: 3, bestOf: 3 },
          },
        },
        db
      )
    );

    expectOk(
      await setEventQuestions(
        event.id,
        [{ label: "In-game name", type: "text", required: true }],
        db
      )
    );

    const [member] = await db
      .insert(users)
      .values({ discordId: `applicant-${event.id}`, displayName: "An applicant" })
      .returning({ id: users.id });
    await db
      .insert(applications)
      .values({ eventId: event.id, userId: member.id, status: "accepted" });

    return event;
  }

  it("reproduces the sign-up and format settings on a new event", async () => {
    const source = await anEventThatRan();
    const template = expectOk(
      await createTemplateFromEvent(source.id, { name: "Rivals, by approval" }, db)
    );

    const next = expectOk(
      await createEvent({ title: "Rivals Winter Cup", templateId: template.id }, db)
    );

    // Every knob that decides how the event runs, through both hops.
    expect(next.type).toBe(source.type);
    expect(next.gameId).toBe(rivalsId);
    expect(next.config.entryMode).toBe("approval");
    expect(next.config.waitlist).toBe(false);
    expect(next.config.teams).toBe(6);
    expect(next.config.draft).toBe(true);
    expect(next.config.bracket).toBe(true);
    expect(next.config.format).toEqual({ concurrentLobbies: 3, bestOf: 3 });

    const questions = await db
      .select()
      .from(eventQuestions)
      .where(eq(eventQuestions.eventId, next.id));
    expect(questions.map((question) => question.label)).toEqual(["In-game name"]);
  });

  it("carries a setup and not an event: no applicants come with it", async () => {
    const source = await anEventThatRan();
    const template = expectOk(
      await createTemplateFromEvent(source.id, { name: "Rivals, again" }, db)
    );

    const next = expectOk(
      await createEvent({ title: "Rivals Spring Cup", templateId: template.id }, db)
    );

    // Structurally impossible rather than merely omitted — applications,
    // teams, lots and matches are their own tables and a template is one row
    // of config and one of questions. Asserted anyway, because "impossible"
    // is a claim about today's shape.
    const theirs = await db
      .select()
      .from(applications)
      .where(eq(applications.eventId, next.id));
    expect(theirs).toEqual([]);
    expect(JSON.stringify(template.config)).not.toContain("applicant");
  });

  /*
   * The test Task 13 left behind, rewritten by Task 52 — it named itself as the
   * line that would have to change when the columns landed, and drizzle/0027 is
   * those columns.
   *
   * What it asserted was `null`, `null`, `null`, `[]`: the cap, both rank
   * thresholds and the day list left behind, because `createEvent` read them
   * from its own input and a template had nowhere to keep them. All four now
   * come across, and the only thing still left behind is the *dates* — which is
   * why `TEMPLATE_OMITS` went from four entries to two.
   */
  it("reproduces the days, the cap and the rank thresholds, as TEMPLATE_OMITS now says", async () => {
    const source = await anEventThatRan();
    const template = expectOk(
      await createTemplateFromEvent(source.id, { name: "Rivals, the shape of it" }, db)
    );

    // Captured on the template itself, not merely reproduced downstream: a
    // template is a row somebody can read and edit, so the setup has to be *on*
    // it rather than reconstructed on the way out.
    expect(template.capacity).toBe(16);
    expect(template.minRankToEnter).toBe(RIVALS_RANK_LADDER[2]);
    expect(template.minRankToCaptain).toBe(RIVALS_RANK_LADDER[4]);
    expect(template.days).toEqual([
      { label: "Group stage" },
      { label: "Playoffs" },
      { label: "Finals" },
    ]);

    const next = expectOk(
      await createEvent({ title: "Rivals, next one", templateId: template.id }, db)
    );

    expect(next.capacity).toBe(16);
    expect(next.minRankToEnter).toBe(RIVALS_RANK_LADDER[2]);
    expect(next.minRankToCaptain).toBe(RIVALS_RANK_LADDER[4]);

    /*
     * The day list reproduced, and the dates not. One day, still called "Group
     * stage", with no time on it — which is the times-to-be-agreed state
     * `event_days.starts_at` is nullable for (R-24), and the thing a manager
     * then sets. Reproducing the *instant* would have dated next month's event
     * in last month, which is the one part of a setup that is never reusable.
     */
    const days = await db
      .select()
      .from(eventDays)
      .where(eq(eventDays.eventId, next.id))
      .orderBy(asc(eventDays.dayIndex));
    expect(days.map((day) => [day.dayIndex, day.label, day.startsAt])).toEqual([
      [0, "Group stage", null],
      [1, "Playoffs", null],
      [2, "Finals", null],
    ]);
    // And therefore the new event has no dates at all, while the source had.
    expect(next.startsAt).toBeNull();
    expect(source.startsAt).toEqual(new Date("2026-03-07T18:00:00Z"));
    expect(source.endsAt).toEqual(new Date("2026-03-09T18:00:00Z"));

    // The list both screens print, now that it is two things rather than four.
    expect(TEMPLATE_OMITS).toEqual(["the dates", "the generated bracket"]);
  });

  it("stores the cap once — in the column, never in the config", async () => {
    // The third criterion, and the reason `event_templates` got real columns
    // instead of a `config.setup` block: `createEvent` copies `config`
    // wholesale, so a cap routed through there would arrive on every event as a
    // dead second copy of its own `events.capacity`.
    const source = await anEventThatRan();
    const template = expectOk(
      await createTemplateFromEvent(source.id, { name: "Rivals, once only" }, db)
    );
    const next = expectOk(
      await createEvent({ title: "Rivals, counted once", templateId: template.id }, db)
    );

    expect(next.capacity).toBe(16);
    expect(JSON.stringify(template.config)).not.toContain("16");
    expect(JSON.stringify(next.config)).not.toContain("16");
    for (const key of ["capacity", "setup", "minRankToEnter", "days"]) {
      expect(Object.keys(next.config)).not.toContain(key);
      expect(Object.keys(template.config)).not.toContain(key);
    }
  });

  it("lets the caller overrule every part of the template's setup", async () => {
    /*
     * `undefined` is silence and the template answers; anything else is the
     * caller's. The two that would be easy to get wrong with `??` are in here
     * on purpose: an explicit `null` cap means "uncapped, I mean it" and an
     * explicit `[]` means "no days", and both have to beat a template that
     * carries the opposite — or an admin could never make a dateless, uncapped
     * event from a template that carries three days and sixteen seats.
     */
    const source = await anEventThatRan();
    const template = expectOk(
      await createTemplateFromEvent(source.id, { name: "Rivals, overruled" }, db)
    );

    const next = expectOk(
      await createEvent(
        {
          title: "Rivals, my way",
          templateId: template.id,
          capacity: null,
          minRankToEnter: null,
          minRankToCaptain: RIVALS_RANK_LADDER[5],
          days: [],
        },
        db
      )
    );

    expect(next.capacity).toBeNull();
    expect(next.minRankToEnter).toBeNull();
    expect(next.minRankToCaptain).toBe(RIVALS_RANK_LADDER[5]);
    expect(await db.select().from(eventDays).where(eq(eventDays.eventId, next.id))).toEqual(
      []
    );
  });

  it("refuses a template's bad setup before the event row exists (UC-08 10c)", async () => {
    /*
     * A template's cap goes through `capacityProblem` exactly as a typed one
     * does, and the refusal lands *before* the insert — "nothing saved" is what
     * 10c says, and an event left behind by a refused create is the defect Task
     * 57 is about. A one-seat cap can only reach a template through a write
     * that bypassed `createTemplate` (a seed, a migration), which is precisely
     * why `createEvent` re-checks rather than trusting the row.
     */
    await db.insert(eventTemplates).values({ name: "One seat", capacity: 1 });
    const [template] = await db
      .select()
      .from(eventTemplates)
      .where(eq(eventTemplates.name, "One seat"));

    expect(await expectFail(createEvent({ title: "Doomed", templateId: template.id }, db)))
      .toMatch(/at least 2 seats/i);

    // Nothing saved: no event row, so the caller was told the truth.
    expect(await db.select().from(events).where(eq(events.title, "Doomed"))).toEqual([]);
  });

  /*
   * Task 57. The two refusals `createEvent` *cannot* make for itself, and the
   * ones Task 52's capacity/day/rank move did not reach.
   *
   * `setEventQuestions` and `setEventDays` hold rules of their own, and neither
   * can be asked before the event row exists — so both used to refuse *after*
   * an insert that had already committed on the bare handle, with nothing to
   * roll back and `createEvent`'s own docblock claiming "nothing saved". The
   * whole job is now one transaction and those refusals are thrown
   * (docs/decisions/004-refusals-inside-transactions.md), so UC-08 10c means
   * what it says on all four paths rather than two of them.
   *
   * In both tests the refusal itself is the *weak* assertion — the broken
   * version returned the identical sentence. The empty `events` table is the
   * one that bites.
   */
  it("saves nothing when a template's question cannot prefill any more (UC-08 10c)", async () => {
    /*
     * The reachable one. A template stores `profileFieldKey`, not an id, and
     * resolves it on every create — so a profile field whose **type** has
     * changed since the template was saved still resolves, and then
     * `setEventQuestions` refuses it as a mismatch. Nobody has done anything
     * wrong and nothing warned them; the template is simply older than the
     * field.
     */
    const template = expectOk(
      await createTemplate(
        {
          name: "Rivals, with an IGN box",
          gameId: rivalsId,
          questions: [
            { key: "ign", label: "In-game name", type: "text", profileFieldKey: "ign" },
          ],
        },
        db
      )
    );
    expect(template.questions).toHaveLength(1);

    // The field the template names is still called `ign`, and is no longer text.
    await db
      .update(profileFields)
      .set({ type: "bool" })
      .where(and(eq(profileFields.key, "ign"), eq(profileFields.gameId, rivalsId)));

    const result = await createEvent(
      { title: "Rivals, stale template", templateId: template.id },
      db
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/questions need another look/i);
      // The per-question detail survives the throw, which is the reason
      // `NothingSaved` carries `errors` as well as the sentence.
      expect(Object.values(result.errors ?? {}).join(" ")).toMatch(
        /different type, so it cannot prefill/i
      );
    }

    expect(
      await db.select().from(events).where(eq(events.title, "Rivals, stale template"))
    ).toEqual([]);
  });

  it("saves nothing when a day list names another event's day (UC-08 10c)", async () => {
    /*
     * The other half, through `setEventDays` rather than `setEventQuestions`,
     * because the two are separate calls with separate refusals and a fix that
     * only covered the first would leave this one committing an event row.
     *
     * `createEvent` pre-checks the day *list* — overlaps, the sign-up window,
     * the count — so the refusal that is still only `setEventDays`' to make is
     * the one about a day's **identity**: an id belonging to somebody else's
     * event, which `CreateEventInput.days` can carry because `EventDayInput`
     * can.
     */
    const neighbour = expectOk(
      await createEvent({ ...PUBLISHABLE, title: "Somebody else's event" }, db)
    );
    const [theirDay] = await db
      .select()
      .from(eventDays)
      .where(eq(eventDays.eventId, neighbour.id));
    expect(theirDay).toBeDefined();

    expect(
      await expectFail(
        createEvent(
          {
            ...PUBLISHABLE,
            title: "Borrowed a day",
            days: [{ id: theirDay.id, startsAt: new Date("2100-02-01T18:00:00Z") }],
          },
          db
        )
      )
    ).toMatch(/belongs to a different event/i);

    expect(await db.select().from(events).where(eq(events.title, "Borrowed a day"))).toEqual([]);
    // And the neighbour's day is untouched, so the rollback took the right things.
    const [stillTheirs] = await db
      .select()
      .from(eventDays)
      .where(eq(eventDays.id, theirDay.id));
    expect(stillTheirs).toMatchObject({ eventId: neighbour.id });
  });
});

/* ------------------------------------------------------------------ */
/* The setup columns (drizzle/0027), on the writing side              */
/* ------------------------------------------------------------------ */

describe("a template's own setup", () => {
  it("takes a cap, two thresholds and a day list, and refuses a cap below the minimum", async () => {
    const template = expectOk(
      await createTemplate(
        {
          name: "Rivals, eight",
          gameId: rivalsId,
          capacity: 8,
          minRankToEnter: RIVALS_RANK_LADDER[1],
          days: [{ label: "Groups" }, { label: "  " }, { label: "Finals" }],
        },
        db
      )
    );
    expect(template.capacity).toBe(8);
    expect(template.minRankToEnter).toBe(RIVALS_RANK_LADDER[1]);
    // A day with a whitespace label is kept as an unnamed day rather than
    // dropped — "three days, one of them unnamed" is a real shape, and `dayName`
    // calls the middle one "Day 2".
    expect(template.days).toEqual([{ label: "Groups" }, { label: null }, { label: "Finals" }]);

    // `capacityProblem`'s sentence, not a second copy of the rule (R-26).
    expect(
      await expectFail(createTemplate({ name: "Rivals, one", capacity: 1 }, db))
    ).toMatch(/at least 2 seats/i);
  });

  it("refuses more days than an event can run over", async () => {
    expect(
      await expectFail(
        createTemplate(
          { name: "Five days", days: [{}, {}, {}, {}, {}] },
          db
        )
      )
    ).toMatch(/at most 4 days/i);
  });

  it("refuses a threshold the game's ladder has never heard of", async () => {
    // The refusal belongs at this end. A template holding "Radiant" against
    // Marvel Rivals would be a template every `createEvent` from it refused —
    // the right sentence arriving against the wrong person, on a setup they
    // did not just type.
    expect(
      await expectFail(
        createTemplate({ name: "Ghost rank", gameId: rivalsId, minRankToEnter: "Radiant" }, db)
      )
    ).toMatch(/not one of Marvel Rivals's ranks/);

    // And a threshold with no game at all cannot mean anything either.
    expect(
      await expectFail(createTemplate({ name: "Gameless", minRankToEnter: "Gold" }, db))
    ).toMatch(/pick the game/i);
  });

  it("re-checks a threshold it is keeping when the game moves under it", async () => {
    /*
     * The one an each-key-on-its-own patch would miss: the rename does not
     * mention the threshold, so a patch loop that only validated the keys it
     * was given would move the template onto a game whose ladder has no
     * "Diamond" and leave the gate behind, unusable.
     */
    const template = expectOk(
      await createTemplate(
        { name: "Rivals gate", gameId: rivalsId, minRankToEnter: RIVALS_RANK_LADDER[3] },
        db
      )
    );

    expect(await expectFail(updateTemplate(template.id, { gameId: jackboxId }, db))).toMatch(
      /Jackbox has no rank ladder/
    );

    // Nothing half-written: the template still belongs to Rivals.
    expect((await getTemplate(template.id, db))?.gameId).toBe(rivalsId);
  });

  it("carries the whole setup into a duplicate", async () => {
    const source = expectOk(
      await createTemplate(
        {
          name: "Rivals, source",
          gameId: rivalsId,
          capacity: 12,
          minRankToEnter: RIVALS_RANK_LADDER[2],
          minRankToCaptain: RIVALS_RANK_LADDER[4],
          days: [{ label: "Day one" }, { label: "Day two" }],
        },
        db
      )
    );

    const copy = expectOk(await duplicateTemplate(source.id, undefined, db));
    expect(copy.capacity).toBe(12);
    expect(copy.minRankToEnter).toBe(RIVALS_RANK_LADDER[2]);
    expect(copy.minRankToCaptain).toBe(RIVALS_RANK_LADDER[4]);
    expect(copy.days).toEqual(source.days);
  });
});

/* ------------------------------------------------------------------ */
/* The scoring setup (R-237 / UC-44 6a)                                */
/* ------------------------------------------------------------------ */

describe("a template carries the scoring setup (R-237 / UC-44 6a)", () => {
  /** The event's config as Postgres holds it — never the object `createEvent` returned. */
  async function storedConfig(eventId: string) {
    const [row] = await db.select({ config: events.config }).from(events).where(eq(events.id, eventId));
    return row.config;
  }

  it("stores a scoring setup, and an event made from it arrives with it", async () => {
    const template = expectOk(
      await createTemplate({ name: "Popsauce night", config: { roundScoring: POPSAUCE } }, db)
    );
    expect(roundScoringFrom((await getTemplate(template.id, db))!.config)).toEqual(POPSAUCE);

    const event = expectOk(await createEvent({ title: "Popsauce, March", templateId: template.id }, db));
    expect(roundScoringFrom(await storedConfig(event.id))).toEqual(POPSAUCE);
  });

  it("round-trips: a scored night becomes a template, and the next night starts on its setup", async () => {
    // UC-44 6a's real route — the Scoring panel saved it on one event, and
    // "do that again next month" is a template made from that event.
    const source = expectOk(
      await createEvent({ title: "Popsauce, March", config: { roundScoring: POPSAUCE } }, db)
    );
    const template = expectOk(await createTemplateFromEvent(source.id, { name: "Popsauce" }, db));
    expect(roundScoringFrom(template.config)).toEqual(POPSAUCE);

    const next = expectOk(await createEvent({ title: "Popsauce, April", templateId: template.id }, db));
    expect(roundScoringFrom(await storedConfig(next.id))).toEqual(POPSAUCE);
  });

  it("editing the template afterwards changes no event already made from it", async () => {
    const template = expectOk(
      await createTemplate({ name: "Popsauce night", config: { roundScoring: POPSAUCE } }, db)
    );
    const event = expectOk(await createEvent({ title: "Popsauce, March", templateId: template.id }, db));

    const fallGuys = {
      rounds: [{ name: null }, { name: null }, { name: null }],
      lowWins: true,
      bonuses: [],
    } satisfies RoundScoring;
    expectOk(await updateTemplate(template.id, { config: { roundScoring: fallGuys } }, db));
    expect(roundScoringFrom((await getTemplate(template.id, db))!.config)).toEqual(fallGuys);

    expect(roundScoringFrom(await storedConfig(event.id))).toEqual(POPSAUCE);
  });

  it("refuses a malformed setup when the template is saved, and writes nothing", async () => {
    const malformed = { ...POPSAUCE, bonuses: [{ key: "Fast", value: 0 }] };
    const sentence = '"Fast" has to be worth at least a point. A penalty is not a bonus.';

    expect(
      await expectFail(createTemplate({ name: "Broken", config: { roundScoring: malformed } }, db))
    ).toBe(sentence);
    expect(await db.select({ id: eventTemplates.id }).from(eventTemplates)).toEqual([]);

    const template = expectOk(
      await createTemplate({ name: "Popsauce night", config: { roundScoring: POPSAUCE } }, db)
    );
    expect(
      await expectFail(updateTemplate(template.id, { config: { roundScoring: malformed } }, db))
    ).toBe(sentence);
    expect((await getTemplate(template.id, db))!.config).toEqual({ roundScoring: POPSAUCE });
  });

  it("refuses to capture a malformed setup from an event too, so the two routes agree", async () => {
    // The panel's save would never write this; a row edited by hand might hold
    // it. The template made from it has to be refused in the same sentence the
    // admin screen would use, not stripped on the way across.
    const source = expectOk(await createEvent({ title: "Edited by hand" }, db));
    await db
      .update(events)
      .set({ config: { roundScoring: { ...POPSAUCE, rounds: [] } } })
      .where(eq(events.id, source.id));

    expect(await expectFail(createTemplateFromEvent(source.id, { name: "From it" }, db))).toBe(
      "A night has at least one round."
    );
    expect(await db.select({ id: eventTemplates.id }).from(eventTemplates)).toEqual([]);
  });

  it("makes an event that is not round-scored from a template with no setup", async () => {
    // Task 87's "absent reads as null", holding across the template path: the
    // key must be *absent* on the new event, not present as a default.
    const template = expectOk(await createTemplate({ name: "Rivals monthly", config: { teams: 4 } }, db));
    const event = expectOk(await createEvent({ title: "Rivals, March", templateId: template.id }, db));

    const config = await storedConfig(event.id);
    expect(roundScoringFrom(config)).toBeNull();
    expect("roundScoring" in config).toBe(false);
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

  it("dates a source event from its days, and offers an undated one anyway (R-24)", async () => {
    const dated = expectOk(
      await createEvent(
        {
          title: "Dated source",
          // R-25: sign-ups close no later than the first day starts.
          signupClosesAt: new Date("2026-04-01T18:00:00Z"),
          days: [
            { startsAt: new Date("2026-04-01T18:00:00Z") },
            { startsAt: new Date("2026-04-02T18:00:00Z") },
          ],
        },
        db
      )
    );
    // No days at all: a setup an admin has started and not finished timing.
    const undated = expectOk(await createEvent({ title: "Undated source" }, db));

    /*
     * The date below is the days' answer and can be nothing else: the column
     * the screen used to read was dropped by drizzle/0026, which
     * `migrations.test.ts` proves.
     */
    const view = await loadAdminTemplates(db);

    expect(view.sources.find((row) => row.id === dated.id)?.startsAt).toEqual(
      new Date("2026-04-01T18:00:00Z")
    );
    // Still a candidate — a template is made from an event's questions and
    // config, neither of which needs a date.
    expect(view.sources.find((row) => row.id === undated.id)?.startsAt).toBeNull();
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
