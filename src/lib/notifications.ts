import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  type Database,
  type NotificationKind,
  applications,
  db as defaultDb,
  events,
  notificationPrefs,
  notifications,
  users,
} from "@/db";
import {
  type PrefOverride,
  channelsFor,
  dayStamp,
  dedupeKey,
} from "./notify-policy";
import { sendDirectMessage } from "./discord-dm";

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
   * Only people the in-app insert actually wrote for get a DM. Somebody who
   * has already been told is not told again by another route — that is the
   * whole point of the dedupe key, and it would be an odd feature that
   * suppressed the quiet channel and not the loud one.
   *
   * Somebody who has switched the bell off but the DM on is a real
   * configuration, so they are sent to on the strength of the same key having
   * been claimed for them.
   */
  const discord =
    wantsDiscord.length > 0
      ? await claimForDiscord(database, wantsDiscord, key, input)
      : 0;

  return { delivered, discord };
}

/**
 * Send the direct messages, and say how many went.
 *
 * Deliberately not transactional with the insert: a Discord outage must not
 * roll back a notification anybody can already see on the site. A DM that fails
 * is logged and dropped, the same bargain `deliver` in `discord.ts` makes.
 */
async function claimForDiscord(
  database: Database,
  userIds: readonly string[],
  key: string,
  input: NotifyInput
): Promise<number> {
  const people = await database
    .select({ id: users.id, discordId: users.discordId })
    .from(users)
    .where(inArray(users.id, [...userIds]));

  let sent = 0;
  for (const person of people) {
    if (!person.discordId) continue;
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

/** Everybody holding a seat — accepted, or waiting for one. */
export async function seatHoldersOf(
  eventId: string,
  database: Database = defaultDb
): Promise<string[]> {
  const rows = await database
    .select({ userId: applications.userId, status: applications.status })
    .from(applications)
    .where(eq(applications.eventId, eventId));
  return [
    ...new Set(
      rows
        .filter((row) => row.status === "accepted" || row.status === "waitlisted")
        .map((row) => row.userId)
    ),
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
 * Events starting within the next day, for the reminder job.
 *
 * A window rather than a moment: a job that runs hourly must not need to catch
 * an event at exactly the right tick, and the dedupe key means the extra runs
 * cost one insert attempt each and change nothing.
 */
export async function eventsStartingSoon(
  within = 24 * 60 * 60 * 1000,
  now: Date = new Date(),
  database: Database = defaultDb
): Promise<Array<{ id: string; title: string; slug: string; startsAt: Date }>> {
  const rows = await database
    .select({
      id: events.id,
      title: events.title,
      slug: events.slug,
      startsAt: events.startsAt,
      status: events.status,
    })
    .from(events);

  return rows
    .filter((row) => row.status === "published" || row.status === "live")
    .filter((row): row is typeof row & { startsAt: Date } => row.startsAt !== null)
    .filter((row) => {
      const delta = row.startsAt.getTime() - now.getTime();
      return delta > 0 && delta <= within;
    })
    .map((row) => ({
      id: row.id,
      title: row.title,
      slug: row.slug,
      startsAt: row.startsAt,
    }));
}

/**
 * Send tomorrow's reminders. Idempotent, so it may run as often as you like.
 *
 * The key carries the event and nothing else, so an event is reminded about
 * once however many times the job runs — including across a redeploy, which a
 * job holding its state in memory would get wrong.
 */
export async function sendDueReminders(
  now: Date = new Date(),
  database: Database = defaultDb
): Promise<{ events: number; delivered: number }> {
  const soon = await eventsStartingSoon(24 * 60 * 60 * 1000, now, database);

  let delivered = 0;
  for (const event of soon) {
    const seats = await seatHoldersOf(event.id, database);
    if (seats.length === 0) continue;

    const result = await notify(
      {
        kind: "event_reminder",
        userIds: seats,
        title: `${event.title} starts tomorrow`,
        body: "You have a seat. Check the time and let an admin know if you cannot make it.",
        href: `/events/${event.slug}`,
        eventId: event.id,
        subject: event.id,
      },
      database
    );
    delivered += result.delivered;
  }

  return { events: soon.length, delivered };
}
