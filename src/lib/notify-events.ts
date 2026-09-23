import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db, events } from "@/db";
import {
  applicantsOf,
  everyone,
  notify,
  seatHoldersOf,
} from "./notifications";
import { membersPlacedIn } from "./championship-policy";
import { scoringInputFor } from "./championship-results";
import { seasonOfEvent } from "./championship-season";

/**
 * The nine places the site has something to say, in one file.
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

/* ------------------------------------------------------------------ */
/* The championship                                                   */
/* ------------------------------------------------------------------ */

/**
 * A counting event was scored, so the table moved (R-193, UC-36 1-2).
 *
 * ## Who hears it
 *
 * **The people who played that event, and nobody else.** Not the season's
 * members, not everybody who has ever played in it: a season runs for months
 * and collects people who turned up once in March, and telling all of them
 * that the table moved because somebody else played last night is the kind of
 * notification a member switches off and never switches back on.
 *
 * So the audience comes from the event's own result — the finishing order
 * unfolded into the members it scores for (R-180: a team's place is every
 * member's), plus everybody who took part and was not placed, who scored the
 * taking-part points off the same night. That is `scoringInputFor`'s answer,
 * which is the one mapping from stored rows to what the arithmetic used, so
 * the set told is exactly the set whose points changed. Asking the season
 * instead would be a different question with a much longer answer.
 *
 * ## When it does not fire
 *
 * Three cases, all silent:
 *
 *  - **The event counts towards nothing**, so there is no table to move.
 *  - **The season is not published.** A hidden season is an admin's draft
 *    (R-189), and a notification naming it would tell forty people it exists —
 *    the one thing the status is for. A closed season cannot get here at all:
 *    `setPlacements` refuses the write that triggers this.
 *  - **Nothing is recorded on the event.** Clearing an order is an admin
 *    undoing a mistake, usually a keystroke before recording the right one.
 *    An event with no order has not counted (`seasonPage` draws that line),
 *    and "the standings have changed" is not the honest thing to say about a
 *    night that has now not been played.
 *
 * Collapsed by the day rather than for ever, exactly as an event's details
 * moving is: a host who corrects a typo four times this evening has produced
 * one piece of news, and a correction next week is news again (UC-33 4a).
 */
export function notifyStandingsChanged(eventId: string, exceptUserId?: string): void {
  defer(async () => {
    const season = await seasonOfEvent(eventId);
    if (!season || season.status !== "published") return;

    const [event, scoring] = await Promise.all([
      eventBrief(eventId),
      scoringInputFor(eventId),
    ]);
    if (!event || !scoring || scoring.placements.length === 0) return;

    const played = [
      ...new Set([...membersPlacedIn(scoring.placements), ...scoring.participants]),
    ];

    await notify({
      kind: "standings_changed",
      userIds: played,
      title: `The ${season.name} standings have changed`,
      body: `${event.title} has been scored. Your place in the table may have moved.`,
      href: `/championship/${season.slug}`,
      eventId: event.id,
      subject: event.id,
      daily: true,
      exceptUserId,
    });
  });
}
