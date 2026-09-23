import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  type ChampionshipStatusValue,
  type Database,
  applications,
  championships,
  events,
  teamMembers,
  teams,
  users,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";

/*
 * UC-36 1-2 and 2a — being told the standings moved, against a real in-memory
 * Postgres.
 *
 * Two things are replaced. `@/db`'s `db` is pointed at this file's database,
 * because `notifyStandingsChanged` takes an event id and nothing else: every
 * read it makes goes through the default handle, exactly as it does in
 * production. And `after()` collects the deferred work instead of needing a
 * request, so a test awaits the job it started rather than sleeping.
 *
 * The DM sender is a stand-in that calls the real function unless a test says
 * otherwise, the same arrangement `notifications.test.ts` makes: the tests
 * with no bot token still exercise the real no-op.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  jobs: [] as Array<Promise<void>>,
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  const db = new Proxy({} as Database, {
    get(_target, property) {
      const real = state.db as unknown as Record<string | symbol, unknown>;
      const value = Reflect.get(real, property, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
  return { ...actual, db };
});

vi.mock("next/server", () => ({
  after: (work: () => Promise<void>) => {
    state.jobs.push(work());
  },
}));

vi.mock("@/lib/discord-dm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/discord-dm")>();
  return { ...actual, sendDirectMessage: vi.fn(actual.sendDirectMessage) };
});

const { notifyStandingsChanged } = await import("@/lib/notify-events");
const { listNotifications, setPref } = await import("@/lib/notifications");
const { sendDirectMessage } = await import("@/lib/discord-dm");
const { addCountingEvent, createChampionship, getChampionship } = await import(
  "@/lib/championships"
);
const { setPlacements } = await import("@/lib/championship-results");
const { seasonPage } = await import("@/lib/championship-season");

let handle: TestDatabase;
let db: Database;
let counter = 0;
let snowflake = 900000000000000000n;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
});

afterAll(async () => {
  await handle.close();
});

afterEach(() => {
  state.jobs = [];
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

async function season(status: ChampionshipStatusValue = "published"): Promise<string> {
  counter += 1;
  const made = await createChampionship({ name: `Season ${counter}` }, db);
  if (!made.ok) throw new Error(made.error);
  if (status !== "hidden") {
    await db.update(championships).set({ status }).where(eq(championships.id, made.data.id));
  }
  return made.data.id;
}

/** A counting event on a season, played at the given hour so the order is fixed. */
async function night(seasonId: string, title: string, startsAt: Date): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(events)
    .values({ slug: `news-${counter}`, title, status: "complete", startsAt })
    .returning({ id: events.id });
  const added = await addCountingEvent(seasonId, row.id, db);
  if (!added.ok) throw new Error(added.error);
  return row.id;
}

async function accepted(eventId: string, displayName: string): Promise<string> {
  const userId = await makeUser(db, { displayName });
  await db.insert(applications).values({ eventId, userId, status: "accepted" });
  return userId;
}

/** A team on an event, with everybody on it. R-180: its place is all of theirs. */
async function teamOf(eventId: string, name: string, memberIds: string[]): Promise<string> {
  const [row] = await db.insert(teams).values({ eventId, name }).returning({ id: teams.id });
  for (const userId of memberIds) {
    await db.insert(teamMembers).values({ eventId, teamId: row.id, userId });
  }
  return row.id;
}

async function finished(eventId: string, order: string[]): Promise<void> {
  const saved = await setPlacements(
    eventId,
    order.map((id, index) => ({ id, position: index + 1 })),
    db
  );
  if (!saved.ok) throw new Error(saved.error);
}

/** Run the notification and wait for the job it deferred. */
async function told(eventId: string, exceptUserId?: string): Promise<void> {
  notifyStandingsChanged(eventId, exceptUserId);
  await Promise.all(state.jobs);
  state.jobs = [];
}

async function heard(userId: string): Promise<string[]> {
  const rows = await listNotifications(userId, db);
  return rows.filter((row) => row.kind === "standings_changed").map((row) => row.title);
}

/* ------------------------------------------------------------------ */
/* UC-36 2 — only the people who played that event                    */
/* ------------------------------------------------------------------ */

describe("who is told the standings moved", () => {
  it("tells the people who played that event, and nobody else in the season", async () => {
    /*
     * The failure this test exists for. A season has a long tail of members
     * who played once months ago; their points move every time anybody else
     * plays, and an audience taken from the season rather than from the night
     * would tell all of them. March turns up in March and hears about March.
     */
    const seasonId = await season();
    const march = await night(seasonId, "March night", new Date("2026-03-01T18:00:00Z"));
    const october = await night(seasonId, "October night", new Date("2026-10-01T18:00:00Z"));

    const marchOnly = await accepted(march, "March Only");
    const both = await accepted(march, "Both Nights");
    await db.insert(applications).values({ eventId: october, userId: both, status: "accepted" });
    const octoberOnly = await accepted(october, "October Only");

    await finished(march, [marchOnly, both]);
    await told(march);
    // Clear the March news so the October assertions cannot pass on it.
    expect(await heard(both)).toHaveLength(1);

    await finished(october, [octoberOnly, both]);
    await told(october);

    expect(await heard(octoberOnly)).toEqual([
      expect.stringContaining("standings have changed"),
    ]);
    // Told once, in March, and not again for a night they did not play.
    expect(await heard(marchOnly)).toHaveLength(1);
    // Played both, so heard about both.
    expect(await heard(both)).toHaveLength(2);
  });

  it("tells everybody on a team whose place it was (R-180)", async () => {
    const seasonId = await season();
    const eventId = await night(seasonId, "Team night", new Date("2026-04-01T18:00:00Z"));
    const captain = await accepted(eventId, "Captain");
    const player = await accepted(eventId, "Squad Player");
    const other = await accepted(eventId, "Other Team");
    const winners = await teamOf(eventId, "Winners", [captain, player]);
    const runnersUp = await teamOf(eventId, "Runners up", [other]);

    await finished(eventId, [winners, runnersUp]);
    await told(eventId);

    expect(await heard(captain)).toHaveLength(1);
    expect(await heard(player)).toHaveLength(1);
    expect(await heard(other)).toHaveLength(1);
  });

  it("tells somebody who took part and was not placed", async () => {
    // They scored the taking-part points off the same night, so their total
    // moved too — UC-33 3b.
    const seasonId = await season();
    const eventId = await night(seasonId, "Unplaced night", new Date("2026-05-01T18:00:00Z"));
    const winner = await accepted(eventId, "Winner");
    const alsoRan = await accepted(eventId, "Also Ran");

    await finished(eventId, [winner]);
    await told(eventId);

    expect(await heard(alsoRan)).toHaveLength(1);
  });

  it("does not tell the person who recorded the order", async () => {
    const seasonId = await season();
    const eventId = await night(seasonId, "Host night", new Date("2026-06-01T18:00:00Z"));
    const host = await accepted(eventId, "The Host");
    const guest = await accepted(eventId, "The Guest");

    await finished(eventId, [host, guest]);
    await told(eventId, host);

    expect(await heard(host)).toEqual([]);
    expect(await heard(guest)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* UC-36 2a — the switch, and the things that stay silent             */
/* ------------------------------------------------------------------ */

describe("what stays silent", () => {
  it("skips a member who switched this kind off, and the standings still change", async () => {
    const seasonId = await season();
    const eventId = await night(seasonId, "Muted night", new Date("2026-07-01T18:00:00Z"));
    const muted = await accepted(eventId, "Muted Member");
    const listening = await accepted(eventId, "Listening Member");
    await setPref(muted, "standings_changed", { inApp: false, discord: false }, db);

    await finished(eventId, [muted, listening]);
    await told(eventId);

    expect(await heard(muted)).toEqual([]);
    expect(await heard(listening)).toHaveLength(1);

    // UC-36 2a: no notification, and the standings moved all the same.
    const row = await getChampionship(seasonId, db);
    const page = await seasonPage(row!, db);
    expect(page.standings.find((player) => player.userId === muted)?.position).toBe(1);
  });

  it("says nothing twice in a day, and again the next day", async () => {
    // A host correcting a typo four times this evening has produced one piece
    // of news; a correction next week is news again (UC-33 4a).
    const seasonId = await season();
    const eventId = await night(seasonId, "Corrected night", new Date("2026-08-01T18:00:00Z"));
    const first = await accepted(eventId, "First Home");
    const second = await accepted(eventId, "Second Home");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-02T09:00:00Z"));
    await finished(eventId, [first, second]);
    await told(eventId);
    await finished(eventId, [second, first]);
    await told(eventId);
    expect(await heard(first)).toHaveLength(1);

    vi.setSystemTime(new Date("2026-08-03T09:00:00Z"));
    await told(eventId);
    expect(await heard(first)).toHaveLength(2);
    vi.useRealTimers();
  });

  it("says nothing about a hidden season (R-189)", async () => {
    // A hidden season is an admin's draft. A notification naming it would tell
    // everybody who played that it exists.
    const seasonId = await season("hidden");
    const eventId = await night(seasonId, "Draft season night", new Date("2026-09-01T18:00:00Z"));
    const player = await accepted(eventId, "Unsuspecting Player");

    await finished(eventId, [player]);
    await told(eventId);

    expect(await heard(player)).toEqual([]);
  });

  it("says nothing when the order is cleared", async () => {
    const seasonId = await season();
    const eventId = await night(seasonId, "Cleared night", new Date("2026-10-02T18:00:00Z"));
    const player = await accepted(eventId, "Cleared Player");

    await finished(eventId, []);
    await told(eventId);

    expect(await heard(player)).toEqual([]);
  });

  it("says nothing about an event that counts towards nothing", async () => {
    counter += 1;
    const [row] = await db
      .insert(events)
      .values({ slug: `uncounted-${counter}`, title: "Just an event", status: "complete" })
      .returning({ id: events.id });
    const player = await accepted(row.id, "Ordinary Player");

    await told(row.id);

    expect(await heard(player)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-36 2 — the Discord DM, once                                     */
/* ------------------------------------------------------------------ */

describe("the direct message", () => {
  const send = vi.mocked(sendDirectMessage);

  beforeEach(() => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "test-token");
    send.mockReset();
    send.mockResolvedValue(true);
  });

  afterEach(() => {
    send.mockReset();
  });

  /** A member who played, has a Discord account, and wants this kind by DM. */
  async function dmPlayer(eventId: string, name: string): Promise<string> {
    snowflake += 1n;
    const userId = await makeUser(db, { displayName: name, discordId: snowflake.toString() });
    await db.insert(applications).values({ eventId, userId, status: "accepted" });
    await setPref(userId, "standings_changed", { inApp: true, discord: true }, db);
    return userId;
  }

  it("goes once however many times the same night is saved", async () => {
    const seasonId = await season();
    const eventId = await night(seasonId, "DM night", new Date("2026-11-01T18:00:00Z"));
    const player = await dmPlayer(eventId, "DM Player");
    const rival = await dmPlayer(eventId, "DM Rival");

    await finished(eventId, [player, rival]);
    await told(eventId);
    await finished(eventId, [rival, player]);
    await told(eventId);

    // Two people, one message each, however many times the order was saved.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("claims nothing for somebody with no Discord account, and DMs them once they have one", async () => {
    const seasonId = await season();
    const eventId = await night(seasonId, "Late link night", new Date("2026-11-02T18:00:00Z"));
    const player = await dmPlayer(eventId, "Late Linker");
    await db.update(users).set({ discordId: null }).where(eq(users.id, player));

    await finished(eventId, [player]);
    await told(eventId);
    expect(send).not.toHaveBeenCalled();

    // The claim must not have been taken: the day they link Discord, the same
    // news has to be able to reach them.
    snowflake += 1n;
    await db.update(users).set({ discordId: snowflake.toString() }).where(eq(users.id, player));
    await told(eventId);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("claims nothing while there is no bot, and DMs once there is one", async () => {
    const seasonId = await season();
    const eventId = await night(seasonId, "No bot night", new Date("2026-11-03T18:00:00Z"));
    const player = await dmPlayer(eventId, "Waiting For A Bot");
    vi.stubEnv("DISCORD_BOT_TOKEN", "");

    await finished(eventId, [player]);
    await told(eventId);
    expect(send).not.toHaveBeenCalled();

    vi.stubEnv("DISCORD_BOT_TOKEN", "test-token");
    await told(eventId);

    expect(send).toHaveBeenCalledTimes(1);
  });
});
