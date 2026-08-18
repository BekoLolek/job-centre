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
 * ## Nothing is deleted
 *
 * Deactivating drops a template out of `listEventTemplates`, which is the only
 * read the create-event flow does, so it disappears from the picker while every
 * event ever made from it keeps its provenance row. That is checklist.md's
 * standing rule, and it costs nothing here.
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
 * The whole screen in six queries.
 *
 * The usage counts are grouped in Postgres rather than fetched per template,
 * for the same reason `loadAdminGames` groups its answer counts: a dozen
 * templates should not be a dozen round trips.
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
          startsAt: events.startsAt,
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

/** A name nobody else is using, so the picker never shows two of the same. */
async function freeName(
  database: Database,
  desired: string,
  exceptId?: string
): Promise<string> {
  const rows = await database
    .select({ name: eventTemplates.name })
    .from(eventTemplates)
    .where(exceptId ? ne(eventTemplates.id, exceptId) : undefined);
  const taken = new Set(rows.map((row) => row.name.toLowerCase()));
  if (!taken.has(desired.toLowerCase())) return desired;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${desired} ${n}`.slice(0, TEMPLATE_NAME_MAX);
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return desired;
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

/** Make a template from nothing. Name only, in practice. */
export async function createTemplate(
  input: TemplateInput,
  database: Database = defaultDb
): Promise<TemplateResult<EventTemplate>> {
  const name = cleanTemplateName(input.name);
  if (!name) return fail("Give the template a name.");

  const game = await resolveGame(database, input.gameId);
  if (!game.ok) return game;

  const config = normaliseTemplateConfig(input.config);
  if (!config.ok) return config;

  const questions = normaliseTemplateQuestions(input.questions);
  if (!questions.ok) return questions;

  const [created] = await database
    .insert(eventTemplates)
    .values({
      name: await freeName(database, name),
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
 * Edit a template. Only the keys present in `patch` change.
 *
 * Nothing here touches an event. Every event ever made from this template holds
 * its own copy of the questions and the config, and that is the entire reason a
 * template is safe to edit at all.
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
    values.name = await freeName(database, name, templateId);
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
 * Copy a template.
 *
 * The obvious way to make "Rivals tournament, 6 teams" out of "Rivals
 * tournament, 8 teams" without retyping either the eleven questions or the
 * config. The copy starts active and lands at the bottom of the order.
 */
export async function duplicateTemplate(
  templateId: string,
  name: string | undefined,
  database: Database = defaultDb
): Promise<TemplateResult<EventTemplate>> {
  const source = await getTemplate(templateId, database);
  if (!source) return fail("That template no longer exists.");

  const wanted = cleanTemplateName(name) || cleanTemplateName(`${source.name} copy`);

  const [created] = await database
    .insert(eventTemplates)
    .values({
      name: await freeName(database, wanted),
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
 * Turn an event that already happened into a template.
 *
 * The useful direction. Everything an event carries that a template can hold
 * comes across: its type, its game, its config — including `config.format`,
 * which is the schedule and stage settings — and its whole question set, with
 * each question's profile link turned back into the profile field's *key*.
 *
 * What cannot come across, and is not pretended to: days, dates, capacity, the
 * rank thresholds, and the generated stages. Days and dates are the two things
 * that are always different next month; capacity and the thresholds are event
 * decisions rather than format ones; and stages are rows in `stages`, not
 * config, so a bracket is regenerated rather than copied.
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

  const name = cleanTemplateName(input.name) || cleanTemplateName(event.title);
  if (!name) return fail("Give the template a name.");

  const [created] = await database
    .insert(eventTemplates)
    .values({
      name: await freeName(database, name),
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
