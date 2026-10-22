/**
 * The kept format and result features, against real Postgres (Section H,
 * Task 34).
 *
 * The half of UC-18's and UC-19's extension flows that is about *stored* rows,
 * which is where the gap audit's "read but never walked" cost most:
 *
 *  - **UC-18 E4** (R-156) — a block moved to another day, with both days
 *    recomputed.
 *  - **UC-18 E5** (R-160) — the seeds a generated table is actually paired by.
 *  - **UC-19 E1** (R-153) — the mode a map was played on, recorded and kept.
 *  - **UC-19 E2** (R-157) — a start time moved by hand, and only by hand,
 *    marking its stage.
 *  - **UC-19 E3** (R-158) — the recorded duration feeding the rest of the day.
 *
 * PGlite, like the rest of `format-*` against the database: the jsonb config,
 * the `matches.scheduled_at` writes and the transaction boundaries are the
 * things under test, so a fake would be testing the fake.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  type Database,
  type EventConfig,
  events,
  matchGames,
  matches,
  stages,
  teams,
} from "@/db";
import { type TestDatabase, freshDatabase } from "@/db/__tests__/helpers";
import {
  type FormatResult,
  applySchedule,
  formatFor,
  generateMatches,
  recordGames,
  setMatchSchedule,
  setStages,
  stageClearings,
  syncStages,
} from "@/lib/format";

let ctx: TestDatabase;
let db: Database;

beforeAll(async () => {
  ctx = await freshDatabase();
  db = ctx.db;
});

afterAll(async () => {
  await ctx.close();
});

function unwrap<T>(result: FormatResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

let counter = 0;

/**
 * Minutes that make the arithmetic readable: every map is 30, so a Bo1 block
 * is 30 and the gap to the next one is 10.
 */
const TIMING = {
  modeMinutes: { convoy: 30, domination: 30 },
  defaultMinutes: 30,
  betweenGames: 5,
  betweenSeries: 10,
};

async function makeEvent(format: Record<string, unknown> = {}): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(events)
    .values({
      slug: `kept-${counter}`,
      title: `Kept ${counter}`,
      config: { format: { timing: TIMING, concurrentLobbies: 1, days: 1, ...format } } as EventConfig,
    })
    .returning({ id: events.id });
  return row.id;
}

/** `count` teams, seeded and sorted in list order unless told otherwise. */
async function makeTeams(
  eventId: string,
  count: number,
  seeds?: Array<number | null>
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const [row] = await db
      .insert(teams)
      .values({
        eventId,
        name: `Team ${i + 1}`,
        seed: seeds ? seeds[i] : i + 1,
        sort: i,
      })
      .returning({ id: teams.id });
    ids.push(row.id);
  }
  return ids;
}

/** A Bo1 round robin, generated — six matches, one phase each. */
async function table(
  count = 4,
  options: { format?: Record<string, unknown>; seeds?: Array<number | null> } = {}
) {
  const eventId = await makeEvent(options.format);
  const teamIds = await makeTeams(eventId, count, options.seeds);
  const created = unwrap(
    await setStages(eventId, [{ kind: "round_robin", name: "Table", config: { bestOf: 1 } }], db)
  );
  unwrap(await generateMatches(created[0].id, db));
  return { eventId, teamIds, stageId: created[0].id };
}

async function rowOf(eventId: string, slot: string) {
  const rows = await db.select().from(matches).where(eq(matches.eventId, eventId));
  const row = rows.find((entry) => entry.slot === slot);
  if (!row) throw new Error(`no match ${slot}`);
  return row;
}

async function startsBySlot(eventId: string): Promise<Record<string, string | null>> {
  const rows = await db.select().from(matches).where(eq(matches.eventId, eventId));
  return Object.fromEntries(
    [...rows]
      .sort((x, y) => x.slot.localeCompare(y.slot))
      .map((row) => [row.slot, row.scheduledAt ? row.scheduledAt.toISOString() : null])
  );
}

async function stageRow(stageId: string) {
  const [row] = await db.select().from(stages).where(eq(stages.id, stageId));
  return row;
}

/* ------------------------------------------------------------------ */
/* UC-18 E4 — a block moved to another day (R-156)                    */
/* ------------------------------------------------------------------ */

describe("moving a block to another day (UC-18 E4, R-156)", () => {
  /** Six Bo1 blocks of one match each: 30 minutes apiece, 10 between. */
  const twoDays = (blockDays: number[] | null) => ({
    days: 2,
    blockDays,
  });

  it("balances the blocks across the days when nobody has chosen", async () => {
    const { eventId } = await table(4, { format: twoDays(null) });
    const view = await formatFor(eventId, db);

    expect(view?.blocks.map((block) => block.day)).toEqual([1, 1, 1, 2, 2, 2]);
    // Three blocks: 30 + 10 + 30 + 10 + 30.
    expect(view?.dayMinutes).toEqual([110, 110]);
  });

  it("recomputes both days when one block is moved to the other", async () => {
    /*
     * The flow, in one assertion each way: the day the block left gets shorter
     * and the day it joined gets longer, and every offset after the move is
     * re-laid rather than left where the old plan put it.
     *
     * Block 2 (the third) moves from day 1 to day 2, so day 1 holds two blocks
     * and day 2 holds four.
     */
    const { eventId } = await table(4, { format: twoDays([1, 1, 2, 2, 2, 2]) });
    const view = await formatFor(eventId, db);

    expect(view?.blocks.map((block) => [block.day, block.offsetMin])).toEqual([
      [1, 0],
      [1, 40],
      [2, 0],
      [2, 40],
      [2, 80],
      [2, 120],
    ]);
    expect(view?.dayMinutes).toEqual([70, 150]);
  });

  it("writes the moved block's matches onto the other day's clock", async () => {
    /*
     * The preview being right is not the flow — the running order on the board
     * is. `applySchedule` lays each day out from its own start, so a block on
     * day 2 has to land on day 2's date rather than day 1's plus an offset.
     */
    const { eventId } = await table(4, { format: twoDays([1, 1, 1, 2, 2, 2]) });
    unwrap(
      await applySchedule(
        eventId,
        ["2026-05-01T16:00:00.000Z", "2026-05-02T16:00:00.000Z"],
        db
      )
    );
    /*
     * The blocks are the circle rounds in order — round 1 is 1v2 and 3v4,
     * round 2 is 1v3 and 2v4, round 3 is 1v4 and 2v3 — one match each at one
     * lobby, so the first three go to day 1 and the last three to day 2.
     */
    expect(await startsBySlot(eventId)).toEqual({
      "rr-1-2": "2026-05-01T16:00:00.000Z",
      "rr-3-4": "2026-05-01T16:40:00.000Z",
      "rr-1-3": "2026-05-01T17:20:00.000Z",
      "rr-2-4": "2026-05-02T16:00:00.000Z",
      "rr-1-4": "2026-05-02T16:40:00.000Z",
      "rr-2-3": "2026-05-02T17:20:00.000Z",
    });
  });

  it("leaves a day with no start time unscheduled rather than guessing", async () => {
    const { eventId } = await table(4, { format: twoDays([1, 1, 1, 2, 2, 2]) });
    unwrap(await applySchedule(eventId, ["2026-05-01T16:00:00.000Z", null], db));
    const starts = await startsBySlot(eventId);

    expect(starts["rr-1-2"]).toBe("2026-05-01T16:00:00.000Z");
    expect([starts["rr-2-4"], starts["rr-1-4"], starts["rr-2-3"]]).toEqual([null, null, null]);
  });

  it("ignores a chosen day the event does not have", async () => {
    // Four days' worth of overrides on a two-day event. Clamped rather than
    // refused: the blocks still have to go somewhere.
    const { eventId } = await table(4, { format: twoDays([1, 4, 4, 2, 3, 3]) });
    const view = await formatFor(eventId, db);
    expect(view?.blocks.map((block) => block.day)).toEqual([1, 2, 2, 2, 2, 2]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-18 E5 — the seeds the stored pairing is built from (R-160)       */
/* ------------------------------------------------------------------ */

describe("the seeds a generated table is paired by (UC-18 E5, R-160)", () => {
  it("writes the pairing from the seed column, not from the list order", async () => {
    // Reverse-seeded, so `seed:1` is the last team on the Teams tab.
    const { eventId, teamIds } = await table(4, { seeds: [4, 3, 2, 1] });
    const opener = await rowOf(eventId, "rr-1-2");
    expect([opener.teamAId, opener.teamBId]).toEqual([teamIds[3], teamIds[2]]);
  });

  it("obeys a half-seeded list instead of throwing every seed away", async () => {
    /*
     * The gap. `teams.seed` is nullable, nothing refuses a blank one, and the
     * seed order used to demand that *every* team carry a number before it
     * would honour a single one — so seeding the top two of four generated a
     * table paired in list order, with the two numbers silently dropped.
     *
     * Team 4 is seeded top and team 2 second, so `seed:1` v `seed:2` is team 4
     * against team 2 and the unseeded pair fall in behind them.
     */
    const { eventId, teamIds } = await table(4, { seeds: [null, 2, null, 1] });
    const opener = await rowOf(eventId, "rr-1-2");
    expect([opener.teamAId, opener.teamBId]).toEqual([teamIds[3], teamIds[1]]);

    // And the resolved board agrees with the stored row, which is the other
    // half of the bug: two readers of one column must not disagree.
    const view = await formatFor(eventId, db);
    expect(view?.stages[0].seeds).toEqual([teamIds[3], teamIds[1], teamIds[0], teamIds[2]]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-19 E1 — the mode a map was played on (R-153)                    */
/* ------------------------------------------------------------------ */

describe("recording the mode a map was played on (UC-19 E1, R-153)", () => {
  it("stores the mode beside the map and the score", async () => {
    const { eventId } = await table();
    const row = await rowOf(eventId, "rr-1-2");
    unwrap(
      await recordGames(
        row.id,
        [{ index: 0, mode: "Payload Escort", map: "Harbour", scoreA: 13, scoreB: 7, played: true }],
        {},
        db
      )
    );

    const [game] = await db.select().from(matchGames).where(eq(matchGames.matchId, row.id));
    expect([game.mode, game.map, game.played]).toEqual(["payload_escort", "Harbour", true]);
  });

  it("leaves the planned mode alone when the patch does not mention one", async () => {
    // A patch that sets a referee must not blank the mode the plan put there.
    const { eventId } = await table();
    const row = await rowOf(eventId, "rr-1-2");
    unwrap(await recordGames(row.id, [{ index: 0, referee: "Ash" }], {}, db));

    const [game] = await db.select().from(matchGames).where(eq(matchGames.matchId, row.id));
    expect([game.mode, game.referee]).toEqual(["convoy", "Ash"]);
  });

  it("does not make the stage look out of shape, or get rebuilt over (R-153 v R-73)", async () => {
    /*
     * The bug this flow exposed, and the sharpest one in the task.
     *
     * `syncStages` compares the generated shape against the stored rows, and
     * the mode of every game was part of that comparison — so recording what
     * the room actually played made the rows disagree with the plan. Two bad
     * answers followed, both reproduced before the fix:
     *
     *  - on a stage with a result, the stage was marked out of date for ever,
     *    and the Format tab explained that "there are results in the way";
     *  - on a stage nobody had finished, the sync counted it untouched and
     *    **rebuilt it**, deleting the record that had just been made.
     *
     * A played game's mode is a record, so it is read as the spec's own mode
     * and cannot make the rows stale. Both halves are asserted here because
     * the two paths through `syncStages` are different branches.
     */
    const { eventId, stageId } = await table();
    const row = await rowOf(eventId, "rr-1-2");
    unwrap(
      await recordGames(
        row.id,
        [{ index: 0, mode: "domination", scoreA: 13, scoreB: 7, played: true }],
        {},
        db
      )
    );

    const sync = unwrap(await syncStages(eventId, db));
    expect(sync.stages[0].state).toBe("current");
    expect([sync.rebuilt, sync.outOfDate]).toEqual([0, 0]);
    expect((await stageRow(stageId)).outOfDateSince).toBeNull();

    // The record survived, which is the thing a rebuild would have taken.
    const after = await rowOf(eventId, "rr-1-2");
    const [game] = await db.select().from(matchGames).where(eq(matchGames.matchId, after.id));
    expect([game.mode, game.played]).toEqual(["domination", true]);
  });

  it("still calls a stage stale when the mode sequence itself is edited", async () => {
    /*
     * The other side of that exemption, and why it is per *played* game rather
     * than a deletion of the whole comparison: the mode of a game nobody has
     * played is still the plan, so changing `config.modeSequence` has to make
     * the untouched rows out of step and rebuild them.
     */
    const { eventId, stageId } = await table();
    unwrap(
      await setStages(
        eventId,
        [
          {
            id: stageId,
            kind: "round_robin",
            name: "Table",
            config: { bestOf: 1, modeSequence: { "1": ["domination"] } },
          },
        ],
        db
      )
    );

    const sync = unwrap(await syncStages(eventId, db));
    expect(sync.stages[0].state).toBe("rebuilt");

    const row = await rowOf(eventId, "rr-1-2");
    const [game] = await db.select().from(matchGames).where(eq(matchGames.matchId, row.id));
    expect(game.mode).toBe("domination");
  });
});

/* ------------------------------------------------------------------ */
/* UC-19 E2 — a start moved by hand marks its stage (R-157)            */
/* ------------------------------------------------------------------ */

describe("a start time moved by hand (UC-19 E2, R-157)", () => {
  it("marks the stage, and shifts the later matches of that day", async () => {
    const { eventId, stageId } = await table();
    unwrap(await applySchedule(eventId, ["2026-05-01T16:00:00.000Z"], db));

    const row = await rowOf(eventId, "rr-1-2");
    unwrap(await setMatchSchedule(row.id, "2026-05-01T16:30:00.000Z", db));

    expect((await stageRow(stageId)).handEditedAt).not.toBeNull();
    const starts = await startsBySlot(eventId);
    expect(starts["rr-1-2"]).toBe("2026-05-01T16:30:00.000Z");
    // Everything after it moves by the same half hour.
    expect(starts["rr-3-4"]).toBe("2026-05-01T17:10:00.000Z");
  });

  it("does not mark the stage when the instruction lands on the stored start", async () => {
    /*
     * A form posts every field it holds. `recordGamesAction` calls
     * `setMatchSchedule` whenever `scheduledAt` is present, and the Results
     * tab's card always holds the match's own start — so recording a scoreline
     * marked the stage hand-edited without moving anything, and a card with no
     * start at all marked it by writing `null` over `null`.
     *
     * That is not cosmetic. The mark makes `stageTouchOf` call the stage
     * touched, so the matches stop being rebuilt when the teams change
     * (UC-18 9); it makes the rebuild dialog claim start times were moved by
     * hand; and it makes the Format tab blame hand-moved times for a stage
     * nobody has touched.
     */
    const { eventId, stageId } = await table();
    const unscheduled = await rowOf(eventId, "rr-1-2");
    expect(unscheduled.scheduledAt).toBeNull();

    expect(unwrap(await setMatchSchedule(unscheduled.id, null, db))).toEqual({
      scheduledAt: null,
    });
    expect((await stageRow(stageId)).handEditedAt).toBeNull();

    // And again on a match that does have a start, re-sent unchanged.
    unwrap(await applySchedule(eventId, ["2026-05-01T16:00:00.000Z"], db));
    const scheduled = await rowOf(eventId, "rr-1-2");
    unwrap(await setMatchSchedule(scheduled.id, "2026-05-01T16:00:00.000Z", db));

    expect((await stageRow(stageId)).handEditedAt).toBeNull();
    expect((await stageClearings(eventId, db))[0].handEdited).toBe(false);
    expect(unwrap(await syncStages(eventId, db)).stages[0].touch.handEdited).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* UC-19 E3 — the recorded duration feeds the day (R-158)             */
/* ------------------------------------------------------------------ */

describe("a recorded duration feeding that day's schedule (UC-19 E3, R-158)", () => {
  it("moves every later match of the day by how much the match overran", async () => {
    /*
     * *"At step 6, manager records how long the match took — System uses it
     * for that day's schedule."*
     *
     * The planned block is 30 minutes. Recording 60 fixes the finish at the
     * start plus an hour, and the rest of the day re-flows from that finish,
     * so each later match is half an hour later than the plan.
     */
    const { eventId } = await table();
    unwrap(await applySchedule(eventId, ["2026-05-01T16:00:00.000Z"], db));
    const planned = await startsBySlot(eventId);
    expect([planned["rr-1-2"], planned["rr-3-4"]]).toEqual([
      "2026-05-01T16:00:00.000Z",
      "2026-05-01T16:40:00.000Z",
    ]);

    const row = await rowOf(eventId, "rr-1-2");
    const outcome = unwrap(
      await recordGames(
        row.id,
        [{ index: 0, scoreA: 13, scoreB: 7, played: true }],
        { durationMin: 60 },
        db
      )
    );

    // The finish is the start plus the minutes that were recorded, not the
    // clock the save happened to run at.
    expect([outcome.durationMin, outcome.finishedAt]).toEqual([
      60,
      "2026-05-01T17:00:00.000Z",
    ]);

    const after = await startsBySlot(eventId);
    expect(after["rr-1-2"]).toBe("2026-05-01T16:00:00.000Z");
    expect([after["rr-3-4"], after["rr-1-3"], after["rr-2-4"]]).toEqual([
      "2026-05-01T17:10:00.000Z",
      "2026-05-01T17:50:00.000Z",
      "2026-05-01T18:30:00.000Z",
    ]);
  });

  it("pulls the day forward when the match took less than planned", async () => {
    // The same rule in the other direction, which is what makes it a schedule
    // rather than a floor: finishing early carries forward too.
    const { eventId } = await table();
    unwrap(await applySchedule(eventId, ["2026-05-01T16:00:00.000Z"], db));

    const row = await rowOf(eventId, "rr-1-2");
    unwrap(
      await recordGames(
        row.id,
        [{ index: 0, scoreA: 13, scoreB: 7, played: true }],
        { durationMin: 10 },
        db
      )
    );

    expect((await startsBySlot(eventId))["rr-3-4"]).toBe("2026-05-01T16:20:00.000Z");
  });

  it("leaves the other days where they are", async () => {
    /*
     * Days are independent — each has its own start time — so an overrun on
     * day 1 must not push day 2 into the evening.
     */
    const { eventId } = await table(4, { format: { days: 2, blockDays: [1, 1, 1, 2, 2, 2] } });
    unwrap(
      await applySchedule(
        eventId,
        ["2026-05-01T16:00:00.000Z", "2026-05-02T16:00:00.000Z"],
        db
      )
    );

    const row = await rowOf(eventId, "rr-1-2");
    unwrap(
      await recordGames(
        row.id,
        [{ index: 0, scoreA: 13, scoreB: 7, played: true }],
        { durationMin: 120 },
        db
      )
    );

    const after = await startsBySlot(eventId);
    // Day 1 absorbs the whole overrun: 16:00 + 120 + 10 for the next block.
    expect([after["rr-3-4"], after["rr-1-3"]]).toEqual([
      "2026-05-01T18:10:00.000Z",
      "2026-05-01T18:50:00.000Z",
    ]);
    // Day 2 has its own start, and does not move.
    expect([after["rr-2-4"], after["rr-1-4"], after["rr-2-3"]]).toEqual([
      "2026-05-02T16:00:00.000Z",
      "2026-05-02T16:40:00.000Z",
      "2026-05-02T17:20:00.000Z",
    ]);
  });

  it("derives the duration from the clock when the manager records none", async () => {
    // Absent is not zero: the finish is stamped and the duration read back off
    // the window, so the day still re-flows from something real.
    const { eventId } = await table();
    unwrap(await applySchedule(eventId, ["2026-05-01T16:00:00.000Z"], db));

    const row = await rowOf(eventId, "rr-1-2");
    const outcome = unwrap(
      await recordGames(
        row.id,
        [{ index: 0, scoreA: 13, scoreB: 7, played: true }],
        { now: new Date("2026-05-01T16:45:00.000Z") },
        db
      )
    );

    expect([outcome.finishedAt, outcome.durationMin]).toEqual([
      "2026-05-01T16:45:00.000Z",
      45,
    ]);
    expect((await startsBySlot(eventId))["rr-3-4"]).toBe("2026-05-01T16:55:00.000Z");
  });
});
