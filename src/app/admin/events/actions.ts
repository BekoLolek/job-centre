"use server";

/**
 * The server actions behind `/admin/events` and `/admin/events/[id]`.
 *
 * Thin on purpose, exactly like `/admin/games`'s. Each one proves the caller is
 * an admin, hands its arguments to `src/lib/events.ts` — which owns every rule
 * and is tested against real Postgres — and revalidates the pages whose content
 * just changed. There is no business logic in this file and there must not be:
 * a second copy of "can this event be published" is a second copy that drifts.
 *
 * `requireAdmin()` runs inside every action rather than being trusted from the
 * page that rendered the button. A server action is a public endpoint; the
 * page's guard proves nothing about who is calling it five minutes later.
 *
 * ## Why times cross the boundary as strings
 *
 * A `datetime-local` input gives a naive string in the admin's own zone. The
 * browser is the only party that knows which zone that is, so the client turns
 * it into an absolute instant (`toInstant`) and these actions parse it back.
 * Passing a `Date` through the action boundary would work, but the string is
 * what the form actually holds and one conversion is easier to be sure of than
 * two.
 *
 * ## The audit log and the announcements live here, and only here
 *
 * Phase 5 adds two side effects to some of these actions. Both belong at this
 * layer and nowhere below it:
 *
 *  - `recordAudit` needs to know **who** is acting, and `requireAdmin()`'s
 *    return value is the only place that is known. `src/lib/events.ts` takes a
 *    `Database` and is called by tests and by seeds; an insert down there would
 *    log a phantom for every fixture and nothing for the person who clicked.
 *  - `announce*` is fire-and-forget by construction. It returns `void`, the
 *    work happens after the response, and a webhook that is down can therefore
 *    not fail the decision that triggered it — see `src/lib/discord.ts`.
 *
 * Both run only after the library has said `ok`. Nothing is logged that did not
 * happen, and nothing is announced that did not stick.
 */

import { revalidatePath } from "next/cache";
import {
  type ApplicationStatus,
  type AvailabilityState,
  type EntryMode,
  type EventStatus,
  eventStatus,
} from "@/db/schema";
import {
  type EventDayInput,
  type EventDaysImpact,
  type EventQuestionInput,
  type EventResult,
  createEvent,
  describeApplication,
  previewEventDays,
  publishEvent,
  setApplicationNote,
  setApplicationStatus,
  setAvailability,
  setEventDays,
  setEventQuestions,
  updateEvent,
} from "@/lib/events";
import type { ApplicationDecision } from "@/lib/events-policy";
import {
  type ChampionshipResult,
  type CountingEventFields,
  addCountingEvent,
  removeCountingEvent,
  setCountingEvent,
} from "@/lib/championships";
import { type PlacementEntry, setPlacements } from "@/lib/championship-results";
import { recordAudit } from "@/lib/audit";
import {
  notifyApplicationDecided,
  notifyEventCancelled,
  notifyEventPublished,
  notifyEventUpdated,
  notifyQuestionsChanged,
} from "@/lib/notify-events";
import { announceApplicationDecision, announceEventPublished } from "@/lib/discord";
import { isFieldType } from "@/lib/profile-fields";
import {
  eventIdOfApplication,
  eventIdOfMatch,
  eventIdOfStage,
} from "@/lib/event-scope";
import {
  requireAdmin,
  requireEventManager,
  requireManagerOfChild,
} from "@/lib/session-guards";
import { parseStamp } from "@/lib/time";

/* ------------------------------------------------------------------ */
/* Shared plumbing                                                    */
/* ------------------------------------------------------------------ */

/** Both admin screens, plus the hub — every edit here changes what is listed. */
function refresh(eventId?: string): void {
  revalidatePath("/admin/events");
  if (eventId) revalidatePath(`/admin/events/${eventId}`);
}

function fail<T>(error: string): EventResult<T> {
  return { ok: false, error };
}

/* ------------------------------------------------------------------ */
/* Creating                                                           */
/* ------------------------------------------------------------------ */

export type CreateEventFields = {
  title: string;
  /** Copy the config and questions off a template (§7, §8.1). */
  templateId?: string | null;
};

/**
 * Create an event. Title only, in practice — everything else is the editor's
 * job, which is why a new event is a draft and therefore invisible.
 */
export async function createEventAction(
  input: CreateEventFields
): Promise<EventResult<{ id: string; slug: string }>> {
  const admin = await requireAdmin();

  const result = await createEvent({
    title: input.title,
    templateId: input.templateId ?? undefined,
    createdBy: admin.id,
  });
  if (!result.ok) return result;

  await recordAudit({
    action: "event.created",
    actor: admin,
    eventId: result.data.id,
    summary: `Created "${result.data.title}".`,
    detail: { slug: result.data.slug, template: input.templateId ?? null },
  });

  refresh(result.data.id);
  return { ok: true, data: { id: result.data.id, slug: result.data.slug } };
}

/* ------------------------------------------------------------------ */
/* Basics                                                             */
/* ------------------------------------------------------------------ */

export type BasicsFields = {
  title: string;
  slug: string;
  type: string;
  description: string | null;
  bannerUrl: string | null;
  gameId: string | null;
  capacity: number | null;
  /** UC-08 6/6a. How applications land (R-27). */
  entryMode: EntryMode;
  /** UC-08 E6. False closes sign-ups once the seats are gone (R-170). */
  waitlist: boolean;
  /** ISO instants, or null for "no bound that side". */
  signupOpensAt: string | null;
  signupClosesAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
};

/**
 * Save the Basics panel of the Setup step.
 *
 * Note what is *not* here: status and the two rank thresholds. Each tab saves
 * itself, so Basics must not carry — and therefore cannot silently revert — a
 * value the admin last changed on a different tab.
 */
export async function saveBasicsAction(
  eventId: string,
  fields: BasicsFields
): Promise<EventResult<{ slug: string }>> {
  await requireEventManager(eventId);

  const result = await updateEvent(eventId, {
    title: fields.title,
    slug: fields.slug,
    type: fields.type,
    description: fields.description,
    bannerUrl: fields.bannerUrl,
    gameId: fields.gameId,
    capacity: fields.capacity,
    // Both arrive from the browser, so neither is stored as it was sent:
    // `updateEvent` merges this into the config it already has.
    config: {
      entryMode: fields.entryMode === "approval" ? "approval" : "first_come",
      waitlist: fields.waitlist !== false,
    },
    signupOpensAt: parseStamp(fields.signupOpensAt),
    signupClosesAt: parseStamp(fields.signupClosesAt),
    startsAt: parseStamp(fields.startsAt),
    endsAt: parseStamp(fields.endsAt),
  });
  if (!result.ok) return result;

  /*
   * Only for an event people have already applied to — `notifyEventUpdated`
   * asks for exactly that audience, so an admin still drafting one is not
   * announcing every keystroke to nobody. Collapsed to one a day, because
   * saving four times on Tuesday is one change of plan.
   */
  notifyEventUpdated(eventId);

  refresh(eventId);
  // The slug comes back because `freeSlug` may have disambiguated it, and an
  // admin who typed "rivals" deserves to be told they got "rivals-2".
  return { ok: true, data: { slug: result.data.slug } };
}

/* ------------------------------------------------------------------ */
/* Status                                                             */
/* ------------------------------------------------------------------ */

/**
 * Move the event along its lifecycle (UC-09). Illegal jumps, and publishing an
 * event that is not set up, are refused inside `updateEvent`; the screen only
 * ever offers the legal moves, so a rejection here means the page was stale or
 * the setup is incomplete.
 *
 * `from` is the status the control was rendered with. The move is written only
 * if the event still has it, so a stale page or a second manager acting at the
 * same moment is refused — and a refused move logs and notifies nothing.
 *
 * Reopening — `complete` back to `live` — gets its own audit line naming who
 * did it (UC-09 6a), because it is the one move that unlocks a finished record.
 */
export async function setEventStatusAction(
  eventId: string,
  from: EventStatus,
  status: EventStatus
): Promise<EventResult<{ status: EventStatus }>> {
  // Both arrive from the browser; anything that is not a status is refused
  // before it can reach a write, a log line or a notification.
  const statuses: readonly string[] = eventStatus.enumValues;
  if (!statuses.includes(from) || !statuses.includes(status)) {
    return fail("That is not an event status.");
  }
  const admin = await requireEventManager(eventId);
  if (from === status) return fail(`The event is already ${status}.`);

  const result = await updateEvent(eventId, { from, status });
  if (!result.ok) return result;

  const reopened = from === "complete" && status === "live";
  await recordAudit(
    reopened
      ? {
          action: "event.reopened",
          actor: admin,
          eventId,
          summary: `${admin.displayName ?? admin.name ?? "A manager"} reopened "${result.data.title}".`,
          detail: { from: "complete", status: "live" },
        }
      : {
          action: "event.status",
          actor: admin,
          eventId,
          summary: `Moved "${result.data.title}" to ${result.data.status}.`,
          detail: { status: result.data.status },
        }
  );

  // Reaching `published` from the status dropdown is the same event as reaching
  // it from the Publish tab, so it announces the same thing. Announcing from
  // one of the two paths is how a feature ends up looking unreliable.
  if (result.data.status === "published") {
    announceEventPublished(eventId);
    notifyEventPublished(eventId, admin.id);
  }
  if (result.data.status === "cancelled") notifyEventCancelled(eventId, admin.id);

  refresh(eventId);
  return { ok: true, data: { status: result.data.status } };
}

/** Publish: members can see it, and the signup window starts to mean something. */
export async function publishEventAction(
  eventId: string
): Promise<EventResult<{ status: EventStatus }>> {
  const admin = await requireEventManager(eventId);

  const result = await publishEvent(eventId);
  if (!result.ok) return result;

  await recordAudit({
    action: "event.published",
    actor: admin,
    eventId,
    summary: `Published "${result.data.title}".`,
    detail: { slug: result.data.slug },
  });

  announceEventPublished(eventId);
  notifyEventPublished(eventId, admin.id);

  refresh(eventId);
  return { ok: true, data: { status: result.data.status } };
}

/* ------------------------------------------------------------------ */
/* Days                                                               */
/* ------------------------------------------------------------------ */

export type DayFields = {
  /** Pass an existing day's id back to keep it — and its availability answers. */
  id?: string;
  /** ISO instant, or null while the time is still to be agreed. */
  startsAt: string | null;
  label: string | null;
};

function toDayInput(day: DayFields): EventDayInput {
  return {
    id: day.id,
    startsAt: parseStamp(day.startsAt),
    label: day.label,
  };
}

/**
 * What saving this day list would destroy — asked *before* the write.
 *
 * `setEventDays` reports the same number afterwards, which is too late for a
 * confirm dialog. Read-only.
 */
export async function previewEventDaysAction(
  eventId: string,
  days: DayFields[]
): Promise<EventDaysImpact> {
  await requireEventManager(eventId);
  return previewEventDays(eventId, days.map(toDayInput));
}

/**
 * Replace the event's days.
 *
 * The written rows come back **with their ids**, and the screen adopts them.
 * That is not a nicety: a day is kept rather than replaced only when its id is
 * passed back, so a tab still holding "three new days" after a successful save
 * would, on the next save, delete those three rows and insert three more —
 * taking every availability answer with them. Adopting the ids is what makes
 * the second save a no-op instead of a quiet massacre.
 */
export async function saveEventDaysAction(
  eventId: string,
  days: DayFields[]
): Promise<EventResult<{ clearedAvailability: number; days: DayFields[] }>> {
  const admin = await requireEventManager(eventId);

  const result = await setEventDays(eventId, days.map(toDayInput));
  if (!result.ok) return result;

  await recordAudit({
    action: "event.days",
    actor: admin,
    eventId,
    summary:
      result.data.clearedAvailability > 0
        ? `Rewrote the day list to ${result.data.days.length}, losing ${result.data.clearedAvailability} availability answers.`
        : `Rewrote the day list to ${result.data.days.length}.`,
    detail: {
      days: result.data.days.length,
      clearedAvailability: result.data.clearedAvailability,
    },
  });

  refresh(eventId);
  return {
    ok: true,
    data: {
      clearedAvailability: result.data.clearedAvailability,
      days: result.data.days.map((day) => ({
        id: day.id,
        startsAt: day.startsAt ? day.startsAt.toISOString() : null,
        label: day.label,
      })),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Questions                                                          */
/* ------------------------------------------------------------------ */

export type QuestionFields = {
  /** Pass an existing question's id back to keep it — and its answers. */
  id?: string;
  label: string;
  /** One of the six field types; anything else is refused here, not stored. */
  type: string;
  /** Plain labels, one per option. Ignored by the types that take no options. */
  options: string[];
  required: boolean;
  /** The profile field this question prefills from. Null asks it fresh. */
  profileFieldId: string | null;
};

/**
 * Replace the event's question set.
 *
 * `setEventQuestions` re-validates every stored answer afterwards and reports
 * how many no longer parse, which is what a retype from "pick one" to "number"
 * costs. The screen has already shown that number: this is the point of no
 * return, not the discovery.
 */
export async function saveEventQuestionsAction(
  eventId: string,
  questions: QuestionFields[]
): Promise<EventResult<{ clearedAnswers: number; questions: QuestionFields[] }>> {
  const admin = await requireEventManager(eventId);

  const cleaned: EventQuestionInput[] = [];
  for (const [index, question] of questions.entries()) {
    if (!isFieldType(question.type)) {
      return {
        ok: false,
        error: "One of those questions has a type that does not exist.",
        errors: { [question.id ?? `new-${index}`]: "Pick a question type." },
      };
    }
    cleaned.push({
      id: question.id,
      label: question.label,
      type: question.type,
      options: question.options,
      required: question.required,
      profileFieldId: question.profileFieldId,
    });
  }

  const result = await setEventQuestions(eventId, cleaned);
  if (!result.ok) return result;

  await recordAudit({
    action: "event.questions",
    actor: admin,
    eventId,
    summary:
      result.data.clearedAnswers > 0
        ? `Rewrote the application form to ${result.data.questions.length} questions, losing ${result.data.clearedAnswers} answers.`
        : `Rewrote the application form to ${result.data.questions.length} questions.`,
    detail: {
      questions: result.data.questions.length,
      clearedAnswers: result.data.clearedAnswers,
    },
  });

  /*
   * Told only to people who have already answered. For anybody else there is
   * nothing to check — they will simply see today's questions when they apply.
   */
  notifyQuestionsChanged(eventId, admin.id);

  refresh(eventId);
  // With their ids, for the same reason the days come back with theirs: a
  // question is kept rather than replaced only when its id is passed back, and
  // replacing it drops every answer to it.
  return {
    ok: true,
    data: {
      clearedAnswers: result.data.clearedAnswers,
      questions: result.data.questions.map((question) => ({
        id: question.id,
        label: question.label,
        type: question.type,
        options: question.options.map((option) => option.label),
        required: question.required,
        profileFieldId: question.profileFieldId,
      })),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Entry rules (§8.3)                                                 */
/* ------------------------------------------------------------------ */

/**
 * The two rank thresholds. Both optional, both guidance rather than a wall —
 * `setApplicationStatus` lets an admin accept anybody regardless.
 *
 * `updateEvent` refuses a rank the selected game's ladder does not contain,
 * which is why the pickers on the screen are built from that ladder and never
 * from a text box.
 */
export async function saveEntryRulesAction(
  eventId: string,
  rules: { minRankToEnter: string | null; minRankToCaptain: string | null }
): Promise<EventResult<null>> {
  await requireEventManager(eventId);

  const result = await updateEvent(eventId, {
    minRankToEnter: rules.minRankToEnter,
    minRankToCaptain: rules.minRankToCaptain,
  });
  if (!result.ok) return result;

  refresh(eventId);
  return { ok: true, data: null };
}

/* ------------------------------------------------------------------ */
/* Championship (UC-32)                                               */
/* ------------------------------------------------------------------ */

/**
 * `refresh`, plus the season whose list of counting events just changed.
 *
 * The season's own screen lists them (UC-32's outcome), so a weight changed
 * from the event editor has to reach it — these are two screens onto one row.
 */
function refreshSeason(eventId: string, championshipId: string): void {
  refresh(eventId);
  revalidatePath("/admin/championships");
  revalidatePath(`/admin/championships/${championshipId}`);
  revalidatePath("/admin/audit");
}

/**
 * Count this event towards a season (UC-32 1).
 *
 * Authorised with `requireEventManager`, exactly like every other write on this
 * page, because UC-32's actor is "an admin, or the host of that event" and its
 * precondition is that the actor manages the *event*. The season is an admin's
 * object and stays one: nothing here can change what a season is worth, only
 * whether this one event is in it, and a finished season refuses all three
 * writes below with UC-35 2b's message.
 *
 * **The offer is filtered by who is asking; this write is not.**
 * `championshipsToAddTo` gives a host the published seasons only (UC-31 2), so
 * a hidden season is never *listed* to them — but a host who already holds a
 * hidden season's id and posts it straight here is not refused, and will then
 * see its name on their own event. That is the right split: UC-31 2 is about
 * browsing other people's unpublished seasons, and a uuid somebody already has
 * is not a secret. Refusing it would also mean a host could not be asked to put
 * their event into a season an admin is still setting up, which is the ordinary
 * way an event joins one.
 */
export async function addEventToChampionshipAction(
  eventId: string,
  championshipId: string
): Promise<ChampionshipResult<null>> {
  const admin = await requireEventManager(eventId);

  const result = await addCountingEvent(championshipId, eventId);
  if (!result.ok) return result;

  await recordAudit({
    action: "championship.event.added",
    actor: admin,
    eventId,
    subject: result.data.season.id,
    summary: `"${result.data.title}" now counts towards "${result.data.season.name}".`,
    detail: { championship: result.data.season.id, weight: result.data.weight },
  });

  refreshSeason(eventId, result.data.season.id);
  return { ok: true, data: null };
}

/**
 * Set what this event is worth to its season — the weight, its own points
 * table, or both (UC-32 3, 3a).
 *
 * Only the settings that were sent are written. That buys nothing from this
 * screen, which shows both in one save and sends both every time — it is
 * `setCountingEvent`'s shape, not a claim about what this caller does, and a
 * weight saved from here does write back the points table the page was loaded
 * with.
 */
export async function saveEventChampionshipAction(
  eventId: string,
  fields: CountingEventFields
): Promise<ChampionshipResult<null>> {
  const admin = await requireEventManager(eventId);

  const result = await setCountingEvent(eventId, fields);
  if (!result.ok) return result;

  await recordAudit({
    action: "championship.event.changed",
    actor: admin,
    eventId,
    subject: result.data.season.id,
    summary:
      result.data.pointsTable === null
        ? `"${result.data.title}" counts towards "${result.data.season.name}" at weight ${result.data.weight}.`
        : `"${result.data.title}" counts towards "${result.data.season.name}" at weight ${result.data.weight}, on its own points table.`,
    detail: {
      championship: result.data.season.id,
      weight: result.data.weight,
      ownTable: result.data.pointsTable !== null,
    },
  });

  refreshSeason(eventId, result.data.season.id);
  return { ok: true, data: null };
}

/**
 * Stop counting this event (UC-32 4a). The season re-scores by itself, because
 * nothing about its standings was ever stored.
 */
export async function removeEventFromChampionshipAction(
  eventId: string
): Promise<ChampionshipResult<null>> {
  const admin = await requireEventManager(eventId);

  const result = await removeCountingEvent(eventId);
  if (!result.ok) return result;

  await recordAudit({
    action: "championship.event.removed",
    actor: admin,
    eventId,
    subject: result.data.season.id,
    summary: `"${result.data.title}" no longer counts towards "${result.data.season.name}".`,
    detail: { championship: result.data.season.id },
  });

  refreshSeason(eventId, result.data.season.id);
  return { ok: true, data: null };
}

/**
 * Record where everyone finished in this event's season (UC-33 3-4, 4a).
 *
 * `requireEventManager` again, and that is the whole reason this action lives
 * beside the other three rather than under `/admin/championships`: UC-33's
 * actor is a Manager, and the person who knows the finishing order is whoever
 * ran the event. The season is still an admin's object — nothing here changes
 * what it is worth, only where this one event's players came.
 *
 * Deliberately **not** gated on the event's own status. UC-33 1b: a complete
 * event may still have its championship result recorded, because the result
 * belongs to the season rather than to the event's own record — which stays
 * locked (UC-09 6b). A finished *season* is the refusal that does apply, and
 * `setPlacements` makes it.
 *
 * There is nothing to re-score afterwards. A standing is
 * `scoreChampionship` over the rows that are there, so the correction *is* the
 * write, and every screen that reads the season is already correct.
 */
export async function saveEventPlacementsAction(
  eventId: string,
  order: PlacementEntry[]
): Promise<ChampionshipResult<null>> {
  const admin = await requireEventManager(eventId);

  const result = await setPlacements(eventId, order);
  if (!result.ok) return result;

  const { counting, placements } = result.data;
  await recordAudit({
    action: "championship.result",
    actor: admin,
    eventId,
    subject: counting.season.id,
    summary:
      placements.length === 0
        ? `Cleared the finishing order for "${counting.title}" in "${counting.season.name}".`
        : `Recorded where everyone finished in "${counting.title}" for "${counting.season.name}".`,
    detail: { championship: counting.season.id, placed: placements.length },
  });

  refreshSeason(eventId, counting.season.id);
  return { ok: true, data: null };
}

/* ------------------------------------------------------------------ */
/* Applicants                                                         */
/* ------------------------------------------------------------------ */

/**
 * The word each decision reads as in the log.
 *
 * `pending` is not here and cannot be: an approval event's application arrives
 * pending and is never sent back to it (`ApplicationDecision`).
 */
const DECISION_VERB: Record<ApplicationDecision, string> = {
  accepted: "Accepted",
  waitlisted: "Waitlisted",
  declined: "Declined",
  withdrawn: "Withdrew",
};

export type DecisionResult = {
  status: ApplicationStatus;
  /** Seats free once this decision landed. Null when the event is uncapped. */
  seatsLeft: number | null;
  /** How many are still queueing behind it. */
  waitlisted: number;
  /** True when an override has put more people in than the cap allows. */
  overCapacity: boolean;
  /** Who this decision let in, when the caller asked for a promotion. */
  promoted: Array<{ id: string; userId: string }>;
};

/**
 * Accept, waitlist or decline one application.
 *
 * `promote` is off unless the screen asks for it, and the screen only asks
 * after the admin has said yes to a named person. That is `setApplicationStatus`'s
 * own reasoning: an admin declining somebody is *choosing* who is in the event,
 * and a promotion they did not ask for is a surprise.
 */
export async function decideApplicationAction(
  applicationId: string,
  status: ApplicationDecision,
  options: { note?: string | null; promote?: boolean }
): Promise<EventResult<DecisionResult>> {
  /*
   * Authorised on the row about to be written, and every read and audit line
   * after it uses the event that row belongs to. There is deliberately no
   * `eventId` option: one sent by the browser would let a host of one event
   * log against another's by passing a foreign id beside their own application.
   * See `src/lib/event-scope.ts`.
   */
  const { user: admin, eventId } = await requireManagerOfChild(() =>
    eventIdOfApplication(applicationId)
  );

  const result = await setApplicationStatus(applicationId, status, {
    decidedBy: admin.id,
    note: options.note,
    promote: options.promote,
  });
  if (!result.ok) return result;

  // Read back rather than describe the payload: the decision may have promoted
  // somebody, and the waitlist has been renumbered underneath either way, so
  // the position on the row that came out of the write is already the truth.
  const named = await describeApplication(applicationId);
  const who = named?.member ?? "somebody";
  const where = named?.eventTitle ?? "an event";
  const queue =
    named?.status === "waitlisted" && named.waitlistPosition
      ? ` at number ${named.waitlistPosition} in the queue`
      : "";

  await recordAudit({
    action: "application.decided",
    actor: admin,
    eventId,
    subject: applicationId,
    summary: `${DECISION_VERB[status]} ${who} for "${where}"${queue}.`,
    detail: {
      status: result.data.application.status,
      promoted: result.data.promoted.length,
      overCapacity: result.data.overCapacity,
    },
  });

  // Every decision is handed over, whatever it was. `announceApplicationDecision`
  // re-reads the row, and whether it posts is decided by the switch for the
  // kind the row turned out to be — accepted, waitlisted or declined.
  announceApplicationDecision(applicationId);

  // Everybody a promotion let in is a decision too, and one nobody clicked.
  for (const promoted of result.data.promoted) {
    announceApplicationDecision(promoted.id);
  }

  /*
   * The personal version of the same news. The channel announcement tells the
   * server; this tells the person, and it is the one kind that cannot be
   * switched off — it is the reply to something they asked for.
   */
  // "withdrawn" is the member's own doing, so there is nobody to tell.
  if (named?.userId && status !== "withdrawn") {
    notifyApplicationDecided(eventId, named.userId, status);
  }
  for (const promoted of result.data.promoted) {
    if (promoted.userId) {
      notifyApplicationDecided(eventId, promoted.userId, "accepted");
    }
  }

  refresh(eventId);
  return {
    ok: true,
    data: {
      status: result.data.application.status,
      seatsLeft: result.data.seats.seatsLeft,
      waitlisted: result.data.seats.waitlisted,
      overCapacity: result.data.overCapacity,
      promoted: result.data.promoted.map((row) => ({ id: row.id, userId: row.userId })),
    },
  };
}

/**
 * Write the admin's note and nothing else.
 *
 * Not `decideApplicationAction` with the status left alone: that recomputes the
 * waitlist position, so noting "might be late" against the person at the front
 * of the queue would send them to the back of it.
 */
export async function saveApplicationNoteAction(
  applicationId: string,
  note: string | null,
  eventId: string
): Promise<EventResult<null>> {
    /*
   * Authorised on the row about to be written, not on the `eventId` beside it.
   * That argument comes from the browser and is only used to revalidate a page;
   * trusting it here would let a host of one event act on another's by passing
   * their own id alongside a foreign application id. See `src/lib/event-scope.ts`.
   */
  const { eventId: scope } = await requireManagerOfChild(() => eventIdOfApplication(applicationId));

  const result = await setApplicationNote(applicationId, note);
  if (!result.ok) return result;

  refresh(scope);
  return { ok: true, data: null };
}

/**
 * Correct one applicant's availability on the admin's behalf — "he messaged me,
 * he can make Saturday after all".
 *
 * Days are checked against this application's own event inside
 * `setAvailability`, so a stale page cannot write an answer onto a day that
 * belongs somewhere else.
 */
export async function setApplicantAvailabilityAction(
  applicationId: string,
  byDay: Record<string, AvailabilityState | null>,
  eventId: string
): Promise<EventResult<Record<string, AvailabilityState>>> {
    /*
   * Authorised on the row about to be written, not on the `eventId` beside it.
   * That argument comes from the browser and is only used to revalidate a page;
   * trusting it here would let a host of one event act on another's by passing
   * their own id alongside a foreign application id. See `src/lib/event-scope.ts`.
   */
  const { eventId: scope } = await requireManagerOfChild(() => eventIdOfApplication(applicationId));

  const result = await setAvailability(applicationId, byDay);
  if (!result.ok) return fail(result.error);

  refresh(scope);
  return result;
}
