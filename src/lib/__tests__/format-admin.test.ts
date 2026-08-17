/**
 * The two reads and writes the admin's Format, Schedule and Results tabs need
 * on top of what §8 already built, against real Postgres.
 *
 * `matchIdsFor` is the mapping between a *generated* slot and the row it was
 * written to — a `ResolvedMatch` deliberately carries no id, because half of it
 * does not exist until a stage is generated. `setMatchSchedule` is the per-match
 * half of §10's scheduling: `applySchedule` says when a day begins, this says
 * when one match actually did, and both have to leave the rest of the day
 * consistent.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, type EventConfig, events, matches, teams } from "@/db";
import { type TestDatabase, freshDatabase } from "@/db/__tests__/helpers";
import {
  applySchedule,
  formatFor,
  generateMatches,
  matchIdsFor,
  recordGames,
  setMatchSchedule,
  setStages,
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
    .values({ slug: `admin-fmt-${counter}`, title: `Admin format ${counter}`, config })
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

/** A generated event, of any team count and any shape. */
async function boardEvent(
  teamCount: number,
  kind: "double_elim" | "single_elim" | "round_robin" = "double_elim",
  config: EventConfig = {}
) {
  const eventId = await makeEvent(config);
  const teamIds = await makeTeams(eventId, teamCount);
  const created = await setStages(eventId, [{ kind, name: "Playoffs" }], db);
  if (!created.ok) throw new Error(created.error);
  const generated = await generateMatches(created.data[0].id, db);
  if (!generated.ok) throw new Error(generated.error);
  return { eventId, teamIds, stageId: created.data[0].id };
}

describe("matchIdsFor", () => {
  it("names every generated slot, and nothing else", async () => {
    const { eventId } = await boardEvent(8);
    const view = await formatFor(eventId, db);
    const ids = await matchIdsFor(eventId, db);

    const slots = view?.stages.flatMap((stage) => stage.matches.map((m) => m.slot)) ?? [];
    expect(slots).toHaveLength(14);
    expect(Object.keys(ids).sort()).toEqual([...slots].sort());
    expect(new Set(Object.values(ids)).size).toBe(slots.length);
  });

  it("is empty for an event whose stage has never been generated", async () => {
    const eventId = await makeEvent();
    await makeTeams(eventId, 4);
    const created = await setStages(eventId, [{ kind: "double_elim" }], db);
    expect(created.ok).toBe(true);
    expect(await matchIdsFor(eventId, db)).toEqual({});
  });

  it("hands back ids the writes actually accept", async () => {
    const { eventId } = await boardEvent(4);
    const ids = await matchIdsFor(eventId, db);

    const result = await recordGames(
      ids.ubsf1,
      [{ index: 0, scoreA: 1, scoreB: 0, played: true }],
      {},
      db
    );
    expect(result.ok).toBe(true);
  });

  it("follows a regeneration rather than pointing at deleted rows", async () => {
    const { eventId, stageId } = await boardEvent(4);
    const before = await matchIdsFor(eventId, db);

    const again = await generateMatches(stageId, db);
    expect(again.ok).toBe(true);

    const after = await matchIdsFor(eventId, db);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    // Same slots, different rows: a regeneration is a delete and an insert.
    expect(after.ubsf1).not.toBe(before.ubsf1);

    const rows = await db.select({ id: matches.id }).from(matches).where(eq(matches.eventId, eventId));
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set(Object.values(after)));
  });
});

describe("setMatchSchedule", () => {
  it("moves the day's opener, and everything after it with it", async () => {
    const { eventId } = await boardEvent(4);
    const applied = await applySchedule(eventId, ["2026-08-15T16:00:00.000Z"], db);
    expect(applied.ok).toBe(true);

    const before = await formatFor(eventId, db);
    const opener = before?.blocks[0].slots[0] as string;
    const later = before?.blocks[1].slots[0] as string;
    const laterWas = before?.stages[0].matches.find((m) => m.slot === later)?.scheduledAt;

    const ids = await matchIdsFor(eventId, db);
    const moved = await setMatchSchedule(ids[opener], "2026-08-15T16:30:00.000Z", db);
    expect(moved.ok).toBe(true);

    const after = await formatFor(eventId, db);
    const openerNow = after?.stages[0].matches.find((m) => m.slot === opener)?.scheduledAt;
    const laterNow = after?.stages[0].matches.find((m) => m.slot === later)?.scheduledAt;

    expect(openerNow).toBe("2026-08-15T16:30:00.000Z");
    // The whole day hangs off the opener, so half an hour late here is half an
    // hour late everywhere after it.
    expect(Date.parse(laterNow as string) - Date.parse(laterWas as string)).toBe(30 * 60_000);
  });

  it("leaves the other days where they are", async () => {
    const { eventId } = await boardEvent(8, "double_elim", {
      format: { days: 2, concurrentLobbies: 2 },
    });
    const applied = await applySchedule(
      eventId,
      ["2026-08-15T16:00:00.000Z", "2026-08-16T16:00:00.000Z"],
      db
    );
    expect(applied.ok).toBe(true);

    const before = await formatFor(eventId, db);
    const dayTwo = before?.blocks.find((block) => block.day === 2)?.slots[0] as string;
    const dayTwoWas = before?.stages[0].matches.find((m) => m.slot === dayTwo)?.scheduledAt;
    const opener = before?.blocks[0].slots[0] as string;

    const ids = await matchIdsFor(eventId, db);
    await setMatchSchedule(ids[opener], "2026-08-15T18:00:00.000Z", db);

    const after = await formatFor(eventId, db);
    expect(after?.stages[0].matches.find((m) => m.slot === dayTwo)?.scheduledAt).toBe(dayTwoWas);
  });

  it("unschedules a match when given nothing", async () => {
    const { eventId } = await boardEvent(4);
    await applySchedule(eventId, ["2026-08-15T16:00:00.000Z"], db);
    const ids = await matchIdsFor(eventId, db);

    const cleared = await setMatchSchedule(ids.gf, null, db);
    expect(cleared.ok).toBe(true);
    // The re-flow puts the grand final back where the day says it belongs — the
    // start of a match nobody has played is a plan, not a fact.
    const [row] = await db.select().from(matches).where(eq(matches.id, ids.gf));
    expect(row.scheduledAt).not.toBeNull();
  });

  it("refuses a start that is not a time, and a match that is not there", async () => {
    const { eventId } = await boardEvent(4);
    const ids = await matchIdsFor(eventId, db);

    const bad = await setMatchSchedule(ids.gf, "not a date", db);
    expect(bad).toEqual({ ok: false, error: "That start time is not a time." });

    const missing = await setMatchSchedule(
      "00000000-0000-0000-0000-000000000000",
      "2026-08-15T16:00:00.000Z",
      db
    );
    expect(missing).toEqual({ ok: false, error: "That match no longer exists." });
  });

  it("keeps a played match's start, so its duration stays honest", async () => {
    const { eventId } = await boardEvent(4);
    await applySchedule(eventId, ["2026-08-15T16:00:00.000Z"], db);
    const ids = await matchIdsFor(eventId, db);

    // Play the first semi, then say it actually kicked off twenty minutes late.
    await recordGames(
      ids.ubsf1,
      [
        { index: 0, scoreA: 1, scoreB: 0, played: true },
        { index: 1, scoreA: 1, scoreB: 0, played: true },
      ],
      {},
      db
    );
    const moved = await setMatchSchedule(ids.ubsf1, "2026-08-15T16:20:00.000Z", db);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    // A finished match keeps the slot it ran in — the re-flow anchors off the
    // day's first *unplayed* match, and does not drag a result around.
    expect(moved.data.scheduledAt).toBe("2026-08-15T16:20:00.000Z");
  });
});
