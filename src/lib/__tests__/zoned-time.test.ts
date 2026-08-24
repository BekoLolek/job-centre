import { describe, expect, it } from "vitest";
import {
  addDays,
  clockOf,
  clockSteps,
  clockWithDay,
  formatDate,
  offsetAt,
  parseDate,
  todayIn,
  weekStart,
  weekdayOf,
  zonedToInstant,
} from "@/lib/zoned-time";

/**
 * The clock arithmetic behind general availability.
 *
 * A weekly pattern is the one thing in this codebase that cannot be an
 * instant, so these are the conversions everything else leans on. Most of what
 * is checked here is daylight saving, because that is where a home-rolled
 * version of this quietly loses an hour twice a year and nobody notices until
 * an event is scheduled at the wrong time.
 */

describe("offsetAt", () => {
  it("reads a zone's offset either side of a clock change", () => {
    // London: GMT in January, BST in July.
    const january = Date.UTC(2026, 0, 15, 12);
    const july = Date.UTC(2026, 6, 15, 12);
    expect(offsetAt(january, "Europe/London")).toBe(0);
    expect(offsetAt(july, "Europe/London")).toBe(60);
  });

  it("handles zones ahead of and behind UTC", () => {
    const at = Date.UTC(2026, 0, 15, 12);
    expect(offsetAt(at, "Europe/Warsaw")).toBe(60);
    expect(offsetAt(at, "America/New_York")).toBe(-300);
    expect(offsetAt(at, "UTC")).toBe(0);
  });

  it("handles a zone whose offset is not a whole hour", () => {
    expect(offsetAt(Date.UTC(2026, 0, 15, 12), "Asia/Kolkata")).toBe(330);
  });
});

describe("zonedToInstant", () => {
  it("turns a wall clock into the moment it names", () => {
    const at = zonedToInstant({ year: 2026, month: 1, day: 15 }, 20 * 60, "Europe/London");
    expect(at.toISOString()).toBe("2026-01-15T20:00:00.000Z");
  });

  it("keeps the same wall clock across a clock change", () => {
    // 20:00 in London is 20:00 UTC in winter and 19:00 UTC in summer. The
    // whole reason availability stores minutes rather than instants.
    const winter = zonedToInstant({ year: 2026, month: 1, day: 15 }, 1200, "Europe/London");
    const summer = zonedToInstant({ year: 2026, month: 7, day: 15 }, 1200, "Europe/London");
    expect(winter.toISOString()).toBe("2026-01-15T20:00:00.000Z");
    expect(summer.toISOString()).toBe("2026-07-15T19:00:00.000Z");
  });

  it("carries past midnight, so a Friday night stays one window", () => {
    // 26:00 on Friday is 02:00 on Saturday.
    const at = zonedToInstant({ year: 2026, month: 1, day: 16 }, 26 * 60, "Europe/London");
    expect(at.toISOString()).toBe("2026-01-17T02:00:00.000Z");
  });

  it("shifts a skipped wall clock forward by the gap", () => {
    // 29 March 2026, London: 01:00 jumps straight to 02:00, so 01:30 never
    // happens. The standard answer is to move forward by the size of the gap,
    // landing on 02:30 local — which is 01:30 UTC.
    const at = zonedToInstant({ year: 2026, month: 3, day: 29 }, 90, "Europe/London");
    expect(at.toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  it("resolves a repeated wall clock to its first pass", () => {
    // 25 October 2026, London: 02:00 falls back to 01:00, so 01:30 happens
    // twice — once at 00:30 UTC on BST, once at 01:30 UTC on GMT. The first
    // is the answer, which is also what every calendar picks.
    const at = zonedToInstant({ year: 2026, month: 10, day: 25 }, 90, "Europe/London");
    expect(at.toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("agrees with the zone it was written in, whichever that is", () => {
    const warsaw = zonedToInstant({ year: 2026, month: 1, day: 15 }, 1200, "Europe/Warsaw");
    const london = zonedToInstant({ year: 2026, month: 1, day: 15 }, 1200, "Europe/London");
    // 20:00 in Warsaw is an hour before 20:00 in London.
    expect(london.getTime() - warsaw.getTime()).toBe(60 * 60_000);
  });
});

describe("dates", () => {
  it("parses and rejects", () => {
    expect(parseDate("2026-08-24")).toEqual({ year: 2026, month: 8, day: 24 });
    expect(parseDate("2026-02-31")).toBeNull();
    expect(parseDate("24/08/2026")).toBeNull();
    expect(parseDate("")).toBeNull();
  });

  it("round-trips", () => {
    expect(formatDate({ year: 2026, month: 8, day: 4 })).toBe("2026-08-04");
  });

  it("counts weekdays from Monday", () => {
    // 24 August 2026 is a Monday.
    expect(weekdayOf({ year: 2026, month: 8, day: 24 })).toBe(0);
    expect(weekdayOf({ year: 2026, month: 8, day: 30 })).toBe(6);
  });

  it("finds the Monday of a week, including when it is already Monday", () => {
    expect(weekStart({ year: 2026, month: 8, day: 27 })).toEqual({
      year: 2026,
      month: 8,
      day: 24,
    });
    expect(weekStart({ year: 2026, month: 8, day: 24 })).toEqual({
      year: 2026,
      month: 8,
      day: 24,
    });
  });

  it("adds days across a month and a year", () => {
    expect(addDays({ year: 2026, month: 8, day: 30 }, 3)).toEqual({
      year: 2026,
      month: 9,
      day: 2,
    });
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
  });

  it("reads today in the zone asked for, not in UTC", () => {
    // 23:30 UTC on the 24th is already the 25th in Sydney.
    const at = new Date("2026-08-24T23:30:00.000Z");
    expect(todayIn("UTC", at)).toEqual({ year: 2026, month: 8, day: 24 });
    expect(todayIn("Australia/Sydney", at)).toEqual({ year: 2026, month: 8, day: 25 });
  });
});

describe("clock faces", () => {
  it("renders minutes as a 24-hour clock", () => {
    expect(clockOf(0)).toBe("00:00");
    expect(clockOf(9 * 60 + 5)).toBe("09:05");
    expect(clockOf(1200)).toBe("20:00");
  });

  it("wraps past midnight and says which day it landed on", () => {
    expect(clockOf(1560)).toBe("02:00");
    expect(clockWithDay(1560)).toBe("02:00 +1");
    expect(clockWithDay(1200)).toBe("20:00");
    expect(clockWithDay(1440)).toBe("00:00 +1");
  });

  it("steps in half hours, inclusive of both ends", () => {
    expect(clockSteps(600, 720)).toEqual([600, 630, 660, 690, 720]);
  });
});
