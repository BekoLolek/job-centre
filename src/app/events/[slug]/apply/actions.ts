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
 */

import { revalidatePath } from "next/cache";
import type { ApplicationStatus, AvailabilityState } from "@/db/schema";
import { type EventResult, applyToEvent } from "@/lib/events";
import { requireUser } from "@/lib/session-guards";

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

  return {
    ok: true,
    data: {
      status: result.data.status,
      waitlistPosition: result.data.waitlistPosition,
    },
  };
}
