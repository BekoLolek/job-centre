/**
 * `/admin/templates` — reusable event templates and their form and format
 * defaults (docs/platform-plan.md §4, §7, §8.1).
 *
 * `event_templates` has existed since Phase 2 and the create-event flow has
 * read it since, but nothing could ever write one — so the list held whatever
 * a seed put there and nothing else. This module is the writing half.
 *
 * ## Templates are copied, never referenced
 *
 * `createEvent` copies a template's type, game, config and questions into the
 * new event and then forgets it. Editing "Rivals tournament" next month must
 * not rewrite the questions of an event that is already taking applications,
 * which is the single most important property of the whole feature.
 *
 * `events.created_from_template_id` does not weaken that. It is provenance —
 * nothing reads it to decide anything — and it exists so this screen can say
 * "used 4 times", which is the number that tells an admin whether a template is
 * earning its place.
 *
 * ## From an event, not just from nothing
 *
 * {@link createTemplateFromEvent} is the direction that actually gets used.
 * Running a good Rivals tournament and then saying "do that again next month"
 * is the point; retyping its eleven questions is not. It reads the event's
 * questions back out and turns each `profile_field_id` into the field's *key*,
 * because a template cannot hold a field id — ids differ per deployment, and
 * `resolveTemplateQuestions` in `events.ts` resolves keys on the way back in.
 *
 * ## Switching off is the usual way, deleting is the other one
 *
 * Deactivating drops a template out of `listEventTemplates`, which is the only
 * read the create-event flow does, so it disappears from the picker while every
 * event ever made from it keeps its provenance row (R-128). That is the path
 * the screen recommends and it costs nothing here.
 *
 * {@link deleteTemplate} is the other one, and UC-28 8a is why it exists: a
 * template is a starting point rather than a parent, so an admin who is done
 * with one may remove the row outright and **the events made from it stay**.
 * Nothing about this contradicts the standing "nothing destructive" rule — a
 * template holds no history. It holds a *setup*, every event copied it on the
 * way in, and `events.created_from_template_id` is provenance nothing reads to
 * decide anything. The foreign key is `on delete set null` (schema.ts, and
 * `drizzle/0006_puzzling_shockwave.sql`), so the link is forgotten and the
 * event is untouched — which is exactly what 8a asks for, and is the one
 * property worth a test of its own.
 */

import { asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import {
  type Database,
  type EventQuestionSpec,
  type EventTemplate,
  type Game,
  db as defaultDb,
  eventQuestions,
  eventTemplates,
  events,
  games,
  profileFields,
} from "@/db";
import {
  type TemplateResult,
  MAX_TEMPLATE_QUESTIONS,
  TEMPLATE_NAME_MAX,
  cleanTemplateName,
  cleanTemplateType,
  normaliseTemplateConfig,
  normaliseTemplateQuestions,
  templateData as withData,
  templateFail as fail,
} from "./admin-templates-policy";
import { readDatesFor } from "./events";
import { reorderById } from "./profile-fields";

/* ------------------------------------------------------------------ */
/* Results and rules                                                  */
/* ------------------------------------------------------------------ */

/**
 * Every rule this module applies is a pure function in
 * `admin-templates-policy.ts`, re-exported here so a server caller has one
 * import. The split is what lets the editor validate and preview in the browser
 * without Drizzle going with it.
 */
export {
  type TemplateResult,
  MAX_TEMPLATE_QUESTIONS,
  TEMPLATE_OMITS,
  cleanTemplateType,
  describeTemplate,
  normaliseTemplateConfig,
  normaliseTemplateQuestions,
} from "./admin-templates-policy";

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

export type AdminTemplateView = EventTemplate & {
  /** The game's name, when it has one. Saves the screen a second lookup. */
  gameName: string | null;
  /** How many events have been created from it (§4's "and how many"). */
  events: number;
  /** Of those, the ones still going — a template in current use. */
  liveEvents: number;
};

export type AdminTemplatesView = {
  templates: AdminTemplateView[];
  /** Games to offer in the picker, in the order `/admin/games` puts them. */
  games: Array<{ id: string; name: string; isActive: boolean }>;
  /** Events an admin could turn into a template, newest first. */
  sources: TemplateSource[];
  /**
   * Profile fields a template question can prefill from, by **key** (§7).
   *
   * The key rather than the id, because that is what a template stores — see
   * `questionSpecsForEvent`. Two fields in different games can share a key, so
   * the game is carried alongside for the picker to disambiguate with.
   */
  profileFields: TemplateFieldOption[];
};

/** One profile field, as the "prefill from" picker sees it. */
export type TemplateFieldOption = {
  key: string;
  label: string;
  type: string;
  gameId: string | null;
  gameName: string | null;
};

/** An existing event, as the "make a template from this" picker sees it. */
export type TemplateSource = {
  id: string;
  title: string;
  slug: string;
  type: string;
  status: string;
  questions: number;
  startsAt: Date | null;
  createdAt: Date;
};

/**
 * The whole screen in seven queries.
 *
 * The usage counts are grouped in Postgres rather than fetched per template,
 * for the same reason `loadAdminGames` groups its answer counts: a dozen
 * templates should not be a dozen round trips.
 *
 * The seventh is the dates for the "make a template from this" picker. An
 * event's start is its first dated day's (R-24) — there is no `starts_at` to
 * select beside the title — so it comes from `event_days` via `readDatesFor`,
 * which answers for all sixty candidates at once. The picker is still ordered
 * newest *created* first, which is the right order for "what did I just run"
 * and needs no date at all; a candidate whose days have no times yet is listed
 * with none, exactly as before.
 */
export async function loadAdminTemplates(
  database: Database = defaultDb
): Promise<AdminTemplatesView> {
  const [templateRows, gameRows, usage, sourceRows, questionCounts, fieldRows] =
    await Promise.all([
      database
        .select()
        .from(eventTemplates)
        .orderBy(asc(eventTemplates.sort), asc(eventTemplates.name)),
      database
        .select({ id: games.id, name: games.name, isActive: games.isActive })
        .from(games)
        .orderBy(asc(games.sort), asc(games.name)),
      database
        .select({
          templateId: events.createdFromTemplateId,
          total: count(),
          live: sql<number>`count(*) filter (where ${events.status} in ('published', 'live'))`,
        })
        .from(events)
        .where(sql`${events.createdFromTemplateId} is not null`)
        .groupBy(events.createdFromTemplateId),
      database
        .select({
          id: events.id,
          title: events.title,
          slug: events.slug,
          type: events.type,
          status: events.status,
          createdAt: events.createdAt,
        })
        .from(events)
        .orderBy(sql`${events.createdAt} desc`)
        .limit(60),
      database
        .select({ eventId: eventQuestions.eventId, total: count() })
        .from(eventQuestions)
        .groupBy(eventQuestions.eventId),
      database
        .select({
          key: profileFields.key,
          label: profileFields.label,
          type: profileFields.type,
          gameId: profileFields.gameId,
        })
        .from(profileFields)
        .orderBy(asc(profileFields.sort), asc(profileFields.label)),
    ]);

  const gameById = new Map(gameRows.map((row) => [row.id, row.name]));
  const usageById = new Map(
    usage.map((row) => [
      row.templateId ?? "",
      { total: Number(row.total), live: Number(row.live) },
    ])
  );
  const questionsByEvent = new Map(
    questionCounts.map((row) => [row.eventId, Number(row.total)])
  );
  const datesByEvent = await readDatesFor(
    database,
    sourceRows.map((row) => row.id)
  );

  return {
    templates: templateRows.map((template) => ({
      ...template,
      gameName: template.gameId ? (gameById.get(template.gameId) ?? null) : null,
      events: usageById.get(template.id)?.total ?? 0,
      liveEvents: usageById.get(template.id)?.live ?? 0,
    })),
    games: gameRows,
    sources: sourceRows.map((row) => ({
      ...row,
      questions: questionsByEvent.get(row.id) ?? 0,
      // Null for an event whose days have no times yet — it is still a
      // candidate, just one with nothing to print beside it.
      startsAt: datesByEvent.get(row.id)?.startsAt ?? null,
    })),
    profileFields: fieldRows.map((row) => ({
      ...row,
      gameName: row.gameId ? (gameById.get(row.gameId) ?? null) : null,
    })),
  };
}

/** One template, or null. */
export async function getTemplate(
  templateId: string,
  database: Database = defaultDb
): Promise<EventTemplate | null> {
  const [row] = await database
    .select()
    .from(eventTemplates)
    .where(eq(eventTemplates.id, templateId))
    .limit(1);
  return row ?? null;
}

/** How many events came from this template. The number the screen prints. */
export async function templateUsage(
  templateId: string,
  database: Database = defaultDb
): Promise<number> {
  const [row] = await database
    .select({ total: count() })
    .from(events)
    .where(eq(events.createdFromTemplateId, templateId));
  return Number(row?.total ?? 0);
}

/* ------------------------------------------------------------------ */
/* The checks that need a database                                    */
/* ------------------------------------------------------------------ */

/** A game id that exists, or a refusal. Null is a valid answer (§7). */
async function resolveGame(
  database: Database,
  gameId: string | null | undefined
): Promise<TemplateResult<Game | null>> {
  if (!gameId) return withData(null);
  const [game] = await database.select().from(games).where(eq(games.id, gameId)).limit(1);
  return game ? withData(game) : fail("That game no longer exists.");
}

/** The next `sort`, so a new template lands at the bottom rather than the top. */
async function nextSort(database: Database): Promise<number> {
  const [row] = await database
    .select({ highest: sql<number | null>`max(${eventTemplates.sort})` })
    .from(eventTemplates);
  return (row?.highest ?? -1) + 1;
}

/** Every other template's name, folded for comparison. */
async function takenNames(
  database: Database,
  exceptId?: string
): Promise<Set<string>> {
  const rows = await database
    .select({ name: eventTemplates.name })
    .from(eventTemplates)
    .where(exceptId ? ne(eventTemplates.id, exceptId) : undefined);
  return new Set(rows.map((row) => row.name.toLowerCase()));
}

/**
 * Whether another template already carries this name (UC-28 4a).
 *
 * The check for a name somebody **typed**. `cleanTemplateName` has already
 * collapsed the spaces, so this only has to fold case: "Rivals cup" and
 * "rivals  cup" are the same template to everybody except `=`.
 */
async function nameTaken(
  database: Database,
  desired: string,
  exceptId?: string
): Promise<boolean> {
  return (await takenNames(database, exceptId)).has(desired.toLowerCase());
}

/**
 * A name nobody else is using, suffixed if need be.
 *
 * Only for a name the *system* chose — a duplicate's "Rivals cup copy", or the
 * event title `createTemplateFromEvent` falls back to. A name an admin typed is
 * refused instead (UC-28 4a), per the Gate 2 amendment to UC-15 6a: "automatic
 * names get a suffix; a typed duplicate is refused", because silently renaming
 * what someone typed is worse than telling them.
 */
async function freeName(database: Database, desired: string): Promise<string> {
  const taken = await takenNames(database);
  if (!taken.has(desired.toLowerCase())) return desired;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${desired} ${n}`.slice(0, TEMPLATE_NAME_MAX);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return desired;
}

/** The refusal 4a asks for, worded the same wherever a typed name clashes. */
function nameClash(name: string): { ok: false; error: string } {
  return fail(`A template is already called "${name}". Pick another name.`);
}

/* ------------------------------------------------------------------ */
/* Creating and editing                                               */
/* ------------------------------------------------------------------ */

export type TemplateInput = {
  name: string;
  type?: string;
  gameId?: string | null;
  config?: unknown;
  questions?: unknown;
};

/**
 * Make a template from nothing (R-125 / UC-28 3).
 *
 * Name, kind, questions, entry mode and format defaults — everything UC-28 3
 * lists, all of it optional except the name. A blank name and a name another
 * template already has are both refused, which is UC-28 4a.
 */
export async function createTemplate(
  input: TemplateInput,
  database: Database = defaultDb
): Promise<TemplateResult<EventTemplate>> {
  const name = cleanTemplateName(input.name);
  if (!name) return fail("Give the template a name.");
  if (await nameTaken(database, name)) return nameClash(name);

  const game = await resolveGame(database, input.gameId);
  if (!game.ok) return game;

  const config = normaliseTemplateConfig(input.config);
  if (!config.ok) return config;

  const questions = normaliseTemplateQuestions(input.questions);
  if (!questions.ok) return questions;

  const [created] = await database
    .insert(eventTemplates)
    .values({
      name,
      type: cleanTemplateType(input.type),
      gameId: game.data?.id ?? null,
      config: config.data,
      questions: questions.data,
      sort: await nextSort(database),
      isActive: true,
    })
    .returning();

  return withData(created);
}

export type TemplatePatch = {
  name?: string;
  type?: string;
  gameId?: string | null;
  config?: unknown;
  questions?: unknown;
};

/**
 * Edit a template (R-126 / UC-28 5, 6). Only the keys present in `patch` change.
 *
 * Nothing here touches an event. Every event ever made from this template holds
 * its own copy of the questions and the config, and that is the entire reason a
 * template is safe to edit at all — UC-28's outcome in one sentence.
 */
export async function updateTemplate(
  templateId: string,
  patch: TemplatePatch,
  database: Database = defaultDb
): Promise<TemplateResult<EventTemplate>> {
  const current = await getTemplate(templateId, database);
  if (!current) return fail("That template no longer exists.");

  const values: Partial<EventTemplate> = {};

  if (patch.name !== undefined) {
    const name = cleanTemplateName(patch.name);
    if (!name) return fail("Give the template a name.");
    // A rename is a typed name, so 4a applies to it exactly as it does to a
    // create. `templateId` is excepted: a template may keep its own name, or
    // saving a card nobody renamed would reject itself.
    if (await nameTaken(database, name, templateId)) return nameClash(name);
    values.name = name;
  }

  if (patch.type !== undefined) values.type = cleanTemplateType(patch.type);

  if (patch.gameId !== undefined) {
    const game = await resolveGame(database, patch.gameId);
    if (!game.ok) return game;
    values.gameId = game.data?.id ?? null;
  }

  if (patch.config !== undefined) {
    const config = normaliseTemplateConfig(patch.config);
    if (!config.ok) return config;
    values.config = config.data;
  }

  if (patch.questions !== undefined) {
    const questions = normaliseTemplateQuestions(patch.questions);
    if (!questions.ok) return questions;
    values.questions = questions.data;
  }

  if (Object.keys(values).length === 0) return withData(current);

  const [updated] = await database
    .update(eventTemplates)
    .set(values)
    .where(eq(eventTemplates.id, templateId))
    .returning();

  return updated ? withData(updated) : fail("That template no longer exists.");
}

/**
 * Copy a template (R-127 / UC-28 5).
 *
 * The obvious way to make "Rivals tournament, 6 teams" out of "Rivals
 * tournament, 8 teams" without retyping either the eleven questions or the
 * config. The copy starts active and lands at the bottom of the order, which is
 * where UC-28 7 then moves it from.
 *
 * A name given here is a typed one and is refused on a clash (4a). The default
 * "… copy" is the system's own, so it is suffixed instead — the one case where
 * suffixing is right, because nobody typed it.
 */
export async function duplicateTemplate(
  templateId: string,
  name: string | undefined,
  database: Database = defaultDb
): Promise<TemplateResult<EventTemplate>> {
  const source = await getTemplate(templateId, database);
  if (!source) return fail("That template no longer exists.");

  const typed = cleanTemplateName(name);
  if (typed && (await nameTaken(database, typed))) return nameClash(typed);

  const wanted = typed || cleanTemplateName(`${source.name} copy`);

  const [created] = await database
    .insert(eventTemplates)
    .values({
      name: typed || (await freeName(database, wanted)),
      type: source.type,
      gameId: source.gameId,
      config: source.config,
      questions: source.questions,
      sort: await nextSort(database),
      isActive: true,
    })
    .returning();

  return withData(created);
}

/**
 * Show or hide a template.
 *
 * The closest thing to deleting one an admin gets, deliberately: an inactive
 * template vanishes from the create-event picker — `listEventTemplates` filters
 * on `is_active` — while every event made from it keeps working and keeps its
 * provenance. Nothing on this site erases history (checklist.md).
 */
export async function setTemplateActive(
  templateId: string,
  isActive: boolean,
  database: Database = defaultDb
): Promise<TemplateResult<EventTemplate>> {
  const [updated] = await database
    .update(eventTemplates)
    .set({ isActive })
    .where(eq(eventTemplates.id, templateId))
    .returning();
  return updated ? withData(updated) : fail("That template no longer exists.");
}

/* ------------------------------------------------------------------ */
/* Order                                                              */
/* ------------------------------------------------------------------ */

/**
 * Renumber `sort` as 0…n-1 for the given order, skipping rows already correct.
 *
 * Dense from the top every time, for the reason `writeGameSort` in
 * `admin-games.ts` gives: nudging one row's number instead is what eventually
 * produces two rows sharing a `sort`, at which point "move up" appears to do
 * nothing and nobody can see why. Both reads that matter —
 * {@link loadAdminTemplates} and `listEventTemplates` — order by `sort` then
 * `name`, so a tie is resolved alphabetically and the arrow looks broken.
 */
async function writeTemplateSort(
  database: Database,
  ordered: ReadonlyArray<{ id: string; sort: number }>
): Promise<void> {
  for (const [index, row] of ordered.entries()) {
    if (row.sort === index) continue;
    await database
      .update(eventTemplates)
      .set({ sort: index })
      .where(eq(eventTemplates.id, row.id));
  }
}

/**
 * Move a template up or down the list, then renumber (R-129 / UC-28 7, 8).
 *
 * "Admin switches the original off and moves the copy to the top. System stops
 * offering the original and **saves the order**." The order is `sort`, and it is
 * the order both the admin list and the create-event picker read in, so moving
 * a template here is what puts it first on `/admin/events` as well.
 *
 * Hidden templates move with the rest rather than being parked at the bottom.
 * This list is the one screen where an inactive template is in front of you —
 * it is where you switch one back on — and a seasonal template kept for next
 * time (R-128) should still be where the admin left it when it is.
 */
export async function moveTemplate(
  templateId: string,
  direction: "up" | "down",
  database: Database = defaultDb
): Promise<TemplateResult> {
  const rows = await database
    .select({ id: eventTemplates.id, sort: eventTemplates.sort })
    .from(eventTemplates)
    .orderBy(asc(eventTemplates.sort), asc(eventTemplates.name));
  if (!rows.some((row) => row.id === templateId)) {
    return fail("That template no longer exists.");
  }

  await writeTemplateSort(database, reorderById(rows, templateId, direction));
  return withData(null);
}

/* ------------------------------------------------------------------ */
/* Deleting                                                           */
/* ------------------------------------------------------------------ */

/**
 * Remove a template. **Every event made from it stays** (UC-28 8a).
 *
 * The flow 8a names, and the reason it is safe is the reason templates exist in
 * the shape they do: `createEvent` *copies* the type, the game, the config and
 * the questions into the new event and then forgets the template, so the event
 * does not depend on the row at all. What remains is
 * `events.created_from_template_id`, which is provenance nothing reads to
 * decide anything, and whose foreign key is `on delete set null` — so the link
 * is forgotten and nothing else about the event moves. 8a's "keeps those events
 * and forgets only the link", exactly.
 *
 * `usedBy` comes back so the caller can say what it just did; the screen puts
 * the same number in the confirm *before* the click, because "4 events were
 * made from this" is the thing an admin wants to know first — and the answer to
 * it is almost always {@link setTemplateActive} instead, which keeps the
 * template for next season (R-128). Deleting is still the right answer for the
 * one somebody made by mistake.
 */
export async function deleteTemplate(
  templateId: string,
  database: Database = defaultDb
): Promise<TemplateResult<{ name: string; usedBy: number }>> {
  // Read the row we are about to delete rather than trusting the id: the name
  // in the audit line has to be this template's.
  const template = await getTemplate(templateId, database);
  if (!template) return fail("That template no longer exists.");

  const usedBy = await templateUsage(templateId, database);

  const [deleted] = await database
    .delete(eventTemplates)
    .where(eq(eventTemplates.id, templateId))
    .returning({ id: eventTemplates.id });
  if (!deleted) return fail("That template no longer exists.");

  // Close the gap the delete left, so `sort` stays dense and the arrows keep
  // meaning what they say.
  const rows = await database
    .select({ id: eventTemplates.id, sort: eventTemplates.sort })
    .from(eventTemplates)
    .orderBy(asc(eventTemplates.sort), asc(eventTemplates.name));
  await writeTemplateSort(database, rows);

  return withData({ name: template.name, usedBy });
}

/* ------------------------------------------------------------------ */
/* From an existing event                                             */
/* ------------------------------------------------------------------ */

export type FromEventInput = {
  /** Defaults to the event's own title. */
  name?: string;
  /** Carry `config` across. Default true — it is most of the point. */
  includeConfig?: boolean;
  /** Carry the question set across. Default true. */
  includeQuestions?: boolean;
};

/**
 * Turn an event that already happened into a template (R-22 / UC-08 10a).
 *
 * The useful direction, and the one behind both buttons that offer it: the
 * "make one from an event" panel on `/admin/templates` (UC-28 3a) and "Save as
 * template" in the event editor itself. Both are admin-only, enforced in
 * `createTemplateFromEventAction` rather than here — this module takes an id
 * and writes a row, and the question of who may is the action's.
 *
 * ## A setup, and nothing that happened
 *
 * What comes across is the event's *settings*: its type, its game, its config —
 * including `config.format`, which is the schedule and stage settings, and
 * `entryMode` and `waitlist`, which are how people get in (R-27, R-170) — and
 * its whole question set, with each question's profile link turned back into
 * the profile field's *key*.
 *
 * What does not is everything that only happened once. The applicants, the
 * teams, the draft's lots and awards, the matches and the recorded results are
 * rows in their own tables keyed on `event_id`; a template is one row holding
 * config and questions, so there is nowhere for any of them to go and the copy
 * below cannot carry one even by accident. `config` itself is checked: every
 * key anything writes there is a setting (`teams`, `draft`, `bracket`,
 * `entryMode`, `waitlist`, and the `format` block's own settings), never a
 * record of what a team did, so copying it whole copies a setup.
 *
 * ## What is left behind, and why that is a decision rather than an oversight
 *
 * Days, dates, capacity, the two rank thresholds, and the generated stages.
 * Days and dates are the two things that are always different next month, and
 * stages are rows in `stages` so a bracket is regenerated rather than copied.
 * Capacity and the thresholds are a different case: docs/plan.md Task 13 asks
 * for them, and they are columns on `events` rather than keys in `config`, so
 * reproducing them needs either a column on `event_templates` to hold them or
 * `createEvent` to learn to apply them out of a template. Routing them through
 * `config` instead would leave every event made from such a template carrying a
 * dead second copy of its own capacity, which is the one thing this codebase
 * will not store. `TEMPLATE_OMITS` is the list both screens print, and it is
 * accurate.
 */
export async function createTemplateFromEvent(
  eventId: string,
  input: FromEventInput = {},
  database: Database = defaultDb
): Promise<TemplateResult<EventTemplate>> {
  const [event] = await database.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) return fail("That event no longer exists.");

  const includeQuestions = input.includeQuestions !== false;
  const includeConfig = input.includeConfig !== false;

  const specs = includeQuestions
    ? await questionSpecsForEvent(database, eventId)
    : [];

  const questions = normaliseTemplateQuestions(specs);
  if (!questions.ok) return questions;

  const config = normaliseTemplateConfig(includeConfig ? event.config : {});
  if (!config.ok) return config;

  // A typed name is refused on a clash (UC-28 4a); the fall back to the
  // event's title is the system's own choice, so it is suffixed instead.
  const typed = cleanTemplateName(input.name);
  if (typed && (await nameTaken(database, typed))) return nameClash(typed);

  const name = typed || cleanTemplateName(event.title);
  if (!name) return fail("Give the template a name.");

  const [created] = await database
    .insert(eventTemplates)
    .values({
      name: typed || (await freeName(database, name)),
      type: cleanTemplateType(event.type),
      gameId: event.gameId,
      config: config.data,
      questions: questions.data,
      sort: await nextSort(database),
      isActive: true,
    })
    .returning();

  return withData(created);
}

/**
 * One event's questions as template specs, in order.
 *
 * The interesting line is the last one. An `event_questions` row points at a
 * `profile_fields` **id**; a template has to name the field's **key**, because
 * ids differ between the local database and the deployment and a template is a
 * thing you might one day want to move. `resolveTemplateQuestions` in
 * `events.ts` turns the key back into an id against the new event's game, which
 * is the round trip this half completes.
 */
export async function questionSpecsForEvent(
  database: Database,
  eventId: string
): Promise<EventQuestionSpec[]> {
  const rows = await database
    .select()
    .from(eventQuestions)
    .where(eq(eventQuestions.eventId, eventId))
    .orderBy(asc(eventQuestions.sort), asc(eventQuestions.createdAt));
  if (rows.length === 0) return [];

  const fieldIds = [...new Set(rows.map((row) => row.profileFieldId).filter(Boolean))] as string[];
  const fields =
    fieldIds.length > 0
      ? await database
          .select({ id: profileFields.id, key: profileFields.key })
          .from(profileFields)
          .where(inArray(profileFields.id, fieldIds))
      : [];
  const keyById = new Map(fields.map((row) => [row.id, row.key]));

  return rows.map((row) => {
    const profileFieldKey = row.profileFieldId ? keyById.get(row.profileFieldId) : undefined;
    return {
      key: row.key,
      label: row.label,
      type: row.type,
      options: row.options,
      required: row.required,
      ...(profileFieldKey ? { profileFieldKey } : {}),
    };
  });
}
