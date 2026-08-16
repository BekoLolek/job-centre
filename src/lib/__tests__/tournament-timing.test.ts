import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMING,
  blankGamesFor,
  dayMinutes,
  modeForGame,
  normaliseTiming,
  schedulePlan,
  seriesMinutes,
} from "@/lib/tournament";
import type { Timing } from "@/lib/types";

/** convoy 30, domination 15, betweenGames 5, betweenSeries 10 */
const D = DEFAULT_TIMING;

/** A deliberately different set, to prove nothing is hard-coded to the defaults. */
const CUSTOM: Timing = { convoy: 20, domination: 10, betweenGames: 3, betweenSeries: 7 };

describe("modeForGame", () => {
  it("makes a best-of-1 a convoy map", () => {
    expect(modeForGame(1, 1)).toBe("convoy");
  });

  it("makes the last game of a best-of-3 the domination decider", () => {
    expect(modeForGame(3, 1)).toBe("convoy");
    expect(modeForGame(3, 2)).toBe("convoy");
    expect(modeForGame(3, 3)).toBe("domination");
  });

  it("makes the last game of a best-of-5 the domination decider", () => {
    expect([1, 2, 3, 4].map((n) => modeForGame(5, n))).toEqual([
      "convoy",
      "convoy",
      "convoy",
      "convoy",
    ]);
    expect(modeForGame(5, 5)).toBe("domination");
  });

  it("never turns game 1 of a best-of-1 into a decider", () => {
    // bestOf === 1 is special-cased before the "last game" rule.
    expect(modeForGame(1, 1)).not.toBe("domination");
  });
});

describe("blankGamesFor", () => {
  it("creates one unplayed game per map, with the right modes", () => {
    const games = blankGamesFor(3);
    expect(games).toHaveLength(3);
    expect(games.map((g) => g.mode)).toEqual(["convoy", "convoy", "domination"]);
    expect(games.every((g) => !g.played && g.scoreA === 0 && g.scoreB === 0)).toBe(true);
    expect(games.every((g) => g.map === "" && g.referee === "")).toBe(true);
  });

  it("returns independent game objects", () => {
    const games = blankGamesFor(3);
    games[0].scoreA = 9;
    expect(games[1].scoreA).toBe(0);
  });
});

describe("normaliseTiming", () => {
  it("falls back to every default for null / undefined input", () => {
    expect(normaliseTiming(null)).toEqual(D);
    expect(normaliseTiming(undefined)).toEqual(D);
    expect(normaliseTiming({})).toEqual(D);
  });

  it("keeps valid values", () => {
    expect(normaliseTiming(CUSTOM)).toEqual(CUSTOM);
  });

  it("falls back per field, leaving the good ones alone", () => {
    expect(normaliseTiming({ convoy: 45, domination: -1 })).toEqual({
      ...D,
      convoy: 45,
    });
  });

  it("rejects negative values", () => {
    expect(normaliseTiming({ convoy: -5, betweenGames: -1, betweenSeries: -20 })).toEqual(D);
  });

  it("rejects values above the per-field maximum", () => {
    expect(normaliseTiming({ convoy: 601 }).convoy).toBe(D.convoy);
    expect(normaliseTiming({ domination: 601 }).domination).toBe(D.domination);
    expect(normaliseTiming({ betweenGames: 241 }).betweenGames).toBe(D.betweenGames);
    expect(normaliseTiming({ betweenSeries: 241 }).betweenSeries).toBe(D.betweenSeries);
  });

  it("accepts the maximum itself", () => {
    expect(normaliseTiming({ convoy: 600, domination: 600 })).toMatchObject({
      convoy: 600,
      domination: 600,
    });
    expect(normaliseTiming({ betweenGames: 240, betweenSeries: 240 })).toMatchObject({
      betweenGames: 240,
      betweenSeries: 240,
    });
  });

  it("rejects junk: strings, NaN, Infinity, objects", () => {
    const junk = { convoy: "abc", domination: NaN, betweenGames: Infinity, betweenSeries: {} };
    expect(normaliseTiming(junk as unknown as Partial<Timing>)).toEqual(D);
  });

  it("coerces numeric strings", () => {
    expect(normaliseTiming({ convoy: "45" } as unknown as Partial<Timing>).convoy).toBe(45);
  });

  it("rounds fractional values to whole minutes", () => {
    expect(normaliseTiming({ convoy: 45.6, betweenGames: 4.4 })).toMatchObject({
      convoy: 46,
      betweenGames: 4,
    });
  });

  it("treats a zero game length as unset, since a match cannot take no time", () => {
    expect(normaliseTiming({ convoy: 0 }).convoy).toBe(D.convoy);
    expect(normaliseTiming({ domination: 0 }).domination).toBe(D.domination);
  });

  it("allows zero-length breaks", () => {
    expect(normaliseTiming({ betweenGames: 0, betweenSeries: 0 })).toMatchObject({
      betweenGames: 0,
      betweenSeries: 0,
    });
  });

  it("never returns a partial object", () => {
    const out = normaliseTiming({ convoy: 40 });
    expect(Object.keys(out).sort()).toEqual([
      "betweenGames",
      "betweenSeries",
      "convoy",
      "domination",
    ]);
  });
});

describe("seriesMinutes", () => {
  it("computes a best-of-1 on the defaults: one convoy map", () => {
    expect(seriesMinutes(1, D)).toBe(30);
  });

  it("computes a best-of-3 on the defaults: 30 + 30 + 15 + two 5' breaks", () => {
    expect(seriesMinutes(3, D)).toBe(85);
  });

  it("computes a best-of-5 on the defaults: four convoys + 15 + four 5' breaks", () => {
    expect(seriesMinutes(5, D)).toBe(155);
  });

  it("computes the same three on a custom timing set", () => {
    expect(seriesMinutes(1, CUSTOM)).toBe(20); // 20
    expect(seriesMinutes(3, CUSTOM)).toBe(56); // 20+20+10 + 2*3
    expect(seriesMinutes(5, CUSTOM)).toBe(102); // 4*20+10 + 4*3
  });

  it("charges no break for a single-game series", () => {
    expect(seriesMinutes(1, { ...D, betweenGames: 99 })).toBe(30);
  });

  it("counts the breaks between games only, not after the last one", () => {
    const withoutBreaks = seriesMinutes(3, { ...D, betweenGames: 0 });
    expect(withoutBreaks).toBe(75);
    expect(seriesMinutes(3, D) - withoutBreaks).toBe(2 * D.betweenGames);
  });
});

describe("schedulePlan", () => {
  const plan = schedulePlan(D);

  it("lays out seven blocks, five on day 1 and two on day 2", () => {
    expect(plan).toHaveLength(7);
    expect(plan.filter((p) => p.day === 1)).toHaveLength(5);
    expect(plan.filter((p) => p.day === 2)).toHaveLength(2);
  });

  it("places every block at the hand-computed default offset", () => {
    expect(
      plan.map((p) => [p.day, p.label, p.offsetMin, p.lengthMin])
    ).toEqual([
      [1, "Round robin 1", 0, 30],
      [1, "Round robin 2", 40, 30],
      [1, "Round robin 3", 80, 30],
      [1, "Upper semis", 120, 85],
      [1, "Upper final + lower round 1", 215, 85],
      [2, "Lower final · bronze", 0, 85],
      [2, "Grand final", 95, 155],
    ]);
  });

  it("does the same for a custom timing set", () => {
    expect(schedulePlan(CUSTOM).map((p) => [p.offsetMin, p.lengthMin])).toEqual([
      [0, 20],
      [27, 20],
      [54, 20],
      [81, 56],
      [144, 56],
      [0, 56],
      [63, 102],
    ]);
  });

  it("restarts the cursor for day 2", () => {
    expect(plan.find((p) => p.day === 2)?.offsetMin).toBe(0);
  });

  it("leaves exactly one series break between consecutive blocks of a day", () => {
    const day1 = plan.filter((p) => p.day === 1);
    for (let i = 1; i < day1.length; i++) {
      const prev = day1[i - 1];
      expect(day1[i].offsetMin - (prev.offsetMin + prev.lengthMin)).toBe(D.betweenSeries);
    }
  });

  it("keeps the matches of a block together, so parallel pairs share an offset", () => {
    expect(plan.map((p) => p.ids)).toEqual([
      ["rr-c1-c2", "rr-c3-c4"],
      ["rr-c1-c3", "rr-c2-c4"],
      ["rr-c1-c4", "rr-c2-c3"],
      ["ubsf1", "ubsf2"],
      ["ubf", "lbr1"],
      ["lbf"],
      ["gf"],
    ]);
  });
});

describe("dayMinutes", () => {
  it("ends each day at its last block, with no trailing break (defaults)", () => {
    expect(dayMinutes(D)).toEqual({ day1: 300, day2: 250 });
  });

  it("does the same for a custom timing set", () => {
    expect(dayMinutes(CUSTOM)).toEqual({ day1: 200, day2: 165 });
  });

  it("stays in step with the plan", () => {
    const plan = schedulePlan(D);
    const last1 = plan.filter((p) => p.day === 1).at(-1)!;
    const last2 = plan.filter((p) => p.day === 2).at(-1)!;
    expect(dayMinutes(D).day1).toBe(last1.offsetMin + last1.lengthMin);
    expect(dayMinutes(D).day2).toBe(last2.offsetMin + last2.lengthMin);
  });

  it("shrinks when the breaks are removed", () => {
    const noBreaks = dayMinutes({ ...D, betweenSeries: 0 });
    expect(noBreaks.day1).toBe(300 - 4 * D.betweenSeries);
    expect(noBreaks.day2).toBe(250 - D.betweenSeries);
  });
});
