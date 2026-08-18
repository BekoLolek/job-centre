"use server";

/**
 * The server actions behind `/admin/users`.
 *
 * Thin on purpose, exactly like `/admin/games`'s. Each one proves the caller is
 * an admin, hands its arguments to `src/lib/admin-users.ts` — which owns every
 * rule and is tested against real Postgres — and revalidates the page. There is
 * no business logic in this file and there must not be: a second copy of "can
 * this admin be revoked" is a second copy that drifts.
 *
 * `requireAdmin()` runs inside every action rather than being trusted from the
 * page that rendered the button. A server action is a public endpoint; the
 * page's guard proves nothing about who is calling it five minutes later. That
 * matters more here than anywhere else on the site, because the thing being
 * edited *is* who counts as an admin.
 *
 * ## Why the actor is passed down rather than read down there
 *
 * `revokeAdmin` needs to know who is clicking, to refuse a self-demotion.
 * `requireAdmin()`'s return value is the only place that is known — the rules
 * module takes a `Database` and is called by tests, so it cannot ask. Same
 * reason `recordAudit` lives at this layer and nowhere below it.
 */

import { revalidatePath } from "next/cache";
import {
  type AddNoteInput,
  type AdminUserResult,
  addUserNote,
  grantAdmin,
  listUserNotes,
  revokeAdmin,
} from "@/lib/admin-users";
import { recordAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/session-guards";

/** The members list, and the audit log that just grew a line. */
function refresh(): void {
  revalidatePath("/admin/users");
  revalidatePath("/admin/audit");
}

/* ------------------------------------------------------------------ */
/* The admin flag                                                     */
/* ------------------------------------------------------------------ */

export async function grantAdminAction(
  userId: string
): Promise<AdminUserResult<{ admins: number }>> {
  const admin = await requireAdmin();

  const result = await grantAdmin(userId);
  if (!result.ok) return result;

  await recordAudit({
    action: "user.admin.granted",
    actor: admin,
    subject: userId,
    summary: `Made ${result.data.user.displayName ?? result.data.user.name ?? "a member"} an admin.`,
    detail: { admins: result.data.admins },
  });

  refresh();
  return { ok: true, data: { admins: result.data.admins } };
}

/**
 * Take the admin flag away.
 *
 * The two refusals — your own flag, and the last one — are decided inside
 * `revokeAdmin` against a *fresh* count, not against whatever the page was
 * rendered with. Nothing is logged when it is refused, because nothing
 * happened.
 */
export async function revokeAdminAction(
  userId: string
): Promise<AdminUserResult<{ admins: number }>> {
  const admin = await requireAdmin();

  const result = await revokeAdmin(userId, admin.id);
  if (!result.ok) return result;

  await recordAudit({
    action: "user.admin.revoked",
    actor: admin,
    subject: userId,
    summary: `Removed admin from ${result.data.user.displayName ?? result.data.user.name ?? "a member"}.`,
    detail: { admins: result.data.admins },
  });

  refresh();
  return { ok: true, data: { admins: result.data.admins } };
}

/* ------------------------------------------------------------------ */
/* Notes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Read one member's notes.
 *
 * Behind `requireAdmin()` like everything else here — these are admin-only by
 * definition (§7), and the read path is the half that has to hold that as
 * firmly as the write path does.
 */
export async function listUserNotesAction(userId: string) {
  await requireAdmin();
  const notes = await listUserNotes(userId);
  return notes.map((note) => ({
    id: note.id,
    body: note.body,
    createdAt: note.createdAt,
    authorName: note.authorName,
    authorHandle: note.authorHandle,
  }));
}

/**
 * Write a note about a member.
 *
 * Append-only. The audit line says a note was added and about whom — never what
 * it said, for the same reason the log does not carry application answers.
 */
export async function addUserNoteAction(
  userId: string,
  body: string
): Promise<AdminUserResult<{ id: string }>> {
  const admin = await requireAdmin();

  const input: AddNoteInput = { body, author: admin };
  const result = await addUserNote(userId, input);
  if (!result.ok) return result;

  await recordAudit({
    action: "user.note",
    actor: admin,
    subject: userId,
    summary: "Added an admin note about a member.",
    detail: { length: result.data.body.length },
  });

  refresh();
  return { ok: true, data: { id: result.data.id } };
}
