/**
 * Generation, tested as properties over the whole matrix rather than as a
 * handful of examples.
 *
 * Every format × every team count from 2 to 8 is generated and then *played
 * through*, and the assertions are the things that must be true of any bracket
 * whatever its shape: every team enters once, byes land on the top seeds, every
 * source resolves, no slot is unreachable, exactly one champion comes out, and
 * nobody keeps playing after they are eliminated. Example tests would pass on
 * six sizes and quietly miss the seventh; these do not.
 */

import { describe, expect, it } from "vitest";
import {
  type GeneratedStage,
  circleRounds,
  generateBracket,
  generateStage,
  splitIntoGroups,
  swissPairings,
  swissRoundOne,
} from "@/lib/bracket";
import {
  type StageKind,
  MAX_TEAMS,
  nextPowerOfTwo,
  parseSource,
  seedOrder,
} from "@/lib/format-policy";
import { TEAM_COUNTS, makeTeams, playStage, seedSources } from "./format-helpers";

const ELIM: StageKind[] = ["single_elim", "double_elim"];
const ALL: StageKind[] = ["round_robin", "single_elim", "double_elim", "group_playoff", "swiss"];

/** The seeds that play in the opening round — everybody who was not given a bye. */
function firstRoundSeeds(stage: GeneratedStage): number[] {
  const opening = { ...stage, matches: stage.matches.filter((m) => m.bracket === "upper" && m.round === 1) };
  return seedSources(opening);
}

function pairsOf(stage: GeneratedStage): string[] {
  return stage.matches.map((m) => `${m.sourceA}|${m.sourceB}`);
}

describe.each(ALL)("%s — properties for every team count", (kind) => {
  describe.each(TEAM_COUNTS)("%i teams", (teamCount) => {
    const stage = generateStage(kind, teamCount);

    it("gives every match a unique slot", () => {
      const slots = stage.matches.map((m) => m.slot);
      expect(new Set(slots).size).toBe(slots.length);
    });

    it("gives every match two parseable sources", () => {
      for (const match of stage.matches) {
        expect(parseSource(match.sourceA), `${match.slot}.a`).not.toBeNull();
        expect(parseSource(match.sourceB), `${match.slot}.b`).not.toBeNull();
      }
    });

    it("never references a slot that does not exist", () => {
      for (const match of stage.matches) {
        for (const raw of [match.sourceA, match.sourceB]) {
          const ref = parseSource(raw);
          if (ref?.kind === "winner" || ref?.kind === "loser") {
            expect(stage.bySlot[ref.slot], `${match.slot} -> ${raw}`).toBeDefined();
          }
        }
      }
    });

    it("only ever waits on an earlier phase, so nothing can deadlock", () => {
      for (const match of stage.matches) {
        for (const raw of [match.sourceA, match.sourceB]) {
          const ref = parseSource(raw);
          if (ref?.kind !== "winner" && ref?.kind !== "loser") continue;
          expect(stage.bySlot[ref.slot].phase, `${match.slot} -> ${raw}`).toBeLessThan(
            match.phase
          );
        }
      }
    });

    it("gives every series one mode per game", () => {
      for (const match of stage.matches) {
        expect(match.modes, match.slot).toHaveLength(match.bestOf);
        expect(match.bestOf % 2, match.slot).toBe(1);
      }
    });

    it("never pairs a slot against itself", () => {
      for (const match of stage.matches) {
        expect(match.sourceA, match.slot).not.toBe(match.sourceB);
      }
    });

    it("plays every match exactly once when the whole stage is run", () => {
      const played = playStage(stage);
      const live = played.matches.filter((m) => m.status !== "void");
      for (const match of live) {
        expect(match.teamAId, `${match.slot} A`).not.toBeNull();
        expect(match.teamBId, `${match.slot} B`).not.toBeNull();
        expect(match.teamAId, match.slot).not.toBe(match.teamBId);
        expect(match.status, match.slot).toBe("done");
      }
      expect(live.length).toBeGreaterThan(0);
    });

    it("gives every team at least one match", () => {
      const played = playStage(stage);
      const appeared = new Set<string>();
      for (const match of played.matches) {
        if (match.teamAId) appeared.add(match.teamAId);
        if (match.teamBId) appeared.add(match.teamBId);
      }
      // A group stage only takes its qualifiers into the bracket, but every
      // team still plays its group. A Swiss round with an odd field rests one
      // team, which is the point of a bye.
      const resting = kind === "swiss" && teamCount % 2 === 1 ? 1 : 0;
      expect(appeared.size).toBe(teamCount - resting);
    });
  });
});

describe.each(ELIM)("%s — bracket properties", (kind) => {
  describe.each(TEAM_COUNTS)("%i teams", (teamCount) => {
    const stage = generateBracket(kind as "single_elim" | "double_elim", teamCount);

    it("enters every team exactly once", () => {
      const seeds = seedSources(stage).sort((a, b) => a - b);
      expect(seeds).toEqual(Array.from({ length: teamCount }, (_, i) => i + 1));
    });

    it("gives the byes to the top seeds", () => {
      const byes = nextPowerOfTwo(teamCount) - teamCount;
      const played = new Set(firstRoundSeeds(stage));
      // Seeds 1…byes never appear as a direct entrant, because their opening
      // match is against a seed that does not exist.
      for (let seed = 1; seed <= byes; seed += 1) {
        expect(played.has(seed), `seed ${seed} should have a bye`).toBe(false);
      }
      for (let seed = byes + 1; seed <= teamCount; seed += 1) {
        expect(played.has(seed), `seed ${seed} should play round 1`).toBe(true);
      }
    });

    it("produces exactly one champion", () => {
      const played = playStage(stage);
      const first = played.resolution.placements().filter((p) => p.position === 1);
      expect(first).toHaveLength(1);
      expect(played.resolution.champion()).toBe(first[0].teamId);
      // The best seed wins every match it plays, so it must be the champion.
      expect(played.resolution.champion()).toBe("t1");
    });

    it("places every team, once, across a partition of 1…n", () => {
      const played = playStage(stage);
      const placements = played.resolution.placements();
      const ids = placements.map((p) => p.teamId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(teamCount);

      const positions = [...placements].sort((x, y) => x.position - y.position);
      let expected = 1;
      for (let i = 0; i < positions.length; ) {
        const block = positions.filter((p) => p.position === positions[i].position);
        expect(positions[i].position).toBe(expected);
        expect(block).toHaveLength(block[0].shared);
        expected += block.length;
        i += block.length;
      }
    });

    it("eliminates the loser of every elimination match exactly once", () => {
      const played = playStage(stage);
      const allowed = kind === "double_elim" ? 2 : 1;
      const losses = new Map<string, number>();

      // In phase order, which is the order the matches are actually playable.
      const inOrder = [...played.matches]
        .filter((m) => m.status === "done")
        .sort((x, y) => x.phase - y.phase || x.slot.localeCompare(y.slot));

      for (const match of inOrder) {
        for (const teamId of [match.teamAId, match.teamBId]) {
          if (!teamId) continue;
          // Nobody may take the field already eliminated. The bronze match is
          // the one deliberate exception: it exists precisely to be played by
          // two teams who have each lost once, and it is their last.
          const cap = match.bracket === "bronze" ? allowed : allowed - 1;
          expect(losses.get(teamId) ?? 0, `${teamId} in ${match.slot}`).toBeLessThanOrEqual(cap);
        }
        // A bronze-match loss decides third from fourth; it does not eliminate
        // anybody, because both of them already were.
        if (match.loser && match.bracket !== "bronze") {
          losses.set(match.loser, (losses.get(match.loser) ?? 0) + 1);
        }
      }

      for (const [teamId, count] of losses) {
        expect(count, `${teamId} lost too often`).toBeLessThanOrEqual(allowed);
      }
    });
  });
});

describe("single elimination", () => {
  it("is n-1 matches, plus a bronze match once there are two semis", () => {
    const counts = TEAM_COUNTS.map((n) => generateStage("single_elim", n).matches.length);
    // 2:1  3:2  4:3+1  5:4+1  6:5+1  7:6+1  8:7+1
    expect(counts).toEqual([1, 2, 4, 5, 6, 7, 8]);
  });

  it("drops the bronze match when it is switched off", () => {
    const stage = generateStage("single_elim", 8, { bronze: "none" });
    expect(stage.matches).toHaveLength(7);
    expect(stage.bySlot.bronze).toBeUndefined();
  });

  it("names third and fourth from the semis when there is no bronze match", () => {
    const stage = generateStage("single_elim", 4, { bronze: "none" });
    expect(stage.bySlot.sf1.note).toBe("Loser is 3rd–4th");
  });

  it("seeds 1–3 into a bye with five teams, exactly as §8.2 asks", () => {
    const stage = generateStage("single_elim", 5);
    expect(stage.bySlot.qf.sourceA).toBe("seed:4");
    expect(stage.bySlot.qf.sourceB).toBe("seed:5");
    expect(stage.bySlot.sf1.sourceA).toBe("seed:1");
    expect(stage.bySlot.sf2.sourceA).toBe("seed:2");
    expect(stage.bySlot.sf2.sourceB).toBe("seed:3");
  });

  it("keeps the top two seeds apart until the final at every size", () => {
    for (const n of TEAM_COUNTS) {
      const stage = generateStage("single_elim", n, { bronze: "none" });
      const lastRound = Math.log2(nextPowerOfTwo(n));
      // Play it with the top two seeds beating everyone, so they can only be in
      // the same match if the bracket put them there.
      const played = playStage(stage);
      const together = played.matches.filter(
        (m) =>
          m.teamAId &&
          m.teamBId &&
          [m.teamAId, m.teamBId].every((id) => id === "t1" || id === "t2")
      );
      expect(together, `${n} teams`).toHaveLength(1);
      expect(together[0].round, `${n} teams`).toBe(lastRound);
    }
  });
});

describe("double elimination", () => {
  it("is 2n-2 matches at every size", () => {
    for (const n of TEAM_COUNTS) {
      expect(generateStage("double_elim", n).matches.length, `${n} teams`).toBe(2 * n - 2);
    }
  });

  it("adds a bracket reset when it is switched on, and nothing else", () => {
    const off = generateStage("double_elim", 4);
    const on = generateStage("double_elim", 4, { bracketReset: true });
    expect(off.resetSlot).toBeNull();
    expect(on.resetSlot).toBe("gf2");
    expect(on.matches).toHaveLength(off.matches.length + 1);
    expect(on.bySlot.gf2.sourceA).toBe("winner:gf");
    expect(on.bySlot.gf2.sourceB).toBe("loser:gf");
  });

  it("defaults the bracket reset off, per §14", () => {
    for (const n of TEAM_COUNTS) {
      expect(generateStage("double_elim", n).config.bracketReset).toBe(false);
    }
  });

  it("gives the loser of the only match a second life when there are two teams", () => {
    const stage = generateStage("double_elim", 2);
    expect(stage.matches.map((m) => m.slot)).toEqual(["ubf", "gf"]);
    expect(stage.bySlot.gf.sourceB).toBe("loser:ubf");
  });

  it("drops losers into the lower round that matches their exit round", () => {
    const stage = generateStage("double_elim", 8);
    // Upper quarter losers open the lower bracket; upper semi losers come in a
    // round later; the upper final loser only meets the lower final.
    expect(stage.bySlot["lbr1-1"].sourceA).toBe("loser:ubqf1");
    expect(stage.bySlot["lbr2-1"].sourceA).toBe("loser:ubsf2");
    expect(stage.bySlot.lbf.sourceA).toBe("loser:ubf");
  });

  it("does not rematch an upper-bracket pairing in the next lower round", () => {
    const stage = generateStage("double_elim", 8);
    // lbr2-1 takes the semi-2 loser against the winner of lbr1-1, which is one
    // of the quarter-1/2 losers — the other side of the bracket entirely.
    expect(stage.bySlot["lbr2-1"].sourceB).toBe("winner:lbr1-1");
    expect(stage.bySlot["lbr2-2"].sourceA).toBe("loser:ubsf1");
    expect(stage.bySlot["lbr2-2"].sourceB).toBe("winner:lbr1-2");
  });
});

describe("round robin", () => {
  it("plays every pair exactly once", () => {
    for (const n of TEAM_COUNTS) {
      const stage = generateStage("round_robin", n);
      expect(stage.matches).toHaveLength((n * (n - 1)) / 2);
      expect(new Set(pairsOf(stage)).size).toBe(stage.matches.length);
    }
  });

  it("plays every pair twice when the return leg is switched on", () => {
    for (const n of TEAM_COUNTS) {
      const stage = generateStage("round_robin", n, { doubleRound: true });
      expect(stage.matches).toHaveLength(n * (n - 1));
    }
  });

  it("never puts a team in a round twice", () => {
    for (const n of TEAM_COUNTS) {
      const stage = generateStage("round_robin", n, { doubleRound: true });
      const rounds = new Map<number, string[]>();
      for (const match of stage.matches) {
        const list = rounds.get(match.round) ?? [];
        list.push(match.sourceA, match.sourceB);
        rounds.set(match.round, list);
      }
      for (const [round, entries] of rounds) {
        expect(new Set(entries).size, `${n} teams, round ${round}`).toBe(entries.length);
      }
    }
  });

  it("uses n-1 rounds for an even field and n for an odd one", () => {
    for (const n of TEAM_COUNTS) {
      const stage = generateStage("round_robin", n);
      const rounds = Math.max(...stage.matches.map((m) => m.round));
      expect(rounds, `${n} teams`).toBe(n % 2 === 0 ? n - 1 : n);
    }
  });

  it("rests exactly one team per round when the field is odd", () => {
    for (const n of [3, 5, 7]) {
      const stage = generateStage("round_robin", n);
      for (let round = 1; round <= n; round += 1) {
        expect(stage.matches.filter((m) => m.round === round)).toHaveLength((n - 1) / 2);
      }
    }
  });

  it("is the current board's pairing for four teams — the n=4 case", () => {
    expect(circleRounds([1, 2, 3, 4])).toEqual([
      [
        [1, 2],
        [3, 4],
      ],
      [
        [1, 3],
        [2, 4],
      ],
      [
        [1, 4],
        [2, 3],
      ],
    ]);
  });
});

describe("group into playoff", () => {
  it("splits the field evenly and snakes the seeds", () => {
    expect(splitIntoGroups(4, 2)).toEqual([
      [1, 4],
      [2, 3],
    ]);
    expect(splitIntoGroups(8, 2)).toEqual([
      [1, 4, 5, 8],
      [2, 3, 6, 7],
    ]);
    expect(splitIntoGroups(5, 2)).toEqual([
      [1, 4, 5],
      [2, 3],
    ]);
  });

  it("puts every team in exactly one group", () => {
    for (const n of TEAM_COUNTS) {
      for (const groups of [1, 2, 3]) {
        const split = splitIntoGroups(n, groups);
        expect(split.flat().sort((a, b) => a - b)).toEqual(
          Array.from({ length: n }, (_, i) => i + 1)
        );
      }
    }
  });

  it("cross-seeds the qualifiers so a group's top two cannot meet in round one", () => {
    const stage = generateStage("group_playoff", 8, { groups: 2, advancePerGroup: 2 });
    expect(stage.bySlot.sf1.sourceA).toBe("group:a:rank:1");
    expect(stage.bySlot.sf1.sourceB).toBe("group:b:rank:2");
    expect(stage.bySlot.sf2.sourceA).toBe("group:b:rank:1");
    expect(stage.bySlot.sf2.sourceB).toBe("group:a:rank:2");
  });

  it("cannot advance more teams than the thinnest group holds", () => {
    // Five teams into two groups is 3 and 2, so three cannot go through.
    const stage = generateStage("group_playoff", 5, { groups: 2, advancePerGroup: 3 });
    const ranks = stage.matches
      .flatMap((m) => [m.sourceA, m.sourceB])
      .map(parseSource)
      .filter((ref) => ref?.kind === "group");
    expect(Math.max(...ranks.map((ref) => (ref as { rank: number }).rank))).toBe(2);
  });

  it("runs the groups before the playoff, in phase order", () => {
    const stage = generateStage("group_playoff", 8, { groups: 2, advancePerGroup: 2 });
    const lastGroup = Math.max(...stage.matches.filter((m) => m.bracket === "rr").map((m) => m.phase));
    const firstPlayoff = Math.min(
      ...stage.matches.filter((m) => m.bracket !== "rr").map((m) => m.phase)
    );
    expect(firstPlayoff).toBeGreaterThan(lastGroup);
  });

  it("gives the groups Bo1 and the playoff Bo3 without being told", () => {
    const stage = generateStage("group_playoff", 8, { groups: 2, advancePerGroup: 2 });
    expect(stage.matches.filter((m) => m.bracket === "rr").every((m) => m.bestOf === 1)).toBe(true);
    expect(stage.matches.filter((m) => m.bracket !== "rr").every((m) => m.bestOf === 3)).toBe(true);
  });
});

describe("swiss", () => {
  it("opens with the top half against the bottom half", () => {
    expect(swissRoundOne(8)).toEqual([
      [1, 5],
      [2, 6],
      [3, 7],
      [4, 8],
    ]);
    expect(swissRoundOne(5)).toEqual([
      [1, 4],
      [2, 5],
    ]);
  });

  it("pairs the next round down the table, skipping anyone already met", () => {
    const { pairs, bye } = swissPairings(["a", "b", "c", "d"], [["a", "b"]]);
    expect(pairs).toEqual([
      ["a", "c"],
      ["b", "d"],
    ]);
    expect(bye).toBeNull();
  });

  it("gives the bye to the bottom of the table when the field is odd", () => {
    const { pairs, bye } = swissPairings(["a", "b", "c"], []);
    expect(pairs).toEqual([["a", "b"]]);
    expect(bye).toBe("c");
  });

  it("allows a rematch rather than leaving somebody unpaired", () => {
    const { pairs } = swissPairings(
      ["a", "b"],
      [
        ["a", "b"],
        ["b", "a"],
      ]
    );
    expect(pairs).toEqual([["a", "b"]]);
  });
});

describe("seeding order", () => {
  it("mirrors, so 1 and 2 can only meet in the final", () => {
    expect(seedOrder(2)).toEqual([1, 2]);
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it("is a permutation at every size", () => {
    for (const size of [2, 4, 8, 16]) {
      expect([...seedOrder(size)].sort((a, b) => a - b)).toEqual(
        Array.from({ length: size }, (_, i) => i + 1)
      );
    }
  });
});

describe("team counts outside the range", () => {
  it("clamps rather than throwing", () => {
    expect(generateStage("single_elim", 1).teamCount).toBe(2);
    expect(generateStage("single_elim", 99).teamCount).toBe(MAX_TEAMS);
    expect(generateStage("single_elim", Number.NaN).teamCount).toBe(2);
  });
});

describe("configuration is data, not branches", () => {
  it("takes the series length from the slot, then the round, then the half", () => {
    const stage = generateStage("double_elim", 4, {
      bestOf: 3,
      bestOfBySlot: { gf: 7 },
      bestOfByRound: { "1": 1 },
    });
    expect(stage.bySlot.gf.bestOf).toBe(7);
    expect(stage.bySlot.ubsf1.bestOf).toBe(1);
    expect(stage.bySlot.ubf.bestOf).toBe(3);
  });

  it("takes the mode sequence from config, so [convoy, convoy, domination] is one instance", () => {
    const stage = generateStage("double_elim", 4);
    expect(stage.bySlot.ubsf1.modes).toEqual(["convoy", "convoy", "domination"]);
    expect(stage.bySlot.gf.modes).toEqual([
      "convoy",
      "convoy",
      "convoy",
      "convoy",
      "domination",
    ]);

    const custom = generateStage("double_elim", 4, {
      modeSequence: { "3": ["escort", "push", "control"] },
    });
    expect(custom.bySlot.ubsf1.modes).toEqual(["escort", "push", "control"]);
  });

  it("stretches a short mode sequence rather than leaving holes", () => {
    const stage = generateStage("double_elim", 4, { modeSequence: { "5": ["push"] } });
    expect(stage.bySlot.gf.modes).toEqual(["push", "push", "push", "push", "push"]);
  });
});
