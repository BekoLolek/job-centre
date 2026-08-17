import { describe, expect, it } from "vitest";
import { generateStage } from "@/lib/bracket";
import {
  type MatchRecord,
  type ResolvedMatch,
  type TeamRef,
  StageResolution,
  blankGamesFor,
  isMatchDecided,
  placementsFor,
  resolveMatches,
  seedsFor,
  standingsFor,
} from "@/lib/format-resolve";
import { blankRecords, drawSeries, makeTeams, playStage, winSeries } from "./format-helpers";

const TEAMS = makeTeams(4);
const IDS = TEAMS.map((t) => t.id);

function bracketState(over: { seeds?: Array<string | null> | null } = {}) {
  const stage = generateStage("double_elim", 4);
  const matches = blankRecords(stage);
  const seeds = over.seeds === undefined ? IDS : over.seeds;
  return {
    stage,
    matches,
    input: { stage, matches, teams: TEAMS, seeds },
    at: (slot: string) => {
      const record = matches.find((m) => m.slot === slot);
      if (!record) throw new Error(`no record ${slot}`);
      return record;
    },
  };
}

function tableState() {
  const stage = generateStage("round_robin", 4);
  const matches = blankRecords(stage);
  // A table stage stores its pairings directly, as the generator writes them.
  for (const record of matches) {
    const [, a, b] = record.slot.split("-");
    record.teamAId = IDS[Number(a) - 1];
    record.teamBId = IDS[Number(b) - 1];
  }
  const play = (slot: string, scoreA: number, scoreB: number) => {
    const record = matches.find((m) => m.slot === slot);
    if (!record) throw new Error(`no record ${slot}`);
    record.games[0].scoreA = scoreA;
    record.games[0].scoreB = scoreB;
    record.games[0].played = true;
  };
  return { stage, matches, input: { stage, matches, teams: TEAMS }, play };
}

const byId = (matches: ResolvedMatch[], slot: string): ResolvedMatch => {
  const match = matches.find((m) => m.slot === slot);
  if (!match) throw new Error(`no resolved match ${slot}`);
  return match;
};

describe("isMatchDecided", () => {
  const bo3 = (games: Array<[number, number]>, override: string | null = null): MatchRecord => ({
    slot: "x",
    bestOf: 3,
    teamAId: null,
    teamBId: null,
    sourceA: null,
    sourceB: null,
    scheduledAt: null,
    finishedAt: null,
    durationMin: null,
    winnerOverrideId: override,
    games: blankGamesFor({ modes: ["a", "b", "c"] }).map((game, i) => ({
      ...game,
      scoreA: games[i]?.[0] ?? 0,
      scoreB: games[i]?.[1] ?? 0,
      played: games[i] !== undefined,
    })),
  });

  it("is false while a series is still open", () => {
    expect(isMatchDecided(bo3([]))).toBe(false);
    expect(isMatchDecided(bo3([[1, 0]]))).toBe(false);
  });

  it("is true once a side is out of reach", () => {
    expect(
      isMatchDecided(
        bo3([
          [1, 0],
          [1, 0],
        ])
      )
    ).toBe(true);
  });

  it("is true when every game is played, even drawn", () => {
    expect(
      isMatchDecided(
        bo3([
          [1, 0],
          [0, 1],
          [2, 2],
        ])
      )
    ).toBe(true);
  });

  it("is true as soon as an override is set, with nothing played", () => {
    expect(isMatchDecided(bo3([], "t1"))).toBe(true);
  });

  it("is not vacuously true for a series with no games at all", () => {
    expect(isMatchDecided({ bestOf: 3, games: [], winnerOverrideId: null })).toBe(false);
  });
});

describe("resolveMatches", () => {
  it("shows where each slot comes from while it is unresolved", () => {
    const { stage, matches } = bracketState({ seeds: null });
    const resolved = resolveMatches({ stage, matches, teams: [], seeds: null });
    const sources = (slot: string) => [byId(resolved, slot).nameA, byId(resolved, slot).nameB];

    expect(sources("ubsf1")).toEqual(["Seed 1", "Seed 4"]);
    expect(sources("ubsf2")).toEqual(["Seed 2", "Seed 3"]);
    expect(sources("ubf")).toEqual(["Upper semi 1 winner", "Upper semi 2 winner"]);
    expect(sources("lbr1")).toEqual(["Upper semi 1 loser", "Upper semi 2 loser"]);
    expect(sources("lbf")).toEqual(["Upper final loser", "Lower round 1 winner"]);
    expect(sources("gf")).toEqual(["Upper final winner", "Lower final winner"]);
  });

  it("names a group source by its group and rank", () => {
    const stage = generateStage("group_playoff", 8, { groups: 2, advancePerGroup: 2 });
    const resolved = resolveMatches({ stage, matches: blankRecords(stage), teams: [] });
    expect(byId(resolved, "sf1").nameA).toBe("Group A #1");
    expect(byId(resolved, "sf1").nameB).toBe("Group B #2");
  });

  it("says TBD for a source it cannot read at all", () => {
    const { stage, matches } = bracketState();
    matches.find((m) => m.slot === "ubsf1")!.sourceA = "nonsense";
    const resolved = resolveMatches({ stage, matches, teams: TEAMS, seeds: IDS });
    expect(byId(resolved, "ubsf1").nameA).toBe("TBD");
  });

  it("fills the opening round from the seeds", () => {
    const { input } = bracketState();
    const resolved = resolveMatches(input);
    expect(byId(resolved, "ubsf1")).toMatchObject({ teamAId: "t1", teamBId: "t4" });
    expect(byId(resolved, "ubsf2")).toMatchObject({ teamAId: "t2", teamBId: "t3" });
    expect(byId(resolved, "ubsf1").nameA).toBe("Team 1");
  });

  it("moves winners up and losers down as results land", () => {
    const { input, at } = bracketState();
    winSeries(at("ubsf1"), "a"); // t1 beats t4
    winSeries(at("ubsf2"), "b"); // t3 beats t2
    const resolved = resolveMatches(input);
    expect(byId(resolved, "ubsf1")).toMatchObject({ winner: "t1", loser: "t4", status: "done" });
    expect(byId(resolved, "ubf")).toMatchObject({ teamAId: "t1", teamBId: "t3" });
    expect(byId(resolved, "lbr1")).toMatchObject({ teamAId: "t4", teamBId: "t2" });
    expect(byId(resolved, "lbf").nameA).toBe("Upper final loser");
  });

  it("counts games won per side and reports a live series", () => {
    const { input, at } = bracketState();
    at("ubsf1").games[0].scoreA = 1;
    at("ubsf1").games[0].played = true;
    at("ubsf1").games[1].scoreB = 3;
    at("ubsf1").games[1].played = true;
    const match = byId(resolveMatches(input), "ubsf1");
    expect([match.gamesWonA, match.gamesWonB]).toEqual([1, 1]);
    expect(match.status).toBe("live");
    expect(match.winner).toBeNull();
  });

  it("does not count a drawn map as a game win for anyone", () => {
    const { input, at } = bracketState();
    at("ubsf1").games[0].scoreA = 2;
    at("ubsf1").games[0].scoreB = 2;
    at("ubsf1").games[0].played = true;
    const match = byId(resolveMatches(input), "ubsf1");
    expect([match.gamesWonA, match.gamesWonB]).toEqual([0, 0]);
  });

  it("stalls a drawn elimination series and asks the admin to decide", () => {
    const { input, at } = bracketState();
    drawSeries(at("ubsf1"));
    const resolved = resolveMatches(input);
    const semi = byId(resolved, "ubsf1");
    expect(semi.needsDecision).toBe(true);
    expect(semi.winner).toBeNull();
    expect(semi.status).toBe("live"); // not "done" — nobody advances yet
    expect(byId(resolved, "ubf").teamAId).toBeNull();
    expect(byId(resolved, "ubf").nameA).toBe("Upper semi 1 winner");
  });

  it("never asks for a decision on a slot whose teams are still unknown", () => {
    // Played before the seeding exists, which is what a stage waiting on the
    // one before it looks like.
    const { stage, matches, at } = bracketState({ seeds: [null, null, null, null] });
    drawSeries(at("ubsf1"));
    const resolved = resolveMatches({ stage, matches, teams: TEAMS, seeds: [null, null, null, null] });
    expect(byId(resolved, "ubsf1").needsDecision).toBe(false);
  });

  it("resolves a drawn series through the admin's override", () => {
    const { input, at } = bracketState();
    drawSeries(at("ubsf1"));
    at("ubsf1").winnerOverrideId = "t4";
    const resolved = resolveMatches(input);
    expect(byId(resolved, "ubsf1")).toMatchObject({
      winner: "t4",
      loser: "t1",
      status: "done",
      needsDecision: false,
    });
    expect(byId(resolved, "ubf").teamAId).toBe("t4");
    expect(byId(resolved, "lbr1").teamAId).toBe("t1");
  });

  it("lets an override beat the games themselves", () => {
    const { input, at } = bracketState();
    winSeries(at("ubsf1"), "a");
    at("ubsf1").winnerOverrideId = "t4";
    expect(byId(resolveMatches(input), "ubsf1").winner).toBe("t4");
  });

  it("ignores an override naming somebody who is not in the match", () => {
    const { input, at } = bracketState();
    winSeries(at("ubsf1"), "a");
    at("ubsf1").winnerOverrideId = "t3";
    expect(byId(resolveMatches(input), "ubsf1").winner).toBe("t1");
  });

  it("re-propagates the whole bracket when an old score is corrected", () => {
    const { input, at } = bracketState();
    winSeries(at("ubsf1"), "a");
    winSeries(at("ubsf2"), "a");
    winSeries(at("ubf"), "a");
    expect(byId(resolveMatches(input), "ubf")).toMatchObject({ teamAId: "t1", winner: "t1" });

    // The semi was recorded the wrong way round.
    at("ubsf1").games.forEach((game) => {
      game.scoreA = 0;
      game.scoreB = 0;
      game.played = false;
    });
    winSeries(at("ubsf1"), "b");
    const after = resolveMatches(input);
    expect(byId(after, "ubf").teamAId).toBe("t4");
    expect(byId(after, "lbr1").teamAId).toBe("t1");
  });

  it("survives two slots pointing at each other", () => {
    const { stage, matches } = bracketState();
    matches.find((m) => m.slot === "ubf")!.sourceA = "winner:gf";
    expect(() => resolveMatches({ stage, matches, teams: TEAMS, seeds: IDS })).not.toThrow();
  });

  it("returns one entry per generated slot, in board order", () => {
    const { stage, input } = bracketState();
    expect(resolveMatches(input).map((m) => m.slot)).toEqual(stage.matches.map((m) => m.slot));
  });

  it("does not mutate the stored matches while resolving", () => {
    const { input, at } = bracketState();
    resolveMatches(input);
    expect(at("ubf").teamAId).toBeNull();
  });

  it("resolves a stage with no stored rows at all, as a preview", () => {
    const stage = generateStage("single_elim", 6);
    const resolved = resolveMatches({ stage, matches: [], teams: makeTeams(6), seeds: null });
    expect(resolved).toHaveLength(stage.matches.length);
    expect(resolved.every((m) => m.status === "pending")).toBe(true);
  });
});

describe("standings", () => {
  it("gives a row per team before anything is played", () => {
    const { input } = tableState();
    const rows = standingsFor(input);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.played === 0 && r.points === 0 && r.diff === 0)).toBe(true);
  });

  it("awards 3 for a win, 1 each for a draw and 0 for a loss", () => {
    const { input, play } = tableState();
    play("rr-1-2", 3, 1);
    play("rr-3-4", 2, 2);
    const rows = standingsFor(input);
    expect(rows.find((r) => r.id === "t1")).toMatchObject({
      played: 1,
      won: 1,
      scoreFor: 3,
      scoreAgainst: 1,
      diff: 2,
      points: 3,
    });
    expect(rows.find((r) => r.id === "t2")).toMatchObject({ lost: 1, points: 0 });
    expect(rows.find((r) => r.id === "t3")).toMatchObject({ drawn: 1, points: 1 });
  });

  it("takes the points rule from config", () => {
    const stage = generateStage("round_robin", 4, { points: { win: 2, draw: 0, loss: 0 } });
    const matches = blankRecords(stage);
    const first = matches[0];
    first.teamAId = "t1";
    first.teamBId = "t2";
    first.games[0].scoreA = 1;
    first.games[0].played = true;
    const rows = standingsFor({ stage, matches, teams: TEAMS });
    expect(rows.find((r) => r.id === "t1")?.points).toBe(2);
  });

  it("ignores a game that has been typed in but not ticked off", () => {
    const { input, matches } = tableState();
    matches[0].games[0].scoreA = 5;
    expect(standingsFor(input).every((r) => r.played === 0)).toBe(true);
  });

  it("ignores elimination series entirely", () => {
    const { input, at } = bracketState();
    winSeries(at("ubsf1"), "a");
    expect(standingsFor(input).every((r) => r.played === 0)).toBe(true);
  });

  it("breaks a two-way tie on the mini-league, ahead of map difference", () => {
    const { input, play } = tableState();
    // t1 and t2 finish level on 6; t1 has the far better difference but lost
    // the head-to-head.
    play("rr-1-2", 0, 1);
    play("rr-3-4", 1, 0);
    play("rr-1-3", 5, 0);
    play("rr-2-4", 0, 1);
    play("rr-1-4", 5, 0);
    play("rr-2-3", 1, 0);
    const rows = standingsFor(input);
    expect(rows.map((r) => r.id)).toEqual(["t2", "t1", "t3", "t4"]);
    expect(rows[0].points).toBe(rows[1].points);
    expect(rows[0].diff).toBeLessThan(rows[1].diff);
  });

  it("falls through to map difference when the mini-league is level", () => {
    const { input, play } = tableState();
    play("rr-1-2", 1, 1);
    play("rr-1-3", 3, 0);
    play("rr-1-4", 0, 1);
    play("rr-2-3", 0, 1);
    play("rr-2-4", 1, 0);
    play("rr-3-4", 0, 2);
    expect(standingsFor(input).map((r) => r.id)).toEqual(["t4", "t1", "t2", "t3"]);
  });

  it("obeys a configured tiebreaker order", () => {
    const stage = generateStage("round_robin", 4, { tiebreakers: ["diff"] });
    const matches = blankRecords(stage);
    const play = (slot: string, a: number, b: number) => {
      const record = matches.find((m) => m.slot === slot);
      if (!record) throw new Error(slot);
      const [, x, y] = slot.split("-");
      record.teamAId = IDS[Number(x) - 1];
      record.teamBId = IDS[Number(y) - 1];
      record.games[0].scoreA = a;
      record.games[0].scoreB = b;
      record.games[0].played = true;
    };
    play("rr-1-2", 0, 1);
    play("rr-3-4", 1, 0);
    play("rr-1-3", 5, 0);
    play("rr-2-4", 0, 1);
    play("rr-1-4", 5, 0);
    play("rr-2-3", 1, 0);
    // Without the mini-league, t1's +9 beats t2's +1.
    expect(standingsFor({ stage, matches, teams: TEAMS }).map((r) => r.id)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
  });

  it("sorts by name when nothing else separates two rows", () => {
    const named: TeamRef[] = [
      { id: "t1", name: "Zulu", seed: 1 },
      { id: "t2", name: "Yankee", seed: 2 },
      { id: "t3", name: "Bravo", seed: 3 },
      { id: "t4", name: "Alpha", seed: 4 },
    ];
    const stage = generateStage("round_robin", 4);
    expect(standingsFor({ stage, matches: [], teams: named }).map((r) => r.id)).toEqual([
      "t4",
      "t3",
      "t2",
      "t1",
    ]);
  });

  it("keeps a team with no games in the table", () => {
    const { input, play } = tableState();
    play("rr-1-2", 1, 0);
    expect(standingsFor(input).map((r) => r.id).sort()).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("skips a match pointing at a team that no longer exists", () => {
    const { input, matches, play } = tableState();
    play("rr-1-2", 1, 0);
    matches[0].teamBId = "ghost";
    expect(standingsFor(input).every((r) => r.played === 0)).toBe(true);
  });

  it("aggregates a best-of-three table game across its maps", () => {
    const stage = generateStage("round_robin", 4, { bestOf: 3 });
    const matches = blankRecords(stage);
    const first = matches.find((m) => m.slot === "rr-1-2");
    if (!first) throw new Error("no rr-1-2");
    first.teamAId = "t1";
    first.teamBId = "t2";
    first.games[0].scoreA = 3;
    first.games[0].scoreB = 1;
    first.games[0].played = true;
    first.games[1].scoreA = 2;
    first.games[1].scoreB = 4;
    first.games[1].played = true;
    first.games[2].scoreA = 5;
    first.games[2].scoreB = 0;
    first.games[2].played = true;

    const rows = standingsFor({ stage, matches, teams: TEAMS });
    expect(rows.find((r) => r.id === "t1")).toMatchObject({
      played: 1,
      won: 1,
      gamesWon: 2,
      gamesLost: 1,
      scoreFor: 10,
      scoreAgainst: 5,
    });
  });

  it("keeps a group's table to that group", () => {
    const stage = generateStage("group_playoff", 8, { groups: 2, advancePerGroup: 2 });
    const teams = makeTeams(8);
    const input = { stage, matches: blankRecords(stage), teams, seeds: teams.map((t) => t.id) };
    expect(standingsFor(input, "a").map((r) => r.id)).toEqual(["t1", "t4", "t5", "t8"]);
    expect(standingsFor(input, "b").map((r) => r.id)).toEqual(["t2", "t3", "t6", "t7"]);
  });
});

describe("seeding the next stage", () => {
  it("is null until every table game is in", () => {
    const { input, play } = tableState();
    expect(seedsFor(input)).toBeNull();
    play("rr-1-2", 1, 0);
    expect(seedsFor(input)).toBeNull();
  });

  it("is the standings order once the table is complete", () => {
    const { input, play } = tableState();
    play("rr-1-2", 0, 1);
    play("rr-3-4", 1, 0);
    play("rr-1-3", 5, 0);
    play("rr-2-4", 0, 1);
    play("rr-1-4", 5, 0);
    play("rr-2-3", 1, 0);
    expect(seedsFor(input)).toEqual(["t2", "t1", "t3", "t4"]);
  });

  it("counts a drawn map as played", () => {
    const { input, matches } = tableState();
    for (const record of matches) {
      record.games[0].scoreA = 1;
      record.games[0].scoreB = 1;
      record.games[0].played = true;
    }
    expect(seedsFor(input)).not.toBeNull();
  });

  it("is a bracket's finishing order once it is over", () => {
    const stage = generateStage("double_elim", 4);
    const played = playStage(stage);
    expect(played.resolution.seeding()).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("is null while a bracket is still being played", () => {
    const { input, at } = bracketState();
    winSeries(at("ubsf1"), "a");
    expect(seedsFor(input)).toBeNull();
  });

  it("refuses to seed a bracket from a group that is still running", () => {
    const stage = generateStage("group_playoff", 8, { groups: 2, advancePerGroup: 2 });
    const teams = makeTeams(8);
    const matches = blankRecords(stage);
    const first = matches.find((m) => m.slot.startsWith("ga-"));
    if (!first) throw new Error("no group A match");
    first.games[0].scoreA = 1;
    first.games[0].played = true;
    const resolved = resolveMatches({ stage, matches, teams, seeds: teams.map((t) => t.id) });
    expect(byId(resolved, "sf1").teamAId).toBeNull();
    expect(byId(resolved, "sf1").nameA).toBe("Group A #1");
  });

  it("seeds the playoff from the group tables once they are done", () => {
    const stage = generateStage("group_playoff", 8, { groups: 2, advancePerGroup: 2 });
    const played = playStage(stage);
    // The better seed wins every group game, so A is 1,4,5,8 in that order.
    const sf1 = byId(played.matches, "sf1");
    expect(sf1.teamAId).toBe("t1");
    expect(sf1.teamBId).toBe("t3");
    expect(played.resolution.champion()).toBe("t1");
  });
});

describe("placements", () => {
  it("is empty before the bracket has been played", () => {
    const { input } = bracketState();
    expect(placementsFor(input)).toEqual([]);
  });

  it("reads the podium off the last three matches", () => {
    const stage = generateStage("double_elim", 4);
    const played = playStage(stage);
    expect(played.resolution.placements()).toEqual([
      { position: 1, shared: 1, teamId: "t1" },
      { position: 2, shared: 1, teamId: "t2" },
      { position: 3, shared: 1, teamId: "t3" },
      { position: 4, shared: 1, teamId: "t4" },
    ]);
  });

  it("names the champion only once there is one", () => {
    const { input, at } = bracketState();
    expect(new StageResolution(input).champion()).toBeNull();
    winSeries(at("ubsf1"), "a");
    expect(new StageResolution(input).champion()).toBeNull();
  });
});

describe("bracket reset", () => {
  function reset() {
    const stage = generateStage("double_elim", 4, { bracketReset: true });
    const matches = blankRecords(stage);
    const at = (slot: string) => {
      const record = matches.find((m) => m.slot === slot);
      if (!record) throw new Error(slot);
      return record;
    };
    // t1 through the upper bracket, t2 up from the lower.
    winSeries(at("ubsf1"), "a"); // t1 beats t4
    winSeries(at("ubsf2"), "a"); // t2 beats t3
    winSeries(at("ubf"), "a"); // t1 beats t2
    winSeries(at("lbr1"), "a"); // t4 beats t3
    winSeries(at("lbf"), "a"); // t2 beats t4
    return { stage, matches, at, input: { stage, matches, teams: TEAMS, seeds: IDS } };
  }

  it("is void when the upper-bracket side wins the grand final", () => {
    const { input, at } = reset();
    winSeries(at("gf"), "a"); // t1, straight from the upper bracket
    const resolved = resolveMatches(input);
    expect(byId(resolved, "gf2").status).toBe("void");
    expect(byId(resolved, "gf2").skipped).toBe(true);
    expect(new StageResolution(input).champion()).toBe("t1");
  });

  it("is played when the lower-bracket side wins the grand final", () => {
    const { input, at } = reset();
    winSeries(at("gf"), "b"); // t2, up from the lower bracket
    const pending = resolveMatches(input);
    expect(byId(pending, "gf2").status).toBe("pending");
    expect(byId(pending, "gf2").teamAId).toBe("t2");
    expect(byId(pending, "gf2").teamBId).toBe("t1");

    winSeries(at("gf2"), "a");
    expect(new StageResolution(input).champion()).toBe("t2");
  });

  it("hands the runner-up spot to the reset when it is played", () => {
    const { input, at } = reset();
    winSeries(at("gf"), "b");
    winSeries(at("gf2"), "b"); // t1 wins the rematch after all
    const placements = new StageResolution(input).placements();
    expect(placements.slice(0, 2)).toEqual([
      { position: 1, shared: 1, teamId: "t1" },
      { position: 2, shared: 1, teamId: "t2" },
    ]);
  });

  it("waits rather than voiding while the grand final is unresolved", () => {
    const { input } = reset();
    expect(byId(resolveMatches(input), "gf2").status).toBe("pending");
  });
});

describe("seeding fallbacks", () => {
  it("uses the teams' own seed column when no order is given", () => {
    const stage = generateStage("single_elim", 4);
    const shuffled = [...TEAMS].reverse();
    const resolved = resolveMatches({ stage, matches: blankRecords(stage), teams: shuffled });
    expect(byId(resolved, "sf1").teamAId).toBe("t1");
    expect(byId(resolved, "sf1").teamBId).toBe("t4");
  });

  it("falls back to the order the teams arrived in", () => {
    const stage = generateStage("single_elim", 4);
    const unseeded: TeamRef[] = TEAMS.map((team) => ({ id: team.id, name: team.name }));
    const resolved = resolveMatches({ stage, matches: blankRecords(stage), teams: unseeded });
    expect(byId(resolved, "sf1").teamAId).toBe("t1");
  });

  it("leaves a slot empty when its seed is not settled", () => {
    const stage = generateStage("single_elim", 4);
    const resolved = resolveMatches({
      stage,
      matches: blankRecords(stage),
      teams: TEAMS,
      seeds: ["t1", null, null, null],
    });
    expect(byId(resolved, "sf1").teamAId).toBe("t1");
    expect(byId(resolved, "sf1").teamBId).toBeNull();
    expect(byId(resolved, "sf1").nameB).toBe("Seed 4");
  });
});
