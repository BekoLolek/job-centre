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

import { and, asc, count, desc, eq, inArray, isNull, ne, notInArray, or } from "drizzle-orm";
import {
  type Application,
  type ApplicationAnswers,
  type ApplicationStatus,
  type AvailabilityState,
  type ConfirmationState,
  type Database,
  type EntryRule,
  type EntryWaiverRow,
  type EventConfig,
  type EventDay,
  type EventQuestion,
  type EventQuestionSpec,
  type EventRow,
  type EventStatus,
  type Game,
  type ProfileField,
  type ProfileFieldOption,
  type ProfileFieldType,
  type ProfileValue,
  applications,
  availability,
  confirmations,
  db as defaultDb,
  entryWaivers,
  eventDays,
  eventQuestions,
  eventTemplates,
  events,
  games,
  profileFields,
  profileValues,
  users,
} from "@/db";
import { LOCKED_STATUSES, lockRefusal } from "./archive-policy";
import {
  type ApplicationsState,
  type CapacityState,
  type DayView,
  type Eligibility,
  type EventDates,
  type EventGateView,
  type PublishView,
  type SetupField,
  type WaivedRules,
  NO_WAIVERS,
  PUBLISH_REQUIREMENT_TEXT,
  applicationsOpen,
  canTransition,
  capacityProblem,
  capacityState,
  confirmationDeadline,
  confirmationsOpen,
  daySequenceProblem,
  eligibility,
  entryMode,
  eventDates,
  missingToPublish,
  nextWaitlistPosition,
  promoteFromWaitlist,
  recomputeWaitlist,
  signupWindowProblem,
  waivedRulesFrom,
} from "./events-policy";
import { type ProfileSectionView, loadProfileForGame } from "./profile";
import {
  type FieldShape,
  choicesFor,
  detailAttention,
  fieldTypeInfo,
  hasAnswer,
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
  | {
      ok: false;
      error: string;
      errors?: Record<string, string>;
      /**
       * Present on the one refusal that is not a "no": UC-14 3a's over-cap
       * accept, which the manager may go through with by asking again.
       */
      confirm?: OverCapacityConfirmation;
    };

/**
 * What the screen has to put in front of the manager before it may ask again
 * (UC-14 3a). The numbers are read inside the write's own transaction, so they
 * are what the cap actually is and what the room actually holds — not what the
 * page was rendered with.
 */
export type OverCapacityConfirmation = {
  kind: "over_capacity";
  /** The cap, unchanged — accepting past it does not raise it. */
  capacity: number;
  /** How many hold a seat right now, before this accept. */
  accepted: number;
};

function fail(error: string, errors?: Record<string, string>): {
  ok: false;
  error: string;
  errors?: Record<string, string>;
} {
  return errors ? { ok: false, error, errors } : { ok: false, error };
}

/**
 * A refusal the caller can overturn by asking a second time.
 *
 * Deliberately a refusal rather than a flag on a success: the write has not
 * happened. `setApplicationStatus` returning `ok` with "…but it was over the
 * cap" is exactly the shape that let the old screen decide after the fact, and
 * a decision made after the fact cannot be enforced on a caller that skips the
 * screen (UC-14 3a).
 */
function needsConfirming(error: string, confirm: OverCapacityConfirmation): {
  ok: false;
  error: string;
  confirm: OverCapacityConfirmation;
} {
  return { ok: false, error, confirm };
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

/** One of the event's own questions, with this member's answer already in it. */
export type AnsweredQuestionView = EventQuestionView & {
  value: ProfileValue;
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
  /**
   * When the member last said a **linked** question's answer is still right
   * (R-49 / UC-12 3), ISO, keyed by `event_questions.id`.
   *
   * Only linked questions appear: their answer is a `profile_values` row, which
   * is the only thing that carries `confirmed_at`. An answer the event asks in
   * its own right is given on the application and has no such stamp, so it is
   * absent rather than null — there is no question to ask about it.
   *
   * ISO rather than a `Date` because `ApplicantsTab` is a client component, and
   * `ApplyDay.startsAt` already settled that a `Date` does not survive those
   * props well. The formatting happens in the browser, never here.
   */
  answerConfirmedAt: Record<string, string>;
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
  /**
   * Which rules a manager has waived for them on this event (R-59).
   *
   * Next to `eligibility` rather than folded into it, because the two answer
   * different questions: `eligibility.enterWaived` says a waiver is what makes
   * them eligible, this says a waiver *exists* — which is what a screen offering
   * to withdraw one has to know, including when the member has since climbed
   * the ladder and no longer needs it.
   */
  waived: WaivedRules;
};

/**
 * One question this application still needs the member for (UC-13 2).
 *
 * `why` is `detailAttention`'s: `missing` for a required answer that is not
 * there, `stale` for an answer the question has outgrown — "a question changed
 * since you answered it", which is the case nobody can see coming and only the
 * member can fix.
 */
export type OutstandingAnswer = {
  /** `profile_fields.id`, or `event_questions.id` for the event's own. */
  id: string;
  label: string;
  why: "missing" | "stale";
  /** Where the answer lives, which is also where the member goes to fix it. */
  where: "profile" | "event";
};

export type MyApplicationView = ApplicationView & {
  event: EventRow;
  seats: CapacityState;
  /**
   * What this application still needs from them — empty for the great majority
   * (R-60 / UC-13 2). Derived on every read, never stored
   * (docs/domain-model.md:335), the same rule the seat counts follow: a to-do
   * that outlived the thing it was asking for is worse than no to-do at all.
   */
  outstanding: OutstandingAnswer[];
};

/** Everything the member's application page needs, in one read. */
export type ApplicationFormView = {
  event: EventDetail;
  state: ApplicationsState;
  eligibility: Eligibility;
  /** Which of the two rules a manager has waived for them here (R-59). */
  waived: WaivedRules;
  /** The member's rank for this event's game, as recorded on their profile. */
  rank: string | null;
  /**
   * The member's profile details for this event's game, and the global ones
   * (UC-12 2) — the **full** profile for that game, not only the parts an event
   * question happens to link to. This is what the member checks and edits; the
   * edits go to the profile (R-11, R-49).
   */
  profile: ProfileSectionView[];
  /** The event's *own* questions only. See `ownQuestions`. */
  questions: AnsweredQuestionView[];
  /** Their answer per day, empty on a first visit. */
  availability: Record<string, AvailabilityState>;
  confirmation: ConfirmationState | null;
  /** Their existing application, if they have one. */
  application: ApplicationView | null;
  /**
   * Whether an existing application's answers may still be changed (R-53 /
   * UC-13 3, 4a) — `answersEditable`'s answer, decided on the server against
   * the same clock the write will use so the page and `editApplicationAnswers`
   * cannot disagree. False for a visitor with no application.
   */
  canEditAnswers: boolean;
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

/**
 * The event row as the rest of the site reads it: **its dates are its days'**
 * (R-24, UC-11 2).
 *
 * Every read in this module goes through here, which is what makes "stop
 * reading `starts_at`" true rather than aspirational — the column is still on
 * the row until the follow-up migration drops it, and overwriting it on the way
 * out is what stops a stale copy leaking into a countdown, a listing order or
 * the answer deadline. `eventDates` is where the arithmetic lives.
 */
function withDates(event: EventRow, days: readonly DayView[]): EventRow {
  return { ...event, ...eventDates(days) };
}

/** The same, for a row whose days have already been reduced to two instants. */
function withKnownDates(event: EventRow, dates: EventDates): EventRow {
  return { ...event, ...dates };
}

/**
 * When each of these events runs, in one query.
 *
 * The list pages and "my applications" need the dates of twenty events at
 * once, and twenty reads of `event_days` would be twenty round trips — on Neon,
 * twenty HTTP requests. Grouped in TypeScript rather than with `min`/`max` in
 * SQL so that `eventDates` stays the only place the rule is written down.
 *
 * Exported because three list reads outside this module — the player profile,
 * a championship season's events and the templates screen — each need the same
 * answer for a whole set of events at once (R-24, R-40, R-41, UC-11 2), and the
 * publish announcement needs it for one (`announceEventPublished`, which has
 * the event row already and only wants the date). The alternative was a copy of
 * "earliest dated day, latest dated day" next to each of them, which is the
 * drift this module's `eventDates` exists to prevent. A one-event call is just
 * a one-row map rather than a special case worth its own function.
 *
 * {@link withDates} and {@link withKnownDates} stay private: they overwrite an
 * `EventRow`'s own columns, and these callers hold column projections, a row
 * they must not write dates onto, or no row at all.
 */
export async function readDatesFor(
  database: Database,
  eventIds: readonly string[]
): Promise<Map<string, EventDates>> {
  const out = new Map<string, EventDates>();
  if (eventIds.length === 0) return out;

  const rows = await database
    .select({
      eventId: eventDays.eventId,
      startsAt: eventDays.startsAt,
      dayIndex: eventDays.dayIndex,
    })
    .from(eventDays)
    .where(inArray(eventDays.eventId, [...eventIds]))
    .orderBy(asc(eventDays.dayIndex));

  const byEvent = new Map<string, DayView[]>();
  for (const row of rows) {
    const bag = byEvent.get(row.eventId) ?? [];
    bag.push({ startsAt: row.startsAt });
    byEvent.set(row.eventId, bag);
  }
  for (const eventId of eventIds) {
    out.set(eventId, eventDates(byEvent.get(eventId) ?? []));
  }
  return out;
}

/**
 * A setup as it stands before a save, for the action layer's two questions
 * (UC-08 10b): *did anything an applicant depends on move* —
 * `changedSetupFields` — and *is this an event anybody could have applied to*,
 * which is `status`.
 *
 * **Exactly those columns, and deliberately not the two dead ones.** The
 * version of this that returned a whole `EventRow` had to read `event_days` as
 * well, purely to overwrite `starts_at`/`ends_at` with the derived answer
 * (`withDates`) so that nobody could read the stale column off it — a second
 * round trip on every setup save, for dates none of these callers looks at
 * (`TOLD_ABOUT` has no dates in it, because a day moving is the Days tab's
 * notification to send). Projecting the columns instead is one query and makes
 * the stale read impossible rather than merely overwritten.
 *
 * A caller that wants the dates wants {@link getEventById} (the game, the days
 * and the questions too) or {@link readDatesFor} (the dates alone).
 */
export type EventSetupRow = Pick<EventRow, "status" | SetupField>;

export async function getEventSetup(
  eventId: string,
  database: Database = defaultDb
): Promise<EventSetupRow | null> {
  const [row] = await database
    .select({
      status: events.status,
      title: events.title,
      type: events.type,
      description: events.description,
      slug: events.slug,
      gameId: events.gameId,
      capacity: events.capacity,
      signupOpensAt: events.signupOpensAt,
      signupClosesAt: events.signupClosesAt,
      minRankToEnter: events.minRankToEnter,
      minRankToCaptain: events.minRankToCaptain,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  return row ?? null;
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

/* ------------------------------------------------------------------ */
/* Entry waivers (R-59 / UC-14 3b)                                    */
/* ------------------------------------------------------------------ */

/**
 * The waivers granted on one event, optionally narrowed to some of its members.
 *
 * Always filtered by `eventId` and never by waiver id alone. A waiver is
 * identified by (event, member, rule) and every caller already knows which
 * event it is asking about, so there is no read here that could be pointed at
 * another event's row by a stale or forged id — the rule `event-scope.ts`
 * states for writes, applied to the reads that decide them.
 */
async function readWaivers(
  database: Database,
  eventId: string,
  userIds?: readonly string[]
): Promise<EntryWaiverRow[]> {
  if (userIds && userIds.length === 0) return [];
  return database
    .select()
    .from(entryWaivers)
    .where(
      and(
        eq(entryWaivers.eventId, eventId),
        userIds ? inArray(entryWaivers.userId, [...userIds]) : undefined
      )
    );
}

/** One member's standing against one event's two rank rules. */
export type MemberGate = {
  /** Their recorded rank for this event's game, if it has one. */
  rank: string | null;
  /** What a manager has waived for them on this event. */
  waived: WaivedRules;
  eligibility: Eligibility;
};

/**
 * The rank gate for a list of members on one event — ladder, ranks and waivers.
 *
 * The single place that assembles the three reads an eligibility answer needs,
 * because there are now four callers of it (the applicant list, the member's
 * own form, `applyToEvent` and `setCaptains`) and a second assembly is a second
 * chance for one of them to forget the waivers and refuse somebody a manager
 * has already let in.
 *
 * Exported for `src/lib/draft.ts`, which needs exactly this answer inside
 * `setCaptains`'s transaction and must not grow its own copy of the ladder and
 * rank reads to get it.
 */
export async function gatesFor(
  database: Database,
  event: { id: string; gameId: string | null } & EventGateView,
  userIds: readonly string[]
): Promise<Map<string, MemberGate>> {
  const out = new Map<string, MemberGate>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return out;

  const [game, ranks, waivers] = await Promise.all([
    readGame(database, event.gameId),
    memberRanks(database, event.gameId, ids),
    readWaivers(database, event.id, ids),
  ]);
  const ladder = game?.rankLadder ?? [];

  for (const userId of ids) {
    const rank = ranks.get(userId) ?? null;
    const waived = waivedRulesFrom(waivers.filter((row) => row.userId === userId));
    out.set(userId, {
      rank,
      waived,
      eligibility: eligibility(event, { rank }, ladder, waived),
    });
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

/**
 * The answers to every **linked** question on these applications, read from the
 * profile — which is where they live (R-11, Task 10).
 *
 * A question with a `profile_field_id` is the event saying "ask them their
 * profile detail". Its answer is therefore the profile's answer, and storing a
 * second copy of it on the application is the one thing this project does not
 * do: the domain model's rule is that nothing derived is stored
 * (docs/domain-model.md:335), and a copy of an answer is exactly that. It
 * would also be a copy that goes wrong — a member who fixes
 * their rank on `/me/profile` would be sitting in a manager's applicant list
 * under the rank they typed in March, with no way for either of them to tell
 * which number was being used to seed the draft.
 *
 * So the composition happens here, on every read, and `ApplicationView.answers`
 * stays the complete map every caller already expects: the admin applicant list
 * (UC-14 2), the questions tab's answer counts, and the member's own form.
 *
 * Returned raw, without re-parsing against the question. A profile answer that
 * no longer fits the question it is shown under is a real state (an admin
 * retyped one of them, and R-09 keeps the answer either way), and the place
 * that reports it is `detailAttention` — on the member's own page, where
 * somebody can actually fix it. Dropping it here would hide it from everybody
 * instead.
 *
 * **`questionIds` comes back with the answers, from the same rows.** Which
 * questions are linked is one derivation — `profile_field_id is not null`, the
 * rule `ownQuestions` states — and `decorate` needs the set as well as the
 * values, to drop a legacy stored copy. Asking the same table a second time for
 * the same answer is how two reads of one rule start disagreeing, so the one
 * query that already has the rows hands both halves over.
 */
type LinkedReads = {
  /** Question ids on these applications' events whose answer is the profile's. */
  questionIds: Set<string>;
  /** The composed answers, by application id. */
  answers: Map<string, ApplicationAnswers>;
  /**
   * When the member last vouched for each of those answers — ISO, by
   * application id then question id, absent for an answer never confirmed
   * (R-49 / UC-12 3). A string rather than a `Date` because it is read in a
   * client component, the choice `ApplyDay.startsAt` already made.
   */
  confirmedAt: Map<string, Record<string, string>>;
};

async function linkedAnswers(
  database: Database,
  rows: readonly Application[]
): Promise<LinkedReads> {
  const out: LinkedReads = {
    questionIds: new Set<string>(),
    answers: new Map<string, ApplicationAnswers>(),
    confirmedAt: new Map<string, Record<string, string>>(),
  };
  if (rows.length === 0) return out;

  const eventIds = [...new Set(rows.map((row) => row.eventId))];
  const userIds = [...new Set(rows.map((row) => row.userId))];

  const linked = (
    await database
      .select()
      .from(eventQuestions)
      .where(inArray(eventQuestions.eventId, eventIds))
  ).filter((question) => question.profileFieldId !== null);
  for (const question of linked) out.questionIds.add(question.id);
  if (linked.length === 0) return out;

  const values = await database
    .select()
    .from(profileValues)
    .where(
      and(
        inArray(profileValues.userId, userIds),
        inArray(
          profileValues.fieldId,
          linked.map((question) => question.profileFieldId as string)
        )
      )
    );
  const byMemberField = new Map(values.map((row) => [`${row.userId}:${row.fieldId}`, row]));

  for (const row of rows) {
    const composed: ApplicationAnswers = {};
    const stamps: Record<string, string> = {};
    for (const question of linked) {
      if (question.eventId !== row.eventId) continue;
      const stored = byMemberField.get(`${row.userId}:${question.profileFieldId as string}`);
      if (stored === undefined) continue;
      composed[question.id] = stored.value;
      if (stored.confirmedAt) stamps[question.id] = stored.confirmedAt.toISOString();
    }
    if (Object.keys(composed).length > 0) out.answers.set(row.id, composed);
    if (Object.keys(stamps).length > 0) out.confirmedAt.set(row.id, stamps);
  }
  return out;
}

async function decorate(
  database: Database,
  rows: readonly Application[]
): Promise<ApplicationView[]> {
  const [extras, linked] = await Promise.all([
    readExtras(
      database,
      rows.map((row) => row.id)
    ),
    linkedAnswers(database, rows),
  ]);

  return rows.map((row) => {
    /*
     * A stored copy under a linked question's id is a legacy row: written
     * before the profile became the only home for these answers, or by an
     * `applyToEvent` that predates this commit. It is dropped from the view
     * rather than merged, because the profile is the source and a copy that
     * disagrees with it must not be what a manager reads. The next write to
     * the application removes it from the column too; no migration goes
     * hunting for them, because an unread key in a jsonb blob costs nothing
     * and a data migration over every application ever stored is not free.
     */
    const own: ApplicationAnswers = {};
    for (const [questionId, value] of Object.entries(row.answers)) {
      if (!linked.questionIds.has(questionId)) own[questionId] = value;
    }

    return {
      ...row,
      answers: { ...own, ...(linked.answers.get(row.id) ?? {}) },
      answerConfirmedAt: linked.confirmedAt.get(row.id) ?? {},
      availability: extras.availability.get(row.id) ?? {},
      confirmation: extras.confirmation.get(row.id) ?? null,
    };
  });
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
 * Callers pass `ownQuestions(...)`, not the whole set. A question linked to a
 * profile field is answered on the profile and composed back on read
 * (`linkedAnswers`), so an answer to one arriving here would be the second copy
 * Task 10 exists to remove — and because the list this validates against is
 * also the list of keys it will accept, a payload naming a linked question is
 * refused rather than stored.
 */
export function validateAnswers(
  questions: readonly EventQuestion[],
  ladder: readonly string[],
  raw: Record<string, unknown>
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
    const supplied = Object.hasOwn(raw, question.id) ? raw[question.id] : null;
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

/**
 * The questions this event asks **in its own right** — the unlinked ones.
 *
 * A linked question is the event asking for a profile detail, which the
 * application form now shows as a profile detail (UC-12 2) and writes to the
 * profile. So it is not asked twice, not answered on the application, and not
 * stored there. This is the one place that decides which questions are which,
 * so the form, the write and the to-dos cannot disagree about it.
 */
function ownQuestions(questions: readonly EventQuestion[]): EventQuestion[] {
  return questions.filter((question) => question.profileFieldId === null);
}

/* ------------------------------------------------------------------ */
/* The profile details an application asks about (R-11, R-49)          */
/* ------------------------------------------------------------------ */

/** One profile detail as this event's application asks it. */
type AskedDetail = {
  field: ProfileField;
  /** The ladder a `rank` detail picks from: the game's, or none for a global one. */
  ladder: readonly string[];
  /** Required by the catalogue, or by a linked question of this event. */
  required: boolean;
};

/**
 * Which profile details this event's application shows, and which it insists on.
 *
 * The global details plus the event's game's, minus the retired ones (R-09,
 * UC-03 5a) — the same set `loadProfileForGame` renders, assembled here because
 * the write has to decide requiredness from the database rather than from
 * whatever the page thought it was showing.
 *
 * A retired detail is dropped **before** requiredness is considered, so a
 * required detail that an admin retires stops blocking applications
 * immediately. The alternative is an event nobody can apply to, asking for
 * something the form does not have a row for.
 */
async function askedDetails(
  database: Database,
  event: { gameId: string | null },
  questions: readonly EventQuestion[]
): Promise<AskedDetail[]> {
  const game = await readGame(database, event.gameId);

  const fields = (
    await database
      .select()
      .from(profileFields)
      .where(
        game
          ? or(eq(profileFields.gameId, game.id), isNull(profileFields.gameId))
          : isNull(profileFields.gameId)
      )
      .orderBy(asc(profileFields.sort), asc(profileFields.createdAt))
  ).filter((field) => field.retiredAt === null);

  const demanded = detailsRequiredBy(questions);

  return fields.map((field) => ({
    field,
    ladder: field.gameId === null ? [] : (game?.rankLadder ?? []),
    required: field.required || demanded.has(field.id),
  }));
}

/** Profile field ids this event requires on top of what the catalogue does. */
function detailsRequiredBy(questions: readonly EventQuestion[]): Set<string> {
  return new Set(
    questions
      .filter((question) => question.required && question.profileFieldId !== null)
      .map((question) => question.profileFieldId as string)
  );
}

/** A checked detail patch: what would be written, and what the result would be. */
type DetailPlan = {
  /** Every detail the patch names, parsed. Blanks included, as `null`. */
  parsed: Array<{ detail: AskedDetail; value: ProfileValue }>;
  /** Ids the member vouched for without changing. */
  confirm: string[];
  /** What the member's answers would be afterwards, keyed by detail id. */
  values: Map<string, ProfileValue>;
};

type DetailCheck =
  | { ok: true; plan: DetailPlan }
  | { ok: false; errors: Record<string, string> };

/**
 * Check a detail patch and work out what it leaves behind — **without writing**.
 *
 * Split from the write for one reason, and it is the reason the whole ordering
 * of `applyToEvent` is the way it is: a refusal must leave nothing behind. If
 * the required-detail check ran after the write, an application refused for a
 * missing detail would still have committed the member's other edits inside the
 * same transaction that said no. So everything that can refuse happens first,
 * over a picture of what the write *would* do, and `commitDetails` runs only
 * once nothing is left to refuse.
 *
 * `values` is the stored answers with the patch laid over them, which is what
 * the required check has to see: a member who answered a detail months ago and
 * did not send it this time has answered it.
 *
 * **The profile is the destination, not a copy of one.** UC-12 3a says the
 * member edits a detail in place and "System saves them to their profile too";
 * read with Task 10's own title — *profile stays the source* — and with the
 * domain model's rule that nothing derived is stored
 * (docs/domain-model.md:335), "too" cannot mean a second copy on the
 * application. There is one answer and it is in `profile_values`; everything
 * else composes it on read (`linkedAnswers`).
 *
 * Mirrors `saveProfileSection` deliberately — same parse function, same
 * all-or-nothing, same "blank means delete the row" — because two ways to write
 * one answer is how the two of them drift. What is different is only that this
 * one spans the global section and the game's at once, which is what the
 * application shows, and that it refuses nothing for being incomplete: the
 * required check is the caller's, so it can be reported next to the seat and
 * the questions rather than per section.
 *
 * `confirm` carries the ids the member said are still right without touching —
 * R-49's whole sentence. They are stamped, not written: see `commitDetails`.
 *
 * Every id in either argument is checked against `asked`. An unknown one is an
 * error rather than a silent drop, the same judgement `validateAnswers` and
 * `saveProfileSection` make: a payload naming a detail this event does not ask
 * about is a stale page or a forgery, and both deserve to be told.
 */
async function checkDetails(
  database: Database,
  userId: string,
  asked: readonly AskedDetail[],
  patch: Record<string, unknown>,
  confirm: readonly string[]
): Promise<DetailCheck> {
  const byId = new Map(asked.map((detail) => [detail.field.id, detail]));
  const errors: Record<string, string> = {};
  const parsed: Array<{ detail: AskedDetail; value: ProfileValue }> = [];

  for (const id of Object.keys(patch)) {
    const detail = byId.get(id);
    if (!detail) {
      errors[id] = "That detail is not one this event asks about.";
      continue;
    }
    const result = parseProfileValue(
      {
        type: detail.field.type,
        label: detail.field.label,
        options: detail.field.options,
        rankLadder: detail.ladder,
      },
      patch[id]
    );
    if (!result.ok) errors[id] = result.error;
    else parsed.push({ detail, value: result.value });
  }

  for (const id of confirm) {
    if (!byId.has(id)) errors[id] = "That detail is not one this event asks about.";
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const stored = await database
    .select()
    .from(profileValues)
    .where(eq(profileValues.userId, userId));
  const values = new Map<string, ProfileValue>();
  for (const detail of asked) {
    const row = stored.find((candidate) => candidate.fieldId === detail.field.id);
    values.set(detail.field.id, row?.value ?? null);
  }
  for (const { detail, value } of parsed) values.set(detail.field.id, value);

  return { ok: true, plan: { parsed, confirm: [...new Set(confirm)], values } };
}

/** Does this value count as "cleared"? `[]` and `null` are both yes. */
function blankValue(value: ProfileValue): boolean {
  return value === null || (Array.isArray(value) && value.length === 0);
}

/**
 * Apply a checked plan to `profile_values`.
 *
 * A cleared answer is **deleted** rather than stored as null, exactly as
 * `saveProfileSection` does it, so "never answered" and "answered, then
 * cleared" stay the same state and the table does not fill with tombstones.
 *
 * Answers the member changed get `updated_at` *and* `confirmed_at`: saving an
 * answer is asserting it. Answers they only vouched for get `confirmed_at`
 * alone, which is the whole reason the column exists — see the docblock on
 * `profile_values.confirmed_at`.
 *
 * ## The stamp, and the two things it will not do
 *
 * **It never creates a row.** The `update` touches rows that exist and nothing
 * else: confirming is a statement about an answer, an unanswered detail has
 * nothing to vouch for, and a row invented to hold the stamp would have to
 * invent a `value` for a `not null` column too. A `confirm` id with no answer
 * behind it is simply not stamped.
 *
 * **It never moves `updated_at`.** That is the distinction the column exists
 * for: afterwards `confirmed_at > updated_at` says "given in March, re-checked
 * today", which is what a manager reading an applicant's details wants to know.
 *
 * Authorised on the rows it writes: the `where` carries `userId` as well as the
 * field ids, so a forged id either matches an answer of theirs or matches
 * nothing. A retired detail cannot get here at all — `askedDetails` drops it
 * before `checkDetails`, which then refuses the id outright (R-09, UC-03 5a).
 */
async function commitDetails(
  database: Database,
  userId: string,
  plan: DetailPlan,
  now: Date
): Promise<void> {
  const clearing = plan.parsed
    .filter(({ value }) => blankValue(value))
    .map(({ detail }) => detail.field.id);

  if (clearing.length > 0) {
    await database
      .delete(profileValues)
      .where(and(eq(profileValues.userId, userId), inArray(profileValues.fieldId, clearing)));
  }

  for (const { detail, value } of plan.parsed) {
    if (blankValue(value)) continue;
    await database
      .insert(profileValues)
      .values({ userId, fieldId: detail.field.id, value, updatedAt: now, confirmedAt: now })
      .onConflictDoUpdate({
        target: [profileValues.userId, profileValues.fieldId],
        set: { value, updatedAt: now, confirmedAt: now },
      });
  }

  // A detail they cleared in the same submission is not also one they vouched
  // for; there is no row left to stamp, and stamping before the delete would
  // only have written a confirmation of nothing.
  const toStamp = plan.confirm.filter((id) => !clearing.includes(id));
  if (toStamp.length > 0) {
    await database
      .update(profileValues)
      .set({ confirmedAt: now })
      .where(and(eq(profileValues.userId, userId), inArray(profileValues.fieldId, toStamp)));
  }
}

/**
 * Required details with nothing in them, keyed by detail id (UC-12 2b).
 *
 * The hard gate the profile deliberately does not have. The approved amendment
 * to UC-04 4a puts it exactly here: the profile saves partially so a member can
 * fill it in over time, and the application is what refuses to go through
 * without the thing they skipped — which is the only point at which the missing
 * answer costs anybody anything.
 *
 * Keyed by `profile_fields.id` so the form can mark the row the member is
 * looking at, not a sentence at the bottom.
 */
function missingRequiredDetails(
  asked: readonly AskedDetail[],
  values: ReadonlyMap<string, ProfileValue>
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const detail of asked) {
    if (!detail.required) continue;
    if (hasAnswer(values.get(detail.field.id) ?? null)) continue;
    errors[detail.field.id] = "This one is required.";
  }
  return errors;
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

/**
 * The event's own fields.
 *
 * **No `startsAt` or `endsAt`.** When an event runs is its days' answer
 * (R-24) — `eventDates` derives it on every read — so there is nothing here to
 * set and nothing to accidentally set to something the days disagree with. A
 * caller that wants to move an event moves its days (`setEventDays`).
 */
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
  /**
   * The status the caller saw. When given and the event has moved on since,
   * the whole edit is refused rather than applied to a page that is stale.
   */
  from?: EventStatus;
};

/** The refusal when the status changed between reading the event and writing it. */
const STATUS_CHANGED = "The event changed meanwhile - reload.";

/**
 * One place to check the things a title and a calendar can get wrong
 * (UC-08 10, 10c).
 *
 * `startsAt` is not a field here — it is *context*: the event's first day
 * (`eventDates`), which the sign-up window has to fit inside (R-25). Every
 * sentence comes from `events-policy.ts`, so the admin checklist, the write and
 * the preview cannot disagree about what is wrong with a setup.
 *
 * Capacity is not checked here either; `capacityProblem` is called by the
 * callers that *write* a capacity, so an event carrying a one-seat cap from
 * before R-26's minimum existed can still be published, cancelled, completed
 * and edited — which is why `saveBasicsAction` leaves an unchanged cap out of
 * its patch rather than echoing the one the panel rendered. See
 * `MIN_CAPACITY`.
 */
function validateFields(
  next: {
    signupOpensAt: Date | null;
    signupClosesAt: Date | null;
    startsAt: Date | null;
    minRankToEnter: string | null;
    minRankToCaptain: string | null;
  },
  game: Game | null
): string | null {
  const window = signupWindowProblem(next, next.startsAt);
  if (window) return window;

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

  const days = input.days ?? [];
  const capacity = input.capacity ?? null;
  const next = {
    capacity,
    signupOpensAt: input.signupOpensAt ?? null,
    signupClosesAt: input.signupClosesAt ?? null,
    minRankToEnter: cleanNullable(input.minRankToEnter, 60),
    minRankToCaptain: cleanNullable(input.minRankToCaptain, 60),
  };

  /*
   * Every refusal before the insert, including the day list's — UC-08 10c says
   * *nothing saved*, and the days are written by `setEventDays` after the event
   * row exists, so a day problem found down there would leave an event behind
   * that the caller was told had not been created. The same rules run again in
   * `setEventDays`, which is the one that has to be right for an edit; this is
   * the create path refusing early rather than trusting it.
   */
  const problem =
    capacityProblem(capacity) ??
    dayListProblem(next, days) ??
    validateFields({ ...next, startsAt: dayStart(days) }, game);
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
      // Provenance only — nothing reads it to decide anything. The template is
      // still copied and then forgotten; this is what lets `/admin/templates`
      // say how many events a template has produced.
      createdFromTemplateId: template?.id ?? null,
      createdBy: input.createdBy ?? null,
      ...next,
    })
    .returning();

  if (template && template.questions.length > 0) {
    const resolved = await resolveTemplateQuestions(database, template.questions, gameId);
    const written = await setEventQuestions(created.id, resolved, database);
    if (!written.ok) return fail(written.error, written.errors);
  }

  if (days.length > 0) {
    const written = await setEventDays(created.id, days, database);
    if (!written.ok) return fail(written.error, written.errors);
    return withData(withDates(created, written.data.days));
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
 * Why this event may not be published yet, as one sentence, or null when it
 * may. Reads the days, since a day with a start time is one of the
 * requirements (UC-09 2a); the event's own fields come from the caller, who may
 * be about to change them in the same write.
 */
async function publishRefusal(
  database: Database,
  eventId: string,
  event: Omit<PublishView, "days">,
  days?: readonly EventDay[]
): Promise<string | null> {
  const missing = missingToPublish({
    ...event,
    days: days ? [...days] : await readDays(database, eventId),
  });
  if (missing.length === 0) return null;
  const needs = missing.map((requirement) => PUBLISH_REQUIREMENT_TEXT[requirement]);
  const list =
    needs.length === 1 ? needs[0] : `${needs.slice(0, -1).join(", ")} and ${needs.at(-1)}`;
  return `This event cannot be published yet. It still needs ${list}.`;
}

/**
 * Edit an event. Only the keys present in `patch` change.
 *
 * Status moves through here too, guarded by `canTransition` — an event cannot
 * jump from `draft` to `live` without ever having been published, because then
 * applications would have been impossible right up until they were too late.
 * Moving to `published` this way is publishing, so it meets the same
 * requirements `publishEvent` does. Sending the status the event already has
 * is not a move and is not refused.
 *
 * Only the columns in `patch` are written, plus `updatedAt`, so an edit never
 * puts back a value somebody else changed after this one read the row. A move
 * is written only if the row still holds the status it was checked against, so
 * two managers moving the same event at once cannot both win.
 */
export async function updateEvent(
  eventId: string,
  patch: UpdateEventInput,
  database: Database = defaultDb
): Promise<EventResult<EventRow>> {
  const current = await readEvent(database, eventId);
  if (!current) return fail("That event no longer exists.");
  if (patch.from !== undefined && patch.from !== current.status) return fail(STATUS_CHANGED);

  const moveTo = patch.status && patch.status !== current.status ? patch.status : null;
  if (moveTo && !canTransition(current.status, moveTo)) {
    return fail(`An event cannot go from ${current.status} to ${patch.status}.`);
  }

  // A finished event takes one write: the reopen, on its own (UC-09 6a). An
  // edit riding along with it is still an edit to a finished event.
  const reopening =
    moveTo === "live" && Object.keys(patch).every((key) => key === "status" || key === "from");
  const locked = reopening ? null : lockRefusal(current);
  if (locked) return fail(locked);

  const gameId = patch.gameId !== undefined ? (patch.gameId ?? null) : current.gameId;
  const game = await readGame(database, gameId);
  if (gameId && !game) return fail("That game no longer exists.");

  const pick = <K extends keyof EventRow>(key: K, fallback: EventRow[K]): EventRow[K] =>
    key in patch ? ((patch as Record<string, unknown>)[key] as EventRow[K]) : fallback;

  const next = {
    capacity: (pick("capacity", current.capacity) ?? null) as number | null,
    signupOpensAt: (pick("signupOpensAt", current.signupOpensAt) ?? null) as Date | null,
    signupClosesAt: (pick("signupClosesAt", current.signupClosesAt) ?? null) as Date | null,
    minRankToEnter:
      "minRankToEnter" in patch
        ? cleanNullable(patch.minRankToEnter, 60)
        : current.minRankToEnter,
    minRankToCaptain:
      "minRankToCaptain" in patch
        ? cleanNullable(patch.minRankToCaptain, 60)
        : current.minRankToCaptain,
  };

  // The days are the event's calendar (R-24), so they are read here: the
  // sign-up window is checked against the first one, and `publishRefusal`
  // wants the same list rather than reading it again.
  const days = await readDays(database, eventId);
  const dates = eventDates(days);

  // Only a save that is actually writing a capacity is held to R-26's minimum
  // — see `MIN_CAPACITY` for why a legacy one-seat event must still be
  // editable in every other respect.
  if ("capacity" in patch) {
    const problem = capacityProblem(next.capacity);
    if (problem) return fail(problem);
  }

  const problem = validateFields({ ...next, startsAt: dates.startsAt }, game);
  if (problem) return fail(problem);

  let title = current.title;
  if ("title" in patch) {
    title = cleanText(patch.title, TITLE_MAX);
    if (!title) return fail("Give the event a title.");
  }

  if (moveTo === "published") {
    const refusal = await publishRefusal(database, eventId, { title, ...next }, days);
    if (refusal) return fail(refusal);
  }

  let slug = current.slug;
  if ("slug" in patch && patch.slug !== undefined) {
    const wanted = slugify(patch.slug);
    if (!wanted) return fail("That slug has no letters or numbers in it.");
    slug = wanted === current.slug ? current.slug : await freeSlug(database, wanted, wanted, eventId);
  }

  const changes: Partial<typeof events.$inferInsert> = { updatedAt: new Date() };
  if (moveTo) changes.status = moveTo;
  if ("title" in patch) changes.title = title;
  if ("slug" in patch && patch.slug !== undefined) changes.slug = slug;
  if (patch.gameId !== undefined) changes.gameId = gameId;
  if ("type" in patch) changes.type = cleanText(patch.type, 40) || current.type;
  if ("description" in patch) {
    changes.description = cleanNullable(patch.description, DESCRIPTION_MAX);
  }
  if ("bannerUrl" in patch) changes.bannerUrl = cleanNullable(patch.bannerUrl, 500);
  if ("config" in patch) changes.config = { ...current.config, ...(patch.config ?? {}) };
  for (const key of Object.keys(next) as Array<keyof typeof next>) {
    if (key in patch) Object.assign(changes, { [key]: next[key] });
  }

  // A move lands only on the status it was checked against. An edit lands on
  // any status but a locked one: the event may have been finished since this
  // call read it, and the lock above only saw the status as it was then.
  const [updated] = await database
    .update(events)
    .set(changes)
    .where(
      and(
        eq(events.id, eventId),
        moveTo
          ? eq(events.status, current.status)
          : notInArray(events.status, [...LOCKED_STATUSES])
      )
    )
    .returning();

  if (!updated) return fail(STATUS_CHANGED);
  return withData(withKnownDates(updated, dates));
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
  const days = await readDays(database, eventId);
  if (current.status === "published") return withData(withDates(current, days));

  if (!canTransition(current.status, "published")) {
    return fail(`A ${current.status} event cannot be published.`);
  }
  const refusal = await publishRefusal(database, eventId, current, days);
  if (refusal) return fail(refusal);

  const [updated] = await database
    .update(events)
    .set({ status: "published", updatedAt: new Date() })
    .where(and(eq(events.id, eventId), eq(events.status, current.status)))
    .returning();

  if (!updated) return fail(STATUS_CHANGED);
  return withData(withDates(updated, days));
}

/* ------------------------------------------------------------------ */
/* Days                                                               */
/* ------------------------------------------------------------------ */

export type EventDaysImpact = {
  /** The days this list drops, as they stand today, so they can be named. */
  removed: Array<{
    id: string;
    dayIndex: number;
    label: string | null;
    startsAt: Date | null;
  }>;
  /** Availability answers stored against them — what the write would clear. */
  clearedAvailability: number;
  /** How many applicants lose at least one of those answers. */
  affectedApplicants: number;
  /** Days that survive but change position, so a reorder can be described. */
  moved: Array<{ id: string; from: number; to: number }>;
  /** Why `setEventDays` would refuse this list. Null when it would go through. */
  problem: string | null;
};

/**
 * When a day list says the event starts, before any of it is written.
 *
 * The one place an *unwritten* list is reduced to the event's start (R-24), so
 * `createEvent` validating a new event's sign-up window and
 * {@link dayListProblem} validating an edited day list are asking `eventDates`
 * the same question in the same words.
 */
function dayStart(days: readonly EventDayInput[]): Date | null {
  return eventDates(days.map((day) => ({ startsAt: day.startsAt ?? null }))).startsAt;
}

/**
 * Why this day list cannot be written, or null when it can (UC-08 4, 10c).
 *
 * The one list of refusals {@link previewEventDays} and {@link setEventDays}
 * share, so a preview that says a save would go through is a save that goes
 * through. Each rule is `events-policy.ts`'s, each with its own sentence:
 *
 *  - more than four days (§10, `MAX_EVENT_DAYS`);
 *  - days out of order, or two of them starting at once (`daySequenceProblem`);
 *  - a first day that starts before sign-ups close (`signupWindowProblem`).
 *
 * That last one is the sign-up window rule arriving from the other direction:
 * `updateEvent` refuses a closing time past the first day, and this refuses a
 * first day pulled back behind the closing time. Writing the days and leaving
 * the window impossible would be the same broken pair, saved by the other
 * door.
 */
function dayListProblem(
  event: Pick<EventRow, "signupOpensAt" | "signupClosesAt">,
  days: readonly EventDayInput[]
): string | null {
  if (days.length > MAX_EVENT_DAYS) {
    return `An event runs over at most ${MAX_EVENT_DAYS} days.`;
  }

  const views: DayView[] = days.map((day) => ({
    startsAt: day.startsAt ?? null,
    label: day.label ?? null,
  }));

  return daySequenceProblem(views) ?? signupWindowProblem(event, dayStart(days));
}

/**
 * What writing this day list would cost, without writing it.
 *
 * `setEventDays` reports `clearedAvailability` in its *result*, which is the
 * honest number but arrives one moment too late to put on a confirm dialog —
 * by the time it is readable the answers are already gone. This is the same
 * question asked beforehand, and it is deliberately the twin of
 * `previewFieldEdit` in `admin-games.ts`: same shape of answer, same purpose,
 * same standing rule from checklist.md that nothing is destructive without the
 * number being said out loud first.
 *
 * Note what does *not* cost anything: reordering days whose ids are passed back
 * keeps every row, so `moved` is reported separately from `removed` and carries
 * no loss. A "reorder" only destroys availability when the caller drops the ids
 * and sends new days, which this function then reports as what it is — a delete
 * and an insert.
 *
 * Validation mirrors `setEventDays` exactly, so a preview that reports a
 * `problem` is a write that would have been refused.
 */
export async function previewEventDays(
  eventId: string,
  days: readonly EventDayInput[],
  database: Database = defaultDb
): Promise<EventDaysImpact> {
  const nothing = {
    removed: [],
    clearedAvailability: 0,
    affectedApplicants: 0,
    moved: [],
  } satisfies Omit<EventDaysImpact, "problem">;

  const event = await readEvent(database, eventId);
  if (!event) return { ...nothing, problem: "That event no longer exists." };

  const refusal = dayListProblem(event, days);
  if (refusal) return { ...nothing, problem: refusal };

  const existing = await readDays(database, eventId);
  const existingIds = new Set(existing.map((day) => day.id));
  for (const day of days) {
    if (day.id && !existingIds.has(day.id)) {
      return { ...nothing, problem: "One of those days belongs to a different event." };
    }
  }

  const keeping = new Set(days.map((day) => day.id).filter((id): id is string => Boolean(id)));
  const doomed = existing.filter((day) => !keeping.has(day.id));

  const byId = new Map(existing.map((day) => [day.id, day]));
  const moved = days.flatMap((day, index) => {
    const current = day.id ? byId.get(day.id) : undefined;
    if (!current || current.dayIndex === index) return [];
    return [{ id: current.id, from: current.dayIndex, to: index }];
  });

  if (doomed.length === 0) return { ...nothing, moved, problem: null };

  const rows = await database
    .select({ applicationId: availability.applicationId })
    .from(availability)
    .where(
      inArray(
        availability.eventDayId,
        doomed.map((day) => day.id)
      )
    );

  return {
    removed: doomed.map((day) => ({
      id: day.id,
      dayIndex: day.dayIndex,
      label: day.label,
      startsAt: day.startsAt,
    })),
    clearedAvailability: rows.length,
    affectedApplicants: new Set(rows.map((row) => row.applicationId)).size,
    moved,
    problem: null,
  };
}

/**
 * Replace an event's days with this list, in this order.
 *
 * Days keep their identity when their id is passed back, which is what stops a
 * reorder throwing away everyone's availability. A day that is *not* in the
 * list is deleted, and its availability answers go with it — so the count comes
 * back in the result, the same way `/admin/games` says how many answers a
 * delete would destroy before it destroys them. {@link previewEventDays} asks
 * the same question early enough to put on a confirm dialog.
 */
export async function setEventDays(
  eventId: string,
  days: readonly EventDayInput[],
  database: Database = defaultDb
): Promise<
  EventResult<{ days: EventDay[]; clearedAvailability: number; changed: boolean }>
> {
  const event = await readEvent(database, eventId);
  if (!event) return fail("That event no longer exists.");
  const locked = lockRefusal(event);
  if (locked) return fail(locked);

  const refusal = dayListProblem(event, days);
  if (refusal) return fail(refusal);

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

  const written = await readDays(database, eventId);
  /*
   * Whether this save moved anything, for the caller deciding whether there is
   * any news to send (R-98, UC-08 10b). A manager who opens the Days tab and
   * presses Save has not changed the dates, and an applicant told the event
   * "has changed" would go and look for what moved.
   */
  const changed =
    written.length !== existing.length ||
    written.some((day, index) => {
      const before = existing[index];
      return (
        before === undefined ||
        before.id !== day.id ||
        (before.startsAt?.getTime() ?? null) !== (day.startsAt?.getTime() ?? null) ||
        before.label !== day.label
      );
    });

  return withData({ days: written, clearedAvailability, changed });
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
): Promise<
  EventResult<{ questions: EventQuestion[]; clearedAnswers: number; changed: boolean }>
> {
  const event = await readEvent(database, eventId);
  if (!event) return fail("That event no longer exists.");
  const locked = lockRefusal(event);
  if (locked) return fail(locked);
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

  /*
   * Whether the form anybody has already answered is actually different
   * (R-99, UC-08 10b). A manager who opens the Questions tab and saves it back
   * unchanged has given applicants nothing to re-check, and "the questions have
   * changed" sends them looking for a change that is not there.
   *
   * Compared on what an applicant would notice — the wording, the type, the
   * options, whether it is required, the order, and which question it is —
   * rather than on the row wholesale: `key` is regenerated from the label on
   * every save and is not something anybody reads.
   */
  const shapeFor = (question: EventQuestion): string =>
    JSON.stringify([
      question.id,
      question.label,
      question.type,
      question.required,
      question.sort,
      question.profileFieldId,
      question.options.map((option) => [option.value, option.label]),
    ]);
  const changed =
    written.length !== existing.length ||
    written.some((question, index) => shapeFor(question) !== shapeFor(existing[index]));

  return withData({ questions: written, clearedAnswers, changed });
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
/* Waiving an entry rule (R-59 / UC-14 3b)                            */
/* ------------------------------------------------------------------ */

/** A waiver with the names the admin screens and the audit line want. */
export type EntryWaiverView = EntryWaiverRow & {
  member: { id: string; displayName: string | null; handle: string | null };
  /** The manager's name as it reads now; null once their account is gone. */
  grantedByName: string | null;
};

/** Name rows for a waiver list, in one query per role. */
async function decorateWaivers(
  database: Database,
  rows: readonly EntryWaiverRow[]
): Promise<EntryWaiverView[]> {
  if (rows.length === 0) return [];
  const ids = [
    ...new Set([
      ...rows.map((row) => row.userId),
      ...rows.map((row) => row.waivedBy).filter((id): id is string => id !== null),
    ]),
  ];
  const people = await database
    .select({
      id: users.id,
      displayName: users.displayName,
      name: users.name,
      handle: users.handle,
    })
    .from(users)
    .where(inArray(users.id, ids));
  const byId = new Map(people.map((person) => [person.id, person]));

  return rows.map((row) => {
    const member = byId.get(row.userId);
    const granter = row.waivedBy ? byId.get(row.waivedBy) : undefined;
    return {
      ...row,
      member: {
        id: row.userId,
        displayName: member?.displayName ?? member?.name ?? null,
        handle: member?.handle ?? null,
      },
      grantedByName: granter?.displayName ?? granter?.name ?? null,
    };
  });
}

/** Every waiver on one event, newest first — the admin panel's read. */
export async function listEntryWaivers(
  eventId: string,
  database: Database = defaultDb
): Promise<EntryWaiverView[]> {
  const rows = await readWaivers(database, eventId);
  const views = await decorateWaivers(database, rows);
  return views.sort((a, b) => b.waivedAt.getTime() - a.waivedAt.getTime());
}

/**
 * One member by their public handle — `/players/[handle]`.
 *
 * The lookup behind "waive it for somebody who cannot apply yet". A manager
 * letting a filler in (R-59's "so that a filler can play") knows who they mean
 * and can read the handle off that person's profile or ask them for it; what
 * they do not have is a list of every member on the site, and an admin screen
 * that handed a *host* one would be a disclosure this feature has no need to
 * make. A handle is already public — it is in the URL of a profile page.
 *
 * Returns null rather than failing: the caller turns it into the sentence.
 */
export async function findMemberByHandle(
  handle: string,
  database: Database = defaultDb
): Promise<{ id: string; displayName: string | null; handle: string | null } | null> {
  // "@beko", " beko " and "Beko" are all the same member: handles are minted
  // lower-case by `handleBase`, and the leading @ is how Discord writes one.
  const wanted = handle.trim().replace(/^@+/, "").toLowerCase();
  if (!wanted) return null;

  const [row] = await database
    .select({ id: users.id, displayName: users.displayName, name: users.name, handle: users.handle })
    .from(users)
    .where(eq(users.handle, wanted))
    .limit(1);
  return row
    ? { id: row.id, displayName: row.displayName ?? row.name ?? null, handle: row.handle }
    : null;
}

/**
 * Let one member past one of this event's rank rules (R-59 / UC-14 3b).
 *
 * ## Why this takes an event and a member and nothing else
 *
 * The row it writes *is* (event, member, rule), so the caller's authorisation —
 * `requireEventManager(eventId)` in the action — is a check on the row being
 * written rather than on an id beside it, which is the rule `event-scope.ts`
 * sets out. There is deliberately no "waive by waiver id" and no "waive by
 * application id": either would make the event a second, unverified argument,
 * and a host of event A holding a waiver id from event B would be exactly the
 * escalation that file exists to describe.
 *
 * ## Why it can be granted before an application exists
 *
 * Because it has to be. `applyToEvent` refuses a below-rank member before
 * anything is stored, so for the `enter` rule there is no application to attach
 * the decision to at the moment it is needed — the Gate-2 amendment to UC-12 2a
 * and UC-14 3b in docs/plan.md. Nothing here reads `applications`.
 *
 * ## Granting twice is granting once
 *
 * The unique constraint makes a repeat grant the same decision, and the
 * conflict is a no-op rather than a refresh: the *first* manager to decide is
 * the one the row should name, and overwriting `waived_by` on a second click
 * would rewrite who made a decision that was already made. The existing row
 * comes back, so a caller cannot tell the difference and a double-submitted
 * form does not produce an error anybody has to read.
 *
 * `created` is how a caller tells the two apart anyway — and it is **Postgres'
 * answer, not a guess from a read beforehand**. `onConflictDoNothing()
 * .returning()` hands back the inserted row or nothing at all, decided inside
 * the one statement, so two managers clicking at the same moment get one `true`
 * and one `false` however their reads interleaved. The action layer logs on
 * `created`, which is what keeps one decision to one audit line (the mirror of
 * `removed` in {@link revokeEntryWaiver}).
 *
 * A finished event refuses this like every other write (UC-09 6b): a waiver
 * changes who could have played in it, and the record of a finished event is
 * closed until somebody reopens it.
 */
export async function waiveEntryRule(
  eventId: string,
  userId: string,
  rule: EntryRule,
  options: { by?: string | null; now?: Date } = {},
  database: Database = defaultDb
): Promise<EventResult<EntryWaiverView & { created: boolean }>> {
  const event = await readEvent(database, eventId);
  if (!event) return fail("That event no longer exists.");
  const locked = lockRefusal(event);
  if (locked) return fail(locked);

  const [member] = await database
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!member) return fail("We do not have an account for that member.");

  const inserted = await database
    .insert(entryWaivers)
    .values({ eventId, userId, rule, waivedBy: options.by ?? null, waivedAt: options.now })
    .onConflictDoNothing({
      target: [entryWaivers.eventId, entryWaivers.userId, entryWaivers.rule],
    })
    .returning({ id: entryWaivers.id });
  const created = inserted.length > 0;

  // Re-read rather than returning what was inserted: on the repeat the insert
  // comes back empty, and the row that is *there* — the first manager's — is
  // the answer. `created` above is the one thing the read cannot tell us.
  const [row] = await database
    .select()
    .from(entryWaivers)
    .where(
      and(
        eq(entryWaivers.eventId, eventId),
        eq(entryWaivers.userId, userId),
        eq(entryWaivers.rule, rule)
      )
    )
    .limit(1);
  if (!row) return fail("That waiver could not be recorded. Nothing was changed.");

  const [view] = await decorateWaivers(database, [row]);
  return withData({ ...view, created });
}

/**
 * Withdraw a waiver (and with it the decision it recorded).
 *
 * Keyed on (event, member, rule) and never on the waiver's own id, for the
 * reason set out above and one more besides: a delete by id authorised against
 * a browser-supplied event would let a host of event A withdraw event B's
 * waiver. With the event in the `where` clause the worst a wrong id can do is
 * match nothing.
 *
 * `removed` is false when there was nothing to withdraw, which is not an error
 * — two managers clicking the same button is not a failure anybody should read
 * a message about.
 */
export async function revokeEntryWaiver(
  eventId: string,
  userId: string,
  rule: EntryRule,
  database: Database = defaultDb
): Promise<EventResult<{ removed: boolean }>> {
  const event = await readEvent(database, eventId);
  if (!event) return fail("That event no longer exists.");
  const locked = lockRefusal(event);
  if (locked) return fail(locked);

  const gone = await database
    .delete(entryWaivers)
    .where(
      and(
        eq(entryWaivers.eventId, eventId),
        eq(entryWaivers.userId, userId),
        eq(entryWaivers.rule, rule)
      )
    )
    .returning({ id: entryWaivers.id });

  return withData({ removed: gone.length > 0 });
}

/* ------------------------------------------------------------------ */
/* Applying                                                           */
/* ------------------------------------------------------------------ */

export type ApplyInput = {
  /**
   * Keyed by `event_questions.id`, for the event's **own** questions.
   *
   * A question linked to a profile field is not answered here and never was
   * meant to be: its answer is the member's profile answer, and it arrives in
   * `details`. A key naming a linked question is refused rather than stored, so
   * a stale page cannot write a second copy of an answer by accident.
   */
  answers?: Record<string, unknown>;
  /**
   * The member's profile details, keyed by `profile_fields.id` (UC-12 3a).
   * Written to the profile, which is where they live (R-11).
   */
  details?: Record<string, unknown>;
  /**
   * Detail ids the member said are still right without changing them
   * (UC-12 3, R-49). Stamped, not written.
   */
  confirmed?: readonly string[];
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
 *     gate, an unanswered required question, a missing required profile detail,
 *     a second application;
 *  4. *then* decide pending, accepted or waitlisted, and write.
 *
 * Steps 2 and 4 being inside the same lock is the entire point. Split them and
 * two people take the last seat, which is the kind of bug that surfaces once,
 * on the busiest event of the year, and cannot be reproduced afterwards.
 *
 * Every refusal happens before every write, including the profile writes — so
 * an application refused for a missing detail has not quietly saved the member's
 * other edits on its way out. That is why the detail handling is split into
 * `checkDetails` and `commitDetails`.
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
    const row = await lockEvent(tx, eventId);
    if (!row) return fail("That event no longer exists.");
    const locked = lockRefusal(row);
    if (locked) return fail(locked);

    // Read inside the lock, like everything else here: whether the event has
    // already started is one of the reasons to refuse (`applicationsOpen`), and
    // that answer is its first day's (R-24).
    const days = await readDays(tx, eventId);
    const event = withDates(row, days);

    const [member] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!member) return fail("We do not have an account for you.");

    const game = await readGame(tx, event.gameId);
    const ladder = game?.rankLadder ?? [];

    const existing = await readApplications(tx, eventId);
    const mine = existing.find((row) => row.userId === userId) ?? null;

    if (
      mine &&
      (mine.status === "pending" || mine.status === "accepted" || mine.status === "waitlisted")
    ) {
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
    // UC-12 2a: below the bar *and* nobody has waived it. The waivers are read
    // inside the same lock as everything else, so a waiver granted while this
    // application was being filled in is either seen by it or lands after it,
    // never half-seen.
    const waived = waivedRulesFrom(await readWaivers(tx, eventId, [userId]));
    const gate = eligibility(event, { rank }, ladder, waived);
    if (!gate.canEnter) return fail(gate.enterReason);

    const questions = await readQuestions(tx, eventId);
    // Only the event's own questions are answered on the application. A linked
    // question's answer is the profile's and arrives in `input.details`; see
    // `linkedAnswers` for why there is no second copy of it here.
    const checked = validateAnswers(ownQuestions(questions), ladder, input.answers ?? {});
    if (!checked.ok) {
      return fail("Some of those answers need another look.", checked.errors);
    }

    // UC-12 2, 2b, 3a: the profile details this event asks about, checked before
    // anything is written so a refusal leaves nothing behind.
    const asked = await askedDetails(tx, event, questions);
    const details = await checkDetails(
      tx,
      userId,
      asked,
      input.details ?? {},
      input.confirmed ?? []
    );
    if (!details.ok) {
      return fail("Some of those details need another look.", details.errors);
    }
    const missing = missingRequiredDetails(asked, details.plan.values);
    if (Object.keys(missing).length > 0) {
      return fail("This event needs a few details from your profile first.", missing);
    }

    const dayIds = new Set(days.map((day) => day.id));
    for (const dayId of Object.keys(input.availability ?? {})) {
      if (!dayIds.has(dayId)) return fail("That day is not part of this event.");
    }

    await commitDetails(tx, userId, details.plan, now);

    // UC-12 7b: an approval event stores the application for a manager to decide.
    const status: ApplicationStatus =
      entryMode(event.config) === "approval"
        ? "pending"
        : state.willWaitlist
          ? "waitlisted"
          : "accepted";
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

/**
 * **The one rule for a seat that frees.** Every caller that can free one goes
 * through here, and none of them promotes on its own.
 *
 * There are four ways a seat comes free and they are the same event wearing
 * four hats:
 *
 *  - the applicant withdraws (UC-13 3a, R-54);
 *  - the applicant says they are not coming (UC-13 5a);
 *  - a manager declines somebody who held a seat (UC-14 5-6, R-58);
 *  - a manager puts somebody who held a seat back on the queue (UC-14 5-6).
 *
 * docs/diagrams/application-state.md states it once for all four: *leaving
 * `Accepted` frees a seat; the earliest `Waitlisted` becomes `Accepted` in the
 * same change, and is notified* (R-55). Four copies of that sentence in four
 * call sites is four chances for one of them to drift, which is what this
 * function exists to prevent.
 *
 * ## Why the read is in here and not in the caller
 *
 * The caller has already read the applications — that is how it knew what it
 * was changing — and passing that array in would be free. It would also be
 * wrong. Those rows were read *before* the caller's own write landed, so the
 * row that just stopped holding a seat still looks accepted in them, and a
 * promotion computed from them fills a seat that is not free and skips the seat
 * that is. So this re-reads inside the same transaction, after the write, and
 * decides from what the database now says.
 *
 * That the transaction is holding the event's row lock (`lockEvent`) is the
 * other half of it, and it is the caller's job: two seats freeing at once must
 * queue behind each other, or both promotions are computed from the same
 * pre-promotion queue and the same person is promoted twice while the next one
 * is never promoted at all. `src/lib/__tests__/events.test.ts` sequences that
 * interleave deliberately rather than racing for it.
 *
 * Nothing is promoted when the change did not actually free a seat: a manager
 * queueing a `pending` applicant in an approval event has taken nothing away,
 * and an event with spare seats and a queue the manager built by hand is not an
 * invitation to empty that queue. The renumbering runs either way, because any
 * change to the set can leave a hole in it (`renumberWaitlist`).
 *
 * ## The row that vacated is not a candidate for its own seat
 *
 * `vacated.id` is left out of the arithmetic, and it has to be. A manager
 * putting the only seated applicant back on the queue (UC-14 5-6) frees a seat
 * and creates a queue of one — themselves — so a promotion computed over
 * everybody would hand the seat straight back and quietly undo the decision.
 * On an uncapped event it is worse: `promoteFromWaitlist` promotes the whole
 * queue there by design, so the manager's decision would not survive the same
 * transaction that made it. Dropping the row keeps the seat count right (it is
 * not accepted any more either way) and asks the only question that matters:
 * who *else* is waiting.
 */
async function freeSeat(
  database: Database,
  event: { id: string; capacity: number | null },
  vacated: { id: string; from: ApplicationStatus; to: ApplicationStatus }
): Promise<Application[]> {
  const gaveUpASeat = vacated.from === "accepted" && vacated.to !== "accepted";

  let promoted: Application[] = [];
  if (gaveUpASeat) {
    const rows = await readApplications(database, event.id);
    const others = rows.filter((row) => row.id !== vacated.id);
    const promotion = promoteFromWaitlist(others, event.capacity);
    if (promotion.promoted.length > 0) {
      promoted = await database
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

  await renumberWaitlist(database, event.id);
  return promoted;
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

/* ------------------------------------------------------------------ */
/* Changing an answer while sign-ups are open (R-53 / UC-13 3, 4, 4a)  */
/* ------------------------------------------------------------------ */

/**
 * May an applicant still change their answers? (R-53, UC-13 3 / 4a.)
 *
 * The sign-up **window**, not the sign-up **offer**. `applicationsOpen` answers
 * a different question — whether a *new* application would be taken — and it
 * closes on `full` for an event that has switched its waitlist off (R-170,
 * UC-12 E3). Reusing it here would stop everybody already in that event from
 * fixing a typo, for a reason that has nothing to do with them: there is no
 * seat for a *new* applicant, and they are not one. So `full` is the one closed
 * reason that still counts as open here, and every other one does not:
 * `signups_closed` and `event_started` are the cut-off UC-13 4a describes,
 * `cancelled` and `finished` have nothing left to answer, and `not_published`
 * cannot have an application behind it.
 *
 * ## This is not the attendance deadline, and must never share a guard with it
 *
 * R-200 closes the "still coming?" answer two days before the start
 * (`confirmationsOpen`); this closes the *answers* when sign-ups close. Two
 * deadlines, two different instants, two different things being shut. And
 * **neither of them governs withdrawing** — R-54, UC-13 4a and UC-13
 * extensions E3 all say so in the same words: *withdrawing is still allowed*.
 * The reason it is acceptable to lock anything at all is that the way out stays
 * open; somebody taken ill the day before an event still gives up their seat,
 * and the seat is what everybody else is waiting for. So
 * `withdrawApplication` below consults neither this function nor
 * `confirmationsOpen`, and a refactor that gave it one of them would be the
 * bug this whole paragraph exists to prevent.
 */
export function answersEditable(state: ApplicationsState): boolean {
  return state.open || state.reason === "full";
}

/** The refusal UC-13 4a asks for — and it names the thing that still works. */
const ANSWERS_CLOSED =
  "Sign-ups for this event have closed, so your answers stand. You can still withdraw if you cannot make it.";

export type EditAnswersInput = {
  /**
   * The event's own questions, keyed by `event_questions.id` — **the whole
   * answer set, not a patch.**
   *
   * `applications.answers` is replaced with what `validateAnswers` makes of
   * this map, so a question left out of it ends up with no stored answer. That
   * is deliberate rather than tolerated: an answer is cleared by sending it
   * empty, `validateAnswers` drops an empty answer from the set it returns, and
   * a merge could therefore never clear one — a member who wants their optional
   * note gone would have no way to say so. One rule for both directions costs
   * callers a complete payload, which `ApplyForm` sends (every question, `null`
   * where there is no answer), and gives the member a way back out of every
   * answer they can give.
   *
   * A required question is still refused when it is missing, so the set cannot
   * be emptied past what the event insists on.
   */
  answers?: Record<string, unknown>;
  /** Profile details, keyed by `profile_fields.id` (UC-12 3a). */
  details?: Record<string, unknown>;
  /** Detail ids vouched for without being changed (R-49). */
  confirmed?: readonly string[];
  /** Keyed by `event_days.id`; `null` clears a day. */
  availability?: Record<string, AvailabilityState | null>;
  now?: Date;
};

/**
 * Change an open application's answers (R-53 / UC-13 3, 4).
 *
 * The refusals, in the order they are made and for the reason each is made:
 *
 *  1. **the event is locked** — complete, cancelled or archived. UC-13 3b
 *     refuses *every* change to a finished event, and `lockRefusal` is the one
 *     rule for that across the whole module.
 *  2. **not their application, or not an open one.** Found by `(event, user)`
 *     inside the transaction, so there is no application id in the signature to
 *     point at somebody else's row — the rule this codebase states as
 *     "authorise on the row you are about to write, never on an id beside it".
 *     A withdrawn or declined application has no answers to change.
 *  3. **sign-ups have closed** (UC-13 4a) — `answersEditable`, checked here and
 *     not only on the page. A server action is a public POST endpoint: a form
 *     the page stopped rendering is a form anybody can still submit, and this
 *     is the only place that can actually say no. Nothing is written when it
 *     does, including the profile details, which is why they are checked before
 *     they are committed.
 *
 * No seat moves. Changing an answer is not a decision about a seat: the status,
 * the queue position and the submission time are all left exactly as they were,
 * so a member who fixes their rank does not lose their place — and
 * `submittedAt` in particular stays put, because it *is* the queue order (§14)
 * and touching it would quietly send them to the back.
 *
 * The event's row lock is taken all the same. Availability and the answer set
 * are read by the same admin screens that read the seat counts, and a write
 * that does not queue behind the lock is a write that can interleave with a
 * promotion.
 */
export async function editApplicationAnswers(
  eventId: string,
  userId: string,
  input: EditAnswersInput = {},
  database: Database = defaultDb
): Promise<EventResult<ApplicationView>> {
  const now = input.now ?? new Date();

  return database.transaction(async (tx) => {
    const row = await lockEvent(tx, eventId);
    if (!row) return fail("That event no longer exists.");
    const locked = lockRefusal(row);
    if (locked) return fail(locked);

    const days = await readDays(tx, eventId);
    const event = withDates(row, days);

    const existing = await readApplications(tx, eventId);
    const mine = existing.find((candidate) => candidate.userId === userId) ?? null;
    if (!mine) return fail("You have not applied to this event.");
    if (mine.status === "withdrawn" || mine.status === "declined") {
      return fail("That application is not open, so there is nothing to change.");
    }

    const seats = capacityState(event, existing);
    const state = applicationsOpen(event, now, {
      accepted: seats.accepted,
      waitlisted: seats.waitlisted,
    });
    if (!answersEditable(state)) return fail(ANSWERS_CLOSED);

    const game = await readGame(tx, event.gameId);
    const ladder = game?.rankLadder ?? [];

    const questions = await readQuestions(tx, eventId);
    const checked = validateAnswers(ownQuestions(questions), ladder, input.answers ?? {});
    if (!checked.ok) {
      return fail("Some of those answers need another look.", checked.errors);
    }

    const asked = await askedDetails(tx, event, questions);
    const details = await checkDetails(
      tx,
      userId,
      asked,
      input.details ?? {},
      input.confirmed ?? []
    );
    if (!details.ok) {
      return fail("Some of those details need another look.", details.errors);
    }
    const missing = missingRequiredDetails(asked, details.plan.values);
    if (Object.keys(missing).length > 0) {
      return fail("This event needs a few details from your profile first.", missing);
    }

    const dayIds = new Set(days.map((day) => day.id));
    for (const dayId of Object.keys(input.availability ?? {})) {
      if (!dayIds.has(dayId)) return fail("That day is not part of this event.");
    }

    await commitDetails(tx, userId, details.plan, now);
    await tx
      .update(applications)
      .set({ answers: checked.answers })
      .where(eq(applications.id, mine.id));
    await writeAvailability(tx, mine.id, input.availability ?? {}, dayIds);

    const [fresh] = await tx.select().from(applications).where(eq(applications.id, mine.id));
    return withData(await decorateOne(tx, fresh));
  });
}

/**
 * Withdraw, and let the next person in (UC-13 3a, R-54).
 *
 * The promotion is not this function's rule: it is `freeSeat`'s, the same one
 * a decline and a "not coming" go through. All this decides is that a
 * withdrawal is a departure, and then it says so.
 *
 * **Sign-ups closing does not close this** (UC-13 4a, UC-13 extensions E3), and
 * neither does the attendance deadline (R-200). There is deliberately no call
 * to `answersEditable` or `confirmationsOpen` in this function: a member who
 * can no longer change a word of their application can still give the seat up,
 * which is the one thing that still matters to the queue behind them. The only
 * thing that stops a withdrawal is the event itself being over (`lockRefusal`).
 *
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
    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    const rows = await readApplications(tx, eventId);
    const mine = rows.find((row) => row.userId === userId);
    if (!mine) return fail("You have not applied to this event.");

    if (mine.status === "withdrawn") {
      return withData({ application: await decorateOne(tx, mine), promoted: [] });
    }

    await tx
      .update(applications)
      .set({ status: "withdrawn", waitlistPosition: null, decidedAt: new Date() })
      .where(eq(applications.id, mine.id));

    const promoted = await freeSeat(tx, event, {
      id: mine.id,
      from: mine.status,
      to: "withdrawn",
    });

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
   * The manager has been shown the cap and has asked again anyway (UC-14 3a).
   * Only an accept that would go past the cap reads this; nothing else does,
   * and it never raises the cap.
   */
  confirmOverCapacity?: boolean;
};

/**
 * An admin decision on one application (UC-14 3-6, R-58).
 *
 * This is §8.3's override, so the *rank* gates are deliberately not enforced
 * here: an admin can accept somebody the threshold would have turned away.
 * Gates are guidance, not a wall.
 *
 * The seat cap is the one exception, and it is not a wall either — it is a
 * question. UC-14 3a: accepting past the cap asks the manager to confirm, and
 * the cap itself does not change. The question is asked **here**, in the write,
 * rather than in the screen that usually asks it: a server action is a public
 * POST endpoint, so a confirmation that lives in a dialog is a confirmation
 * anybody can skip by calling the action directly. The first call is refused
 * with `confirm`; the second, carrying `confirmOverCapacity`, goes through.
 *
 * Every decision that takes a seat away goes through `freeSeat`, the same rule
 * a withdrawal and a "not coming" use. There is no `promote` option any more
 * and there must not be one: UC-14 6 says the seat a decline frees goes to the
 * next waitlisted, and an option to skip that is an option to leave a seat
 * empty with somebody queueing for it.
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
  // Pending is where an application arrives, never where a manager sends one
  // (docs/diagrams/application-state.md has no edge into it).
  if (status === "pending") return fail("An application cannot be put back to pending review.");

  return database.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);
    if (!current) return fail("That application no longer exists.");

    const event = await lockEvent(tx, current.eventId);
    if (!event) return fail("That event no longer exists.");
    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    const rows = await readApplications(tx, current.eventId);
    const others = rows.filter((row) => row.id !== current.id);

    /*
     * UC-14 3a, inside the lock. `others` is what the room holds without this
     * application in it, read after `lockEvent`, so the count cannot have moved
     * between the question and the answer: a manager who confirms going over a
     * cap that somebody has meanwhile freed a seat in is simply let through,
     * and one who was told there was room that has since gone is asked.
     */
    const before = capacityState(event, others);
    const takesASeat = status === "accepted" && current.status !== "accepted";
    if (
      takesASeat &&
      before.capacity !== null &&
      before.accepted >= before.capacity &&
      !options.confirmOverCapacity
    ) {
      return needsConfirming(
        `This event's cap is ${before.capacity} and ${before.accepted} are already in. Accepting anyway puts it over the cap — confirm to go ahead.`,
        { kind: "over_capacity", capacity: before.capacity, accepted: before.accepted }
      );
    }

    const waitlistPosition =
      status === "waitlisted" ? nextWaitlistPosition(others) : null;

    await tx
      .update(applications)
      .set({
        status,
        waitlistPosition,
        decidedAt: now,
        decidedBy: options.decidedBy ?? null,
        note: options.note === undefined ? current.note : cleanNullable(options.note, NOTE_MAX),
      })
      .where(eq(applications.id, applicationId));

    const promoted = await freeSeat(tx, event, {
      id: current.id,
      from: current.status,
      to: status,
    });

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
 * Write the admin's note on an application, and nothing else.
 *
 * This is not `setApplicationStatus(id, current.status, { note })` with the
 * status left alone, and the difference matters: that call recomputes
 * `waitlistPosition` from `nextWaitlistPosition`, so re-affirming `waitlisted`
 * on the person at the front of the queue sends them to the back of it. Adding
 * "said they might be late" to somebody's row must not cost them their place,
 * so the note gets its own write that touches one column.
 */
export async function setApplicationNote(
  applicationId: string,
  note: string | null,
  database: Database = defaultDb
): Promise<EventResult<ApplicationView>> {
  return database.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);
    if (!current) return fail("That application no longer exists.");
    const event = await lockEvent(tx, current.eventId);
    if (!event) return fail("That event no longer exists.");
    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    const [updated] = await tx
      .update(applications)
      .set({ note: cleanNullable(note, NOTE_MAX) })
      .where(eq(applications.id, applicationId))
      .returning();

    return withData(await decorateOne(tx, updated));
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
  return database.transaction(async (tx) => {
    const [application] = await tx
      .select()
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);
    if (!application) return fail("That application no longer exists.");
    const event = await lockEvent(tx, application.eventId);
    if (!event) return fail("That event no longer exists.");
    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    const days = await readDays(tx, application.eventId);
    const dayIds = new Set(days.map((day) => day.id));
    for (const dayId of Object.keys(byDay)) {
      if (!dayIds.has(dayId)) return fail("That day is not part of this event.");
    }

    await writeAvailability(tx, applicationId, byDay, dayIds);

    const view = await decorateOne(tx, application);
    return withData(view.availability);
  });
}

/** What the "still coming?" answer did — including, for "out", who it let in. */
export type ConfirmationOutcome = {
  state: ConfirmationState;
  confirmedAt: Date;
  /** Where the application stands afterwards: `withdrawn` when a seat was given up. */
  status: ApplicationStatus;
  /** Whoever the freed seat promoted, so the caller can notify them (R-55). */
  promoted: ApplicationView[];
  /**
   * When this answer stops being changeable (R-200, UC-13 7), or null for an
   * event with no start date. Derived from the event here so the caller never
   * has a second opinion about it.
   */
  closesAt: Date | null;
};

/**
 * The "still coming?" answer (R-56, UC-13 5-6) — and, for "not coming", the
 * seat it frees (UC-13 5a).
 *
 * Only somebody with a live application can answer it: confirming attendance
 * for an application that was declined or withdrawn is not a state worth
 * storing, and letting it through would put the wrong people in the count the
 * admin uses to decide whether the event can run.
 *
 * ## "I can't make it", from somebody holding a seat, is a departure
 *
 * It used to be a note for the admin, and the seat stayed held. UC-13 5a is
 * explicit that it frees the seat, promoting exactly as a withdrawal does, and
 * docs/diagrams/application-state.md draws the two as one edge:
 * *Accepted → Withdrawn: applicant withdraws or says "not coming"*. A seat held
 * by somebody who has said they are not coming is a seat nobody can have, with
 * a queue waiting for it — which is the situation R-55 exists to end.
 *
 * From the **queue** it is not a departure and does not become one. A
 * waitlisted member answering "I can't make it" has no seat to give up, the
 * diagram has no such edge, and dropping them out of the queue over one tap
 * would cost them a place they could still want.
 *
 * ## "Not sure yet" is not a departure either, and must never become one
 *
 * R-199 / UC-13 5b. `maybe` is recorded and nothing else happens: the seat
 * stays, `freeSeat` is not called, nobody is promoted. That is the whole
 * point of the answer — an uncertain seat is still a held seat, and what to
 * do about it is the admin's decision (UC-13 extensions E4), not a rule that
 * fires while nobody is looking. The condition below names `"out"`
 * explicitly rather than testing `state !== "in"`, which would have swept
 * `maybe` straight into the withdrawal path the day it was added.
 *
 * ## The answer closes two days before the start
 *
 * R-200, UC-13 7, enforced here rather than only on the card. A server action
 * is a public POST endpoint, so a deadline that lives in the UI is a deadline
 * anybody can answer past by calling the action directly — the same argument
 * that puts UC-14 3a's over-cap question in `setApplicationStatus`. The
 * refusal names withdrawing, because withdrawing is deliberately *not* closed
 * (R-54): the reason it is acceptable to lock the answer at all is that the
 * way out stays open.
 *
 * An event with no start date has no deadline and stays answerable for ever
 * (UC-13 7a) — see `confirmationDeadline`.
 */
export async function setConfirmation(
  applicationId: string,
  state: ConfirmationState,
  options: { now?: Date } = {},
  database: Database = defaultDb
): Promise<EventResult<ConfirmationOutcome>> {
  const now = options.now ?? new Date();

  return database.transaction(async (tx) => {
    const [application] = await tx
      .select()
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);
    if (!application) return fail("That application no longer exists.");
    const row = await lockEvent(tx, application.eventId);
    if (!row) return fail("That event no longer exists.");
    const locked = lockRefusal(row);
    if (locked) return fail(locked);

    // The deadline is two days before the start, and the start is the first
    // day's (R-24) — so a manager who moves the first day has moved the
    // deadline, and this reads the days rather than a column that would still
    // be describing the old date (`confirmationDeadline`).
    const event = withDates(row, await readDays(tx, application.eventId));

    if (application.status === "declined" || application.status === "withdrawn") {
      return fail("That application is not active, so there is nothing to confirm.");
    }

    const closesAt = confirmationDeadline(event.startsAt);
    if (!confirmationsOpen(event.startsAt, now)) {
      return fail(
        "Answers closed two days before this event starts, so this one stands. You can still withdraw if you cannot make it."
      );
    }

    const confirmedAt = new Date();
    await tx
      .insert(confirmations)
      .values({ applicationId, state, confirmedAt })
      .onConflictDoUpdate({
        target: confirmations.applicationId,
        set: { state, confirmedAt },
      });

    // The same departure a withdrawal is, so the same rule fills the seat.
    // An answer that gives nothing up touches the queue not at all: neither
    // "I'll be there" nor "Not sure yet" may rewrite everybody's place in it,
    // and `maybe` in particular must never reach `freeSeat` (UC-13 5b).
    const givingUpASeat = state === "out" && application.status === "accepted";
    let promoted: Application[] = [];
    if (givingUpASeat) {
      await tx
        .update(applications)
        .set({ status: "withdrawn", waitlistPosition: null, decidedAt: confirmedAt })
        .where(eq(applications.id, applicationId));

      promoted = await freeSeat(tx, event, {
        id: applicationId,
        from: "accepted",
        to: "withdrawn",
      });
    }

    return withData({
      state,
      confirmedAt,
      status: givingUpASeat ? ("withdrawn" as ApplicationStatus) : application.status,
      promoted: await decorate(tx, promoted),
      closesAt,
    });
  });
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
 * Seat counts and dates come back grouped from Postgres rather than per event,
 * because twenty events would otherwise be twenty round trips — and on Neon
 * that is twenty HTTP requests.
 *
 * ## Soonest first, ordered here rather than in SQL
 *
 * The order is "what is coming up next" (R-40, R-41, UC-10 4), and that is the
 * first day's start — not a column, so `order by` cannot do it. It is sorted
 * after the dates are in hand, matching Postgres's own `asc` exactly so the
 * lists read as they always have: ascending by start, an event with no date
 * last rather than first (it is not coming up sooner than everything else —
 * nobody has said when it is), and the newest created first within a tie.
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
    .where(wanted ? inArray(events.status, wanted) : undefined);

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

  const dates = await readDatesFor(
    database,
    rows.map((event) => event.id)
  );
  const nowhere = { startsAt: null, endsAt: null } satisfies EventDates;

  const summaries = rows
    .map((event) =>
      summarise(
        withKnownDates(event, dates.get(event.id) ?? nowhere),
        byEvent.get(event.id) ?? [],
        now
      )
    )
    .sort((a, b) => {
      const left = a.startsAt?.getTime() ?? null;
      const right = b.startsAt?.getTime() ?? null;
      if (left !== right) {
        if (left === null) return 1;
        if (right === null) return -1;
        return left - right;
      }
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

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

/**
 * Every status, at zero — the shape a caller can index without checking, and
 * the fallback for an event `countApplicationsByStatus` left out of its map.
 */
export function emptyApplicationCounts(): Record<ApplicationStatus, number> {
  return { pending: 0, accepted: 0, waitlisted: 0, declined: 0, withdrawn: 0 };
}

/**
 * How many applications each of these events holds, split by status.
 *
 * `EventSummary.seats` answers "how full is it", which is the number a member
 * cares about. An admin list also wants "how many people applied at all",
 * including the ones who were declined or pulled out — and that is not
 * derivable from a `CapacityState`. One grouped query covers the whole list
 * rather than one per event, for the same reason `listEvents` groups its own.
 *
 * Events with no applications are absent from the map; callers should fall back
 * to a zeroed record.
 */
export async function countApplicationsByStatus(
  eventIds: readonly string[],
  database: Database = defaultDb
): Promise<Map<string, Record<ApplicationStatus, number>>> {
  const out = new Map<string, Record<ApplicationStatus, number>>();
  if (eventIds.length === 0) return out;

  const rows = await database
    .select({ eventId: applications.eventId, status: applications.status, total: count() })
    .from(applications)
    .where(inArray(applications.eventId, [...eventIds]))
    .groupBy(applications.eventId, applications.status);

  for (const row of rows) {
    const bag = out.get(row.eventId) ?? emptyApplicationCounts();
    bag[row.status] += Number(row.total);
    out.set(row.eventId, bag);
  }
  return out;
}

/**
 * One event as a list renders it.
 *
 * `event` is expected to carry its derived dates already (`withDates`), because
 * whether applications are open depends on whether the event has started
 * (`applicationsOpen`) and that is the first day's answer (R-24).
 */
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
    // The days are read here anyway, so this is where the event's own dates
    // come from (R-24): the page's countdown, its date range and its list of
    // days are then three readings of one answer (UC-11 2).
    ...summarise(withDates(event, days), rows, now),
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
/** Enough of an application to write a sentence about it. */
export type ApplicationLabel = {
  applicationId: string;
  eventId: string;
  eventTitle: string;
  eventSlug: string;
  userId: string;
  member: string;
  status: ApplicationStatus;
  waitlistPosition: number | null;
};

/**
 * One application, named — the member and the event, in one read.
 *
 * The audit log needs this and nothing else: a line saying "Accepted Beko Lolek
 * for the March Rivals Cup" has to be written *at the time*, because a summary
 * rebuilt on read from two ids is a summary that changes meaning when somebody
 * is renamed. Returns `null` for an application that has since gone.
 */
export async function describeApplication(
  applicationId: string,
  database: Database = defaultDb
): Promise<ApplicationLabel | null> {
  const [row] = await database
    .select({
      applicationId: applications.id,
      eventId: applications.eventId,
      eventTitle: events.title,
      eventSlug: events.slug,
      userId: applications.userId,
      displayName: users.displayName,
      name: users.name,
      status: applications.status,
      waitlistPosition: applications.waitlistPosition,
    })
    .from(applications)
    .innerJoin(events, eq(applications.eventId, events.id))
    .innerJoin(users, eq(applications.userId, users.id))
    .where(eq(applications.id, applicationId))
    .limit(1);

  if (!row) return null;
  return {
    applicationId: row.applicationId,
    eventId: row.eventId,
    eventTitle: row.eventTitle,
    eventSlug: row.eventSlug,
    userId: row.userId,
    member: row.displayName ?? row.name ?? "A member",
    status: row.status,
    waitlistPosition: row.waitlistPosition,
  };
}

export async function getApplicationsForEvent(
  eventId: string,
  database: Database = defaultDb
): Promise<ApplicantView[]> {
  const event = await readEvent(database, eventId);
  if (!event) return [];

  const rows = await readApplications(database, eventId);
  if (rows.length === 0) return [];

  const [views, members, gates] = await Promise.all([
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
    // One assembly of ladder + ranks + waivers, shared with the apply page and
    // with `setCaptains`, so the verdict this table shows is the verdict the
    // writes enforce (R-59 / UC-14 3b).
    gatesFor(
      database,
      event,
      rows.map((row) => row.userId)
    ),
  ]);

  const memberById = new Map(members.map((member) => [member.id, member]));
  const rank: Record<ApplicationStatus, number> = {
    accepted: 0,
    waitlisted: 1,
    pending: 2,
    declined: 3,
    withdrawn: 4,
  };

  return views
    .map((view): ApplicantView => {
      const gate = gates.get(view.userId);
      return {
        ...view,
        member: memberById.get(view.userId) ?? {
          id: view.userId,
          displayName: null,
          avatarUrl: null,
          discordId: null,
        },
        rank: gate?.rank ?? null,
        eligibility: gate?.eligibility ?? eligibility(event, { rank: null }, []),
        waived: gate?.waived ?? NO_WAIVERS,
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

/**
 * What each of these events still needs from this member (UC-13 2, R-60).
 *
 * Batched across every event in the list — four queries for the whole
 * dashboard, not four per card — because `/me` renders this for all of them and
 * a per-row read is how a dashboard becomes slow enough that somebody deletes
 * the to-dos rather than the query.
 *
 * Two kinds of question are checked, and they are deliberately the same two the
 * application form shows:
 *
 *  - the member's **profile details** for the event's game, plus the global
 *    ones (`where: "profile"`), answered from `profile_values`;
 *  - the event's **own** questions (`where: "event"`), answered from
 *    `applications.answers`. A linked question is not checked here: the profile
 *    detail behind it already is, and counting both would show one question
 *    twice under two labels.
 *
 * The verdict is `detailAttention`'s in both cases, which is what makes "the
 * question changed since you answered it" mean the same thing on this page, on
 * the profile and on the application. A **retired** detail answers `null` there
 * and so never reaches this list (R-09, UC-03 5a): an admin who stops asking a
 * question has stopped asking it everywhere, and a to-do pointing at a question
 * no form shows is a job nobody can finish.
 */
async function outstandingByEvent(
  database: Database,
  userId: string,
  eventRows: readonly EventRow[],
  answersFor: (eventId: string) => ApplicationAnswers
): Promise<Map<string, OutstandingAnswer[]>> {
  const out = new Map<string, OutstandingAnswer[]>();
  if (eventRows.length === 0) return out;

  const eventIds = eventRows.map((event) => event.id);
  const gameIds = [...new Set(eventRows.map((event) => event.gameId).filter((id) => id !== null))];

  const [questions, gameRows, fields, values] = await Promise.all([
    database.select().from(eventQuestions).where(inArray(eventQuestions.eventId, eventIds)),
    gameIds.length > 0
      ? database.select().from(games).where(inArray(games.id, gameIds))
      : Promise.resolve([] as Game[]),
    database
      .select()
      .from(profileFields)
      .where(
        gameIds.length > 0
          ? or(inArray(profileFields.gameId, gameIds), isNull(profileFields.gameId))
          : isNull(profileFields.gameId)
      )
      .orderBy(asc(profileFields.sort), asc(profileFields.createdAt)),
    database.select().from(profileValues).where(eq(profileValues.userId, userId)),
  ]);

  const ladderOf = new Map(gameRows.map((game) => [game.id, game.rankLadder]));
  const valueOf = new Map(values.map((row) => [row.fieldId, row.value]));

  for (const event of eventRows) {
    const mine = questions.filter((question) => question.eventId === event.id);
    const demanded = detailsRequiredBy(mine);
    const ladder = event.gameId === null ? [] : (ladderOf.get(event.gameId) ?? []);
    const answers = answersFor(event.id);
    const list: OutstandingAnswer[] = [];

    for (const field of fields) {
      if (field.gameId !== null && field.gameId !== event.gameId) continue;
      const why = detailAttention(
        {
          type: field.type,
          label: field.label,
          options: field.options,
          rankLadder: field.gameId === null ? [] : ladder,
          required: field.required || demanded.has(field.id),
          retiredAt: field.retiredAt,
        },
        valueOf.get(field.id) ?? null
      );
      if (why) list.push({ id: field.id, label: field.label, why, where: "profile" });
    }

    for (const question of ownQuestions(mine)) {
      const why = detailAttention(
        {
          type: question.type,
          label: question.label,
          options: question.options,
          rankLadder: ladder,
          required: question.required,
          // An event question cannot be retired — only deleted, which takes
          // it out of this list by taking it out of the event.
          retiredAt: null,
        },
        answers[question.id] ?? null
      );
      if (why) list.push({ id: question.id, label: question.label, why, where: "event" });
    }

    out.set(event.id, list);
  }

  return out;
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
  const [eventRows, views, counts, dates] = await Promise.all([
    database.select().from(events).where(inArray(events.id, eventIds)),
    decorate(database, rows),
    database
      .select({ eventId: applications.eventId, status: applications.status, total: count() })
      .from(applications)
      .where(inArray(applications.eventId, eventIds))
      .groupBy(applications.eventId, applications.status),
    readDatesFor(database, eventIds),
  ]);

  // Soonest first, and the member's cards count down to the start and show the
  // answer deadline (R-200) — all three are the first day's answer (R-24).
  const eventById = new Map(
    eventRows.map((event) => [
      event.id,
      withKnownDates(event, dates.get(event.id) ?? { startsAt: null, endsAt: null }),
    ])
  );
  const byEvent = new Map<string, Array<{ status: ApplicationStatus }>>();
  for (const row of counts) {
    const bag = byEvent.get(row.eventId) ?? [];
    for (let index = 0; index < Number(row.total); index += 1) bag.push({ status: row.status });
    byEvent.set(row.eventId, bag);
  }

  const answersByEvent = new Map(views.map((view) => [view.eventId, view.answers]));
  const outstanding = await outstandingByEvent(
    database,
    userId,
    [...eventById.values()],
    (eventId) => answersByEvent.get(eventId) ?? {}
  );

  return views
    .flatMap((view): MyApplicationView[] => {
      const event = eventById.get(view.eventId);
      if (!event) return [];
      return [
        {
          ...view,
          event,
          seats: capacityState(event, byEvent.get(event.id) ?? []),
          outstanding: outstanding.get(event.id) ?? [],
        },
      ];
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
 * applications and why not, whether this member clears the rank gate, their
 * whole profile for the event's game with every saved answer in it (UC-12 2),
 * and the event's own questions carrying the answers they already gave.
 *
 * The profile section is the reason the profile exists (§2, R-11): a returning
 * player checks that what is already on screen is still right, taps the days
 * they can make, and submits — no typing at all. And it is the *profile* they
 * are reading, not a copy of it taken when they applied, so the rank they
 * corrected on `/me/profile` last night is the rank this page shows.
 *
 * `canEditAnswers` is for an applicant who already has one: it says whether the
 * page should offer the form at all (R-53 / UC-13 4a). It is the same answer
 * `editApplicationAnswers` will reach, which is the point of computing it here
 * rather than letting the page compare dates.
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
  // UC-12 2: the gate is shown before the questions, so the page needs the same
  // answer the write will reach — ladder, recorded rank *and* waivers (UC-12 2a).
  const gate = userId
    ? (await gatesFor(database, event, [userId])).get(userId)
    : undefined;
  const rank = gate?.rank ?? null;

  const [mine] = userId
    ? await database
        .select()
        .from(applications)
        .where(and(eq(applications.eventId, eventId), eq(applications.userId, userId)))
        .limit(1)
    : [];

  const application = mine ? await decorateOne(database, mine) : null;

  // The event's own questions, each with whatever this member answered. The
  // linked ones are left out on purpose: the profile section below is where
  // they are asked, and asking the same thing twice on one page is how the two
  // answers end up disagreeing.
  const ownIds = new Set(ownQuestions(view.questions).map((question) => question.id));
  const questions = view.questions
    .filter((question) => ownIds.has(question.id))
    .map((question): AnsweredQuestionView => ({
      ...question,
      value: application?.answers[question.id] ?? null,
    }));

  const profile = await loadProfileForGame(
    userId,
    event.gameId,
    { alsoRequired: detailsRequiredBy(view.questions) },
    database
  );

  const live =
    application !== null &&
    (application.status === "pending" ||
      application.status === "accepted" ||
      application.status === "waitlisted");

  return {
    event: view,
    state: view.applicationsState,
    eligibility: gate?.eligibility ?? eligibility(event, { rank }, view.rankLadder),
    waived: gate?.waived ?? NO_WAIVERS,
    rank,
    profile,
    questions,
    canEditAnswers: live && answersEditable(view.applicationsState),
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
