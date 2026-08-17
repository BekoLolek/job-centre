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
import { eq } from "drizzle-orm";
import { type Database, type EventConfig, events, matchGames, matches, stages, teams } from "@/db";
import { type TestDatabase, freshDatabase } from "@/db/__tests__/helpers";
import {
  applySchedule,
  formatFor,
  generateMatches,
  recordGames,
  scheduleSettingsFrom,
  setStages,
  setWinnerOverride,
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

  it("ignores a negative score rather than storing one", async () => {
    const { eventId } = await boardEvent();
    const id = await matchId(eventId, "rr-1-2");
    await recordGames(id, [{ index: 0, scoreA: -5, played: true }], {}, db);
    const [game] = await db.select().from(matchGames).where(eq(matchGames.matchId, id));
    expect(game.scoreA).toBe(0);
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
