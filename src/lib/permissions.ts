import { and, eq, inArray } from "drizzle-orm";
import { type Database, db as defaultDb, eventHosts, userPermissions } from "@/db";
import { type AuditAction, isDestructive } from "./audit";
import {
  type Holder,
  POWERS,
  type Power,
  assertPower,
  holds,
  isPower,
} from "./permissions-policy";

/**
 * The stored side of permissions: one row in `user_permissions` per grant
 * (R-261 / UC-55, decision 007).
 *
 * The vocabulary, the presets and the question "may they" are in
 * `permissions-policy.ts`, which has no database and can be imported by a
 * client component. This module is the half that talks to Postgres.
 *
 * `powersOf` is read by `requirePermission` in `session-guards.ts` on every
 * call of the guard for a member who is not an admin, so a row here decides
 * who that guard lets through.
 *
 * Every write to the table is in this file. `/admin/users` stores a member's
 * whole list through `setPowers`; `grantPower` gives one power, and no screen
 * calls it; `clearPowers` deletes a list the admin flag has replaced.
 *
 * `destructiveRefusal`, at the foot, is here for the same reason: the
 * `destructive` modifier (R-267) is a question about stored rows - the
 * member's own, and the event's hosts.
 */

/**
 * The powers stored for this member.
 *
 * Only the rows. The admin flag is not in this table and is not consulted
 * here: pass the result to `holds` with the flag beside it.
 *
 * A row whose power is not in the vocabulary — one retired in a later
 * release, or written by hand — is dropped here, at the read. So the set holds
 * powers and nothing else, and its size and its members can be trusted by a
 * caller that never goes through `holds`.
 */
export async function powersOf(
  userId: string,
  database: Database = defaultDb
): Promise<ReadonlySet<Power>> {
  const rows = await database
    .select({ power: userPermissions.power })
    .from(userPermissions)
    .where(eq(userPermissions.userId, userId));
  return new Set(rows.map((row) => row.power).filter(isPower));
}

/**
 * This member as `holds` wants them: the flag, and beside it their own list
 * (R-265 / UC-56 2).
 *
 * For a screen deciding what to *offer* - which sections, which buttons. It is
 * the same read `requirePermission` makes and it is made on this request, so a
 * power taken away a moment ago stops being offered on the next page load. An
 * admin's list is not read, as the guard does not read it: the flag answers
 * first, so the rows could change nothing.
 *
 * It refuses nobody. What is offered is never what stops an action; the guard
 * on the action is.
 */
export async function holderFor(
  user: { id: string; isAdmin: boolean },
  database: Database = defaultDb
): Promise<Holder> {
  return {
    isAdmin: user.isAdmin,
    powers: user.isAdmin ? new Set<Power>() : await powersOf(user.id, database),
  };
}

/**
 * Give a member a power.
 *
 * A power outside the vocabulary is refused before anything is written, with
 * an error that names it — the column is plain text, so this is the only
 * thing between a typo and a stored row.
 *
 * Granting what the member already holds changes nothing: the first grant's
 * time and granter stand. The primary key refuses the second row, and the
 * conflict clause — targeted at that key, as `makeHost` and
 * `approveHostApplication` target theirs — turns that one refusal into a
 * no-op.
 *
 * `created` says which happened, and it is Postgres' answer rather than a
 * read beforehand: `onConflictDoNothing().returning()` hands back the inserted
 * row or nothing, inside the one statement. It is the shape `waiveEntryRule`
 * in `events.ts` reports, for the same use — a caller that logs on `created`
 * writes one audit line per grant however many times the form is sent.
 *
 * Two things it deliberately does not do, both left to the action that calls
 * it: it does not ask who is granting, which only an admin may (R-264), and
 * it writes no audit line, which every grant must have (R-266).
 */
export async function grantPower(
  grant: { userId: string; power: string; grantedByUserId: string },
  database: Database = defaultDb
): Promise<{ created: boolean }> {
  assertPower(grant.power);
  const inserted = await database
    .insert(userPermissions)
    .values(grant)
    .onConflictDoNothing({ target: [userPermissions.userId, userPermissions.power] })
    .returning({ power: userPermissions.power });
  return { created: inserted.length > 0 };
}

/**
 * Make a member's stored list exactly this one (R-262 / UC-55).
 *
 * The list is everything they hold afterwards: a power on it that they lacked
 * is granted, and one they held that is not on it is taken away. A power is
 * removed here and in {@link clearPowers}, and nowhere else.
 *
 * **One transaction.** A save is one decision somebody made, so it lands whole
 * or not at all. The removal runs first and the grant second; if the grant
 * fails, the removal is rolled back with it rather than leaving the member
 * with half of the old list and none of the new.
 *
 * `added` and `removed` are Postgres' answer, as `grantPower`'s `created` is:
 * the rows the two statements actually inserted and deleted, in the
 * vocabulary's order. Both empty means the list was already what is stored,
 * which is how a caller knows to write no audit line. A power that stays keeps
 * the time and the granter it already had.
 *
 * A name outside the vocabulary is refused before anything is written, with
 * the error `grantPower` gives. A stored *row* outside it is left where it is
 * and never reported: `powersOf` does not show it, so removing it here would
 * be a line in the log about something no screen ever offered.
 *
 * Like `grantPower`, it does not ask who is saving and writes no audit line.
 */
export async function setPowers(
  change: { userId: string; powers: readonly string[]; grantedByUserId: string },
  database: Database = defaultDb
): Promise<{ added: Power[]; removed: Power[] }> {
  for (const power of change.powers) assertPower(power);
  const wanted = new Set(change.powers);
  const unwanted = POWERS.filter((power) => !wanted.has(power));

  return database.transaction(async (tx) => {
    const deleted =
      unwanted.length === 0
        ? []
        : await tx
            .delete(userPermissions)
            .where(
              and(
                eq(userPermissions.userId, change.userId),
                inArray(userPermissions.power, unwanted)
              )
            )
            .returning({ power: userPermissions.power });

    const inserted =
      wanted.size === 0
        ? []
        : await tx
            .insert(userPermissions)
            .values(
              [...wanted].map((power) => ({
                userId: change.userId,
                power,
                grantedByUserId: change.grantedByUserId,
              }))
            )
            .onConflictDoNothing({ target: [userPermissions.userId, userPermissions.power] })
            .returning({ power: userPermissions.power });

    return { added: inVocabularyOrder(inserted), removed: inVocabularyOrder(deleted) };
  });
}

/**
 * Delete a member's whole stored list, and say what was on it (Task 151,
 * R-266).
 *
 * For the moment the admin flag replaces the list. An admin's rows are read by
 * nothing while the flag is on - `holderFor` skips them and the screen refuses
 * to edit them - and {@link powersOf} hands them straight back the day it
 * comes off: powers granted by a decision nobody made, at a time nobody chose.
 * So the rows go when the flag arrives, and `powersOf` has nothing to return
 * that somebody did not grant since.
 *
 * One statement, so a caller runs it inside the transaction that sets the
 * flag. What it returns is what Postgres deleted, in the vocabulary's order,
 * and empty means there was nothing - which is how a caller knows to write no
 * audit line.
 *
 * As {@link setPowers}: a stored row outside the vocabulary is left where it
 * is and not reported, it does not ask who is clearing, and it writes no audit
 * line.
 */
export async function clearPowers(
  userId: string,
  database: Database = defaultDb
): Promise<Power[]> {
  const deleted = await database
    .delete(userPermissions)
    .where(and(eq(userPermissions.userId, userId), inArray(userPermissions.power, [...POWERS])))
    .returning({ power: userPermissions.power });
  return inVocabularyOrder(deleted);
}

/** These rows' powers, in the order the vocabulary lists them. */
function inVocabularyOrder(rows: ReadonlyArray<{ power: string }>): Power[] {
  const names = new Set(rows.map((row) => row.power));
  return POWERS.filter((power) => names.has(power));
}

/**
 * What a holder is told when the one thing they lack is `destructive`
 * (UC-57 4: "refuses, naming what is missing").
 *
 * A sentence in the `{ ok: false, error }` every action here already returns,
 * not a redirect and not a new kind of result. The guards redirect because
 * they are telling somebody the page is not theirs; this is said to somebody
 * whose page it is, about one button on it.
 *
 * It names the power and nothing else, and it leaks nothing: it is only ever
 * said after the action's own guard has let the caller in, so the one fact in
 * it - that they do not hold `destructive` - is a fact about their own list.
 */
export const DESTRUCTIVE_REFUSAL =
  "This action is marked destructive, so it needs the “destructive” power as well. " +
  "You have not been given it - an admin can grant it.";

/**
 * The `destructive` modifier (R-267 / UC-57): may this actor do this, given
 * that the action's own guard has already said yes?
 *
 * `null` when they may, {@link DESTRUCTIVE_REFUSAL} when they may not. An
 * action that writes a line under a destructive key asks this **after** its
 * guard and **before** its write, with the same key it will log under:
 *
 * ```ts
 * const actor = await requirePermission("polls.manage");
 * const refusal = await destructiveRefusal(actor, "poll.deleted");
 * if (refusal) return { ok: false, error: refusal };
 * ```
 *
 * Returned, not thrown, and that is safe only because of where it is asked:
 * nothing has been written yet and no transaction is open. A refusal returned
 * from inside a transaction commits what came before it (decision 004), so
 * this must never be moved below a write.
 *
 * ## It is not a guard, and it admits nobody
 *
 * It answers "no" to nobody the area's guard would have let in for an
 * ordinary action, and "yes" means only "the modifier is not what stops you".
 * A member holding `destructive` and nothing else gets `null` here and is
 * still turned away by the guard that ran first. Never call it instead of one.
 *
 * ## Which actions: `audit.ts` decides, and only `audit.ts`
 *
 * `isDestructive` is asked and there is no list here. The key is typed as an
 * {@link AuditAction} so that a misspelt one is a compile error and not an
 * action that is quietly never refused.
 *
 * ## Who is let through
 *
 *  - **An admin**: the flag is above the vocabulary (UC-57 2a), and `holds`
 *    answers for it before anything is read.
 *  - **A holder of `destructive`** (UC-57 1a).
 *  - **The host of the event the action is on** (UC-57 3a). A host's evening
 *    is whole: within their one event they do what an admin can, and this
 *    vocabulary is site-wide. Pass the event's id for an action on an event
 *    and nothing for one that is not. It is the host of *that* event only -
 *    hosting one evening says nothing about somebody else's, or about polls.
 */
export async function destructiveRefusal(
  actor: { id: string; isAdmin: boolean },
  action: AuditAction,
  hostedEventId: string | null = null,
  database: Database = defaultDb
): Promise<string | null> {
  if (!isDestructive(action)) return null;
  if (holds(await holderFor(actor, database), "destructive")) return null;
  if (hostedEventId && (await hostsEvent(actor.id, hostedEventId, database))) return null;
  return DESTRUCTIVE_REFUSAL;
}

/** Is there an `event_hosts` row for this member on this event? */
async function hostsEvent(userId: string, eventId: string, database: Database): Promise<boolean> {
  const [row] = await database
    .select({ userId: eventHosts.userId })
    .from(eventHosts)
    .where(and(eq(eventHosts.eventId, eventId), eq(eventHosts.userId, userId)))
    .limit(1);
  return Boolean(row);
}
