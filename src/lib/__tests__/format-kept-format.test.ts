/**
 * The kept format features, as rules (Section H, Task 34).
 *
 * Four of UC-18's extension flows, each of them read by the gap audit and never
 * walked:
 *
 *  - **E1** (R-152) — a mode per map of a series length, shown on the match.
 *  - **E2** (R-154) — a series length for one bracket or one match, winning
 *    over the stage and round lengths.
 *  - **E3** (R-155) — a round robin played twice, home and away.
 *  - **E5** (R-160) — team seeds, with the bracket paired by them.
 *
 * Pure throughout: the whole of E1, E2 and E3 is `format-policy` and `bracket`,
 * and E5 is `format-resolve`'s seeding. What those answers do to stored rows is
 * `format-kept-results.test.ts`, which needs a database for it.
 */

import { describe, expect, it } from "vitest";
import { circleRounds, generateStage } from "@/lib/bracket";
import {
  type StageConfig,
  bestOfFor,
  modesFor,
  normaliseStageConfig,
} from "@/lib/format-policy";
import {
  type TeamRef,
  blankGamesFor,
  resolveMatches,
  seedOrderFrom,
  seedingFrom,
  standingsFor,
} from "@/lib/format-resolve";
import { TEAM_COUNTS, blankRecords, makeTeams, winSeries } from "./format-helpers";

/* ------------------------------------------------------------------ */
/* UC-18 E1 — a mode per map of a series length (R-152)               */
/* ------------------------------------------------------------------ */

describe("a mode per map of a series length (UC-18 E1, R-152)", () => {
  const config = normaliseStageConfig("double_elim", {
    bestOf: 3,
    bestOfBySlot: { gf: 5 },
    modeSequence: {
      "3": ["convoy", "domination", "escort"],
      "5": ["escort", "escort", "convoy", "convoy", "domination"],
    },
  });

  it("gives every map of a Bo3 the mode set for that position", () => {
    // The order is the point: "Bo3: convoy, convoy, domination" is a sequence,
    // so a set-comparison would pass on any shuffle of it.
    expect(modesFor(config, 3)).toEqual(["convoy", "domination", "escort"]);
  });

  it("keeps the sequences of two series lengths apart in one stage", () => {
    /*
     * The flow's own example is a Bo3, but a stage with a longer grand final
     * plays two lengths at once — and `modeSequence` is keyed by length for
     * exactly that reason. A per-stage list could not say both.
     */
    const stage = generateStage("double_elim", 4, config);

    expect([stage.bySlot.ubsf1.bestOf, stage.bySlot.ubsf1.modes]).toEqual([
      3,
      ["convoy", "domination", "escort"],
    ]);
    expect([stage.bySlot.gf.bestOf, stage.bySlot.gf.modes]).toEqual([
      5,
      ["escort", "escort", "convoy", "convoy", "domination"],
    ]);
  });

  it("shows each map's mode on the match, game by game", () => {
    /*
     * "System shows each map's mode on the match" — so the modes have to reach
     * the resolved board, which is what every screen reads, and the card rows
     * have to carry one each rather than the match carrying a list the games
     * know nothing about.
     */
    const stage = generateStage("double_elim", 4, config);
    const resolved = resolveMatches({
      stage,
      matches: blankRecords(stage),
      teams: makeTeams(4),
      seeds: null,
    });
    const final = resolved.find((match) => match.slot === "gf");

    expect(final?.modes).toEqual(["escort", "escort", "convoy", "convoy", "domination"]);
    expect(final?.games.map((game) => [game.index, game.mode])).toEqual([
      [0, "escort"],
      [1, "escort"],
      [2, "convoy"],
      [3, "convoy"],
      [4, "domination"],
    ]);
  });

  it("takes a mode name the game owns, rather than a fixed pair", () => {
    // Modes belong to the games catalogue, so adding one must not be a
    // migration or an enum — the whole reason `modeSequence` holds strings.
    const stage = generateStage("single_elim", 4, {
      bestOf: 3,
      modeSequence: { "3": ["Payload Escort", "  control  ", "hardpoint"] },
    });
    expect(stage.bySlot.sf1.modes).toEqual(["payload_escort", "control", "hardpoint"]);
  });

  it("is what a blank card is created from, so the plan is on the row", () => {
    const stage = generateStage("double_elim", 4, config);
    expect(blankGamesFor(stage.bySlot.ubsf1).map((game) => game.mode)).toEqual([
      "convoy",
      "domination",
      "escort",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-18 E2 — a length for one bracket or one match (R-154)           */
/* ------------------------------------------------------------------ */

describe("a series length for one bracket or one match (UC-18 E2, R-154)", () => {
  /** Every key set at once, so each assertion is a question about precedence. */
  const config: StageConfig = normaliseStageConfig("double_elim", {
    bestOf: 3,
    bestOfByBracket: { upper: 5, lower: 1 },
    bestOfByRound: { "1": 7, "2": 7 },
    bestOfBySlot: { gf: 1 },
  });

  it("gives a named match its own length, over everything else", () => {
    expect(bestOfFor(config, { slot: "gf", round: 1, bracket: "final" })).toBe(1);
  });

  it("gives a half its own length over a round number of the same match", () => {
    /*
     * The flow in as many words: *"manager sets a series length for one
     * bracket or one match — it wins over the stage and round lengths."*
     *
     * Round 1 is also set here, to 7, and the upper bracket's round 1 is the
     * match being asked about. The half wins, which is the opposite of what
     * `bestOfFor` used to answer.
     */
    expect(bestOfFor(config, { slot: "ubsf1", round: 1, bracket: "upper" })).toBe(5);
    expect(bestOfFor(config, { slot: "lbr1", round: 1, bracket: "lower" })).toBe(1);
  });

  it("falls to the round number only where no half is set", () => {
    // `bronze` has no entry, so the round is the next thing asked — the
    // fallback order is still slot, half, round, stage.
    expect(bestOfFor(config, { slot: "bronze", round: 2, bracket: "bronze" })).toBe(7);
  });

  it("falls to the stage default when nothing names the match", () => {
    expect(bestOfFor(config, { slot: "bronze", round: 9, bracket: "bronze" })).toBe(3);
  });

  it("keeps a group stage's table games Bo1 while the bracket's round 1 is Bo5", () => {
    /*
     * The case the precedence is *for*, and the one that was silently wrong.
     *
     * Round numbers restart in each half, so "round 1" is the first circle
     * round of every group **and** the opening tie of the playoff. A manager
     * lengthening the opening tie to Bo5 used to lengthen every group's first
     * round with it, straight through the `bestOfByBracket: { rr: 1 }` that a
     * group stage carries by default to keep table games Bo1.
     */
    const stage = generateStage("group_playoff", 4, {
      groups: 2,
      bestOf: 3,
      bestOfByRound: { "1": 5 },
    });

    const table = stage.matches.filter((match) => match.bracket === "rr");
    expect(table.map((match) => [match.slot, match.round, match.bestOf])).toEqual([
      ["ga-1-4", 1, 1],
      ["gb-2-3", 1, 1],
    ]);
    expect([stage.bySlot.sf1.bestOf, stage.bySlot.sf2.bestOf]).toEqual([5, 5]);
    // Round 2 of the bracket is untouched by either, so it is the stage default.
    expect(stage.bySlot.f.bestOf).toBe(3);
  });

  it("writes the series length onto the match, not onto a reader of it", () => {
    // `matches.best_of` is stored, and `seriesRefusal` and the card both read
    // the row — so the override has to land on the generated match.
    const stage = generateStage("double_elim", 4, {
      bestOf: 1,
      // Cleared, because a double elimination carries `{ gf: 5 }` by default
      // and a named match beats a half — which the first case here asserts.
      bestOfBySlot: {},
      bestOfByBracket: { final: 7 },
    });
    expect(stage.bySlot.gf.bestOf).toBe(7);
    expect(stage.bySlot.gf.modes).toHaveLength(7);
    expect(stage.bySlot.ubsf1.bestOf).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* UC-18 E3 — a round robin played twice (R-155)                      */
/* ------------------------------------------------------------------ */

describe("a round robin played twice (UC-18 E3, R-155)", () => {
  /** Each pairing as "low-high", so the two legs of a pair read the same. */
  const pairing = (match: { sourceA: string; sourceB: string }): string => {
    const [a, b] = [match.sourceA, match.sourceB].map((ref) => Number(ref.split(":")[1]));
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  };

  it("generates every pair exactly twice at every team count", () => {
    for (const n of TEAM_COUNTS) {
      const stage = generateStage("round_robin", n, { doubleRound: true });
      const counts = new Map<string, number>();
      for (const match of stage.matches) {
        const key = pairing(match);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      expect([...counts.keys()], `${n} teams`).toHaveLength((n * (n - 1)) / 2);
      expect([...new Set(counts.values())], `${n} teams`).toEqual([2]);
    }
  });

  it("swaps who is listed first in the return leg — home and away", () => {
    /*
     * "every pair meets home and away". With no home ground the only thing
     * that can mean is which team the board lists first, so the second leg has
     * to be the first one reversed rather than a second copy of it.
     */
    const stage = generateStage("round_robin", 4, { doubleRound: true });
    const first = stage.matches.filter((match) => match.slot.startsWith("rr-"));
    const second = stage.matches.filter((match) => match.slot.startsWith("rr2-"));

    expect(first.map((match) => [match.sourceA, match.sourceB])).toEqual([
      ["seed:1", "seed:2"],
      ["seed:3", "seed:4"],
      ["seed:1", "seed:3"],
      ["seed:2", "seed:4"],
      ["seed:1", "seed:4"],
      ["seed:2", "seed:3"],
    ]);
    expect(second.map((match) => [match.sourceA, match.sourceB])).toEqual([
      ["seed:2", "seed:1"],
      ["seed:4", "seed:3"],
      ["seed:3", "seed:1"],
      ["seed:4", "seed:2"],
      ["seed:4", "seed:1"],
      ["seed:3", "seed:2"],
    ]);
  });

  it("gives the second leg its own slots, rounds and phases", () => {
    /*
     * Three separate consequences of one decision, and all three are load
     * bearing: a repeated slot would collide with its own row, a repeated
     * round would put a pair in one circle round twice, and a repeated phase
     * would let `planBlocks` schedule both legs of a pair in one block.
     */
    const stage = generateStage("round_robin", 4, { doubleRound: true });
    const single = generateStage("round_robin", 4);

    expect(new Set(stage.matches.map((match) => match.slot)).size).toBe(12);
    expect([...new Set(stage.matches.map((match) => match.round))]).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...new Set(stage.matches.map((match) => match.phase))]).toEqual([1, 2, 3, 4, 5, 6]);
    // The first leg is exactly the single-leg stage, so switching the setting
    // on adds rounds rather than re-planning the ones already there.
    expect(stage.matches.slice(0, single.matches.length).map((match) => match.slot)).toEqual(
      single.matches.map((match) => match.slot)
    );
  });

  it("is the circle rotation twice over, so nobody plays twice in a round", () => {
    for (const n of TEAM_COUNTS) {
      const stage = generateStage("round_robin", n, { doubleRound: true });
      const legs = circleRounds(Array.from({ length: n }, (_unused, i) => i + 1)).length;
      expect(Math.max(...stage.matches.map((match) => match.round)), `${n} teams`).toBe(legs * 2);
      for (const round of new Set(stage.matches.map((match) => match.round))) {
        const sides = stage.matches
          .filter((match) => match.round === round)
          .flatMap((match) => [match.sourceA, match.sourceB]);
        expect(new Set(sides).size, `${n} teams, round ${round}`).toBe(sides.length);
      }
    }
  });

  it("counts both legs in the table, so a pair can go one each", () => {
    /*
     * The reason the flow exists: a double round robin is a table over twice
     * as many games. If the standings only saw one leg a team could win the
     * return match and gain nothing.
     */
    const teams = makeTeams(4);
    const stage = generateStage("round_robin", 4, { doubleRound: true, bestOf: 1 });
    const records = blankRecords(stage);

    const home = records.find((row) => row.slot === "rr-1-2");
    const away = records.find((row) => row.slot === "rr2-2-1");
    if (!home || !away) throw new Error("no 1 v 2 both ways");
    // Seed 1 is side A at home and side B away, and wins both times.
    winSeries(home, "a");
    winSeries(away, "b");

    const table = standingsFor({ stage, matches: records, teams, seeds: teams.map((t) => t.id) });
    const top = table.find((row) => row.id === "t1");
    const other = table.find((row) => row.id === "t2");

    expect([top?.played, top?.won, top?.points]).toEqual([2, 2, 6]);
    expect([other?.played, other?.lost, other?.points]).toEqual([2, 2, 0]);
  });

  it("doubles a group stage's groups too, and not its bracket", () => {
    const stage = generateStage("group_playoff", 4, { groups: 2, doubleRound: true });
    const table = stage.matches.filter((match) => match.bracket === "rr");
    expect(table.map((match) => [match.slot, match.group, match.round])).toEqual([
      ["ga-1-4", "a", 1],
      ["ga2-4-1", "a", 2],
      ["gb-2-3", "b", 1],
      ["gb2-3-2", "b", 2],
    ]);
    expect(stage.matches.filter((match) => match.bracket !== "rr").map((m) => m.slot)).toEqual([
      "sf1",
      "sf2",
      "f",
      "bronze",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-18 E5 — team seeds (R-160)                                      */
/* ------------------------------------------------------------------ */

describe("team seeds (UC-18 E5, R-160)", () => {
  /** Four teams in list order, with whatever seeds the case is about. */
  const list = (seeds: Array<number | null>): TeamRef[] =>
    seeds.map((seed, index) => ({ id: `t${index + 1}`, name: `Team ${index + 1}`, seed }));

  it("pairs the bracket by seed rather than by the order teams were added", () => {
    // Reverse-seeded, so list order and seed order disagree about every slot.
    const teams = list([4, 3, 2, 1]);
    const stage = generateStage("single_elim", 4);
    const resolved = resolveMatches({ stage, matches: blankRecords(stage), teams });

    expect(seedingFrom({ stage, matches: [], teams })).toEqual(["t4", "t3", "t2", "t1"]);
    // Seed 1 v seed 4 is the standard opening pair, so t4 meets t1.
    const opener = resolved.find((match) => match.slot === "sf1");
    expect([opener?.teamAId, opener?.teamBId]).toEqual(["t4", "t1"]);
  });

  it("obeys the seeds that are set when the rest of the list is blank", () => {
    /*
     * `teams.seed` is nullable and nothing makes a manager fill it in, so this
     * is a reachable state — and it used to throw *every* seed away and pair
     * by list order, with nothing on any screen to say the two numbers had
     * been ignored. "System pairs by seed", silently not done.
     *
     * Team 3 is seeded top and team 1 second; the two unseeded teams keep
     * their list order behind them.
     */
    const teams = list([2, null, 1, null]);
    expect(seedOrderFrom(teams)).toEqual(["t3", "t1", "t2", "t4"]);

    const stage = generateStage("single_elim", 4);
    const resolved = resolveMatches({ stage, matches: blankRecords(stage), teams });
    const opener = resolved.find((match) => match.slot === "sf1");
    expect([opener?.teamAId, opener?.teamBId]).toEqual(["t3", "t4"]);
  });

  it("keeps list order where two teams share a seed, and drops nobody", () => {
    // Nothing refuses a duplicate on the way in, so the answer has to be
    // stable rather than dependent on which read asked.
    const teams = list([1, 1, 3, 2]);
    expect(seedOrderFrom(teams)).toEqual(["t1", "t2", "t4", "t3"]);
    expect(seedOrderFrom(teams)).toHaveLength(teams.length);
  });

  it("falls back to list order only when nobody is seeded at all", () => {
    const teams = list([null, null, null, null]);
    expect(seedOrderFrom(teams)).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("lets a previous stage's finishing order beat the column (R-160)", () => {
    /*
     * A later stage seeds from the stage before it, not from the team list —
     * so an explicit order is handed in and the `seed` column must not
     * override it. The row of nulls is the same rule mid-tournament: a bracket
     * whose table has not finished shows "Seed 1", not a team.
     */
    const teams = list([1, 2, 3, 4]);
    const stage = generateStage("single_elim", 4);
    expect(seedingFrom({ stage, matches: [], teams, seeds: ["t4", "t3", "t2", "t1"] })).toEqual([
      "t4",
      "t3",
      "t2",
      "t1",
    ]);
    expect(
      seedingFrom({ stage, matches: [], teams, seeds: [null, null, null, null] })
    ).toEqual([null, null, null, null]);
  });
});
