/**
 * The rules an event template obeys — all of them, with no database
 * (docs/platform-plan.md §7, §8.1).
 *
 * Split out of `src/lib/admin-templates.ts` on the same line as
 * `events-policy.ts` and `admin-users-policy.ts`: everything here is a pure
 * function over plain data, so `/admin/templates`' editor can import it into
 * the browser and show what a template would produce *as it is being typed*,
 * while the module that talks to Postgres stays on the server.
 *
 * The type-only imports from `@/db/schema` are erased at build time, so nothing
 * here drags a Drizzle table into a client bundle — the same trick
 * `profile-fields.ts` uses.
 */

import type {
  EventConfig,
  EventQuestionSpec,
  EventTemplateDay,
  ProfileFieldOption,
} from "@/db/schema";
import { capacityProblem, entryMode } from "./events-policy";
import { MAX_DAYS } from "./format-policy";
import { isFieldType, normaliseOptions, slugify, uniqueKey } from "./profile-fields";

/* ------------------------------------------------------------------ */
/* Results                                                            */
/* ------------------------------------------------------------------ */

/** As everywhere else in the admin data layer: a message, not a stack trace. */
export type TemplateResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

export function templateFail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export function templateData<T>(data: T): TemplateResult<T> {
  return { ok: true, data };
}

/* ------------------------------------------------------------------ */
/* Limits                                                             */
/* ------------------------------------------------------------------ */

export const TEMPLATE_NAME_MAX = 80;
const TYPE_MAX = 40;
const LABEL_MAX = 120;

/**
 * The longest day label a template stores.
 *
 * 60, because that is what `setEventDays` truncates an `event_days.label` to —
 * a template that stored more would have it silently cut on the way out, and a
 * template is meant to reproduce what it captured.
 */
const DAY_LABEL_MAX = 60;

/** A rank threshold, as long as `events.min_rank_to_enter` is written. */
const RANK_MAX = 60;

/** A template holds a form; forty is already more than anyone will answer. */
export const MAX_TEMPLATE_QUESTIONS = 40;

/** The team counts the format engine builds brackets for (§8.2). */
export const MIN_TEMPLATE_TEAMS = 2;
export const MAX_TEMPLATE_TEAMS = 8;

export function cleanTemplateName(raw: unknown): string {
  return typeof raw === "string"
    ? raw.trim().replace(/\s+/g, " ").slice(0, TEMPLATE_NAME_MAX)
    : "";
}

/**
 * An event type is free text by design (§8.1) — adding "Among Us night" is a
 * row, not a migration — so this normalises rather than constrains: lower case,
 * slugged, capped. Blank falls back to `custom`, which is what `createEvent`
 * would have used anyway.
 */
export function cleanTemplateType(raw: unknown): string {
  const text = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return slugify(text, TYPE_MAX) || "custom";
}

/* ------------------------------------------------------------------ */
/* Config                                                             */
/* ------------------------------------------------------------------ */

/**
 * A template's config, vetted.
 *
 * Only the four documented knobs of `EventConfig` are checked; **everything
 * else on the object is carried through untouched**, `config.format` above all
 * — that is where §10's schedule and stage settings live. A template made from
 * a real event has to keep the settings that made that event what it was, so
 * dropping unknown keys here would quietly gut "do that again next month".
 */
export function normaliseTemplateConfig(raw: unknown): TemplateResult<EventConfig> {
  if (raw === undefined || raw === null) return templateData({});
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return templateFail("The template's configuration has to be an object.");
  }

  const config = { ...(raw as EventConfig) };

  if (config.teams !== undefined && config.teams !== null) {
    const teams = config.teams;
    if (
      typeof teams !== "number" ||
      !Number.isInteger(teams) ||
      teams < MIN_TEMPLATE_TEAMS ||
      teams > MAX_TEMPLATE_TEAMS
    ) {
      return templateFail(
        `Teams has to be a whole number from ${MIN_TEMPLATE_TEAMS} to ${MAX_TEMPLATE_TEAMS}, ` +
          "or empty for no teams."
      );
    }
  }

  for (const key of ["waitlist", "draft", "bracket"] as const) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") {
      return templateFail(`"${key}" is a yes/no setting.`);
    }
  }

  // R-27's two modes and nothing else. Absent is first come, which is what
  // every template written before approval existed means.
  const mode = config.entryMode;
  if (mode !== undefined && mode !== "first_come" && mode !== "approval") {
    return templateFail("Entry is either first come or by approval.");
  }

  return templateData(config);
}

/* ------------------------------------------------------------------ */
/* The setup drizzle/0027 gave the table columns for                  */
/* ------------------------------------------------------------------ */

/**
 * A template's seat cap, vetted (R-26 / UC-08 10c).
 *
 * `capacityProblem` rather than a rule of its own, and that is the point: a cap
 * stored on a template is a cap `createEvent` will put on an event, so a
 * template allowed to hold `1` would be a template every create from it
 * refused. One function, one sentence, checked at both ends.
 *
 * Null is "this template sets no cap", which is also what an uncapped event
 * stores — see the column's docblock for why those two readings need no third
 * state between them.
 */
export function normaliseTemplateCapacity(raw: unknown): TemplateResult<number | null> {
  if (raw === undefined || raw === null || raw === "") return templateData(null);
  const capacity = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(capacity)) {
    return templateFail("Capacity has to be a whole number of seats, or empty for unlimited.");
  }
  const problem = capacityProblem(capacity);
  return problem ? templateFail(problem) : templateData(capacity);
}

/** One rank threshold as a template stores it: a trimmed ladder entry name, or null. */
export function cleanTemplateRank(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().replace(/\s+/g, " ").slice(0, RANK_MAX);
  return value === "" ? null : value;
}

/**
 * A template's day list, vetted (R-22, R-24 / UC-08 2, 4).
 *
 * Labels and nothing else — {@link EventTemplateDay} has the reasoning for why
 * there are no dates and no times here. What this function is for is the bound:
 * `MAX_DAYS` is §10's four, the same number `event_days.day_index`'s CHECK
 * enforces and the same one `MAX_EVENT_DAYS` names on the server side, so a
 * five-day template would be one `createEvent` could never apply.
 *
 * A day with no label is kept rather than dropped. "Three days, none of them
 * named" is a real shape — `dayName` renders them "Day 1", "Day 2", "Day 3" —
 * and dropping the entry would quietly turn a three-day template into a
 * nothing-day one.
 */
export function normaliseTemplateDays(raw: unknown): TemplateResult<EventTemplateDay[]> {
  if (raw === undefined || raw === null) return templateData([]);
  if (!Array.isArray(raw)) return templateFail("The template's days have to be a list.");
  if (raw.length > MAX_DAYS) {
    return templateFail(`An event runs over at most ${MAX_DAYS} days.`);
  }

  const out: EventTemplateDay[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return templateFail("A day has to be an object.");
    }
    const label = (entry as Record<string, unknown>).label;
    const cleaned =
      typeof label === "string" ? label.trim().replace(/\s+/g, " ").slice(0, DAY_LABEL_MAX) : "";
    out.push({ label: cleaned === "" ? null : cleaned });
  }

  return templateData(out);
}

/* ------------------------------------------------------------------ */
/* Questions                                                          */
/* ------------------------------------------------------------------ */

/**
 * A template's questions, vetted and keyed.
 *
 * Keys are slugged from labels and disambiguated within the template, the same
 * way `createField` does it: nothing outside the template's own jsonb refers to
 * one, so two questions both labelled "Notes" becoming `notes` and `notes-2` is
 * a convenience rather than a surprise. `setEventQuestions` re-keys them again
 * when the template is actually used, so this is about the template being
 * readable rather than about correctness downstream.
 *
 * `profileFieldKey` is preserved verbatim and never resolved here. A template
 * cannot hold a profile field *id* — ids differ per deployment — so the key is
 * the portable half, and `resolveTemplateQuestions` in `events.ts` turns it
 * back into an id against the new event's game.
 */
export function normaliseTemplateQuestions(raw: unknown): TemplateResult<EventQuestionSpec[]> {
  if (raw === undefined || raw === null) return templateData([]);
  if (!Array.isArray(raw)) return templateFail("The template's questions have to be a list.");
  if (raw.length > MAX_TEMPLATE_QUESTIONS) {
    return templateFail(
      `${MAX_TEMPLATE_QUESTIONS} questions is already more than anyone will answer.`
    );
  }

  const out: EventQuestionSpec[] = [];
  const taken: string[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      return templateFail("A question has to be an object.");
    }
    const question = entry as Record<string, unknown>;

    const label =
      typeof question.label === "string"
        ? question.label.trim().replace(/\s+/g, " ").slice(0, LABEL_MAX)
        : "";
    if (!label) {
      return templateFail("Every question needs a label — it is what the member reads.");
    }

    if (!isFieldType(question.type)) return templateFail(`"${label}" needs a question type.`);
    const type = question.type;

    const needsOptions = type === "select" || type === "multiselect";
    const options: ProfileFieldOption[] = needsOptions
      ? normaliseOptions(question.options)
      : [];
    if (needsOptions && options.length === 0) {
      return templateFail(`"${label}" needs at least one option to choose from.`);
    }

    const key = uniqueKey(
      typeof question.key === "string" && question.key.trim() ? question.key : label,
      taken,
      "question"
    );
    taken.push(key);

    const profileFieldKey =
      typeof question.profileFieldKey === "string" && question.profileFieldKey.trim()
        ? question.profileFieldKey.trim()
        : undefined;

    out.push({
      key,
      label,
      type,
      options,
      required: Boolean(question.required),
      ...(profileFieldKey ? { profileFieldKey } : {}),
    });
  }

  return templateData(out);
}

/* ------------------------------------------------------------------ */
/* "What would this produce?"                                         */
/* ------------------------------------------------------------------ */

/**
 * What an event made from this template would arrive with, in plain words.
 *
 * §4 asks the screen to "show what each template would produce", and the way to
 * keep that honest is to derive it from the same row `createEvent` reads rather
 * than to describe it from memory. `formatSummary` in
 * `components/events/labels.ts` says the same kind of thing about a *saved*
 * event; this says it about a template, which has no dates yet — and
 * deliberately does not pretend otherwise.
 *
 * The day count, the cap and the thresholds joined the list when drizzle/0027
 * gave the table columns for them, because the honesty rule above cuts both
 * ways: a template that now puts a 16-seat cap and a Diamond gate on every
 * event made from it would be *understated* by a summary that still only
 * counted questions.
 */
export function describeTemplate(template: {
  type: string;
  config: EventConfig;
  questions: readonly EventQuestionSpec[];
  gameName?: string | null;
  days?: readonly EventTemplateDay[];
  capacity?: number | null;
  minRankToEnter?: string | null;
  minRankToCaptain?: string | null;
}): string[] {
  const parts: string[] = [];
  const config = template.config ?? {};

  if (template.gameName) parts.push(template.gameName);

  const days = template.days?.length ?? 0;
  if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);

  const teams = typeof config.teams === "number" ? config.teams : null;
  if (teams && teams > 0) parts.push(`${teams} teams`);
  if (typeof template.capacity === "number") parts.push(`${template.capacity} seats`);
  // The entry gate before the captain gate, in that order, because that is the
  // order UC-08 7 sets them in and the order the event editor shows them.
  if (template.minRankToEnter) parts.push(`${template.minRankToEnter}+ to enter`);
  if (template.minRankToCaptain) parts.push(`${template.minRankToCaptain}+ to captain`);
  if (config.draft === true) parts.push("bid draft");
  if (config.bracket === true) parts.push("bracket");
  // The waitlist is a first-come setting (R-27), so an approval template says
  // how people get in rather than what the cap would do with them.
  if (entryMode(config) === "approval") parts.push("by approval");
  else if (config.waitlist === false) parts.push("no waitlist");

  parts.push(
    template.questions.length === 0
      ? "no questions"
      : `${template.questions.length} question${template.questions.length === 1 ? "" : "s"}`
  );

  const prefilled = template.questions.filter((question) => question.profileFieldKey).length;
  if (prefilled > 0) parts.push(`${prefilled} prefilled from the profile`);

  // `config.format` is §10's schedule and stage settings. It rides along whole,
  // and it is worth saying so rather than letting an admin discover that a
  // template carries more than the four knobs on the screen.
  if (config.format && typeof config.format === "object") parts.push("format settings");

  return parts;
}

/**
 * What a template made from this event would *not* carry, in plain words.
 *
 * On the screen next to the "make a template from this" button, because the
 * omissions are the part somebody would otherwise assume.
 *
 * Two entries, down from four. drizzle/0027 gave `event_templates` columns for
 * the capacity and the two rank thresholds and a `days` list for the shape of
 * the week, and `createEvent` applies all four — so the only things left behind
 * are:
 *
 *  * **the dates.** The day *list* comes across, labels and all; the instants
 *    do not, because they are the one part of a setup that is always different
 *    next month. A new event arrives with the right number of days, named, and
 *    no times — the documented times-to-be-agreed state.
 *  * **the generated bracket.** Rows in `stages`, built from the teams that
 *    actually turn up, so it is regenerated rather than copied.
 *
 * "days and dates" was one entry and is now wrong in half of itself, which is
 * why it is split rather than edited: a template that reproduces three days
 * called "Group stage", "Playoffs" and "Finals" must not be described as
 * leaving the days behind.
 */
export const TEMPLATE_OMITS = ["the dates", "the generated bracket"] as const;
