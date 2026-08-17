import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORMAT_TIMING,
  DEFAULT_MODE_SEQUENCE,
  DEFAULT_TIEBREAKERS,
  MAX_TEAMS,
  bestOfFor,
  defaultStageConfig,
  formatSource,
  groupKey,
  isEliminationKind,
  isStageKind,
  modeMinutes,
  modesFor,
  nextPowerOfTwo,
  normaliseFormatTiming,
  normaliseStageConfig,
  ordinal,
  parseSource,
  seriesMinutes,
  seriesTarget,
  sourceDependency,
} from "@/lib/format-policy";

describe("stage kinds", () => {
  it("recognises the five formats and nothing else", () => {
    for (const kind of ["round_robin", "single_elim", "double_elim", "swiss", "group_playoff"]) {
      expect(isStageKind(kind)).toBe(true);
    }
    expect(isStageKind("ladder")).toBe(false);
    expect(isStageKind(null)).toBe(false);
    expect(isEliminationKind("single_elim")).toBe(true);
    expect(isEliminationKind("round_robin")).toBe(false);
  });
});

describe("normaliseStageConfig", () => {
  it("fills everything in from nothing", () => {
    const config = normaliseStageConfig("double_elim", null);
    expect(config).toEqual(defaultStageConfig("double_elim"));
    expect(config.bestOf).toBe(3);
    expect(config.bestOfBySlot).toEqual({ gf: 5 });
    expect(config.bracketReset).toBe(false);
    expect(config.tiebreakers).toEqual(DEFAULT_TIEBREAKERS);
  });

  it("makes a round robin Bo1, the way the current board runs it", () => {
    expect(normaliseStageConfig("round_robin", null).bestOf).toBe(1);
    expect(normaliseStageConfig("round_robin", null).bestOfBySlot).toEqual({});
  });

  it("rounds an even series length down to an odd one rather than dropping it", () => {
    expect(normaliseStageConfig("single_elim", { bestOf: 4 as 3 }).bestOf).toBe(3);
    expect(normaliseStageConfig("single_elim", { bestOf: 2 as 3 }).bestOf).toBe(1);
    expect(normaliseStageConfig("single_elim", { bestOf: 99 as 3 }).bestOf).toBe(7);
    expect(normaliseStageConfig("single_elim", { bestOf: 0 as 3 }).bestOf).toBe(1);
  });

  it("reads a lower-final bronze in a single elimination as a separate match", () => {
    expect(normaliseStageConfig("single_elim", { bronze: "lower_final" }).bronze).toBe("separate");
  });

  it("reads a separate bronze in a double elimination as the lower final", () => {
    expect(normaliseStageConfig("double_elim", { bronze: "separate" }).bronze).toBe("lower_final");
  });

  it("keeps 'none' meaning none, in both shapes", () => {
    expect(normaliseStageConfig("single_elim", { bronze: "none" }).bronze).toBe("none");
    expect(normaliseStageConfig("double_elim", { bronze: "none" }).bronze).toBe("none");
  });

  it("has no bronze at all in a round robin", () => {
    expect(normaliseStageConfig("round_robin", { bronze: "separate" }).bronze).toBe("none");
  });

  it("takes the bronze rule of a group stage from its playoff", () => {
    expect(
      normaliseStageConfig("group_playoff", { playoffKind: "double_elim", bronze: "separate" })
        .bronze
    ).toBe("lower_final");
    expect(
      normaliseStageConfig("group_playoff", { playoffKind: "single_elim", bronze: "lower_final" })
        .bronze
    ).toBe("separate");
  });

  it("drops a bracket reset anywhere there is no lower bracket to come from", () => {
    expect(normaliseStageConfig("double_elim", { bracketReset: true }).bracketReset).toBe(true);
    expect(normaliseStageConfig("single_elim", { bracketReset: true }).bracketReset).toBe(false);
    expect(normaliseStageConfig("round_robin", { bracketReset: true }).bracketReset).toBe(false);
  });

  it("clamps the group settings to something a field can fill", () => {
    const config = normaliseStageConfig("group_playoff", { groups: 0, advancePerGroup: 99 });
    expect(config.groups).toBe(1);
    expect(config.advancePerGroup).toBe(MAX_TEAMS);
  });

  it("keeps a custom points rule and rejects junk in it", () => {
    const config = normaliseStageConfig("round_robin", {
      points: { win: 2, draw: 1, loss: -5 as 0 },
    });
    expect(config.points).toEqual({ win: 2, draw: 1, loss: 0 });
  });

  it("always finishes the tiebreaker list with a total rule", () => {
    expect(normaliseStageConfig("round_robin", { tiebreakers: ["diff"] }).tiebreakers).toEqual([
      "diff",
      "name",
    ]);
    expect(normaliseStageConfig("round_robin", { tiebreakers: [] }).tiebreakers).toEqual(
      DEFAULT_TIEBREAKERS
    );
    expect(
      normaliseStageConfig("round_robin", { tiebreakers: ["nonsense" as "diff"] }).tiebreakers
    ).toEqual(DEFAULT_TIEBREAKERS);
  });

  it("normalises a mode name rather than storing whatever was typed", () => {
    const config = normaliseStageConfig("single_elim", {
      modeSequence: { "3": ["  Convoy ", "Domination"] },
    });
    expect(config.modeSequence["3"]).toEqual(["convoy", "domination"]);
  });
});

describe("bestOfFor", () => {
  const config = normaliseStageConfig("double_elim", {
    bestOf: 3,
    bestOfByBracket: { rr: 1 },
    bestOfByRound: { "2": 5 },
    bestOfBySlot: { gf: 7 },
  });

  it("prefers the slot", () => {
    expect(bestOfFor(config, { slot: "gf", round: 2, bracket: "final" })).toBe(7);
  });

  it("then the round", () => {
    expect(bestOfFor(config, { slot: "ubf", round: 2, bracket: "upper" })).toBe(5);
  });

  it("then the half", () => {
    expect(bestOfFor(config, { slot: "rr-1-2", round: 1, bracket: "rr" })).toBe(1);
  });

  it("then the stage default", () => {
    expect(bestOfFor(config, { slot: "ubsf1", round: 1, bracket: "upper" })).toBe(3);
  });
});

describe("modesFor", () => {
  const config = normaliseStageConfig("double_elim", null);

  it("is the current board's rule, as data", () => {
    expect(modesFor(config, 1)).toEqual(["convoy"]);
    expect(modesFor(config, 3)).toEqual(DEFAULT_MODE_SEQUENCE["3"]);
    expect(modesFor(config, 5)).toEqual(DEFAULT_MODE_SEQUENCE["5"]);
  });

  it("is always exactly as long as the series", () => {
    for (const bestOf of [1, 3, 5, 7]) expect(modesFor(config, bestOf)).toHaveLength(bestOf);
  });

  it("repeats the last mode rather than leaving a game without one", () => {
    const short = normaliseStageConfig("double_elim", { modeSequence: { "5": ["a", "b"] } });
    expect(modesFor(short, 5)).toEqual(["a", "b", "b", "b", "b"]);
  });

  it("cuts a sequence that is too long", () => {
    const long = normaliseStageConfig("double_elim", {
      modeSequence: { "1": ["a", "b", "c"] },
    });
    expect(modesFor(long, 1)).toEqual(["a"]);
  });
});

describe("source references", () => {
  it("round-trips every shape", () => {
    const cases = ["seed:1", "winner:ubsf1", "loser:ubf", "group:a:rank:2"];
    for (const raw of cases) {
      const ref = parseSource(raw);
      expect(ref).not.toBeNull();
      expect(formatSource(ref!)).toBe(raw);
    }
  });

  it("refuses anything it does not recognise", () => {
    for (const raw of ["", "seed", "seed:0", "seed:x", "winner:", "group:a:2", "group:a:rank:x", null]) {
      expect(parseSource(raw), String(raw)).toBeNull();
    }
  });

  it("names the slot a reference waits on, and only for a result", () => {
    expect(sourceDependency("winner:ubf")).toBe("ubf");
    expect(sourceDependency("loser:lbr1")).toBe("lbr1");
    expect(sourceDependency("seed:3")).toBeNull();
    expect(sourceDependency("group:a:rank:1")).toBeNull();
  });
});

describe("timing", () => {
  it("falls back to the current board's numbers", () => {
    expect(normaliseFormatTiming(null)).toEqual(DEFAULT_FORMAT_TIMING);
    expect(normaliseFormatTiming({})).toEqual(DEFAULT_FORMAT_TIMING);
  });

  it("refuses a zero-length mode, which would collapse its block", () => {
    const timing = normaliseFormatTiming({ modeMinutes: { convoy: 0, domination: -4 } });
    expect(timing.modeMinutes.convoy).toBe(DEFAULT_FORMAT_TIMING.defaultMinutes);
    expect(timing.modeMinutes.domination).toBe(DEFAULT_FORMAT_TIMING.defaultMinutes);
  });

  it("allows zero-length breaks, which are a real choice", () => {
    const timing = normaliseFormatTiming({ betweenGames: 0, betweenSeries: 0 });
    expect(timing.betweenGames).toBe(0);
    expect(timing.betweenSeries).toBe(0);
  });

  it("gives a mode nobody has timed the default rather than nothing", () => {
    expect(modeMinutes(DEFAULT_FORMAT_TIMING, "escort")).toBe(30);
  });

  it("adds up a series the way the current board does", () => {
    // Bo3: 30 + 30 + 15, plus two five-minute breaks.
    expect(seriesMinutes(["convoy", "convoy", "domination"], DEFAULT_FORMAT_TIMING)).toBe(85);
    // Bo5: 30 × 4 + 15, plus four breaks.
    expect(
      seriesMinutes(
        ["convoy", "convoy", "convoy", "convoy", "domination"],
        DEFAULT_FORMAT_TIMING
      )
    ).toBe(155);
    expect(seriesMinutes(["convoy"], DEFAULT_FORMAT_TIMING)).toBe(30);
    expect(seriesMinutes([], DEFAULT_FORMAT_TIMING)).toBe(0);
  });
});

describe("small helpers", () => {
  it("counts the wins a series needs", () => {
    expect([1, 3, 5, 7].map(seriesTarget)).toEqual([1, 2, 3, 4]);
  });

  it("rounds up to a power of two", () => {
    expect([2, 3, 4, 5, 6, 7, 8].map(nextPowerOfTwo)).toEqual([2, 4, 4, 8, 8, 8, 8]);
  });

  it("writes ordinals in English, including the awkward teens", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
    ]);
  });

  it("names groups a, b, c", () => {
    expect([0, 1, 2].map(groupKey)).toEqual(["a", "b", "c"]);
  });
});
