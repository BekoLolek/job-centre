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
import { eq } from "drizzle-orm";
import { db, users } from "@/db";
import {
  type AddNoteInput,
  type AdminUserResult,
  addUserNote,
  grantAdmin,
  listUserNotes,
  revokeAdmin,
} from "@/lib/admin-users";
import { allowAdmin, barAdmin, countAdmins, forgetAdmin } from "@/lib/admin-allowlist";
import { revokeRefusal } from "@/lib/admin-users-policy";
import { normaliseDiscordId } from "@/lib/auth-policy";
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

/* ------------------------------------------------------------------ */
/* The allowlist                                                      */
/* ------------------------------------------------------------------ */

export type AllowlistActionResult = { ok: true; said: string } | { ok: false; error: string };

/**
 * Pre-authorise a Discord id.
 *
 * No guard beyond the id being an id: going from one admin to two takes
 * nothing away from anybody, which is the same reason `grantAdmin` has no
 * refusal either.
 */
export async function allowAdminAction(input: {
  discordId: string;
  note?: string;
}): Promise<AllowlistActionResult> {
  const admin = await requireAdmin();

  const result = await allowAdmin(
    input.discordId,
    { note: input.note ?? null, addedByUserId: admin.id },
    undefined
  );
  if (!result.ok) return result;

  await recordAudit({
    action: "user.admin.granted",
    actor: admin,
    summary: `Added ${result.data.discordId} to the admin allowlist.`,
    detail: { discordId: result.data.discordId, promotedNow: result.data.promotedNow },
  });

  revalidatePath("/admin/users");
  return {
    ok: true,
    said: result.data.promotedNow
      ? "Added, and they are an admin now."
      : "Added. They become an admin the first time they sign in.",
  };
}

/**
 * Bar a Discord id for good, or hand the decision back to the environment.
 *
 * The two refusals are the same ones `revokeAdmin` makes, and for the same
 * reasons — barring is a demotion with a longer memory, so it cannot be
 * allowed to do anything a demotion could not.
 *
 * They are re-checked here rather than trusted from the browser: a page loaded
 * when there were three admins is not evidence that there still are.
 */
export async function barAdminAction(input: {
  discordId: string;
  note?: string;
  /** Forget the row instead of barring — undo a mistake, not remove somebody. */
  forget?: boolean;
}): Promise<AllowlistActionResult> {
  const admin = await requireAdmin();

  const id = normaliseDiscordId(input.discordId);
  if (!id) return { ok: false, error: "That is not a Discord id." };

  if (!input.forget) {
    const [target] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.discordId, id));

    // Only a bar that would actually demote somebody can lock anybody out.
    if (target) {
      const refusal = revokeRefusal({
        actorId: admin.id,
        targetId: target.id,
        adminCount: await countAdmins(),
      });
      if (refusal) return { ok: false, error: refusal };
    }
  }

  if (input.forget) {
    await forgetAdmin(id);
    await recordAudit({
      action: "user.admin.revoked",
      actor: admin,
      summary: `Removed ${id} from the admin allowlist.`,
      detail: { discordId: id, forgotten: true },
    });
    revalidatePath("/admin/users");
    return {
      ok: true,
      said: "Removed from the list. ADMIN_DISCORD_IDS decides again for that id.",
    };
  }

  const result = await barAdmin(id, { note: input.note ?? null, addedByUserId: admin.id });
  if (!result.ok) return result;

  await recordAudit({
    action: "user.admin.revoked",
    actor: admin,
    summary: `Barred ${id} from ever being an admin.`,
    detail: { discordId: id, demotedNow: result.data.demotedNow, barred: true },
  });

  revalidatePath("/admin/users");
  return {
    ok: true,
    said: result.data.demotedNow
      ? "Barred, and their admin flag is off."
      : "Barred. They cannot become an admin on sign-in.",
  };
}
