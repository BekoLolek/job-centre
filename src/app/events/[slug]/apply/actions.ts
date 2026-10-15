"use server";

/**
 * The server action behind `/events/[slug]/apply`.
 *
 * Thin, like every other action in this codebase: prove who is asking, hand the
 * arguments to `src/lib/events.ts` — which takes the event's row lock, re-reads
 * the questions and the seat count inside it, and owns every rule — then
 * revalidate the pages whose content just changed.
 *
 * `requireUser()` runs here rather than being trusted from the page that
 * rendered the button. A server action is a public endpoint reachable by POST;
 * the page's guard proves nothing about who is calling it five minutes later,
 * and `applyToEvent` decides who gets the last seat.
 *
 * Note the `userId` that reaches `applyToEvent` is the session's, never the
 * client's. There is no parameter for it and there must not be one.
 *
 * ## The notification and the audit line live here
 *
 * Same rule as `/admin/events`' actions, for the same two reasons: `recordAudit`
 * needs to know who is acting and `requireUser()` is the only place that is
 * known, and `notify*` is deferred work that must not be able to fail an
 * application that has already landed. Both run only after `applyToEvent` has
 * said `ok` — nothing is announced that did not stick.
 */

import { revalidatePath } from "next/cache";
import type { ApplicationStatus, AvailabilityState } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import {
  type EventResult,
  applyToEvent,
  describeApplication,
  editApplicationAnswers,
} from "@/lib/events";
import { notifyApplicationDecided } from "@/lib/notify-events";
import { requireUser } from "@/lib/session-guards";

/** How an application that has just landed reads in the log and the alert. */
const LANDED: Record<ApplicationStatus, string> = {
  accepted: "took a seat",
  waitlisted: "joined the queue",
  pending: "is awaiting review",
  declined: "was declined",
  withdrawn: "was withdrawn",
};

/** What the form needs back: where the application landed, and where in a queue. */
export type ApplyOutcome = {
  status: ApplicationStatus;
  /** Null unless they are queueing. #1 is the front. */
  waitlistPosition: number | null;
};

export type ApplyInputFields = {
  eventId: string;
  /** Only used to revalidate the event's own page. */
  slug: string;
  /**
   * The event's own questions, keyed by `event_questions.id`. Anything unknown
   * is refused, not ignored — and a linked question is unknown here, because
   * its answer is a profile detail and belongs in `details`.
   */
  answers: Record<string, unknown>;
  /**
   * The member's profile details, keyed by `profile_fields.id` (UC-12 3a).
   * These are written to the profile, which stays the source (R-11).
   */
  details?: Record<string, unknown>;
  /** Detail ids the member said are still right, untouched (UC-12 3, R-49). */
  confirmed?: string[];
  /** Keyed by `event_days.id`. */
  availability: Record<string, AvailabilityState>;
};

export async function applyToEventAction(
  input: ApplyInputFields
): Promise<EventResult<ApplyOutcome>> {
  const user = await requireUser();

  const result = await applyToEvent(input.eventId, user.id, {
    answers: input.answers,
    details: input.details,
    confirmed: input.confirmed,
    availability: input.availability,
  });
  if (!result.ok) return result;

  // A new application changes the seat count on the hub, the events list and
  // the event page, and adds a row to the member's own list.
  revalidatePath("/");
  revalidatePath("/events");
  revalidatePath(`/events/${input.slug}`);
  revalidatePath(`/events/${input.slug}/apply`);
  revalidatePath("/me");
  revalidatePath("/me/events");
  revalidatePath(`/admin/events/${input.eventId}`);

  /*
   * UC-12 8: the member is told where they landed, and R-100's "without
   * checking" is the whole point of the notification existing at all. An
   * approval event's `pending` is not one of the three answers
   * `notifyApplicationDecided` knows how to word (R-27: nothing has been
   * decided yet), so it waits for the manager's decision to say anything.
   */
  const landed = result.data.status;
  if (landed === "accepted" || landed === "waitlisted") {
    notifyApplicationDecided(input.eventId, user.id, landed);
  }

  // Read back rather than describe the payload: the waitlist was renumbered
  // inside the write, so the position on the stored row is the one that is true.
  const named = await describeApplication(result.data.id);
  const who = named?.member ?? "somebody";
  const where = named?.eventTitle ?? "an event";
  const queue =
    named?.status === "waitlisted" && named.waitlistPosition
      ? ` at number ${named.waitlistPosition}`
      : "";

  await recordAudit({
    action: "application.decided",
    actor: user,
    eventId: input.eventId,
    subject: result.data.id,
    summary: `${who} applied to "${where}" and ${LANDED[landed]}${queue}.`,
    detail: { status: landed },
  });

  return {
    ok: true,
    data: {
      status: result.data.status,
      waitlistPosition: result.data.waitlistPosition,
    },
  };
}

/**
 * Change an answer on an application that is already in (R-53 / UC-13 3, 4).
 *
 * `requireUser()` again, and for the reason that matters most on this one: the
 * deadline. UC-13 4a closes edits when sign-ups close, and `editApplicationAnswers`
 * is what enforces it — **not** this action, and certainly not the page. A
 * server action is a public POST endpoint reachable long after the form that
 * used to render it has gone, so a check that lives in the UI is a check
 * anybody can walk past. What is here is only the two things the library
 * deliberately cannot know: who is asking, and which pages to re-render.
 *
 * Note the member id and the event id are the only identifiers that reach the
 * write. There is no application id in this signature, so there is nothing to
 * point at somebody else's row: `editApplicationAnswers` finds the application
 * by `(event, user)` inside its own transaction.
 *
 * Nothing is notified and nothing is audited. A member fixing their own answer
 * is not a decision about a seat — the status, the queue position and the
 * submission time all stay exactly as they were — and a notification per typo
 * is how members turn notifications off.
 */
export async function editApplicationAction(
  input: ApplyInputFields
): Promise<EventResult<null>> {
  const user = await requireUser();

  const result = await editApplicationAnswers(input.eventId, user.id, {
    answers: input.answers,
    details: input.details,
    confirmed: input.confirmed,
    availability: input.availability,
  });
  if (!result.ok) return result;

  // No seat moved, so the hub and the events list are untouched. What did
  // change is the member's own pages and the manager's applicant list, which
  // reads the answers (UC-14 2).
  revalidatePath(`/events/${input.slug}/apply`);
  revalidatePath("/me");
  revalidatePath("/me/events");
  revalidatePath("/me/profile");
  revalidatePath(`/admin/events/${input.eventId}`);

  return { ok: true, data: null };
}
