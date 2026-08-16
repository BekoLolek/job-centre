import { describe, expect, it } from "vitest";
import {
  POINTS,
  isMatchDecided,
  placementsFor,
  resolveMatches,
  seedTournament,
  seedsFor,
  standingsFor,
  toTournamentView,
} from "@/lib/tournament";
import type { DraftState, ResolvedMatch } from "@/lib/types";
import {
  RR_IDS,
  makeCaptains,
  makeState,
  matchIn,
  playFullRoundRobin,
  playRr,
  playSeries,
} from "./helpers";

const byId = (matches: ResolvedMatch[], id: string) => {
  const m = matches.find((x) => x.id === id);
  if (!m) throw new Error(`no resolved match ${id}`);
  return m;
};

const order = (state: DraftState) => standingsFor(state).map((r) => r.id);

describe("seedTournament", () => {
  it("creates six round-robin maps and six bracket slots", () => {
    const t = seedTournament();
    expect(t.matches.filter((m) => m.kind === "rr").map((m) => m.id)).toEqual([...RR_IDS]);
    expect(t.matches.filter((m) => m.kind === "bracket").map((m) => m.id)).toEqual([
      "ubsf1",
      "ubsf2",
      "ubf",
      "lbr1",
      "lbf",
      "gf",
    ]);
  });

  it("gives every captain three round-robin games, one per round", () => {
    const t = seedTournament();
    for (const id of ["c1", "c2", "c3", "c4"]) {
      const games = t.matches.filter(
        (m) => m.kind === "rr" && (m.teamA === id || m.teamB === id)
      );
      expect(games).toHaveLength(3);
      expect(games.map((m) => m.phase).sort()).toEqual([1, 2, 3]);
    }
  });

  it("starts with nothing scheduled, played or overridden", () => {
    const t = seedTournament();
    expect(t.seedOverride).toBeNull();
    expect(
      t.matches.every(
        (m) =>
          m.scheduledAt === null &&
          m.finishedAt === null &&
          m.durationMin === null &&
          m.winnerOverride === null &&
          m.games.every((g) => !g.played)
      )
    ).toBe(true);
  });

  it("makes the grand final a best-of-5 and everything else shorter", () => {
    const t = seedTournament();
    expect(t.matches.find((m) => m.id === "gf")?.bestOf).toBe(5);
    expect(t.matches.filter((m) => m.kind === "rr").every((m) => m.bestOf === 1)).toBe(true);
  });
});

describe("isMatchDecided", () => {
  it("is false while a series is still open", () => {
    const state = makeState();
    expect(isMatchDecided(matchIn(state, "ubsf1"))).toBe(false);
    playSeries(state, "ubsf1", [[1, 0]]);
    expect(isMatchDecided(matchIn(state, "ubsf1"))).toBe(false);
  });

  it("is true once a side is out of reach", () => {
    const state = makeState();
    playSeries(state, "ubsf1", [
      [1, 0],
      [1, 0],
    ]);
    expect(isMatchDecided(matchIn(state, "ubsf1"))).toBe(true);
  });

  it("is true when every game is played, even if it is drawn", () => {
    const state = makeState();
    playSeries(state, "ubsf1", [
      [1, 0],
      [0, 1],
      [2, 2],
    ]);
    expect(isMatchDecided(matchIn(state, "ubsf1"))).toBe(true);
  });

  it("is true as soon as an override is set, with no games played", () => {
    const state = makeState();
    matchIn(state, "ubsf1").winnerOverride = "c1";
    expect(isMatchDecided(matchIn(state, "ubsf1"))).toBe(true);
  });

  it("needs three maps of a best-of-5 to be settled", () => {
    const state = makeState();
    playSeries(state, "gf", [
      [1, 0],
      [1, 0],
    ]);
    expect(isMatchDecided(matchIn(state, "gf"))).toBe(false);
    playSeries(state, "gf", [
      [1, 0],
      [1, 0],
      [1, 0],
    ]);
    expect(isMatchDecided(matchIn(state, "gf"))).toBe(true);
  });
});

describe("standingsFor", () => {
  it("gives a row per captain even before anything is played", () => {
    const rows = standingsFor(makeState());
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.played === 0 && r.points === 0 && r.diff === 0)).toBe(true);
  });

  it("awards 3 for a win and 0 for a loss", () => {
    const state = makeState();
    playRr(state, "rr-c1-c2", 3, 1);
    const rows = standingsFor(state);
    expect(rows.find((r) => r.id === "c1")).toMatchObject({
      played: 1,
      won: 1,
      drawn: 0,
      lost: 0,
      scoreFor: 3,
      scoreAgainst: 1,
      diff: 2,
      points: POINTS.win,
    });
    expect(rows.find((r) => r.id === "c2")).toMatchObject({
      played: 1,
      won: 0,
      drawn: 0,
      lost: 1,
      scoreFor: 1,
      scoreAgainst: 3,
      diff: -2,
      points: POINTS.loss,
    });
  });

  it("awards 1 point each for a draw", () => {
    const state = makeState();
    playRr(state, "rr-c1-c2", 2, 2);
    const rows = standingsFor(state);
    for (const id of ["c1", "c2"]) {
      expect(rows.find((r) => r.id === id)).toMatchObject({
        played: 1,
        drawn: 1,
        won: 0,
        lost: 0,
        points: POINTS.draw,
      });
    }
  });

  it("ignores games that have not been played", () => {
    const state = makeState();
    matchIn(state, "rr-c1-c2").games[0].scoreA = 5; // typed in but not ticked off
    expect(standingsFor(state).every((r) => r.played === 0)).toBe(true);
  });

  it("ignores bracket series entirely", () => {
    const state = makeState();
    playSeries(state, "ubsf1", [
      [1, 0],
      [1, 0],
    ]);
    matchIn(state, "ubsf1").teamA = "c1";
    matchIn(state, "ubsf1").teamB = "c2";
    expect(standingsFor(state).every((r) => r.played === 0)).toBe(true);
  });

  it("accumulates across the whole round robin", () => {
    const state = makeState();
    playFullRoundRobin(state);
    const rows = standingsFor(state);
    expect(rows.find((r) => r.id === "c1")).toMatchObject({
      played: 3,
      won: 2,
      lost: 1,
      points: 6,
      scoreFor: 10,
      scoreAgainst: 1,
      diff: 9,
    });
    expect(rows.find((r) => r.id === "c2")).toMatchObject({ played: 3, points: 6, diff: 1 });
    expect(rows.reduce((sum, r) => sum + r.played, 0)).toBe(12);
  });

  it("breaks a two-way tie on the head-to-head, ahead of map difference", () => {
    const state = makeState();
    playFullRoundRobin(state);
    // c1 and c2 both finish on 6. c1 has a far better difference (+9 vs +1) but lost
    // the head-to-head, so the mini-league puts c2 first.
    expect(order(state)).toEqual(["c2", "c1", "c3", "c4"]);
    const rows = standingsFor(state);
    expect(rows[0].points).toBe(rows[1].points);
    expect(rows[0].diff).toBeLessThan(rows[1].diff);
  });

  it("falls through to map difference when the mini-league is level", () => {
    const state = makeState();
    playRr(state, "rr-c1-c2", 1, 1); // c1 and c2 split the head-to-head
    playRr(state, "rr-c1-c3", 3, 0);
    playRr(state, "rr-c1-c4", 0, 1);
    playRr(state, "rr-c2-c3", 0, 1);
    playRr(state, "rr-c2-c4", 1, 0);
    playRr(state, "rr-c3-c4", 0, 2);
    // c4 = 6, c1 = 4 (diff +2), c2 = 4 (diff 0), c3 = 3
    expect(order(state)).toEqual(["c4", "c1", "c2", "c3"]);
  });

  it("sorts by name when nothing else separates two rows", () => {
    const state = makeState({
      captains: makeCaptains({ c1: "Zulu", c2: "Yankee", c3: "Bravo", c4: "Alpha" }),
    });
    expect(order(state)).toEqual(["c4", "c3", "c2", "c1"]);
  });

  it("keeps a captain with no games in the table", () => {
    const state = makeState();
    playRr(state, "rr-c1-c2", 1, 0);
    const rows = standingsFor(state);
    expect(rows.map((r) => r.id).sort()).toEqual(["c1", "c2", "c3", "c4"]);
    expect(rows.find((r) => r.id === "c3")?.played).toBe(0);
  });

  it("skips a match pointing at a captain that no longer exists", () => {
    const state = makeState();
    matchIn(state, "rr-c1-c2").teamB = "ghost";
    playRr(state, "rr-c1-c2", 1, 0);
    expect(standingsFor(state).every((r) => r.played === 0)).toBe(true);
  });
});

describe("seedsFor", () => {
  it("is null until every round-robin map is played", () => {
    const state = makeState();
    expect(seedsFor(state)).toBeNull();
    for (const id of RR_IDS.slice(0, 5)) playRr(state, id, 1, 0);
    expect(seedsFor(state)).toBeNull();
  });

  it("is the standings order once the round robin is complete", () => {
    const state = makeState();
    playFullRoundRobin(state);
    expect(seedsFor(state)).toEqual(["c2", "c1", "c3", "c4"]);
  });

  it("lets an admin override win, even mid round robin", () => {
    const state = makeState();
    state.tournament.seedOverride = ["c4", "c3", "c2", "c1"];
    expect(seedsFor(state)).toEqual(["c4", "c3", "c2", "c1"]);
  });

  it("lets the override beat a completed table", () => {
    const state = makeState();
    playFullRoundRobin(state);
    state.tournament.seedOverride = ["c3", "c4", "c1", "c2"];
    expect(seedsFor(state)).toEqual(["c3", "c4", "c1", "c2"]);
  });

  it("ignores an override that is not a full four", () => {
    const state = makeState();
    state.tournament.seedOverride = ["c1", "c2", "c3"];
    expect(seedsFor(state)).toBeNull();
    playFullRoundRobin(state);
    expect(seedsFor(state)).toEqual(["c2", "c1", "c3", "c4"]);
  });

  it("counts a drawn map as played", () => {
    const state = makeState();
    for (const id of RR_IDS) playRr(state, id, 1, 1);
    expect(seedsFor(state)).not.toBeNull();
  });
});

describe("resolveMatches", () => {
  it("names round-robin teams straight away", () => {
    const matches = resolveMatches(makeState());
    const rr = byId(matches, "rr-c1-c2");
    expect([rr.nameA, rr.nameB]).toEqual(["Alpha", "Bravo"]);
    expect(rr.status).toBe("pending");
  });

  it("falls back to a placeholder for an unknown captain id", () => {
    const state = makeState();
    matchIn(state, "rr-c1-c2").teamB = "ghost";
    expect(byId(resolveMatches(state), "rr-c1-c2").nameB).toBe("TBD");
  });

  it("shows where each bracket slot comes from while it is unresolved", () => {
    const matches = resolveMatches(makeState());
    const sources = (id: string) => [byId(matches, id).nameA, byId(matches, id).nameB];
    expect(sources("ubsf1")).toEqual(["Seed 1", "Seed 4"]);
    expect(sources("ubsf2")).toEqual(["Seed 2", "Seed 3"]);
    expect(sources("ubf")).toEqual(["Upper semi 1 winner", "Upper semi 2 winner"]);
    expect(sources("lbr1")).toEqual(["Upper semi 1 loser", "Upper semi 2 loser"]);
    expect(sources("lbf")).toEqual(["Upper final loser", "Lower round 1 winner"]);
    expect(sources("gf")).toEqual(["Upper final winner", "Lower final winner"]);
    expect(matches.filter((m) => m.kind === "bracket").every((m) => m.teamA === null)).toBe(
      true
    );
  });

  it("carries the stakes note for the slots that have one", () => {
    const matches = resolveMatches(makeState());
    expect(byId(matches, "lbr1").note).toBe("Loser is 4th");
    expect(byId(matches, "lbf").note).toBe("Loser takes bronze");
    expect(byId(matches, "gf").note).toBe("Winner is champion");
    expect(byId(matches, "ubsf1").note).toBeNull();
    expect(byId(matches, "rr-c1-c2").note).toBeNull();
  });

  it("fills the semi-finals from the seeds once the round robin is done", () => {
    const state = makeState();
    playFullRoundRobin(state);
    const matches = resolveMatches(state); // seeds: c2, c1, c3, c4
    expect(byId(matches, "ubsf1")).toMatchObject({ teamA: "c2", teamB: "c4" });
    expect(byId(matches, "ubsf1")).toMatchObject({ nameA: "Bravo", nameB: "Delta" });
    expect(byId(matches, "ubsf2")).toMatchObject({ teamA: "c1", teamB: "c3" });
  });

  it("moves winners up and losers down as results land", () => {
    const state = makeState();
    playFullRoundRobin(state);
    playSeries(state, "ubsf1", [
      [1, 0],
      [1, 0],
    ]); // c2 beats c4
    playSeries(state, "ubsf2", [
      [0, 1],
      [0, 1],
    ]); // c3 beats c1
    const matches = resolveMatches(state);
    expect(byId(matches, "ubsf1")).toMatchObject({ winner: "c2", loser: "c4", status: "done" });
    expect(byId(matches, "ubf")).toMatchObject({ teamA: "c2", teamB: "c3" });
    expect(byId(matches, "lbr1")).toMatchObject({ teamA: "c4", teamB: "c1" });
    expect(byId(matches, "lbf").nameA).toBe("Upper final loser");
  });

  it("counts games won per side and reports a live series", () => {
    const state = makeState();
    playFullRoundRobin(state);
    playSeries(state, "ubsf1", [
      [1, 0],
      [0, 3],
    ]);
    const m = byId(resolveMatches(state), "ubsf1");
    expect([m.gamesWonA, m.gamesWonB]).toEqual([1, 1]);
    expect(m.status).toBe("live");
    expect(m.winner).toBeNull();
  });

  it("does not count a drawn map as a game win for anyone", () => {
    const state = makeState();
    playFullRoundRobin(state);
    playSeries(state, "ubsf1", [[2, 2]]);
    const m = byId(resolveMatches(state), "ubsf1");
    expect([m.gamesWonA, m.gamesWonB]).toEqual([0, 0]);
  });

  it("treats a drawn round-robin map as finished", () => {
    const state = makeState();
    playRr(state, "rr-c1-c2", 2, 2);
    const m = byId(resolveMatches(state), "rr-c1-c2");
    expect(m.status).toBe("done");
    expect(m.winner).toBeNull();
    expect(m.loser).toBeNull();
    expect(m.needsDecision).toBe(false);
  });

  it("stalls a drawn bracket series and asks the admin to decide", () => {
    const state = makeState();
    playFullRoundRobin(state);
    playSeries(state, "ubsf1", [
      [1, 0],
      [0, 1],
      [2, 2],
    ]);
    const matches = resolveMatches(state);
    const semi = byId(matches, "ubsf1");
    expect(semi.needsDecision).toBe(true);
    expect(semi.winner).toBeNull();
    expect(semi.status).toBe("live"); // not "done" — nobody advances yet
    // Nothing downstream may resolve off it.
    expect(byId(matches, "ubf").teamA).toBeNull();
    expect(byId(matches, "ubf").nameA).toBe("Upper semi 1 winner");
    expect(byId(matches, "lbr1").teamA).toBeNull();
  });

  it("never asks for a decision on a slot whose teams are still unknown", () => {
    const state = makeState();
    playSeries(state, "ubsf1", [
      [1, 0],
      [0, 1],
      [2, 2],
    ]); // played before the seeds exist
    expect(byId(resolveMatches(state), "ubsf1").needsDecision).toBe(false);
  });

  it("resolves a drawn series through the admin's override", () => {
    const state = makeState();
    playFullRoundRobin(state);
    playSeries(state, "ubsf1", [
      [1, 0],
      [0, 1],
      [2, 2],
    ]);
    matchIn(state, "ubsf1").winnerOverride = "c4"; // the seed-4 side
    const matches = resolveMatches(state);
    expect(byId(matches, "ubsf1")).toMatchObject({
      winner: "c4",
      loser: "c2",
      status: "done",
      needsDecision: false,
    });
    expect(byId(matches, "ubf").teamA).toBe("c4");
    expect(byId(matches, "lbr1").teamA).toBe("c2");
  });

  it("lets an override beat the games themselves", () => {
    const state = makeState();
    playFullRoundRobin(state);
    playSeries(state, "ubsf1", [
      [1, 0],
      [1, 0],
    ]); // c2 won on the maps
    matchIn(state, "ubsf1").winnerOverride = "c4";
    expect(byId(resolveMatches(state), "ubsf1").winner).toBe("c4");
  });

  it("ignores an override naming somebody who is not in the match", () => {
    const state = makeState();
    playFullRoundRobin(state);
    playSeries(state, "ubsf1", [
      [1, 0],
      [1, 0],
    ]);
    matchIn(state, "ubsf1").winnerOverride = "c3"; // c3 is in the other semi
    expect(byId(resolveMatches(state), "ubsf1").winner).toBe("c2");
  });

  it("returns one entry per stored match, in the stored order", () => {
    const state = makeState();
    expect(resolveMatches(state).map((m) => m.id)).toEqual(
      state.tournament.matches.map((m) => m.id)
    );
  });

  it("does not mutate the stored matches while resolving", () => {
    const state = makeState();
    playFullRoundRobin(state);
    resolveMatches(state);
    expect(matchIn(state, "ubsf1").teamA).toBeNull();
  });
});

describe("a full tournament", () => {
  function played(): DraftState {
    const state = makeState();
    playFullRoundRobin(state); // seeds: c2, c1, c3, c4
    playSeries(state, "ubsf1", [
      [1, 0],
      [1, 0],
    ]); // c2 beats c4
    playSeries(state, "ubsf2", [
      [1, 0],
      [0, 1],
      [1, 0],
    ]); // c1 beats c3
    playSeries(state, "ubf", [
      [0, 1],
      [0, 1],
    ]); // teamA c2 vs teamB c1 → c1 wins
    playSeries(state, "lbr1", [
      [0, 1],
      [0, 1],
    ]); // teamA c4 vs teamB c3 → c3 wins
    playSeries(state, "lbf", [
      [1, 0],
      [1, 0],
    ]); // teamA c2 vs teamB c3 → c2 wins
    playSeries(state, "gf", [
      [1, 0],
      [1, 0],
      [1, 0],
    ]); // teamA c1 vs teamB c2 → c1 wins
    return state;
  }

  it("threads every slot through to the grand final", () => {
    const matches = resolveMatches(played());
    expect(byId(matches, "ubf")).toMatchObject({ teamA: "c2", teamB: "c1", winner: "c1" });
    expect(byId(matches, "lbr1")).toMatchObject({ teamA: "c4", teamB: "c3", loser: "c4" });
    expect(byId(matches, "lbf")).toMatchObject({ teamA: "c2", teamB: "c3", loser: "c3" });
    expect(byId(matches, "gf")).toMatchObject({ teamA: "c1", teamB: "c2", winner: "c1" });
    expect(matches.every((m) => m.status === "done")).toBe(true);
  });

  it("reads the placements off the last three matches", () => {
    expect(placementsFor(resolveMatches(played()))).toEqual({
      first: "c1",
      second: "c2",
      third: "c3",
      fourth: "c4",
    });
  });
});

describe("placementsFor", () => {
  it("is null before the bracket has been played", () => {
    expect(placementsFor(resolveMatches(makeState()))).toBeNull();
  });

  it("is null while the grand final is undecided", () => {
    const state = makeState();
    playFullRoundRobin(state);
    playSeries(state, "ubsf1", [
      [1, 0],
      [1, 0],
    ]);
    playSeries(state, "ubsf2", [
      [1, 0],
      [1, 0],
    ]);
    playSeries(state, "ubf", [
      [1, 0],
      [1, 0],
    ]);
    playSeries(state, "lbr1", [
      [1, 0],
      [1, 0],
    ]);
    playSeries(state, "lbf", [
      [1, 0],
      [1, 0],
    ]);
    expect(placementsFor(resolveMatches(state))).toBeNull();
  });

  it("is null when the match list is missing the deciding slots", () => {
    expect(placementsFor([])).toBeNull();
  });
});

describe("toTournamentView", () => {
  it("packs the teams, table, seeds, matches and placements together", () => {
    const state = makeState();
    playFullRoundRobin(state);
    state.captains[0].roster = ["Nova", "Rook"];
    const view = toTournamentView(state, true);

    expect(view.isAdmin).toBe(true);
    expect(view.teams).toEqual([
      { id: "c1", name: "Alpha", roster: ["Nova", "Rook"] },
      { id: "c2", name: "Bravo", roster: [] },
      { id: "c3", name: "Charlie", roster: [] },
      { id: "c4", name: "Delta", roster: [] },
    ]);
    expect(view.standings.map((r) => r.id)).toEqual(["c2", "c1", "c3", "c4"]);
    expect(view.seeds).toEqual(["c2", "c1", "c3", "c4"]);
    expect(view.matches).toHaveLength(12);
    expect(view.placements).toBeNull();
    expect(typeof view.now).toBe("number");
  });

  it("passes the admin flag straight through", () => {
    expect(toTournamentView(makeState(), false).isAdmin).toBe(false);
  });

  it("normalises stored timing junk before handing it out", () => {
    const state = makeState();
    state.tournament.timing = { convoy: -1, domination: 0, betweenGames: 7, betweenSeries: 999 };
    expect(toTournamentView(state, false).timing).toEqual({
      convoy: 30,
      domination: 15,
      betweenGames: 7,
      betweenSeries: 10,
    });
  });
});
