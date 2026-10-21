import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
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
  formatFor,
  generateMatches,
  rebuildStage,
  recordGames,
  setMatchSchedule,
  matchesNamingTeams,
  releaseTeamsFromMatches,
  setStages,
  setWinnerOverride,
  stageClearings,
  syncStages,
} from "@/lib/format";

/**
 * **The matches follow the teams, and nothing rebuilds over somebody's work.**
 *
 * Task 21 against real Postgres — R-73, R-157, R-161, R-162 / UC-18 2a, 5, 9,
 * 9a and the Swiss notes, UC-19 E2.
 *
 * This is the most destructive code in the project: `syncStages` deletes whole
 * stages and writes them again, and the only thing between it and a wiped
 * tournament is its answer to "has somebody touched this". So the file is
 * organised around that one question, and every case that should be answered
 * *yes* is asserted both ways — the rows were not replaced, **and** the thing
 * that made the stage untouchable is still there afterwards.
 *
 * PGlite is real Postgres 17 compiled to WASM, so the row lock, the cascades
 * and the jsonb behave as they will on Neon.
 */

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

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

async function makeEvent(config: EventConfig = {}): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(events)
    .values({ slug: `sync-${counter}`, title: `Sync ${counter}`, config })
    .returning({ id: events.id });
  return row.id;
}

/** `count` teams, seeded and sorted in order, named for the event they are in. */
async function addTeams(eventId: string, from: number, to: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = from; index <= to; index += 1) {
    const [row] = await db
      .insert(teams)
      .values({ eventId, name: `Team ${index}`, seed: index, sort: index })
      .returning({ id: teams.id });
    ids.push(row.id);
  }
  return ids;
}

type Fixture = {
  eventId: string;
  stageId: string;
  teamIds: string[];
};

/** An event with `teamCount` teams and one generated stage of `kind`. */
async function staged(
  kind: "round_robin" | "single_elim" | "double_elim" | "swiss" | "group_playoff",
  teamCount: number,
  config: Record<string, unknown> = {}
): Promise<Fixture> {
  const eventId = await makeEvent();
  const teamIds = await addTeams(eventId, 1, teamCount);
  const written = unwrap(await setStages(eventId, [{ kind, name: "Stage", config }], db));
  unwrap(await generateMatches(written[0].id, db));
  return { eventId, stageId: written[0].id, teamIds };
}

async function rowsOf(stageId: string) {
  return db
    .select()
    .from(matches)
    .where(eq(matches.stageId, stageId))
    .orderBy(asc(matches.slot));
}

async function stageRow(stageId: string) {
  const [row] = await db.select().from(stages).where(eq(stages.id, stageId));
  return row;
}

async function matchId(stageId: string, slot: string): Promise<string> {
  const rows = await rowsOf(stageId);
  const row = rows.find((entry) => entry.slot === slot);
  if (!row) throw new Error(`no match ${slot} in ${rows.map((r) => r.slot).join(", ")}`);
  return row.id;
}

/** Win a series for one side, taking the minimum number of games. */
async function win(stageId: string, slot: string, side: "a" | "b"): Promise<void> {
  const id = await matchId(stageId, slot);
  const [row] = await db.select().from(matches).where(eq(matches.id, id));
  const target = Math.floor(row.bestOf / 2) + 1;
  unwrap(
    await recordGames(
      id,
      Array.from({ length: target }, (_unused, index) => ({
        index,
        scoreA: side === "a" ? 1 : 0,
        scoreB: side === "b" ? 1 : 0,
        played: true,
      })),
      {},
      db
    )
  );
}

/** How many games of this stage are ticked off. */
async function playedGames(stageId: string): Promise<number> {
  const rows = await db
    .select({ id: matchGames.id })
    .from(matchGames)
    .innerJoin(matches, eq(matchGames.matchId, matches.id))
    .where(and(eq(matches.stageId, stageId), eq(matchGames.played, true)));
  return rows.length;
}

/**
 * This file's database, except that the first transaction it opens runs
 * `between` to completion first — the same helper `draft.test.ts` and
 * `events.test.ts` use, for the same reason.
 *
 * Sequenced rather than raced. A result landing in the exact window between
 * "which stages are stale" and "delete every match in this one" is not
 * something a timer can be trusted to reproduce, and a test that had to *win* a
 * race to see the bug would pass by luck on the days it did not. This pins the
 * interleave: everything the outer call could have read before it opened its
 * transaction is stale, because the inner one has already committed.
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

/* ------------------------------------------------------------------ */
/* UC-18 9 — the matches follow the teams                             */
/* ------------------------------------------------------------------ */

describe("syncStages: an untouched stage follows the teams (UC-18 9)", () => {
  it("rebuilds a round robin when two more teams arrive", async () => {
    const { eventId, stageId } = await staged("round_robin", 4);
    expect(await rowsOf(stageId)).toHaveLength(6);

    await addTeams(eventId, 5, 6);
    const sync = unwrap(await syncStages(eventId, db));

    expect(sync.rebuilt).toBe(1);
    expect(sync.stages[0].state).toBe("rebuilt");
    // Six teams play fifteen; four play six. The rows, not the spec.
    expect(await rowsOf(stageId)).toHaveLength(15);
  });

  it("follows a re-seeding, with the count unchanged (UC-18 E5)", async () => {
    /*
     * The case a row count cannot see, and the one that matters most: four
     * teams before and four after, so the old "rows.length === spec.length"
     * test said the stage was current — while every match in it named the
     * wrong pair. `seed:1` is a *reference*, so moving the seeds moves which
     * team each table game is actually between.
     */
    const { eventId, stageId, teamIds } = await staged("round_robin", 4);
    const opener = (await rowsOf(stageId)).find((row) => row.slot === "rr-1-2");
    expect([opener?.teamAId, opener?.teamBId]).toEqual([teamIds[0], teamIds[1]]);

    // The manager seeds them the other way round.
    for (const [index, id] of teamIds.entries()) {
      await db.update(teams).set({ seed: teamIds.length - index }).where(eq(teams.id, id));
    }

    const sync = unwrap(await syncStages(eventId, db));
    expect(sync.stages[0].state).toBe("rebuilt");

    const rows = await rowsOf(stageId);
    expect(rows).toHaveLength(6);
    const after = rows.find((row) => row.slot === "rr-1-2");
    expect([after?.teamAId, after?.teamBId]).toEqual([teamIds[3], teamIds[2]]);
  });

  it("follows a stage setting that leaves the match count alone (UC-18 5)", async () => {
    const { eventId, stageId } = await staged("round_robin", 4, { bestOf: 1 });
    const before = await rowsOf(stageId);
    expect(before.every((row) => row.bestOf === 1)).toBe(true);

    unwrap(
      await setStages(
        eventId,
        [{ id: stageId, kind: "round_robin", name: "Stage", config: { bestOf: 3, bestOfByBracket: {} } }],
        db
      )
    );
    const sync = unwrap(await syncStages(eventId, db));

    expect(sync.stages[0].state).toBe("rebuilt");
    const after = await rowsOf(stageId);
    expect(after).toHaveLength(before.length);
    expect(after.every((row) => row.bestOf === 3)).toBe(true);
    // The cards follow the series length, three games each rather than one.
    const cards = await db
      .select({ id: matchGames.id })
      .from(matchGames)
      .innerJoin(matches, eq(matchGames.matchId, matches.id))
      .where(eq(matches.stageId, stageId));
    expect(cards).toHaveLength(after.length * 3);
  });

  it("writes nothing when the rows already are the shape", async () => {
    const { eventId, stageId } = await staged("double_elim", 4);
    const before = await rowsOf(stageId);

    const sync = unwrap(await syncStages(eventId, db));
    expect(sync.stages[0].state).toBe("current");
    expect(sync.rebuilt).toBe(0);

    // The same rows, not merely the same number of them: a rebuild would have
    // given every match a new id and re-tossed its coin.
    const after = await rowsOf(stageId);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
  });

  it("generates a stage that has never been generated at all", async () => {
    const eventId = await makeEvent();
    await addTeams(eventId, 1, 4);
    const written = unwrap(await setStages(eventId, [{ kind: "single_elim" }], db));

    expect(await rowsOf(written[0].id)).toHaveLength(0);
    const sync = unwrap(await syncStages(eventId, db));
    expect(sync.stages[0].state).toBe("rebuilt");
    // Two semis, a final, and the bronze match a single elimination can only
    // express as a separate one.
    expect((await rowsOf(written[0].id)).map((row) => row.slot)).toEqual([
      "bronze",
      "f",
      "sf1",
      "sf2",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-18 9a — a stage that has been touched is marked, never rebuilt  */
/* ------------------------------------------------------------------ */

describe("syncStages: a touched stage is marked out of date (UC-18 9a)", () => {
  it("leaves a recorded result exactly where it is", async () => {
    const { eventId, stageId } = await staged("round_robin", 4);
    await win(stageId, "rr-1-2", "a");
    const before = await rowsOf(stageId);

    await addTeams(eventId, 5, 6);
    const sync = unwrap(await syncStages(eventId, db));

    expect(sync.stages[0].state).toBe("out_of_date");
    expect(sync.rebuilt).toBe(0);
    expect(await stageRow(stageId).then((row) => row.outOfDateSince)).not.toBeNull();

    // Both halves: the rows were not replaced, and the result is still there.
    expect((await rowsOf(stageId)).map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(await playedGames(stageId)).toBe(1);
  });

  it("refuses over a score typed in but never ticked off", async () => {
    /*
     * Not a result — `stageHasResults` says so, and a manager who is *told*
     * about it may clear it. But an automation has nobody to ask, so the
     * refusal is the default whenever it cannot tell.
     */
    const { eventId, stageId } = await staged("round_robin", 4);
    const id = await matchId(stageId, "rr-1-2");
    unwrap(await recordGames(id, [{ index: 0, scoreA: 2, scoreB: 1, played: false }], {}, db));

    await addTeams(eventId, 5, 6);
    const sync = unwrap(await syncStages(eventId, db));

    expect(sync.stages[0].state).toBe("out_of_date");
    expect(sync.stages[0].touch.draftedScores).toBe(1);
    expect(await rowsOf(stageId)).toHaveLength(6);
  });

  it("refuses over a winner called on a drawn series", async () => {
    const { eventId, stageId, teamIds } = await staged("single_elim", 4, { bestOf: 1 });
    // Seed 1 v seed 4 in a four-team bracket; the override names a real team.
    const id = await matchId(stageId, "sf1");
    unwrap(await setWinnerOverride(id, teamIds[0], db));

    await addTeams(eventId, 5, 6);
    const sync = unwrap(await syncStages(eventId, db));
    expect(sync.stages[0].state).toBe("out_of_date");
    expect(sync.stages[0].touch.overrides).toBe(1);
  });

  it("stamps the mark once, so “out of date since” stays true", async () => {
    const { eventId, stageId } = await staged("round_robin", 4);
    await win(stageId, "rr-1-2", "a");
    await addTeams(eventId, 5, 6);

    unwrap(await syncStages(eventId, db));
    const first = (await stageRow(stageId)).outOfDateSince;
    expect(first).not.toBeNull();

    unwrap(await syncStages(eventId, db));
    expect((await stageRow(stageId)).outOfDateSince?.toISOString()).toBe(first?.toISOString());
  });

  it("clears the mark when the rows come back into line", async () => {
    const { eventId, stageId } = await staged("round_robin", 4);
    await win(stageId, "rr-1-2", "a");

    const added = await addTeams(eventId, 5, 6);
    unwrap(await syncStages(eventId, db));
    expect((await stageRow(stageId)).outOfDateSince).not.toBeNull();

    // The manager puts the teams back. The matches were never replaced, so
    // they are the right shape again — and nothing is out of date any more.
    await db.delete(teams).where(eq(teams.id, added[0]));
    await db.delete(teams).where(eq(teams.id, added[1]));
    const sync = unwrap(await syncStages(eventId, db));

    expect(sync.stages[0].state).toBe("current");
    expect((await stageRow(stageId)).outOfDateSince).toBeNull();
    expect(await playedGames(stageId)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* UC-19 E2 — a hand-moved start time marks its stage                 */
/* ------------------------------------------------------------------ */

describe("a hand-moved start time (R-157 / UC-19 E2)", () => {
  it("marks the stage hand-edited", async () => {
    const { stageId } = await staged("round_robin", 4);
    expect((await stageRow(stageId)).handEditedAt).toBeNull();

    unwrap(await setMatchSchedule(await matchId(stageId, "rr-1-2"), "2026-06-20T18:00:00Z", db));
    expect((await stageRow(stageId)).handEditedAt).not.toBeNull();
  });

  it("stops the stage being rebuilt from under the time that was typed", async () => {
    const { eventId, stageId } = await staged("round_robin", 4);
    const moved = await matchId(stageId, "rr-1-2");
    unwrap(await setMatchSchedule(moved, "2026-06-20T18:00:00Z", db));

    await addTeams(eventId, 5, 6);
    const sync = unwrap(await syncStages(eventId, db));

    expect(sync.stages[0].state).toBe("out_of_date");
    expect(sync.stages[0].touch.handEdited).toBe(true);
    // The moved time survived, and so did the match it was typed onto.
    const [row] = await db.select().from(matches).where(eq(matches.id, moved));
    expect(row.scheduledAt?.toISOString()).toBe("2026-06-20T18:00:00.000Z");
  });

  it("is not set by the auto fill or by a re-flow", async () => {
    /*
     * The whole reason this is a column: three different things write
     * `scheduled_at`, and only one of them is a person moving a match. If the
     * auto fill marked the stage too, every event with a running order would be
     * frozen against the teams for ever.
     */
    const { eventId, stageId } = await staged("round_robin", 4);
    const { applySchedule } = await import("@/lib/format");
    unwrap(await applySchedule(eventId, ["2026-06-20T10:00:00Z"], db));

    const rows = await rowsOf(stageId);
    expect(rows.every((row) => row.scheduledAt !== null)).toBe(true);
    expect((await stageRow(stageId)).handEditedAt).toBeNull();

    // And a re-flow, which `recordGames` runs on every write.
    await win(stageId, "rr-1-2", "a");
    expect((await stageRow(stageId)).handEditedAt).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* UC-18 2a — the kind does not support the team count                */
/* ------------------------------------------------------------------ */

describe("a team count the kind cannot be played with (UC-18 2a)", () => {
  it("names the range and generates nothing", async () => {
    const eventId = await makeEvent();
    await addTeams(eventId, 1, 4);
    const written = unwrap(
      await setStages(eventId, [{ kind: "group_playoff", config: { groups: 3 } }], db)
    );

    const result = await generateMatches(written[0].id, db);
    expect(result).toEqual({
      ok: false,
      error:
        "Groups then a playoff with 3 groups needs between 6 and 8 teams. This event has 4.",
    });
    expect(await rowsOf(written[0].id)).toHaveLength(0);
  });

  it("is reported by the sync rather than failing the write that caused it", async () => {
    const eventId = await makeEvent();
    await addTeams(eventId, 1, 4);
    const written = unwrap(
      await setStages(eventId, [{ kind: "swiss", config: { rounds: 6 } }], db)
    );

    const sync = unwrap(await syncStages(eventId, db));
    expect(sync.stages[0].state).toBe("refused");
    expect(sync.stages[0].reason).toContain("needs between 7 and 8 teams");
    expect(await rowsOf(written[0].id)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* UC-18 9a — "rebuild anyway" lists what it clears, then clears it   */
/* ------------------------------------------------------------------ */

describe("rebuildStage (UC-18 9a, R-162 / UC-18 E6)", () => {
  it("lists the results it would clear, by name", async () => {
    const { eventId, stageId } = await staged("round_robin", 4, { bestOf: 1 });
    await win(stageId, "rr-1-2", "a");

    const [clearing] = await stageClearings(eventId, db);
    expect(clearing.stageId).toBe(stageId);
    expect(clearing.matches).toBe(6);
    expect(clearing.playedGames).toBe(1);
    expect(clearing.decided).toBe(1);
    expect(clearing.blocked).toBe(true);
    expect(clearing.results).toEqual([
      { slot: "rr-1-2", label: "Round 1", line: "Team 1 1–0 Team 2" },
    ]);
  });

  it("clears them and rebuilds when handed the token it was shown", async () => {
    const { eventId, stageId } = await staged("round_robin", 4, { bestOf: 1 });
    await win(stageId, "rr-1-2", "a");
    await addTeams(eventId, 5, 6);
    unwrap(await syncStages(eventId, db));

    const [clearing] = await stageClearings(eventId, db);
    const rebuilt = unwrap(await rebuildStage(stageId, clearing.confirm, db));

    expect(rebuilt.created).toBe(15);
    // What went is reported back, so the caller can log it.
    expect(rebuilt.cleared.results).toHaveLength(1);
    expect(await playedGames(stageId)).toBe(0);
    // And the stage is current again: no mark, no stale rows.
    const row = await stageRow(stageId);
    expect(row.outOfDateSince).toBeNull();
    expect(row.handEditedAt).toBeNull();
  });

  it("refuses a token that does not match anything", async () => {
    const { stageId } = await staged("round_robin", 4);
    const result = await rebuildStage(stageId, "not-a-token", db);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("changed since you were shown");
    expect(await rowsOf(stageId)).toHaveLength(6);
  });

  it("refuses an empty token, so a caller cannot opt out of confirming", async () => {
    const { stageId } = await staged("round_robin", 4);
    expect((await rebuildStage(stageId, "", db)).ok).toBe(false);
    expect(await rowsOf(stageId)).toHaveLength(6);
  });

  it("refuses on a finished event, token or no token", async () => {
    const { eventId, stageId } = await staged("round_robin", 4);
    const [clearing] = await stageClearings(eventId, db);
    await db.update(events).set({ status: "complete" }).where(eq(events.id, eventId));

    const result = await rebuildStage(stageId, clearing.confirm, db);
    expect(result.ok).toBe(false);
    expect(await rowsOf(stageId)).toHaveLength(6);
  });
});

/* ------------------------------------------------------------------ */
/* Concurrency                                                        */
/* ------------------------------------------------------------------ */

describe("a rebuild racing a result", () => {
  it("declines rather than half-rebuilding when the result lands first", async () => {
    /*
     * The shape of the accident this guards against: the teams change, which
     * makes the stage stale and therefore due for a rebuild, and in the window
     * between that decision and the delete a manager records a result into the
     * stage being replaced.
     *
     * `committingAfter` makes the result commit before `syncStages` opens its
     * transaction, so the sync's reads are the ones it would have had if it had
     * lost the race for the event's row lock. It has to see the result and
     * decline — anything else loses a played game.
     */
    const { eventId, stageId } = await staged("round_robin", 4);
    await addTeams(eventId, 5, 6);

    const sync = unwrap(
      await syncStages(
        eventId,
        committingAfter(() => win(stageId, "rr-1-2", "a"))
      )
    );

    expect(sync.stages[0].state).toBe("out_of_date");
    expect(await playedGames(stageId)).toBe(1);
    expect(await rowsOf(stageId)).toHaveLength(6);
  });

  it("rebuilds the same stage when no result lands — the control", async () => {
    /*
     * Without this, the assertion above passes on a sync that never rebuilds
     * anything. Same fixture, same stale stage, no interleaved result.
     */
    const { eventId, stageId } = await staged("round_robin", 4);
    await addTeams(eventId, 5, 6);

    const sync = unwrap(await syncStages(eventId, db));
    expect(sync.stages[0].state).toBe("rebuilt");
    expect(await rowsOf(stageId)).toHaveLength(15);
  });

  it("refuses a confirmed rebuild whose stage moved while the dialog was open", async () => {
    const { eventId, stageId } = await staged("round_robin", 4, { bestOf: 1 });
    await win(stageId, "rr-1-2", "a");

    // What the manager was shown: one result.
    const [clearing] = await stageClearings(eventId, db);
    expect(clearing.results).toHaveLength(1);

    // A second result lands between the dialog opening and the button.
    const result = await rebuildStage(
      stageId,
      clearing.confirm,
      committingAfter(() => win(stageId, "rr-1-3", "a"))
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("changed since you were shown");
    // Nothing cleared. Both results are still there.
    expect(await playedGames(stageId)).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* A closed record                                                    */
/* ------------------------------------------------------------------ */

describe("syncStages on an event that is over", () => {
  it("rewrites nothing, and says why", async () => {
    const { eventId, stageId } = await staged("round_robin", 4);
    await addTeams(eventId, 5, 6);
    await db.update(events).set({ status: "complete" }).where(eq(events.id, eventId));

    const sync = unwrap(await syncStages(eventId, db));
    expect(sync.rebuilt).toBe(0);
    expect(sync.stages[0].state).toBe("refused");
    expect(sync.stages[0].reason).toBeTruthy();
    expect(await rowsOf(stageId)).toHaveLength(6);
  });
});

/* ------------------------------------------------------------------ */
/* Swiss, round by round (UC-18 swiss)                                */
/* ------------------------------------------------------------------ */

describe("Swiss rounds appear as the round before them finishes", () => {
  /** Finish every stored match of the stage, better seed winning. */
  async function finishRound(stageId: string, round: number): Promise<void> {
    const rows = (await rowsOf(stageId)).filter((row) => row.round === round);
    for (const row of rows) await win(stageId, row.slot, "a");
  }

  it("generates round one only, and pairs round two from the table", async () => {
    const { eventId, stageId } = await staged("swiss", 4, { rounds: 3, bestOf: 1 });
    expect((await rowsOf(stageId)).map((row) => row.slot)).toEqual(["sw1-1-3", "sw1-2-4"]);

    await finishRound(stageId, 1);

    const rows = await rowsOf(stageId);
    const second = rows.filter((row) => row.round === 2);
    expect(second).toHaveLength(2);
    // 1 and 2 won; 3 and 4 lost. So the table is 1, 2, 3, 4 and neither new
    // pairing is a rematch of round one's 1 v 3 and 2 v 4.
    expect(second.map((row) => row.slot)).toEqual(["sw2-1-2", "sw2-3-4"]);

    // The pairing is written down, not re-derived on every read.
    const stored = (await stageRow(stageId)).config as { swissRounds?: Record<string, unknown> };
    expect(stored.swissRounds).toEqual({ "2": [[1, 2], [3, 4]] });
  });

  it("stops at the configured number of rounds", async () => {
    const { stageId } = await staged("swiss", 4, { rounds: 2, bestOf: 1 });
    await finishRound(stageId, 1);
    expect((await rowsOf(stageId)).filter((row) => row.round === 2)).toHaveLength(2);

    await finishRound(stageId, 2);
    const rounds = [...new Set((await rowsOf(stageId)).map((row) => row.round))];
    expect(rounds).toEqual([1, 2]);
  });

  it("adds one round at a time, never two", async () => {
    const { stageId } = await staged("swiss", 4, { rounds: 3, bestOf: 1 });
    await finishRound(stageId, 1);
    expect([...new Set((await rowsOf(stageId)).map((row) => row.round))]).toEqual([1, 2]);
    await finishRound(stageId, 2);
    expect([...new Set((await rowsOf(stageId)).map((row) => row.round))]).toEqual([1, 2, 3]);
  });

  it("waits for every match of the round, not just one", async () => {
    const { stageId } = await staged("swiss", 4, { rounds: 3, bestOf: 1 });
    await win(stageId, "sw1-1-3", "a");
    expect((await rowsOf(stageId)).filter((row) => row.round === 2)).toHaveLength(0);
  });

  it("hands the next stage nothing until every round is in", async () => {
    /*
     * A Swiss is the one table whose matches are not all generated up front, so
     * "every match decided" is not "the stage is over". A bracket seeded off
     * the table after round one would be seeded off an order about to move.
     */
    const { eventId, stageId } = await staged("swiss", 4, { rounds: 2, bestOf: 1 });
    await finishRound(stageId, 1);

    const mid = await formatFor(eventId, db);
    expect(mid?.stages[0].seeding).toBeNull();

    await finishRound(stageId, 2);
    const done = await formatFor(eventId, db);
    expect(done?.stages[0].seeding).toHaveLength(4);
  });

  it("goes back to round one when the stage is rebuilt", async () => {
    const { eventId, stageId } = await staged("swiss", 4, { rounds: 3, bestOf: 1 });
    await finishRound(stageId, 1);
    expect((await rowsOf(stageId)).filter((row) => row.round === 2)).toHaveLength(2);

    const [clearing] = await stageClearings(eventId, db);
    unwrap(await rebuildStage(stageId, clearing.confirm, db));

    expect((await rowsOf(stageId)).map((row) => row.slot)).toEqual(["sw1-1-3", "sw1-2-4"]);
    const stored = (await stageRow(stageId)).config as { swissRounds?: Record<string, unknown> };
    expect(stored.swissRounds).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/* R-161 / UC-15 E1 — removing a team a match names                   */
/* ------------------------------------------------------------------ */

describe("releaseTeamsFromMatches (R-161 / UC-15 E1)", () => {
  it("counts the matches a removal would clear, by stage", async () => {
    const { eventId, teamIds } = await staged("round_robin", 4);

    const release = await matchesNamingTeams(eventId, [teamIds[3]], db);
    // Team 4 plays each of the other three.
    expect(release.matches).toBe(3);
    expect(release.withResults).toBe(0);
    expect(release.stages).toHaveLength(1);
    expect(release.stages[0].matches).toBe(3);
  });

  it("lets Postgres delete the team, by turning a stored pairing into its source", async () => {
    /*
     * `matches.team_a_id` references `teams` with no `on delete` action, so the
     * database refuses to delete a team any match names — and refuses with a
     * foreign-key error, which is the right instinct and the wrong sentence.
     * Nulling the column leaves the match resolving from `seed:n`, which is how
     * every bracket match in the engine already works.
     */
    const { eventId, stageId, teamIds } = await staged("round_robin", 4);
    const doomed = teamIds[3];

    unwrap(await releaseTeamsFromMatches(eventId, [doomed], db));
    await expect(db.delete(teams).where(eq(teams.id, doomed))).resolves.toBeDefined();

    // Nobody else lost their pairing in the process.
    const rows = await rowsOf(stageId);
    expect(rows.filter((row) => row.teamAId === null || row.teamBId === null)).toHaveLength(3);
    const opener = rows.find((row) => row.slot === "rr-1-2");
    expect([opener?.teamAId, opener?.teamBId]).toEqual([teamIds[0], teamIds[1]]);

    // And the sync puts the stage back to the three-team shape.
    const sync = unwrap(await syncStages(eventId, db));
    expect(sync.stages[0].state).toBe("rebuilt");
    expect(await rowsOf(stageId)).toHaveLength(3);
  });

  it("refuses when one of those matches carries a result, and names the stage", async () => {
    const { eventId, stageId, teamIds } = await staged("round_robin", 4, { bestOf: 1 });
    // Team 1 beats Team 2. Team 2 is the one being removed.
    await win(stageId, "rr-1-2", "a");

    const release = await matchesNamingTeams(eventId, [teamIds[1]], db);
    expect(release.withResults).toBe(1);

    const result = await releaseTeamsFromMatches(eventId, [teamIds[1]], db);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("“Stage”");
    expect(result.error).toContain("who that result belongs to");

    // Nothing was nulled, so the team still cannot be deleted — which is the
    // point: a refusal that left the reference cleared would have handed the
    // next caller a silent re-attribution.
    const opener = (await rowsOf(stageId)).find((row) => row.slot === "rr-1-2");
    expect(opener?.teamAId).toBe(teamIds[0]);
    expect(opener?.teamBId).toBe(teamIds[1]);
  });

  it("refuses over a winner override naming the team being removed", async () => {
    const { eventId, stageId, teamIds } = await staged("single_elim", 4, { bestOf: 1 });
    const id = await matchId(stageId, "sf1");
    unwrap(await setWinnerOverride(id, teamIds[0], db));

    const result = await releaseTeamsFromMatches(eventId, [teamIds[0]], db);
    expect(result.ok).toBe(false);
  });

  it("does nothing, and says so, when no match names them", async () => {
    const eventId = await makeEvent();
    const ids = await addTeams(eventId, 1, 4);
    expect(unwrap(await releaseTeamsFromMatches(eventId, ids, db)).released).toBe(0);
  });
});
