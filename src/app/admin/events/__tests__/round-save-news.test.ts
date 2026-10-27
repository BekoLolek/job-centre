import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  type Database,
  type EventConfig,
  SETTING_KEYS,
  announcementClaims,
  applications,
  championships,
  events,
} from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";
import type { AnnouncementSettings, DiscordMessage } from "@/lib/announce";

/*
 * Task 95 — UC-36 1-3 reached from a round save (R-236).
 *
 * `saveEventPlacementsAction` tells the players and the channel that the
 * season moved; Task 88's `saveRoundAction` moved the season too (Task 91) and
 * told nobody. These tests pin the rule the round save now follows:
 *
 *   it speaks when the save **completes the night's table** — every round of
 *   the setup has a score in it — and again when a save on an already-complete
 *   night **moves the standings**. A round on a part-scored night and a
 *   correction that moved nobody say nothing.
 *
 * Three harnesses in one, each borrowed whole: `round-save.test.ts`'s (the
 * action runs for real with the session, the page cache and `after()`
 * replaced), `standings-announcement.test.ts`'s (`after()` collects the
 * deferred work so a test can await it, and `fetch` is a stub so nothing can
 * reach Discord), and `standings-news.test.ts`'s (the notifications are read
 * back from the table). "Announces nothing" is asserted as a sender with zero
 * calls and rows read back as empty — never as "no error came out".
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
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

vi.mock("@/lib/auth", () => ({
  SIGN_IN_PATH: "/signin",
  auth: async () => (state.userId ? { user: { id: state.userId } } : null),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({
  after: (work: () => Promise<void>) => {
    state.jobs.push(work());
  },
}));

const { saveRoundAction, saveRoundScoringAction } = await import("../actions");
const { applyToEvent, createEvent, publishEvent, updateEvent } = await import("@/lib/events");
const { listRoundScores } = await import("@/lib/round-scores");
const { addCountingEvent, createChampionship, getChampionship } = await import("@/lib/championships");
const { setPlacements } = await import("@/lib/championship-results");
const { seasonPage } = await import("@/lib/championship-season");
const { listNotifications, setPref } = await import("@/lib/notifications");
const { setAnnouncementSettings, setIntegrationSetting } = await import("@/lib/discord");
const { defaultAnnouncementSettings } = await import("@/lib/announce");
const { listAudit } = await import("@/lib/audit");

/** The token half is a word nothing else in this file contains (`standings-announcement.test.ts`). */
const WEBHOOK = "https://discord.test/api/webhooks/1/supersecretwebhooktoken";

let handle: TestDatabase;
let db: Database;
let counter = 0;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
});

afterAll(async () => {
  await handle.close();
});

const fetchStub = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

beforeEach(async () => {
  await setIntegrationSetting(SETTING_KEYS.webhookUrl, WEBHOOK);
  await switches({ standings_changed: true });
  vi.stubEnv("DISCORD_WEBHOOK_URL", "");
  // No bot, so the in-app row is the whole of a notification here.
  vi.stubEnv("DISCORD_BOT_TOKEN", "");
  vi.stubGlobal("fetch", fetchStub);
  fetchStub.mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchStub.mockReset();
  state.jobs = [];
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/** Switch exactly these on, everything else off. */
async function switches(on: Partial<AnnouncementSettings>): Promise<void> {
  const off = Object.fromEntries(
    Object.keys(defaultAnnouncementSettings()).map((kind) => [kind, false])
  ) as AnnouncementSettings;
  await setAnnouncementSettings({ ...off, ...on });
}

async function season(): Promise<string> {
  counter += 1;
  const made = await createChampionship({ name: `Cup ${counter}` }, db);
  if (!made.ok) throw new Error(made.error);
  await db
    .update(championships)
    .set({ status: "published" })
    .where(eq(championships.id, made.data.id));
  return made.data.id;
}

const SOLO: EventConfig = {
  eventShape: { teamEvent: false, draft: false, sizing: { mode: "perTeam", value: 6 } },
};

function setupOf(rounds: number) {
  return {
    rounds: Array.from({ length: rounds }, () => ({ name: null })),
    lowWins: false,
    bonuses: [] as { key: string; value: number }[],
  };
}

type Night = {
  eventId: string;
  title: string;
  /** Display name to user id, for every accepted applicant. */
  player: Record<string, string>;
  host: string;
};

/**
 * A published solo night scored in `rounds` rounds, counting towards
 * `seasonId` (or towards nothing when null), with these accepted applicants
 * and a host who is signed in and about to save. `hostPlays` seats the host too.
 */
async function roundNight(
  seasonId: string | null,
  names: readonly string[],
  rounds: number,
  options: { hostPlays?: boolean } = {}
): Promise<Night> {
  counter += 1;
  const event = unwrap(
    await createEvent({ ...PUBLISHABLE, title: `Popsauce ${counter}`, capacity: 64 }, db)
  );
  unwrap(await publishEvent(event.id, db));
  unwrap(await updateEvent(event.id, { config: SOLO }, db));
  if (seasonId) unwrap(await addCountingEvent(seasonId, event.id, db));

  const player: Record<string, string> = {};
  for (const name of names) {
    const userId = await makeUser(db, { displayName: name });
    unwrap(await applyToEvent(event.id, userId, {}, db));
    player[name] = userId;
  }

  const host = await makeUser(db, { displayName: `Host ${counter}` });
  await makeHost(db, event.id, host);
  if (options.hostPlays) unwrap(await applyToEvent(event.id, host, {}, db));
  state.userId = host;
  unwrap(await saveRoundScoringAction(event.id, setupOf(rounds)));
  await settle();
  return { eventId: event.id, title: event.title, player, host };
}

/** Wait for everything the actions deferred to `after()`. */
async function settle(): Promise<void> {
  await Promise.all(state.jobs);
  state.jobs = [];
}

/** Save one round through the action, as the screen would, and let the news go out. */
async function score(
  night: Night,
  roundIndex: number,
  scores: Record<string, number | null>
): Promise<Awaited<ReturnType<typeof saveRoundAction>>> {
  const expected = (await listRoundScores(night.eventId)).filter(
    (row) => row.roundIndex === roundIndex
  );
  const result = await saveRoundAction(night.eventId, {
    roundIndex,
    entries: Object.entries(scores).map(([name, value]) => ({
      userId: night.player[name] ?? (name === "host" ? night.host : name),
      score: value,
      bonuses: {},
    })),
    expected,
  });
  await settle();
  return result;
}

/** The same scores into every round from `from` to `to` — an ordinary evening. */
async function scoreRounds(
  night: Night,
  from: number,
  to: number,
  scores: Record<string, number | null>
): Promise<void> {
  for (let round = from; round <= to; round += 1) {
    unwrap(await score(night, round, scores));
  }
}

/**
 * Rows in a fixed order. `listRoundScores` orders a round by its row id, which
 * is a random uuid, and a re-saved round gets new ids — so "the rows are what
 * they were" has to be asserted on content, not on position.
 */
function byRoundAndUser<T extends { roundIndex: number; userId: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((x, y) =>
    x.roundIndex !== y.roundIndex ? x.roundIndex - y.roundIndex : x.userId < y.userId ? -1 : 1
  );
}

async function heard(userId: string): Promise<string[]> {
  const rows = await listNotifications(userId, db);
  return rows.filter((row) => row.kind === "standings_changed").map((row) => row.title);
}

function posted(): DiscordMessage[] {
  return fetchStub.mock.calls.map(([, init]) => JSON.parse(String(init.body)) as DiscordMessage);
}

async function failures(eventId: string) {
  return (await listAudit({ eventId }, db)).filter((row) => row.action === "announcement.failed");
}

/**
 * The season's table as (name, position, points), by position and then by
 * name — level members are shown level (R-181) and the page promises nothing
 * about which of them is printed first.
 */
async function standingsOf(seasonId: string): Promise<Array<[string, number, number]>> {
  const row = await getChampionship(seasonId, db);
  const page = await seasonPage(row!, db);
  return page.standings
    .map((player) => [player.name, player.position, player.points] as [string, number, number])
    .sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0]));
}

/* ------------------------------------------------------------------ */
/* The trigger: the round that completes the night                    */
/* ------------------------------------------------------------------ */

describe("when a round save tells people about the season", () => {
  it("stays silent while the night is part-scored, and speaks when the last round goes in", async () => {
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Bo", "Cy"], 3);
    const { Ada, Bo, Cy } = night.player;

    unwrap(await score(night, 1, { Ada: 10, Bo: 8, Cy: 6 }));
    unwrap(await score(night, 2, { Ada: 10, Bo: 8, Cy: 6 }));

    // The season already shows a provisional table, and nobody has been told.
    expect((await standingsOf(seasonId)).map(([name]) => name)).toEqual(["Ada", "Bo", "Cy"]);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await heard(Ada)).toEqual([]);
    expect(await heard(Bo)).toEqual([]);
    expect(await heard(Cy)).toEqual([]);

    unwrap(await score(night, 3, { Ada: 10, Bo: 8, Cy: 6 }));

    expect(await heard(Ada)).toEqual([`The Cup ${counter - 1} standings have changed`]);
    expect(await heard(Bo)).toHaveLength(1);
    expect(await heard(Cy)).toHaveLength(1);
    const [message] = posted();
    expect(posted()).toHaveLength(1);
    expect(message.embeds[0].footer?.text).toBe("Standings");
    expect(message.embeds[0].description).toContain("**Ada**");
    expect(message.embeds[0].fields?.map((field) => field.value)).toEqual([
      "Ada — 25",
      "Bo — 18",
      "Cy — 15",
    ]);
  });

  it("posts one announcement for six rounds scored in one night", async () => {
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Bo"], 6);

    await scoreRounds(night, 1, 6, { Ada: 10, Bo: 8 });

    // Six saves actually performed; one post, one notification each.
    expect(await listRoundScores(night.eventId)).toHaveLength(12);
    expect(posted()).toHaveLength(1);
    expect(await heard(night.player.Ada)).toHaveLength(1);
    expect(await heard(night.player.Bo)).toHaveLength(1);
  });

  it("announces the round that completes the night even when that round moved nobody", async () => {
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Bo"], 2);

    unwrap(await score(night, 1, { Ada: 10, Bo: 5 }));
    const provisional = await standingsOf(seasonId);
    unwrap(await score(night, 2, { Ada: 10, Bo: 5 }));

    // The table after the final round is the table before it — and it is still
    // the first time there is a result to report.
    expect(await standingsOf(seasonId)).toEqual(provisional);
    expect(posted()).toHaveLength(1);
    expect(await heard(night.player.Bo)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Corrections after the night                                        */
/* ------------------------------------------------------------------ */

describe("a correction after the night is complete", () => {
  it("announces again when it moves the standings, and tells the players again the next day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T21:00:00Z"));
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Bo"], 2);
    await scoreRounds(night, 1, 2, { Ada: 10, Bo: 8 });
    expect((await standingsOf(seasonId)).map(([name]) => name)).toEqual(["Ada", "Bo"]);

    // Bo's round 2 was 18, not 8 — noticed the next morning.
    vi.setSystemTime(new Date("2026-11-11T09:00:00Z"));
    unwrap(await score(night, 2, { Ada: 10, Bo: 18 }));

    expect((await standingsOf(seasonId)).map(([name]) => name)).toEqual(["Bo", "Ada"]);
    expect(posted()).toHaveLength(2);
    expect(posted()[1].embeds[0].description).toContain("**Bo**");
    expect(await heard(night.player.Ada)).toHaveLength(2);
    expect(await heard(night.player.Bo)).toHaveLength(2);
  });

  it("announces a correction that moves points but no places", async () => {
    /*
     * "The standings" are who stands where *and on how many points*. A typed
     * night and a round night in one season; the correction ties Bo and Cy in
     * the round night, so Cy's season total moves from 30 to 33 while the
     * season's positions stay 1, 2, 3.
     */
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Bo", "Cy"], 1);
    const { Ada, Bo, Cy } = night.player;
    counter += 1;
    const [typed] = await db
      .insert(events)
      .values({ slug: `typed-${counter}`, title: "Typed night", status: "complete" })
      .returning({ id: events.id });
    for (const userId of [Ada, Bo, Cy]) {
      await db.insert(applications).values({ eventId: typed.id, userId, status: "accepted" });
    }
    unwrap(await addCountingEvent(seasonId, typed.id, db));
    unwrap(
      await setPlacements(
        typed.id,
        [
          { id: Ada, position: 1 },
          { id: Bo, position: 2 },
          { id: Cy, position: 3 },
        ],
        db
      )
    );

    unwrap(await score(night, 1, { Ada: 30, Bo: 20, Cy: 10 }));
    expect(await standingsOf(seasonId)).toEqual([
      ["Ada", 1, 50],
      ["Bo", 2, 36],
      ["Cy", 3, 30],
    ]);
    expect(posted()).toHaveLength(1);

    unwrap(await score(night, 1, { Ada: 30, Bo: 20, Cy: 20 }));

    expect(await standingsOf(seasonId)).toEqual([
      ["Ada", 1, 50],
      ["Bo", 2, 36],
      ["Cy", 3, 33],
    ]);
    expect(posted()).toHaveLength(2);
  });

  it("announces a correction that moves places but no points — a countback move", async () => {
    /*
     * The other half of "who stands where, on how many points". A two-row
     * points table makes 3rd and 4th worth the same (the taking-part points),
     * so swapping Ada and Di between them moves nobody's total — but the tie
     * between Ada and Bo on 23 is now broken on seconds-then-thirds (R-181),
     * and Ada drops from a shared 2nd to 3rd.
     */
    counter += 1;
    const made = await createChampionship(
      { name: `Cup ${counter}`, pointsTable: [25, 18], participationPoints: 5 },
      db
    );
    if (!made.ok) throw new Error(made.error);
    const seasonId = made.data.id;
    await db.update(championships).set({ status: "published" }).where(eq(championships.id, seasonId));
    const night = await roundNight(seasonId, ["Ada", "Bo", "Cy", "Di"], 1);
    const { Ada, Bo, Cy, Di } = night.player;
    counter += 1;
    const [typed] = await db
      .insert(events)
      .values({ slug: `typed-${counter}`, title: "Typed night", status: "complete" })
      .returning({ id: events.id });
    for (const userId of [Ada, Bo, Cy, Di]) {
      await db.insert(applications).values({ eventId: typed.id, userId, status: "accepted" });
    }
    unwrap(await addCountingEvent(seasonId, typed.id, db));
    unwrap(
      await setPlacements(
        typed.id,
        [
          { id: Cy, position: 1 },
          { id: Ada, position: 2 },
          { id: Bo, position: 3 },
          { id: Di, position: 4 },
        ],
        db
      )
    );

    unwrap(await score(night, 1, { Cy: 30, Bo: 20, Ada: 10, Di: 5 }));
    expect(await standingsOf(seasonId)).toEqual([
      ["Cy", 1, 50],
      ["Ada", 2, 23],
      ["Bo", 2, 23],
      ["Di", 4, 10],
    ]);
    expect(posted()).toHaveLength(1);

    unwrap(await score(night, 1, { Cy: 30, Bo: 20, Di: 10, Ada: 5 }));

    expect(await standingsOf(seasonId)).toEqual([
      ["Cy", 1, 50],
      ["Bo", 2, 23],
      ["Ada", 3, 23],
      ["Di", 4, 10],
    ]);
    expect(posted()).toHaveLength(2);
  });

  it("announces nothing when the round is saved again exactly as it was", async () => {
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Bo"], 2);
    await scoreRounds(night, 1, 2, { Ada: 10, Bo: 8 });
    expect(posted()).toHaveLength(1);
    const before = await listRoundScores(night.eventId);

    unwrap(await score(night, 2, { Ada: 10, Bo: 8 }));

    expect(byRoundAndUser(await listRoundScores(night.eventId))).toEqual(byRoundAndUser(before));
    expect(posted()).toHaveLength(1);
  });

  it("announces nothing for a correction that changes a score and moves nobody", async () => {
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Bo"], 2);
    await scoreRounds(night, 1, 2, { Ada: 10, Bo: 8 });
    const standings = await standingsOf(seasonId);

    // Ada scored 12 in round 2, not 10. She was first and stays first.
    unwrap(await score(night, 2, { Ada: 12, Bo: 8 }));

    expect((await listRoundScores(night.eventId)).find((row) => row.roundIndex === 2 && row.userId === night.player.Ada)?.score).toBe(12);
    expect(await standingsOf(seasonId)).toEqual(standings);
    expect(posted()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Who hears, and what stays silent                                   */
/* ------------------------------------------------------------------ */

describe("who is told", () => {
  it("tells the people who played — the unplaced too — and not the host who saved, nor a muted member", async () => {
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Idle", "Muted"], 1, { hostPlays: true });
    const { Ada, Idle, Muted } = night.player;
    await setPref(Muted, "standings_changed", { inApp: false, discord: false }, db);

    // Idle holds a seat and plays nothing; the host plays and saves.
    unwrap(await score(night, 1, { Ada: 10, Muted: 8, host: 6 }));

    expect(await heard(Ada)).toHaveLength(1);
    expect(await heard(Idle)).toHaveLength(1);
    expect(await heard(Muted)).toEqual([]);
    expect(await heard(night.host)).toEqual([]);
  });

  it("says nothing, posts nothing and logs no failure for a night in no championship", async () => {
    const night = await roundNight(null, ["Ada", "Bo"], 2);

    await scoreRounds(night, 1, 2, { Ada: 10, Bo: 8 });

    expect(await listRoundScores(night.eventId)).toHaveLength(4);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await heard(night.player.Ada)).toEqual([]);
    expect(await heard(night.player.Bo)).toEqual([]);
    expect(await failures(night.eventId)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* A post Discord refuses (UC-43 5a's rule, on the automatic path)     */
/* ------------------------------------------------------------------ */

describe("a post Discord refuses", () => {
  it("is audited against the event, and the save claims nothing about a post", async () => {
    fetchStub.mockResolvedValue(new Response(null, { status: 404 }));
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Bo"], 1);

    const result = unwrap(await score(night, 1, { Ada: 10, Bo: 8 }));

    // The save itself succeeded, and says only what the save did.
    expect(Object.keys(result).sort()).toEqual(["name", "replaced", "roundIndex", "rows", "title"]);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const failed = await failures(night.eventId);
    expect(failed).toHaveLength(1);
    expect(failed[0].summary).toBe(
      'The "standings_changed" announcement did not go out — Discord answered 404.'
    );
    expect(JSON.stringify(failed[0])).not.toContain("supersecretwebhooktoken");
    // No claim was taken and nothing says a post went out by hand.
    expect(
      await db
        .select({ kind: announcementClaims.kind })
        .from(announcementClaims)
        .where(and(eq(announcementClaims.eventId, night.eventId)))
    ).toEqual([]);
    expect(
      (await listAudit({ eventId: night.eventId }, db)).filter((row) =>
        row.action.startsWith("announcement.posted")
      )
    ).toEqual([]);
  });
});
