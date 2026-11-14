import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Hero, HeroRole, SettingValue } from "@/db";
import { HEROES_PER_ROLE, eventShapeFrom } from "@/lib/events-policy";
import { HERO_ROLES } from "@/lib/heroes";
import { drawHand } from "@/lib/heroes-policy";

/**
 * Task 142 — an event says whether it draws heroes, and how wide a hand
 * (R-269, R-270 / UC-58 1-6, 5a).
 *
 * Three things, none of which needs a database:
 *
 *  - **The resolver's defaults**, which are the whole safety argument: every
 *    event that exists has no hero key, so nothing stored has to read as "on,
 *    three per role". Asserted against configs that hold **no hero key at
 *    all** — a config holding the default would pass with a resolver that had
 *    no default.
 *  - **`drawHand` deals the width it is handed**, at three and at other
 *    widths, and its thin-role refusal names that width rather than three.
 *  - **Nothing reads `HEROES_PER_ROLE` as the live answer**, swept over the
 *    source: the constant is the resolver's fallback and nothing else.
 *
 * A width other than three cannot be *stored* yet —
 * `hero_hands_nine_distinct_per_role` still requires nine ids — so every
 * other-width assertion here is over the pure function, never a round trip.
 */

/* ------------------------------------------------------------------ */
/* The resolver                                                       */
/* ------------------------------------------------------------------ */

describe("whether an event draws heroes, and how wide", () => {
  it.each([
    ["no config at all", null],
    ["an undefined config", undefined],
    ["an empty config", {}],
    ["a config with other keys and no shape", { teamFormat: "3v3", waitlist: false }],
    [
      "a stored shape from before the hero answers existed",
      { eventShape: { teamEvent: true, draft: true, sizing: { mode: "perTeam", value: 6 } } },
    ],
  ] as const)("reads %s as drawing heroes, three per role", (_label, config) => {
    // The fixture really has no hero key — the easy fake is a config that
    // holds the default, which proves nothing about what absent means.
    expect(JSON.stringify(config ?? {})).not.toMatch(/hero/i);

    const shape = eventShapeFrom(config);

    expect(shape.heroes).toBe(true);
    expect(shape.heroesPerRole).toBe(3);
  });

  it("falls back to the one constant, which is three", () => {
    expect(HEROES_PER_ROLE).toBe(3);
    expect(eventShapeFrom({}).heroesPerRole).toBe(HEROES_PER_ROLE);
  });

  it("is off only for a stored false", () => {
    expect(eventShapeFrom({ eventShape: { heroes: false } }).heroes).toBe(false);
  });

  it.each<[SettingValue]>([["false"], [0], [null], ["off"], [[false]]])(
    "reads a stored %j as not said, so the event still draws",
    (stored) => {
      expect(eventShapeFrom({ eventShape: { heroes: stored } }).heroes).toBe(true);
    }
  );

  it.each([[1], [2], [5]] as const)("reads a stored width of %i as that width", (width) => {
    expect(eventShapeFrom({ eventShape: { heroesPerRole: width } }).heroesPerRole).toBe(width);
  });

  it.each<[SettingValue]>([[0], [-2], [2.5], ["4"], [null], [[4]]])(
    "reads a stored width of %j as three, because it is not a count",
    (stored) => {
      expect(eventShapeFrom({ eventShape: { heroesPerRole: stored } }).heroesPerRole).toBe(3);
    }
  );

  it("keeps the width while the toggle is off, so turning it back on restores it", () => {
    const shape = eventShapeFrom({ eventShape: { heroes: false, heroesPerRole: 2 } });

    expect(shape.heroes).toBe(false);
    expect(shape.heroesPerRole).toBe(2);
  });

  it("reads the answers from inside the shape, not from a top-level key", () => {
    // `saveEventShapeAction` writes `config.eventShape` whole; a second home
    // for the same answer would be a disagreement waiting to happen.
    const shape = eventShapeFrom({ heroes: false, heroesPerRole: 5 });

    expect(shape.heroes).toBe(true);
    expect(shape.heroesPerRole).toBe(3);
  });

  it("leaves the three answers the shape already held alone", () => {
    const stored = { teamEvent: false, draft: true, sizing: { mode: "teams", value: 4 } } as const;

    const shape = eventShapeFrom({ eventShape: { ...stored, heroes: false, heroesPerRole: 2 } });

    expect(shape).toEqual({ ...stored, heroes: false, heroesPerRole: 2 });
  });
});

/* ------------------------------------------------------------------ */
/* The draw, at the width it is handed                                */
/* ------------------------------------------------------------------ */

function hero(name: string, roles: HeroRole[]): Hero {
  return {
    id: `id-${name}`,
    gameId: "game",
    name,
    roles,
    retiredAt: null,
    createdAt: new Date("2026-10-23T00:00:00Z"),
  };
}

function poolsOf(sizes: Record<HeroRole, number>): Record<HeroRole, Hero[]> {
  return {
    Vanguard: Array.from({ length: sizes.Vanguard }, (_, i) => hero(`V${i + 1}`, ["Vanguard"])),
    Duelist: Array.from({ length: sizes.Duelist }, (_, i) => hero(`D${i + 1}`, ["Duelist"])),
    Strategist: Array.from({ length: sizes.Strategist }, (_, i) =>
      hero(`S${i + 1}`, ["Strategist"])
    ),
  };
}

/** The numbers in order, counting how many were taken, throwing past the end. */
function counted(draws: readonly number[]) {
  let taken = 0;
  return {
    random: () => {
      if (taken >= draws.length) throw new Error("the draw asked for more numbers than given");
      return draws[taken++];
    },
    taken: () => taken,
  };
}

function thrower(): () => number {
  return () => {
    throw new Error("the draw rolled when it should have refused");
  };
}

const names = (result: ReturnType<typeof drawHand>) => {
  if (!result.ok) throw new Error(result.error);
  return Object.fromEntries(HERO_ROLES.map((role) => [role, result.hand[role].map((h) => h.name)]));
};

const refusal = (result: ReturnType<typeof drawHand>) => {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
};

/**
 * `hero-hands.test.ts`'s `SEQUENCE_A` over pools of four, and the shuffled
 * pools it leaves — worked there for the Duelists. The hand at any width is
 * the front of these, which is what the literals below pin.
 */
const FOUR_EACH = { Vanguard: 4, Duelist: 4, Strategist: 4 };
const SEQUENCE = [0, 0, 0, 0.9, 0.5, 0.1, 0.5, 0.9, 0.5];

describe("drawHand at the event's width", () => {
  it("deals three in each role when handed three", () => {
    expect(names(drawHand(poolsOf(FOUR_EACH), counted(SEQUENCE).random, 3))).toEqual({
      Vanguard: ["V2", "V3", "V4"],
      Duelist: ["D3", "D1", "D2"],
      Strategist: ["S1", "S2", "S4"],
    });
  });

  it("deals two in each role when handed two", () => {
    expect(names(drawHand(poolsOf(FOUR_EACH), counted(SEQUENCE).random, 2))).toEqual({
      Vanguard: ["V2", "V3"],
      Duelist: ["D3", "D1"],
      Strategist: ["S1", "S2"],
    });
  });

  it("deals one in each role when handed one", () => {
    expect(names(drawHand(poolsOf(FOUR_EACH), counted(SEQUENCE).random, 1))).toEqual({
      Vanguard: ["V2"],
      Duelist: ["D3"],
      Strategist: ["S1"],
    });
  });

  it("deals the whole pool when handed its size — four from four", () => {
    expect(names(drawHand(poolsOf(FOUR_EACH), counted(SEQUENCE).random, 4))).toEqual({
      Vanguard: ["V2", "V3", "V4", "V1"],
      Duelist: ["D3", "D1", "D2", "D4"],
      Strategist: ["S1", "S2", "S4", "S3"],
    });
  });

  it.each([[1], [2], [3], [4]] as const)(
    "burns the same nine numbers over pools of four at a width of %i",
    (width) => {
      // One whole shuffle per role whatever the width: a pool of four burns
      // three numbers, so a seeded hand at three is the hand it always was.
      const source = counted(SEQUENCE);

      drawHand(poolsOf(FOUR_EACH), source.random, width);

      expect(source.taken()).toBe(9);
    }
  );
});

describe("a role too thin for the event's width (UC-58 5a)", () => {
  it("names the five that was asked for, not three", () => {
    const result = drawHand(poolsOf({ Vanguard: 15, Duelist: 28, Strategist: 4 }), thrower(), 5);

    expect(refusal(result)).toBe(
      "Strategist has 4 heroes. A draw needs 5 in each role, so nothing was dealt. Add more on the game's hero list."
    );
  });

  it("names every role thin for that width", () => {
    const result = drawHand(poolsOf({ Vanguard: 3, Duelist: 28, Strategist: 1 }), thrower(), 4);

    expect(refusal(result)).toBe(
      "Vanguard has 3 heroes and Strategist has 1 hero. A draw needs 4 in each role, so nothing was dealt. Add more on the game's hero list."
    );
  });

  it("deals at one from pools three would have refused", () => {
    expect(
      names(drawHand(poolsOf({ Vanguard: 1, Duelist: 1, Strategist: 1 }), thrower(), 1))
    ).toEqual({
      Vanguard: ["V1"],
      Duelist: ["D1"],
      Strategist: ["S1"],
    });
  });

  it("still refuses an empty role at a width of one, and says one", () => {
    const result = drawHand(poolsOf({ Vanguard: 1, Duelist: 0, Strategist: 1 }), thrower(), 1);

    expect(refusal(result)).toBe(
      "Duelist has 0 heroes. A draw needs 1 in each role, so nothing was dealt. Add more on the game's hero list."
    );
  });
});

/* ------------------------------------------------------------------ */
/* Nothing reads the constant as the live answer                      */
/* ------------------------------------------------------------------ */

const SRC = path.resolve(__dirname, "../..").replace(/\\/g, "/");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry).replace(/\\/g, "/");
    if (statSync(full).isDirectory()) return entry === "__tests__" ? [] : walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/**
 * The source with its comments blanked, so prose naming the constant is not a
 * read of it.
 *
 * **Not string-aware.** A `/*` inside a string or a regex literal would blank
 * real code up to the next block-comment close, and a read of the constant in
 * that stretch would go unseen. Shipped source held none when this was
 * written; a file that gains one makes this sweep quieter than it looks.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""))
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** Every line of shipped code that names the constant, as `file: line`. */
function readsOfTheConstant(): string[] {
  return walk(SRC).flatMap((file) =>
    code(readFileSync(file, "utf8"))
      .split("\n")
      .filter((line) => /\bHEROES_PER_ROLE\b/.test(line))
      .map((line) => `${file.slice(SRC.length + 1)}: ${line.trim()}`)
  );
}

describe("HEROES_PER_ROLE", () => {
  it("is swept for over the whole of the shipped source", () => {
    // The floor: a walk that found nothing would report a clean sweep.
    const files = walk(SRC);
    expect(files.length).toBeGreaterThanOrEqual(150);
    expect(files).toContain(`${SRC}/lib/heroes-policy.ts`);
    expect(files).toContain(`${SRC}/lib/hero-hands.ts`);
    expect(files).toContain(`${SRC}/app/events/[slug]/draw/draw.ts`);
  });

  it("does not count a comment as a read, and does count code", () => {
    const sample = [
      "/** {@link HEROES_PER_ROLE} in a docblock */",
      "// HEROES_PER_ROLE in a line comment",
      "const live = HEROES_PER_ROLE; // and a trailing one",
      'const url = "https://example.test/HEROES_PER_ROLE";',
    ].join("\n");

    expect(code(sample).split("\n").map((line) => line.trimEnd())).toEqual([
      "",
      "",
      "const live = HEROES_PER_ROLE;",
      'const url = "https://example.test/HEROES_PER_ROLE";',
    ]);
  });

  it("is declared once, read once as the resolver's fallback, and read nowhere else", () => {
    expect(readsOfTheConstant()).toEqual([
      "lib/events-policy.ts: export const HEROES_PER_ROLE = 3;",
      "lib/events-policy.ts: : HEROES_PER_ROLE;",
    ]);
  });
});
