/**
 * Who picks the side, and who picks the map (docs/platform-plan.md §8.4).
 *
 * The rule: for every game of a match one team chooses which side to play
 * first — attack or defence — and the other team chooses the map. A coin
 * decides who starts with the side choice, and the two roles **swap every
 * game** through the series.
 *
 * ## What these tests are actually protecting
 *
 * Not the arithmetic, which is a parity check on the game index and could be
 * read off the source. What they protect is the decision *not to store the
 * assignment per game*. One value lives on the match and everything else is
 * derived, exactly as a bracket slot's teams are (§1.1, §8.5) and a team's
 * remaining balance is. A per-game column would be a second copy, and the
 * failure mode of a second copy is not that it is wrong on the day it is
 * written — it is that a Bo3 re-generated at Bo5, or a game inserted, or a coin
 * corrected, leaves game 3 disagreeing with game 1 and nobody able to say which
 * of the two is the record.
 *
 * So the shape of this file is: the derivation, then the *stability* of the
 * derivation across reads and across a series being played out, then the two
 * refusals that stop a coin moving under a game that has already been played.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, events, matchGames, matches, teams } from "@/db";
import { type TestDatabase, freshDatabase } from "@/db/__tests__/helpers";
import { generateStage } from "@/lib/bracket";
import {
  MATCH_SLOTS,
  type MatchSlot,
  PLAY_SIDES,
  isMatchSlot,
  isPlaySide,
  mapChooserFor,
  normaliseMatchSlot,
  normalisePlaySide,
  otherSlot,
  sideChooserFor,
  tossForFirstSideChoice,
} from "@/lib/format-policy";
import { resolveMatches } from "@/lib/format-resolve";
import {
  formatFor,
  generateMatches,
  recordGames,
  reflipMatch,
  setStages,
} from "@/lib/format";
import { blankRecords, makeTeams } from "./format-helpers";

/* ------------------------------------------------------------------ */
/* The vocabulary                                                     */
/* ------------------------------------------------------------------ */

describe("the two slots and the two sides", () => {
  it("names the two halves of a match the way the row does", () => {
    expect([...MATCH_SLOTS]).toEqual(["a", "b"]);
    expect(isMatchSlot("a")).toBe(true);
    expect(isMatchSlot("b")).toBe(true);
    expect(isMatchSlot("c")).toBe(false);
    expect(isMatchSlot(0)).toBe(false);
  });

  it("swaps a slot for the other one, and back", () => {
    expect(otherSlot("a")).toBe("b");
    expect(otherSlot("b")).toBe("a");
    expect(otherSlot(otherSlot("a"))).toBe("a");
  });

  it("reads anything unrecognised as slot a rather than leaving a hole", () => {
    // Every reader derives from this value, so `null` would mean a branch in
    // the resolver, in the card and in the results tab. There is no such thing
    // as a match with nobody holding the choice.
    for (const junk of [null, undefined, "", "A", "left", 1, {}]) {
      expect(normaliseMatchSlot(junk)).toBe("a");
    }
    expect(normaliseMatchSlot("b")).toBe("b");
  });

  it("keeps a recorded side and drops anything else, because it is only a note", () => {
    expect([...PLAY_SIDES]).toEqual(["attack", "defence"]);
    expect(isPlaySide("attack")).toBe(true);
    expect(isPlaySide("defense")).toBe(false);
    expect(normalisePlaySide("defence")).toBe("defence");
    // Null, not "attack": who *holds* the choice is never missing, but whether
    // anybody wrote down which way it went is up to whoever filled the card in.
    for (const junk of [null, undefined, "", "offence", 3]) {
      expect(normalisePlaySide(junk)).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ */
/* The derivation                                                     */
/* ------------------------------------------------------------------ */

describe("sideChooserFor", () => {
  it("gives game 1 to whoever the coin named", () => {
    expect(sideChooserFor("a", 0)).toBe("a");
    expect(sideChooserFor("b", 0)).toBe("b");
  });

  it("swaps every game of a Bo3 — the worked example in §8.4", () => {
    // "if the coin gives team A the side choice in game 1, then B chooses the
    // side in game 2 and A in game 3"
    expect([0, 1, 2].map((i) => sideChooserFor("a", i))).toEqual(["a", "b", "a"]);
    expect([0, 1, 2].map((i) => sideChooserFor("b", i))).toEqual(["b", "a", "b"]);
  });

  it("keeps swapping through a Bo5 and a Bo7", () => {
    expect([0, 1, 2, 3, 4].map((i) => sideChooserFor("a", i))).toEqual([
      "a",
      "b",
      "a",
      "b",
      "a",
    ]);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => sideChooserFor("b", i))).toEqual([
      "b",
      "a",
      "b",
      "a",
      "b",
      "a",
      "b",
    ]);
  });

  it("works for a Bo1 exactly as for a longer series — one coin, one game", () => {
    for (const coin of MATCH_SLOTS) {
      expect(sideChooserFor(coin, 0)).toBe(coin);
      expect(mapChooserFor(coin, 0)).toBe(otherSlot(coin));
    }
  });

  it("never lets the same team pick both, at any index and either way up", () => {
    for (const coin of MATCH_SLOTS) {
      for (let index = 0; index < 32; index += 1) {
        const side = sideChooserFor(coin, index);
        const map = mapChooserFor(coin, index);
        expect(map).not.toBe(side);
        expect(map).toBe(otherSlot(side));
      }
    }
  });

  it("holds the two coins as exact mirrors of each other", () => {
    for (let index = 0; index < 16; index += 1) {
      expect(sideChooserFor("a", index)).toBe(otherSlot(sideChooserFor("b", index)));
    }
  });

  it("is a pure function of the coin and the index, so a re-read cannot drift", () => {
    const once = [0, 1, 2, 3, 4].map((i) => sideChooserFor("b", i));
    const twice = [0, 1, 2, 3, 4].map((i) => sideChooserFor("b", i));
    expect(twice).toEqual(once);
  });

  it("tolerates a nonsense coin and a nonsense index rather than throwing", () => {
    expect(sideChooserFor("wobble", 0)).toBe("a");
    expect(sideChooserFor("a", Number.NaN)).toBe("a");
    expect(sideChooserFor("a", 1.7)).toBe("b");
    expect(sideChooserFor("a", -1)).toBe("b");
  });
});

describe("tossForFirstSideChoice", () => {
  it("is a fair coin, pinned so a test can say which way it landed", () => {
    expect(tossForFirstSideChoice(() => 0)).toBe("a");
    expect(tossForFirstSideChoice(() => 0.4999)).toBe("a");
    expect(tossForFirstSideChoice(() => 0.5)).toBe("b");
    expect(tossForFirstSideChoice(() => 0.9999)).toBe("b");
  });

  it("reaches both answers when it is left to itself", () => {
    const seen = new Set<MatchSlot>();
    for (let i = 0; i < 500; i += 1) seen.add(tossForFirstSideChoice());
    expect([...seen].sort()).toEqual(["a", "b"]);
  });
});

/* ------------------------------------------------------------------ */
/* On a resolved board                                                */
/* ------------------------------------------------------------------ */

describe("the choice on a resolved match", () => {
  const stage = generateStage("double_elim", 4, { bestOf: 3, bestOfBySlot: { gf: 5 } });

  function boardWith(coin: MatchSlot) {
    const records = blankRecords(stage).map((record) => ({ ...record, firstSideChoice: coin }));
    return resolveMatches({ stage, matches: records, teams: makeTeams(4) });
  }

  it("carries one entry per game of the series, however long it is", () => {
    const board = boardWith("a");
    for (const match of board) {
      expect(match.choices).toHaveLength(match.bestOf);
      expect(match.choices.map((choice) => choice.index)).toEqual(
        Array.from({ length: match.bestOf }, (_, i) => i)
      );
    }
    expect(board.find((m) => m.slot === "gf")?.choices).toHaveLength(5);
  });

  it("names real teams once the slot has resolved, and the other team for the map", () => {
    const first = boardWith("a").find((match) => match.slot === "ubsf1");
    expect(first).toBeDefined();
    expect(first?.choices[0].sideName).toBe(first?.nameA);
    expect(first?.choices[0].mapName).toBe(first?.nameB);
    expect(first?.choices[1].sideName).toBe(first?.nameB);
    expect(first?.choices[1].mapName).toBe(first?.nameA);
  });

  it("prints the source's placeholder while the slot is still waiting", () => {
    // The rule is settled the moment the coin is tossed; only the names are
    // pending, so "Upper final winner picks the side" is the honest line and
    // "TBD picks the side" is not.
    const final = boardWith("a").find((match) => match.slot === "gf");
    expect(final?.choices[0].sideTeamId).toBeNull();
    expect(final?.choices[0].mapTeamId).toBeNull();
    // Slot a of the grand final is the upper bracket's survivor.
    expect(final?.choices[0].sideName).toBe("Upper final winner");
    expect(final?.choices[0].mapName).toBe("Lower final winner");
    // And it swaps in game 2 exactly as a resolved one does.
    expect(final?.choices[1].sideName).toBe("Lower final winner");
  });

  it("hands the side to the other slot when the coin went the other way", () => {
    const a = boardWith("a").find((match) => match.slot === "ubsf1");
    const b = boardWith("b").find((match) => match.slot === "ubsf1");
    expect(a?.choices.map((c) => c.sideSlot)).toEqual(["a", "b", "a"]);
    expect(b?.choices.map((c) => c.sideSlot)).toEqual(["b", "a", "b"]);
    expect(b?.choices.map((c) => c.mapSlot)).toEqual(["a", "b", "a"]);
  });

  it("is the same answer on every read of the same records", () => {
    const records = blankRecords(stage).map((record) => ({
      ...record,
      firstSideChoice: "b" as MatchSlot,
    }));
    const input = { stage, matches: records, teams: makeTeams(4) };
    const once = resolveMatches(input);
    const twice = resolveMatches(input);
    expect(twice.map((m) => m.choices.map((c) => c.sideSlot))).toEqual(
      once.map((m) => m.choices.map((c) => c.sideSlot))
    );
  });

  it("does not move when the results around it change", () => {
    // The point of deriving rather than storing: playing the bracket out
    // re-resolves every team in it, and the assignment must not follow.
    const records = blankRecords(stage).map((record) => ({
      ...record,
      firstSideChoice: "a" as MatchSlot,
    }));
    const before = resolveMatches({ stage, matches: records, teams: makeTeams(4) });

    const semi = records.find((record) => record.slot === "ubsf1");
    if (!semi) throw new Error("no ubsf1");
    semi.games[0].scoreA = 1;
    semi.games[0].played = true;
    semi.games[1].scoreA = 1;
    semi.games[1].played = true;

    const after = resolveMatches({ stage, matches: records, teams: makeTeams(4) });
    for (const match of after) {
      const was = before.find((m) => m.slot === match.slot);
      expect(match.choices.map((c) => c.sideSlot)).toEqual(was?.choices.map((c) => c.sideSlot));
      expect(match.choices.map((c) => c.mapSlot)).toEqual(was?.choices.map((c) => c.mapSlot));
    }
  });

  it("surfaces the side a team actually took, when somebody wrote it down", () => {
    const records = blankRecords(stage).map((record) => ({
      ...record,
      firstSideChoice: "a" as MatchSlot,
    }));
    const semi = records.find((record) => record.slot === "ubsf1");
    if (!semi) throw new Error("no ubsf1");
    semi.games[0].sideChosen = "defence";

    const match = resolveMatches({ stage, matches: records, teams: makeTeams(4) }).find(
      (m) => m.slot === "ubsf1"
    );
    expect(match?.choices[0].sideChosen).toBe("defence");
    // Unrecorded everywhere else, and the rule is untouched by that.
    expect(match?.choices[1].sideChosen).toBeNull();
    expect(match?.choices[1].sideSlot).toBe("b");
  });
});

/* ------------------------------------------------------------------ */
/* Against real Postgres                                              */
/* ------------------------------------------------------------------ */

describe("the coin in the database", () => {
  let ctx: TestDatabase;
  let db: Database;
  let counter = 0;

  beforeAll(async () => {
    ctx = await freshDatabase();
    db = ctx.db;
  });

  afterAll(async () => {
    await ctx.close();
  });

  /** A four-team double elimination, generated. */
  async function board() {
    counter += 1;
    const [event] = await db
      .insert(events)
      .values({ slug: `coin-${counter}`, title: `Coin ${counter}` })
      .returning({ id: events.id });
    for (let i = 1; i <= 4; i += 1) {
      await db.insert(teams).values({ eventId: event.id, name: `Team ${i}`, seed: i, sort: i });
    }
    const stages = await setStages(event.id, [{ kind: "double_elim", name: "Playoffs" }], db);
    if (!stages.ok) throw new Error(stages.error);
    const created = await generateMatches(stages.data[0].id, db);
    if (!created.ok) throw new Error(created.error);
    return { eventId: event.id, stageId: stages.data[0].id };
  }

  async function rowFor(eventId: string, slot: string) {
    const rows = await db.select().from(matches).where(eq(matches.eventId, eventId));
    const row = rows.find((m) => m.slot === slot);
    if (!row) throw new Error(`no match ${slot}`);
    return row;
  }

  it("tosses a coin for every match it generates", async () => {
    const { eventId } = await board();
    const rows = await db.select().from(matches).where(eq(matches.eventId, eventId));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(["a", "b"]).toContain(row.firstSideChoice);
  });

  it("reaches both answers across enough matches to be a coin and not a constant", async () => {
    const seen = new Set<string>();
    for (let attempt = 0; attempt < 4 && seen.size < 2; attempt += 1) {
      const { eventId } = await board();
      const rows = await db.select().from(matches).where(eq(matches.eventId, eventId));
      for (const row of rows) seen.add(row.firstSideChoice);
    }
    expect([...seen].sort()).toEqual(["a", "b"]);
  });

  it("hands the same assignment back on every read", async () => {
    const { eventId } = await board();
    const first = await formatFor(eventId, db);
    const second = await formatFor(eventId, db);
    const slots = (view: Awaited<ReturnType<typeof formatFor>>) =>
      view?.stages.flatMap((stage) =>
        stage.matches.map((match) => [match.slot, match.choices.map((c) => c.sideSlot).join("")])
      );
    expect(second && slots(second)).toEqual(first && slots(first));
    // And it is the derivation, not a coincidence of two identical reads.
    const row = await rowFor(eventId, "ubf");
    const match = first?.stages[0].matches.find((m) => m.slot === "ubf");
    expect(match?.firstSideChoice).toBe(row.firstSideChoice);
    expect(match?.choices[0].sideSlot).toBe(row.firstSideChoice);
    expect(match?.choices[1].sideSlot).toBe(otherSlot(row.firstSideChoice as MatchSlot));
  });

  it("sets the coin outright when a slot is named — the toss called wrongly", async () => {
    const { eventId } = await board();
    const before = await rowFor(eventId, "ubsf1");
    const wanted = otherSlot(before.firstSideChoice as MatchSlot);

    const result = await reflipMatch(before.id, wanted, db);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.firstSideChoice).toBe(wanted);
    expect((await rowFor(eventId, "ubsf1")).firstSideChoice).toBe(wanted);
  });

  it("tosses again when no slot is named, and lands on one of the two", async () => {
    const { eventId } = await board();
    const row = await rowFor(eventId, "ubsf1");
    for (let i = 0; i < 8; i += 1) {
      const result = await reflipMatch(row.id, null, db);
      expect(result.ok).toBe(true);
      if (result.ok) expect(["a", "b"]).toContain(result.data.firstSideChoice);
    }
  });

  it("refuses a slot that is not a slot", async () => {
    const { eventId } = await board();
    const row = await rowFor(eventId, "ubsf1");
    const result = await reflipMatch(row.id, "c" as MatchSlot, db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/one of the two teams/i);
    expect((await rowFor(eventId, "ubsf1")).firstSideChoice).toBe(row.firstSideChoice);
  });

  it("refuses a match that no longer exists", async () => {
    const result = await reflipMatch("00000000-0000-0000-0000-000000000000", null, db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no longer exists/i);
  });

  it("refuses once a game of the series has been played, and leaves the coin alone", async () => {
    const { eventId } = await board();
    const row = await rowFor(eventId, "ubsf1");
    const before = row.firstSideChoice;

    const recorded = await recordGames(row.id, [{ index: 0, scoreA: 3, scoreB: 1, played: true }], {}, db);
    expect(recorded.ok).toBe(true);

    for (const slot of [null, otherSlot(before as MatchSlot)]) {
      const result = await reflipMatch(row.id, slot, db);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/already been played/i);
    }
    expect((await rowFor(eventId, "ubsf1")).firstSideChoice).toBe(before);
  });

  it("allows it again once the series is cleared back to an unplayed card", async () => {
    const { eventId } = await board();
    const row = await rowFor(eventId, "ubsf1");
    await recordGames(row.id, [{ index: 0, scoreA: 3, scoreB: 1, played: true }], {}, db);
    expect((await reflipMatch(row.id, "a", db)).ok).toBe(false);

    await recordGames(row.id, [{ index: 0, scoreA: 0, scoreB: 0, played: false }], {}, db);
    expect((await reflipMatch(row.id, "a", db)).ok).toBe(true);
    expect((await rowFor(eventId, "ubsf1")).firstSideChoice).toBe("a");
  });

  it("refuses on a finished event, and the coin is still there afterwards", async () => {
    // The standing rule, applied to a value that is not a result but is what a
    // result was played *under*: changing it rewrites the record of which team
    // was entitled to pick the map of a game already on the board.
    const { eventId } = await board();
    const row = await rowFor(eventId, "ubsf1");
    await db.update(events).set({ status: "complete" }).where(eq(events.id, eventId));

    const result = await reflipMatch(row.id, otherSlot(row.firstSideChoice as MatchSlot), db);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/finished/i);
      expect(result.error).toMatch(/coin tosses cannot be re-flipped/i);
    }
    expect((await rowFor(eventId, "ubsf1")).firstSideChoice).toBe(row.firstSideChoice);

    // And the lock is a lock, not a trap: one legal status change and it works.
    await db.update(events).set({ status: "live" }).where(eq(events.id, eventId));
    expect((await reflipMatch(row.id, null, db)).ok).toBe(true);
  });

  it("records which side was taken, and keeps it out of the rule", async () => {
    const { eventId } = await board();
    const row = await rowFor(eventId, "ubsf1");

    const saved = await recordGames(
      row.id,
      [
        { index: 0, sideChosen: "defence", scoreA: 3, scoreB: 1, played: true },
        { index: 1, sideChosen: "attack" },
      ],
      {},
      db
    );
    expect(saved.ok).toBe(true);

    const games = await db.select().from(matchGames).where(eq(matchGames.matchId, row.id));
    const byIndex = new Map(games.map((game) => [game.index, game]));
    expect(byIndex.get(0)?.sideChosen).toBe("defence");
    expect(byIndex.get(1)?.sideChosen).toBe("attack");
    expect(byIndex.get(2)?.sideChosen).toBeNull();

    const view = await formatFor(eventId, db);
    const match = view?.stages[0].matches.find((m) => m.slot === "ubsf1");
    if (!match) throw new Error("no ubsf1 on the board");
    expect(match.choices[0].sideChosen).toBe("defence");
    // The note has not moved the rule: game 2 still belongs to the other slot.
    expect(match.choices[0].sideSlot).toBe(match.firstSideChoice);
    expect(match.choices[1].sideSlot).toBe(otherSlot(match.firstSideChoice));
  });

  it("drops a side that is not a side rather than storing it", async () => {
    const { eventId } = await board();
    const row = await rowFor(eventId, "ubsf2");
    await recordGames(row.id, [{ index: 0, sideChosen: "offence" }], {}, db);
    const games = await db.select().from(matchGames).where(eq(matchGames.matchId, row.id));
    expect(games.find((game) => game.index === 0)?.sideChosen).toBeNull();
  });
});
