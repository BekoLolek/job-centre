import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db, events } from "@/db";
import {
  applicantsOf,
  everyone,
  notify,
  seatHoldersOf,
} from "./notifications";

/**
 * The eight places the site has something to say, in one file.
 *
 * Each is a small function an action calls and forgets. They are here rather
 * than inline in the actions for the same reason the announcements are in
 * `discord.ts`: an action should say *what happened*, and everything about who
 * hears it, in what words, and whether it is worth saying twice belongs
 * somewhere a person can read all of it at once.
 *
 * Every one is deferred. Fanning out to two hundred members is a write per
 * member, and nobody clicking "publish" is waiting for that — the same bargain
 * announcements make, and it uses the same `after()`.
 */

function defer(work: () => Promise<void>): void {
  try {
    after(work);
  } catch {
    // Outside a request scope — a script, a test, the reminder job. Run it now
    // and swallow, exactly as the announcements do.
    void work().catch((error: unknown) => {
      console.error("[notify] failed outside a request scope", error);
    });
  }
}

async function eventBrief(
  eventId: string
): Promise<{ id: string; title: string; slug: string } | null> {
  const [row] = await db
    .select({ id: events.id, title: events.title, slug: events.slug })
    .from(events)
    .where(eq(events.id, eventId));
  return row ?? null;
}

/* ------------------------------------------------------------------ */
/* Events                                                             */
/* ------------------------------------------------------------------ */

/** A new event is up. Everybody, once ever. */
export function notifyEventPublished(eventId: string, exceptUserId?: string): void {
  defer(async () => {
    const event = await eventBrief(eventId);
    if (!event) return;
    await notify({
      kind: "event_published",
      userIds: await everyone(),
      title: event.title,
      body: "A new event is up. Applications are open if the window says so.",
      href: `/events/${event.slug}`,
      eventId: event.id,
      subject: event.id,
      exceptUserId,
    });
  });
}

/**
 * The details moved. Anybody who applied, once a day.
 *
 * Daily rather than once ever: an admin who nudges the start time on Tuesday
 * and again on Thursday has produced two pieces of news, and an admin who
 * nudges it four times on Tuesday has produced one.
 */
export function notifyEventUpdated(eventId: string, exceptUserId?: string): void {
  defer(async () => {
    const event = await eventBrief(eventId);
    if (!event) return;
    await notify({
      kind: "event_updated",
      userIds: await applicantsOf(event.id),
      title: `${event.title} has changed`,
      body: "The dates or the details moved. Worth a look if you are counting on it.",
      href: `/events/${event.slug}`,
      eventId: event.id,
      subject: event.id,
      daily: true,
      exceptUserId,
    });
  });
}

/** It is off. Anybody who applied — including the declined, who deserve to know. */
export function notifyEventCancelled(eventId: string, exceptUserId?: string): void {
  defer(async () => {
    const event = await eventBrief(eventId);
    if (!event) return;
    await notify({
      kind: "event_cancelled",
      userIds: await applicantsOf(event.id),
      title: `${event.title} has been called off`,
      body: "Your application stays on the record. Nothing else is needed from you.",
      href: `/events/${event.slug}`,
      eventId: event.id,
      subject: event.id,
      exceptUserId,
    });
  });
}

/**
 * The sign-up questions changed after people answered them.
 *
 * Only people who already applied, because for anybody else it is not news —
 * they will simply see the current questions when they apply.
 */
export function notifyQuestionsChanged(eventId: string, exceptUserId?: string): void {
  defer(async () => {
    const event = await eventBrief(eventId);
    if (!event) return;
    await notify({
      kind: "questions_changed",
      userIds: await applicantsOf(event.id),
      title: `The questions for ${event.title} have changed`,
      body: "Check your answers still say what you meant — there may be a new one to fill in.",
      href: `/me/events`,
      eventId: event.id,
      subject: event.id,
      daily: true,
      exceptUserId,
    });
  });
}

/** Starting tomorrow. Used by the reminder job; kept here for symmetry. */
export function notifyStartingSoon(eventId: string): void {
  defer(async () => {
    const event = await eventBrief(eventId);
    if (!event) return;
    await notify({
      kind: "event_reminder",
      userIds: await seatHoldersOf(event.id),
      title: `${event.title} starts tomorrow`,
      body: "You have a seat. Check the time and tell an admin if you cannot make it.",
      href: `/events/${event.slug}`,
      eventId: event.id,
      subject: event.id,
    });
  });
}

/* ------------------------------------------------------------------ */
/* People                                                             */
/* ------------------------------------------------------------------ */

/**
 * The answer to somebody's application.
 *
 * Cannot be muted — see `notify-policy.ts`. The subject carries the status as
 * well as the event, so somebody promoted off the waitlist a week later is
 * told about the promotion rather than silently deduped against the first
 * answer.
 */
export function notifyApplicationDecided(
  eventId: string,
  userId: string,
  status: "accepted" | "waitlisted" | "declined"
): void {
  defer(async () => {
    const event = await eventBrief(eventId);
    if (!event) return;

    const said =
      status === "accepted"
        ? { title: `You're in for ${event.title}`, body: "Your seat is confirmed." }
        : status === "waitlisted"
          ? {
              title: `You're in the queue for ${event.title}`,
              body: "The cap is full for now. You move up when somebody withdraws.",
            }
          : {
              title: `Your application to ${event.title} was declined`,
              body: null,
            };

    await notify({
      kind: "application_decided",
      userIds: [userId],
      title: said.title,
      body: said.body,
      href: "/me/events",
      eventId: event.id,
      subject: `${event.id}:${status}`,
    });
  });
}

/** Your application to run something was decided. Cannot be muted either. */
export function notifyHostDecision(
  userId: string,
  applicationId: string,
  approved: boolean,
  title: string,
  eventId?: string | null
): void {
  defer(async () => {
    await notify({
      kind: "host_decision",
      userIds: [userId],
      title: approved
        ? `You're hosting ${title}`
        : `Your application to host ${title} was declined`,
      body: approved
        ? "The event is yours to set up and run. It is a draft until you publish it."
        : "There should be a note on it saying why.",
      href: approved && eventId ? `/admin/events/${eventId}` : "/host",
      eventId: eventId ?? null,
      subject: applicationId,
    });
  });
}

/* ------------------------------------------------------------------ */
/* Polls                                                              */
/* ------------------------------------------------------------------ */

export function notifyPollPosted(
  pollId: string,
  question: string,
  exceptUserId?: string
): void {
  defer(async () => {
    await notify({
      kind: "poll_posted",
      userIds: await everyone(),
      title: "There's a new poll",
      body: question,
      href: "/polls",
      subject: pollId,
      exceptUserId,
    });
  });
}
