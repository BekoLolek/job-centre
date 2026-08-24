import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  type PersonAvailability,
  getAvailability,
  getEveryoneAvailability,
  mergeRules,
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
/* Storage                                                            */
/* ------------------------------------------------------------------ */

describe("setAvailability", () => {
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
          { date: "2026-09-14", startMinute: 0, endMinute: 1440, state: "no", note: "Away" },
        ],
      },
      db
    );
    expect(written.ok).toBe(true);

    const read = await getAvailability(userId, db);
    expect(read.timezone).toBe("Europe/London");
    expect(read.rules).toEqual([
      { weekday: 1, startMinute: 1080, endMinute: 1380, state: "yes" },
    ]);
    expect(read.exceptions).toEqual([
      { date: "2026-09-14", startMinute: 0, endMinute: 1440, state: "no", note: "Away" },
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

  it("refuses a window that ends before it starts", async () => {
    const userId = await makeUser(db);
    const result = await setAvailability(
      userId,
      {
        timezone: "UTC",
        rules: [{ weekday: 0, startMinute: 1200, endMinute: 600, state: "yes" }],
        exceptions: [],
      },
      db
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/end after it starts/);
  });

  it("refuses a date that is not one", async () => {
    const userId = await makeUser(db);
    const result = await setAvailability(
      userId,
      {
        timezone: "UTC",
        rules: [],
        exceptions: [
          { date: "2026-02-31", startMinute: 0, endMinute: 1440, state: "no", note: null },
        ],
      },
      db
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
