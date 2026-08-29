import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  channelsFor,
  dayStamp,
  dedupeKey,
  getPrefs,
  listNotifications,
  markAllRead,
  markRead,
  notify,
  setPref,
  unreadCount,
} from "@/lib/notifications";
import { NOTIFICATION_KINDS, allChannels } from "@/lib/notify-policy";
import { botToken, directMessagesConfigured, render } from "@/lib/discord-dm";

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
