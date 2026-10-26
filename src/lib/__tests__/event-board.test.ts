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
  eventRoundScores,
  events,
  teamMembers,
  teams,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  getEventBoard,
  playerBookFor,
  podiumFor,
  resultLine,
  teamNames,
} from "@/lib/event-board";
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
    // A bracket's placement is a team, and says so.
    const winner = podium[0].subject;
    expect(winner.kind).toBe("team");
    if (winner.kind !== "team") throw new Error("a bracket placed a player");
    expect(teamNames(board).get(winner.teamId)).toBe("Team 1");
    // The one-line result belongs to the round-scored night; a bracket's
    // podium already says who won in its tiles (UC-46 4 against §6.2).
    expect(resultLine(board)).toBeNull();
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

/* ------------------------------------------------------------------ */
/* A night scored in rounds (decision 006; UC-46 4, 4a; R-234)         */
/* ------------------------------------------------------------------ */

/**
 * The stored setup, as `saveRoundScoring` writes it: a sibling of
 * `config.format`, never inside it (Task 87).
 */
function roundScored(rounds: number, over: { lowWins?: boolean } = {}): EventConfig {
  return {
    eventShape: { teamEvent: false, draft: false, sizing: { mode: "perTeam", value: 6 } },
    roundScoring: {
      rounds: Array.from({ length: rounds }, (_, index) => ({
        name: index === rounds - 1 ? "Final" : null,
      })),
      lowWins: over.lowWins ?? false,
      bonuses: [{ key: "Gold run", value: 5 }],
    },
  };
}

type Scored = { name: string; rounds: Array<number | null>; bonuses?: Record<string, number> };

/**
 * Row ids in insertion order. `listRoundScores` orders a round's rows by id,
 * which is a random uuid in the site; here it is this counter, so "the order
 * the rows arrived in" is a fact the tests can arrange rather than a toss.
 */
let rowSeq = 0;
function nextRowId(): string {
  rowSeq += 1;
  return `00000000-0000-4000-8000-${String(rowSeq).padStart(12, "0")}`;
}

/**
 * A round-scored night with these players' rows written straight in — one row
 * per scored round, none for a blank, which is what decision 006 makes the only
 * representation of "did not play".
 */
async function scoredNight(
  config: EventConfig,
  players: Scored[]
): Promise<{ eventId: string; ids: Record<string, string> }> {
  const eventId = await makeEvent(config);
  const ids: Record<string, string> = {};
  for (const player of players) {
    const userId = await makeUser(db, { displayName: player.name });
    ids[player.name] = userId;
    const rows = player.rounds.flatMap((score, index) =>
      score === null
        ? []
        : [
            {
              id: nextRowId(),
              eventId,
              roundIndex: index + 1,
              userId,
              score,
              bonuses: player.bonuses ?? {},
            },
          ]
    );
    if (rows.length > 0) await db.insert(eventRoundScores).values(rows);
  }
  return { eventId, ids };
}

describe("getEventBoard — a night scored in rounds", () => {
  it("keeps the results tab shut while nothing has been scored", async () => {
    // The direction that would put an empty tab on every round-scored night
    // the moment its Scoring panel was saved.
    const { eventId } = await scoredNight(roundScored(3), []);
    const board = await getEventBoard(eventId, {}, db);

    expect(board.rounds).not.toBeNull();
    expect(board.rounds?.rows).toEqual([]);
    expect(board.has.results).toBe(false);
    expect(board.has.bracket).toBe(false);
  });

  it("opens the results tab once a round has a score in it", async () => {
    // The direction that would hide a scored night however well it was scored.
    const { eventId } = await scoredNight(roundScored(3), [{ name: "Ada", rounds: [10, null, null] }]);
    const board = await getEventBoard(eventId, {}, db);

    expect(board.has.results).toBe(true);
    expect(board.has.bracket).toBe(false);
    expect(board.has.teams).toBe(false);
    expect(board.rounds?.ranks).toEqual([{ userId: board.rounds?.ranks[0].userId, position: 1, total: 10 }]);
  });

  it("says how many of the night's rounds hold a score", async () => {
    const { eventId } = await scoredNight(roundScored(4), [
      { name: "Ada", rounds: [10, 8, null, null] },
      { name: "Bo", rounds: [9, null, null, null] },
    ]);
    const board = await getEventBoard(eventId, {}, db);

    expect(board.rounds?.scored).toBe(2);
    expect(board.rounds?.scoring.rounds).toHaveLength(4);
  });

  it("leaves a solo night that is not scored in rounds exactly as it was", async () => {
    const eventId = await makeEvent({
      eventShape: { teamEvent: false, draft: false, sizing: { mode: "perTeam", value: 6 } },
    });
    const board = await getEventBoard(eventId, {}, db);

    expect(board.rounds).toBeNull();
    expect(board.has.results).toBe(false);
    expect(podiumFor(board)).toEqual([]);
    expect(resultLine(board)).toBeNull();
  });

  it("names every scored player in the player book, as it names a roster", async () => {
    const { eventId, ids } = await scoredNight(roundScored(2), [
      { name: "Ada Lovelace", rounds: [10, 10] },
    ]);
    const board = await getEventBoard(eventId, {}, db);

    expect(board.players[ids["Ada Lovelace"]]?.displayName).toBe("Ada Lovelace");
  });
});

describe("podiumFor — a night scored in rounds", () => {
  it("places the players from the table, best total first, with their names", async () => {
    const { eventId, ids } = await scoredNight(roundScored(2), [
      { name: "Second", rounds: [10, 5] },
      { name: "First", rounds: [9, 9] },
      { name: "Third", rounds: [1, 1] },
    ]);
    const board = await getEventBoard(eventId, {}, db);

    expect(podiumFor(board)).toEqual([
      { position: 1, shared: 1, name: "First", subject: { kind: "player", userId: ids.First } },
      { position: 2, shared: 1, name: "Second", subject: { kind: "player", userId: ids.Second } },
      { position: 3, shared: 1, name: "Third", subject: { kind: "player", userId: ids.Third } },
    ]);
  });

  it("shares a place between equal totals, skips the next, and orders a tie by name", async () => {
    // Inserted Zed before Amy, so an order inherited from the rows (Task 88's
    // trap: a round's rows sit in uuid order) would be a coin toss here.
    const { eventId } = await scoredNight(roundScored(1), [
      { name: "Zed", rounds: [10] },
      { name: "Amy", rounds: [10] },
      { name: "Kim", rounds: [3] },
    ]);
    const board = await getEventBoard(eventId, {}, db);

    expect(podiumFor(board).map(({ position, shared, name }) => ({ position, shared, name }))).toEqual([
      { position: 1, shared: 2, name: "Amy" },
      { position: 1, shared: 2, name: "Zed" },
      { position: 3, shared: 1, name: "Kim" },
    ]);
  });

  it("is empty while nothing has been scored", async () => {
    const { eventId } = await scoredNight(roundScored(2), []);
    expect(podiumFor(await getEventBoard(eventId, {}, db))).toEqual([]);
  });

  it("takes the table over the bracket for a round-scored event — the table is the authority", async () => {
    // Not a configuration the screens offer, but decision 006 names one
    // authority for a round-scored event and this is where that is decided.
    const { eventId, ids } = await scoredNight(roundScored(1), [{ name: "Solo", rounds: [7] }]);
    await makeTeams(eventId, 4);
    const created = await setStages(eventId, [{ kind: "single_elim" }], db);
    if (!created.ok) throw new Error(created.error);
    const generated = await generateMatches(created.data[0].id, db);
    if (!generated.ok) throw new Error(generated.error);
    await win(eventId, "sf1", "a");
    await win(eventId, "sf2", "a");
    await win(eventId, "f", "a");

    const podium = podiumFor(await getEventBoard(eventId, {}, db));
    expect(podium).toEqual([
      { position: 1, shared: 1, name: "Solo", subject: { kind: "player", userId: ids.Solo } },
    ]);

    // And "only" means only: with the table emptied, the bracket does not
    // step in as a fallback. Nothing scored is nothing placed.
    await db.delete(eventRoundScores).where(eq(eventRoundScores.eventId, eventId));
    expect(podiumFor(await getEventBoard(eventId, {}, db))).toEqual([]);
  });
});

describe("resultLine — the one-line result of a round-scored night", () => {
  it("names the winner once every round is scored", async () => {
    const { eventId } = await scoredNight(roundScored(2), [
      { name: "Ada", rounds: [10, 10] },
      { name: "Bo", rounds: [1, 1] },
    ]);
    expect(resultLine(await getEventBoard(eventId, {}, db))).toBe("Won by Ada.");
  });

  it("names both winners of a shared first place on the one line", async () => {
    const { eventId } = await scoredNight(roundScored(1), [
      { name: "Bo", rounds: [10] },
      { name: "Ada", rounds: [10] },
      { name: "Cy", rounds: [2] },
    ]);
    expect(resultLine(await getEventBoard(eventId, {}, db))).toBe("Ada and Bo share first place.");
  });

  it("lists three or more sharers in words", async () => {
    const { eventId } = await scoredNight(roundScored(1), [
      { name: "Cy", rounds: [10] },
      { name: "Bo", rounds: [10] },
      { name: "Ada", rounds: [10] },
    ]);
    expect(resultLine(await getEventBoard(eventId, {}, db))).toBe(
      "Ada, Bo and Cy share first place."
    );
  });

  it("says who leads, and how many rounds are in, while the night is part-scored", async () => {
    // UC-46 3a's table-as-it-stands, in a sentence: a half-scored night has a
    // leader, not a winner, and the sentence says which it is reporting.
    const { eventId } = await scoredNight(roundScored(3), [
      { name: "Ada", rounds: [10, null, null] },
      { name: "Bo", rounds: [4, null, null] },
    ]);
    expect(resultLine(await getEventBoard(eventId, {}, db))).toBe("Ada leads after 1 of 3 rounds.");
  });

  it("shares the lead in the same words", async () => {
    const { eventId } = await scoredNight(roundScored(2), [
      { name: "Ada", rounds: [10, null] },
      { name: "Bo", rounds: [10, null] },
    ]);
    expect(resultLine(await getEventBoard(eventId, {}, db))).toBe(
      "Ada and Bo share the lead after 1 of 2 rounds."
    );
  });

  it("has nothing to say while nothing is scored", async () => {
    const { eventId } = await scoredNight(roundScored(2), []);
    expect(resultLine(await getEventBoard(eventId, {}, db))).toBeNull();
  });
});
