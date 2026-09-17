/**
 * The standing rule, as a function: **a finished event is a record**
 * (R-39; UC-09 6b; the Event domain rule).
 *
 * While an event is `complete`, nothing belonging to it can change — its setup,
 * its applications, its teams, its draft, its stages and its results. A record
 * that can be quietly edited afterwards is not one anybody can trust, and a
 * draft whose prices vanished has already happened once.
 *
 * No database, no I/O, one exported decision. The refusals themselves live at
 * the top of every write that belongs to an event, in `src/lib/events.ts`,
 * `src/lib/draft.ts` and `src/lib/format.ts`, and every one of them asks this
 * module rather than retyping `status === "complete"`, because a second copy of
 * the rule is a second copy that drifts. Each reads the status from the
 * database inside its own call; a status the caller passes in is not evidence.
 *
 * ## One sentence, everywhere
 *
 * The refusal used to say what, in particular, could not happen. It no longer
 * needs to: *everything* is refused, so the only thing worth saying is why and
 * what to do about it. `archive-lock.test.ts` holds the list of writes it
 * covers, one row each.
 *
 * ## Why only `complete`, and not `cancelled`
 *
 * `cancelled` means called off, not finished. It is not locked; it is terminal,
 * so nothing moves it through the status flow — `EVENT_STATUS_FLOW` has no
 * transition out of it.
 *
 * ## Why this is a lock and not a wall
 *
 * `complete → live` is a legal transition, deliberately, and it is the one write
 * a finished event accepts (UC-09 6a). A manager who marked an event finished
 * too early is one status change away from editing it again, and the change is
 * itself in the audit log. That is the difference between a rule that protects
 * a record and a rule that traps its owner: the way out is one click, it is
 * visible, and it is written down.
 */

import type { EventStatus } from "@/db/schema";

/**
 * The statuses that make an event read-only.
 *
 * A list rather than a comparison, so a future `archived` status is one entry
 * rather than a hunt through three modules.
 */
export const LOCKED_STATUSES: readonly EventStatus[] = ["complete"];

/** Is this event's record closed? */
export function isLocked(status: EventStatus): boolean {
  return LOCKED_STATUSES.includes(status);
}

/** What every refused write on a finished event says (UC-09 6b). */
export const LOCKED_REFUSAL = "This event is finished - reopen it to change it";

/**
 * The refusal for a write that would touch a finished event, or `null` when the
 * write may proceed.
 *
 * ```ts
 * const locked = lockRefusal(event);
 * if (locked) return fail(locked);
 * ```
 */
export function lockRefusal(event: { status: EventStatus }): string | null {
  return isLocked(event.status) ? LOCKED_REFUSAL : null;
}
