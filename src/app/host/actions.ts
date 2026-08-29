"use server";

/**
 * Applying to host, and deciding those applications.
 *
 * Approving is the one action here that grants a permission, so it is also the
 * only one that does several things at once: it creates the event, makes the
 * applicant its host, and marks the application with what it became. All three
 * in a transaction — half of it happening leaves either an event nobody can
 * edit or a host of nothing.
 */

import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import { notifyHostDecision } from "@/lib/notify-events";
import { createEvent } from "@/lib/events";
import {
  type HostApplicationInput,
  applyToHost,
  approveHostApplication,
  declineHostApplication,
  getHostApplication,
  withdrawHostApplication,
} from "@/lib/hosting";
import { requireAdmin, requireUser } from "@/lib/session-guards";

export type HostActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function refresh(): void {
  revalidatePath("/host");
  revalidatePath("/admin/host");
  revalidatePath("/admin");
}

export async function applyToHostAction(
  input: HostApplicationInput
): Promise<HostActionResult<{ id: string }>> {
  const user = await requireUser();
  const result = await applyToHost(user.id, input);
  if (!result.ok) return result;

  await recordAudit({
    action: "host.applied",
    actor: user,
    summary: `Applied to host "${input.title.trim()}".`,
    detail: { applicationId: result.data.id, game: input.gameName },
  });

  refresh();
  return { ok: true, data: result.data };
}

/** Take your own back. Somebody else's is not yours to withdraw. */
export async function withdrawHostApplicationAction(
  id: string
): Promise<HostActionResult> {
  const user = await requireUser();
  const application = await getHostApplication(id);

  if (!application || application.by?.id !== user.id) {
    return { ok: false, error: "That is not yours to withdraw." };
  }
  if (application.status !== "pending") {
    return { ok: false, error: "That application has already been decided." };
  }

  await withdrawHostApplication(id);
  refresh();
  return { ok: true, data: undefined };
}

/**
 * Approve: create the event and hand it over.
 *
 * The event is a **draft**, titled from the application. Approving somebody to
 * run an evening is not the same as putting it on the calendar — the host
 * fills in the dates, the questions and the format, and publishes it
 * themselves, which they can because within this one event they have what an
 * admin has.
 *
 * The game and the questions are deliberately *not* created here. The
 * application says what they need; an admin reads it and sets the game up on
 * `/admin/games` if it does not exist yet. Guessing a game catalogue from free
 * text is how you end up with three spellings of the same game.
 */
export async function approveHostApplicationAction(
  id: string,
  note?: string
): Promise<HostActionResult<{ eventId: string }>> {
  const admin = await requireAdmin();

  const application = await getHostApplication(id);
  if (!application) return { ok: false, error: "That application has gone." };
  if (application.status !== "pending") {
    return { ok: false, error: "That application has already been decided." };
  }

  const created = await createEvent({ title: application.title });
  if (!created.ok) return { ok: false, error: created.error };

  const result = await approveHostApplication(id, admin.id, {
    note: note ?? null,
    eventId: created.data.id,
  });
  if (!result.ok) return result;

  await recordAudit({
    action: "host.approved",
    actor: admin,
    eventId: created.data.id,
    summary: `Approved ${application.by?.name ?? "somebody"} to host "${application.title}".`,
    detail: {
      applicationId: id,
      eventId: created.data.id,
      hostUserId: application.by?.id ?? null,
    },
  });

  if (application.by?.id) {
    notifyHostDecision(application.by.id, id, true, application.title, created.data.id);
  }

  refresh();
  revalidatePath("/admin/events");
  return { ok: true, data: { eventId: created.data.id } };
}

export async function declineHostApplicationAction(
  id: string,
  note?: string
): Promise<HostActionResult> {
  const admin = await requireAdmin();

  const application = await getHostApplication(id);
  if (!application) return { ok: false, error: "That application has gone." };
  if (application.status !== "pending") {
    return { ok: false, error: "That application has already been decided." };
  }

  await declineHostApplication(id, admin.id, note ?? null);

  await recordAudit({
    action: "host.declined",
    actor: admin,
    summary: `Declined a host application for "${application.title}".`,
    detail: { applicationId: id, note: note ?? null },
  });

  if (application.by?.id) {
    notifyHostDecision(application.by.id, id, false, application.title, null);
  }

  refresh();
  return { ok: true, data: undefined };
}
