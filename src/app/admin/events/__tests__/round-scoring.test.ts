import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  type Database,
  type EventConfig,
  auditLog,
  championships,
  eventRoundScores,
  events,
} from "@/db";
import {
  PUBLISHABLE,
  type TestDatabase,
  freshDatabase,
  makeHost,
  makeUser,
} from "@/db/__tests__/helpers";

/*
 * Task 87's write — R-225, R-226, R-229 / UC-44, and UC-42 5b one level down.
 *
 * Set up exactly as `event-shape.test.ts`: the action runs for real against an
 * in-memory Postgres with only what cannot run outside a Next request replaced
 * — the session cookie, the page cache and `after()`.
 *
 * Five things exist only at this layer and so are proved only here.
 *
 * **That the setup round-trips through `events.config` with no migration**, and
 * survives a schedule save (and the schedule survives it) — the pair Task 78's
 * `Left over` note paid for, because `saveScheduleSettingsAction` rewrites the
 * whole of `config.format` and `updateEvent` merges one level deep.
 *
 * **That an event which predates the feature reads as not round-scored**,
 * through the same reader the screen uses, over a row `createEvent` wrote with
 * no knowledge of the key.
 *
 * **That a refusal stores nothing** — the config is compared as the bytes
 * Postgres holds, not merely read back as "no error".
 *
 * **The three confirmations**, each asserted with the whole sentence and with
 * the rows counted before and after: refused, nothing moved; confirmed, exactly
 * what was named is gone and nothing else. Task 88 has not landed, so the rows
 * the destructive rules count are inserted directly.
 *
 * **That the action guards itself whatever the editor draws** (UC-42 5b): the
 * panel is absent for a team event, and the action still refuses a member and
 * still succeeds for the manager. Next's own guidance: "Render-time gating
 * (only rendering a form on an authenticated page) is not a security boundary."
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
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
vi.mock("next/server", () => ({ after: () => {} }));

const { clearRoundScoringAction, saveRoundScoringAction } = await import("../actions");
const { saveScheduleSettingsAction } = await import("../format-actions");
const { ROUND_SCORED_REFUSAL, finishingOrderFor, listPlacements, setPlacements } = await import(
  "@/lib/championship-results"
);
const { addCountingEvent, createChampionship, getChampionship } = await import(
  "@/lib/championships"
);
const { seasonPage } = await import("@/lib/championship-season");
const { applyToEvent, createEvent, getEventById, publishEvent, updateEvent } = await import(
  "@/lib/events"
);
const { eventShapeFrom, roundScoringConfirmRefusal, roundScoringFrom, roundScoringLosses } =
  await import("@/lib/events-policy");
const { scheduleSettingsFrom } = await import("@/lib/format");
const { listRoundScores } = await import("@/lib/round-scores");
const { visibleSetup } = await import("@/components/admin/events/tabs");

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

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function refusal<T>(result: { ok: true; data: T } | { ok: false; error: string }): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

type Fixture = { eventId: string; members: string[]; names: Record<string, string>; host: string };

const SOLO: EventConfig = {
  eventShape: { teamEvent: false, draft: false, sizing: { mode: "perTeam", value: 6 } },
};

/** A published event with `people` accepted applicants and a host; solo unless told otherwise. */
async function hostedEvent(people: number, config: EventConfig | null = SOLO): Promise<Fixture> {
  counter += 1;
  const event = unwrap(
    await createEvent({ ...PUBLISHABLE, title: `Scored ${counter}`, capacity: 64 }, db)
  );
  unwrap(await publishEvent(event.id, db));
  if (config) unwrap(await updateEvent(event.id, { config }, db));

  const members: string[] = [];
  const names: Record<string, string> = {};
  for (let index = 0; index < people; index += 1) {
    const name = `Player ${counter}-${index}`;
    const userId = await makeUser(db, { displayName: name });
    unwrap(await applyToEvent(event.id, userId, {}, db));
    members.push(userId);
    names[userId] = name;
  }

  const host = await makeUser(db, { displayName: `Host ${counter}` });
  await makeHost(db, event.id, host);
  state.userId = host;
  return { eventId: event.id, members, names, host };
}

async function storedConfig(eventId: string): Promise<EventConfig> {
  const [row] = await db.select({ config: events.config }).from(events).where(eq(events.id, eventId));
  return row.config;
}

/** The config as Postgres holds it — the bytes, not a parse of them. */
async function configBytes(eventId: string): Promise<string> {
  const result = await handle.client.query<{ config: string }>(
    `select config::text as config from events where id = $1`,
    [eventId]
  );
  return result.rows[0].config;
}

/** Task 88's write has not landed; the rows the destructive rules count go in directly. */
async function score(
  eventId: string,
  roundIndex: number,
  userId: string,
  points: number,
  bonuses: Record<string, number> = {}
) {
  await db.insert(eventRoundScores).values({ eventId, roundIndex, userId, score: points, bonuses });
}

const rounds = (count: number, named: Record<number, string> = {}) =>
  Array.from({ length: count }, (_, index) => ({ name: named[index + 1] ?? null }));

const SIX = {
  rounds: rounds(6, { 6: "Final" }),
  lowWins: false,
  bonuses: [
    { key: "Sub-0.5 answer", value: 2 },
    { key: "Gold run", value: 5 },
  ],
};

/* --------------------------------------------------------------------- */
/* It persists, with no migration (UC-44 1-6)                            */
/* --------------------------------------------------------------------- */

describe("storing how a night is scored", () => {
  it("round-trips the count, the names, the direction and the bonuses", async () => {
    const fixture = await hostedEvent(2);
    const saved = unwrap(await saveRoundScoringAction(fixture.eventId, { ...SIX, lowWins: true }));

    expect(saved.scoring).toEqual({ ...SIX, lowWins: true });
    expect(saved.losses).toEqual([]);
    expect(roundScoringFrom(await storedConfig(fixture.eventId))).toEqual(saved.scoring);
  });

  it("writes one top-level key on events.config and no column", async () => {
    const fixture = await hostedEvent(2);
    unwrap(await saveRoundScoringAction(fixture.eventId, SIX));

    const config = await storedConfig(fixture.eventId);
    expect(config).toHaveProperty("roundScoring");
    expect(config.format).toBeUndefined();
    // Exactly the three facts, and the ranking's two by the ranking's names.
    const stored = config.roundScoring as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["bonuses", "lowWins", "rounds"]);
  });

  it("stores the names trimmed, and a blank as no name", async () => {
    const fixture = await hostedEvent(2);
    const saved = unwrap(
      await saveRoundScoringAction(fixture.eventId, {
        ...SIX,
        rounds: [{ name: "  Warm-up " }, { name: "   " }, { name: null }],
        bonuses: [{ key: "  Fast  ", value: 2 }],
      })
    );
    expect(saved.scoring.rounds).toEqual([{ name: "Warm-up" }, { name: null }, { name: null }]);
    expect(saved.scoring.bonuses).toEqual([{ key: "Fast", value: 2 }]);
  });

  it("reads an event made before this panel existed as not round-scored", async () => {
    // Asserted against a row `createEvent` wrote with no knowledge of the key —
    // not against a hand-built `{}`. Every solo event on the site today is one
    // of these, and reading it as scored would claim a system it never had.
    const fixture = await hostedEvent(2);
    const event = await getEventById(fixture.eventId);
    expect(event!.config).not.toHaveProperty("roundScoring");
    expect(roundScoringFrom(event!.config)).toBeNull();
    expect(await listRoundScores(fixture.eventId)).toEqual([]);
  });

  it("survives the Schedule tab, and the schedule survives it", async () => {
    const fixture = await hostedEvent(2);
    unwrap(await saveRoundScoringAction(fixture.eventId, SIX));

    unwrap(
      await saveScheduleSettingsAction(fixture.eventId, {
        timing: scheduleSettingsFrom(null).timing,
        concurrentLobbies: 3,
        days: 2,
        blockDays: null,
      })
    );
    expect(roundScoringFrom(await storedConfig(fixture.eventId))).toEqual(SIX);

    unwrap(await saveRoundScoringAction(fixture.eventId, { ...SIX, lowWins: true }));
    const settings = scheduleSettingsFrom(await storedConfig(fixture.eventId));
    expect(settings.concurrentLobbies).toBe(3);
    expect(settings.days).toBe(2);
    // And the shape beside it is untouched.
    expect(eventShapeFrom(await storedConfig(fixture.eventId)).teamEvent).toBe(false);
  });

  it("raises the count with nothing re-scored (UC-44 2a)", async () => {
    const fixture = await hostedEvent(2);
    unwrap(await saveRoundScoringAction(fixture.eventId, SIX));
    await score(fixture.eventId, 1, fixture.members[0], 10, { "Gold run": 1 });
    const before = await listRoundScores(fixture.eventId);

    const saved = unwrap(
      await saveRoundScoringAction(fixture.eventId, { ...SIX, rounds: rounds(7, { 6: "Final" }) })
    );
    expect(saved.scoring.rounds.length).toBe(7);
    expect(saved.losses).toEqual([]);
    expect(await listRoundScores(fixture.eventId)).toEqual(before);
  });

  it("logs the change once, and says nothing when nothing moved", async () => {
    const fixture = await hostedEvent(2);
    unwrap(await saveRoundScoringAction(fixture.eventId, SIX));
    unwrap(await saveRoundScoringAction(fixture.eventId, SIX));

    const lines = await db
      .select({ summary: auditLog.summary })
      .from(auditLog)
      .where(and(eq(auditLog.eventId, fixture.eventId), eq(auditLog.action, "event.roundScoring")));
    expect(lines.length).toBe(1);
    expect(lines[0].summary).toContain("6 rounds, highest total wins, 2 bonuses");
  });
});

/* --------------------------------------------------------------------- */
/* What it refuses, storing nothing (UC-44 4b, 4c)                       */
/* --------------------------------------------------------------------- */

describe("what the save refuses", () => {
  it("refuses two bonuses with one name, and stores nothing (UC-44 4b)", async () => {
    const fixture = await hostedEvent(2);
    const before = await configBytes(fixture.eventId);

    const said = refusal(
      await saveRoundScoringAction(fixture.eventId, {
        ...SIX,
        bonuses: [{ key: "Fast", value: 2 }, { key: "fast", value: 3 }],
      })
    );
    expect(said).toBe(
      'Two bonuses are called "fast". The scoring screen picks a bonus out by its name, so each needs its own.'
    );
    expect(said).not.toContain("worth");
    expect(await configBytes(fixture.eventId)).toBe(before);
    expect(await storedConfig(fixture.eventId)).not.toHaveProperty("roundScoring");
  });

  it("refuses a bonus worth zero or less, and stores nothing (UC-44 4c)", async () => {
    const fixture = await hostedEvent(2);
    unwrap(await saveRoundScoringAction(fixture.eventId, SIX));
    const before = await configBytes(fixture.eventId);

    for (const value of [0, -1]) {
      const said = refusal(
        await saveRoundScoringAction(fixture.eventId, {
          ...SIX,
          bonuses: [{ key: "Fast", value }],
        })
      );
      expect(said, String(value)).toBe('"Fast" has to be worth at least a point. A penalty is not a bonus.');
      expect(said).not.toContain("Two bonuses");
    }
    // Byte for byte what was there before either attempt.
    expect(await configBytes(fixture.eventId)).toBe(before);
  });

  it("refuses a count outside the table's bound, and stores nothing", async () => {
    const fixture = await hostedEvent(2);
    const before = await configBytes(fixture.eventId);
    expect(refusal(await saveRoundScoringAction(fixture.eventId, { ...SIX, rounds: [] }))).toBe(
      "A night has at least one round."
    );
    expect(refusal(await saveRoundScoringAction(fixture.eventId, { ...SIX, rounds: rounds(33) }))).toBe(
      "A night has at most 32 rounds."
    );
    expect(await configBytes(fixture.eventId)).toBe(before);
  });

  it("refuses something off the wire that is not a setup at all", async () => {
    const fixture = await hostedEvent(2);
    expect(
      refusal(
        await saveRoundScoringAction(fixture.eventId, {
          rounds: "six" as unknown as { name: string | null }[],
          lowWins: false,
          bonuses: [],
        })
      )
    ).toBe("That is not a scoring setup.");
    expect(await storedConfig(fixture.eventId)).not.toHaveProperty("roundScoring");
  });
});

/* --------------------------------------------------------------------- */
/* The three confirmations (UC-44 2b, 3a, 4d)                            */
/* --------------------------------------------------------------------- */

/** Six rounds set up, with rounds 1, 5 and 6 scored and both bonuses awarded. */
async function scoredNight(): Promise<Fixture> {
  const fixture = await hostedEvent(3);
  unwrap(await saveRoundScoringAction(fixture.eventId, SIX));
  const [alice, bob, cass] = fixture.members;
  await score(fixture.eventId, 1, alice, 10, { "Sub-0.5 answer": 2 });
  await score(fixture.eventId, 1, bob, 8);
  await score(fixture.eventId, 5, alice, 7);
  await score(fixture.eventId, 5, cass, 9, { "Gold run": 1 });
  await score(fixture.eventId, 6, bob, 12, { "Sub-0.5 answer": 1 });
  return fixture;
}

describe("lowering the count below a scored round (UC-44 2b)", () => {
  it("is refused until confirmed, naming how many scores go and from which rounds", async () => {
    const fixture = await scoredNight();
    const before = await configBytes(fixture.eventId);
    const rowsBefore = await listRoundScores(fixture.eventId);

    const said = refusal(
      await saveRoundScoringAction(fixture.eventId, { ...SIX, rounds: rounds(4) })
    );
    expect(said).toBe(
      "Cutting the night to 4 rounds discards 3 scores, from Round 5 and Final. Tick the box below to go ahead."
    );
    // Not the validator's sentences.
    expect(said).not.toContain("Two bonuses");
    expect(said).not.toContain("worth");

    // Nothing written: neither the setup nor a row.
    expect(await configBytes(fixture.eventId)).toBe(before);
    expect(await listRoundScores(fixture.eventId)).toEqual(rowsBefore);
  });

  it("is the same sentence the panel computes from the same rows", async () => {
    const fixture = await scoredNight();
    const stored = roundScoringFrom(await storedConfig(fixture.eventId));
    const rows = await listRoundScores(fixture.eventId);
    const losses = roundScoringLosses(
      stored,
      { ...SIX, rounds: rounds(4) },
      rows,
      (userId) => fixture.names[userId]
    );
    expect(refusal(await saveRoundScoringAction(fixture.eventId, { ...SIX, rounds: rounds(4) }))).toBe(
      roundScoringConfirmRefusal(losses)
    );
  });

  it("discards exactly the scores it named once confirmed, and nothing else", async () => {
    const fixture = await scoredNight();
    const saved = unwrap(
      await saveRoundScoringAction(fixture.eventId, { ...SIX, rounds: rounds(4), confirmed: true })
    );

    expect(saved.scoring.rounds.length).toBe(4);
    expect(saved.losses).toEqual(["Cutting the night to 4 rounds discards 3 scores, from Round 5 and Final."]);
    expect(saved.scoresDiscarded).toBe(3);

    const left = await listRoundScores(fixture.eventId);
    expect(left.map((row) => row.roundIndex)).toEqual([1, 1]);
    // Round 1's awards stay exactly as they were.
    expect(left.find((row) => row.userId === fixture.members[0])!.bonuses).toEqual({
      "Sub-0.5 answer": 2,
    });
  });

  it("names the discard in the log", async () => {
    const fixture = await scoredNight();
    unwrap(await saveRoundScoringAction(fixture.eventId, { ...SIX, rounds: rounds(4), confirmed: true }));
    const lines = await db
      .select({ summary: auditLog.summary })
      .from(auditLog)
      .where(and(eq(auditLog.eventId, fixture.eventId), eq(auditLog.action, "event.roundScoring")));
    // Two: the fixture's own save of six rounds, and the cut.
    expect(lines.length).toBe(2);
    const cut = lines.find((line) => line.summary.includes("4 rounds"));
    expect(cut, "no log line for the cut").toBeDefined();
    expect(cut!.summary).toContain("discarding 3 scores");
  });
});

describe("deleting a bonus that has been awarded (UC-44 4d)", () => {
  it("is refused until confirmed, naming how many awards and to whom", async () => {
    const fixture = await scoredNight();
    const before = await configBytes(fixture.eventId);
    const [alice, bob] = fixture.members;

    const said = refusal(
      await saveRoundScoringAction(fixture.eventId, { ...SIX, bonuses: [SIX.bonuses[1]] })
    );
    expect(said).toBe(
      `Dropping "Sub-0.5 answer" takes back 3 awards, from ${fixture.names[alice]} (x2) and ${fixture.names[bob]}. Tick the box below to go ahead.`
    );
    expect(await configBytes(fixture.eventId)).toBe(before);
  });

  it("takes back exactly those awards once confirmed, leaving the scores and the other bonus", async () => {
    const fixture = await scoredNight();
    const [alice, bob, cass] = fixture.members;
    const saved = unwrap(
      await saveRoundScoringAction(fixture.eventId, {
        ...SIX,
        bonuses: [SIX.bonuses[1]],
        confirmed: true,
      })
    );
    expect(saved.awardsDiscarded).toBe(3);
    expect(saved.scoresDiscarded).toBe(0);

    const rows = await listRoundScores(fixture.eventId);
    expect(rows.length).toBe(5);
    const bonusesOf = (roundIndex: number, userId: string) =>
      rows.find((row) => row.roundIndex === roundIndex && row.userId === userId)!.bonuses;
    expect(bonusesOf(1, alice)).toEqual({});
    expect(bonusesOf(6, bob)).toEqual({});
    expect(bonusesOf(5, cass)).toEqual({ "Gold run": 1 });
    // The scores themselves did not move.
    expect(rows.find((row) => row.roundIndex === 1 && row.userId === alice)!.score).toBe(10);
  });

  it("lets an unawarded bonus go with no confirmation", async () => {
    const fixture = await hostedEvent(2);
    unwrap(await saveRoundScoringAction(fixture.eventId, SIX));
    await score(fixture.eventId, 1, fixture.members[0], 10, { "Gold run": 1 });
    const saved = unwrap(
      await saveRoundScoringAction(fixture.eventId, { ...SIX, bonuses: [SIX.bonuses[1]] })
    );
    expect(saved.losses).toEqual([]);
  });
});

describe("changing the direction once scores exist (UC-44 3a)", () => {
  it("is confirmed first, naming that the order inverts, and stores nothing until then", async () => {
    const fixture = await scoredNight();
    const before = await configBytes(fixture.eventId);

    const said = refusal(await saveRoundScoringAction(fixture.eventId, { ...SIX, lowWins: true }));
    expect(said).toBe(
      "Switching to lowest total wins turns the table upside down: the 5 scores already recorded rank the other way round. Tick the box below to go ahead."
    );
    expect(await configBytes(fixture.eventId)).toBe(before);
  });

  it("goes through once confirmed, with every row still there", async () => {
    const fixture = await scoredNight();
    const rowsBefore = await listRoundScores(fixture.eventId);
    const saved = unwrap(
      await saveRoundScoringAction(fixture.eventId, { ...SIX, lowWins: true, confirmed: true })
    );
    expect(saved.scoring.lowWins).toBe(true);
    expect(saved.scoresDiscarded).toBe(0);
    expect(saved.awardsDiscarded).toBe(0);
    expect(await listRoundScores(fixture.eventId)).toEqual(rowsBefore);
  });

  it("asks nothing on a night nobody has scored", async () => {
    const fixture = await hostedEvent(2);
    unwrap(await saveRoundScoringAction(fixture.eventId, SIX));
    expect(unwrap(await saveRoundScoringAction(fixture.eventId, { ...SIX, lowWins: true })).losses).toEqual(
      []
    );
  });
});

/* --------------------------------------------------------------------- */
/* Hiding a panel is not forbidding it (UC-42 5b)                        */
/* --------------------------------------------------------------------- */

describe("the hidden panel's action", () => {
  it("is absent from a team event's Setup rail, and still refuses a member", async () => {
    const fixture = await hostedEvent(2, null);
    const shape = eventShapeFrom(await storedConfig(fixture.eventId));
    expect(shape.teamEvent).toBe(true);
    expect(visibleSetup(shape)).not.toContain("scoring");

    state.userId = fixture.members[0];
    await expect(saveRoundScoringAction(fixture.eventId, SIX)).rejects.toThrow(/NEXT_REDIRECT/);
    state.userId = null;
    await expect(saveRoundScoringAction(fixture.eventId, SIX)).rejects.toThrow(/NEXT_REDIRECT/);
    expect(await storedConfig(fixture.eventId)).not.toHaveProperty("roundScoring");
    state.userId = fixture.host;
  });

  it("and still succeeds for the manager, because hiding is not forbidding", async () => {
    const fixture = await hostedEvent(2, null);
    expect(visibleSetup(eventShapeFrom(await storedConfig(fixture.eventId)))).not.toContain("scoring");

    const saved = unwrap(await saveRoundScoringAction(fixture.eventId, SIX));
    expect(saved.scoring).toEqual(SIX);
    expect(roundScoringFrom(await storedConfig(fixture.eventId))).toEqual(SIX);
  });
});

/* --------------------------------------------------------------------- */
/* Turning round scoring off (Task 93 — the step UC-44 was missing)      */
/* --------------------------------------------------------------------- */

/*
 * Task 87 found there was no way to unset `config.roundScoring`, and Task 91
 * made that a trap: `setPlacements` refuses a round-scored night, so an event
 * set up this way by mistake had no route to a result. The decision on the rows
 * is Task 91's, in its words — kept, never read, named on the screen that would
 * have read them, and read again exactly as they were only when the setup that
 * reads them is switched back on.
 *
 * What is proved only here: that the key is **gone** from the row rather than
 * present as `null` (`updateEvent` merges one level deep, so the spelling that
 * removes a key is the thing most likely to silently not work); that the refusal
 * wrote nothing, as bytes; that the rows survive the switch unchanged, scores
 * and awards included, and are read again when it is switched back on; and the
 * whole trap closing end to end — refused typed order, switch, typed order
 * accepted, season scored from it.
 */

/** The sentence `clearRoundScoringAction` refuses `scoredNight` with, before the box is ticked. */
function keptSentence(fixture: Fixture): string {
  const [alice, bob, cass] = fixture.members.map((userId) => fixture.names[userId]);
  return `Turning round scoring off leaves 5 scores with nothing to read them: ${alice} in Round 1 and Round 5; ${bob} in Round 1 and Final; ${cass} in Round 5. They are kept, not deleted, and would be read again exactly as they are if this night were scored in rounds again.`;
}

async function auditSummaries(eventId: string): Promise<string[]> {
  const lines = await db
    .select({ summary: auditLog.summary })
    .from(auditLog)
    .where(and(eq(auditLog.eventId, eventId), eq(auditLog.action, "event.roundScoring")));
  return lines.map((line) => line.summary);
}

describe("turning round scoring off", () => {
  it("is refused until confirmed, naming whose scores are left unread, and writes nothing", async () => {
    const fixture = await scoredNight();
    const before = await configBytes(fixture.eventId);
    const rowsBefore = await listRoundScores(fixture.eventId);

    const said = refusal(await clearRoundScoringAction(fixture.eventId));

    expect(said).toBe(`${keptSentence(fixture)} Tick the box below to go ahead.`);
    // Not one of the three discards, which share the box.
    expect(said).not.toContain("Cutting");
    expect(said).not.toContain("Dropping");
    expect(said).not.toContain("upside down");
    // Nothing written: the setup is still there, byte for byte, and so are the rows.
    expect(await configBytes(fixture.eventId)).toBe(before);
    expect(roundScoringFrom(await storedConfig(fixture.eventId))).toEqual(SIX);
    expect(await listRoundScores(fixture.eventId)).toEqual(rowsBefore);
  });

  it("is the same sentence the panel computes from the same rows", async () => {
    const fixture = await scoredNight();
    const stored = roundScoringFrom(await storedConfig(fixture.eventId));
    const rows = await listRoundScores(fixture.eventId);
    const losses = roundScoringLosses(stored, null, rows, (userId) => fixture.names[userId]);
    expect(losses).toEqual([keptSentence(fixture)]);
    expect(refusal(await clearRoundScoringAction(fixture.eventId))).toBe(
      roundScoringConfirmRefusal(losses)
    );
  });

  it("removes the key once confirmed — gone, not null — and keeps every row exactly as it was", async () => {
    const fixture = await scoredNight();
    const rowsBefore = await listRoundScores(fixture.eventId);
    expect(rowsBefore.length).toBe(5);

    const cleared = unwrap(await clearRoundScoringAction(fixture.eventId, { confirmed: true }));

    expect(cleared.changed).toBe(true);
    expect(cleared.losses).toEqual([keptSentence(fixture)]);
    expect(cleared.kept).toEqual(rowsBefore);

    // The key is absent from the row, not present as null or as the defaults:
    // `updateEvent` merges one level deep, so this is the assertion that the
    // spelling which removes a key actually removed it.
    const config = await storedConfig(fixture.eventId);
    expect(config).not.toHaveProperty("roundScoring");
    expect(roundScoringFrom(config)).toBeNull();
    expect(await configBytes(fixture.eventId)).not.toContain("roundScoring");
    // Its siblings are untouched.
    expect(eventShapeFrom(config).teamEvent).toBe(false);

    // Every row, with its score and its awards, exactly as before.
    expect(await listRoundScores(fixture.eventId)).toEqual(rowsBefore);
    const alice = rowsBefore.find((row) => row.roundIndex === 1 && row.userId === fixture.members[0])!;
    expect(alice.score).toBe(10);
    expect(alice.bonuses).toEqual({ "Sub-0.5 answer": 2 });
  });

  it("asks nothing on a night with nothing scored", async () => {
    const fixture = await hostedEvent(2);
    unwrap(await saveRoundScoringAction(fixture.eventId, SIX));

    const cleared = unwrap(await clearRoundScoringAction(fixture.eventId));

    expect(cleared).toEqual({ changed: true, kept: [], losses: [] });
    expect(await storedConfig(fixture.eventId)).not.toHaveProperty("roundScoring");
  });

  it("reads the kept scores again, exactly as they were, when round scoring is turned back on", async () => {
    /*
     * Criterion 3, answered the way Task 91 answered it for a typed order: the
     * rows do come back, and the screen says so — before the switch (the
     * sentence above) and while it is off (the panel's standing notice, held in
     * `scoring-panel.test.ts`). Asserted as the same rows, scores and awards
     * included, not as a count.
     */
    const fixture = await scoredNight();
    const rowsBefore = await listRoundScores(fixture.eventId);
    expect((await finishingOrderFor(fixture.eventId)).source).toBe("table");

    unwrap(await clearRoundScoringAction(fixture.eventId, { confirmed: true }));
    // Off: the rows are there and nothing reads them as a table.
    expect(await listRoundScores(fixture.eventId)).toEqual(rowsBefore);
    expect(await finishingOrderFor(fixture.eventId)).toEqual({ source: "typed", places: [] });

    // On again, with a setup the rows fit: nothing to confirm, nothing discarded.
    const saved = unwrap(await saveRoundScoringAction(fixture.eventId, SIX));
    expect(saved.losses).toEqual([]);
    expect(saved.scoresDiscarded).toBe(0);
    expect(saved.awardsDiscarded).toBe(0);
    expect(await listRoundScores(fixture.eventId)).toEqual(rowsBefore);
    const order = await finishingOrderFor(fixture.eventId);
    expect(order.source).toBe("table");
    // The table is ranked from exactly those rows, a blank taking the round's
    // worst: Cass 8 + 9 + 12 + 5 = 34, Alice 10 + 7 + 12 + 2×2 = 33, Bob 8 + 7 + 12 + 2 = 29.
    const [alice, bob, cass] = fixture.members;
    expect(order.places.map((place) => [place.id, place.position])).toEqual([
      [cass, 1],
      [alice, 2],
      [bob, 3],
    ]);
  });

  it("does nothing, and says so, on a night that is not scored in rounds", async () => {
    const fixture = await hostedEvent(2);
    const before = await configBytes(fixture.eventId);

    const cleared = unwrap(await clearRoundScoringAction(fixture.eventId, { confirmed: true }));

    expect(cleared.changed).toBe(false);
    expect(await configBytes(fixture.eventId)).toBe(before);
    expect(await auditSummaries(fixture.eventId)).toEqual([]);
  });

  it("logs the switch once, naming what was kept", async () => {
    const fixture = await scoredNight();
    unwrap(await clearRoundScoringAction(fixture.eventId, { confirmed: true }));

    const lines = await auditSummaries(fixture.eventId);
    // Two: the fixture's own save of six rounds, and the switch.
    expect(lines.length).toBe(2);
    const off = lines.find((line) => line.includes("Turned round scoring off"));
    expect(off, "no log line for the switch").toBeDefined();
    expect(off).toContain("5 scores");
  });

  it("refuses a member and succeeds for the manager", async () => {
    const fixture = await scoredNight();
    const before = await configBytes(fixture.eventId);

    state.userId = fixture.members[0];
    await expect(clearRoundScoringAction(fixture.eventId, { confirmed: true })).rejects.toThrow(
      /NEXT_REDIRECT/
    );
    state.userId = null;
    await expect(clearRoundScoringAction(fixture.eventId, { confirmed: true })).rejects.toThrow(
      /NEXT_REDIRECT/
    );
    expect(await configBytes(fixture.eventId)).toBe(before);
    expect(roundScoringFrom(await storedConfig(fixture.eventId))).toEqual(SIX);

    state.userId = fixture.host;
    unwrap(await clearRoundScoringAction(fixture.eventId, { confirmed: true }));
    expect(roundScoringFrom(await storedConfig(fixture.eventId))).toBeNull();
  });

  it("opens the hand-typed order again, and the season reads it — the trap, closed end to end", async () => {
    /*
     * Criterion 1, which is the whole point of the task: a night set up as
     * round-scored by mistake, in a season, with scores on the board. Before the
     * switch the typed order is refused (UC-46 5b). After it, the typed order is
     * accepted and the season scores from it; the round rows are still there
     * and consulted by nothing.
     */
    const fixture = await scoredNight();
    const [alice, bob] = fixture.members;
    const season = unwrap(await createChampionship({ name: `Trap season ${counter}` }, db));
    await db.update(championships).set({ status: "published" }).where(eq(championships.id, season.id));
    unwrap(await addCountingEvent(season.id, fixture.eventId, db));

    const refused = await setPlacements(
      fixture.eventId,
      [
        { id: bob, position: 1 },
        { id: alice, position: 2 },
      ],
      db
    );
    expect(refused).toEqual({ ok: false, error: ROUND_SCORED_REFUSAL });
    expect(await listPlacements(fixture.eventId, db)).toEqual([]);

    unwrap(await clearRoundScoringAction(fixture.eventId, { confirmed: true }));

    const typed = await setPlacements(
      fixture.eventId,
      [
        { id: bob, position: 1 },
        { id: alice, position: 2 },
      ],
      db
    );
    expect(typed.ok).toBe(true);
    const order = await finishingOrderFor(fixture.eventId, db);
    expect(order.source).toBe("typed");
    expect(order.places.map((place) => [place.id, place.position])).toEqual([
      [bob, 1],
      [alice, 2],
    ]);

    // The season scores the typed order — Bob first — not the table, which had Bob last.
    const page = await seasonPage((await getChampionship(season.id, db))!, db);
    expect(page.standings.find((row) => row.userId === bob)).toMatchObject({ points: 25, position: 1 });
    expect(page.standings.find((row) => row.userId === alice)).toMatchObject({ points: 18, position: 2 });
    // The round rows were never deleted; they are simply not what is read.
    expect((await listRoundScores(fixture.eventId)).length).toBe(5);
  });
});
