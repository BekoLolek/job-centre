import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  type Database,
  type NotificationKind,
  applications,
  confirmations,
  db as defaultDb,
  eventDays,
  events,
  notificationDmClaims,
  notificationPrefs,
  notifications,
  users,
} from "@/db";
import { CONFIRMATION_LEAD_MS, eventDates } from "./events-policy";
import {
  type PrefOverride,
  channelsFor,
  dayStamp,
  dedupeKey,
} from "./notify-policy";
import { directMessagesConfigured, sendDirectMessage } from "./discord-dm";

export * from "./notify-policy";

/**
 * Telling people things.
 *
 * One entry point — {@link notify} — and everything about who gets what lives
 * either in it or in `notify-policy.ts`. Callers say *what happened* and to
 * *whom it is relevant*; they do not decide whether it is delivered, because
 * that depends on preferences they have no reason to know about.
 *
 * ## Fan-out, and why it is safe to repeat
 *
 * A row per recipient, inserted with `onConflictDoNothing` against
 * `(userId, dedupeKey)`. That one constraint is what lets every trigger be
 * careless: an admin who saves the questions five times sends five times and
 * produces one notification, a reminder job that runs twice writes once, and a
 * retry after a half-failure fills in only the gaps.
 *
 * ## Discord
 *
 * Off by default on every kind, and a no-op entirely until a bot token exists
 * — see `discord-dm.ts`. Direct messages are also sent *after* the response,
 * like announcements, because nobody is waiting for them and Discord being
 * slow must never be something a member feels.
 */

export const PAGE_SIZE = 30;

export type Notification = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  href: string | null;
  eventId: string | null;
  readAt: Date | null;
  createdAt: Date;
};

export type NotifyInput = {
  kind: NotificationKind;
  /** Who it is relevant to. Preferences are applied here, not by the caller. */
  userIds: readonly string[];
  title: string;
  body?: string | null;
  href?: string | null;
  eventId?: string | null;
  /** What makes this piece of news distinct — see `dedupeKey`. */
  subject: string;
  /** Collapse repeats within a day rather than for ever. */
  daily?: boolean;
  /**
   * Somebody who caused the news and should not be told about it. An admin who
   * edits the questions does not need telling that the questions changed.
   */
  exceptUserId?: string | null;
};

/* ------------------------------------------------------------------ */
/* Sending                                                            */
/* ------------------------------------------------------------------ */

export async function notify(
  input: NotifyInput,
  database: Database = defaultDb
): Promise<{ delivered: number; discord: number }> {
  const recipients = [...new Set(input.userIds)].filter(
    (id) => id && id !== input.exceptUserId
  );
  if (recipients.length === 0) return { delivered: 0, discord: 0 };

  const key = dedupeKey(
    input.kind,
    input.subject,
    input.daily ? dayStamp() : undefined
  );

  const overrides = await database
    .select({
      userId: notificationPrefs.userId,
      kind: notificationPrefs.kind,
      inApp: notificationPrefs.inApp,
      discord: notificationPrefs.discord,
    })
    .from(notificationPrefs)
    .where(
      and(
        inArray(notificationPrefs.userId, recipients),
        eq(notificationPrefs.kind, input.kind)
      )
    );

  const byUser = new Map<string, PrefOverride[]>();
  for (const row of overrides) {
    const list = byUser.get(row.userId) ?? [];
    list.push({ kind: row.kind, inApp: row.inApp, discord: row.discord });
    byUser.set(row.userId, list);
  }

  const wantsInApp: string[] = [];
  const wantsDiscord: string[] = [];
  for (const userId of recipients) {
    const channels = channelsFor(input.kind, byUser.get(userId) ?? null);
    if (channels.inApp) wantsInApp.push(userId);
    if (channels.discord) wantsDiscord.push(userId);
  }

  let delivered = 0;
  if (wantsInApp.length > 0) {
    const written = await database
      .insert(notifications)
      .values(
        wantsInApp.map((userId) => ({
          userId,
          kind: input.kind,
          title: input.title,
          body: input.body ?? null,
          href: input.href ?? null,
          eventId: input.eventId ?? null,
          dedupeKey: key,
        }))
      )
      .onConflictDoNothing({
        target: [notifications.userId, notifications.dedupeKey],
      })
      .returning({ id: notifications.id });
    delivered = written.length;
  }

  /*
   * The DM has its own claim on the same key, separate from the in-app insert.
   * Somebody who has already been messaged about this is not messaged again —
   * that is the whole point of the dedupe key, and it would be an odd feature
   * that suppressed the quiet channel and not the loud one.
   *
   * It cannot piggyback on the in-app rows, because somebody who has switched
   * the bell off but the DM on is a real configuration: there is no row for
   * them, and nothing else would stop a repeat.
   */
  const discord =
    wantsDiscord.length > 0
      ? await claimForDiscord(database, wantsDiscord, key, input)
      : 0;

  return { delivered, discord };
}

/**
 * Claim the key for each person who can be messaged, then message only those
 * the claim was new for, and say how many went.
 *
 * A claim means "about to message this person", so nobody is claimed while
 * there is no bot, or for somebody with no Discord account: either would use up
 * the key, and the same news could never reach them once the bot or the
 * account appeared.
 *
 * Claim first, send second: two overlapping runs cannot both win the insert, so
 * neither can both send. The price is that a DM which fails after its claim is
 * never retried — logged and dropped, the same bargain `deliver` in
 * `discord.ts` makes — and a missed message is the better failure than a
 * repeated one.
 *
 * Deliberately not transactional with the in-app insert: a Discord outage must
 * not roll back a notification anybody can already see on the site.
 */
async function claimForDiscord(
  database: Database,
  userIds: readonly string[],
  key: string,
  input: NotifyInput
): Promise<number> {
  if (!directMessagesConfigured()) return 0;

  const people = await database
    .select({ id: users.id, discordId: users.discordId })
    .from(users)
    .where(and(inArray(users.id, [...userIds]), isNotNull(users.discordId)));
  if (people.length === 0) return 0;

  const claimed = await database
    .insert(notificationDmClaims)
    .values(people.map((person) => ({ userId: person.id, dedupeKey: key })))
    .onConflictDoNothing({
      target: [notificationDmClaims.userId, notificationDmClaims.dedupeKey],
    })
    .returning({ userId: notificationDmClaims.userId });
  const fresh = new Set(claimed.map((row) => row.userId));

  let sent = 0;
  for (const person of people) {
    if (!person.discordId || !fresh.has(person.id)) continue;
    const ok = await sendDirectMessage(person.discordId, {
      title: input.title,
      body: input.body ?? null,
      href: input.href ?? null,
      key,
    });
    if (ok) sent += 1;
  }
  return sent;
}

/* ------------------------------------------------------------------ */
/* Audiences                                                          */
/* ------------------------------------------------------------------ */

/**
 * Everybody who could be told anything.
 *
 * Members who have signed in at least once, which is every row in `users` —
 * an account exists because somebody signed in. Admins included: they are
 * members too, and an admin who does not want to hear about new events can
 * switch it off like anybody else.
 */
export async function everyone(database: Database = defaultDb): Promise<string[]> {
  const rows = await database.select({ id: users.id }).from(users);
  return rows.map((row) => row.id);
}

/** Everybody who applied to this event, whatever the answer was. */
export async function applicantsOf(
  eventId: string,
  database: Database = defaultDb
): Promise<string[]> {
  const rows = await database
    .select({ userId: applications.userId })
    .from(applications)
    .where(eq(applications.eventId, eventId));
  return [...new Set(rows.map((row) => row.userId))];
}

/**
 * The people who have a seat — **accepted only**.
 *
 * R-97 is "remind me the day before an event *I have a seat in*", and the
 * queue is deliberately not in it: somebody third in line has no seat and
 * nowhere to turn up to, "you have a seat — check the time" is not true of
 * them, and a reminder about an event they are not in is the kind of
 * notification that gets the whole kind switched off (R-104). If a seat frees
 * they are promoted and told so there and then (R-55, `freeSeat`), which is
 * the notification that is actually about them.
 *
 * This replaces an `accepted`-or-`waitlisted` version. `seatHoldersAwaitingAnswer`
 * below is the one audience that still keeps the queue, and says why.
 */
export async function seatedMembersOf(
  eventId: string,
  database: Database = defaultDb
): Promise<string[]> {
  const rows = await database
    .select({ userId: applications.userId, status: applications.status })
    .from(applications)
    .where(eq(applications.eventId, eventId));
  return [
    ...new Set(rows.filter((row) => row.status === "accepted").map((row) => row.userId)),
  ];
}

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

export async function listNotifications(
  userId: string,
  database: Database = defaultDb,
  limit = PAGE_SIZE
): Promise<Notification[]> {
  return database
    .select({
      id: notifications.id,
      kind: notifications.kind,
      title: notifications.title,
      body: notifications.body,
      href: notifications.href,
      eventId: notifications.eventId,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .where(eq(notifications.userId, userId))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function unreadCount(
  userId: string,
  database: Database = defaultDb
): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return row?.count ?? 0;
}

/** Mark one as read. Keyed on the owner too, so an id alone is not enough. */
export async function markRead(
  userId: string,
  notificationId: string,
  database: Database = defaultDb
): Promise<void> {
  await database
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(eq(notifications.id, notificationId), eq(notifications.userId, userId))
    );
}

export async function markAllRead(
  userId: string,
  database: Database = defaultDb
): Promise<void> {
  await database
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
}

/* ------------------------------------------------------------------ */
/* Preferences                                                        */
/* ------------------------------------------------------------------ */

export async function getPrefs(
  userId: string,
  database: Database = defaultDb
): Promise<PrefOverride[]> {
  const rows = await database
    .select({
      kind: notificationPrefs.kind,
      inApp: notificationPrefs.inApp,
      discord: notificationPrefs.discord,
    })
    .from(notificationPrefs)
    .where(eq(notificationPrefs.userId, userId));
  return rows;
}

/**
 * Write one switch.
 *
 * Every kind gets a row once it is touched, including one that matches the
 * default. Deleting rows that agree with the default would be tidier and
 * wrong: the default may change, and somebody who deliberately chose today's
 * default should not be moved when it does.
 */
export async function setPref(
  userId: string,
  kind: NotificationKind,
  channels: { inApp: boolean; discord: boolean },
  database: Database = defaultDb
): Promise<void> {
  await database
    .insert(notificationPrefs)
    .values({ userId, kind, inApp: channels.inApp, discord: channels.discord })
    .onConflictDoUpdate({
      target: [notificationPrefs.userId, notificationPrefs.kind],
      set: { inApp: channels.inApp, discord: channels.discord, updatedAt: new Date() },
    });
}

/* ------------------------------------------------------------------ */
/* Reminders                                                          */
/* ------------------------------------------------------------------ */

/**
 * Events starting within `within`, for the reminder job.
 *
 * A window rather than a moment: a job that runs once a day, somewhere inside
 * its hour, must not need to catch an event at exactly the right tick, and the
 * dedupe key means overlapping runs cost one insert attempt each and change
 * nothing. See `REMINDER_WINDOW_MS` for why the window is wider than a day.
 *
 * **When an event starts is its first day's start** (R-24): the join below is
 * what makes "starting soon" mean the same thing here as it does on the hub and
 * on the member's own page, and an event whose days have been moved is reminded
 * about on its new date without anything having to be kept in step.
 * `eventDates` holds the arithmetic — an event with no dated day has no start,
 * so it is not starting soon and never appears (UC-25 10a).
 */
export async function eventsStartingSoon(
  within = REMINDER_WINDOW_MS,
  now: Date = new Date(),
  database: Database = defaultDb
): Promise<Array<{ id: string; title: string; slug: string; startsAt: Date }>> {
  const rows = await database
    .select({
      id: events.id,
      title: events.title,
      slug: events.slug,
      status: events.status,
      dayStartsAt: eventDays.startsAt,
    })
    .from(events)
    .leftJoin(eventDays, eq(eventDays.eventId, events.id));

  const byEvent = new Map<
    string,
    { id: string; title: string; slug: string; days: Array<{ startsAt: Date | null }> }
  >();
  for (const row of rows) {
    if (row.status !== "published" && row.status !== "live") continue;
    const bag =
      byEvent.get(row.id) ?? { id: row.id, title: row.title, slug: row.slug, days: [] };
    if (row.dayStartsAt !== null) bag.days.push({ startsAt: row.dayStartsAt });
    byEvent.set(row.id, bag);
  }

  return [...byEvent.values()].flatMap((event) => {
    const { startsAt } = eventDates(event.days);
    if (startsAt === null) return [];
    const delta = startsAt.getTime() - now.getTime();
    if (delta <= 0 || delta > within) return [];
    return [{ id: event.id, title: event.title, slug: event.slug, startsAt }];
  });
}

/**
 * How far ahead a reminder run looks.
 *
 * The job runs once a day (Vercel Hobby allows nothing more often), and Hobby
 * only promises the hour, so two runs can be as much as 24h59m apart. A window
 * of exactly a day therefore has a gap: an event starting between the two runs
 * is too far out for the first and already started by the second. 36 hours
 * closes it with room to spare, and from the midday run in `vercel.json` it is
 * precisely "the rest of today and all of tomorrow" in UTC. The overlap between
 * runs costs nothing, because the dedupe key makes a second reminder a no-op.
 */
export const REMINDER_WINDOW_MS = 36 * 60 * 60 * 1000;

/**
 * How far ahead the *answer* ask looks — 84 hours (R-200, UC-25 10).
 *
 * ## The problem the number solves
 *
 * R-200 closes the "still coming?" answer at `CONFIRMATION_LEAD_MS` — 48 hours
 * — before the start. The day-before reminder above looks 36 hours ahead, and
 * 36 is less than 48, so **every** run of it fires after the answer has already
 * closed: an event is only inside that window once `now > T − 48h`. It can tell
 * you to turn up; it can no longer ask you anything. Something has to reach the
 * member *before* T − 48h, and it has to do so from the same once-a-day cron.
 *
 * ## The arithmetic, the same way `REMINDER_WINDOW_MS` does it
 *
 * Let T be the start, D = T − 48h the deadline, and W this window, so a run at
 * time `r` picks the event up while `48h < T − r ≤ W`.
 *
 * For the ask to be guaranteed to land in time, some run must fall inside
 * `[T − W, D]` — late enough to see the event, early enough to still be before
 * the deadline. That interval is `W − 48h` long. Hobby cron fires once a day
 * and only promises the hour, so consecutive runs can be **24h59m** apart;
 * a closed interval is certain to contain a run only once it is at least that
 * long. So:
 *
 *     W − 48h ≥ 24h59m   →   W ≥ 72h59m
 *
 * 84 hours is `48h + 36h`: the deadline, plus the look-ahead the day-before
 * reminder already uses. That is not a coincidence dressed up as a reason — it
 * is the *same* problem displaced by 48 hours, because "reach somebody before
 * T − 48h" is "reach somebody before T" with the clock moved, and 36h was
 * already chosen to cover a 24h59m gap with room to spare. It leaves the same
 * 11h01m of slack, and from the midday run in `vercel.json` it means an event
 * starting the day after tomorrow or the day after that is asked about today.
 *
 * The lower bound matters as much as the upper one: the window starts *at* the
 * deadline, so an event already inside 48 hours is never asked. The one
 * notification that would be a lie — "answer before it closes", sent after it
 * closed — is the one this window cannot produce.
 *
 * Overlap is free, as above: the dedupe key is the kind and the event, so the
 * two or three runs that see the same event between T − 84h and T − 48h write
 * one notification (UC-25 10b).
 */
export const CONFIRMATION_ASK_WINDOW_MS = CONFIRMATION_LEAD_MS + REMINDER_WINDOW_MS;

/**
 * Seat holders whose "still coming?" answer is not settled — nobody has
 * answered, or they answered "not sure yet".
 *
 * The audience for the ask, and the one place the queue is still included:
 * "are you still coming?" is a question a waitlisted member can answer
 * usefully, because they are who the seat goes to if somebody says no — which
 * is what makes this wider than the day-before reminder's audience
 * (`seatedMembersOf`, R-97). It is narrower in the other direction, though:
 * telling somebody who has already said "I'll be there" to answer is the kind
 * of notification that gets a switch thrown. A `maybe` *is* unsettled (R-199,
 * UC-13 extensions E4) — it is precisely the answer the deadline is about to
 * freeze — so they are asked again while they can still change it.
 *
 * The left join is filtered in TypeScript rather than in SQL for the same
 * reason `seatedMembersOf` counts statuses that way: one row per applicant is
 * nothing to carry, and a `where` on an enum literal is one more place the
 * three answers are spelled out.
 */
export async function seatHoldersAwaitingAnswer(
  eventId: string,
  database: Database = defaultDb
): Promise<string[]> {
  const rows = await database
    .select({
      userId: applications.userId,
      status: applications.status,
      answer: confirmations.state,
    })
    .from(applications)
    .leftJoin(confirmations, eq(confirmations.applicationId, applications.id))
    .where(eq(applications.eventId, eventId));

  return [
    ...new Set(
      rows
        .filter((row) => row.status === "accepted" || row.status === "waitlisted")
        .filter((row) => row.answer === null || row.answer === "maybe")
        .map((row) => row.userId)
    ),
  ];
}

/**
 * Send what a scheduler wake owes people: the day-before reminder (R-97,
 * UC-25 9) and the ask for an answer before it closes (R-200, UC-25 10).
 *
 * Idempotent, so it may run as often as you like. The key carries the kind and
 * the event and nothing else, so an event is reminded about once and asked
 * about once however many times the job runs — including across a redeploy,
 * which a job holding its state in memory would get wrong. Two kinds rather
 * than one is also what keeps those two keys apart: on one kind, whichever
 * message arrived first would silently swallow the other.
 *
 * The two never overlap. The ask covers 48h–84h out and the reminder 0–36h, so
 * no event is in both on the same run and nobody gets two notifications about
 * the same event on the same day.
 *
 * ## Two audiences, on purpose
 *
 * The day-before reminder goes to **accepted seats only** (R-97,
 * `seatedMembersOf`): it says "you have a seat, check the time", which is not
 * true of somebody in the queue. The ask keeps the queue in
 * (`seatHoldersAwaitingAnswer`), because "are you still coming?" is a question
 * a waitlisted member can answer usefully — they are who the seat goes to if
 * somebody says no, and an answer frozen two days out is the answer the
 * running order is built from either way.
 */
export async function sendDueReminders(
  now: Date = new Date(),
  database: Database = defaultDb
): Promise<{ events: number; delivered: number; asking: number; asked: number }> {
  const soon = await eventsStartingSoon(REMINDER_WINDOW_MS, now, database);

  let delivered = 0;
  for (const event of soon) {
    // Accepted seats only (R-97, UC-25 9) — see `seatedMembersOf`.
    const seats = await seatedMembersOf(event.id, database);
    if (seats.length === 0) continue;

    const when = dayStamp(event.startsAt) === dayStamp(now) ? "today" : "tomorrow";
    const result = await notify(
      {
        kind: "event_reminder",
        userIds: seats,
        title: `${event.title} starts ${when}`,
        /*
         * It does not ask "are you still coming?" any more, and cannot: this
         * window ends 36 hours out and R-200 closed the answer at 48, so every
         * reminder this job sends arrives after the answer is already fixed
         * (UC-25 9b). Asking anyway would be asking for something the write
         * refuses. What is still true, and still worth saying the night before,
         * is the way out — withdrawing is deliberately open right up to the
         * start (R-54, UC-13 extensions E3), and it is the only thing left that
         * helps anybody else.
         */
        body: "You have a seat — check the time. The “still coming?” answer has closed, so there is nothing left to confirm; if you cannot make it, withdraw and your seat goes straight to whoever is next in the queue.",
        href: `/events/${event.slug}`,
        eventId: event.id,
        subject: event.id,
      },
      database
    );
    delivered += result.delivered;
  }

  /*
   * Events past the deadline are excluded by the lower bound, not by a second
   * check: `eventsStartingSoon` already drops anything that has started, and
   * `> CONFIRMATION_LEAD_MS` drops anything whose answer has closed. An event
   * with no start date has no deadline (UC-13 7a) and never appears here at all
   * — `eventsStartingSoon` cannot see a null start — which is right, because
   * there is no closing time to warn anybody about (UC-25 10a).
   */
  const closing = (
    await eventsStartingSoon(CONFIRMATION_ASK_WINDOW_MS, now, database)
  ).filter((event) => event.startsAt.getTime() - now.getTime() > CONFIRMATION_LEAD_MS);

  let asked = 0;
  for (const event of closing) {
    const waiting = await seatHoldersAwaitingAnswer(event.id, database);
    if (waiting.length === 0) continue;

    const result = await notify(
      {
        kind: "confirmation_due",
        userIds: waiting,
        title: `Are you still coming to ${event.title}?`,
        body: "The answer closes two days before it starts. Say you will be there, that you cannot make it, or that you are not sure yet — after that it stands, though you can still withdraw.",
        // `/me/events` rather than the event page: the chips are there, and an
        // ask that lands you somewhere you cannot answer is half an ask.
        href: "/me/events",
        eventId: event.id,
        subject: event.id,
      },
      database
    );
    asked += result.delivered;
  }

  return { events: soon.length, delivered, asking: closing.length, asked };
}
