/**
 * Events and applications — the part that talks to Postgres.
 *
 * The rules themselves live in `./events-policy`, which has no database handle
 * and is tested exhaustively. This module is the trust boundary and the
 * transaction boundary:
 *
 * ## Nothing here believes the request
 *
 * Questions, options, rank ladders and capacities are re-read from the database
 * on every write. An answer naming a question that belongs to another event is
 * rejected outright rather than ignored, exactly as `saveProfileSection` treats
 * a field id from another section — and for the same reason: a payload like
 * that is either a stale page or a forgery, and quietly dropping it produces an
 * application that looks complete and is not. Answers are validated with
 * `parseProfileValue`, the same function the profile uses, because two
 * validators for one set of field types is how the two versions drift apart.
 *
 * ## Applying is one transaction, and it has to be
 *
 * "Count the accepted, then insert" is a race with a fifty-fifty window in it:
 * two members clicking apply on the last seat both read `accepted = 4` against
 * a capacity of 5 and both get in. So `applyToEvent` takes a row lock on the
 * event (`select … for update`) and does the count *and* the insert inside it.
 * The lock is on the event rather than the table, so two events never queue
 * behind each other. `src/lib/__tests__/events-concurrency.test.ts` fires
 * simultaneous applications at a capacity-1 event and asserts exactly one
 * acceptance — and, to prove the test can actually catch it, runs the naive
 * read-then-write version alongside and watches it double-book.
 *
 * The same lock covers withdrawal, because promoting the next person in the
 * queue is the same read-then-write shape pointing the other way.
 *
 * ## A note on Neon
 *
 * `@neondatabase/serverless`'s HTTP driver — the one `src/db/index.ts` picks
 * when `DATABASE_URL` is set — has no interactive transactions, so
 * `database.transaction()` throws there. Everything in this module is exercised
 * against real Postgres via PGlite; deploying it to Neon means switching that
 * driver to the WebSocket `neon-serverless` one. See the report in
 * docs/platform-plan.md §3.1's driver note.
 */

import { and, asc, count, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import {
  type Application,
  type ApplicationAnswers,
  type ApplicationStatus,
  type AvailabilityState,
  type ConfirmationState,
  type Database,
  type EventConfig,
  type EventDay,
  type EventQuestion,
  type EventQuestionSpec,
  type EventRow,
  type EventStatus,
  type Game,
  type ProfileFieldOption,
  type ProfileFieldType,
  type ProfileValue,
  applications,
  availability,
  confirmations,
  db as defaultDb,
  eventDays,
  eventQuestions,
  eventTemplates,
  events,
  games,
  profileFields,
  profileValues,
  users,
} from "@/db";
import {
  type ApplicationsState,
  type CapacityState,
  type Eligibility,
  applicationsOpen,
  canTransition,
  capacityState,
  eligibility,
  nextWaitlistPosition,
  promoteFromWaitlist,
  recomputeWaitlist,
} from "./events-policy";
import {
  type FieldShape,
  choicesFor,
  fieldTypeInfo,
  isFieldType,
  normaliseOptions,
  parseProfileValue,
  slugify,
  uniqueKey,
} from "./profile-fields";

/* ------------------------------------------------------------------ */
/* Results                                                            */
/* ------------------------------------------------------------------ */

/**
 * Every mutation returns this rather than throwing, for the same reason
 * `admin-games.ts` does: the caller is a form, and a form wants a message next
 * to the control. `errors` is keyed by question id when the problem is one
 * answer's; `error` always carries a sentence to show if the caller has nowhere
 * to put the detail.
 */
export type EventResult<T = null> =
  | { ok: true; data: T }
  | { ok: false; error: string; errors?: Record<string, string> };

function fail(error: string, errors?: Record<string, string>): {
  ok: false;
  error: string;
  errors?: Record<string, string>;
} {
  return errors ? { ok: false, error, errors } : { ok: false, error };
}

function withData<T>(data: T): EventResult<T> {
  return { ok: true, data };
}

/* ------------------------------------------------------------------ */
/* Shapes the pages render                                            */
/* ------------------------------------------------------------------ */

export type EventQuestionView = EventQuestion & {
  /** What the member taps: the options, or the game's ladder for a `rank`. */
  choices: ProfileFieldOption[];
};

/** A question with this member's answer already in it (§2, §7). */
export type PrefilledQuestionView = EventQuestionView & {
  value: ProfileValue;
  /** True when the value came from the profile rather than from a past answer. */
  prefilled: boolean;
};

export type EventSummary = EventRow & {
  seats: CapacityState;
  /** Whether applications are open *now*, and why not when they are not. */
  applicationsState: ApplicationsState;
};

export type EventDetail = EventSummary & {
  game: Game | null;
  /** Lowest first; empty for a game without ranks, or no game at all. */
  rankLadder: string[];
  days: EventDay[];
  questions: EventQuestionView[];
};

export type ApplicationView = Application & {
  /** Keyed by `event_days.id`. Days with no answer are absent. */
  availability: Record<string, AvailabilityState>;
  confirmation: ConfirmationState | null;
};

export type ApplicantView = ApplicationView & {
  member: {
    id: string;
    displayName: string | null;
    avatarUrl: string | null;
    discordId: string | null;
  };
  /** Their recorded rank for this event's game, if it has one. */
  rank: string | null;
  eligibility: Eligibility;
};

export type MyApplicationView = ApplicationView & {
  event: EventRow;
  seats: CapacityState;
};

/** Everything the member's application page needs, in one read. */
export type ApplicationFormView = {
  event: EventDetail;
  state: ApplicationsState;
  eligibility: Eligibility;
  /** The member's rank for this event's game, as recorded on their profile. */
  rank: string | null;
  questions: PrefilledQuestionView[];
  /** Their answer per day, empty on a first visit. */
  availability: Record<string, AvailabilityState>;
  confirmation: ConfirmationState | null;
  /** Their existing application, if they have one. */
  application: ApplicationView | null;
};

/* ------------------------------------------------------------------ */
/* Small shared reads                                                 */
/* ------------------------------------------------------------------ */

const TITLE_MAX = 120;
const NOTE_MAX = 500;
const DESCRIPTION_MAX = 4000;
export const MAX_EVENT_DAYS = 4;
export const MAX_EVENT_QUESTIONS = 40;

function cleanText(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

/** A trimmed string, or null — the shape every nullable text column wants. */
function cleanNullable(raw: unknown, max: number): string | null {
  if (raw === null || raw === undefined) return null;
  const value = typeof raw === "string" ? raw.trim().slice(0, max) : "";
  return value === "" ? null : value;
}

async function readEvent(database: Database, eventId: string): Promise<EventRow | null> {
  const [row] = await database.select().from(events).where(eq(events.id, eventId)).limit(1);
  return row ?? null;
}

/**
 * Read the event **and take its row lock**, so everything that follows in this
 * transaction is the only thing counting seats for it.
 */
async function lockEvent(database: Database, eventId: string): Promise<EventRow | null> {
  const [row] = await database
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .for("update")
    .limit(1);
  return row ?? null;
}

async function readGame(database: Database, gameId: string | null): Promise<Game | null> {
  if (!gameId) return null;
  const [row] = await database.select().from(games).where(eq(games.id, gameId)).limit(1);
  return row ?? null;
}

async function readQuestions(
  database: Database,
  eventId: string
): Promise<EventQuestion[]> {
  return database
    .select()
    .from(eventQuestions)
    .where(eq(eventQuestions.eventId, eventId))
    .orderBy(asc(eventQuestions.sort), asc(eventQuestions.createdAt));
}

async function readDays(database: Database, eventId: string): Promise<EventDay[]> {
  return database
    .select()
    .from(eventDays)
    .where(eq(eventDays.eventId, eventId))
    .orderBy(asc(eventDays.dayIndex));
}

async function readApplications(
  database: Database,
  eventId: string
): Promise<Application[]> {
  return database
    .select()
    .from(applications)
    .where(eq(applications.eventId, eventId))
    .orderBy(asc(applications.submittedAt));
}

/**
 * The member's rank for a game, straight off their profile.
 *
 * A game's rank lives in whichever profile field has type `rank`; there is
 * normally exactly one, and if an admin has made two, the first in `sort` order
 * wins. Returns null when the game has no rank field, the member has not
 * answered it, or the event has no game at all — all three of which mean the
 * same thing to the gate in §8.3: nothing to compare.
 */
async function memberRank(
  database: Database,
  gameId: string | null,
  userId: string | null
): Promise<string | null> {
  if (!gameId || !userId) return null;

  const rankFields = await database
    .select({ id: profileFields.id })
    .from(profileFields)
    .where(and(eq(profileFields.gameId, gameId), eq(profileFields.type, "rank")))
    .orderBy(asc(profileFields.sort), asc(profileFields.createdAt));
  if (rankFields.length === 0) return null;

  const ids = rankFields.map((field) => field.id);
  const values = await database
    .select()
    .from(profileValues)
    .where(and(eq(profileValues.userId, userId), inArray(profileValues.fieldId, ids)));

  for (const field of rankFields) {
    const hit = values.find((row) => row.fieldId === field.id);
    if (hit && typeof hit.value === "string" && hit.value.trim() !== "") return hit.value;
  }
  return null;
}

/** Ranks for a whole list of members at once — the admin applicant list. */
async function memberRanks(
  database: Database,
  gameId: string | null,
  userIds: readonly string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!gameId || userIds.length === 0) return out;

  const rankFields = await database
    .select({ id: profileFields.id })
    .from(profileFields)
    .where(and(eq(profileFields.gameId, gameId), eq(profileFields.type, "rank")))
    .orderBy(asc(profileFields.sort), asc(profileFields.createdAt));
  if (rankFields.length === 0) return out;

  const rows = await database
    .select()
    .from(profileValues)
    .where(
      and(
        inArray(profileValues.userId, [...userIds]),
        inArray(
          profileValues.fieldId,
          rankFields.map((field) => field.id)
        )
      )
    );

  const order = new Map(rankFields.map((field, index) => [field.id, index]));
  const best = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.value !== "string" || row.value.trim() === "") continue;
    const rank = order.get(row.fieldId) ?? Number.MAX_SAFE_INTEGER;
    if ((best.get(row.userId) ?? Number.MAX_SAFE_INTEGER) <= rank) continue;
    best.set(row.userId, rank);
    out.set(row.userId, row.value);
  }
  return out;
}

/** Availability and confirmation for a set of applications, in two queries. */
async function readExtras(
  database: Database,
  applicationIds: readonly string[]
): Promise<{
  availability: Map<string, Record<string, AvailabilityState>>;
  confirmation: Map<string, ConfirmationState>;
}> {
  const byApplication = new Map<string, Record<string, AvailabilityState>>();
  const confirmed = new Map<string, ConfirmationState>();
  if (applicationIds.length === 0) return { availability: byApplication, confirmation: confirmed };

  const ids = [...applicationIds];
  const [availabilityRows, confirmationRows] = await Promise.all([
    database.select().from(availability).where(inArray(availability.applicationId, ids)),
    database.select().from(confirmations).where(inArray(confirmations.applicationId, ids)),
  ]);

  for (const row of availabilityRows) {
    const bag = byApplication.get(row.applicationId) ?? {};
    bag[row.eventDayId] = row.state;
    byApplication.set(row.applicationId, bag);
  }
  for (const row of confirmationRows) confirmed.set(row.applicationId, row.state);

  return { availability: byApplication, confirmation: confirmed };
}

async function decorate(
  database: Database,
  rows: readonly Application[]
): Promise<ApplicationView[]> {
  const extras = await readExtras(
    database,
    rows.map((row) => row.id)
  );
  return rows.map((row) => ({
    ...row,
    availability: extras.availability.get(row.id) ?? {},
    confirmation: extras.confirmation.get(row.id) ?? null,
  }));
}

async function decorateOne(
  database: Database,
  row: Application
): Promise<ApplicationView> {
  const [view] = await decorate(database, [row]);
  return view;
}

/* ------------------------------------------------------------------ */
/* Answers                                                            */
/* ------------------------------------------------------------------ */

function shapeOf(question: EventQuestion, ladder: readonly string[]): FieldShape {
  return {
    type: question.type,
    label: question.label,
    options: question.options,
    rankLadder: ladder,
  };
}

export type AnswerCheck =
  | { ok: true; answers: ApplicationAnswers }
  | { ok: false; errors: Record<string, string> };

/**
 * Validate a submitted answer set against *this event's* questions.
 *
 * Three things it will not do:
 *
 *  - accept a key that is not one of this event's question ids. That is the
 *    forged-payload case, and it is an error rather than a silent drop;
 *  - trust an option list, a rank ladder or a type from the request;
 *  - let a required question through unanswered. §7 puts the soft nudge on the
 *    profile and the hard gate here, which is the point at which refusing to
 *    continue is the correct behaviour.
 *
 * A linked question with no key in the payload falls back to the member's
 * stored profile answer, so a returning player really can submit without
 * touching anything (§2). `prefill` carries those values.
 */
export function validateAnswers(
  questions: readonly EventQuestion[],
  ladder: readonly string[],
  raw: Record<string, unknown>,
  prefill: Record<string, ProfileValue> = {}
): AnswerCheck {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const errors: Record<string, string> = {};

  for (const key of Object.keys(raw)) {
    if (!byId.has(key)) {
      errors[key] = "That question is not part of this event.";
    }
  }

  const answers: ApplicationAnswers = {};
  for (const question of questions) {
    const supplied = Object.hasOwn(raw, question.id) ? raw[question.id] : prefill[question.id];
    const result = parseProfileValue(shapeOf(question, ladder), supplied ?? null);

    if (!result.ok) {
      errors[question.id] = result.error;
      continue;
    }

    const empty =
      result.value === null || (Array.isArray(result.value) && result.value.length === 0);
    if (question.required && empty) {
      errors[question.id] = "This one is required.";
      continue;
    }
    if (!empty) answers[question.id] = result.value;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, answers };
}

/** The member's profile answers, keyed by the event question that mirrors them. */
async function prefillFromProfile(
  database: Database,
  questions: readonly EventQuestion[],
  userId: string | null
): Promise<Record<string, ProfileValue>> {
  const linked = questions.filter((question) => question.profileFieldId !== null);
  if (!userId || linked.length === 0) return {};

  const rows = await database
    .select()
    .from(profileValues)
    .where(
      and(
        eq(profileValues.userId, userId),
        inArray(
          profileValues.fieldId,
          linked.map((question) => question.profileFieldId as string)
        )
      )
    );

  const byField = new Map(rows.map((row) => [row.fieldId, row.value]));
  const out: Record<string, ProfileValue> = {};
  for (const question of linked) {
    const value = byField.get(question.profileFieldId as string);
    if (value !== undefined) out[question.id] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Creating and editing an event                                      */
/* ------------------------------------------------------------------ */

export type EventDayInput = {
  /** Keep an existing day (and its availability) by passing its id back. */
  id?: string;
  startsAt?: Date | null;
  label?: string | null;
};

export type EventFieldsInput = {
  title?: string;
  slug?: string;
  type?: string;
  description?: string | null;
  bannerUrl?: string | null;
  gameId?: string | null;
  capacity?: number | null;
  signupOpensAt?: Date | null;
  signupClosesAt?: Date | null;
  startsAt?: Date | null;
  endsAt?: Date | null;
  minRankToEnter?: string | null;
  minRankToCaptain?: string | null;
  config?: EventConfig;
};

export type CreateEventInput = EventFieldsInput & {
  title: string;
  /** Copy the config and questions off a template (§7). */
  templateId?: string;
  createdBy?: string | null;
  days?: EventDayInput[];
};

export type UpdateEventInput = EventFieldsInput & {
  /** Guarded by `canTransition`; a nonsense jump is refused, not applied. */
  status?: EventStatus;
};

/** One place to check the things a title and a calendar can get wrong. */
function validateFields(
  next: {
    capacity: number | null;
    signupOpensAt: Date | null;
    signupClosesAt: Date | null;
    startsAt: Date | null;
    endsAt: Date | null;
    minRankToEnter: string | null;
    minRankToCaptain: string | null;
  },
  game: Game | null
): string | null {
  if (next.capacity !== null) {
    if (!Number.isInteger(next.capacity) || next.capacity < 1) {
      return "Capacity has to be a whole number of seats, or empty for unlimited.";
    }
  }
  if (
    next.signupOpensAt &&
    next.signupClosesAt &&
    next.signupClosesAt.getTime() < next.signupOpensAt.getTime()
  ) {
    return "Signups cannot close before they open.";
  }
  if (next.startsAt && next.endsAt && next.endsAt.getTime() < next.startsAt.getTime()) {
    return "The event cannot end before it starts.";
  }
  if (
    next.signupOpensAt &&
    next.startsAt &&
    next.startsAt.getTime() < next.signupOpensAt.getTime()
  ) {
    return "Signups open after the event starts, so nobody could ever apply.";
  }

  const gates: Array<[string | null, string]> = [
    [next.minRankToEnter, "minimum rank to enter"],
    [next.minRankToCaptain, "minimum rank to captain"],
  ];
  for (const [rank, label] of gates) {
    if (!rank) continue;
    if (!game) return `Pick the game before setting a ${label}.`;
    if (game.rankLadder.length === 0) return `${game.name} has no rank ladder to compare against.`;
    const known = game.rankLadder.some(
      (entry) => entry.trim().toLowerCase() === rank.trim().toLowerCase()
    );
    if (!known) return `"${rank}" is not one of ${game.name}'s ranks.`;
  }

  return null;
}

/** A slug nobody else holds. Unlike a game key, this one disambiguates itself. */
async function freeSlug(
  database: Database,
  desired: string,
  fallback: string,
  exceptEventId?: string
): Promise<string> {
  const taken = await database
    .select({ slug: events.slug })
    .from(events)
    .where(exceptEventId ? ne(events.id, exceptEventId) : undefined);
  return uniqueKey(desired || fallback, taken.map((row) => row.slug), "event");
}

/**
 * Create an event, optionally from a template.
 *
 * Everything except the title is optional, because an admin starts by naming
 * the thing and fills the rest in afterwards — which is also why a new event is
 * `draft` and therefore invisible until `publishEvent` says otherwise.
 *
 * A template is **copied**, never referenced: editing "Rivals tournament" next
 * month must not rewrite the questions of an event that is already taking
 * applications.
 */
export async function createEvent(
  input: CreateEventInput,
  database: Database = defaultDb
): Promise<EventResult<EventRow>> {
  const title = cleanText(input.title, TITLE_MAX);
  if (!title) return fail("Give the event a title.");

  let template = null;
  if (input.templateId) {
    const [row] = await database
      .select()
      .from(eventTemplates)
      .where(eq(eventTemplates.id, input.templateId))
      .limit(1);
    if (!row) return fail("That template no longer exists.");
    template = row;
  }

  const gameId =
    input.gameId !== undefined ? (input.gameId ?? null) : (template?.gameId ?? null);
  const game = await readGame(database, gameId);
  if (gameId && !game) return fail("That game no longer exists.");

  const next = {
    capacity: input.capacity ?? null,
    signupOpensAt: input.signupOpensAt ?? null,
    signupClosesAt: input.signupClosesAt ?? null,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    minRankToEnter: cleanNullable(input.minRankToEnter, 60),
    minRankToCaptain: cleanNullable(input.minRankToCaptain, 60),
  };
  const problem = validateFields(next, game);
  if (problem) return fail(problem);

  const slug = await freeSlug(database, slugify(input.slug ?? title), slugify(title));

  const [created] = await database
    .insert(events)
    .values({
      slug,
      title,
      type: cleanText(input.type ?? template?.type ?? "", 40) || "custom",
      status: "draft",
      description: cleanNullable(input.description, DESCRIPTION_MAX),
      bannerUrl: cleanNullable(input.bannerUrl, 500),
      gameId,
      config: { ...(template?.config ?? {}), ...(input.config ?? {}) },
      createdBy: input.createdBy ?? null,
      ...next,
    })
    .returning();

  if (template && template.questions.length > 0) {
    const resolved = await resolveTemplateQuestions(database, template.questions, gameId);
    const written = await setEventQuestions(created.id, resolved, database);
    if (!written.ok) return fail(written.error, written.errors);
  }

  if (input.days && input.days.length > 0) {
    const written = await setEventDays(created.id, input.days, database);
    if (!written.ok) return fail(written.error, written.errors);
  }

  return withData(created);
}

/** Turn a template's `profileFieldKey` references into real field ids. */
async function resolveTemplateQuestions(
  database: Database,
  specs: readonly EventQuestionSpec[],
  gameId: string | null
): Promise<EventQuestionInput[]> {
  const keys = specs
    .map((spec) => spec.profileFieldKey)
    .filter((key): key is string => typeof key === "string" && key !== "");

  const byKey = new Map<string, string>();
  if (keys.length > 0) {
    const rows = await database
      .select()
      .from(profileFields)
      .where(
        and(
          inArray(profileFields.key, keys),
          gameId ? or(eq(profileFields.gameId, gameId), isNull(profileFields.gameId)) : isNull(profileFields.gameId)
        )
      );
    // A game field beats a global one with the same key: it is the more specific
    // answer to "what is this event's version of that question".
    for (const row of rows) {
      if (row.gameId === null && byKey.has(row.key)) continue;
      byKey.set(row.key, row.id);
    }
  }

  return specs.map((spec) => ({
    key: spec.key,
    label: spec.label,
    type: spec.type,
    options: spec.options ?? [],
    required: spec.required ?? false,
    profileFieldId: spec.profileFieldKey ? (byKey.get(spec.profileFieldKey) ?? null) : null,
  }));
}

/**
 * Edit an event. Only the keys present in `patch` change.
 *
 * Status moves through here too, guarded by `canTransition` — an event cannot
 * jump from `draft` to `live` without ever having been published, because then
 * applications would have been impossible right up until they were too late.
 */
export async function updateEvent(
  eventId: string,
  patch: UpdateEventInput,
  database: Database = defaultDb
): Promise<EventResult<EventRow>> {
  const current = await readEvent(database, eventId);
  if (!current) return fail("That event no longer exists.");

  if (patch.status && !canTransition(current.status, patch.status)) {
    return fail(`An event cannot go from ${current.status} to ${patch.status}.`);
  }

  const gameId = patch.gameId !== undefined ? (patch.gameId ?? null) : current.gameId;
  const game = await readGame(database, gameId);
  if (gameId && !game) return fail("That game no longer exists.");

  const pick = <K extends keyof EventRow>(key: K, fallback: EventRow[K]): EventRow[K] =>
    key in patch ? ((patch as Record<string, unknown>)[key] as EventRow[K]) : fallback;

  const next = {
    capacity: (pick("capacity", current.capacity) ?? null) as number | null,
    signupOpensAt: (pick("signupOpensAt", current.signupOpensAt) ?? null) as Date | null,
    signupClosesAt: (pick("signupClosesAt", current.signupClosesAt) ?? null) as Date | null,
    startsAt: (pick("startsAt", current.startsAt) ?? null) as Date | null,
    endsAt: (pick("endsAt", current.endsAt) ?? null) as Date | null,
    minRankToEnter:
      "minRankToEnter" in patch
        ? cleanNullable(patch.minRankToEnter, 60)
        : current.minRankToEnter,
    minRankToCaptain:
      "minRankToCaptain" in patch
        ? cleanNullable(patch.minRankToCaptain, 60)
        : current.minRankToCaptain,
  };

  const problem = validateFields(next, game);
  if (problem) return fail(problem);

  let title = current.title;
  if ("title" in patch) {
    title = cleanText(patch.title, TITLE_MAX);
    if (!title) return fail("Give the event a title.");
  }

  let slug = current.slug;
  if ("slug" in patch && patch.slug !== undefined) {
    const wanted = slugify(patch.slug);
    if (!wanted) return fail("That slug has no letters or numbers in it.");
    slug = wanted === current.slug ? current.slug : await freeSlug(database, wanted, wanted, eventId);
  }

  const [updated] = await database
    .update(events)
    .set({
      title,
      slug,
      gameId,
      status: patch.status ?? current.status,
      type: "type" in patch ? cleanText(patch.type, 40) || current.type : current.type,
      description:
        "description" in patch
          ? cleanNullable(patch.description, DESCRIPTION_MAX)
          : current.description,
      bannerUrl: "bannerUrl" in patch ? cleanNullable(patch.bannerUrl, 500) : current.bannerUrl,
      config: "config" in patch ? { ...current.config, ...(patch.config ?? {}) } : current.config,
      updatedAt: new Date(),
      ...next,
    })
    .where(eq(events.id, eventId))
    .returning();

  return withData(updated);
}

/**
 * Publish an event: members can now see it, and the signup window starts to
 * mean something.
 *
 * Publishing twice is not an error — the admin pressing the button again wants
 * a published event, and they have one.
 */
export async function publishEvent(
  eventId: string,
  database: Database = defaultDb
): Promise<EventResult<EventRow>> {
  const current = await readEvent(database, eventId);
  if (!current) return fail("That event no longer exists.");
  if (current.status === "published") return withData(current);

  if (!canTransition(current.status, "published")) {
    return fail(`A ${current.status} event cannot be published.`);
  }
  if (!current.title.trim()) return fail("Give the event a title before publishing it.");

  const [updated] = await database
    .update(events)
    .set({ status: "published", updatedAt: new Date() })
    .where(eq(events.id, eventId))
    .returning();

  return withData(updated);
}

/* ------------------------------------------------------------------ */
/* Days                                                               */
/* ------------------------------------------------------------------ */

/**
 * Replace an event's days with this list, in this order.
 *
 * Days keep their identity when their id is passed back, which is what stops a
 * reorder throwing away everyone's availability. A day that is *not* in the
 * list is deleted, and its availability answers go with it — so the count comes
 * back in the result, the same way `/admin/games` says how many answers a
 * delete would destroy before it destroys them.
 */
export async function setEventDays(
  eventId: string,
  days: readonly EventDayInput[],
  database: Database = defaultDb
): Promise<EventResult<{ days: EventDay[]; clearedAvailability: number }>> {
  const event = await readEvent(database, eventId);
  if (!event) return fail("That event no longer exists.");

  if (days.length > MAX_EVENT_DAYS) {
    return fail(`An event runs over at most ${MAX_EVENT_DAYS} days.`);
  }

  const existing = await readDays(database, eventId);
  const existingIds = new Set(existing.map((day) => day.id));

  for (const day of days) {
    if (day.id && !existingIds.has(day.id)) {
      return fail("One of those days belongs to a different event.");
    }
  }

  const keeping = new Set(days.map((day) => day.id).filter((id): id is string => Boolean(id)));
  const doomed = existing.filter((day) => !keeping.has(day.id));

  let clearedAvailability = 0;
  if (doomed.length > 0) {
    const [row] = await database
      .select({ total: count() })
      .from(availability)
      .where(
        inArray(
          availability.eventDayId,
          doomed.map((day) => day.id)
        )
      );
    clearedAvailability = Number(row?.total ?? 0);
    // Availability cascades from the day, so this one delete is the whole job.
    await database.delete(eventDays).where(
      inArray(
        eventDays.id,
        doomed.map((day) => day.id)
      )
    );
  }

  const surviving = existing.filter((day) => keeping.has(day.id));
  await moveDaysInto(
    database,
    surviving,
    new Map(
      days.flatMap((day, index) => (day.id ? [[day.id, index] as [string, number]] : []))
    )
  );

  for (const [index, day] of days.entries()) {
    const values = {
      startsAt: day.startsAt ?? null,
      label: cleanNullable(day.label, 60),
    };
    if (day.id) {
      await database.update(eventDays).set(values).where(eq(eventDays.id, day.id));
    } else {
      await database.insert(eventDays).values({ eventId, dayIndex: index, ...values });
    }
  }

  return withData({ days: await readDays(database, eventId), clearedAvailability });
}

/** The slot `moveDaysInto` parks a row in. Never a resting value — see schema. */
const SCRATCH_DAY_INDEX = MAX_EVENT_DAYS;

/**
 * Move surviving days into their new indexes without ever holding two rows on
 * the same one.
 *
 * `day_index` is unique per event and the constraint is checked per statement,
 * so "just write the new numbers" fails the moment two days swap places. The
 * loop below only ever writes into a slot nobody is standing on; when every
 * slot is taken — four days being rotated, which is a pure cycle — it parks one
 * row on the scratch index to break the cycle and carries on. Days keep their
 * ids throughout, which is what stops a reorder wiping everyone's availability.
 */
async function moveDaysInto(
  database: Database,
  surviving: readonly EventDay[],
  targets: ReadonlyMap<string, number>
): Promise<void> {
  const at = new Map(surviving.map((day) => [day.id, day.dayIndex]));
  const holder = new Map(surviving.map((day) => [day.dayIndex, day.id]));
  const pending = new Set(
    surviving.filter((day) => targets.get(day.id) !== day.dayIndex).map((day) => day.id)
  );

  const move = async (id: string, to: number): Promise<void> => {
    await database.update(eventDays).set({ dayIndex: to }).where(eq(eventDays.id, id));
    const from = at.get(id);
    if (from !== undefined) holder.delete(from);
    holder.set(to, id);
    at.set(id, to);
  };

  // Bounded by construction — every pass either seats a row or parks one, and
  // parking can happen at most once per row — but the guard keeps a future
  // change from turning a logic slip into a hung request.
  for (let guard = 0; pending.size > 0 && guard < surviving.length * 2 + 2; guard += 1) {
    let seated = false;
    for (const id of [...pending]) {
      const target = targets.get(id);
      if (target === undefined || holder.has(target)) continue;
      await move(id, target);
      pending.delete(id);
      seated = true;
    }
    if (seated) continue;

    const [stuck] = [...pending];
    if (stuck === undefined) break;
    await move(stuck, SCRATCH_DAY_INDEX);
  }
}

/* ------------------------------------------------------------------ */
/* Questions                                                          */
/* ------------------------------------------------------------------ */

export type EventQuestionInput = {
  /** Keep an existing question (and its answers) by passing its id back. */
  id?: string;
  key?: string;
  label: string;
  type: ProfileFieldType;
  options?: unknown;
  required?: boolean;
  /** Prefill from this profile field. Must belong to the event's game, or be global. */
  profileFieldId?: string | null;
};

/**
 * Replace an event's question set with this list, in this order.
 *
 * The interesting part is not the writing, it is the tidying afterwards:
 * deleting a question, or retyping one from "pick one" to "number", leaves
 * answers behind that no longer mean anything. Rather than let them rot inside
 * the `answers` jsonb, every stored application is re-validated against the new
 * question set and anything that no longer parses is dropped — with the count
 * returned, so the admin screen can say what the edit cost.
 */
export async function setEventQuestions(
  eventId: string,
  questions: readonly EventQuestionInput[],
  database: Database = defaultDb
): Promise<EventResult<{ questions: EventQuestion[]; clearedAnswers: number }>> {
  const event = await readEvent(database, eventId);
  if (!event) return fail("That event no longer exists.");
  if (questions.length > MAX_EVENT_QUESTIONS) {
    return fail(`${MAX_EVENT_QUESTIONS} questions is already more than anyone will answer.`);
  }

  const game = await readGame(database, event.gameId);
  const existing = await readQuestions(database, eventId);
  const existingIds = new Set(existing.map((question) => question.id));

  // Profile fields this event is allowed to prefill from: its game's, plus the
  // global ones. A field belonging to another game would prefill an answer the
  // member gave about a different game entirely.
  const linkable = await database
    .select()
    .from(profileFields)
    .where(
      event.gameId
        ? or(eq(profileFields.gameId, event.gameId), isNull(profileFields.gameId))
        : isNull(profileFields.gameId)
    );
  const linkableById = new Map(linkable.map((field) => [field.id, field]));

  const errors: Record<string, string> = {};
  const cleaned: Array<Required<Omit<EventQuestionInput, "options">> & {
    options: ProfileFieldOption[];
    sort: number;
  }> = [];
  const takenKeys: string[] = [];

  for (const [index, question] of questions.entries()) {
    const at = question.id ?? `new-${index}`;

    if (question.id && !existingIds.has(question.id)) {
      errors[at] = "That question belongs to a different event.";
      continue;
    }

    const label = cleanText(question.label, TITLE_MAX);
    if (!label) {
      errors[at] = "Give the question a label.";
      continue;
    }
    if (!isFieldType(question.type)) {
      errors[at] = "That is not one of the question types.";
      continue;
    }

    const info = fieldTypeInfo(question.type);
    const options = normaliseOptions(question.options);
    if (info.needsOptions && options.length === 0) {
      errors[at] = "A pick-one or pick-any question needs at least one option.";
      continue;
    }
    if (info.usesRankLadder && (!game || game.rankLadder.length === 0)) {
      errors[at] = "A rank question needs an event whose game has a rank ladder.";
      continue;
    }

    let profileFieldId: string | null = question.profileFieldId ?? null;
    if (profileFieldId) {
      const field = linkableById.get(profileFieldId);
      if (!field) {
        errors[at] = "That profile question is not one this event can prefill from.";
        continue;
      }
      if (field.type !== question.type) {
        errors[at] = `The profile question "${field.label}" is a different type, so it cannot prefill this one.`;
        continue;
      }
    }

    const key = uniqueKey(question.key?.trim() || label, takenKeys, `question-${index + 1}`);
    takenKeys.push(key);

    cleaned.push({
      id: question.id ?? "",
      key,
      label,
      type: question.type,
      options,
      required: question.required ?? false,
      profileFieldId,
      sort: index,
    });
  }

  if (Object.keys(errors).length > 0) {
    return fail("Some of those questions need another look.", errors);
  }

  const keeping = new Set(cleaned.map((question) => question.id).filter(Boolean));
  const doomed = existing.filter((question) => !keeping.has(question.id));
  if (doomed.length > 0) {
    await database.delete(eventQuestions).where(
      inArray(
        eventQuestions.id,
        doomed.map((question) => question.id)
      )
    );
  }

  // Keys are unique per event, so the same collision problem as day indexes:
  // swapping two questions' keys in place would trip the constraint halfway.
  // Prefixing every survivor first sidesteps it without dropping rows.
  for (const question of existing) {
    if (!keeping.has(question.id)) continue;
    await database
      .update(eventQuestions)
      .set({ key: `tmp-${question.id}` })
      .where(eq(eventQuestions.id, question.id));
  }

  for (const question of cleaned) {
    const values = {
      key: question.key,
      label: question.label,
      type: question.type,
      options: question.options,
      required: question.required,
      sort: question.sort,
      profileFieldId: question.profileFieldId,
    };
    if (question.id) {
      await database
        .update(eventQuestions)
        .set(values)
        .where(eq(eventQuestions.id, question.id));
    } else {
      await database.insert(eventQuestions).values({ eventId, ...values });
    }
  }

  const written = await readQuestions(database, eventId);
  const clearedAnswers = await clearOrphanedAnswers(
    database,
    eventId,
    written,
    game?.rankLadder ?? []
  );

  return withData({ questions: written, clearedAnswers });
}

/**
 * Drop stored answers that no longer parse against the current questions.
 *
 * Reads the values rather than trying to express "still valid" in SQL, because
 * the rules live in `profile-fields` and having them in two places is how the
 * two versions drift apart.
 */
async function clearOrphanedAnswers(
  database: Database,
  eventId: string,
  questions: readonly EventQuestion[],
  ladder: readonly string[]
): Promise<number> {
  const rows = await database
    .select({ id: applications.id, answers: applications.answers })
    .from(applications)
    .where(eq(applications.eventId, eventId));

  const byId = new Map(questions.map((question) => [question.id, question]));
  let cleared = 0;

  for (const row of rows) {
    const kept: ApplicationAnswers = {};
    let dropped = 0;

    for (const [questionId, value] of Object.entries(row.answers)) {
      const question = byId.get(questionId);
      if (!question) {
        dropped += 1;
        continue;
      }
      const parsed = parseProfileValue(shapeOf(question, ladder), value);
      if (!parsed.ok || parsed.value === null) {
        dropped += 1;
        continue;
      }
      kept[questionId] = parsed.value;
    }

    if (dropped === 0) continue;
    cleared += dropped;
    await database.update(applications).set({ answers: kept }).where(eq(applications.id, row.id));
  }

  return cleared;
}

/* ------------------------------------------------------------------ */
/* Applying                                                           */
/* ------------------------------------------------------------------ */

export type ApplyInput = {
  /** Keyed by `event_questions.id`. Missing linked keys prefill from the profile. */
  answers?: Record<string, unknown>;
  /** Keyed by `event_days.id`. */
  availability?: Record<string, AvailabilityState | null>;
  /** For a caller that has already stamped the request, and for tests. */
  now?: Date;
};

/**
 * Apply to an event — the whole member-side flow, in one transaction.
 *
 * The order matters and it is deliberate:
 *
 *  1. lock the event row, so nobody else is counting seats at the same time;
 *  2. re-read the questions, the ladder and the counts from inside that lock;
 *  3. refuse everything that should be refused — closed signups, a failed rank
 *     gate, an unanswered required question, a second application;
 *  4. *then* decide accepted vs waitlisted, and write.
 *
 * Steps 2 and 4 being inside the same lock is the entire point. Split them and
 * two people take the last seat, which is the kind of bug that surfaces once,
 * on the busiest event of the year, and cannot be reproduced afterwards.
 *
 * Re-applying after withdrawing is allowed and reuses the row: they go to the
 * back of whatever queue exists now, which is the fair reading of first-come.
 */
export async function applyToEvent(
  eventId: string,
  userId: string,
  input: ApplyInput = {},
  database: Database = defaultDb
): Promise<EventResult<ApplicationView>> {
  const now = input.now ?? new Date();

  return database.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const [member] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!member) return fail("We do not have an account for you.");

    const game = await readGame(tx, event.gameId);
    const ladder = game?.rankLadder ?? [];

    const existing = await readApplications(tx, eventId);
    const mine = existing.find((row) => row.userId === userId) ?? null;

    if (mine && (mine.status === "accepted" || mine.status === "waitlisted")) {
      return fail("You have already applied to this event.");
    }
    if (mine && mine.status === "declined") {
      return fail("Your application to this event was declined.");
    }

    // Counts exclude this member's own withdrawn row, which holds no seat.
    const others = existing.filter((row) => row.id !== mine?.id);
    const seats = capacityState(event, others);

    const state = applicationsOpen(event, now, {
      accepted: seats.accepted,
      waitlisted: seats.waitlisted,
    });
    if (!state.open) return fail(state.message);

    const rank = await memberRank(tx, event.gameId, userId);
    const gate = eligibility(event, { rank }, ladder);
    if (!gate.canEnter) return fail(gate.enterReason);

    const questions = await readQuestions(tx, eventId);
    const prefill = await prefillFromProfile(tx, questions, userId);
    const checked = validateAnswers(questions, ladder, input.answers ?? {}, prefill);
    if (!checked.ok) {
      return fail("Some of those answers need another look.", checked.errors);
    }

    const days = await readDays(tx, eventId);
    const dayIds = new Set(days.map((day) => day.id));
    for (const dayId of Object.keys(input.availability ?? {})) {
      if (!dayIds.has(dayId)) return fail("That day is not part of this event.");
    }

    const status: ApplicationStatus = state.willWaitlist ? "waitlisted" : "accepted";
    const waitlistPosition =
      status === "waitlisted" ? nextWaitlistPosition(others) : null;

    const values = {
      status,
      answers: checked.answers,
      submittedAt: now,
      waitlistPosition,
      decidedAt: null,
      decidedBy: null,
    };

    const [written] = mine
      ? await tx.update(applications).set(values).where(eq(applications.id, mine.id)).returning()
      : await tx
          .insert(applications)
          .values({ eventId, userId, ...values })
          .returning();

    await writeAvailability(tx, written.id, input.availability ?? {}, dayIds);
    await renumberWaitlist(tx, eventId);

    const [fresh] = await tx.select().from(applications).where(eq(applications.id, written.id));
    return withData(await decorateOne(tx, fresh));
  });
}

/**
 * Rewrite the queue so the positions run 1…n with no gaps.
 *
 * Positions are cleared before they are reassigned rather than moved in place.
 * The partial unique index on (event, position) is checked per statement, so
 * shuffling in place can trip it halfway through a legal rewrite; nulls are
 * never in conflict, so two passes always fit through.
 */
async function renumberWaitlist(database: Database, eventId: string): Promise<void> {
  const rows = await readApplications(database, eventId);
  const assignments = recomputeWaitlist(rows);
  const changed = assignments.filter((assignment) => assignment.changed);
  if (changed.length === 0) return;

  await database
    .update(applications)
    .set({ waitlistPosition: null })
    .where(
      inArray(
        applications.id,
        changed.map((assignment) => assignment.id)
      )
    );

  for (const assignment of changed) {
    if (assignment.waitlistPosition === null) continue;
    await database
      .update(applications)
      .set({ waitlistPosition: assignment.waitlistPosition })
      .where(eq(applications.id, assignment.id));
  }
}

/** Upsert one application's day answers; `null` clears a day. */
async function writeAvailability(
  database: Database,
  applicationId: string,
  byDay: Record<string, AvailabilityState | null>,
  dayIds: ReadonlySet<string>
): Promise<void> {
  const now = new Date();
  for (const [dayId, state] of Object.entries(byDay)) {
    if (!dayIds.has(dayId)) continue;
    if (state === null) {
      await database
        .delete(availability)
        .where(
          and(eq(availability.applicationId, applicationId), eq(availability.eventDayId, dayId))
        );
      continue;
    }
    await database
      .insert(availability)
      .values({ applicationId, eventDayId: dayId, state, updatedAt: now })
      .onConflictDoUpdate({
        target: [availability.applicationId, availability.eventDayId],
        set: { state, updatedAt: now },
      });
  }
}

/**
 * Withdraw, and let the next person in.
 *
 * A withdrawal is the one status change that promotes automatically (§14): the
 * member has freed a seat, nobody needs to approve that, and the person at the
 * front of the queue should not have to refresh the page all evening to notice.
 * Promotion and renumbering happen in the same transaction as the withdrawal,
 * so there is no instant at which the seat is free and the queue still says #1.
 *
 * Withdrawing twice is not an error — it says withdrawn, and it is.
 */
export async function withdrawApplication(
  eventId: string,
  userId: string,
  database: Database = defaultDb
): Promise<EventResult<{ application: ApplicationView; promoted: ApplicationView[] }>> {
  return database.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const rows = await readApplications(tx, eventId);
    const mine = rows.find((row) => row.userId === userId);
    if (!mine) return fail("You have not applied to this event.");

    if (mine.status === "withdrawn") {
      return withData({ application: await decorateOne(tx, mine), promoted: [] });
    }

    const freedASeat = mine.status === "accepted";

    const [withdrawn] = await tx
      .update(applications)
      .set({ status: "withdrawn", waitlistPosition: null, decidedAt: new Date() })
      .where(eq(applications.id, mine.id))
      .returning();

    let promoted: Application[] = [];
    if (freedASeat) {
      const remaining = rows
        .filter((row) => row.id !== mine.id)
        .concat({ ...withdrawn });
      const promotion = promoteFromWaitlist(remaining, event.capacity);

      if (promotion.promoted.length > 0) {
        promoted = await tx
          .update(applications)
          .set({ status: "accepted", waitlistPosition: null })
          .where(
            inArray(
              applications.id,
              promotion.promoted.map((row) => row.id)
            )
          )
          .returning();
      }
    }

    await renumberWaitlist(tx, eventId);

    const [fresh] = await tx.select().from(applications).where(eq(applications.id, mine.id));
    return withData({
      application: await decorateOne(tx, fresh),
      promoted: await decorate(tx, promoted),
    });
  });
}

export type DecisionInput = {
  decidedBy?: string | null;
  note?: string | null;
  now?: Date;
  /**
   * Fill the seat this decision frees from the waitlist. Off by default: an
   * admin declining somebody is *choosing* who is in the event, and a promotion
   * they did not ask for is a surprise. A withdrawal is the case where nobody
   * is choosing, and that promotes on its own.
   */
  promote?: boolean;
};

/**
 * An admin decision on one application.
 *
 * This is §8.3's override, so it is deliberately not gated: an admin can accept
 * somebody the rank threshold would have turned away, and can accept past
 * capacity — the result says `overCapacity` so the screen can show it rather
 * than the write silently refusing. Gates are guidance, not a wall.
 */
export async function setApplicationStatus(
  applicationId: string,
  status: ApplicationStatus,
  options: DecisionInput = {},
  database: Database = defaultDb
): Promise<
  EventResult<{
    application: ApplicationView;
    promoted: ApplicationView[];
    seats: CapacityState;
    overCapacity: boolean;
  }>
> {
  const now = options.now ?? new Date();

  return database.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);
    if (!current) return fail("That application no longer exists.");

    const event = await lockEvent(tx, current.eventId);
    if (!event) return fail("That event no longer exists.");

    const rows = await readApplications(tx, current.eventId);
    const others = rows.filter((row) => row.id !== current.id);

    const waitlistPosition =
      status === "waitlisted" ? nextWaitlistPosition(others) : null;

    const [updated] = await tx
      .update(applications)
      .set({
        status,
        waitlistPosition,
        decidedAt: now,
        decidedBy: options.decidedBy ?? null,
        note: options.note === undefined ? current.note : cleanNullable(options.note, NOTE_MAX),
      })
      .where(eq(applications.id, applicationId))
      .returning();

    let promoted: Application[] = [];
    if (options.promote) {
      const after = others.concat(updated);
      const promotion = promoteFromWaitlist(after, event.capacity);
      if (promotion.promoted.length > 0) {
        promoted = await tx
          .update(applications)
          .set({ status: "accepted", waitlistPosition: null })
          .where(
            inArray(
              applications.id,
              promotion.promoted.map((row) => row.id)
            )
          )
          .returning();
      }
    }

    await renumberWaitlist(tx, current.eventId);

    const final = await readApplications(tx, current.eventId);
    const seats = capacityState(event, final);
    const [fresh] = final.filter((row) => row.id === applicationId);

    return withData({
      application: await decorateOne(tx, fresh),
      promoted: await decorate(tx, promoted),
      seats,
      overCapacity: seats.overCapacity,
    });
  });
}

/**
 * Set one application's per-day availability.
 *
 * Days are checked against *this application's* event: a day id from another
 * event is refused rather than ignored, because the only ways to send one are a
 * stale page and a forgery, and both deserve to be told.
 */
export async function setAvailability(
  applicationId: string,
  byDay: Record<string, AvailabilityState | null>,
  database: Database = defaultDb
): Promise<EventResult<Record<string, AvailabilityState>>> {
  const [application] = await database
    .select()
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (!application) return fail("That application no longer exists.");

  const days = await readDays(database, application.eventId);
  const dayIds = new Set(days.map((day) => day.id));
  for (const dayId of Object.keys(byDay)) {
    if (!dayIds.has(dayId)) return fail("That day is not part of this event.");
  }

  await writeAvailability(database, applicationId, byDay, dayIds);

  const view = await decorateOne(database, application);
  return withData(view.availability);
}

/**
 * The "still coming?" answer (§2).
 *
 * Only somebody with a live application can answer it: confirming attendance
 * for an application that was declined or withdrawn is not a state worth
 * storing, and letting it through would put the wrong people in the count the
 * admin uses to decide whether the event can run.
 */
export async function setConfirmation(
  applicationId: string,
  state: ConfirmationState,
  database: Database = defaultDb
): Promise<EventResult<{ state: ConfirmationState; confirmedAt: Date }>> {
  const [application] = await database
    .select()
    .from(applications)
    .where(eq(applications.id, applicationId))
    .limit(1);
  if (!application) return fail("That application no longer exists.");

  if (application.status === "declined" || application.status === "withdrawn") {
    return fail("That application is not active, so there is nothing to confirm.");
  }

  const confirmedAt = new Date();
  await database
    .insert(confirmations)
    .values({ applicationId, state, confirmedAt })
    .onConflictDoUpdate({
      target: confirmations.applicationId,
      set: { state, confirmedAt },
    });

  return withData({ state, confirmedAt });
}

/* ------------------------------------------------------------------ */
/* Reads for the pages                                                */
/* ------------------------------------------------------------------ */

export type ListEventsOptions = {
  /** One status or several. Omit for every status — admin lists want that. */
  status?: EventStatus | EventStatus[];
  /**
   * True: only events still to come. False: only ones that have been and gone.
   * Omit: everything.
   */
  upcoming?: boolean;
  now?: Date;
};

/**
 * The list behind the hub, the events index and the archive.
 *
 * Seat counts come back grouped from Postgres rather than per event, because
 * twenty events would otherwise be twenty round trips — and on Neon that is
 * twenty HTTP requests.
 */
export async function listEvents(
  options: ListEventsOptions = {},
  database: Database = defaultDb
): Promise<EventSummary[]> {
  const now = options.now ?? new Date();
  const wanted = options.status
    ? Array.isArray(options.status)
      ? options.status
      : [options.status]
    : null;

  const rows = await database
    .select()
    .from(events)
    .where(wanted ? inArray(events.status, wanted) : undefined)
    .orderBy(asc(events.startsAt), desc(events.createdAt));

  const counts = await database
    .select({
      eventId: applications.eventId,
      status: applications.status,
      total: count(),
    })
    .from(applications)
    .groupBy(applications.eventId, applications.status);

  const byEvent = new Map<string, Array<{ status: ApplicationStatus }>>();
  for (const row of counts) {
    const bag = byEvent.get(row.eventId) ?? [];
    for (let index = 0; index < Number(row.total); index += 1) bag.push({ status: row.status });
    byEvent.set(row.eventId, bag);
  }

  const summaries = rows.map((event) => summarise(event, byEvent.get(event.id) ?? [], now));

  if (options.upcoming === undefined) return summaries;

  const isPast = (event: EventRow): boolean => {
    if (event.status === "complete" || event.status === "cancelled") return true;
    const end = event.endsAt ?? event.startsAt;
    return end !== null && end.getTime() < now.getTime();
  };

  const filtered = summaries.filter((event) =>
    options.upcoming ? !isPast(event) : isPast(event)
  );
  // The archive reads newest first; what is coming up reads soonest first.
  return options.upcoming ? filtered : filtered.reverse();
}

function summarise(
  event: EventRow,
  rows: ReadonlyArray<{ status: ApplicationStatus }>,
  now: Date
): EventSummary {
  const seats = capacityState(event, rows);
  return {
    ...event,
    seats,
    applicationsState: applicationsOpen(event, now, {
      accepted: seats.accepted,
      waitlisted: seats.waitlisted,
    }),
  };
}

async function detail(
  database: Database,
  event: EventRow,
  now: Date
): Promise<EventDetail> {
  const [game, days, questions, rows] = await Promise.all([
    readGame(database, event.gameId),
    readDays(database, event.id),
    readQuestions(database, event.id),
    readApplications(database, event.id),
  ]);

  const ladder = game?.rankLadder ?? [];
  return {
    ...summarise(event, rows, now),
    game,
    rankLadder: [...ladder],
    days,
    questions: questions.map((question) => ({
      ...question,
      choices: choicesFor(question.type, question.options, ladder),
    })),
  };
}

/** The public event page: /events/[slug]. */
export async function getEventBySlug(
  slug: string,
  options: { now?: Date } = {},
  database: Database = defaultDb
): Promise<EventDetail | null> {
  const [event] = await database.select().from(events).where(eq(events.slug, slug)).limit(1);
  if (!event) return null;
  return detail(database, event, options.now ?? new Date());
}

/** The same, by id — what the admin editor holds. */
export async function getEventById(
  eventId: string,
  options: { now?: Date } = {},
  database: Database = defaultDb
): Promise<EventDetail | null> {
  const event = await readEvent(database, eventId);
  if (!event) return null;
  return detail(database, event, options.now ?? new Date());
}

/**
 * The admin's applicant list: everybody, in the order they should be read.
 *
 * Accepted first in submission order, then the queue in its own order, then the
 * decided-against and the departed. Each row carries the member's rank and
 * their eligibility, so the captain picker can grey out anyone below the
 * captain threshold (§8.3) without a second pass over the database.
 */
export async function getApplicationsForEvent(
  eventId: string,
  database: Database = defaultDb
): Promise<ApplicantView[]> {
  const event = await readEvent(database, eventId);
  if (!event) return [];

  const rows = await readApplications(database, eventId);
  if (rows.length === 0) return [];

  const [game, views, members, ranks] = await Promise.all([
    readGame(database, event.gameId),
    decorate(database, rows),
    database
      .select({
        id: users.id,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        discordId: users.discordId,
      })
      .from(users)
      .where(
        inArray(
          users.id,
          rows.map((row) => row.userId)
        )
      ),
    memberRanks(
      database,
      event.gameId,
      rows.map((row) => row.userId)
    ),
  ]);

  const ladder = game?.rankLadder ?? [];
  const memberById = new Map(members.map((member) => [member.id, member]));
  const rank: Record<ApplicationStatus, number> = {
    accepted: 0,
    waitlisted: 1,
    declined: 2,
    withdrawn: 3,
  };

  return views
    .map((view): ApplicantView => {
      const memberRankValue = ranks.get(view.userId) ?? null;
      return {
        ...view,
        member: memberById.get(view.userId) ?? {
          id: view.userId,
          displayName: null,
          avatarUrl: null,
          discordId: null,
        },
        rank: memberRankValue,
        eligibility: eligibility(event, { rank: memberRankValue }, ladder),
      };
    })
    .sort((a, b) => {
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
      if (a.status === "waitlisted" && b.status === "waitlisted") {
        return (a.waitlistPosition ?? 0) - (b.waitlistPosition ?? 0);
      }
      return a.submittedAt.getTime() - b.submittedAt.getTime();
    });
}

/** "My applications" — every event this member has applied to, soonest first. */
export async function getMyApplications(
  userId: string,
  options: { now?: Date } = {},
  database: Database = defaultDb
): Promise<MyApplicationView[]> {
  const rows = await database
    .select()
    .from(applications)
    .where(eq(applications.userId, userId))
    .orderBy(desc(applications.submittedAt));
  if (rows.length === 0) return [];

  const eventIds = [...new Set(rows.map((row) => row.eventId))];
  const [eventRows, views, counts] = await Promise.all([
    database.select().from(events).where(inArray(events.id, eventIds)),
    decorate(database, rows),
    database
      .select({ eventId: applications.eventId, status: applications.status, total: count() })
      .from(applications)
      .where(inArray(applications.eventId, eventIds))
      .groupBy(applications.eventId, applications.status),
  ]);

  const eventById = new Map(eventRows.map((event) => [event.id, event]));
  const byEvent = new Map<string, Array<{ status: ApplicationStatus }>>();
  for (const row of counts) {
    const bag = byEvent.get(row.eventId) ?? [];
    for (let index = 0; index < Number(row.total); index += 1) bag.push({ status: row.status });
    byEvent.set(row.eventId, bag);
  }

  return views
    .flatMap((view): MyApplicationView[] => {
      const event = eventById.get(view.eventId);
      if (!event) return [];
      return [{ ...view, event, seats: capacityState(event, byEvent.get(event.id) ?? []) }];
    })
    .sort((a, b) => {
      const timeA = a.event.startsAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const timeB = b.event.startsAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return timeA - timeB;
    });
}

/**
 * The member's application form, filled in.
 *
 * One read gives the page everything: the event, whether it is taking
 * applications and why not, whether this member clears the rank gate, and every
 * question carrying the answer they already gave — or, for a linked question
 * they have never answered here, the answer sitting on their profile.
 *
 * That last part is the reason the profile exists (§2): a returning player
 * should check that the prefilled answers are still right, tap the days they
 * can make, and submit.
 */
export async function loadApplicationForm(
  eventId: string,
  userId: string | null,
  options: { now?: Date } = {},
  database: Database = defaultDb
): Promise<ApplicationFormView | null> {
  const now = options.now ?? new Date();
  const event = await readEvent(database, eventId);
  if (!event) return null;

  const view = await detail(database, event, now);
  const rank = await memberRank(database, event.gameId, userId);

  const [mine] = userId
    ? await database
        .select()
        .from(applications)
        .where(and(eq(applications.eventId, eventId), eq(applications.userId, userId)))
        .limit(1)
    : [];

  const application = mine ? await decorateOne(database, mine) : null;
  const prefill = await prefillFromProfile(database, view.questions, userId);

  const questions = view.questions.map((question): PrefilledQuestionView => {
    const answered = application?.answers[question.id];
    if (answered !== undefined) {
      return { ...question, value: answered, prefilled: false };
    }
    const fromProfile = prefill[question.id];
    return {
      ...question,
      value: fromProfile ?? null,
      prefilled: fromProfile !== undefined && fromProfile !== null,
    };
  });

  return {
    event: view,
    state: view.applicationsState,
    eligibility: eligibility(event, { rank }, view.rankLadder),
    rank,
    questions,
    availability: application?.availability ?? {},
    confirmation: application?.confirmation ?? null,
    application,
  };
}

/* ------------------------------------------------------------------ */
/* Templates                                                          */
/* ------------------------------------------------------------------ */

/** The starting points an admin can pick from when creating an event. */
export async function listEventTemplates(database: Database = defaultDb) {
  return database
    .select()
    .from(eventTemplates)
    .where(eq(eventTemplates.isActive, true))
    .orderBy(asc(eventTemplates.sort), asc(eventTemplates.name));
}
