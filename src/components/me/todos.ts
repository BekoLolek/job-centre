import type { ApplicationStatus, ConfirmationState } from "@/db/schema";
import { confirmationsOpen } from "@/lib/events-policy";

/**
 * The "still coming?" to-do on `/me`, as a function rather than as a branch
 * inside the page.
 *
 * It lives here for the reason `src/components/events/viewer.ts` does: it is a
 * rule, it is pure, and a rule buried in a server component is a rule nothing
 * can test. The page reads the answer; it does not have an opinion of its own.
 *
 * Every to-do on that page is something **only the member can resolve**, and
 * R-199 and R-200 each change what that means:
 *
 *  - A `maybe` is an answer, so the section on `/me/events` is answered — but
 *    it is the one answer that leaves the organisers holding an uncertain seat
 *    (UC-13 5b), and nothing in the site resolves it (UC-13 extensions E4). So
 *    it stays a to-do, worded as settling rather than as answering. Without
 *    that, the kindest thing a member can do — saying "I don't know yet"
 *    instead of nothing — would also be the thing that makes the site stop
 *    reminding them, and a seat would sit on a maybe until the night.
 *  - Past the deadline there is **no to-do at all**, for a maybe or for silence
 *    alike, because the write refuses it (R-200, UC-13 5c): a task nobody can
 *    complete is not a task. Withdrawing is still open, but a withdrawal is a
 *    decision rather than an outstanding job, and it belongs on `/me/events`
 *    where it costs a seat.
 *
 * An undated event is never a to-do either: `CONFIRM_WINDOW_MS` measures how
 * close the event is, and an event nobody has scheduled is not close to
 * anything. It has no deadline, so the answer keeps for ever (UC-13 7a).
 */

export type ConfirmationTodoInput = {
  status: ApplicationStatus;
  confirmation: ConfirmationState | null;
  /** The event's start, or null for one nobody has scheduled. */
  startsAt: Date | null;
  /** How close the start has to be before the nudge is worth making. */
  within: number;
  now: Date;
};

/** What to nudge about: nothing, an unanswered seat, or an unsettled maybe. */
export type ConfirmationTodo = "answer" | "settle" | null;

export function confirmationTodo({
  status,
  confirmation,
  startsAt,
  within,
  now,
}: ConfirmationTodoInput): ConfirmationTodo {
  // Only a held seat. A queue place is not an attendance question yet, and a
  // declined or withdrawn application has nothing to answer (`setConfirmation`
  // refuses both).
  if (status !== "accepted") return null;
  if (!startsAt) return null;
  if (!confirmationsOpen(startsAt, now)) return null;
  if (startsAt.getTime() - now.getTime() > within) return null;

  if (confirmation === null) return "answer";
  if (confirmation === "maybe") return "settle";
  // "I'll be there" and "I can't make it" both settle it. ("I can't make it"
  // from a seat has already withdrawn them, so they are not in this list at
  // all — but saying so costs nothing and survives that changing.)
  return null;
}
