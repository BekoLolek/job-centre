"use server";

/**
 * The server actions behind `/me/events`.
 *
 * Three things a member may do to their own application: change which days they
 * can make, answer "still coming?", and withdraw. Each one is a public POST
 * endpoint, so each one re-establishes who is asking with `requireUser()` and
 * then proves the application being touched is *theirs*.
 *
 * ## Why the ownership check is here and not in `src/lib/events.ts`
 *
 * `setAvailability` and `setConfirmation` take an application id and no user:
 * they are the same calls the admin screen makes when it fills in availability
 * on somebody's behalf, and pushing "unless you are an admin" into the library
 * would put a session concept inside the module that is deliberately free of
 * one. So the check lives at the trust boundary, which is exactly here — an
 * application id is a uuid somebody could guess at, and "the id came from the
 * page we rendered" is not a security argument.
 *
 * `withdrawApplication` needs no such check: it takes the event and the user,
 * and the user is the session's.
 */

import { revalidatePath } from "next/cache";
import type { AvailabilityState, ConfirmationState } from "@/db/schema";
import {
  type EventResult,
  getMyApplications,
  setAvailability,
  setConfirmation,
  withdrawApplication,
} from "@/lib/events";
import { requireUser } from "@/lib/session-guards";

/** Everything a member touches changes these four surfaces. */
function refresh(slug?: string): void {
  revalidatePath("/");
  revalidatePath("/me");
  revalidatePath("/me/events");
  revalidatePath("/events");
  if (slug) revalidatePath(`/events/${slug}`);
}

/**
 * The member's own application with this id, or null.
 *
 * A read of their whole list rather than of the one row, because
 * `getMyApplications` is already the "these are yours" query and a second,
 * subtly different notion of ownership is how a hole gets left in one of them.
 */
async function ownApplication(userId: string, applicationId: string) {
  const mine = await getMyApplications(userId);
  return mine.find((row) => row.id === applicationId) ?? null;
}

export async function setMyAvailabilityAction(
  applicationId: string,
  byDay: Record<string, AvailabilityState | null>
): Promise<EventResult<Record<string, AvailabilityState>>> {
  const user = await requireUser();

  const application = await ownApplication(user.id, applicationId);
  if (!application) return { ok: false, error: "That is not one of your applications." };

  const result = await setAvailability(applicationId, byDay);
  if (result.ok) refresh(application.event.slug);
  return result;
}

export async function setMyConfirmationAction(
  applicationId: string,
  state: ConfirmationState
): Promise<EventResult<{ state: ConfirmationState; confirmedAt: Date }>> {
  const user = await requireUser();

  const application = await ownApplication(user.id, applicationId);
  if (!application) return { ok: false, error: "That is not one of your applications." };

  const result = await setConfirmation(applicationId, state);
  if (result.ok) refresh(application.event.slug);
  return result;
}

export type WithdrawOutcome = {
  /** How many people the freed seat let in — normally 0 or 1. */
  promoted: number;
};

/**
 * Withdraw from an event.
 *
 * Takes the event id rather than the application id because that is what
 * `withdrawApplication` takes, and it finds the caller's own application
 * inside the same transaction that promotes whoever is next. The member cannot
 * withdraw anyone else by passing a different id: their session decides whose
 * application is found.
 */
export async function withdrawFromEventAction(
  eventId: string,
  slug: string
): Promise<EventResult<WithdrawOutcome>> {
  const user = await requireUser();

  const result = await withdrawApplication(eventId, user.id);
  if (!result.ok) return result;

  refresh(slug);
  revalidatePath(`/admin/events/${eventId}`);

  return { ok: true, data: { promoted: result.data.promoted.length } };
}
