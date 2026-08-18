/**
 * The standing rule, as a function: **nothing destructive, ever**
 * (docs/checklist.md, Standing rules).
 *
 * A finished event is a record. Its results, its rosters and the prices its
 * captains paid are the only reason the storage rewrite in §3.1 was worth
 * doing — a draft whose prices vanish is a draft nobody can argue about
 * afterwards, and that has already happened once. So once an event is
 * `complete`, every write that could erase one of those three is refused.
 *
 * No database, no I/O, one exported decision. The refusals themselves live in
 * `src/lib/events.ts`, `src/lib/draft.ts` and `src/lib/format.ts` — the modules
 * that already own "may this write happen" — and every one of them asks this
 * module rather than retyping `status === "complete"`, because a second copy of
 * the rule is a second copy that drifts.
 *
 * ## Why only `complete`, and not `cancelled`
 *
 * `cancelled` means called off, not finished: `EVENT_STATUS_FLOW` lets a
 * cancelled event go back to `draft`, and the admin events list says so in as
 * many words. An event that never ran has nothing to protect, and locking it
 * would turn "I clicked the wrong button" into a dead end.
 *
 * ## Why this is a lock and not a wall
 *
 * `complete → live` is a legal transition, deliberately. An admin who marked an
 * event finished too early is one status change away from editing it again, and
 * the change is itself in the audit log. That is the difference between a rule
 * that protects a record and a rule that traps its owner: the way out is one
 * click, it is visible, and it is written down.
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

/**
 * Just enough of an event to decide. Every caller has a row; none of them
 * should have to pass anything else.
 */
export type LockableEvent = { status: EventStatus; title?: string | null };

/**
 * The refusal sentence for a write that would touch a finished event, or `null`
 * when the write may proceed.
 *
 * `attempt` completes the sentence "This event is finished, so …" and is
 * therefore an infinitive phrase describing what was *asked for*, not what
 * would be lost: "its bracket cannot be regenerated" rather than "you would
 * lose six results". The admin knows what they clicked; what they need told is
 * why it did not happen and what to do instead — which is why every refusal
 * ends with the way out.
 *
 * ```ts
 * const refusal = lockRefusal(event, "its bracket cannot be regenerated");
 * if (refusal) return fail(refusal);
 * ```
 */
export function lockRefusal(event: LockableEvent, attempt: string): string | null {
  if (!isLocked(event.status)) return null;
  return `${event.title ? `"${event.title}" is finished` : "This event is finished"}, so ${attempt}. Move it back to live first if it really is not over.`;
}

/* ------------------------------------------------------------------ */
/* The phrases                                                        */
/* ------------------------------------------------------------------ */

/**
 * Every refusal on the site, in one place.
 *
 * Not because the strings need sharing — most are used once — but because this
 * list *is* the answer to "what can a finished event no longer do", and having
 * to read it out of nine call sites is how the answer stops being knowable. It
 * doubles as the checklist for the audit that produced it.
 */
export const LOCKED = {
  /* --- results ---------------------------------------------------- */
  recordResult: "its results cannot be changed",
  clearResult: "its results cannot be cleared",
  overrideWinner: "its winners cannot be overturned",
  reschedule: "its running order cannot be rebuilt",
  moveMatch: "its matches cannot be moved",
  /* --- the bracket ------------------------------------------------ */
  generate: "its bracket cannot be regenerated",
  stages: "its format cannot be changed",
  /* --- teams and the draft ---------------------------------------- */
  teams: "its teams cannot be changed",
  captains: "its captains cannot be changed",
  draftConfig: "the draft rules cannot be changed",
  pool: "its draft pool cannot be re-seeded",
  runDraft: "its draft cannot be run again",
  voidLot: "a lot cannot be voided — that would erase what was paid",
  bid: "its draft is closed",
  /* --- the event's own scaffolding -------------------------------- */
  days: "its days cannot be rewritten",
  questions: "its application form cannot be rewritten",
} as const;
