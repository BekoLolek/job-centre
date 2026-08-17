/**
 * The proof that the generalisation did not change the tournament.
 *
 * `src/lib/tournament.ts` hardcodes one 4-team double elimination: six bracket
 * slots with a hand-written source table, a hand-written phase list and a
 * hand-written schedule. This file generates the same tournament from
 * `generateStage` and asserts that the two agree on every observable — the
 * slots, the sources, the phases, the series lengths, the labels, the stakes
 * notes, the resolved teams after a full tournament is played through both, the
 * placements, and every start time the auto-fill produces.
 *
 * Nothing here imports a fixture: the legacy side is the live module the
 * current board runs on, so this test fails if either implementation drifts.
 */

import { describe, expect, it } from "vitest";
import { generateStage } from "@/lib/bracket";
import { DEFAULT_FORMAT_TIMING } from "@/lib/format-policy";
import { type MatchRecord, StageResolution, blankGamesFor } from "@/lib/format-resolve";
import { autoSchedule as autoScheduleNew, planBlocks } from "@/lib/format-schedule";
import {
  DEFAULT_TIMING,
  autoSchedule as autoScheduleOld,
  resolveMatches as resolveOld,
  seedsFor as seedsOld,
  standingsFor as standingsOld,
} from "@/lib/tournament";
import type { DraftState } from "@/lib/types";
import { makeState, matchIn, playFullRoundRobin, playSeries } from "./helpers";

/** Captain `c1` is seed 1's team, and so on. */
const TEAMS = [1, 2, 3, 4].map((n) => ({ id: `c${n}`, name: `Team ${n}`, seed: n }));

/** `rr-c1-c2` on the old board is `rr-1-2` on the new one. */
function slotFor(legacyId: string): string {
  return legacyId.startsWith("rr-") ? legacyId.replace(/c/g, "") : legacyId;
}

const RR = generateStage("round_robin", 4);
const DE = generateStage("double_elim", 4);

describe("the generated 4-team double elimination", () => {
  const legacy = makeState().tournament.matches.filter((m) => m.kind === "bracket");

  it("has exactly the hardcoded slots, in the same order", () => {
    expect(DE.matches.map((m) => m.slot)).toEqual(legacy.map((m) => m.slot));
  });

  it("gives every slot the same phase", () => {
    expect(DE.matches.map((m) => m.phase)).toEqual(legacy.map((m) => m.phase));
  });

  it("gives every slot the same series length", () => {
    expect(DE.matches.map((m) => m.bestOf)).toEqual(legacy.map((m) => m.bestOf));
  });

  it("gives every slot the same label", () => {
    expect(DE.matches.map((m) => m.displayLabel)).toEqual(legacy.map((m) => m.label));
  });

  it("gives every game the same mode", () => {
    for (const match of DE.matches) {
      const old = legacy.find((m) => m.slot === match.slot);
      expect(match.modes, match.slot).toEqual(old?.games.map((g) => g.mode));
    }
  });

  it("produces the same placeholder for every source, which is the source table", () => {
    const records: MatchRecord[] = DE.matches.map((match) => ({
      slot: match.slot,
      bestOf: match.bestOf,
      teamAId: null,
      teamBId: null,
      sourceA: match.sourceA,
      sourceB: match.sourceB,
      scheduledAt: null,
      finishedAt: null,
      durationMin: null,
      winnerOverrideId: null,
      games: blankGamesFor(match),
    }));
    const fresh = new StageResolution({
      stage: DE,
      matches: records,
      teams: [],
      seeds: null,
    }).matches();
    const old = resolveOld(makeState());

    for (const match of fresh) {
      const before = old.find((m) => m.id === match.slot);
      expect([match.nameA, match.nameB], match.slot).toEqual([before?.nameA, before?.nameB]);
    }
  });

  it("carries the same stakes notes", () => {
    const old = resolveOld(makeState());
    for (const match of DE.matches) {
      expect(match.note, match.slot).toBe(old.find((m) => m.id === match.slot)?.note ?? null);
    }
  });
});

describe("the generated 4-team round robin", () => {
  const legacy = makeState().tournament.matches.filter((m) => m.kind === "rr");

  it("is the same six pairings, in the same rounds", () => {
    expect(RR.matches.map((m) => ({ slot: m.slot, round: m.round }))).toEqual(
      legacy.map((m) => ({ slot: slotFor(m.id), round: m.phase }))
    );
  });

  it("is a single map per pairing, as the current board plays it", () => {
    expect(RR.matches.every((m) => m.bestOf === 1)).toBe(true);
    expect(RR.matches.every((m) => m.modes[0] === "convoy")).toBe(true);
  });
});

/** Play the identical tournament through both implementations. */
function playBoth(): {
  old: DraftState;
  records: MatchRecord[];
  resolution: StageResolution;
} {
  const old = makeState();
  playFullRoundRobin(old);
  playSeries(old, "ubsf1", [
    [1, 0],
    [1, 0],
  ]);
  playSeries(old, "ubsf2", [
    [1, 0],
    [0, 1],
    [1, 0],
  ]);
  playSeries(old, "ubf", [
    [0, 1],
    [0, 1],
  ]);
  playSeries(old, "lbr1", [
    [0, 1],
    [0, 1],
  ]);
  playSeries(old, "lbf", [
    [1, 0],
    [1, 0],
  ]);
  playSeries(old, "gf", [
    [1, 0],
    [1, 0],
    [1, 0],
  ]);

  // The same results, copied game by game onto the generated slots.
  const records: MatchRecord[] = DE.matches.map((match) => {
    const before = matchIn(old, match.slot);
    return {
      slot: match.slot,
      bestOf: match.bestOf,
      teamAId: null,
      teamBId: null,
      sourceA: match.sourceA,
      sourceB: match.sourceB,
      scheduledAt: null,
      finishedAt: null,
      durationMin: null,
      winnerOverrideId: null,
      games: blankGamesFor(match).map((game, i) => ({
        ...game,
        scoreA: before.games[i].scoreA,
        scoreB: before.games[i].scoreB,
        played: before.games[i].played,
      })),
    };
  });

  const resolution = new StageResolution({
    stage: DE,
    matches: records,
    teams: TEAMS,
    // The current board seeds the bracket off the finished table, and so does
    // the generalised one — this is that handover, made explicit.
    seeds: seedsOld(old),
  });

  return { old, records, resolution };
}

describe("a full tournament, played through both", () => {
  it("agrees on the table, and on the seeding it hands the bracket", () => {
    const old = makeState();
    playFullRoundRobin(old);

    const table = new StageResolution({
      stage: RR,
      matches: RR.matches.map((match) => {
        const [, a, b] = match.slot.split("-");
        const before = matchIn(old, `rr-c${a}-c${b}`);
        return {
          slot: match.slot,
          bestOf: 1,
          teamAId: `c${a}`,
          teamBId: `c${b}`,
          sourceA: match.sourceA,
          sourceB: match.sourceB,
          scheduledAt: null,
          finishedAt: null,
          durationMin: null,
          winnerOverrideId: null,
          games: blankGamesFor(match).map((game) => ({
            ...game,
            scoreA: before.games[0].scoreA,
            scoreB: before.games[0].scoreB,
            played: before.games[0].played,
          })),
        };
      }),
      teams: TEAMS,
    });

    // The mini-league tiebreak, the map difference and the seeding all agree.
    expect(table.table(null).map((r) => r.id)).toEqual(seedsOld(old));
    expect(table.seeding()).toEqual(seedsOld(old));
    for (const row of table.table(null)) {
      const before = standingsOld(old).find((r) => r.id === row.id);
      expect(
        { played: row.played, won: row.won, drawn: row.drawn, lost: row.lost, points: row.points, diff: row.diff },
        row.id
      ).toEqual({
        played: before?.played,
        won: before?.won,
        drawn: before?.drawn,
        lost: before?.lost,
        points: before?.points,
        diff: before?.diff,
      });
    }
  });

  it("agrees on every slot's teams, winner, loser and status", () => {
    const { old, resolution } = playBoth();
    const before = resolveOld(old);
    for (const match of resolution.matches()) {
      const legacy = before.find((m) => m.id === match.slot);
      expect(
        {
          teamA: match.teamAId,
          teamB: match.teamBId,
          winner: match.winner,
          loser: match.loser,
          status: match.status,
          needsDecision: match.needsDecision,
          gamesWonA: match.gamesWonA,
          gamesWonB: match.gamesWonB,
        },
        match.slot
      ).toEqual({
        teamA: legacy?.teamA,
        teamB: legacy?.teamB,
        winner: legacy?.winner,
        loser: legacy?.loser,
        status: legacy?.status,
        needsDecision: legacy?.needsDecision,
        gamesWonA: legacy?.gamesWonA,
        gamesWonB: legacy?.gamesWonB,
      });
    }
  });

  it("agrees on the podium", () => {
    const { resolution } = playBoth();
    expect(resolution.placements()).toEqual([
      { position: 1, shared: 1, teamId: "c1" },
      { position: 2, shared: 1, teamId: "c2" },
      { position: 3, shared: 1, teamId: "c3" },
      { position: 4, shared: 1, teamId: "c4" },
    ]);
  });

  it("agrees on a drawn series stalling for the admin", () => {
    const old = makeState();
    playFullRoundRobin(old);
    playSeries(old, "ubsf1", [
      [1, 0],
      [0, 1],
      [2, 2],
    ]);
    const records: MatchRecord[] = DE.matches.map((match) => {
      const before = matchIn(old, match.slot);
      return {
        slot: match.slot,
        bestOf: match.bestOf,
        teamAId: null,
        teamBId: null,
        sourceA: match.sourceA,
        sourceB: match.sourceB,
        scheduledAt: null,
        finishedAt: null,
        durationMin: null,
        winnerOverrideId: null,
        games: blankGamesFor(match).map((game, i) => ({
          ...game,
          scoreA: before.games[i].scoreA,
          scoreB: before.games[i].scoreB,
          played: before.games[i].played,
        })),
      };
    });
    const fresh = new StageResolution({
      stage: DE,
      matches: records,
      teams: TEAMS,
      seeds: seedsOld(old),
    }).matches();
    const legacy = resolveOld(old);

    for (const slot of ["ubsf1", "ubf", "lbr1"]) {
      const a = fresh.find((m) => m.slot === slot);
      const b = legacy.find((m) => m.id === slot);
      expect([a?.status, a?.needsDecision, a?.teamAId], slot).toEqual([
        b?.status,
        b?.needsDecision,
        b?.teamA,
      ]);
    }
  });
});

describe("the schedule, laid out by both", () => {
  const DAY1 = "2025-08-15T14:00:00.000Z";
  const DAY2 = "2025-08-16T14:00:00.000Z";

  it("agrees on every start time in the 4-team, 2-lobby, 2-day case", () => {
    const old = makeState();
    autoScheduleOld(old, DAY1, DAY2, DEFAULT_TIMING);

    const blocks = planBlocks([RR, DE], {
      timing: DEFAULT_FORMAT_TIMING,
      concurrentLobbies: 2,
      days: 2,
      blockDays: [1, 1, 1, 1, 1, 2, 2],
    });
    const matches = [...RR.matches, ...DE.matches].map((match) => ({
      slot: match.slot,
      scheduledAt: null as string | null,
      finishedAt: null as string | null,
      durationMin: null as number | null,
    }));
    autoScheduleNew(matches, blocks, [DAY1, DAY2], DEFAULT_FORMAT_TIMING);

    const fresh = Object.fromEntries(matches.map((m) => [m.slot, m.scheduledAt]));
    const legacy = Object.fromEntries(
      old.tournament.matches.map((m) => [slotFor(m.id), m.scheduledAt])
    );
    expect(fresh).toEqual(legacy);
  });

  it("agrees on the timing defaults themselves", () => {
    expect(DEFAULT_FORMAT_TIMING.modeMinutes.convoy).toBe(DEFAULT_TIMING.convoy);
    expect(DEFAULT_FORMAT_TIMING.modeMinutes.domination).toBe(DEFAULT_TIMING.domination);
    expect(DEFAULT_FORMAT_TIMING.betweenGames).toBe(DEFAULT_TIMING.betweenGames);
    expect(DEFAULT_FORMAT_TIMING.betweenSeries).toBe(DEFAULT_TIMING.betweenSeries);
  });
});
