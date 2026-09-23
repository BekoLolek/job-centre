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
import { type EventResult, applyToEvent, describeApplication } from "@/lib/events";
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
  /** Keyed by `event_questions.id`. Anything unknown is refused, not ignored. */
  answers: Record<string, unknown>;
  /** Keyed by `event_days.id`. */
  availability: Record<string, AvailabilityState>;
};

export async function applyToEventAction(
  input: ApplyInputFields
): Promise<EventResult<ApplyOutcome>> {
  const user = await requireUser();

  const result = await applyToEvent(input.eventId, user.id, {
    answers: input.answers,
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
