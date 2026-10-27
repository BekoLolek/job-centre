import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  type Database,
  type EventConfig,
  SETTING_KEYS,
  championships,
  eventRoundScores,
} from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";
import type { AnnouncementSettings, DiscordMessage } from "@/lib/announce";

/*
 * Task 97 — UC-36 1-3 reached from the Scoring panel (R-236).
 *
 * Task 95 made the round save ask one question — *did this write complete the
 * night's table, or move the standings of a complete one?* — and accepted that
 * a night cut short never announces on its own. A trim is exactly how a night
 * cut short gets finished: six rounds set up, four played, the setup trimmed
 * to four, and at that moment the table is complete. These tests pin that the
 * scoring save asks **the same question through the same code**, so:
 *
 *   - a trim that completes the table announces, once;
 *   - a trim that leaves it part-scored announces nothing;
 *   - a refused trim announces nothing, and the confirmed one does;
 *   - a trim that shortens a *complete* table announces only when the
 *     standings moved, because rounds left the total;
 *   - turning round scoring off announces nothing, matching the typed path's
 *     cleared order.
 *
 * The harness is `round-save-news.test.ts`'s, borrowed whole rather than
 * extended, so that file stays byte-identical — it is the guard that the round
 * save's own behaviour did not move. "Announces nothing" is a sender with zero
 * calls **and** no `announcement.failed` row, never "no error came out".
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

const { clearRoundScoringAction, saveRoundAction, saveRoundScoringAction } = await import(
  "../actions"
);
const { applyToEvent, createEvent, publishEvent, updateEvent } = await import("@/lib/events");
const { listRoundScores } = await import("@/lib/round-scores");
const { addCountingEvent, createChampionship, getChampionship } = await import("@/lib/championships");
const { setPlacements } = await import("@/lib/championship-results");
const { seasonPage } = await import("@/lib/championship-season");
const { listNotifications } = await import("@/lib/notifications");
const { setAnnouncementSettings, setIntegrationSetting } = await import("@/lib/discord");
const { defaultAnnouncementSettings } = await import("@/lib/announce");
const { listAudit } = await import("@/lib/audit");

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
  vi.stubEnv("DISCORD_BOT_TOKEN", "");
  vi.stubGlobal("fetch", fetchStub);
  fetchStub.mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(() => {
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

function refusal<T>(result: { ok: true; data: T } | { ok: false; error: string }): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
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

function setupOf(rounds: number, lowWins = false) {
  return {
    rounds: Array.from({ length: rounds }, () => ({ name: null })),
    lowWins,
    bonuses: [] as { key: string; value: number }[],
  };
}

type Night = {
  eventId: string;
  player: Record<string, string>;
  host: string;
};

/**
 * A published solo night set up with `rounds` rounds (or not round-scored at
 * all when null), counting towards `seasonId` (or towards nothing when null),
 * with these accepted applicants and a host who is signed in and about to save.
 */
async function roundNight(
  seasonId: string | null,
  names: readonly string[],
  rounds: number | null
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
  state.userId = host;
  if (rounds !== null) {
    unwrap(await saveRoundScoringAction(event.id, setupOf(rounds)));
    await settle();
  }
  return { eventId: event.id, player, host };
}

/** Wait for everything the actions deferred to `after()`. */
async function settle(): Promise<void> {
  await Promise.all(state.jobs);
  state.jobs = [];
}

/** Save one round through the action, as the screen would, and let the news go out. */
async function score(night: Night, roundIndex: number, scores: Record<string, number>): Promise<void> {
  const expected = (await listRoundScores(night.eventId)).filter(
    (row) => row.roundIndex === roundIndex
  );
  unwrap(
    await saveRoundAction(night.eventId, {
      roundIndex,
      entries: Object.entries(scores).map(([name, value]) => ({
        userId: night.player[name],
        score: value,
        bonuses: {},
      })),
      expected,
    })
  );
  await settle();
}

/** Save the Scoring panel through the action, and let the news go out. */
async function rescore(
  night: Night,
  setup: ReturnType<typeof setupOf>,
  options: { confirmed?: boolean } = {}
): Promise<Awaited<ReturnType<typeof saveRoundScoringAction>>> {
  const result = await saveRoundScoringAction(night.eventId, { ...setup, ...options });
  await settle();
  return result;
}

/**
 * Rows in a fixed order. `listRoundScores` orders a round by its row id, which
 * is a random uuid — so "the rows are what they were" is asserted on content.
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

/** The season's table as (name, position, points), by position and then by name. */
async function standingsOf(seasonId: string): Promise<Array<[string, number, number]>> {
  const row = await getChampionship(seasonId, db);
  const page = await seasonPage(row!, db);
  return page.standings
    .map((player) => [player.name, player.position, player.points] as [string, number, number])
    .sort((x, y) => x[1] - y[1] || x[0].localeCompare(y[0]));
}

/* ------------------------------------------------------------------ */
/* A trim that completes the table                                    */
/* ------------------------------------------------------------------ */

describe("a trim that completes a part-scored table", () => {
  it("announces once and tells the players, as the last round going in would have", async () => {
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Bo", "Cy"], 3);
    const { Ada, Bo, Cy } = night.player;
    await score(night, 1, { Ada: 10, Bo: 8, Cy: 6 });
    await score(night, 2, { Ada: 10, Bo: 8, Cy: 6 });

    // Task 95's accepted silence: two of three rounds in, nobody told.
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await heard(Ada)).toEqual([]);

    // Round 3 was never played; the setup is trimmed to what was.
    const saved = unwrap(await rescore(night, setupOf(2)));

    expect(saved.losses).toEqual([]);
    expect(posted()).toHaveLength(1);
    const [message] = posted();
    expect(message.embeds[0].footer?.text).toBe("Standings");
    expect(message.embeds[0].fields?.map((field) => field.value)).toEqual([
      "Ada — 25",
      "Bo — 18",
      "Cy — 15",
    ]);
    expect(await heard(Ada)).toEqual([`The Cup ${counter - 1} standings have changed`]);
    expect(await heard(Bo)).toHaveLength(1);
    expect(await heard(Cy)).toHaveLength(1);
    expect(await heard(night.host)).toEqual([]);
  });

  it("announces nothing when the table is still part-scored afterwards", async () => {
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Bo"], 4);
    await score(night, 1, { Ada: 10, Bo: 8 });

    unwrap(await rescore(night, setupOf(3)));

    // One of three rounds in: nothing to report, and nothing that crashed.
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await failures(night.eventId)).toEqual([]);
    expect(await heard(night.player.Ada)).toEqual([]);
    expect(await heard(night.player.Bo)).toEqual([]);
  });

  it("announces nothing on the refused trim, and announces on the confirmed one", async () => {
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Bo"], 3);
    await score(night, 1, { Ada: 10, Bo: 8 });
    await score(night, 2, { Ada: 10, Bo: 8 });
    const rowsBefore = await listRoundScores(night.eventId);
    const standings = await standingsOf(seasonId);

    // UC-44 2b: round 2 holds scores, so cutting to one round asks first.
    expect(refusal(await rescore(night, setupOf(1)))).toBe(
      "Cutting the night to 1 round discards 2 scores, from Round 2. Tick the box below to go ahead."
    );

    // Refused means nothing happened — not the rows, not the standings, and
    // not a word to anybody.
    expect(byRoundAndUser(await listRoundScores(night.eventId))).toEqual(byRoundAndUser(rowsBefore));
    expect(await standingsOf(seasonId)).toEqual(standings);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await failures(night.eventId)).toEqual([]);
    expect(await heard(night.player.Ada)).toEqual([]);

    const saved = unwrap(await rescore(night, setupOf(1), { confirmed: true }));

    expect(saved.scoresDiscarded).toBe(2);
    expect(posted()).toHaveLength(1);
    expect(await heard(night.player.Ada)).toHaveLength(1);
    expect(await heard(night.player.Bo)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* A trim that shortens a complete table                              */
/* ------------------------------------------------------------------ */

describe("a trim that shortens a complete table", () => {
  it("announces again when the rounds that left moved the standings", async () => {
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Bo"], 2);
    await score(night, 1, { Ada: 10, Bo: 8 });
    await score(night, 2, { Ada: 5, Bo: 20 });
    expect((await standingsOf(seasonId)).map(([name]) => name)).toEqual(["Bo", "Ada"]);
    expect(posted()).toHaveLength(1);

    // Round 2 is struck from the night; Ada's 10 to Bo's 8 is now the whole of it.
    unwrap(await rescore(night, setupOf(1), { confirmed: true }));

    expect((await standingsOf(seasonId)).map(([name]) => name)).toEqual(["Ada", "Bo"]);
    expect(posted()).toHaveLength(2);
    expect(posted()[1].embeds[0].description).toContain("**Ada**");
  });

  it("announces nothing when the rounds that left moved nobody", async () => {
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Bo"], 2);
    await score(night, 1, { Ada: 10, Bo: 8 });
    await score(night, 2, { Ada: 10, Bo: 8 });
    const standings = await standingsOf(seasonId);
    expect(posted()).toHaveLength(1);

    unwrap(await rescore(night, setupOf(1), { confirmed: true }));

    // Same places, same points: the season did not move, so there is no news.
    expect(await listRoundScores(night.eventId)).toHaveLength(2);
    expect(await standingsOf(seasonId)).toEqual(standings);
    expect(posted()).toHaveLength(1);
    expect(await failures(night.eventId)).toEqual([]);
  });

  it("announces a direction change on a complete night, which turns the table upside down", async () => {
    /*
     * Not a trim, but the same save and the same question: UC-44 3a's
     * confirmed correction is the biggest move a scoring save can make to the
     * season, and under Task 95's rule a complete table that moved is news.
     */
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Bo"], 1);
    await score(night, 1, { Ada: 10, Bo: 8 });
    expect((await standingsOf(seasonId)).map(([name]) => name)).toEqual(["Ada", "Bo"]);
    expect(posted()).toHaveLength(1);

    unwrap(await rescore(night, setupOf(1, true), { confirmed: true }));

    expect((await standingsOf(seasonId)).map(([name]) => name)).toEqual(["Bo", "Ada"]);
    expect(posted()).toHaveLength(2);
    expect(posted()[1].embeds[0].description).toContain("**Bo**");
  });
});

/* ------------------------------------------------------------------ */
/* Switching a night to rounds                                        */
/* ------------------------------------------------------------------ */

describe("switching a night to rounds when kept rows already fill the setup", () => {
  it("is the completing save, and announces even when the season reads as it did", async () => {
    /*
     * Task 93's round-trip inside a season: a night with no setup is never
     * complete, so the save that gives it one the rows fill is the save that
     * completes the table — and Task 95's rule fires on completion whether or
     * not anybody moved. The outgrown typed order here happens to pay exactly
     * what the table pays, so the standings read the same before and after;
     * the announcement is still owed, because it is the first result.
     */
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Bo"], null);
    const { Ada, Bo } = night.player;
    unwrap(
      await setPlacements(
        night.eventId,
        [
          { id: Ada, position: 1 },
          { id: Bo, position: 2 },
        ],
        db
      )
    );
    await db.insert(eventRoundScores).values([
      { eventId: night.eventId, roundIndex: 1, userId: Ada, score: 10, bonuses: {} },
      { eventId: night.eventId, roundIndex: 1, userId: Bo, score: 8, bonuses: {} },
    ]);
    const typed = await standingsOf(seasonId);
    expect(typed).toEqual([
      ["Ada", 1, 25],
      ["Bo", 2, 18],
    ]);
    expect(fetchStub).not.toHaveBeenCalled();

    const saved = unwrap(await rescore(night, setupOf(1)));

    expect(saved.losses).toEqual([]);
    expect(await standingsOf(seasonId)).toEqual(typed);
    expect(posted()).toHaveLength(1);
    expect(await heard(Ada)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* What stays silent                                                  */
/* ------------------------------------------------------------------ */

describe("what a scoring save does not announce", () => {
  it("says nothing when round scoring is turned off, as a cleared typed order says nothing", async () => {
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Bo"], 1);
    await score(night, 1, { Ada: 10, Bo: 8 });
    expect(posted()).toHaveLength(1);
    expect(await heard(night.player.Ada)).toHaveLength(1);

    const cleared = unwrap(await clearRoundScoringAction(night.eventId, { confirmed: true }));
    await settle();

    // The night has stopped counting; `announceStandings` and
    // `notifyStandingsChanged` both already refuse an event with no order on
    // it, and the switch-off does not ask them.
    expect(cleared.changed).toBe(true);
    expect(await standingsOf(seasonId)).toEqual([]);
    expect(posted()).toHaveLength(1);
    expect(await failures(night.eventId)).toEqual([]);
    expect(await heard(night.player.Ada)).toHaveLength(1);
  });

  it("says nothing, posts nothing and logs no failure for a night in no championship", async () => {
    const night = await roundNight(null, ["Ada", "Bo"], 2);
    await score(night, 1, { Ada: 10, Bo: 8 });

    unwrap(await rescore(night, setupOf(1)));

    expect(await listRoundScores(night.eventId)).toHaveLength(2);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await failures(night.eventId)).toEqual([]);
    expect(await heard(night.player.Ada)).toEqual([]);
    expect(await heard(night.player.Bo)).toEqual([]);
  });

  it("says nothing when the setup is saved again exactly as it was on a complete night", async () => {
    const seasonId = await season();
    const night = await roundNight(seasonId, ["Ada", "Bo"], 1);
    await score(night, 1, { Ada: 10, Bo: 8 });
    expect(posted()).toHaveLength(1);

    unwrap(await rescore(night, setupOf(1)));

    expect(posted()).toHaveLength(1);
    expect(await failures(night.eventId)).toEqual([]);
  });
});
