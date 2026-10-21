import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  type PersonAvailability,
  availabilityWeek,
  getAvailability,
  notedWindows,
  setAvailability,
  tallyWeek,
  weekDays,
} from "@/lib/availability";

/**
 * The note on a date override (R-134 / UC-06 E1).
 *
 * > **E1.** At step 6, member adds a note ("away at a wedding") — System
 * > stores it with the override and shows it to admins in UC-07's slot list.
 *
 * Storing it already worked and `availability.test.ts` pins that. The second
 * half did not exist: `SlotTally` carried two lists of names and nothing else,
 * so the note was written, read back onto the member's own profile form, and
 * then stopped — the admin looking for an evening in UC-07 6 never saw it.
 *
 * ## Why "away at a wedding" is the hard case, and the whole point
 *
 * E1's own example is a member saying they are *not* available, and a `no`
 * window produces no interval at all (`resolveFor` skips it). So a note folded
 * into `yes`/`maybe` would have been visible for every override except the
 * one kind anybody writes a note on. That is why {@link notedWindows} keeps
 * the refusals and why `notes` is its own list.
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

/** Monday 2026-08-24, the week every grid test in this suite uses. */
const monday = { year: 2026, month: 8, day: 24 };
const week = weekDays(monday);
/** Evening slots, half-hourly: 18:00–22:00 is eight of them. */
const EVENING = { startMinute: 18 * 60, endMinute: 22 * 60 };

function person(over: Partial<PersonAvailability> = {}): PersonAvailability {
  return {
    userId: "u1",
    name: "Sam",
    handle: null,
    timezone: "UTC",
    rules: [],
    exceptions: [],
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* Stored with the override                                           */
/* ------------------------------------------------------------------ */

describe("UC-06 E1: the note is stored with the override", () => {
  it("keeps the words the member wrote", async () => {
    const userId = await makeUser(db, { displayName: "Bea" });

    const written = await setAvailability(
      userId,
      {
        timezone: "UTC",
        rules: [],
        exceptions: [
          {
            date: "2026-08-26",
            startMinute: 0,
            endMinute: 1440,
            state: "no",
            note: "  away at a wedding  ",
          },
        ],
      },
      db,
      new Date("2026-08-01T12:00:00Z")
    );
    expect(written.ok).toBe(true);

    const read = await getAvailability(userId, db);
    expect(read.exceptions).toEqual([
      {
        date: "2026-08-26",
        startMinute: 0,
        endMinute: 1440,
        state: "no",
        note: "away at a wedding",
      },
    ]);
  });

  it("reaches the admin's read of everybody, not only the member's own", async () => {
    // `availabilityWeek` is what `/admin/availability` calls. A note that only
    // survived `getAvailability` would be a note only its author could see.
    const userId = await makeUser(db, { displayName: "Cass" });
    await setAvailability(
      userId,
      {
        timezone: "UTC",
        rules: [],
        exceptions: [
          { date: "2026-08-27", startMinute: 1080, endMinute: 1320, state: "no", note: "on call" },
        ],
      },
      db,
      new Date("2026-08-01T12:00:00Z")
    );

    const everyone = await availabilityWeek(monday, db);
    const mine = everyone.find((row) => row.userId === userId);
    expect(mine?.exceptions.map((row) => row.note)).toContain("on call");
  });
});

/* ------------------------------------------------------------------ */
/* notedWindows                                                       */
/* ------------------------------------------------------------------ */

describe("notedWindows", () => {
  it("keeps a refusal's note, which is the one E1 is about", () => {
    const out = notedWindows(
      person({
        exceptions: [
          {
            date: "2026-08-26",
            startMinute: 18 * 60,
            endMinute: 22 * 60,
            state: "no",
            note: "away at a wedding",
          },
        ],
      }),
      week,
      "UTC"
    );

    expect(out).toHaveLength(1);
    expect(out[0].note).toBe("away at a wedding");
    expect(out[0].state).toBe("no");
    expect(out[0].from).toBe(Date.UTC(2026, 7, 26, 18, 0));
    expect(out[0].to).toBe(Date.UTC(2026, 7, 26, 22, 0));
  });

  it("ignores an override with nothing written on it", () => {
    const out = notedWindows(
      person({
        exceptions: [
          { date: "2026-08-26", startMinute: 0, endMinute: 1440, state: "no", note: null },
          { date: "2026-08-26", startMinute: 0, endMinute: 1440, state: "yes", note: "   " },
        ],
      }),
      week,
      "UTC"
    );
    expect(out).toEqual([]);
  });

  it("ignores a note on a date outside the week being read", () => {
    const out = notedWindows(
      person({
        exceptions: [
          { date: "2026-09-30", startMinute: 0, endMinute: 1440, state: "no", note: "miles away" },
        ],
      }),
      week,
      "UTC"
    );
    expect(out).toEqual([]);
  });

  it("reads the window in the member's own zone, not the reader's", () => {
    // The same promise `resolveFor` makes: the member wrote 19:00 where they
    // live, and that is a different instant from 19:00 where the admin is.
    const [warsaw] = notedWindows(
      person({
        timezone: "Europe/Warsaw",
        exceptions: [
          { date: "2026-08-26", startMinute: 19 * 60, endMinute: 20 * 60, state: "no", note: "gig" },
        ],
      }),
      week,
      "UTC"
    );
    expect(warsaw.from).toBe(Date.UTC(2026, 7, 26, 17, 0));
  });
});

/* ------------------------------------------------------------------ */
/* Shown to admins in UC-07's slot list                               */
/* ------------------------------------------------------------------ */

describe("UC-06 E1: the note reaches UC-07's slot list", () => {
  it("hangs the note on every slot the override touches", () => {
    const grid = tallyWeek(
      [
        person({
          userId: "b",
          name: "Bea",
          exceptions: [
            {
              date: "2026-08-26",
              startMinute: 19 * 60,
              endMinute: 20 * 60,
              state: "no",
              note: "away at a wedding",
            },
          ],
        }),
      ],
      week,
      EVENING,
      "UTC"
    );

    // Wednesday 26th, 18:00–22:00 in half hours: 19:00–20:00 is slots 2 and 3.
    const wednesday = grid[2];
    expect(wednesday).toHaveLength(8);
    expect(wednesday[2].notes).toEqual([
      { name: "Bea", note: "away at a wedding", state: "no" },
    ]);
    expect(wednesday[3].notes).toEqual([
      { name: "Bea", note: "away at a wedding", state: "no" },
    ]);
    // And nowhere else: the hour either side of it has nothing to read.
    expect(wednesday[1].notes).toEqual([]);
    expect(wednesday[4].notes).toEqual([]);
    expect(grid[1].every((slot) => slot.notes.length === 0)).toBe(true);
  });

  it("shows it even though the member is in neither name list", () => {
    // The assertion this file exists for. A `no` override produces no
    // interval, so "away at a wedding" was invisible on a grid that only knew
    // how to say who was free.
    const grid = tallyWeek(
      [
        person({
          userId: "b",
          name: "Bea",
          rules: [{ weekday: 2, startMinute: 18 * 60, endMinute: 22 * 60, state: "yes" }],
          exceptions: [
            {
              date: "2026-08-26",
              startMinute: 0,
              endMinute: 1440,
              state: "no",
              note: "away at a wedding",
            },
          ],
        }),
      ],
      week,
      EVENING,
      "UTC"
    );

    const slot = grid[2][0];
    expect(slot.yes).toEqual([]);
    expect(slot.maybe).toEqual([]);
    expect(slot.notes.map((entry) => entry.note)).toEqual(["away at a wedding"]);
  });

  it("keeps a note on an override that makes somebody free too", () => {
    // "Free after all, taking the day off" is a reason an admin wants as much
    // as a refusal, and it must not be dropped as the easy case.
    const grid = tallyWeek(
      [
        person({
          userId: "d",
          name: "Dee",
          exceptions: [
            {
              date: "2026-08-26",
              startMinute: 18 * 60,
              endMinute: 22 * 60,
              state: "yes",
              note: "taking the day off",
            },
          ],
        }),
      ],
      week,
      EVENING,
      "UTC"
    );

    const slot = grid[2][0];
    expect(slot.yes).toEqual(["Dee"]);
    expect(slot.notes).toEqual([
      { name: "Dee", note: "taking the day off", state: "yes" },
    ]);
  });

  it("names everybody with something to say about the same slot", () => {
    const grid = tallyWeek(
      [
        person({
          userId: "b",
          name: "Bea",
          exceptions: [
            { date: "2026-08-26", startMinute: 0, endMinute: 1440, state: "no", note: "wedding" },
          ],
        }),
        person({
          userId: "c",
          name: "Cass",
          exceptions: [
            { date: "2026-08-26", startMinute: 0, endMinute: 1440, state: "no", note: "on call" },
          ],
        }),
      ],
      week,
      EVENING,
      "UTC"
    );

    expect(grid[2][0].notes.map((entry) => `${entry.name}: ${entry.note}`)).toEqual([
      "Bea: wedding",
      "Cass: on call",
    ]);
  });

  it("leaves `notes` empty rather than absent on an ordinary week", () => {
    // Every slot carries the field, so the panel never has to guard it.
    const grid = tallyWeek(
      [person({ rules: [{ weekday: 2, startMinute: 18 * 60, endMinute: 22 * 60, state: "yes" }] })],
      week,
      EVENING,
      "UTC"
    );
    expect(grid.flat().every((slot) => Array.isArray(slot.notes))).toBe(true);
    expect(grid.flat().every((slot) => slot.notes.length === 0)).toBe(true);
  });
});
