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
 */

import { revalidatePath } from "next/cache";
import type { ApplicationStatus, AvailabilityState, EventStatus } from "@/db/schema";
import {
  type EventDayInput,
  type EventDaysImpact,
  type EventQuestionInput,
  type EventResult,
  createEvent,
  previewEventDays,
  publishEvent,
  setApplicationNote,
  setApplicationStatus,
  setAvailability,
  setEventDays,
  setEventQuestions,
  updateEvent,
} from "@/lib/events";
import { isFieldType } from "@/lib/profile-fields";
import { requireAdmin } from "@/lib/session-guards";
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
  /** ISO instants, or null for "no bound that side". */
  signupOpensAt: string | null;
  signupClosesAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
};

/**
 * Save the Basics tab.
 *
 * Note what is *not* here: status and the two rank thresholds. Each tab saves
 * itself, so Basics must not carry — and therefore cannot silently revert — a
 * value the admin last changed on a different tab.
 */
export async function saveBasicsAction(
  eventId: string,
  fields: BasicsFields
): Promise<EventResult<{ slug: string }>> {
  await requireAdmin();

  const result = await updateEvent(eventId, {
    title: fields.title,
    slug: fields.slug,
    type: fields.type,
    description: fields.description,
    bannerUrl: fields.bannerUrl,
    gameId: fields.gameId,
    capacity: fields.capacity,
    signupOpensAt: parseStamp(fields.signupOpensAt),
    signupClosesAt: parseStamp(fields.signupClosesAt),
    startsAt: parseStamp(fields.startsAt),
    endsAt: parseStamp(fields.endsAt),
  });
  if (!result.ok) return result;

  refresh(eventId);
  // The slug comes back because `freeSlug` may have disambiguated it, and an
  // admin who typed "rivals" deserves to be told they got "rivals-2".
  return { ok: true, data: { slug: result.data.slug } };
}

/* ------------------------------------------------------------------ */
/* Status                                                             */
/* ------------------------------------------------------------------ */

/**
 * Move the event along its lifecycle. Illegal jumps are refused by
 * `canTransition` inside `updateEvent`; the screen only ever offers the legal
 * ones, so a rejection here means the page was stale.
 */
export async function setEventStatusAction(
  eventId: string,
  status: EventStatus
): Promise<EventResult<{ status: EventStatus }>> {
  await requireAdmin();

  const result = await updateEvent(eventId, { status });
  if (!result.ok) return result;

  refresh(eventId);
  return { ok: true, data: { status: result.data.status } };
}

/** Publish: members can see it, and the signup window starts to mean something. */
export async function publishEventAction(
  eventId: string
): Promise<EventResult<{ status: EventStatus }>> {
  await requireAdmin();

  const result = await publishEvent(eventId);
  if (!result.ok) return result;

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
  await requireAdmin();
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
  await requireAdmin();

  const result = await setEventDays(eventId, days.map(toDayInput));
  if (!result.ok) return result;

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
  await requireAdmin();

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
  await requireAdmin();

  const result = await updateEvent(eventId, {
    minRankToEnter: rules.minRankToEnter,
    minRankToCaptain: rules.minRankToCaptain,
  });
  if (!result.ok) return result;

  refresh(eventId);
  return { ok: true, data: null };
}

/* ------------------------------------------------------------------ */
/* Applicants                                                         */
/* ------------------------------------------------------------------ */

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
  status: ApplicationStatus,
  options: { eventId: string; note?: string | null; promote?: boolean }
): Promise<EventResult<DecisionResult>> {
  const admin = await requireAdmin();

  const result = await setApplicationStatus(applicationId, status, {
    decidedBy: admin.id,
    note: options.note,
    promote: options.promote,
  });
  if (!result.ok) return result;

  refresh(options.eventId);
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
  await requireAdmin();

  const result = await setApplicationNote(applicationId, note);
  if (!result.ok) return result;

  refresh(eventId);
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
  await requireAdmin();

  const result = await setAvailability(applicationId, byDay);
  if (!result.ok) return fail(result.error);

  refresh(eventId);
  return result;
}
