import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Hero, HeroRole } from "@/db";
import type { StoredHand } from "@/lib/hero-hands";
import { type SheetApplicant, type SheetHands, handSheet } from "@/lib/hands-sheet";

/*
 * Task 99 — the Hands sheet decided before it is drawn (R-240, R-241, R-243 /
 * UC-47 2, 3, 4, 2a, 3a, 4a).
 *
 * `handSheet` is a decision over plain data for the reason `standingOn` and
 * `roundScoringLosses` are: the same lines inside the tab could not be
 * mutation-proved in a node suite with nothing to click, and they decide what
 * a manager believes about who has drawn. So every row the tab draws is
 * asserted here directly, and the mutations the task names — filter the
 * undrawn seat out, drop the hand with no seat, re-sort the seats, count hands
 * instead of seats — each have a test built to die to them.
 */

/* --- Fixtures ----------------------------------------------------- */

const ROLES: readonly HeroRole[] = ["Vanguard", "Duelist", "Strategist"];

function hero(name: string, role: HeroRole): Hero {
  return {
    id: `hero-${name.toLowerCase()}`,
    gameId: "game-1",
    name,
    roles: [role],
    retiredAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

/** Nine heroes, three to a role, named after their holder so hands are telling. */
function hand(holder: string, dealtAt = new Date("2026-11-01T19:00:00Z")): StoredHand {
  const heroes = Object.fromEntries(
    ROLES.map((role) => [role, [1, 2, 3].map((n) => hero(`${holder}-${role}-${n}`, role))])
  ) as Record<HeroRole, Hero[]>;
  return { heroes, dealtAt };
}

function applicant(
  userId: string,
  status: SheetApplicant["status"] = "accepted"
): SheetApplicant {
  return {
    userId,
    status,
    member: { id: userId, displayName: userId, avatarUrl: null, discordId: null },
  };
}

/* --- UC-47 2: every seat, in the Applicants tab's order ----------- */

describe("handSheet lists every seat", () => {
  it("keeps the seats in the order they arrive, which is the Applicants tab's", () => {
    // Deliberately not alphabetical, not by whether they have drawn, so any
    // re-sort moves somebody.
    const seats = [applicant("zed"), applicant("amy"), applicant("mia")];
    const hands: SheetHands = { mia: hand("mia"), zed: hand("zed") };

    const sheet = handSheet(seats, hands);

    expect(sheet.seats.map((row) => row.userId)).toEqual(["zed", "amy", "mia"]);
  });

  it("gives each seat that has drawn its nine grouped by role, and when they were dealt (R-241)", () => {
    const dealtAt = new Date("2026-11-02T20:15:00Z");
    const amy = hand("amy", dealtAt);

    const sheet = handSheet([applicant("amy")], { amy });

    expect(sheet.seats).toEqual([
      { userId: "amy", member: applicant("amy").member, hand: amy },
    ]);
    expect(sheet.seats[0].hand?.dealtAt).toBe(dealtAt);
    expect(Object.keys(sheet.seats[0].hand?.heroes ?? {})).toEqual([...ROLES]);
  });

  it("names a seat that has not drawn as a row rather than leaving it out (R-240 / UC-47 3)", () => {
    const seats = [applicant("amy"), applicant("bob"), applicant("cal")];
    const hands: SheetHands = { amy: hand("amy"), cal: hand("cal") };

    const sheet = handSheet(seats, hands);

    // The mutation this exists to kill: `seats.filter((s) => hands[s.userId])`.
    expect(sheet.seats.map((row) => row.userId)).toEqual(["amy", "bob", "cal"]);
    expect(sheet.seats[1]).toEqual({ userId: "bob", member: applicant("bob").member, hand: null });
  });

  it("treats only an accepted application as a seat — pending, waitlisted, declined and withdrawn are not rows", () => {
    const applicants = [
      applicant("amy", "accepted"),
      applicant("pen", "pending"),
      applicant("wai", "waitlisted"),
      applicant("dec", "declined"),
      applicant("wit", "withdrawn"),
      applicant("bob", "accepted"),
    ];

    const sheet = handSheet(applicants, {});

    expect(sheet.seats.map((row) => row.userId)).toEqual(["amy", "bob"]);
  });
});

/* --- UC-47 4: how many of the seats have drawn --------------------- */

describe("handSheet counts the seats that have drawn", () => {
  it("counts seats with a hand, not hands (UC-47 4)", () => {
    const seats = [applicant("amy"), applicant("bob"), applicant("cal")];
    // Three hands, but only two belong to seats: `wit` withdrew after drawing.
    const hands: SheetHands = { amy: hand("amy"), wit: hand("wit"), cal: hand("cal") };

    const sheet = handSheet([...seats, applicant("wit", "withdrawn")], hands);

    // The mutation this exists to kill: `drawn = Object.keys(hands).length`.
    expect(sheet.drawn).toBe(2);
    expect(sheet.seats).toHaveLength(3);
  });
});

/* --- UC-47 3a: a hand whose holder no longer holds a seat ---------- */

describe("handSheet keeps a hand whose holder no longer holds a seat (R-243)", () => {
  it("shows it after every seat, named as no longer holding one", () => {
    const applicants = [applicant("amy"), applicant("wit", "withdrawn"), applicant("bob")];
    const hands: SheetHands = { wit: hand("wit"), amy: hand("amy") };

    const sheet = handSheet(applicants, hands);

    // The mutation this exists to kill: dropping any hand with no seat.
    expect(sheet.seats.map((row) => row.userId)).toEqual(["amy", "bob"]);
    expect(sheet.former).toEqual([
      { userId: "wit", member: applicant("wit").member, hand: hands.wit },
    ]);
  });

  it("still shows a hand whose holder has no application row at all, with nobody to name", () => {
    const hands: SheetHands = { gone: hand("gone") };

    const sheet = handSheet([applicant("amy")], hands);

    expect(sheet.former).toEqual([{ userId: "gone", member: null, hand: hands.gone }]);
  });

  it("keeps former holders in the order their hands arrive, and never among the seats", () => {
    const applicants = [applicant("amy"), applicant("dec", "declined"), applicant("wit", "withdrawn")];
    const hands: SheetHands = { wit: hand("wit"), amy: hand("amy"), dec: hand("dec") };

    const sheet = handSheet(applicants, hands);

    expect(sheet.former.map((row) => row.userId)).toEqual(["wit", "dec"]);
    expect(sheet.seats.map((row) => row.userId)).toEqual(["amy"]);
  });
});

/* --- UC-47 2a, 4a: the two stated states --------------------------- */

describe("handSheet states the empty cases rather than drawing an empty sheet", () => {
  it("says nobody has drawn when every seat is still waiting (UC-47 2a)", () => {
    const sheet = handSheet([applicant("amy"), applicant("bob")], {});

    expect(sheet.kind).toBe("nobody_drawn");
    expect(sheet.seats.map((row) => row.hand)).toEqual([null, null]);
    expect(sheet.drawn).toBe(0);
  });

  it("says there are no seats when nothing is accepted (UC-47 4a)", () => {
    const sheet = handSheet([applicant("pen", "pending")], {});

    expect(sheet.kind).toBe("no_seats");
    expect(sheet.seats).toEqual([]);
  });

  it("says there are no seats even when a withdrawn player's hand remains — the hand is still shown", () => {
    const hands: SheetHands = { wit: hand("wit") };

    const sheet = handSheet([applicant("wit", "withdrawn")], hands);

    expect(sheet.kind).toBe("no_seats");
    expect(sheet.former.map((row) => row.userId)).toEqual(["wit"]);
  });

  it("is a sheet once one seat has drawn", () => {
    const sheet = handSheet([applicant("amy"), applicant("bob")], { amy: hand("amy") });

    expect(sheet.kind).toBe("drawing");
    expect(sheet.drawn).toBe(1);
  });

  it("is still a sheet when every seat has drawn", () => {
    const sheet = handSheet([applicant("amy")], { amy: hand("amy") });

    expect(sheet.kind).toBe("drawing");
    expect(sheet.drawn).toBe(1);
  });
});

/* --- The boundary: no value import --------------------------------- */

describe("hands-sheet.ts is safe on both sides of the client boundary", () => {
  /*
   * A `"use client"` panel will hold this module, and the tab's server page may
   * too. `client-boundary.test.ts` sweeps for a named value import *from* a
   * client module; the matching hazard in this direction is this module pulling
   * a value from `@/db` or `@/lib/hero-hands` into the browser bundle. Asserted
   * the way that sweep asserts: on the file's text, with the same `import …
   * from` shape, because the directive and the import are facts about a file.
   */
  it("imports nothing but types", () => {
    const source = readFileSync(path.resolve(__dirname, "../hands-sheet.ts"), "utf8");
    const imports = [...source.matchAll(/^\s*import\s+([^;]+?)\s+from\s+["']([^"']+)["']/gm)];

    expect(imports.length, "the sweep must see the module's imports").toBeGreaterThan(0);
    const values = imports.filter(([, clause]) => !/^type\b/.test(clause));
    expect(
      values.map(([line]) => line.trim()),
      "a value import here would ship Postgres to the browser"
    ).toEqual([]);
  });
});
