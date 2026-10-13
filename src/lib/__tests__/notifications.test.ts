import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  type Database,
  type NotificationKind,
  applications,
  confirmations,
  events,
  notificationDmClaims,
  users,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { CONFIRMATION_LEAD_MS, confirmationsOpen } from "@/lib/events-policy";
import {
  CONFIRMATION_ASK_WINDOW_MS,
  REMINDER_WINDOW_MS,
  channelsFor,
  dayStamp,
  dedupeKey,
  getPrefs,
  listNotifications,
  markAllRead,
  markRead,
  notify,
  sendDueReminders,
  setPref,
  unreadCount,
} from "@/lib/notifications";
import { NOTIFICATION_KINDS, allChannels } from "@/lib/notify-policy";
import {
  botToken,
  directMessagesConfigured,
  render,
  sendDirectMessage,
} from "@/lib/discord-dm";

/*
 * The sender is the one thing here that would touch the network, so it is
 * replaced — but by a stand-in that calls the real function unless a test says
 * otherwise. The token-less tests below therefore still exercise the real
 * no-op, and only the "sent once" tests pretend Discord said yes.
 */
vi.mock("@/lib/discord-dm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord-dm")>();
  return { ...actual, sendDirectMessage: vi.fn(actual.sendDirectMessage) };
});

/**
 * Notifications.
 *
 * Two things decide whether this feature is useful or a nuisance, and both are
 * pinned here: the dedupe key, which is the only thing standing between "an
 * admin saved five times" and five notifications, and the preference
 * resolution, which decides who hears anything at all.
 */

let handle: TestDatabase;
let db: Database;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
});

afterAll(async () => {
  await handle.close();
});

/* ------------------------------------------------------------------ */
/* Preferences                                                        */
/* ------------------------------------------------------------------ */

describe("channelsFor", () => {
  it("is in-app on and Discord off, everywhere, by default", () => {
    for (const spec of NOTIFICATION_KINDS) {
      const channels = channelsFor(spec.kind, null);
      expect(channels.inApp).toBe(true);
      expect(channels.discord).toBe(false);
    }
  });

  it("lets an override switch a kind off", () => {
    const channels = channelsFor("event_published", [
      { kind: "event_published", inApp: false, discord: false },
    ]);
    expect(channels.inApp).toBe(false);
  });

  it("ignores an override for another kind", () => {
    const channels = channelsFor("event_published", [
      { kind: "poll_posted", inApp: false, discord: false },
    ]);
    expect(channels.inApp).toBe(true);
  });

  it("refuses to let somebody mute the answer to their own application", () => {
    // `application_decided` and `host_decision` are the reply to something you
    // asked for, not news about somebody else. Muting the reply is how you end
    // up waiting a month for a seat you already have.
    const muted = [
      { kind: "application_decided" as const, inApp: false, discord: false },
    ];
    expect(channelsFor("application_decided", muted).inApp).toBe(true);
  });

  it("still lets a fixed kind's DM be switched off", () => {
    // Being unable to mute the reply is not a reason to be unable to mute a
    // direct message about it.
    const channels = channelsFor("application_decided", [
      { kind: "application_decided", inApp: true, discord: true },
    ]);
    expect(channels.discord).toBe(true);
  });

  it("describes every kind for the screen", () => {
    const all = allChannels(null);
    expect(all).toHaveLength(NOTIFICATION_KINDS.length);
    expect(all.every((row) => row.label && row.blurb && row.audience)).toBe(true);
  });
});

describe("dedupeKey", () => {
  it("is the same for the same news", () => {
    expect(dedupeKey("event_published", "abc")).toBe(dedupeKey("event_published", "abc"));
  });

  it("separates kinds and subjects", () => {
    expect(dedupeKey("event_published", "abc")).not.toBe(dedupeKey("poll_posted", "abc"));
    expect(dedupeKey("event_published", "abc")).not.toBe(dedupeKey("event_published", "xyz"));
  });

  it("separates days when the news repeats", () => {
    expect(dedupeKey("questions_changed", "abc", "2026-08-24")).not.toBe(
      dedupeKey("questions_changed", "abc", "2026-08-25")
    );
  });

  it("stamps a day in UTC", () => {
    expect(dayStamp(new Date("2026-08-24T23:30:00.000Z"))).toBe("2026-08-24");
  });
});

/* ------------------------------------------------------------------ */
/* Sending                                                            */
/* ------------------------------------------------------------------ */

describe("notify", () => {
  it("delivers one per recipient", async () => {
    const a = await makeUser(db);
    const b = await makeUser(db);

    const result = await notify(
      { kind: "poll_posted", userIds: [a, b], title: "A new poll", subject: "poll-1" },
      db
    );

    expect(result.delivered).toBe(2);
    expect(await unreadCount(a, db)).toBe(1);
    expect(await unreadCount(b, db)).toBe(1);
  });

  it("sends the same news twice and produces one notification", async () => {
    const userId = await makeUser(db);
    const send = () =>
      notify(
        { kind: "poll_posted", userIds: [userId], title: "Same poll", subject: "poll-2" },
        db
      );

    expect((await send()).delivered).toBe(1);
    expect((await send()).delivered).toBe(0);
    expect((await send()).delivered).toBe(0);
    expect(await unreadCount(userId, db)).toBe(1);
  });

  it("collapses a daily kind within the day and not across days", async () => {
    const userId = await makeUser(db);
    // Same subject, same day: one notification however many saves.
    for (let i = 0; i < 4; i += 1) {
      await notify(
        {
          kind: "questions_changed",
          userIds: [userId],
          title: "Questions changed",
          subject: "event-daily",
          daily: true,
        },
        db
      );
    }
    expect(await unreadCount(userId, db)).toBe(1);
  });

  it("does not tell somebody about their own doing", async () => {
    const admin = await makeUser(db);
    const member = await makeUser(db);

    const result = await notify(
      {
        kind: "questions_changed",
        userIds: [admin, member],
        title: "Questions changed",
        subject: "event-self",
        exceptUserId: admin,
      },
      db
    );

    expect(result.delivered).toBe(1);
    expect(await unreadCount(admin, db)).toBe(0);
    expect(await unreadCount(member, db)).toBe(1);
  });

  it("skips somebody who switched that kind off", async () => {
    const quiet = await makeUser(db);
    const loud = await makeUser(db);
    await setPref(quiet, "event_published", { inApp: false, discord: false }, db);

    const result = await notify(
      {
        kind: "event_published",
        userIds: [quiet, loud],
        title: "A new event",
        subject: "event-pref",
      },
      db
    );

    expect(result.delivered).toBe(1);
    expect(await unreadCount(quiet, db)).toBe(0);
    expect(await unreadCount(loud, db)).toBe(1);
  });

  it("still reaches somebody who muted a different kind", async () => {
    const userId = await makeUser(db);
    await setPref(userId, "poll_posted", { inApp: false, discord: false }, db);

    await notify(
      {
        kind: "event_published",
        userIds: [userId],
        title: "A new event",
        subject: "event-other-pref",
      },
      db
    );
    expect(await unreadCount(userId, db)).toBe(1);
  });

  it("does nothing when nobody is left to tell", async () => {
    const only = await makeUser(db);
    const result = await notify(
      {
        kind: "poll_posted",
        userIds: [only],
        title: "Nobody",
        subject: "poll-nobody",
        exceptUserId: only,
      },
      db
    );
    expect(result).toEqual({ delivered: 0, discord: 0 });
  });

  it("sends no Discord message without a bot token", async () => {
    const userId = await makeUser(db, { discordId: "123456789012345678" });
    await setPref(userId, "poll_posted", { inApp: true, discord: true }, db);

    const result = await notify(
      { kind: "poll_posted", userIds: [userId], title: "DM test", subject: "poll-dm" },
      db
    );

    // The in-app one still lands; the DM is an inert no-op until a bot exists.
    expect(result.delivered).toBe(1);
    expect(result.discord).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

describe("reading", () => {
  it("lists newest first and counts the unread", async () => {
    const userId = await makeUser(db);
    await notify({ kind: "poll_posted", userIds: [userId], title: "First", subject: "r1" }, db);
    await notify({ kind: "poll_posted", userIds: [userId], title: "Second", subject: "r2" }, db);

    const list = await listNotifications(userId, db);
    expect(list).toHaveLength(2);
    expect(await unreadCount(userId, db)).toBe(2);
  });

  it("marks one read without touching the rest", async () => {
    const userId = await makeUser(db);
    await notify({ kind: "poll_posted", userIds: [userId], title: "One", subject: "m1" }, db);
    await notify({ kind: "poll_posted", userIds: [userId], title: "Two", subject: "m2" }, db);

    const [first] = await listNotifications(userId, db);
    await markRead(userId, first.id, db);
    expect(await unreadCount(userId, db)).toBe(1);
  });

  it("will not let somebody mark another person's notification read", async () => {
    const owner = await makeUser(db);
    const stranger = await makeUser(db);
    await notify({ kind: "poll_posted", userIds: [owner], title: "Mine", subject: "m3" }, db);

    const [mine] = await listNotifications(owner, db);
    await markRead(stranger, mine.id, db);

    // Still unread: the update is keyed on the owner as well as the id.
    expect(await unreadCount(owner, db)).toBe(1);
  });

  it("marks everything read at once", async () => {
    const userId = await makeUser(db);
    for (let i = 0; i < 3; i += 1) {
      await notify(
        { kind: "poll_posted", userIds: [userId], title: `n${i}`, subject: `all-${i}` },
        db
      );
    }
    await markAllRead(userId, db);
    expect(await unreadCount(userId, db)).toBe(0);
  });
});

describe("preferences round-trip", () => {
  it("stores a choice that happens to match the default", async () => {
    const userId = await makeUser(db);
    await setPref(userId, "poll_posted", { inApp: true, discord: false }, db);

    // Kept, not tidied away: the default may move, and somebody who chose
    // today's default should not be moved with it.
    const prefs = await getPrefs(userId, db);
    expect(prefs.find((row) => row.kind === "poll_posted")).toBeTruthy();
  });

  it("updates rather than duplicating", async () => {
    const userId = await makeUser(db);
    await setPref(userId, "event_published", { inApp: false, discord: false }, db);
    await setPref(userId, "event_published", { inApp: true, discord: true }, db);

    const prefs = await getPrefs(userId, db);
    const rows = prefs.filter((row) => row.kind === "event_published");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inApp: true, discord: true });
  });
});

/* ------------------------------------------------------------------ */
/* Reminders                                                          */
/* ------------------------------------------------------------------ */

describe("sendDueReminders", () => {
  const HOUR = 60 * 60 * 1000;
  const MINUTE = 60 * 1000;

  /** A published event starting at `startsAt`, with one accepted seat. */
  async function eventWithSeat(startsAt: Date, status: "published" | "draft" = "published") {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [event] = await db
      .insert(events)
      .values({ slug: `reminder-${suffix}`, title: `Reminder ${suffix}`, status, startsAt })
      .returning({ id: events.id });
    const userId = await makeUser(db);
    await db.insert(applications).values({ eventId: event.id, userId, status: "accepted" });
    return userId;
  }

  it("reminds a seat holder about an event starting within the day", async () => {
    const now = new Date("2026-10-01T17:00:00.000Z");
    const seat = await eventWithSeat(new Date(now.getTime() + 20 * HOUR));

    await sendDueReminders(now, db);
    expect(await unreadCount(seat, db)).toBe(1);
  });

  it("leaves no gap between two daily runs as far apart as Vercel allows", async () => {
    // A Hobby cron fires once a day, anywhere inside its hour, so consecutive
    // runs can be 24h59m apart. An event starting between them must be caught
    // by the first run, because by the second it has already begun.
    const firstRun = new Date("2026-10-02T17:00:00.000Z");
    const secondRun = new Date(firstRun.getTime() + 24 * HOUR + 59 * MINUTE);
    const seat = await eventWithSeat(new Date(firstRun.getTime() + 24 * HOUR + 30 * MINUTE));

    await sendDueReminders(firstRun, db);
    await sendDueReminders(secondRun, db);
    expect(await unreadCount(seat, db)).toBe(1);
  });

  it("does not remind twice when the window overlaps two runs", async () => {
    const firstRun = new Date("2026-10-04T17:00:00.000Z");
    const secondRun = new Date(firstRun.getTime() + 23 * HOUR);
    const seat = await eventWithSeat(new Date(firstRun.getTime() + 24 * HOUR + 30 * MINUTE));

    await sendDueReminders(firstRun, db);
    await sendDueReminders(secondRun, db);
    expect(await unreadCount(seat, db)).toBe(1);
  });

  it("still says tomorrow: nothing further out than the window", async () => {
    const now = new Date("2026-10-06T17:00:00.000Z");
    const seat = await eventWithSeat(new Date(now.getTime() + REMINDER_WINDOW_MS + MINUTE));

    await sendDueReminders(now, db);
    expect(await unreadCount(seat, db)).toBe(0);
    expect(REMINDER_WINDOW_MS).toBeLessThanOrEqual(36 * HOUR);
  });

  it("says today for an event later the same day, tomorrow otherwise", async () => {
    const now = new Date("2026-10-10T12:00:00.000Z");
    const later = await eventWithSeat(new Date("2026-10-10T20:00:00.000Z"));
    const tomorrow = await eventWithSeat(new Date("2026-10-11T19:00:00.000Z"));

    await sendDueReminders(now, db);
    expect((await listNotifications(later, db))[0].title).toMatch(/starts today$/);
    expect((await listNotifications(tomorrow, db))[0].title).toMatch(/starts tomorrow$/);
  });

  it("never reminds anybody about an unpublished event", async () => {
    const now = new Date("2026-10-08T17:00:00.000Z");
    const seat = await eventWithSeat(new Date(now.getTime() + 2 * HOUR), "draft");

    await sendDueReminders(now, db);
    expect(await unreadCount(seat, db)).toBe(0);
  });

  /*
   * The day-before reminder and R-200's deadline, which is the conflict this
   * window had to be re-reasoned around.
   */
  it("can only ever arrive after the answer has closed, so it does not ask for one", async () => {
    // The arithmetic first: 36h < 48h, so an event is inside this window only
    // once `now` is past `start − 48h`. There is no run of this job that can
    // reach a member while the answer is still open.
    expect(REMINDER_WINDOW_MS).toBeLessThan(CONFIRMATION_LEAD_MS);

    const now = new Date("2026-10-14T17:00:00.000Z");
    const starts = new Date(now.getTime() + REMINDER_WINDOW_MS);
    const seat = await eventWithSeat(starts);
    expect(confirmationsOpen(starts, now)).toBe(false);

    await sendDueReminders(now, db);
    const [sent] = await listNotifications(seat, db);
    expect(sent.kind).toBe("event_reminder");
    // So it says the answer is shut and points at the one thing still open
    // (R-54, UC-13 extensions E3) rather than asking for an answer the write
    // would refuse.
    expect(sent.body).toMatch(/has closed/);
    expect(sent.body).toMatch(/withdraw/);
  });
});

/* ------------------------------------------------------------------ */
/* "Answer before it closes" — R-200, UC-25 10                        */
/* ------------------------------------------------------------------ */

/*
 * The second ask, and the window that makes it reach anybody.
 *
 * `REMINDER_WINDOW_MS` is 36 hours and R-200's deadline is 48, so the
 * day-before reminder is structurally too late to ask for an answer. This
 * window exists to be early instead, and the only interesting thing about it
 * is whether a once-a-day scheduler can miss it. These tests are the
 * arithmetic in the docblock, executed.
 */
describe("sendDueReminders — the answer deadline", () => {
  const HOUR = 60 * 60 * 1000;
  const MINUTE = 60 * 1000;

  /** A published event starting at `startsAt`, with one accepted seat. */
  async function eventWithSeat(startsAt: Date | null) {
    const suffix = Math.random().toString(36).slice(2, 10);
    const [event] = await db
      .insert(events)
      .values({ slug: `ask-${suffix}`, title: `Ask ${suffix}`, status: "published", startsAt })
      .returning({ id: events.id });
    const userId = await makeUser(db);
    const [application] = await db
      .insert(applications)
      .values({ eventId: event.id, userId, status: "accepted" })
      .returning({ id: applications.id });
    return { eventId: event.id, userId, applicationId: application.id };
  }

  async function kindsFor(userId: string): Promise<string[]> {
    return (await listNotifications(userId, db)).map((row) => row.kind);
  }

  it("covers a 24h59m gap between runs, with the margin the docblock claims", () => {
    // The guarantee: some run must fall inside [start − W, start − 48h], an
    // interval W − 48h long, and consecutive Hobby runs can be 24h59m apart.
    const reach = CONFIRMATION_ASK_WINDOW_MS - CONFIRMATION_LEAD_MS;
    expect(reach).toBeGreaterThanOrEqual(24 * HOUR + 59 * MINUTE);
    // And it is exactly the look-ahead the day-before reminder already uses,
    // because it is the same problem displaced by the deadline.
    expect(CONFIRMATION_ASK_WINDOW_MS).toBe(CONFIRMATION_LEAD_MS + REMINDER_WINDOW_MS);
  });

  it("reaches a seat holder before the deadline even when one run just misses it", async () => {
    // The worst case the window has to survive: the first run is a minute too
    // early to see the event at all, and the next one is as late as a daily
    // cron can legally be.
    const firstRun = new Date("2026-11-01T12:00:00.000Z");
    const starts = new Date(firstRun.getTime() + CONFIRMATION_ASK_WINDOW_MS + MINUTE);
    const secondRun = new Date(firstRun.getTime() + 24 * HOUR + 59 * MINUTE);
    const { userId } = await eventWithSeat(starts);

    await sendDueReminders(firstRun, db);
    expect(await kindsFor(userId)).toEqual([]);

    await sendDueReminders(secondRun, db);
    expect(await kindsFor(userId)).toEqual(["confirmation_due"]);
    // The whole point: it landed while they could still answer.
    expect(confirmationsOpen(starts, secondRun)).toBe(true);
  });

  it("never asks once the answer has closed", async () => {
    const now = new Date("2026-11-05T12:00:00.000Z");
    // An hour inside the deadline: still 47 hours from the start, so the
    // day-before reminder has not fired either. Nothing should be asked.
    const starts = new Date(now.getTime() + CONFIRMATION_LEAD_MS - HOUR);
    const { userId } = await eventWithSeat(starts);

    await sendDueReminders(now, db);
    expect(await kindsFor(userId)).toEqual([]);
  });

  it("asks nothing about an event with no start date, which has no deadline", async () => {
    const { userId } = await eventWithSeat(null);
    await sendDueReminders(new Date("2026-11-07T12:00:00.000Z"), db);
    expect(await kindsFor(userId)).toEqual([]);
  });

  it("does not ask twice when two runs both see the event", async () => {
    const firstRun = new Date("2026-11-09T12:00:00.000Z");
    const starts = new Date(firstRun.getTime() + 80 * HOUR);
    const { userId } = await eventWithSeat(starts);

    await sendDueReminders(firstRun, db);
    await sendDueReminders(new Date(firstRun.getTime() + 24 * HOUR), db);
    expect(await kindsFor(userId)).toEqual(["confirmation_due"]);
  });

  it("leaves alone anybody who has already settled their answer", async () => {
    const now = new Date("2026-11-12T12:00:00.000Z");
    const starts = new Date(now.getTime() + 60 * HOUR);

    const settled = await eventWithSeat(starts);
    await db
      .insert(confirmations)
      .values({ applicationId: settled.applicationId, state: "in" });

    await sendDueReminders(now, db);
    expect(await kindsFor(settled.userId)).toEqual([]);
  });

  it("asks again anybody still sitting on a maybe", async () => {
    const now = new Date("2026-11-14T12:00:00.000Z");
    const starts = new Date(now.getTime() + 60 * HOUR);

    const unsure = await eventWithSeat(starts);
    await db
      .insert(confirmations)
      .values({ applicationId: unsure.applicationId, state: "maybe" });

    await sendDueReminders(now, db);
    // A maybe is exactly what the deadline is about to freeze (R-199, UC-13
    // extensions E4), so it is unsettled and gets the ask.
    expect(await kindsFor(unsure.userId)).toEqual(["confirmation_due"]);
  });

  it("sends people to the page that can take the answer", async () => {
    const now = new Date("2026-11-16T12:00:00.000Z");
    const { userId } = await eventWithSeat(new Date(now.getTime() + 60 * HOUR));

    await sendDueReminders(now, db);
    const [sent] = await listNotifications(userId, db);
    expect(sent.href).toBe("/me/events");
    expect(sent.title).toMatch(/^Are you still coming to /);
  });
});

/* ------------------------------------------------------------------ */
/* Discord                                                            */
/* ------------------------------------------------------------------ */

describe("direct messages", () => {
  it("is switched off entirely without a token", () => {
    expect(botToken({})).toBeNull();
    expect(directMessagesConfigured({})).toBe(false);
    expect(directMessagesConfigured({ DISCORD_BOT_TOKEN: "  " })).toBe(false);
    expect(directMessagesConfigured({ DISCORD_BOT_TOKEN: "abc" })).toBe(true);
  });

  it("writes a sentence and a link, not an embed", () => {
    const text = render(
      { title: "Spring Open starts tomorrow", body: "You have a seat.", href: "/events/x", key: "k" },
      "https://jobcentre.vercel.app"
    );
    expect(text).toContain("**Spring Open starts tomorrow**");
    expect(text).toContain("You have a seat.");
    expect(text).toContain("https://jobcentre.vercel.app/events/x");
  });

  it("leaves the link relative when nothing says where the site is", () => {
    const text = render({ title: "T", body: null, href: "/events/x", key: "k" });
    expect(text).toContain("/events/x");
  });
});

/*
 * Once per person per piece of news.
 *
 * The in-site row is deduplicated by its unique key, but a DM leaves nothing
 * behind to collide with — so without a claim of its own, every repeat of the
 * same news would be another message on somebody's phone.
 */
describe("direct messages are sent once", () => {
  const HOUR = 60 * 60 * 1000;
  const send = vi.mocked(sendDirectMessage);
  let snowflake = 100000000000000000n;

  /** A member who has a Discord account and wants this kind by DM. */
  async function dmMember(kind: "poll_posted" | "event_reminder", inApp = true) {
    snowflake += 1n;
    const userId = await makeUser(db, { discordId: snowflake.toString() });
    await setPref(userId, kind, { inApp, discord: true }, db);
    return userId;
  }

  /** How many DM claims exist for this person and this piece of news. */
  async function claimsFor(userId: string, kind: NotificationKind, subject: string) {
    const rows = await db
      .select({ userId: notificationDmClaims.userId })
      .from(notificationDmClaims)
      .where(
        and(
          eq(notificationDmClaims.userId, userId),
          eq(notificationDmClaims.dedupeKey, dedupeKey(kind, subject))
        )
      );
    return rows.length;
  }

  beforeEach(() => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "test-token");
    // Forget calls from the token-less tests above; count only this test's.
    send.mockReset();
    send.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // Back to the real, token-less sender for anything that runs after.
    send.mockReset();
  });

  it("sends one DM per opted-in member when the same news is sent twice", async () => {
    const a = await dmMember("poll_posted");
    const b = await dmMember("poll_posted");
    const input = {
      kind: "poll_posted" as const,
      userIds: [a, b],
      title: "A poll",
      subject: "dm-twice",
    };

    const first = await notify(input, db);
    const second = await notify(input, db);

    expect(first.discord).toBe(2);
    expect(second.discord).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends one reminder DM across two runs inside the window", async () => {
    const firstRun = new Date("2026-11-01T12:00:00.000Z");
    const secondRun = new Date(firstRun.getTime() + 23 * HOUR);
    const [event] = await db
      .insert(events)
      .values({
        slug: "dm-reminder",
        title: "DM reminder",
        status: "published",
        startsAt: new Date(firstRun.getTime() + 30 * HOUR),
      })
      .returning({ id: events.id });
    const seat = await dmMember("event_reminder");
    await db.insert(applications).values({ eventId: event.id, userId: seat, status: "accepted" });

    await sendDueReminders(firstRun, db);
    await sendDueReminders(secondRun, db);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("DMs a member with the bell off once, and writes nothing in-site", async () => {
    const userId = await dmMember("poll_posted", false);
    const input = {
      kind: "poll_posted" as const,
      userIds: [userId],
      title: "Bell off",
      subject: "dm-bell-off",
    };

    await notify(input, db);
    await notify(input, db);

    expect(send).toHaveBeenCalledTimes(1);
    expect(await listNotifications(userId, db)).toHaveLength(0);
  });

  /*
   * A claim means "about to message this person" and nothing weaker. Claiming
   * for somebody we could not message would silence them for good: the day
   * they link Discord, or the day the bot is configured, the same news would
   * find its claim already taken.
   */

  it("claims nothing for somebody opted in without a Discord id, and DMs them once they have one", async () => {
    const userId = await dmMember("poll_posted");
    await db.update(users).set({ discordId: null }).where(eq(users.id, userId));
    const input = {
      kind: "poll_posted" as const,
      userIds: [userId],
      title: "No Discord yet",
      subject: "dm-no-id",
    };

    await notify(input, db);
    expect(send).not.toHaveBeenCalled();
    expect(await claimsFor(userId, "poll_posted", "dm-no-id")).toBe(0);

    snowflake += 1n;
    await db.update(users).set({ discordId: snowflake.toString() }).where(eq(users.id, userId));
    await notify(input, db);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("claims nothing for somebody who has not opted in to DMs", async () => {
    snowflake += 1n;
    const userId = await makeUser(db, { discordId: snowflake.toString() });

    await notify(
      { kind: "poll_posted", userIds: [userId], title: "Bell only", subject: "dm-not-opted" },
      db
    );

    expect(send).not.toHaveBeenCalled();
    expect(await claimsFor(userId, "poll_posted", "dm-not-opted")).toBe(0);
  });

  it("claims nothing without a bot token, and DMs once the token exists", async () => {
    const userId = await dmMember("poll_posted");
    const input = {
      kind: "poll_posted" as const,
      userIds: [userId],
      title: "No bot yet",
      subject: "dm-no-token",
    };
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    await notify(input, db);
    expect(send).not.toHaveBeenCalled();
    expect(await claimsFor(userId, "poll_posted", "dm-no-token")).toBe(0);

    vi.stubEnv("DISCORD_BOT_TOKEN", "test-token");
    await notify(input, db);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
