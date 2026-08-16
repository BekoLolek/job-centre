import { describe, expect, it } from "vitest";
import {
  addMinutesTo,
  formatClock,
  formatWhen,
  parseStamp,
  toInstant,
  toLocalInput,
} from "@/lib/time";

/**
 * The suite pins TZ=Europe/Budapest (see vitest.config.ts):
 * CEST (UTC+2) in summer, CET (UTC+1) in winter.
 */
const SUMMER_UTC = "2025-08-15T14:00:00.000Z"; // 16:00 local
const WINTER_UTC = "2025-01-05T07:03:00.000Z"; // 08:03 local

describe("the pinned test timezone", () => {
  it("is Europe/Budapest, otherwise every local assertion below is meaningless", () => {
    expect(new Date(SUMMER_UTC).getHours()).toBe(16);
    expect(new Date(WINTER_UTC).getHours()).toBe(8);
  });
});

describe("parseStamp", () => {
  it("returns null for empty input", () => {
    expect(parseStamp(null)).toBeNull();
    expect(parseStamp(undefined)).toBeNull();
    expect(parseStamp("")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(parseStamp("not a date")).toBeNull();
    expect(parseStamp("2025-13-45T99:99")).toBeNull();
  });

  it("parses an absolute instant", () => {
    const at = parseStamp(SUMMER_UTC);
    expect(at?.getTime()).toBe(Date.UTC(2025, 7, 15, 14, 0, 0));
  });

  it("reads a naive (legacy) value as local time", () => {
    // 16:00 typed in Budapest during CEST is 14:00Z.
    expect(parseStamp("2025-08-15T16:00")?.toISOString()).toBe(SUMMER_UTC);
    // The same wall clock in winter is CET, so 07:00Z.
    expect(parseStamp("2025-01-05T08:00")?.toISOString()).toBe("2025-01-05T07:00:00.000Z");
  });
});

describe("toInstant", () => {
  it("converts a datetime-local value into a UTC instant", () => {
    expect(toInstant("2025-08-15T16:00")).toBe(SUMMER_UTC);
  });

  it("respects the offset in force on that date, not today's", () => {
    expect(toInstant("2025-01-05T08:03")).toBe(WINTER_UTC);
  });

  it("returns null for junk", () => {
    expect(toInstant("")).toBeNull();
    expect(toInstant("tomorrow-ish")).toBeNull();
  });
});

describe("toLocalInput", () => {
  it("renders an instant as a datetime-local value in the viewer's zone", () => {
    expect(toLocalInput(SUMMER_UTC)).toBe("2025-08-15T16:00");
  });

  it("zero-pads every field", () => {
    expect(toLocalInput(WINTER_UTC)).toBe("2025-01-05T08:03");
  });

  it("drops seconds", () => {
    expect(toLocalInput("2025-08-15T14:00:59.999Z")).toBe("2025-08-15T16:00");
  });

  it("returns an empty string for empty or invalid input", () => {
    expect(toLocalInput(null)).toBe("");
    expect(toLocalInput(undefined)).toBe("");
    expect(toLocalInput("nope")).toBe("");
  });
});

describe("toLocalInput / toInstant round trip", () => {
  const locals = [
    "2025-08-15T16:00", // CEST
    "2025-01-05T08:03", // CET
    "2025-03-30T03:30", // the first half hour after the spring-forward
    "2025-10-26T04:15", // after the autumn fall-back
    "2025-12-31T23:59",
  ];

  it.each(locals)("local -> instant -> local does not drift (%s)", (local) => {
    const instant = toInstant(local);
    expect(instant).not.toBeNull();
    expect(toLocalInput(instant)).toBe(local);
  });

  const instants = [SUMMER_UTC, WINTER_UTC, "2025-03-30T00:30:00.000Z"];

  it.each(instants)("instant -> local -> instant does not drift (%s)", (instant) => {
    expect(toInstant(toLocalInput(instant))).toBe(instant);
  });
});

describe("addMinutesTo", () => {
  it("adds minutes to an instant", () => {
    expect(addMinutesTo(SUMMER_UTC, 90)).toBe("2025-08-15T15:30:00.000Z");
  });

  it("accepts zero and negative offsets", () => {
    expect(addMinutesTo(SUMMER_UTC, 0)).toBe(SUMMER_UTC);
    expect(addMinutesTo(SUMMER_UTC, -60)).toBe("2025-08-15T13:00:00.000Z");
  });

  it("rolls over days", () => {
    expect(addMinutesTo("2025-08-15T23:30:00.000Z", 45)).toBe("2025-08-16T00:15:00.000Z");
  });

  it("adds real elapsed time across a DST boundary", () => {
    // 01:30 local (CET) + 60 real minutes lands at 03:30 local (CEST).
    const before = "2025-03-30T00:30:00.000Z";
    const after = addMinutesTo(before, 60);
    expect(after).toBe("2025-03-30T01:30:00.000Z");
    expect(toLocalInput(before)).toBe("2025-03-30T01:30");
    expect(toLocalInput(after)).toBe("2025-03-30T03:30");
  });

  it("accepts a naive value and returns an instant", () => {
    expect(addMinutesTo("2025-08-15T16:00", 30)).toBe("2025-08-15T14:30:00.000Z");
  });

  it("returns null when the base value is unparseable", () => {
    expect(addMinutesTo("", 30)).toBeNull();
    expect(addMinutesTo("junk", 30)).toBeNull();
  });
});

describe("formatClock", () => {
  it("renders 24-hour local time", () => {
    expect(formatClock(SUMMER_UTC)).toBe("16:00");
  });

  it("pads a single-digit hour", () => {
    expect(formatClock(WINTER_UTC)).toBe("08:03");
  });

  it("returns null for empty or invalid input", () => {
    expect(formatClock(null)).toBeNull();
    expect(formatClock(undefined)).toBeNull();
    expect(formatClock("junk")).toBeNull();
  });
});

describe("formatWhen", () => {
  it("prefixes the local date and joins it with a middot", () => {
    const out = formatWhen(SUMMER_UTC);
    expect(out).not.toBeNull();
    expect(out!.endsWith(" · 16:00")).toBe(true);
    // Locale-dependent wording, so assert the pieces rather than a literal string.
    expect(out).toContain("15");
    expect(out).toMatch(/aug/i);
    expect(out).toMatch(/fri/i); // 15 Aug 2025 is a Friday
  });

  it("uses the same clock text as formatClock", () => {
    expect(formatWhen(WINTER_UTC)).toContain(formatClock(WINTER_UTC)!);
  });

  it("returns null for empty or invalid input", () => {
    expect(formatWhen(null)).toBeNull();
    expect(formatWhen("")).toBeNull();
    expect(formatWhen("junk")).toBeNull();
  });
});
