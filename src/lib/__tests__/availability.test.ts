import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  type PersonAvailability,
  clockAt,
  getAvailability,
  getEveryoneAvailability,
  mergeExceptions,
  mergeRules,
  rangeRefusal,
  refusedOn,
  resolveFor,
  setAvailability,
  tallyWeek,
  weekDays,
} from "@/lib/availability";

/**
 * General availability.
 *
 * The interesting behaviour is not the storage, it is the three rules that
 * make the answer readable: overlapping windows fold together, a named date
 * replaces the weekly pattern entirely, and a person only counts for a slot
 * they cover all of.
 */

let handle: TestDatabase;
let db: Database;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
});

afterAll(async () => {
  await handle.close();
});

const monday = { year: 2026, month: 8, day: 24 };

/* ------------------------------------------------------------------ */
/* Folding                                                            */
/* ------------------------------------------------------------------ */

describe("mergeRules", () => {
  it("folds two windows that overlap into one", () => {
    const merged = mergeRules([
      { weekday: 1, startMinute: 1080, endMinute: 1260, state: "yes" },
      { weekday: 1, startMinute: 1200, endMinute: 1380, state: "yes" },
    ]);
    expect(merged).toEqual([{ weekday: 1, startMinute: 1080, endMinute: 1380, state: "yes" }]);
  });

  it("folds two windows that merely touch, because a seam is not a gap", () => {
    const merged = mergeRules([
      { weekday: 3, startMinute: 600, endMinute: 720, state: "yes" },
      { weekday: 3, startMinute: 720, endMinute: 840, state: "yes" },
    ]);
    expect(merged).toEqual([{ weekday: 3, startMinute: 600, endMinute: 840, state: "yes" }]);
  });

  it("leaves a real gap alone", () => {
    const merged = mergeRules([
      { weekday: 3, startMinute: 600, endMinute: 660, state: "yes" },
      { weekday: 3, startMinute: 720, endMinute: 840, state: "yes" },
    ]);
    expect(merged).toHaveLength(2);
  });

  it("keeps different days apart", () => {
    const merged = mergeRules([
      { weekday: 1, startMinute: 600, endMinute: 720, state: "yes" },
      { weekday: 2, startMinute: 600, endMinute: 720, state: "yes" },
    ]);
    expect(merged).toHaveLength(2);
  });

  it("drops a maybe that a yes already covers", () => {
    const merged = mergeRules([
      { weekday: 4, startMinute: 1080, endMinute: 1440, state: "yes" },
      { weekday: 4, startMinute: 1200, endMinute: 1380, state: "maybe" },
    ]);
    expect(merged).toEqual([{ weekday: 4, startMinute: 1080, endMinute: 1440, state: "yes" }]);
  });

  it("keeps a maybe that reaches past the yes", () => {
    const merged = mergeRules([
      { weekday: 4, startMinute: 1080, endMinute: 1260, state: "yes" },
      { weekday: 4, startMinute: 1080, endMinute: 1440, state: "maybe" },
    ]);
    expect(merged).toHaveLength(2);
  });
});

/*
 * UC-06 7d: "Ranges on the same day overlap - System merges them into one and
 * saves." The approved amendment to 7b in docs/plan.md — overlapping ranges
 * were written as an error and merge instead, because merging loses nothing.
 * The rule holds for a named date exactly as it does for the usual week.
 */
describe("mergeExceptions", () => {
  const range = (
    over: Partial<{
      date: string;
      startMinute: number;
      endMinute: number;
      state: "yes" | "maybe" | "no";
      note: string | null;
    }> = {}
  ) => ({
    date: "2026-09-14",
    startMinute: 1080,
    endMinute: 1260,
    state: "yes" as const,
    note: null,
    ...over,
  });

  it("folds two ranges on one date into one", () => {
    expect(
      mergeExceptions([range(), range({ startMinute: 1200, endMinute: 1380 })])
    ).toEqual([range({ startMinute: 1080, endMinute: 1380 })]);
  });

  it("folds two that merely touch, because a seam is not a gap", () => {
    expect(
      mergeExceptions([
        range({ startMinute: 600, endMinute: 720 }),
        range({ startMinute: 720, endMinute: 840 }),
      ])
    ).toEqual([range({ startMinute: 600, endMinute: 840 })]);
  });

  it("keeps two different dates apart, and a real gap on one date", () => {
    expect(mergeExceptions([range(), range({ date: "2026-09-15" })])).toHaveLength(2);
    expect(
      mergeExceptions([range({ startMinute: 600, endMinute: 660 }), range()])
    ).toHaveLength(2);
  });

  it("drops a maybe a refusal already covers on that date", () => {
    // "Away all day" over "maybe in the evening" is the member saying the
    // maybe is off, not both at once.
    expect(
      mergeExceptions([
        range({ startMinute: 0, endMinute: 1440, state: "no" }),
        range({ state: "maybe" }),
      ])
    ).toEqual([range({ startMinute: 0, endMinute: 1440, state: "no" })]);
  });

  it("keeps half a refusal whole — free all evening, out from eight", () => {
    const merged = mergeExceptions([
      range({ startMinute: 1020, endMinute: 1380, state: "yes" }),
      range({ startMinute: 1200, endMinute: 1380, state: "no" }),
    ]);
    // The "no" covers only the tail of the "yes", so neither is dropped:
    // trimming would be the system deciding which half they meant.
    expect(merged).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ */
/* Naming the range that is wrong                                     */
/* ------------------------------------------------------------------ */

/*
 * UC-06 7b: "A range ends before it starts - System shows which range is
 * wrong; nothing saved." Which range. In a form holding fourteen of them, a
 * bare "a window has to end after it starts" leaves the member hunting.
 */
describe("rangeRefusal", () => {
  it("names the range, and quotes both of its times back", () => {
    expect(rangeRefusal("Tuesday", 1200, 600)).toBe(
      "Tuesday 20:00 – 10:00 ends before it starts."
    );
    expect(rangeRefusal("2026-09-14", 1200, 600)).toBe(
      "2026-09-14 20:00 – 10:00 ends before it starts."
    );
  });

  it("refuses a range that ends exactly where it starts", () => {
    expect(rangeRefusal("Monday", 600, 600)).toMatch(/ends before it starts/);
  });

  it("names the range for the other refusals too", () => {
    expect(rangeRefusal("Friday", 0, 1800)).toMatch(/^Friday: /);
    expect(rangeRefusal("Friday", 1.5, 600)).toMatch(/^Friday: /);
  });

  it("passes a range that is simply fine", () => {
    expect(rangeRefusal("Saturday", 600, 1200)).toBeNull();
    // 05:00 the next morning is the far end, and it is allowed.
    expect(rangeRefusal("Saturday", 1320, 1740)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Resolving                                                          */
/* ------------------------------------------------------------------ */

function person(over: Partial<PersonAvailability> = {}): PersonAvailability {
  return {
    userId: "u1",
    name: "Sam",
    handle: null,
    timezone: "Europe/London",
    rules: [],
    exceptions: [],
    ...over,
  };
}

describe("resolveFor", () => {
  it("repeats a weekly rule on the right day of the week", () => {
    const out = resolveFor(
      person({ rules: [{ weekday: 1, startMinute: 1200, endMinute: 1320, state: "yes" }] }),
      weekDays(monday),
      "UTC"
    );
    expect(out).toHaveLength(1);
    // 24 August 2026 is a Monday, so weekday 1 is Tuesday the 25th, and
    // London is on BST in August.
    expect(new Date(out[0].from).toISOString()).toBe("2026-08-25T19:00:00.000Z");
  });

  it("uses the person's own zone, not the reader's", () => {
    const rules = [{ weekday: 1, startMinute: 1200, endMinute: 1320, state: "yes" as const }];
    const london = resolveFor(person({ rules }), weekDays(monday), "UTC");
    const warsaw = resolveFor(
      person({ rules, timezone: "Europe/Warsaw" }),
      weekDays(monday),
      "UTC"
    );
    expect(london[0].from - warsaw[0].from).toBe(60 * 60_000);
  });

  it("falls back to the reader's zone when the person has no zone", () => {
    const out = resolveFor(
      person({
        timezone: null,
        rules: [{ weekday: 0, startMinute: 600, endMinute: 660, state: "yes" }],
      }),
      weekDays(monday),
      "UTC"
    );
    expect(new Date(out[0].from).toISOString()).toBe("2026-08-24T10:00:00.000Z");
  });

  it("lets a named date replace the weekly pattern entirely", () => {
    const out = resolveFor(
      person({
        rules: [{ weekday: 0, startMinute: 600, endMinute: 1200, state: "yes" }],
        exceptions: [
          { date: "2026-08-24", startMinute: 1260, endMinute: 1380, state: "yes", note: null },
        ],
      }),
      weekDays(monday),
      "UTC"
    );
    // The Monday rule is gone, replaced by the one window named for that date.
    const mondayIntervals = out.filter(
      (interval) => new Date(interval.from).toISOString().startsWith("2026-08-24")
    );
    expect(mondayIntervals).toHaveLength(1);
    expect(new Date(mondayIntervals[0].from).toISOString()).toBe("2026-08-24T20:00:00.000Z");
  });

  it("treats an outright refusal as no availability at all", () => {
    const out = resolveFor(
      person({
        rules: [{ weekday: 0, startMinute: 600, endMinute: 1200, state: "yes" }],
        exceptions: [
          { date: "2026-08-24", startMinute: 0, endMinute: 1440, state: "no", note: "Away" },
        ],
      }),
      weekDays(monday),
      "UTC"
    );
    expect(out).toHaveLength(0);
  });

  it("carries a late window into the following morning", () => {
    const out = resolveFor(
      person({
        timezone: "UTC",
        rules: [{ weekday: 4, startMinute: 1200, endMinute: 1560, state: "yes" }],
      }),
      weekDays(monday),
      "UTC"
    );
    // Friday the 28th, 20:00 through 02:00 on the Saturday.
    expect(new Date(out[0].from).toISOString()).toBe("2026-08-28T20:00:00.000Z");
    expect(new Date(out[0].to).toISOString()).toBe("2026-08-29T02:00:00.000Z");
  });
});

describe("refusedOn", () => {
  it("is true only when every window that day is a no", () => {
    const away = person({
      exceptions: [
        { date: "2026-08-24", startMinute: 0, endMinute: 1440, state: "no", note: null },
      ],
    });
    const partly = person({
      exceptions: [
        { date: "2026-08-24", startMinute: 0, endMinute: 600, state: "no", note: null },
        { date: "2026-08-24", startMinute: 1200, endMinute: 1380, state: "yes", note: null },
      ],
    });
    expect(refusedOn(away, monday)).toBe(true);
    expect(refusedOn(partly, monday)).toBe(false);
    expect(refusedOn(person(), monday)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The grid                                                           */
/* ------------------------------------------------------------------ */

describe("tallyWeek", () => {
  const window = { startMinute: 18 * 60, endMinute: 22 * 60 };

  it("counts a person only in the slots they cover completely", () => {
    const grid = tallyWeek(
      [
        person({
          timezone: "UTC",
          rules: [{ weekday: 0, startMinute: 19 * 60, endMinute: 20 * 60, state: "yes" }],
        }),
      ],
      weekDays(monday),
      window,
      "UTC"
    );
    // 18:00-22:00 in half hours is eight slots; 19:00-20:00 is slots 2 and 3.
    const mondayColumn = grid[0];
    expect(mondayColumn).toHaveLength(8);
    expect(mondayColumn.map((slot) => slot.yes.length)).toEqual([0, 0, 1, 1, 0, 0, 0, 0]);
  });

  it("does not count a slot the person only half covers", () => {
    const grid = tallyWeek(
      [
        person({
          timezone: "UTC",
          rules: [{ weekday: 0, startMinute: 19 * 60 + 15, endMinute: 19 * 60 + 45, state: "yes" }],
        }),
      ],
      weekDays(monday),
      window,
      "UTC"
    );
    expect(grid[0].every((slot) => slot.yes.length === 0)).toBe(true);
  });

  it("keeps yes and maybe apart", () => {
    const grid = tallyWeek(
      [
        person({
          userId: "a",
          name: "Ana",
          timezone: "UTC",
          rules: [{ weekday: 0, startMinute: 18 * 60, endMinute: 22 * 60, state: "yes" }],
        }),
        person({
          userId: "b",
          name: "Bo",
          timezone: "UTC",
          rules: [{ weekday: 0, startMinute: 18 * 60, endMinute: 22 * 60, state: "maybe" }],
        }),
      ],
      weekDays(monday),
      window,
      "UTC"
    );
    expect(grid[0][0].yes).toEqual(["Ana"]);
    expect(grid[0][0].maybe).toEqual(["Bo"]);
  });

  it("names who is free, so the grid can say more than a number", () => {
    const grid = tallyWeek(
      [
        person({ userId: "a", name: "Ana", timezone: "UTC",
          rules: [{ weekday: 2, startMinute: 18 * 60, endMinute: 20 * 60, state: "yes" }] }),
        person({ userId: "b", name: "Bo", timezone: "UTC",
          rules: [{ weekday: 2, startMinute: 19 * 60, endMinute: 22 * 60, state: "yes" }] }),
      ],
      weekDays(monday),
      window,
      "UTC"
    );
    const wednesday = grid[2];
    expect(wednesday[0].yes).toEqual(["Ana"]);
    expect(wednesday[2].yes).toEqual(["Ana", "Bo"]);
    expect(wednesday[6].yes).toEqual(["Bo"]);
  });

  it("covers a window that runs past midnight", () => {
    const grid = tallyWeek(
      [
        person({
          timezone: "UTC",
          rules: [{ weekday: 4, startMinute: 22 * 60, endMinute: 26 * 60, state: "yes" }],
        }),
      ],
      weekDays(monday),
      { startMinute: 22 * 60, endMinute: 25 * 60 },
      "UTC"
    );
    // Friday, six half-hour slots from 22:00 to 01:00, all of them covered.
    expect(grid[4].map((slot) => slot.yes.length)).toEqual([1, 1, 1, 1, 1, 1]);
  });
});

/* ------------------------------------------------------------------ */
/* The two weeks a year the clocks move                               */
/* ------------------------------------------------------------------ */

/**
 * UC-07 4a: "Week contains a clock change - System shows real local times; no
 * slot is duplicated or lost silently."
 *
 * The grid's slots are cut from instants rather than walked along the clock
 * face, and these are the two weeks that tell the difference. Both use a
 * 00:00–05:00 window, because a clock change happens at 02:00 or 03:00 and an
 * evening window would step right over the interesting part.
 *
 * Paris, because that is the community's clock: CET to CEST on the last Sunday
 * of March, back on the last Sunday of October.
 */
describe("a clock-change week on the grid (UC-07 4a)", () => {
  const PARIS = "Europe/Paris";
  const NIGHT = { startMinute: 0, endMinute: 5 * 60 };

  /** Free right through the window, every day, so the counting is not the variable. */
  const nightOwl = () =>
    person({
      timezone: PARIS,
      rules: Array.from({ length: 7 }, (_unused, weekday) => ({
        weekday,
        startMinute: 0,
        endMinute: 5 * 60,
        state: "yes" as const,
      })),
    });

  /** Every slot's real local clock face, which is what the admin reads. */
  const faces = (column: Array<{ from: number }>) =>
    column.map((slot) => clockAt(slot.from, PARIS));

  describe("spring forward — 29 March 2026, 02:00 becomes 03:00", () => {
    // Monday the 23rd; the Sunday at the end of the week is the 29th.
    const week = weekDays({ year: 2026, month: 3, day: 23 });

    it("is two slots shorter that day, and no shorter on the others", () => {
      const grid = tallyWeek([nightOwl()], week, NIGHT, PARIS);
      expect(grid.slice(0, 6).map((column) => column.length)).toEqual([
        10, 10, 10, 10, 10, 10,
      ]);
      // Four real hours between 00:00 CET and 05:00 CEST, so eight half hours.
      expect(grid[6]).toHaveLength(8);
    });

    it("duplicates no slot — the old grid drew 02:00 and 03:00 on one instant", () => {
      const sunday = tallyWeek([nightOwl()], week, NIGHT, PARIS)[6];
      expect(new Set(sunday.map((slot) => slot.from)).size).toBe(sunday.length);
      // And each one starts where the last ended: a contiguous four hours.
      for (let at = 1; at < sunday.length; at += 1) {
        expect(sunday[at].from).toBe(sunday[at - 1].to);
      }
    });

    it("shows real local times, with the hour that never happened absent", () => {
      const sunday = tallyWeek([nightOwl()], week, NIGHT, PARIS)[6];
      expect(faces(sunday)).toEqual([
        "00:00",
        "00:30",
        "01:00",
        "01:30",
        "03:00",
        "03:30",
        "04:00",
        "04:30",
      ]);
    });

    it("counts the night owl in every slot that exists", () => {
      const sunday = tallyWeek([nightOwl()], week, NIGHT, PARIS)[6];
      expect(sunday.every((slot) => slot.yes.length === 1)).toBe(true);
    });
  });

  describe("fall back — 25 October 2026, 03:00 becomes 02:00", () => {
    const week = weekDays({ year: 2026, month: 10, day: 19 });

    it("is two slots longer that day, and no longer on the others", () => {
      const grid = tallyWeek([nightOwl()], week, NIGHT, PARIS);
      expect(grid.slice(0, 6).map((column) => column.length)).toEqual([
        10, 10, 10, 10, 10, 10,
      ]);
      // Six real hours between 00:00 CEST and 05:00 CET, so twelve half hours.
      expect(grid[6]).toHaveLength(12);
    });

    it("loses no slot — the repeated hour used to belong to none of them", () => {
      const sunday = tallyWeek([nightOwl()], week, NIGHT, PARIS)[6];
      expect(new Set(sunday.map((slot) => slot.from)).size).toBe(sunday.length);
      for (let at = 1; at < sunday.length; at += 1) {
        expect(sunday[at].from).toBe(sunday[at - 1].to);
      }
    });

    it("shows real local times, with 02:00 on the grid twice because it is", () => {
      const sunday = tallyWeek([nightOwl()], week, NIGHT, PARIS)[6];
      expect(faces(sunday)).toEqual([
        "00:00",
        "00:30",
        "01:00",
        "01:30",
        "02:00",
        "02:30",
        "02:00",
        "02:30",
        "03:00",
        "03:30",
        "04:00",
        "04:30",
      ]);
      // The two 02:00s are an hour apart in real time, which is the point.
      expect(sunday[6].from - sunday[4].from).toBe(60 * 60_000);
    });

    it("counts the night owl through both passes of the repeated hour", () => {
      const sunday = tallyWeek([nightOwl()], week, NIGHT, PARIS)[6];
      expect(sunday.every((slot) => slot.yes.length === 1)).toBe(true);
    });
  });

  it("leaves an ordinary week exactly as it was", () => {
    const grid = tallyWeek([nightOwl()], weekDays(monday), NIGHT, PARIS);
    expect(grid.map((column) => column.length)).toEqual([10, 10, 10, 10, 10, 10, 10]);
  });
});

/* ------------------------------------------------------------------ */
/* Storage                                                            */
/* ------------------------------------------------------------------ */

describe("setAvailability", () => {
  /*
   * A fixed "now" so that "in the past" (UC-06 7c) is a fact about the test
   * rather than about the day it is run on. Every date below is read against
   * this: 2026-09-14 is behind it, 2026-09-16 ahead of it.
   */
  const NOW = new Date("2026-09-15T12:00:00Z");

  it("stores a pattern, folds it, and reads it back", async () => {
    const userId = await makeUser(db, { displayName: "Sam" });
    const written = await setAvailability(
      userId,
      {
        timezone: "Europe/London",
        rules: [
          { weekday: 1, startMinute: 1080, endMinute: 1260, state: "yes" },
          { weekday: 1, startMinute: 1200, endMinute: 1380, state: "yes" },
        ],
        exceptions: [
          { date: "2026-09-16", startMinute: 0, endMinute: 1440, state: "no", note: "Away" },
        ],
      },
      db,
      NOW
    );
    expect(written.ok).toBe(true);

    const read = await getAvailability(userId, db);
    expect(read.timezone).toBe("Europe/London");
    expect(read.rules).toEqual([
      { weekday: 1, startMinute: 1080, endMinute: 1380, state: "yes" },
    ]);
    expect(read.exceptions).toEqual([
      { date: "2026-09-16", startMinute: 0, endMinute: 1440, state: "no", note: "Away" },
    ]);
  });

  // UC-06 7d, on the way through the database rather than in the helper.
  it("folds two overlapping ranges on one named date into one", async () => {
    const userId = await makeUser(db);
    const written = await setAvailability(
      userId,
      {
        timezone: "UTC",
        rules: [],
        exceptions: [
          { date: "2026-09-16", startMinute: 1080, endMinute: 1260, state: "yes", note: null },
          { date: "2026-09-16", startMinute: 1200, endMinute: 1380, state: "yes", note: null },
        ],
      },
      db,
      NOW
    );
    expect(written.ok).toBe(true);
    if (written.ok) expect(written.data.exceptions).toBe(1);

    expect((await getAvailability(userId, db)).exceptions).toEqual([
      { date: "2026-09-16", startMinute: 1080, endMinute: 1380, state: "yes", note: null },
    ]);
  });

  it("replaces the whole answer rather than adding to it", async () => {
    const userId = await makeUser(db);
    await setAvailability(
      userId,
      {
        timezone: "UTC",
        rules: [{ weekday: 0, startMinute: 600, endMinute: 720, state: "yes" }],
        exceptions: [],
      },
      db
    );
    await setAvailability(
      userId,
      {
        timezone: "UTC",
        rules: [{ weekday: 5, startMinute: 900, endMinute: 1020, state: "maybe" }],
        exceptions: [],
      },
      db
    );

    const read = await getAvailability(userId, db);
    expect(read.rules).toEqual([
      { weekday: 5, startMinute: 900, endMinute: 1020, state: "maybe" },
    ]);
  });

  it("clears everything when the answer is empty", async () => {
    const userId = await makeUser(db);
    await setAvailability(
      userId,
      {
        timezone: "UTC",
        rules: [{ weekday: 0, startMinute: 600, endMinute: 720, state: "yes" }],
        exceptions: [],
      },
      db
    );
    await setAvailability(userId, { timezone: "UTC", rules: [], exceptions: [] }, db);
    expect((await getAvailability(userId, db)).rules).toEqual([]);
  });

  // UC-06 7b: which range is wrong, and nothing saved.
  it("refuses a weekly range that ends before it starts, naming the day", async () => {
    const userId = await makeUser(db);
    const result = await setAvailability(
      userId,
      {
        timezone: "UTC",
        rules: [
          { weekday: 2, startMinute: 600, endMinute: 720, state: "yes" },
          { weekday: 0, startMinute: 1200, endMinute: 600, state: "yes" },
        ],
        exceptions: [],
      },
      db,
      NOW
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(
      "Monday 20:00 – 10:00 ends before it starts."
    );

    // Nothing saved — not even the Wednesday range that was fine.
    expect((await getAvailability(userId, db)).rules).toEqual([]);
  });

  it("refuses a named date's range the same way, naming the date", async () => {
    const userId = await makeUser(db);
    const result = await setAvailability(
      userId,
      {
        timezone: "UTC",
        rules: [],
        exceptions: [
          { date: "2026-09-16", startMinute: 1200, endMinute: 600, state: "yes", note: null },
        ],
      },
      db,
      NOW
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(
      "2026-09-16 20:00 – 10:00 ends before it starts."
    );
  });

  // UC-06 7c: "A date in the past - System rejects it."
  it("refuses a date that has already been", async () => {
    const userId = await makeUser(db);
    const result = await setAvailability(
      userId,
      {
        timezone: "UTC",
        rules: [],
        exceptions: [
          { date: "2026-09-14", startMinute: 0, endMinute: 1440, state: "no", note: null },
        ],
      },
      db,
      NOW
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/^2026-09-14 has already been/);
  });

  it("counts the past in the member's own zone, not the server's", async () => {
    const userId = await makeUser(db);
    // 2026-09-16T05:00Z is 22:00 on the 15th in Los Angeles and 07:00 on the
    // 16th in Paris, so the same instant puts the 15th in the past for one
    // member and not the other.
    const morningAfter = new Date("2026-09-16T05:00:00Z");
    const west = await setAvailability(
      userId,
      {
        timezone: "America/Los_Angeles",
        rules: [],
        exceptions: [
          { date: "2026-09-15", startMinute: 0, endMinute: 1440, state: "no", note: null },
        ],
      },
      db,
      morningAfter
    );
    expect(west.ok).toBe(true);

    const other = await makeUser(db);
    const east = await setAvailability(
      other,
      {
        timezone: "Europe/Paris",
        rules: [],
        exceptions: [
          { date: "2026-09-15", startMinute: 0, endMinute: 1440, state: "no", note: null },
        ],
      },
      db,
      morningAfter
    );
    expect(east.ok).toBe(false);
  });

  it("lets a member save although a date they set long ago has now passed", async () => {
    const userId = await makeUser(db);
    const dated = {
      date: "2026-09-16",
      startMinute: 0,
      endMinute: 1440,
      state: "no" as const,
      note: null,
    };
    expect(
      (await setAvailability(userId, { timezone: "UTC", rules: [], exceptions: [dated] }, db, NOW))
        .ok
    ).toBe(true);

    // A month later they change a weekday, and the form still holds that date.
    // Refusing the whole save over history they are not adding would mean the
    // only way back is hunting for a row they have forgotten about.
    const later = await setAvailability(
      userId,
      {
        timezone: "UTC",
        rules: [{ weekday: 0, startMinute: 600, endMinute: 720, state: "yes" }],
        exceptions: [dated],
      },
      db,
      new Date("2026-10-16T12:00:00Z")
    );
    expect(later.ok).toBe(true);
  });

  it("refuses a date that is not one", async () => {
    const userId = await makeUser(db);
    const result = await setAvailability(
      userId,
      {
        timezone: "UTC",
        rules: [],
        exceptions: [
          { date: "2027-02-31", startMinute: 0, endMinute: 1440, state: "no", note: null },
        ],
      },
      db,
      NOW
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a timezone that is not one", async () => {
    const userId = await makeUser(db);
    const result = await setAvailability(
      userId,
      { timezone: "Mars/Olympus", rules: [], exceptions: [] },
      db
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/timezone/);
  });

  it("leaves out anybody who has said nothing", async () => {
    const said = await makeUser(db, { displayName: "Said" });
    await makeUser(db, { displayName: "Silent" });
    await setAvailability(
      said,
      {
        timezone: "UTC",
        rules: [{ weekday: 0, startMinute: 600, endMinute: 720, state: "yes" }],
        exceptions: [],
      },
      db
    );

    const everyone = await getEveryoneAvailability(db);
    expect(everyone.map((row) => row.name)).toContain("Said");
    expect(everyone.map((row) => row.name)).not.toContain("Silent");
  });
});
