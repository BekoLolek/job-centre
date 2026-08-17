/**
 * The public tournament surface's one read, against real Postgres.
 *
 * `src/lib/event-board.ts` is what `/events/[slug]` calls to decide which of
 * §6.2's tabs exist and what goes in them. Two things about it are worth
 * pinning down with a database behind them rather than a fixture:
 *
 *  1. **A tab appears only when it has content.** A Jackbox night shows none of
 *     these; an event whose bracket has been drawn but not played shows the
 *     bracket and not the results. Getting that wrong is how a public page ends
 *     up with an empty tab promising something.
 *  2. **The prices survive.** The whole point of the storage rewrite is that
 *     what a player went for is a permanent public fact, so a roster read back
 *     out of the database days later has to carry the same numbers the draft
 *     produced — including the captain's zero.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Database,
  type EventConfig,
  eventDays,
  events,
  teamMembers,
  teams,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { getEventBoard, playerBookFor, podiumFor, teamNames } from "@/lib/event-board";
import { generateMatches, recordGames, setStages } from "@/lib/format";
import { matches } from "@/db";
import { eq } from "drizzle-orm";

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
    .values({ slug: `board-${counter}`, title: `Board ${counter}`, config })
    .returning({ id: events.id });
  return row.id;
}

async function makeTeams(eventId: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const [row] = await db
      .insert(teams)
      .values({ eventId, name: `Team ${i}`, seed: i, sort: i, balanceStart: 1000 })
      .returning({ id: teams.id });
    ids.push(row.id);
  }
  return ids;
}

async function win(eventId: string, slot: string, side: "a" | "b") {
  const rows = await db.select().from(matches).where(eq(matches.eventId, eventId));
  const row = rows.find((match) => match.slot === slot);
  if (!row) throw new Error(`no match ${slot}`);
  const target = Math.floor(row.bestOf / 2) + 1;
  const result = await recordGames(
    row.id,
    Array.from({ length: target }, (_, index) => ({
      index,
      map: `Map ${index + 1}`,
      referee: "Zoe",
      scoreA: side === "a" ? 3 : 1,
      scoreB: side === "b" ? 3 : 1,
      played: true,
    })),
    {},
    db
  );
  if (!result.ok) throw new Error(result.error);
}

/* ------------------------------------------------------------------ */

describe("getEventBoard — which tabs exist", () => {
  it("shows none of the four for an event with nothing set up", async () => {
    const eventId = await makeEvent();
    const board = await getEventBoard(eventId, {}, db);

    expect(board.has).toEqual({
      teams: false,
      schedule: false,
      bracket: false,
      results: false,
    });
    expect(board.format).not.toBeNull();
    expect(board.matches).toEqual([]);
  });

  it("keeps the schedule tab for an event with days but no matches — a Jackbox night", async () => {
    const eventId = await makeEvent();
    await db.insert(eventDays).values({ eventId, dayIndex: 0, label: "Friday" });

    const board = await getEventBoard(eventId, { days: 1 }, db);
    expect(board.has.schedule).toBe(true);
    expect(board.has.bracket).toBe(false);
    expect(board.has.results).toBe(false);
  });

  it("opens the bracket tab as soon as matches exist, and results only once played", async () => {
    const eventId = await makeEvent();
    await makeTeams(eventId, 8);
    const created = await setStages(eventId, [{ kind: "double_elim" }], db);
    if (!created.ok) throw new Error(created.error);
    const generated = await generateMatches(created.data[0].id, db);
    if (!generated.ok) throw new Error(generated.error);

    const drawn = await getEventBoard(eventId, {}, db);
    expect(drawn.has.teams).toBe(true);
    expect(drawn.has.bracket).toBe(true);
    expect(drawn.has.results).toBe(false);
    // Fourteen matches is the whole eight-team double elimination.
    expect(drawn.matches).toHaveLength(14);

    await win(eventId, "ubqf1", "a");
    const played = await getEventBoard(eventId, {}, db);
    expect(played.has.results).toBe(true);
  });
});

describe("getEventBoard — rosters and prices", () => {
  it("carries every price back out, captain included at nothing", async () => {
    const eventId = await makeEvent();
    const [teamId] = await makeTeams(eventId, 2);
    const captain = await makeUser(db, { displayName: "Cap" });
    const player = await makeUser(db, { displayName: "Bought" });

    await db.update(teams).set({ captainUserId: captain }).where(eq(teams.id, teamId));
    await db.insert(teamMembers).values([
      { teamId, eventId, userId: captain, price: 0, isCaptain: true },
      { teamId, eventId, userId: player, price: 250, isCaptain: false },
    ]);

    const board = await getEventBoard(eventId, {}, db);
    const team = board.teams.find((row) => row.id === teamId);

    expect(team?.members.map((member) => member.price).sort()).toEqual([0, 250]);
    expect(team?.members.find((member) => member.isCaptain)?.price).toBe(0);
    expect(board.players[captain].displayName).toBe("Cap");
    expect(board.players[player].displayName).toBe("Bought");
  });

  it("names the captain even before anybody has been drafted onto the roster", async () => {
    const eventId = await makeEvent();
    const [teamId] = await makeTeams(eventId, 2);
    const captain = await makeUser(db, { displayName: "Early Cap" });
    await db.update(teams).set({ captainUserId: captain }).where(eq(teams.id, teamId));

    const board = await getEventBoard(eventId, {}, db);
    expect(board.players[captain]?.displayName).toBe("Early Cap");
  });

  it("hands back an empty book rather than querying for nobody", async () => {
    await expect(playerBookFor([], db)).resolves.toEqual({});
  });
});

describe("podiumFor", () => {
  it("is empty while the tournament is still being played", async () => {
    const eventId = await makeEvent();
    await makeTeams(eventId, 4);
    const created = await setStages(eventId, [{ kind: "single_elim" }], db);
    if (!created.ok) throw new Error(created.error);
    const generated = await generateMatches(created.data[0].id, db);
    if (!generated.ok) throw new Error(generated.error);

    const board = await getEventBoard(eventId, {}, db);
    expect(podiumFor(board)).toEqual([]);
  });

  it("names the champion once the final is in, with the team's own name", async () => {
    const eventId = await makeEvent();
    await makeTeams(eventId, 4);
    const created = await setStages(eventId, [{ kind: "single_elim" }], db);
    if (!created.ok) throw new Error(created.error);
    const generated = await generateMatches(created.data[0].id, db);
    if (!generated.ok) throw new Error(generated.error);

    await win(eventId, "sf1", "a");
    await win(eventId, "sf2", "a");
    await win(eventId, "f", "a");

    const board = await getEventBoard(eventId, {}, db);
    const podium = podiumFor(board);

    expect(podium[0].position).toBe(1);
    // Seed 1 beat seed 4 and then seed 2.
    expect(podium[0].name).toBe("Team 1");
    expect(podium.find((entry) => entry.position === 2)?.name).toBe("Team 2");
    expect(teamNames(board).get(podium[0].teamId)).toBe("Team 1");
  });

  it("takes the podium from the deciding stage, not from the group table before it", async () => {
    const eventId = await makeEvent();
    await makeTeams(eventId, 4);
    const created = await setStages(
      eventId,
      [{ kind: "round_robin", name: "Round robin" }, { kind: "single_elim", name: "Playoffs" }],
      db
    );
    if (!created.ok) throw new Error(created.error);
    for (const stage of created.data) {
      const generated = await generateMatches(stage.id, db);
      if (!generated.ok) throw new Error(generated.error);
    }

    // The round robin alone crowns nobody, so there is still no podium.
    for (const slot of ["rr-1-2", "rr-3-4", "rr-1-3", "rr-2-4", "rr-1-4", "rr-2-3"]) {
      await win(eventId, slot, "a");
    }
    const midway = await getEventBoard(eventId, {}, db);
    expect(podiumFor(midway)).toEqual([]);
    expect(midway.format?.stages).toHaveLength(2);
  });
});
