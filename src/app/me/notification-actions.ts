"use server";

/**
 * A member's own notifications and switches.
 *
 * The user always comes from the session. Every one of these is keyed on it as
 * well as on whatever id was passed — marking a notification read takes the
 * owner *and* the id, so a guessed uuid marks nothing.
 */

import { revalidatePath } from "next/cache";
import type { NotificationKind } from "@/db/schema";
import { markAllRead, markRead, setPref } from "@/lib/notifications";
import { kindSpec } from "@/lib/notify-policy";
import { requireUser } from "@/lib/session-guards";

export type NotificationActionResult = { ok: true } | { ok: false; error: string };

function refresh(): void {
  revalidatePath("/me/notifications");
  revalidatePath("/me");
}

export async function markReadAction(id: string): Promise<NotificationActionResult> {
  const user = await requireUser();
  await markRead(user.id, id);
  refresh();
  return { ok: true };
}

export async function markAllReadAction(): Promise<NotificationActionResult> {
  const user = await requireUser();
  await markAllRead(user.id);
  refresh();
  return { ok: true };
}

/**
 * Flip one switch.
 *
 * A kind marked `fixed` cannot have its in-app channel turned off, and the
 * refusal is here rather than only on the screen — the switch is not rendered,
 * so anything that reaches this with `inApp: false` for one of them is not a
 * member clicking a button.
 */
export async function setNotificationPrefAction(
  kind: NotificationKind,
  channels: { inApp: boolean; discord: boolean }
): Promise<NotificationActionResult> {
  const user = await requireUser();

  const spec = kindSpec(kind);
  if (!spec) return { ok: false, error: "There is no such notification." };

  await setPref(user.id, kind, {
    inApp: spec.fixed ? true : channels.inApp,
    discord: channels.discord,
  });

  revalidatePath("/me/notifications");
  return { ok: true };
}
