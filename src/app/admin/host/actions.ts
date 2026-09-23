"use server";

/**
 * Deciding a host application (UC-21).
 *
 * The three steps of the use case are three actions, in the order an admin does
 * them:
 *
 *  1. `createEventFromApplicationAction` — UC-21 2. The event is built *from*
 *     the application: its name, its game, and one question per line of what
 *     the applicant said they need to know about each player.
 *  2. `approveHostApplicationAction` — UC-21 3/4. Approving links that event
 *     and hands the keys over.
 *  3. `declineHostApplicationAction` — UC-21 3a. With a reason, always.
 *
 * ## Why these are not in `/app/host/actions.ts` with the member's two
 *
 * Every exported function in a `"use server"` module is a POST endpoint that
 * anybody who can reach the site can call, whether or not the UI ever renders a
 * button for it (Next.js "Server Actions and Mutations" → Security). Approving
 * is the one action on this site that hands out a permission, so it lives with
 * the admin screen that calls it, next to the guard that protects it, rather
 * than in a module whose other exports are for every signed-in member.
 *
 * ## Authorisation
 *
 * `requireAdmin()`, every time and first. A host is not a small admin: UC-27 1a
 * says a host reaching any of `/admin` is refused, and that includes the
 * actions behind it — deciding who gets to host is exactly the power a host
 * must not be able to hand themselves. Beyond that, the library authorises on
 * the rows it writes: `approveHostApplication` re-reads the application and the
 * event inside its own transaction and refuses an event somebody already hosts,
 * because `eventId` arrives from the browser.
 */

import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import { createEvent, setEventQuestions } from "@/lib/events";
import {
  type HostResult,
  approveHostApplication,
  declineHostApplication,
  getHostApplication,
  questionsFromApplication,
} from "@/lib/hosting";
import { notifyHostDecision } from "@/lib/notify-events";
import { requireAdmin } from "@/lib/session-guards";

function refresh(): void {
  revalidatePath("/host");
  revalidatePath("/admin/host");
  revalidatePath("/admin");
}

/**
 * Create the event this application describes (UC-21 2).
 *
 * A draft, with the applicant's own words in it: the title, the game if they
 * picked one this site already knows, and the questions. It is not approved by
 * doing this and nobody is granted anything — the admin now has an event to
 * read through, fix and then approve onto, which is the order the use case puts
 * those steps in and the order that lets an admin change their mind.
 *
 * The game is only attached when the applicant chose one from the catalogue. A
 * game typed as free text stays free text: guessing a catalogue from it is how
 * you end up with three spellings of the same game.
 *
 * Questions are written in a second call, so a question set the event refuses
 * (too many, or nothing but blank lines) refuses the questions and not the
 * event — the admin gets the event, and the reason the prefill did not stick.
 */
export async function createEventFromApplicationAction(
  id: string
): Promise<HostResult<{ eventId: string; questions: number; note: string | null }>> {
  const admin = await requireAdmin();

  const application = await getHostApplication(id);
  if (!application) return { ok: false, error: "That application has gone." };
  if (application.status !== "pending") {
    return { ok: false, error: "That application has already been decided." };
  }

  const created = await createEvent({
    title: application.title,
    gameId: application.gameId,
    createdBy: admin.id,
  });
  if (!created.ok) return { ok: false, error: created.error };

  const questions = questionsFromApplication(application.playerInfoNeeded);
  const written =
    questions.length > 0 ? await setEventQuestions(created.data.id, questions) : null;

  await recordAudit({
    action: "event.created",
    actor: admin,
    eventId: created.data.id,
    subject: id,
    summary: `Created "${created.data.title}" from ${application.by?.name ?? "somebody"}'s host application.`,
    detail: {
      applicationId: id,
      slug: created.data.slug,
      questions: written?.ok ? written.data.questions.length : 0,
    },
  });

  refresh();
  revalidatePath("/admin/events");

  return {
    ok: true,
    data: {
      eventId: created.data.id,
      questions: written?.ok ? written.data.questions.length : 0,
      // Said plainly rather than swallowed: the admin is about to look at a
      // Questions tab and needs to know the prefill is not there.
      note:
        written && !written.ok
          ? `The event was created, but the questions were not: ${written.error}`
          : null,
    },
  };
}

/**
 * Approve, linking the event (UC-21 3, 4).
 *
 * The event id comes from the admin's screen and is checked against the row it
 * is about to write — see `approveHostApplication`. Nothing is granted, logged
 * or notified unless that write went through.
 */
export async function approveHostApplicationAction(
  id: string,
  input: { eventId: string; note?: string }
): Promise<HostResult<{ eventId: string }>> {
  const admin = await requireAdmin();

  const application = await getHostApplication(id);
  if (!application) return { ok: false, error: "That application has gone." };
  if (application.status !== "pending") {
    return { ok: false, error: "That application has already been decided." };
  }

  const result = await approveHostApplication(id, admin.id, {
    note: input.note ?? null,
    eventId: input.eventId,
  });
  if (!result.ok) return result;

  await recordAudit({
    action: "host.approved",
    actor: admin,
    eventId: result.data.eventId,
    subject: id,
    summary: `Approved ${application.by?.name ?? "somebody"} to host "${application.title}".`,
    detail: {
      applicationId: id,
      eventId: result.data.eventId,
      hostUserId: application.by?.id ?? null,
    },
  });

  if (application.by?.id) {
    notifyHostDecision(application.by.id, id, true, application.title, result.data.eventId);
  }

  refresh();
  revalidatePath("/admin/events");
  return result;
}

/**
 * Decline, with a reason (UC-21 3a).
 *
 * The reason is the whole of what the applicant gets back, so an empty one is
 * refused by the library before anything is written — and nothing is logged or
 * notified on a refusal, because nothing was decided.
 */
export async function declineHostApplicationAction(
  id: string,
  note: string
): Promise<HostResult<null>> {
  const admin = await requireAdmin();

  const application = await getHostApplication(id);
  if (!application) return { ok: false, error: "That application has gone." };
  if (application.status !== "pending") {
    return { ok: false, error: "That application has already been decided." };
  }

  const result = await declineHostApplication(id, admin.id, note);
  if (!result.ok) return result;

  await recordAudit({
    action: "host.declined",
    actor: admin,
    subject: id,
    summary: `Declined a host application for "${application.title}".`,
    detail: { applicationId: id, note: note.trim() },
  });

  if (application.by?.id) {
    notifyHostDecision(application.by.id, id, false, application.title, null);
  }

  refresh();
  return result;
}
