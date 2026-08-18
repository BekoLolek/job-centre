/**
 * The visible half of the live re-flow.
 *
 * The engine already moves the rest of the day when a block finishes; these
 * cover the bit the admin actually sees, which is the difference between two
 * boards. The important cases are the quiet ones — a match that gained or lost
 * a time altogether — because those are exactly what a naive minute subtraction
 * would turn into `NaN`.
 */

import { describe, expect, it } from "vitest";
import type { ResolvedMatch } from "@/lib/format-resolve";
import { scheduleShifts, shiftText } from "../shifts";

function match(slot: string, scheduledAt: string | null): ResolvedMatch {
  return {
    slot,
    bestOf: 3,
    teamAId: null,
    teamBId: null,
    sourceA: null,
    sourceB: null,
    scheduledAt,
    finishedAt: null,
    durationMin: null,
    winnerOverrideId: null,
    firstSideChoice: "a",
    games: [],
    choices: [],
    round: 1,
    phase: 1,
    bracket: "upper",
    group: null,
    label: slot,
    displayLabel: slot.toUpperCase(),
    roundLabel: slot,
    note: null,
    elimination: true,
    modes: [],
    nameA: "A",
    nameB: "B",
    gamesWonA: 0,
    gamesWonB: 0,
    winner: null,
    loser: null,
    status: "pending",
    needsDecision: false,
    skipped: false,
  };
}

const board = (...matches: ResolvedMatch[]) => ({ stages: [{ matches }] });

describe("scheduleShifts", () => {
  it("reports only what moved, with the size and the direction", () => {
    const before = board(
      match("ubsf1", "2026-08-15T16:00:00.000Z"),
      match("ubf", "2026-08-15T17:00:00.000Z")
    );
    const after = board(
      match("ubsf1", "2026-08-15T16:00:00.000Z"),
      match("ubf", "2026-08-15T17:20:00.000Z")
    );

    const shifts = scheduleShifts(before, after);
    expect(shifts).toHaveLength(1);
    expect(shifts[0].slot).toBe("ubf");
    expect(shifts[0].deltaMin).toBe(20);
    expect(shiftText(shifts[0])).toBe("20 minutes later");
  });

  it("says 'earlier' when a day catches up", () => {
    const shifts = scheduleShifts(
      board(match("gf", "2026-08-15T20:00:00.000Z")),
      board(match("gf", "2026-08-15T19:59:00.000Z"))
    );
    expect(shiftText(shifts[0])).toBe("1 minute earlier");
  });

  it("handles a match that had no time, and one that lost its time", () => {
    const gained = scheduleShifts(
      board(match("gf", null)),
      board(match("gf", "2026-08-15T20:00:00.000Z"))
    );
    expect(gained[0].deltaMin).toBeNull();
    expect(shiftText(gained[0])).toBe("now scheduled");

    const lost = scheduleShifts(
      board(match("gf", "2026-08-15T20:00:00.000Z")),
      board(match("gf", null))
    );
    expect(shiftText(lost[0])).toBe("no longer scheduled");
  });

  it("ignores a slot that did not exist before — a regeneration is not a shift", () => {
    const shifts = scheduleShifts(
      board(match("ubsf1", "2026-08-15T16:00:00.000Z")),
      board(
        match("ubsf1", "2026-08-15T16:00:00.000Z"),
        match("ubsf2", "2026-08-15T16:00:00.000Z")
      )
    );
    expect(shifts).toEqual([]);
  });

  it("looks across every stage, since a day spans them", () => {
    const before = {
      stages: [
        { matches: [match("rr-1-2", "2026-08-15T16:00:00.000Z")] },
        { matches: [match("gf", "2026-08-15T20:00:00.000Z")] },
      ],
    };
    const after = {
      stages: [
        { matches: [match("rr-1-2", "2026-08-15T16:00:00.000Z")] },
        { matches: [match("gf", "2026-08-15T20:30:00.000Z")] },
      ],
    };
    expect(scheduleShifts(before, after).map((shift) => shift.slot)).toEqual(["gf"]);
  });
});
