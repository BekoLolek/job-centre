"use server";

/**
 * The server actions behind entry-rule waivers (R-59 / UC-14 3b).
 *
 * A separate file from `./actions.ts` and `./draft-actions.ts` for the same
 * reason those two are separate from each other: one subject per file, and the
 * tabs that call them are different screens. As thin as both — every rule about
 * what a waiver *is* lives in `src/lib/events.ts`, which is tested against real
 * Postgres.
 *
 * ## Authorising on the row that is about to be written
 *
 * A waiver is identified by (event, member, rule) — the event id is *part of
 * the row*, not an id sitting beside it — so `requireEventManager(eventId)` is
 * a check on the write itself, and the same verified id is what the write and
 * the audit line use. This is the rule `src/lib/event-scope.ts` sets out, and
 * the reason there is no `waiveByWaiverIdAction` here: a waiver id plus a
 * browser-supplied event id is precisely the shape that lets a host of event A
 * act on event B. The library functions take the pair and scope every statement
 * to it, so even a wrong id can only match nothing.
 *
 * The member id is not an authorisation subject — a manager may waive a rule
 * for anybody, which is the whole of R-59 — but it *is* half of the row's
 * identity, so it is passed through to the write rather than resolved from
 * anything the client said about an application.
 *
 * ## Every one of these writes a log line
 *
 * `recordAudit` is only ever called from the action layer, because this is the
 * only layer that knows who is acting (see the docblock in `src/lib/audit.ts`).
 * A waiver is an admin decision that changes who may play, so a waiver nobody
 * can trace afterwards would be the one kind of override the plan does not
 * allow. `waiver.granted` and `waiver.revoked` were added to `AUDIT_ACTIONS`
 * for this, which that map's docblock explicitly invites.
 */

import { revalidatePath } from "next/cache";
import type { EntryRule } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import {
  type EventResult,
  findMemberByHandle,
  listEntryWaivers,
  revokeEntryWaiver,
  waiveEntryRule,
} from "@/lib/events";
import { requireEventManager } from "@/lib/session-guards";

/** One waiver, trimmed to what the admin panel renders. */
export type WaiverRow = {
  userId: string;
  rule: EntryRule;
  /** Their display name, falling back to the handle and then to a placeholder. */
  member: string;
  handle: string | null;
  /** The manager who decided, as their name reads now. */
  grantedBy: string | null;
  waivedAt: Date;
};

/** What every action here hands back: the event's waivers, after the write. */
export type WaiverListResult = { waivers: WaiverRow[] };

/** The words the log line and the panel both use for a rule. */
const RULE_LABEL: Record<EntryRule, string> = {
  enter: "entry",
  captain: "captain",
};

function refresh(eventId: string): void {
  // The applicant list and the captain picker both read the gate, so both of
  // the pages that render them are stale the moment a waiver is written.
  revalidatePath(`/admin/events/${eventId}`);
}

async function waiverList(eventId: string): Promise<WaiverListResult> {
  const rows = await listEntryWaivers(eventId);
  return {
    waivers: rows.map((row) => ({
      userId: row.userId,
      rule: row.rule,
      member: row.member.displayName ?? row.member.handle ?? "Unknown member",
      handle: row.member.handle,
      grantedBy: row.grantedByName,
      waivedAt: row.waivedAt,
    })),
  };
}

/** This event's waivers. A read, so that a panel can show them before a write. */
export async function listEntryWaiversAction(
  eventId: string
): Promise<EventResult<WaiverListResult>> {
  await requireEventManager(eventId);
  return { ok: true, data: await waiverList(eventId) };
}

/**
 * Waive one rule for one member on this event.
 *
 * Used by the Captains tab's override (the `captain` rule) and by the
 * Applicants tab (the `enter` rule). The library makes a repeat grant a no-op
 * that returns the existing row, so a double-clicked button is not an error —
 * but it is also not a second log line.
 *
 * **Whether it is a repeat is the write's own answer.** `created` comes from
 * `onConflictDoNothing().returning()` inside the insert, so two managers
 * clicking at the same moment produce one row and one log line. Deciding it
 * here from a list read *before* the write would have both see "not there yet"
 * and both log, which is two "Entry rule waived" lines for one decision — and
 * it cost a second decorated read, with its `users` join, on every click.
 * `revokeEntryWaiverAction` below has always worked this way with `removed`;
 * the grant is now symmetrical with it.
 */
export async function waiveEntryRuleAction(
  eventId: string,
  userId: string,
  rule: EntryRule
): Promise<EventResult<WaiverListResult>> {
  const manager = await requireEventManager(eventId);

  const result = await waiveEntryRule(eventId, userId, rule, { by: manager.id });
  if (!result.ok) return result;

  if (result.data.created) {
    const name = result.data.member.displayName ?? result.data.member.handle ?? "a member";
    await recordAudit({
      action: "waiver.granted",
      actor: manager,
      eventId,
      // The member, not the waiver row: "who was let in" is what somebody
      // reading this line later is looking for.
      subject: userId,
      summary: `Waived the ${RULE_LABEL[rule]} rank rule for ${name}.`,
      detail: { rule, member: name },
    });
  }

  refresh(eventId);
  return { ok: true, data: await waiverList(eventId) };
}

/**
 * Waive the entry rule for somebody who cannot apply yet, by their handle.
 *
 * The case the Gate-2 amendment exists for: a below-rank member is refused by
 * `applyToEvent` before an application is stored, so they are on no list this
 * screen could offer. A handle is public — it is the `/players/[handle]`
 * segment — and asking for one keeps a *host* from being handed a directory of
 * every member on the site, which is a disclosure this feature does not need.
 */
export async function waiveEnterRuleByHandleAction(
  eventId: string,
  handle: string
): Promise<EventResult<WaiverListResult>> {
  await requireEventManager(eventId);

  const member = await findMemberByHandle(handle);
  if (!member) {
    return {
      ok: false,
      error: `Nobody on the site has the handle "${handle.trim()}". It is the last part of their player-profile link.`,
    };
  }

  return waiveEntryRuleAction(eventId, member.id, "enter");
}

/**
 * Withdraw a waiver.
 *
 * A mis-click that hands somebody a permanent way past a rule would be a worse
 * defect than the one the waiver fixes, so the decision is reversible — and the
 * reversal is logged in its own right, because "who took it away again" is the
 * same question as "who granted it".
 *
 * Nothing to withdraw is not an error: two managers pressing the same button is
 * not a failure anybody should have to read a message about.
 */
export async function revokeEntryWaiverAction(
  eventId: string,
  userId: string,
  rule: EntryRule
): Promise<EventResult<WaiverListResult>> {
  const manager = await requireEventManager(eventId);

  const before = await listEntryWaivers(eventId);
  const existing = before.find((row) => row.userId === userId && row.rule === rule);

  const result = await revokeEntryWaiver(eventId, userId, rule);
  if (!result.ok) return result;

  if (result.data.removed) {
    const name = existing?.member.displayName ?? existing?.member.handle ?? "a member";
    await recordAudit({
      action: "waiver.revoked",
      actor: manager,
      eventId,
      subject: userId,
      summary: `Withdrew the ${RULE_LABEL[rule]} rank waiver for ${name}.`,
      detail: { rule, member: name },
    });
  }

  refresh(eventId);
  return { ok: true, data: await waiverList(eventId) };
}
