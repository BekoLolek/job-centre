import { describe, expect, it } from "vitest";
import { generateStage, swissNextRound } from "@/lib/bracket";
import {
  type StageConfig,
  MAX_TEAMS,
  normaliseStageConfig,
  teamCountRefusal,
  teamRangeFor,
} from "@/lib/format-policy";
import { type PlannedBlock, dayOverruns } from "@/lib/format-schedule";

/**
 * The pure half of Task 21: what a kind of stage can be played with, how a
 * Swiss grows, and which days do not finish on the day they start.
 *
 * Nothing here touches a database. All three are decisions the write and the
 * screen both have to agree about, so they are functions and they are tested
 * as functions — the database-level consequences are in `format-sync.test.ts`.
 */

function config(kind: Parameters<typeof normaliseStageConfig>[0], over: Partial<StageConfig> = {}) {
  return normaliseStageConfig(kind, over);
}

/* ------------------------------------------------------------------ */
/* UC-18 2a — the kind does not support the team count                */
/* ------------------------------------------------------------------ */

describe("teamRangeFor / teamCountRefusal (UC-18 2a)", () => {
  it("names the valid range rather than clamping, for a bracket", () => {
    const refusal = teamCountRefusal("single_elim", 1, config("single_elim"));
    expect(refusal).toBe(
      "A single elimination needs between 2 and 8 teams. This event has 1."
    );
  });

  it("raises the floor for a group stage: a group of one is not a group", () => {
    const three = config("group_playoff", { groups: 3 });
    expect(teamRangeFor("group_playoff", three)).toEqual({ min: 6, max: MAX_TEAMS });

    expect(teamCountRefusal("group_playoff", 4, three)).toBe(
      "Groups then a playoff with 3 groups needs between 6 and 8 teams. This event has 4."
    );
    // Six is exactly enough — two per group — and is not refused.
    expect(teamCountRefusal("group_playoff", 6, three)).toBeNull();
  });

  it("raises the floor for a Swiss: n teams hold only n-1 opponents", () => {
    const three = config("swiss", { rounds: 3 });
    expect(teamRangeFor("swiss", three)).toEqual({ min: 4, max: MAX_TEAMS });

    expect(teamCountRefusal("swiss", 3, three)).toBe(
      "A Swiss over 3 rounds needs between 4 and 8 teams. This event has 3."
    );
    expect(teamCountRefusal("swiss", 4, three)).toBeNull();
  });

  it("says which setting is impossible when no team count could satisfy it", () => {
    // Five groups is a ten-team shape, and the platform stops at eight — so
    // naming a range would name an empty one.
    const five = config("group_playoff", { groups: 5 });
    expect(teamCountRefusal("group_playoff", 8, five)).toBe(
      "Groups then a playoff with 5 groups needs 10 teams, and an event can have at most 8. Use fewer groups."
    );

    const long = config("swiss", { rounds: 9 });
    expect(teamCountRefusal("swiss", 8, long)).toBe(
      "A Swiss over 9 rounds needs 10 teams, and an event can have at most 8. Use fewer rounds."
    );
  });

  it("refuses above the ceiling as well as below the floor", () => {
    expect(teamCountRefusal("round_robin", 9, config("round_robin"))).toContain(
      "between 2 and 8 teams"
    );
    expect(teamCountRefusal("round_robin", 8, config("round_robin"))).toBeNull();
  });

  it("is a refusal, and leaves the preview free to draw the shape anyway", () => {
    /*
     * The two have to disagree, and deliberately: the Format tab draws the
     * bracket it is refusing, because a tab that cannot show the shape cannot
     * explain the refusal. `generateStage` therefore still clamps — this is the
     * line that says the *write*'s answer comes from somewhere else.
     */
    const three = config("group_playoff", { groups: 3 });
    expect(teamCountRefusal("group_playoff", 4, three)).not.toBeNull();
    expect(generateStage("group_playoff", 4, three).matches.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* The Swiss pairing record                                           */
/* ------------------------------------------------------------------ */

describe("normaliseStageConfig: swissRounds", () => {
  it("keeps a stored pairing for a Swiss", () => {
    const stored = config("swiss", {
      swissRounds: { "2": [[1, 3], [2, 4]] } as StageConfig["swissRounds"],
    });
    expect(stored.swissRounds).toEqual({ "2": [[1, 3], [2, 4]] });
  });

  it("drops a pairing list on any other kind", () => {
    const stored = config("round_robin", {
      swissRounds: { "2": [[1, 3]] } as StageConfig["swissRounds"],
    });
    expect(stored.swissRounds).toEqual({});
  });

  it("refuses round 1, a seed out of range, a self-pairing and a seed twice", () => {
    const stored = config("swiss", {
      swissRounds: {
        // Round 1 is the seeding, never a stored pairing.
        "1": [[1, 2]],
        "2": [
          [1, 3],
          // 1 has already been paired this round; a team cannot play twice.
          [1, 4],
          // Nobody plays themselves.
          [5, 5],
          // Nine is past MAX_TEAMS.
          [2, 9],
          [2, 6],
        ],
        // Not a round number at all.
        later: [[1, 2]],
      } as unknown as StageConfig["swissRounds"],
    });
    expect(stored.swissRounds).toEqual({ "2": [[1, 3], [2, 6]] });
  });
});

describe("swissNextRound", () => {
  it("pairs the table from the top down, skipping anyone already met", () => {
    // Table order 1,2,3,4; 1 has already played 2 and 3 has already played 4.
    const { pairs, bye } = swissNextRound([1, 2, 3, 4], [
      [1, 2],
      [3, 4],
    ]);
    expect(pairs).toEqual([
      [1, 3],
      [2, 4],
    ]);
    expect(bye).toBeNull();
  });

  it("leaves the lowest unpaired team with a bye on an odd field", () => {
    const { pairs, bye } = swissNextRound([1, 2, 3], [[1, 2]]);
    expect(pairs).toEqual([[1, 3]]);
    expect(bye).toBe(2);
  });

  it("gives a rematch rather than no match once everyone has met", () => {
    const { pairs } = swissNextRound([1, 2], [[1, 2]]);
    expect(pairs).toEqual([[1, 2]]);
  });
});

describe("generateStage: swiss grows a round at a time", () => {
  it("generates round one from the seeding and nothing else", () => {
    const stage = generateStage("swiss", 4, config("swiss", { rounds: 3 }));
    expect(stage.matches.map((match) => match.slot)).toEqual(["sw1-1-3", "sw1-2-4"]);
    expect(stage.matches.every((match) => match.round === 1)).toBe(true);
    // A table game, not a bracket slot: a drawn Swiss game is a finished match.
    expect(stage.matches.every((match) => match.elimination === false)).toBe(true);
  });

  it("generates a later round once its pairing has been recorded", () => {
    const stage = generateStage(
      "swiss",
      4,
      config("swiss", {
        rounds: 3,
        swissRounds: { "2": [[1, 2], [3, 4]] } as StageConfig["swissRounds"],
      })
    );
    expect(stage.matches.map((match) => match.slot)).toEqual([
      "sw1-1-3",
      "sw1-2-4",
      "sw2-1-2",
      "sw2-3-4",
    ]);
    expect(stage.matches.filter((match) => match.round === 2)).toHaveLength(2);
    expect(stage.matches.find((match) => match.slot === "sw2-1-2")?.roundLabel).toBe(
      "Swiss round 2"
    );
  });

  it("stops at a gap rather than generating a round whose table has no games", () => {
    const stage = generateStage(
      "swiss",
      4,
      config("swiss", {
        rounds: 4,
        // Round 3 recorded, round 2 missing — a shape nobody can have played.
        swissRounds: { "3": [[1, 2], [3, 4]] } as StageConfig["swissRounds"],
      })
    );
    expect(stage.matches.map((match) => match.round)).toEqual([1, 1]);
  });

  it("never generates past the configured round count", () => {
    const stage = generateStage(
      "swiss",
      4,
      config("swiss", {
        rounds: 2,
        swissRounds: {
          "2": [[1, 2], [3, 4]],
          "3": [[1, 3], [2, 4]],
        } as StageConfig["swissRounds"],
      })
    );
    expect([...new Set(stage.matches.map((match) => match.round))]).toEqual([1, 2]);
  });

  it("drops a stored pairing naming a seed this field no longer has", () => {
    // Paired when there were six teams; two have since gone.
    const stage = generateStage(
      "swiss",
      4,
      config("swiss", {
        rounds: 2,
        swissRounds: { "2": [[1, 2], [5, 6]] } as StageConfig["swissRounds"],
      })
    );
    expect(stage.matches.filter((match) => match.round === 2).map((match) => match.slot)).toEqual([
      "sw2-1-2",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-18 7a — a day that overruns midnight                            */
/* ------------------------------------------------------------------ */

/** One block of `lengthMin` minutes on `day`, `offsetMin` after its start. */
function block(day: number, offsetMin: number, lengthMin: number, index = 0): PlannedBlock {
  return { index, day, label: `Day ${day} block ${index}`, slots: [], lengthMin, offsetMin };
}

describe("dayOverruns (UC-18 7a)", () => {
  // The suite pins Europe/Budapest, so these offsets are the local clock.
  const evening = "2026-06-20T20:00:00+02:00";
  const morning = "2026-06-20T10:00:00+02:00";

  it("says nothing about a day that finishes on the day it started", () => {
    expect(dayOverruns([block(1, 0, 300)], [morning])).toEqual([]);
  });

  it("warns about a day that ends past midnight, and allows it", () => {
    const [overrun] = dayOverruns([block(1, 0, 300)], [evening]);
    expect(overrun.day).toBe(1);
    expect(overrun.pastMidnight).toBe(true);
    expect(overrun.intoNextDay).toBe(false);
    expect(overrun.lengthMin).toBe(300);
    expect(overrun.endsAt).toBe("2026-06-20T23:00:00.000Z");
  });

  it("warns separately when a day runs into the next day's own start", () => {
    const blocks = [block(1, 0, 300, 0), block(2, 0, 60, 1)];
    const [overrun] = dayOverruns(blocks, [morning, "2026-06-20T14:00:00+02:00"]);
    expect(overrun.day).toBe(1);
    // 10:00 + 5h = 15:00, which is after day 2's 14:00 — the two overlap, and
    // nothing here has crossed midnight.
    expect(overrun.intoNextDay).toBe(true);
    expect(overrun.pastMidnight).toBe(false);
  });

  it("measures the whole day, not one block", () => {
    const blocks = [block(1, 0, 120, 0), block(1, 130, 300, 1)];
    const [overrun] = dayOverruns(blocks, [evening]);
    expect(overrun.lengthMin).toBe(430);
    expect(overrun.pastMidnight).toBe(true);
  });

  it("skips a day with no start time rather than guessing one", () => {
    expect(dayOverruns([block(1, 0, 600)], [null])).toEqual([]);
    expect(dayOverruns([block(1, 0, 600)], [])).toEqual([]);
  });
});
