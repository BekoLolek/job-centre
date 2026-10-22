/**
 * The format engine against real Postgres.
 *
 * `src/lib/format.ts` is the trust and transaction boundary: it re-reads
 * everything it is told, refuses to erase a played stage, and keeps the finish,
 * the duration and the rest of the day in step in one transaction. These run it
 * against PGlite — Postgres 17 compiled to WASM — so the constraints, the
 * cascades and the jsonb behave exactly as they will on Neon.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import {
  type Database,
  type EventConfig,
  events,
  matchGames,
  matches,
  schema,
  stages,
  teams,
} from "@/db";
import { type TestDatabase, freshDatabase } from "@/db/__tests__/helpers";
import {
  applySchedule,
  clearMatch,
  formatFor,
  generateMatches,
  recordGames,
  reflipMatch,
  scheduleSettingsFrom,
  setMatchSchedule,
  setStages,
  setWinnerOverride,
  syncStages,
} from "@/lib/format";
import { type MatchSlot, otherSlot } from "@/lib/format-policy";

let ctx: TestDatabase;
let db: Database;

beforeAll(async () => {
  ctx = await freshDatabase();
  db = ctx.db;
});

afterAll(async () => {
  await ctx.close();
});

let counter = 0;

async function makeEvent(config: EventConfig = {}): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(events)
    .values({ slug: `fmt-${counter}`, title: `Format ${counter}`, config })
    .returning({ id: events.id });
  return row.id;
}

async function makeTeams(eventId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const [row] = await db
      .insert(teams)
      .values({ eventId, name: `Team ${i}`, seed: i, sort: i })
      .returning({ id: teams.id });
    ids.push(row.id);
  }
  return ids;
}

/** An event with four teams, a round robin and a double elimination, generated. */
async function boardEvent(config: EventConfig = {}) {
  const eventId = await makeEvent(config);
  const teamIds = await makeTeams(eventId, 4);
  const created = await setStages(eventId, [
    { kind: "round_robin", name: "Round robin" },
    { kind: "double_elim", name: "Playoffs" },
  ], db);
  if (!created.ok) throw new Error(created.error);
  for (const stage of created.data) {
    const result = await generateMatches(stage.id, db);
    if (!result.ok) throw new Error(result.error);
  }
  return { eventId, teamIds, stageIds: created.data.map((s) => s.id) };
}

async function matchId(eventId: string, slot: string): Promise<string> {
  const rows = await db.select().from(matches).where(eq(matches.eventId, eventId));
  const row = rows.find((m) => m.slot === slot);
  if (!row) throw new Error(`no match ${slot}`);
  return row.id;
}

/** Win a series for one side, taking the minimum number of games. */
async function win(eventId: string, slot: string, side: "a" | "b") {
  const id = await matchId(eventId, slot);
  const [row] = await db.select().from(matches).where(eq(matches.id, id));
  const target = Math.floor(row.bestOf / 2) + 1;
  const result = await recordGames(
    id,
    Array.from({ length: target }, (_, i) => ({
      index: i,
      scoreA: side === "a" ? 1 : 0,
      scoreB: side === "b" ? 1 : 0,
      played: true,
    })),
    {},
    db
  );
  if (!result.ok) throw new Error(result.error);
}

/** Every table game, won by whichever team is listed first — so the seeding settles. */
const TABLE_SLOTS = ["rr-1-2", "rr-3-4", "rr-1-3", "rr-2-4", "rr-1-4", "rr-2-3"] as const;

async function finishTable(eventId: string): Promise<void> {
  for (const slot of TABLE_SLOTS) await win(eventId, slot, "a");
}

async function gamesOf(id: string) {
  const rows = await db.select().from(matchGames).where(eq(matchGames.matchId, id));
  return rows.sort((x, y) => x.index - y.index);
}

async function rowFor(eventId: string, slot: string) {
  const rows = await db.select().from(matches).where(eq(matches.eventId, eventId));
  const row = rows.find((m) => m.slot === slot);
  if (!row) throw new Error(`no match ${slot}`);
  return row;
}

/** One resolved match off a freshly read board. */
async function cardFor(eventId: string, slot: string) {
  const view = await formatFor(eventId, db);
  const card = view?.stages.flatMap((stage) => stage.matches).find((m) => m.slot === slot);
  if (!card) throw new Error(`no card ${slot}`);
  return card;
}

/**
 * This file's database, except that the first transaction it opens runs
 * `between` to completion first — the helper `format-sync.test.ts`,
 * `draft.test.ts` and `events.test.ts` all use, for the same reason.
 *
 * Sequenced rather than raced. Two managers pressing Save on the same card
 * inside the same second is not something a timer can be trusted to reproduce,
 * and a test that had to *win* a race to see the bug would pass by luck on the
 * days it did not. This pins the interleave exactly: everything the outer call
 * could have read before it opened its transaction is stale, because the inner
 * one has already committed.
 */
function committingAfter(between: () => Promise<unknown>): Database {
  let pending: (() => Promise<unknown>) | null = between;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return async (run: Parameters<Database["transaction"]>[0]) => {
        const first = pending;
        pending = null;
        if (first) await first();
        return target.transaction(run);
      };
    },
  });
}

/**
 * This file's database again, over the same PGlite client, with every statement
 * it runs pushed onto `log` in the order it was issued.
 *
 * drizzle's own `logger` hook rather than a proxy over the query builders: the
 * hook fires from the prepared query, so it sees statements issued inside a
 * transaction too — `PgliteSession.transaction` hands its options, logger and
 * all, to the session it builds for the `tx`. `createPgliteDatabase` takes no
 * logger, so the handle is built here.
 *
 * It is for asserting **order**, which is the only way to test a lock-ordering
 * rule without a race: "this read is taken after the lock" is a fact about the
 * statements, and a race that happened to expose it would be a test that
 * passes by luck.
 */
function logging(log: string[]): Database {
  return drizzlePglite(ctx.client, {
    schema,
    logger: { logQuery: (query) => log.push(query) },
  });
}

describe("setStages", () => {
  it("creates stages in order and names the ones left unnamed", async () => {
    const eventId = await makeEvent();
    const result = await setStages(
      eventId,
      [{ kind: "round_robin" }, { kind: "double_elim" }],
      db
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((s) => [s.kind, s.sort, s.name])).toEqual([
      ["round_robin", 0, "Round robin"],
      ["double_elim", 1, "Playoffs"],
    ]);
  });

  it("normalises the config it stores, so no reader has to guess", async () => {
    const eventId = await makeEvent();
    const result = await setStages(
      eventId,
      [{ kind: "single_elim", config: { bestOf: 4 as 3, bracketReset: true } }],
      db
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const config = result.data[0].config as Record<string, unknown>;
    expect(config.bestOf).toBe(3); // rounded down to an odd length
    expect(config.bracketReset).toBe(false); // meaningless without a lower bracket
    expect(config.bronze).toBe("separate"); // a single elimination has no lower final
  });

  it("refuses a format it does not know", async () => {
    const eventId = await makeEvent();
    const result = await setStages(eventId, [{ kind: "ladder" }], db);
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses more stages than an event may have", async () => {
    const eventId = await makeEvent();
    const result = await setStages(
      eventId,
      Array.from({ length: 5 }, () => ({ kind: "round_robin" as const })),
      db
    );
    expect(result).toMatchObject({ ok: false });
  });

  it("updates rather than duplicating when an id is given", async () => {
    const eventId = await makeEvent();
    const first = await setStages(eventId, [{ kind: "round_robin" }], db);
    if (!first.ok) throw new Error(first.error);
    const second = await setStages(
      eventId,
      [{ id: first.data[0].id, kind: "round_robin", name: "Group stage" }],
      db
    );
    if (!second.ok) throw new Error(second.error);
    expect(second.data[0].id).toBe(first.data[0].id);
    expect(second.data[0].name).toBe("Group stage");
    expect(await db.select().from(stages).where(eq(stages.eventId, eventId))).toHaveLength(1);
  });

  it("removes a stage that has not been played", async () => {
    const eventId = await makeEvent();
    const first = await setStages(eventId, [{ kind: "round_robin" }, { kind: "single_elim" }], db);
    if (!first.ok) throw new Error(first.error);
    const second = await setStages(eventId, [{ id: first.data[0].id, kind: "round_robin" }], db);
    expect(second.ok).toBe(true);
    expect(await db.select().from(stages).where(eq(stages.eventId, eventId))).toHaveLength(1);
  });

  it("refuses to remove a stage that has results — nothing destructive", async () => {
    const { eventId, stageIds } = await boardEvent();
    await win(eventId, "rr-1-2", "a");
    const result = await setStages(eventId, [{ id: stageIds[1], kind: "double_elim" }], db);
    expect(result).toMatchObject({ ok: false });
    expect(await db.select().from(stages).where(eq(stages.eventId, eventId))).toHaveLength(2);
  });

  it("refuses to change the format of a stage that has results", async () => {
    const { eventId, stageIds } = await boardEvent();
    await win(eventId, "rr-1-2", "a");
    const result = await setStages(
      eventId,
      [
        { id: stageIds[0], kind: "single_elim" },
        { id: stageIds[1], kind: "double_elim" },
      ],
      db
    );
    expect(result).toMatchObject({ ok: false });
  });
});

describe("generateMatches", () => {
  it("writes every generated slot, with its sources and its games", async () => {
    const { eventId, stageIds } = await boardEvent();
    const rows = await db.select().from(matches).where(eq(matches.stageId, stageIds[1]));
    expect(rows.map((r) => r.slot).sort()).toEqual(
      ["gf", "lbf", "lbr1", "ubf", "ubsf1", "ubsf2"].sort()
    );
    const gf = rows.find((r) => r.slot === "gf");
    expect(gf?.sourceA).toBe("winner:ubf");
    expect(gf?.sourceB).toBe("winner:lbf");
    expect(gf?.bestOf).toBe(5);

    const games = await db.select().from(matchGames).where(eq(matchGames.matchId, gf!.id));
    expect(games).toHaveLength(5);
    expect(games.sort((x, y) => x.index - y.index).map((g) => g.mode)).toEqual([
      "convoy",
      "convoy",
      "convoy",
      "convoy",
      "domination",
    ]);
  });

  it("fills in a table game's teams and leaves a bracket slot's empty", async () => {
    const { eventId, teamIds, stageIds } = await boardEvent();
    const table = await db.select().from(matches).where(eq(matches.stageId, stageIds[0]));
    const first = table.find((m) => m.slot === "rr-1-2");
    expect(first?.teamAId).toBe(teamIds[0]);
    expect(first?.teamBId).toBe(teamIds[1]);

    const bracket = await db.select().from(matches).where(eq(matches.stageId, stageIds[1]));
    expect(bracket.every((m) => m.teamAId === null && m.teamBId === null)).toBe(true);
  });

  it("refuses a field of one", async () => {
    const eventId = await makeEvent();
    await makeTeams(eventId, 1);
    const created = await setStages(eventId, [{ kind: "single_elim" }], db);
    if (!created.ok) throw new Error(created.error);
    expect(await generateMatches(created.data[0].id, db)).toMatchObject({ ok: false });
  });

  it("regenerates cleanly while nothing has been played", async () => {
    const { stageIds } = await boardEvent();
    const again = await generateMatches(stageIds[1], db);
    expect(again).toMatchObject({ ok: true });
  });

  it("refuses to regenerate once a game is ticked off", async () => {
    const { eventId, stageIds } = await boardEvent();
    await win(eventId, "rr-1-2", "a");
    expect(await generateMatches(stageIds[0], db)).toMatchObject({ ok: false });
  });

  it("does not count a score typed in but never ticked as a result", async () => {
    const { eventId, stageIds } = await boardEvent();
    const id = await matchId(eventId, "rr-1-2");
    const result = await recordGames(id, [{ index: 0, scoreA: 3, played: false }], {}, db);
    expect(result).toMatchObject({ ok: true });
    expect(await generateMatches(stageIds[0], db)).toMatchObject({ ok: true });
  });
});

describe("formatFor", () => {
  it("resolves the bracket only once the table that seeds it is finished", async () => {
    const { eventId } = await boardEvent();
    const before = await formatFor(eventId, db);
    expect(before?.stages[1].matches[0].teamAId).toBeNull();
    expect(before?.stages[1].matches[0].nameA).toBe("Seed 1");

    for (const slot of ["rr-1-2", "rr-3-4", "rr-1-3", "rr-2-4", "rr-1-4", "rr-2-3"]) {
      await win(eventId, slot, "a");
    }

    const after = await formatFor(eventId, db);
    expect(after?.stages[0].seeding).not.toBeNull();
    expect(after?.stages[1].matches[0].teamAId).not.toBeNull();
    // Team 1 wins every table game it is listed first in, so it seeds top.
    expect(after?.stages[1].matches[0].nameA).toBe("Team 1");
  });

  it("carries the placeholders, the notes and the block plan", async () => {
    const { eventId } = await boardEvent();
    const view = await formatFor(eventId, db);
    const bracket = view?.stages[1];
    expect(bracket?.matches.find((m) => m.slot === "lbf")?.note).toBe("Loser takes bronze");
    expect(bracket?.matches.find((m) => m.slot === "gf")?.nameA).toBe("Upper final winner");
    expect(view?.blocks.map((b) => b.label)).toEqual([
      "Round robin 1",
      "Round robin 2",
      "Round robin 3",
      "Upper semis",
      "Upper final + Lower round 1",
      "Lower final · bronze",
      "Grand final",
    ]);
  });

  it("is null for an event that does not exist", async () => {
    expect(await formatFor("00000000-0000-0000-0000-000000000000", db)).toBeNull();
  });

  it("is an empty format for an event with no stages", async () => {
    const eventId = await makeEvent();
    const view = await formatFor(eventId, db);
    expect(view?.stages).toEqual([]);
    expect(view?.blocks).toEqual([]);
  });
});

describe("recordGames", () => {
  it("stamps the finish and derives the duration once the series is decided", async () => {
    const { eventId } = await boardEvent();
    const id = await matchId(eventId, "rr-1-2");
    await db
      .update(matches)
      .set({ scheduledAt: new Date("2025-08-15T14:00:00.000Z") })
      .where(eq(matches.id, id));

    const result = await recordGames(
      id,
      [{ index: 0, scoreA: 2, scoreB: 1, played: true }],
      { now: new Date("2025-08-15T14:35:00.000Z") },
      db
    );
    expect(result).toMatchObject({
      ok: true,
      data: { finishedAt: "2025-08-15T14:35:00.000Z", durationMin: 35 },
    });
  });

  it("clears the finish when the admin unticks the deciding game", async () => {
    const { eventId } = await boardEvent();
    const id = await matchId(eventId, "rr-1-2");
    await recordGames(id, [{ index: 0, scoreA: 2, scoreB: 1, played: true }], {}, db);
    const result = await recordGames(id, [{ index: 0, played: false }], {}, db);
    expect(result).toMatchObject({ ok: true, data: { finishedAt: null } });
  });

  it("refuses a game that is not in the series", async () => {
    const { eventId } = await boardEvent();
    const id = await matchId(eventId, "rr-1-2");
    expect(await recordGames(id, [{ index: 4, played: true }], {}, db)).toMatchObject({
      ok: false,
    });
  });

  it("refuses a match that does not exist", async () => {
    expect(
      await recordGames("00000000-0000-0000-0000-000000000000", [], {}, db)
    ).toMatchObject({ ok: false });
  });

  /*
   * This replaces "ignores a negative score rather than storing one", and the
   * replacement is the point rather than a tidy-up. That test asserted the old
   * `score()` helper's clamp: a negative number resolved to whatever was
   * stored, the write returned `ok`, and the manager was told a scoreline was
   * saved while a different one went to the database. UC-19 4a says the system
   * "rejects with the reason; nothing stored", so the old test was pinning a
   * defect — a silent, successful write of the wrong result.
   */
  it("refuses a negative score with the reason, and stores nothing (UC-19 4a)", async () => {
    const { eventId } = await boardEvent();
    const id = await matchId(eventId, "rr-1-2");
    const result = await recordGames(id, [{ index: 0, scoreA: -5, played: true }], {}, db);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Game 1 cannot have a negative score.");

    const [game] = await db.select().from(matchGames).where(eq(matchGames.matchId, id));
    expect(game.scoreA).toBe(0);
    // Not stored *and* not ticked off: the whole patch was refused, so the
    // `played: true` beside the bad score did not land either.
    expect(game.played).toBe(false);
  });

  it("refuses a score that is not a whole number (UC-19 4a)", async () => {
    const { eventId } = await boardEvent();
    const id = await matchId(eventId, "rr-1-2");
    const result = await recordGames(
      id,
      [{ index: 0, scoreA: 2.5, scoreB: 1, played: true }],
      {},
      db
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("Game 1's score has to be a whole number — 2.5 is not.");
    }
    const [game] = await db.select().from(matchGames).where(eq(matchGames.matchId, id));
    expect([game.scoreA, game.scoreB, game.played]).toEqual([0, 0, false]);
  });

  it("writes none of a patch when one game of it is refused (UC-19 4a)", async () => {
    /*
     * Nothing in this codebase calls `tx.rollback()`, so a refusal returned
     * from the middle of a write loop *commits* everything before it. Games 1
     * and 2 here are perfectly good and game 3's score is not a number, and the
     * requirement is that all three are left alone.
     */
    const { eventId } = await boardEvent();
    await finishTable(eventId);
    const id = await matchId(eventId, "ubsf1");

    const result = await recordGames(
      id,
      [
        { index: 0, scoreA: 13, scoreB: 11, played: true },
        { index: 1, scoreA: 9, scoreB: 13, played: true },
        { index: 2, scoreA: "nonsense" as unknown as number, scoreB: 7, played: true },
      ],
      {},
      db
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Game 3's score is not a number.");

    const games = await gamesOf(id);
    expect(games.map((game) => [game.scoreA, game.scoreB, game.played])).toEqual([
      [0, 0, false],
      [0, 0, false],
      [0, 0, false],
    ]);
  });

  it("refuses a level single map in a knockout, and allows one in a table (UC-19 4a)", async () => {
    const { eventId } = await boardEvent();

    // A table game: a draw is a finished match worth a point each.
    const table = await matchId(eventId, "rr-1-2");
    expect(
      await recordGames(table, [{ index: 0, scoreA: 12, scoreB: 12, played: true }], {}, db)
    ).toMatchObject({ ok: true });

    // The same scoreline on a one-map knockout has nothing to resolve into.
    await finishTable(eventId);
    const semi = await matchId(eventId, "ubsf1");
    await db.update(matches).set({ bestOf: 1 }).where(eq(matches.id, semi));
    await db
      .delete(matchGames)
      .where(and(eq(matchGames.matchId, semi), inArray(matchGames.index, [1, 2])));

    const result = await recordGames(
      semi,
      [{ index: 0, scoreA: 12, scoreB: 12, played: true }],
      {},
      db
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/^A single map cannot end level/);
    expect((await gamesOf(semi)).every((game) => !game.played)).toBe(true);
  });

  it("refuses a knockout map played after the series was won (UC-19 5a)", async () => {
    const { eventId } = await boardEvent();
    await finishTable(eventId);
    const id = await matchId(eventId, "ubsf1");

    const result = await recordGames(
      id,
      [
        { index: 0, scoreA: 13, scoreB: 11, played: true },
        { index: 1, scoreA: 13, scoreB: 9, played: true },
        { index: 2, scoreA: 13, scoreB: 7, played: true },
      ],
      {},
      db
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        "The series was already won in game 2, so game 3 cannot have been played."
      );
    }
    expect((await gamesOf(id)).every((game) => !game.played)).toBe(true);
  });

  it("refuses a hole in the middle of a series (UC-19 4a)", async () => {
    const { eventId } = await boardEvent();
    await finishTable(eventId);
    const id = await matchId(eventId, "ubsf1");

    const result = await recordGames(
      id,
      [{ index: 1, scoreA: 13, scoreB: 11, played: true }],
      {},
      db
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        "Game 1 has no result, so game 2 cannot have one — a series is played in order."
      );
    }
    expect((await gamesOf(id)).every((game) => !game.played)).toBe(true);
  });

  it("re-flows the rest of the day when a match overruns", async () => {
    const { eventId } = await boardEvent({
      format: { days: 2, concurrentLobbies: 2, blockDays: [1, 1, 1, 1, 1, 2, 2] },
    });
    await applySchedule(
      eventId,
      ["2025-08-15T14:00:00.000Z", "2025-08-16T14:00:00.000Z"],
      db
    );
    const before = await formatFor(eventId, db);
    expect(before?.stages[0].matches.find((m) => m.slot === "rr-1-3")?.scheduledAt).toBe(
      "2025-08-15T14:40:00.000Z"
    );

    const first = await matchId(eventId, "rr-1-2");
    const second = await matchId(eventId, "rr-3-4");
    await recordGames(
      first,
      [{ index: 0, scoreA: 1, played: true }],
      { now: new Date("2025-08-15T14:50:00.000Z") },
      db
    );
    await recordGames(
      second,
      [{ index: 0, scoreA: 1, played: true }],
      { now: new Date("2025-08-15T14:45:00.000Z") },
      db
    );

    const after = await formatFor(eventId, db);
    // The block ends at its slowest match, 14:50, plus the ten-minute break.
    expect(after?.stages[0].matches.find((m) => m.slot === "rr-1-3")?.scheduledAt).toBe(
      "2025-08-15T15:00:00.000Z"
    );
    // Day 2 is untouched.
    expect(after?.stages[1].matches.find((m) => m.slot === "lbf")?.scheduledAt).toBe(
      "2025-08-16T14:00:00.000Z"
    );
  });
});

describe("setWinnerOverride", () => {
  async function drawnSemi() {
    const { eventId, teamIds } = await boardEvent();
    for (const slot of ["rr-1-2", "rr-3-4", "rr-1-3", "rr-2-4", "rr-1-4", "rr-2-3"]) {
      await win(eventId, slot, "a");
    }
    const id = await matchId(eventId, "ubsf1");
    await recordGames(
      id,
      [
        { index: 0, scoreA: 1, scoreB: 1, played: true },
        { index: 1, scoreA: 1, scoreB: 1, played: true },
        { index: 2, scoreA: 1, scoreB: 1, played: true },
      ],
      {},
      db
    );
    return { eventId, teamIds, id };
  }

  it("asks for a decision on a drawn series and takes one", async () => {
    const { eventId, id } = await drawnSemi();
    const stalled = await formatFor(eventId, db);
    const semi = stalled?.stages[1].matches.find((m) => m.slot === "ubsf1");
    expect(semi?.needsDecision).toBe(true);

    const result = await setWinnerOverride(id, semi?.teamBId ?? null, db);
    expect(result).toMatchObject({ ok: true });

    const settled = await formatFor(eventId, db);
    const after = settled?.stages[1].matches.find((m) => m.slot === "ubsf1");
    expect(after?.winner).toBe(semi?.teamBId);
    expect(after?.needsDecision).toBe(false);
    expect(settled?.stages[1].matches.find((m) => m.slot === "ubf")?.teamAId).toBe(
      semi?.teamBId
    );
  });

  it("refuses a team that is not in the match", async () => {
    const { eventId, id } = await drawnSemi();
    const view = await formatFor(eventId, db);
    const semi = view?.stages[1].matches.find((m) => m.slot === "ubsf1");
    const outsider = view?.teams.find(
      (t) => t.id !== semi?.teamAId && t.id !== semi?.teamBId
    );
    expect(await setWinnerOverride(id, outsider?.id ?? null, db)).toMatchObject({ ok: false });
  });

  it("can be cleared again", async () => {
    const { eventId, id } = await drawnSemi();
    const view = await formatFor(eventId, db);
    const semi = view?.stages[1].matches.find((m) => m.slot === "ubsf1");
    await setWinnerOverride(id, semi?.teamAId ?? null, db);
    expect(await setWinnerOverride(id, null, db)).toMatchObject({ ok: true });
    const cleared = await formatFor(eventId, db);
    expect(cleared?.stages[1].matches.find((m) => m.slot === "ubsf1")?.winner).toBeNull();
  });

  it("takes every deciding read after the event lock", async () => {
    /*
     * The lock-ordering rule `recordGames` and `reflipMatch` already follow.
     * One read has to come first, because the lock has to be named before it
     * can be taken — but it asks for `event_id` and nothing else, so nothing
     * the function decides on predates the wait for the lock.
     *
     * The row's existence is one of those decisions and the reason this is
     * asserted rather than left to inspection: a regeneration committing while
     * this transaction queued for the lock deletes and re-inserts every match
     * of its stage, and an existence check taken before the wait left the
     * `update` matching no rows while this function still answered `ok` with
     * no flags.
     */
    const { eventId, id } = await drawnSemi();
    const semi = await cardFor(eventId, "ubsf1");

    const log: string[] = [];
    expect(await setWinnerOverride(id, semi.teamBId, logging(log))).toMatchObject({ ok: true });

    const lock = log.findIndex((query) => /for update/i.test(query));
    expect(lock).toBeGreaterThanOrEqual(0);

    const readsBefore = log.slice(0, lock).filter((query) => /from "matches"/.test(query));
    expect(readsBefore).toHaveLength(1);
    // `slot` stands for the whole row here: it is on every column list drizzle
    // builds for a bare `select()` of `matches`, and it is one of the values
    // this function actually decides on.
    expect(readsBefore[0]).not.toMatch(/"slot"/);
    expect(
      log.slice(lock + 1).some((query) => /from "matches"/.test(query) && /"slot"/.test(query))
    ).toBe(true);
  });
});

describe("setMatchSchedule", () => {
  it("takes the deciding read after the event lock", async () => {
    /*
     * The sibling of the test above, for the same rule and by the same
     * technique. What `setMatchSchedule` decides on is `scheduled_at`: it
     * early-returns, writing nothing and marking no stage, when the instant it
     * is given is the instant already stored.
     *
     * That read has to come from under the lock, and `reflow` is why — it
     * rewrites `scheduled_at` for every later match of the day, and
     * `recordGamesAction` posts `scheduledAt` on every scoreline, so a
     * regeneration or another manager's scoreline committing while this
     * transaction queued for the lock leaves a pre-lock read comparing against
     * an instant that has since moved. The early return then fires on a move
     * the manager really did ask for, and hands back the stale instant as
     * where the match ended up.
     *
     * `scheduled_at` stands for the whole row here, the way `slot` does above:
     * it is on every column list drizzle builds for a bare `select()` of
     * `matches`, and it is the value this function actually decides on.
     */
    const { eventId } = await boardEvent();
    expect(await applySchedule(eventId, ["2026-08-15T14:00:00.000Z"], db)).toMatchObject({
      ok: true,
    });
    const id = await matchId(eventId, "ubsf1");

    const log: string[] = [];
    expect(
      await setMatchSchedule(id, "2026-08-15T18:40:00.000Z", logging(log))
    ).toMatchObject({ ok: true });

    const lock = log.findIndex((query) => /for update/i.test(query));
    expect(lock).toBeGreaterThanOrEqual(0);

    const readsBefore = log.slice(0, lock).filter((query) => /from "matches"/.test(query));
    expect(readsBefore).toHaveLength(1);
    expect(readsBefore[0]).not.toMatch(/"scheduled_at"/);
    expect(
      log
        .slice(lock + 1)
        .some((query) => /from "matches"/.test(query) && /"scheduled_at"/.test(query))
    ).toBe(true);
  });
});

describe("applySchedule", () => {
  it("lays the whole event out from a start time per day", async () => {
    const { eventId } = await boardEvent({
      format: { days: 2, concurrentLobbies: 2, blockDays: [1, 1, 1, 1, 1, 2, 2] },
    });
    const result = await applySchedule(
      eventId,
      ["2025-08-15T14:00:00.000Z", "2025-08-16T14:00:00.000Z"],
      db
    );
    expect(result).toMatchObject({ ok: true, data: { scheduled: 12 } });

    const view = await formatFor(eventId, db);
    const at = (slot: string) =>
      view?.stages.flatMap((s) => s.matches).find((m) => m.slot === slot)?.scheduledAt;
    expect(at("rr-1-2")).toBe("2025-08-15T14:00:00.000Z");
    expect(at("ubsf1")).toBe("2025-08-15T16:00:00.000Z");
    expect(at("ubf")).toBe("2025-08-15T17:35:00.000Z");
    expect(at("lbf")).toBe("2025-08-16T14:00:00.000Z");
    expect(at("gf")).toBe("2025-08-16T15:35:00.000Z");
  });

  it("skips a day left blank", async () => {
    const { eventId } = await boardEvent({
      format: { days: 2, concurrentLobbies: 2, blockDays: [1, 1, 1, 1, 1, 2, 2] },
    });
    await applySchedule(eventId, ["2025-08-15T14:00:00.000Z", null], db);
    const view = await formatFor(eventId, db);
    const at = (slot: string) =>
      view?.stages.flatMap((s) => s.matches).find((m) => m.slot === slot)?.scheduledAt;
    expect(at("rr-1-2")).toBe("2025-08-15T14:00:00.000Z");
    expect(at("lbf")).toBeNull();
  });

  it("refuses to schedule an event with nothing generated", async () => {
    const eventId = await makeEvent();
    expect(await applySchedule(eventId, ["2025-08-15T14:00:00.000Z"], db)).toMatchObject({
      ok: false,
    });
  });
});

describe("scheduleSettingsFrom", () => {
  it("defaults to one day and two lobbies, which is the current board", () => {
    expect(scheduleSettingsFrom(null)).toMatchObject({ days: 1, concurrentLobbies: 2 });
  });

  it("reads what the format tab stored, and clamps it", () => {
    const settings = scheduleSettingsFrom({
      format: { days: 99, concurrentLobbies: 0, blockDays: [1, 2] },
    });
    expect(settings.days).toBe(4);
    expect(settings.concurrentLobbies).toBe(1);
    expect(settings.blockDays).toEqual([1, 2]);
  });

  it("ignores a config that is not one", () => {
    expect(scheduleSettingsFrom("nonsense")).toMatchObject({ days: 1 });
    expect(scheduleSettingsFrom({ format: [] })).toMatchObject({ days: 1 });
  });
});

/* ------------------------------------------------------------------ */
/* UC-19 precondition 1 — a slot with nobody in it                    */
/* ------------------------------------------------------------------ */

describe("recordGames refuses a slot that has not resolved (UC-19 pre1)", () => {
  it("refuses a score against a bracket slot still waiting on its seeding", async () => {
    const { eventId } = await boardEvent();
    const id = await matchId(eventId, "ubsf1");

    // The playoff seeds come from the table, which nobody has played.
    expect((await cardFor(eventId, "ubsf1")).nameA).toBe("Seed 1");

    const result = await recordGames(
      id,
      [{ index: 0, scoreA: 13, scoreB: 11, played: true }],
      {},
      db
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        "This match is still waiting on Seed 1 and Seed 4, so it cannot have a result yet."
      );
    }
    expect((await gamesOf(id)).every((game) => !game.played)).toBe(true);
  });

  it("refuses a match waiting on only one of its two slots", async () => {
    const { eventId } = await boardEvent();
    await finishTable(eventId);
    await win(eventId, "ubsf1", "a");

    // The upper final now knows who came out of semi 1 and not semi 2.
    const card = await cardFor(eventId, "ubf");
    expect(card.teamAId).not.toBeNull();
    expect(card.teamBId).toBeNull();

    const result = await recordGames(
      await matchId(eventId, "ubf"),
      [{ index: 0, scoreA: 13, scoreB: 11, played: true }],
      {},
      db
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        "This match is still waiting on Upper semi 2 winner, so it cannot have a result yet."
      );
    }
  });

  it("takes the same result once both slots have resolved", async () => {
    const { eventId } = await boardEvent();
    await finishTable(eventId);
    const id = await matchId(eventId, "ubsf1");

    expect(
      await recordGames(id, [{ index: 0, scoreA: 13, scoreB: 11, played: true }], {}, db)
    ).toMatchObject({ ok: true });
    expect((await gamesOf(id))[0].scoreA).toBe(13);
  });

  it("still lets a slot that has stopped resolving be cleared", async () => {
    /*
     * The refusal must not become a trap. A later match whose feeding result was
     * corrected away is carrying maps that are now against nobody, and clearing
     * it is the only way out — so an erasing patch goes through while a
     * recording one does not.
     */
    const { eventId } = await boardEvent();
    await finishTable(eventId);
    await win(eventId, "ubsf1", "a");
    await win(eventId, "ubsf2", "a");
    await win(eventId, "ubf", "a");
    const finalId = await matchId(eventId, "ubf");
    expect((await gamesOf(finalId)).some((game) => game.played)).toBe(true);

    // Semi 1 is wiped, so the upper final's side A has nobody in it again.
    const semi = await rowFor(eventId, "ubsf1");
    expect(await clearMatch(semi.id, 3, db)).toMatchObject({ ok: true });
    expect((await cardFor(eventId, "ubf")).teamAId).toBeNull();

    const recording = await recordGames(
      finalId,
      [{ index: 0, scoreA: 9, scoreB: 13, played: true }],
      {},
      db
    );
    expect(recording.ok).toBe(false);
    if (!recording.ok) expect(recording.error).toMatch(/still waiting on/);

    const cleared = await clearMatch(finalId, 3, db);
    expect(cleared).toMatchObject({ ok: true });
    expect((await gamesOf(finalId)).every((game) => !game.played)).toBe(true);
  });

  /*
   * The exemption above is the only way past this refusal, so the two shapes
   * that used to claim it while erasing nothing are both checked here.
   *
   * Neither can write a score, so what they cost is not a wrong result: it is a
   * `durationMin` stamped on a match with nobody in it, and `reflow` moving
   * every later block of that day off a match that cannot have been played
   * (§10). `recordGamesAction` passes `fields.games` through from the client
   * beside the duration, so both shapes are things a request can actually be.
   */
  it("refuses a duration sent with no games at all", async () => {
    // `[].every(…)` is true of every predicate, which is the whole bug.
    const { eventId } = await boardEvent();
    const id = await matchId(eventId, "ubsf1");
    expect((await rowFor(eventId, "ubsf1")).durationMin).toBeNull();

    const result = await recordGames(id, [], { durationMin: 90 }, db);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        "This match is still waiting on Seed 1 and Seed 4, so it cannot have a result yet."
      );
    }
    expect((await rowFor(eventId, "ubsf1")).durationMin).toBeNull();
  });

  it("refuses a patch that names nothing but its index", async () => {
    // The other half of the same hole, and the half a length check misses:
    // every field `erasesOnly` looks at is *preserved* when it is absent, so
    // `{ index: 0 }` passes it and takes nothing away.
    const { eventId } = await boardEvent();
    const id = await matchId(eventId, "ubsf1");

    const result = await recordGames(id, [{ index: 0 }], { durationMin: 90 }, db);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(
        "This match is still waiting on Seed 1 and Seed 4, so it cannot have a result yet."
      );
    }
    expect((await rowFor(eventId, "ubsf1")).durationMin).toBeNull();
  });

  it("still takes a single patch that does take something away", async () => {
    // And the refusal has not swallowed the exemption: one patch that names a
    // field it can only erase is enough, which is what `clearMatch` sends per
    // game.
    const { eventId } = await boardEvent();
    const id = await matchId(eventId, "ubsf1");

    expect(
      await recordGames(id, [{ index: 0, played: false, scoreA: 0, scoreB: 0 }], {}, db)
    ).toMatchObject({ ok: true });
  });
});

/* ------------------------------------------------------------------ */
/* UC-19 3a — a later match whose team changed                        */
/* ------------------------------------------------------------------ */

describe("recordGames flags a later match whose team changed (UC-19 3a)", () => {
  /** Table played, both semis won by side A, and the upper final recorded. */
  async function playedToTheFinal() {
    const { eventId } = await boardEvent();
    await finishTable(eventId);
    await win(eventId, "ubsf1", "a");
    await win(eventId, "ubsf2", "a");
    await win(eventId, "ubf", "a");
    return { eventId };
  }

  it("names the match, what moved and how many maps are on it", async () => {
    const { eventId } = await playedToTheFinal();
    const before = await cardFor(eventId, "ubf");
    const semi = await cardFor(eventId, "ubsf1");

    // The manager corrects semi 1: side B won it after all.
    const result = await recordGames(
      await matchId(eventId, "ubsf1"),
      [
        { index: 0, scoreA: 11, scoreB: 13, played: true },
        { index: 1, scoreA: 9, scoreB: 13, played: true },
      ],
      {},
      db
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.flagged).toHaveLength(1);
    const [flag] = result.data.flagged;
    expect(flag.slot).toBe("ubf");
    expect(flag.label).toBe("Upper final");
    // Both maps of the Bo3 the upper final was won in.
    expect(flag.playedGames).toBe(2);
    expect(flag.before).toEqual({ a: semi.teamAId, b: before.teamBId });
    expect(flag.after).toEqual({ a: semi.teamBId, b: before.teamBId });

    // Flagged, not fixed: the maps are exactly where they were.
    const games = await gamesOf(await matchId(eventId, "ubf"));
    expect(games.filter((game) => game.played)).toHaveLength(2);
  });

  it("says nothing about a later match that has no maps recorded yet", async () => {
    const { eventId } = await boardEvent();
    await finishTable(eventId);

    // Winning semi 1 fills the upper final's side A — a change, but there is
    // nothing recorded there for it to contradict.
    const result = await recordGames(
      await matchId(eventId, "ubsf1"),
      [
        { index: 0, scoreA: 13, scoreB: 11, played: true },
        { index: 1, scoreA: 13, scoreB: 9, played: true },
      ],
      {},
      db
    );
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.data.flagged).toEqual([]);
    // And the slot really did move, so the empty list is not a vacuous pass.
    expect((await cardFor(eventId, "ubf")).teamAId).not.toBeNull();
  });

  it("flags from an override too, because that is what settles a drawn series", async () => {
    const { eventId } = await playedToTheFinal();
    const semiId = await matchId(eventId, "ubsf1");
    const before = await cardFor(eventId, "ubsf1");

    // Semi 1 is overturned in favour of the other team.
    const result = await setWinnerOverride(semiId, before.teamBId, db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.flagged.map((flag) => flag.slot)).toEqual(["ubf"]);
    expect(result.data.flagged[0].after.a).toBe(before.teamBId);
  });

  it("flags from a clear, which is where a result is actually destroyed", async () => {
    const { eventId } = await playedToTheFinal();
    const before = await cardFor(eventId, "ubf");

    const result = await clearMatch(await matchId(eventId, "ubsf1"), 3, db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flag = result.data.flagged.find((entry) => entry.slot === "ubf");
    expect(flag?.before).toEqual({ a: before.teamAId, b: before.teamBId });
    // Nobody resolves into side A any more, which is the same trouble.
    expect(flag?.after).toEqual({ a: null, b: before.teamBId });
  });
});

/* ------------------------------------------------------------------ */
/* UC-19 2a, 2b — the coin, before and after a map                    */
/* ------------------------------------------------------------------ */

/*
 * R-80 is the rule — one team picks the side, the other the map, swapping every
 * game — and R-81 is the correction: "re-toss or hand the side choice to a named
 * team **before any map is played**". UC-19 2a is the correction going through
 * and 2b is the refusal once a map has been played, with the way out it names.
 * `side-choice.test.ts` covers the same two writes from §8.4's side (the coin is
 * tossed per match, derived per game, and recorded as one value, R-82); these
 * are the UC-19 lines, so they assert the whole series swaps and that the
 * refusal's instruction is true.
 */
describe("the side choice before a series is played (UC-19 2a, 2b)", () => {
  it("2a — hands the choice to the named team, for every game of the series", async () => {
    const { eventId } = await boardEvent();
    await finishTable(eventId);
    const row = await rowFor(eventId, "ubsf1");
    const wanted = otherSlot(row.firstSideChoice as MatchSlot);

    const result = await reflipMatch(row.id, wanted, db);
    expect(result).toMatchObject({ ok: true, data: { firstSideChoice: wanted } });

    // The swap is derived per game, so the whole series follows the one value.
    const card = await cardFor(eventId, "ubsf1");
    expect(card.choices.map((choice) => choice.sideSlot)).toEqual([
      wanted,
      otherSlot(wanted),
      wanted,
    ]);
    // And whoever does not choose the side chooses the map, always.
    expect(card.choices.map((choice) => choice.mapSlot)).toEqual([
      otherSlot(wanted),
      wanted,
      otherSlot(wanted),
    ]);
  });

  it("2a — tosses again when no team is named, and lands on one of the two", async () => {
    const { eventId } = await boardEvent();
    await finishTable(eventId);
    const row = await rowFor(eventId, "ubsf1");
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = await reflipMatch(row.id, null, db);
      expect(result.ok).toBe(true);
      if (result.ok) seen.add(result.data.firstSideChoice);
    }
    expect([...seen].sort()).toEqual(["a", "b"]);
  });

  it("2b — refuses a re-toss once a map is played, and says to clear the series", async () => {
    const { eventId } = await boardEvent();
    await finishTable(eventId);
    const row = await rowFor(eventId, "ubsf1");
    expect(
      await recordGames(row.id, [{ index: 0, scoreA: 13, scoreB: 11, played: true }], {}, db)
    ).toMatchObject({ ok: true });

    for (const slot of [null, otherSlot(row.firstSideChoice as MatchSlot)]) {
      const result = await reflipMatch(row.id, slot, db);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("Clear the series first");
    }
    // The coin a played map was played under is still the stored one.
    expect((await rowFor(eventId, "ubsf1")).firstSideChoice).toBe(row.firstSideChoice);
  });

  it("2b — and the way out it names actually works", async () => {
    const { eventId } = await boardEvent();
    await finishTable(eventId);
    const row = await rowFor(eventId, "ubsf1");
    await recordGames(row.id, [{ index: 0, scoreA: 13, scoreB: 11, played: true }], {}, db);
    expect((await reflipMatch(row.id, "a", db)).ok).toBe(false);

    expect(await clearMatch(row.id, 3, db)).toMatchObject({ ok: true });
    expect(await reflipMatch(row.id, "a", db)).toMatchObject({
      ok: true,
      data: { firstSideChoice: "a" },
    });
  });
});

/* ------------------------------------------------------------------ */
/* UC-19 E4 — a series that ends level                                */
/* ------------------------------------------------------------------ */

describe("a series that ends level waits for the manager (UC-19 E4)", () => {
  /**
   * An upper semi played out to a level Bo3.
   *
   * E4's words are "an even-length series ends level", and in this system that
   * is reached by a *drawn map*, not by an even `best_of`: `SERIES_LENGTHS` is
   * odd-only and `matches_best_of_odd` refuses an even one in the database
   * (`src/db/__tests__/format-constraints.test.ts` pins that). So the state E4
   * describes — every game in, nobody ahead — is produced here the only way it
   * can be. Nothing in the engine reads the length's parity: `seriesRefusal`
   * and `isMatchDecided` are asserted against an even length directly in
   * `format-policy.test.ts` and `format-resolve.test.ts`, where no constraint
   * is in the way.
   */
  async function levelSemi() {
    const { eventId } = await boardEvent();
    await finishTable(eventId);
    const id = await matchId(eventId, "ubsf1");
    const result = await recordGames(
      id,
      [
        { index: 0, scoreA: 13, scoreB: 11, played: true },
        { index: 1, scoreA: 9, scoreB: 13, played: true },
        { index: 2, scoreA: 12, scoreB: 12, played: true },
      ],
      {},
      db
    );
    if (!result.ok) throw new Error(result.error);
    return { eventId, id };
  }

  it("is not finished, and nothing after it resolves", async () => {
    const { eventId } = await levelSemi();

    const card = await cardFor(eventId, "ubsf1");
    expect([card.gamesWonA, card.gamesWonB]).toEqual([1, 1]);
    expect(card.needsDecision).toBe(true);
    expect(card.status).not.toBe("done");
    expect(card.winner).toBeNull();
    // The slot it feeds is still waiting, so the bracket has not guessed.
    expect((await cardFor(eventId, "ubf")).teamAId).toBeNull();
  });

  it("does not settle the stage's finishing order either", async () => {
    const { eventId } = await levelSemi();
    const view = await formatFor(eventId, db);
    const playoffs = view?.stages[1];
    expect(playoffs?.champion).toBeNull();
    expect(playoffs?.seeding).toBeNull();
  });

  it("the manager decides, and the System proceeds as step 6", async () => {
    const { eventId, id } = await levelSemi();
    const level = await cardFor(eventId, "ubsf1");
    expect(level.teamBId).not.toBeNull();

    expect(await setWinnerOverride(id, level.teamBId, db)).toMatchObject({ ok: true });

    const settled = await cardFor(eventId, "ubsf1");
    expect(settled.needsDecision).toBe(false);
    expect(settled.status).toBe("done");
    expect(settled.winner).toBe(level.teamBId);
    // Step 6: the next match's slot is filled.
    expect((await cardFor(eventId, "ubf")).teamAId).toBe(level.teamBId);
  });

  it("a level *table* game is a finished match, not a stall", async () => {
    // The other half of the same rule, and the reason E4 is about knockouts:
    // a drawn table game is worth a point each and settles immediately.
    const { eventId } = await boardEvent();
    const id = await matchId(eventId, "rr-1-2");
    expect(
      await recordGames(id, [{ index: 0, scoreA: 12, scoreB: 12, played: true }], {}, db)
    ).toMatchObject({ ok: true });

    const card = await cardFor(eventId, "rr-1-2");
    expect(card.status).toBe("done");
    expect(card.needsDecision).toBe(false);
    expect(card.winner).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Two managers at once                                               */
/* ------------------------------------------------------------------ */

describe("a result landing while the board moves underneath it", () => {
  it("refuses a map the other manager's result has already made impossible", async () => {
    /*
     * Both managers have the same card open. One records a 2-0 and commits;
     * the other was about to tick off game 3, and by the time their write
     * opens its transaction there is no game 3 to play. The refusal has to be
     * decided from the whole series as it stands in the database — a rule
     * applied to the patch alone sees one played game, nobody at the target,
     * and writes a phantom third map over somebody's finished series.
     */
    const { eventId } = await boardEvent();
    await finishTable(eventId);
    const id = await matchId(eventId, "ubsf1");

    const theOtherManager = async () => {
      const done = await recordGames(
        id,
        [
          { index: 0, scoreA: 11, scoreB: 13, played: true },
          { index: 1, scoreA: 9, scoreB: 13, played: true },
        ],
        {},
        db
      );
      if (!done.ok) throw new Error(done.error);
    };

    const late = await recordGames(
      id,
      [{ index: 2, scoreA: 13, scoreB: 7, played: true }],
      {},
      committingAfter(theOtherManager)
    );
    expect(late.ok).toBe(false);
    if (!late.ok) {
      expect(late.error).toBe(
        "The series was already won in game 2, so game 3 cannot have been played."
      );
    }

    // Their result is untouched, which is the whole point of the refusal.
    const games = await gamesOf(id);
    expect(games.map((game) => [game.scoreA, game.scoreB, game.played])).toEqual([
      [11, 13, true],
      [9, 13, true],
      [0, 0, false],
    ]);
    const card = await cardFor(eventId, "ubsf1");
    expect([card.gamesWonA, card.gamesWonB]).toEqual([0, 2]);
  });

  it("refuses a result whose slot stopped resolving while the write was in flight", async () => {
    const { eventId } = await boardEvent();
    await finishTable(eventId);
    await win(eventId, "ubsf1", "a");
    await win(eventId, "ubsf2", "a");
    const finalId = await matchId(eventId, "ubf");

    // The other manager clears semi 1, so the upper final loses its side A.
    const theOtherManager = async () => {
      const cleared = await clearMatch(await matchId(eventId, "ubsf1"), 3, db);
      if (!cleared.ok) throw new Error(cleared.error);
    };

    const late = await recordGames(
      finalId,
      [{ index: 0, scoreA: 13, scoreB: 11, played: true }],
      {},
      committingAfter(theOtherManager)
    );
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error).toMatch(/still waiting on/);
    expect((await gamesOf(finalId)).every((game) => !game.played)).toBe(true);
  });

  it("refuses a result landing in a stage that has just been regenerated", async () => {
    const eventId = await makeEvent();
    const teamIds = await makeTeams(eventId, 4);
    const created = await setStages(eventId, [{ kind: "round_robin" }], db);
    if (!created.ok) throw new Error(created.error);
    if (!(await generateMatches(created.data[0].id, db)).ok) throw new Error("not generated");
    const id = await matchId(eventId, "rr-1-2");

    // Another manager re-seeds the teams; `syncStages` rebuilds the stage,
    // because nothing in it has been played (UC-18 9).
    const theOtherManager = async () => {
      for (const [index, teamId] of teamIds.entries()) {
        await db
          .update(teams)
          .set({ seed: teamIds.length - index })
          .where(eq(teams.id, teamId));
      }
      const sync = await syncStages(eventId, db);
      if (!sync.ok) throw new Error(sync.error);
      expect(sync.data.rebuilt).toBe(1);
    };

    const late = await recordGames(
      id,
      [{ index: 0, scoreA: 13, scoreB: 11, played: true }],
      {},
      committingAfter(theOtherManager)
    );
    expect(late.ok).toBe(false);
    if (!late.ok) expect(late.error).toBe("That match no longer exists.");

    // The rebuilt stage is a clean one: the refused score is nowhere in it.
    const rows = await db.select().from(matches).where(eq(matches.eventId, eventId));
    const games = await db
      .select()
      .from(matchGames)
      .where(
        inArray(
          matchGames.matchId,
          rows.map((row) => row.id)
        )
      );
    expect(games.length).toBeGreaterThan(0);
    expect(games.every((game) => !game.played && game.scoreA === 0)).toBe(true);
  });
});
