import { describe, expect, it } from "vitest";
import {
  type ChampionshipScoring,
  type CountingEventInput,
  DEFAULT_POINTS_TABLE,
  duplicateMemberIn,
  scoreChampionship,
} from "@/lib/championship-policy";

/**
 * A season, scored (UC-33, UC-34 / R-172, R-173, R-176, R-177, R-180 to R-182).
 *
 * Everything here is plain data in and plain data out: no database, no clock.
 * That is what makes the correction case at the bottom a three-line test rather
 * than a fixture.
 */

const SCORING: ChampionshipScoring = {
  pointsTable: [10, 6, 3],
  participationPoints: 1,
  countBest: null,
};

/** One counting event, with defaults so each test states only what it is about. */
function event(over: Partial<CountingEventInput> = {}): CountingEventInput {
  return {
    id: over.id ?? "e1",
    weight: over.weight ?? 1,
    pointsTable: over.pointsTable ?? null,
    placements: over.placements ?? [],
    participants: over.participants ?? [],
  };
}

function member(userId: string) {
  return { kind: "member", userId } as const;
}

function team(teamId: string, ...memberIds: string[]) {
  return { kind: "team", teamId, memberIds } as const;
}

/** The standings as `userId -> points`, which is what most of these assert. */
function pointsOf(standings: ReturnType<typeof scoreChampionship>): Record<string, number> {
  return Object.fromEntries(standings.map((row) => [row.userId, row.points]));
}

describe("the default points table", () => {
  it("is the one UC-31 3 names", () => {
    expect(DEFAULT_POINTS_TABLE).toEqual([25, 18, 15, 12, 10, 8, 6, 4, 2, 1]);
  });
});

describe("scoring one event", () => {
  it("gives a place beyond the end of the table the taking-part points, weighted", () => {
    // UC-31 4 calls the participation points "what taking part is worth, for
    // anyone who played but finished outside the table" — so 4th on a table of
    // three is exactly that case, not a zero. Bob finishing outside the table
    // is worth precisely what Cat is worth for turning up, weight and all.
    const standings = scoreChampionship(SCORING, [
      event({
        weight: 2,
        placements: [
          { position: 1, subject: member("ann") },
          { position: 4, subject: member("bob") },
        ],
        participants: ["ann", "bob", "cat"],
      }),
    ]);

    expect(pointsOf(standings)).toEqual({ ann: 20, bob: 2, cat: 2 });
  });

  it("never lets a deeper place outscore a shallower one, however deep", () => {
    const standings = scoreChampionship(SCORING, [
      event({
        placements: [
          { position: 3, subject: member("ann") },
          { position: 99, subject: member("bob") },
        ],
        participants: [],
      }),
    ]);

    expect(pointsOf(standings)).toEqual({ ann: 3, bob: 1 });
  });

  it("gives each placed member their place's points", () => {
    const standings = scoreChampionship(SCORING, [
      event({
        placements: [
          { position: 1, subject: member("ann") },
          { position: 2, subject: member("bob") },
        ],
        participants: ["ann", "bob"],
      }),
    ]);

    expect(pointsOf(standings)).toEqual({ ann: 10, bob: 6 });
  });

  it("scores a team's place for every member of that team", () => {
    const standings = scoreChampionship(SCORING, [
      event({
        placements: [
          { position: 1, subject: team("reds", "ann", "bob") },
          { position: 2, subject: team("blues", "cat") },
        ],
        participants: ["ann", "bob", "cat"],
      }),
    ]);

    expect(pointsOf(standings)).toEqual({ ann: 10, bob: 10, cat: 6 });
    expect(standings.find((row) => row.userId === "ann")?.results[0].teamId).toBe("reds");
  });

  it("gives the taking-part points to somebody who played and was not placed", () => {
    const standings = scoreChampionship(SCORING, [
      event({
        placements: [{ position: 1, subject: member("ann") }],
        participants: ["ann", "bob"],
      }),
    ]);

    expect(pointsOf(standings)).toEqual({ ann: 10, bob: 1 });
    expect(standings.find((row) => row.userId === "bob")?.results[0].position).toBeNull();
  });

  it("leaves the next position empty when two subjects share a place", () => {
    // 1, 1, 3 — not 1, 1, 2. Both firsts are worth a first, and nobody is
    // second, so the table's second row is simply not used.
    const standings = scoreChampionship(SCORING, [
      event({
        placements: [
          { position: 1, subject: member("ann") },
          { position: 1, subject: member("bob") },
          { position: 3, subject: member("cat") },
        ],
        participants: ["ann", "bob", "cat"],
      }),
    ]);

    expect(pointsOf(standings)).toEqual({ ann: 10, bob: 10, cat: 3 });
  });

  it("multiplies every value by the event's weight, taking part included", () => {
    const standings = scoreChampionship(SCORING, [
      event({
        weight: 3,
        placements: [{ position: 1, subject: member("ann") }],
        participants: ["ann", "bob"],
      }),
    ]);

    expect(pointsOf(standings)).toEqual({ ann: 30, bob: 3 });
  });

  it("uses the event's own table instead of the championship's, still weighted", () => {
    const standings = scoreChampionship(SCORING, [
      event({
        weight: 2,
        pointsTable: [100, 50],
        placements: [
          { position: 1, subject: member("ann") },
          { position: 2, subject: member("bob") },
        ],
        participants: ["ann", "bob"],
      }),
    ]);

    expect(pointsOf(standings)).toEqual({ ann: 200, bob: 100 });
  });

  it("falls back to the championship's table when the event's is empty", () => {
    const standings = scoreChampionship(SCORING, [
      event({
        pointsTable: [],
        placements: [{ position: 1, subject: member("ann") }],
        participants: ["ann"],
      }),
    ]);

    expect(pointsOf(standings)).toEqual({ ann: 10 });
  });

  it("counts a member exactly once when they are placed twice by mistake", () => {
    // The editor refuses this (see `duplicateMemberIn` below) and the database
    // refuses the straightforward version of it, but a member joining a team
    // after the fact can still produce it — so scoring stays total and takes
    // the result worth the most rather than adding both.
    const standings = scoreChampionship(SCORING, [
      event({
        placements: [
          { position: 3, subject: member("ann") },
          { position: 1, subject: team("reds", "ann") },
        ],
        participants: ["ann"],
      }),
    ]);

    expect(pointsOf(standings)).toEqual({ ann: 10 });
    expect(standings[0].results).toHaveLength(1);
  });
});

describe("input the arithmetic cannot represent", () => {
  // The columns refuse all of these; the preview caller — an order being typed
  // and not yet saved — has no database to refuse them, and every one of them
  // used to degrade silently rather than fail.

  it.each([0, -1, 1.5])("refuses a finishing position of %s, naming it", (position) => {
    expect(() =>
      scoreChampionship(SCORING, [
        event({ id: "night-four", placements: [{ position, subject: member("ann") }] }),
      ])
    ).toThrow(`A finishing position must be a whole number of 1 or more; event night-four has ${position}.`);
  });

  it.each([0, -2, 2.5])("refuses a countBest of %s, naming it", (countBest) => {
    expect(() => scoreChampionship({ ...SCORING, countBest }, [event({})])).toThrow(
      `countBest must be a whole number of 1 or more, or null to count everything; got ${countBest}.`
    );
  });

  it("is happy with the smallest legal values", () => {
    const standings = scoreChampionship({ ...SCORING, countBest: 1 }, [
      event({ placements: [{ position: 1, subject: member("ann") }] }),
    ]);
    expect(pointsOf(standings)).toEqual({ ann: 10 });
  });
});

describe("duplicateMemberIn", () => {
  it("names a member who appears twice, directly and through a team", () => {
    expect(
      duplicateMemberIn([
        { position: 1, subject: team("reds", "ann", "bob") },
        { position: 2, subject: member("ann") },
      ])
    ).toBe("ann");
  });

  it("names a member who is on two placed teams", () => {
    expect(
      duplicateMemberIn([
        { position: 1, subject: team("reds", "ann") },
        { position: 2, subject: team("blues", "ann") },
      ])
    ).toBe("ann");
  });

  it("is happy with an order in which everybody appears once", () => {
    expect(
      duplicateMemberIn([
        { position: 1, subject: team("reds", "ann", "bob") },
        { position: 2, subject: member("cat") },
      ])
    ).toBeNull();
  });
});

describe("counting only the best results", () => {
  const three = [
    event({
      id: "e1",
      placements: [{ position: 1, subject: member("ann") }],
      participants: ["ann"],
    }),
    event({
      id: "e2",
      placements: [{ position: 3, subject: member("ann") }],
      participants: ["ann"],
    }),
    event({
      id: "e3",
      placements: [{ position: 2, subject: member("ann") }],
      participants: ["ann"],
    }),
  ];

  it("adds everything up when countBest is not set", () => {
    expect(pointsOf(scoreChampionship(SCORING, three))).toEqual({ ann: 19 });
  });

  it("keeps each member's best N and drops the rest", () => {
    const standings = scoreChampionship({ ...SCORING, countBest: 2 }, three);
    expect(pointsOf(standings)).toEqual({ ann: 16 });
    expect(standings[0].counted).toBe(2);
    expect(standings[0].played).toBe(3);
  });

  it("keeps every result in the breakdown, marking the dropped ones", () => {
    const standings = scoreChampionship({ ...SCORING, countBest: 2 }, three);
    expect(standings[0].results.map((r) => [r.eventId, r.points, r.counted])).toEqual([
      ["e1", 10, true],
      ["e2", 3, false],
      ["e3", 6, true],
    ]);
  });

  it("counts a dropped result's place towards nothing", () => {
    // `places` is the tiebreaker, and it reads the counted results only — the
    // same total the page shows the points for.
    const standings = scoreChampionship({ ...SCORING, countBest: 1 }, three);
    expect(standings[0].places).toEqual([1]);
  });

  it("applies the limit per member, not per season", () => {
    const standings = scoreChampionship({ ...SCORING, countBest: 1 }, [
      ...three,
      event({
        id: "e4",
        placements: [{ position: 2, subject: member("bob") }],
        participants: ["bob"],
      }),
    ]);
    expect(pointsOf(standings)).toEqual({ ann: 10, bob: 6 });
  });
});

describe("the tie rule", () => {
  /**
   * Points first, then most firsts, then most seconds, and so on. Each row
   * builds a season from two members' finishing positions alone, on a table
   * where every place is worth the same, so only the tie rule can separate them.
   */
  const FLAT: ChampionshipScoring = {
    pointsTable: [6, 6, 6, 6, 6, 6],
    participationPoints: 0,
    countBest: null,
  };

  function season(annPlaces: number[], bobPlaces: number[]): CountingEventInput[] {
    const length = Math.max(annPlaces.length, bobPlaces.length);
    return Array.from({ length }, (_, i) => ({
      id: `e${i}`,
      weight: 1,
      pointsTable: null,
      placements: [
        ...(annPlaces[i] ? [{ position: annPlaces[i], subject: member("ann") }] : []),
        ...(bobPlaces[i] ? [{ position: bobPlaces[i], subject: member("bob") }] : []),
      ],
      participants: [],
    }));
  }

  it.each([
    {
      // The leg that separates this rule from one that counted places first:
      // Ann holds the only first place in the season and still loses, because
      // points are asked about before any place is counted at all.
      why: "points come first — fewer points never wins on better places",
      ann: [1],
      bob: [2, 2],
      expected: ["bob", "ann"],
      level: false,
    },
    {
      why: "winning more events simply scores more",
      ann: [1, 1],
      bob: [1, 1, 1],
      expected: ["bob", "ann"],
      level: false,
    },
    {
      why: "level on points, more firsts wins",
      ann: [1, 3],
      bob: [2, 2],
      expected: ["ann", "bob"],
      level: false,
    },
    {
      // Bob holds the deepest place in the season and Ann holds none that
      // deep, so this is the case that pins which end of the table is asked
      // about first: a first place beats any number of deeper ones.
      why: "the shallowest place is asked about first, not the deepest",
      ann: [1, 2],
      bob: [3, 4],
      expected: ["ann", "bob"],
      level: false,
    },
    {
      why: "level on points and firsts, more seconds wins",
      ann: [1, 2, 4],
      bob: [1, 3, 3],
      expected: ["ann", "bob"],
      level: false,
    },
    {
      // The same guard one leg further in: level on firsts, Ann wins on
      // seconds, and Bob's fourth place does not rescue him.
      why: "level on firsts, more seconds wins over a deeper place",
      ann: [1, 2, 3],
      bob: [1, 3, 4],
      expected: ["ann", "bob"],
      level: false,
    },
    {
      why: "level on points, firsts and seconds, more thirds wins",
      ann: [1, 2, 3, 5],
      bob: [1, 2, 4, 4],
      expected: ["ann", "bob"],
      level: false,
    },
    {
      why: "a deeper place never beats a shallower one",
      ann: [2, 2],
      bob: [1, 4],
      expected: ["bob", "ann"],
      level: false,
    },
    {
      why: "identical records survive the rule and are shown level",
      ann: [1, 3],
      bob: [3, 1],
      expected: ["ann", "bob"],
      level: true,
    },
  ])("$why", ({ ann, bob, expected, level }) => {
    const standings = scoreChampionship(FLAT, season(ann, bob));
    expect(standings.map((row) => row.userId)).toEqual(expected);
    expect(standings.every((row) => row.level)).toBe(level);
  });

  it("gives everyone level the same position and leaves the next one empty", () => {
    const standings = scoreChampionship(FLAT, season([1, 3], [3, 1]));
    expect(standings.map((row) => row.position)).toEqual([1, 1]);
  });

  it("numbers positions 1, 1, 3 when two lead and one trails", () => {
    const standings = scoreChampionship(
      FLAT,
      Array.from({ length: 2 }, (_, i) => ({
        id: `e${i}`,
        weight: 1,
        pointsTable: null,
        placements: [
          { position: 1, subject: member("ann") },
          { position: 1, subject: member("bob") },
          ...(i === 0 ? [{ position: 2, subject: member("cat") }] : []),
        ],
        participants: [],
      }))
    );

    expect(standings.map((row) => [row.userId, row.position, row.level])).toEqual([
      ["ann", 1, true],
      ["bob", 1, true],
      ["cat", 3, false],
    ]);
  });
});

describe("correcting a placement", () => {
  it("re-scores the whole season with nothing stale left behind", () => {
    // The point of the module: the standings are a function of the placements,
    // so the "before" cannot survive anywhere once the placements change.
    const before = [
      event({
        id: "e1",
        placements: [
          { position: 1, subject: member("ann") },
          { position: 2, subject: member("bob") },
        ],
        participants: ["ann", "bob"],
      }),
      event({
        id: "e2",
        placements: [
          { position: 1, subject: member("bob") },
          { position: 2, subject: member("ann") },
        ],
        participants: ["ann", "bob"],
      }),
    ];

    const first = scoreChampionship(SCORING, before);
    expect(pointsOf(first)).toEqual({ ann: 16, bob: 16 });
    expect(first.map((row) => row.position)).toEqual([1, 1]);

    // e1 is corrected three days later: Bob won it after all.
    const after = [
      {
        ...before[0],
        placements: [
          { position: 1, subject: member("bob") },
          { position: 2, subject: member("ann") },
        ],
      },
      before[1],
    ];

    const second = scoreChampionship(SCORING, after);
    expect(pointsOf(second)).toEqual({ bob: 20, ann: 12 });
    expect(second.map((row) => [row.userId, row.position, row.level])).toEqual([
      ["bob", 1, false],
      ["ann", 2, false],
    ]);
    // And Ann's own breakdown no longer claims the first place she had.
    expect(second.find((row) => row.userId === "ann")?.results.map((r) => r.position)).toEqual([
      2, 2,
    ]);
  });

  it("drops a member entirely once they are taken out of every event", () => {
    const scored = scoreChampionship(SCORING, [
      event({ placements: [{ position: 1, subject: member("ann") }], participants: ["ann"] }),
    ]);
    expect(scored.map((row) => row.userId)).toEqual(["ann"]);

    expect(scoreChampionship(SCORING, [event({})])).toEqual([]);
  });
});
