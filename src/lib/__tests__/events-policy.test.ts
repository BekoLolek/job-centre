import { describe, expect, it } from "vitest";
import type { ApplicationStatus, EventStatus } from "@/db";
import {
  type EventTimingView,
  type WaitlistApplication,
  applicationsOpen,
  canTransition,
  capacityState,
  eligibility,
  nextStatuses,
  nextWaitlistPosition,
  promoteFromWaitlist,
  rankMeetsMinimum,
  recomputeWaitlist,
  waitlistEnabled,
} from "@/lib/events-policy";

/**
 * The event rules, with no database anywhere near them.
 *
 * Everything here is a pure function, so the tests can be exhaustive about the
 * cases that are expensive to reproduce for real: a signup window that closed
 * an hour ago, a member whose rank was deleted from the ladder last week, a
 * waitlist that three people have left out of order.
 */

const LADDER = [
  "Bronze III",
  "Bronze II",
  "Bronze I",
  "Silver III",
  "Gold III",
  "Platinum III",
  "Platinum II",
  "Platinum I",
  "Diamond III",
  "Diamond II",
  "Diamond I",
];

const NOW = new Date("2026-03-10T18:00:00Z");
const hoursFromNow = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000);

function event(over: Partial<EventTimingView> = {}): EventTimingView {
  return {
    status: "published",
    signupOpensAt: null,
    signupClosesAt: null,
    startsAt: null,
    capacity: null,
    config: null,
    ...over,
  };
}

/* ------------------------------------------------------------------ */

describe("event status transitions", () => {
  it("lets a draft be published or cancelled, and nothing else", () => {
    expect(nextStatuses("draft").sort()).toEqual(["cancelled", "published"]);
    expect(canTransition("draft", "published")).toBe(true);
    expect(canTransition("draft", "live")).toBe(false);
    expect(canTransition("draft", "complete")).toBe(false);
  });

  it("treats staying put as allowed, so a no-op edit is not an error", () => {
    const every: EventStatus[] = ["draft", "published", "live", "complete", "cancelled"];
    for (const status of every) expect(canTransition(status, status)).toBe(true);
  });

  it("never lists its own status as somewhere to go", () => {
    const every: EventStatus[] = ["draft", "published", "live", "complete", "cancelled"];
    for (const status of every) expect(nextStatuses(status)).not.toContain(status);
  });

  it("lets a mistaken cancellation and a mistaken completion be undone", () => {
    expect(canTransition("cancelled", "draft")).toBe(true);
    expect(canTransition("complete", "live")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe("applicationsOpen — the reason, not a boolean", () => {
  it("is open for a published event with no window at all", () => {
    const state = applicationsOpen(event(), NOW);
    expect(state.open).toBe(true);
    if (!state.open) return;
    expect(state.willWaitlist).toBe(false);
    expect(state.seatsLeft).toBeNull();
  });

  it("says not_published for a draft", () => {
    const state = applicationsOpen(event({ status: "draft" }), NOW);
    expect(state).toMatchObject({ open: false, reason: "not_published" });
  });

  it("says cancelled for a cancelled event", () => {
    expect(applicationsOpen(event({ status: "cancelled" }), NOW)).toMatchObject({
      open: false,
      reason: "cancelled",
    });
  });

  it("says finished for a complete event", () => {
    expect(applicationsOpen(event({ status: "complete" }), NOW)).toMatchObject({
      open: false,
      reason: "finished",
    });
  });

  it("says event_started for a live event even inside its signup window", () => {
    const state = applicationsOpen(
      event({ status: "live", signupClosesAt: hoursFromNow(5) }),
      NOW
    );
    expect(state).toMatchObject({ open: false, reason: "event_started" });
  });

  it("says too_early before signups open, and hands back when", () => {
    const opensAt = hoursFromNow(2);
    const state = applicationsOpen(event({ signupOpensAt: opensAt }), NOW);
    expect(state).toMatchObject({ open: false, reason: "too_early" });
    if (state.open) return;
    expect(state.opensAt).toEqual(opensAt);
  });

  it("opens on the stroke of the opening time", () => {
    expect(applicationsOpen(event({ signupOpensAt: NOW }), NOW).open).toBe(true);
  });

  it("says signups_closed after the deadline", () => {
    const state = applicationsOpen(event({ signupClosesAt: hoursFromNow(-1) }), NOW);
    expect(state).toMatchObject({ open: false, reason: "signups_closed" });
  });

  it("still accepts an application timestamped exactly on the deadline", () => {
    expect(applicationsOpen(event({ signupClosesAt: NOW }), NOW).open).toBe(true);
  });

  it("closes one millisecond after the deadline", () => {
    const closesAt = new Date(NOW.getTime() - 1);
    expect(applicationsOpen(event({ signupClosesAt: closesAt }), NOW)).toMatchObject({
      open: false,
      reason: "signups_closed",
    });
  });

  it("says event_started once the start time passes, whatever the window says", () => {
    const state = applicationsOpen(
      event({ startsAt: hoursFromNow(-1), signupClosesAt: hoursFromNow(3) }),
      NOW
    );
    expect(state).toMatchObject({ open: false, reason: "event_started" });
  });

  it("closes at the exact start instant", () => {
    expect(applicationsOpen(event({ startsAt: NOW }), NOW)).toMatchObject({
      open: false,
      reason: "event_started",
    });
  });

  it("stays open and warns about the queue when a capped event is full", () => {
    const state = applicationsOpen(event({ capacity: 12 }), NOW, { accepted: 12 });
    expect(state.open).toBe(true);
    if (!state.open) return;
    expect(state.willWaitlist).toBe(true);
    expect(state.seatsLeft).toBe(0);
    expect(state.message).toMatch(/waitlist/i);
  });

  it("says full only when the event has switched its waitlist off", () => {
    const state = applicationsOpen(event({ capacity: 12, config: { waitlist: false } }), NOW, {
      accepted: 12,
    });
    expect(state).toMatchObject({ open: false, reason: "full" });
  });

  it("counts the last seat as open", () => {
    const state = applicationsOpen(event({ capacity: 12 }), NOW, { accepted: 11 });
    expect(state.open).toBe(true);
    if (!state.open) return;
    expect(state.seatsLeft).toBe(1);
    expect(state.willWaitlist).toBe(false);
  });

  it("never reports negative seats when an admin has overfilled the event", () => {
    const state = applicationsOpen(event({ capacity: 4 }), NOW, { accepted: 7 });
    expect(state.open).toBe(true);
    if (!state.open) return;
    expect(state.seatsLeft).toBe(0);
    expect(state.willWaitlist).toBe(true);
  });

  it("checks status before timing, so a cancelled full event says cancelled", () => {
    const state = applicationsOpen(
      event({ status: "cancelled", capacity: 1, config: { waitlist: false } }),
      NOW,
      { accepted: 1 }
    );
    expect(state).toMatchObject({ open: false, reason: "cancelled" });
  });

  it("defaults the waitlist on, and only an explicit false turns it off", () => {
    expect(waitlistEnabled(null)).toBe(true);
    expect(waitlistEnabled({})).toBe(true);
    expect(waitlistEnabled({ waitlist: true })).toBe(true);
    expect(waitlistEnabled({ waitlist: false })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("rankMeetsMinimum", () => {
  it("passes everybody when there is no minimum", () => {
    expect(rankMeetsMinimum("Bronze III", null, LADDER)).toMatchObject({
      ok: true,
      reason: "no_minimum",
    });
    expect(rankMeetsMinimum(null, "  ", LADDER)).toMatchObject({ ok: true, reason: "no_minimum" });
  });

  it("passes everybody when the game has no ladder at all", () => {
    expect(rankMeetsMinimum(null, "Platinum III", [])).toMatchObject({
      ok: true,
      reason: "no_ladder",
    });
  });

  it("passes on equal rank", () => {
    const check = rankMeetsMinimum("Platinum III", "Platinum III", LADDER);
    expect(check.ok).toBe(true);
    expect(check.reason).toBe("meets");
    expect(check.userIndex).toBe(check.minIndex);
  });

  it("passes above the threshold and fails below it", () => {
    expect(rankMeetsMinimum("Diamond II", "Platinum III", LADDER).ok).toBe(true);
    const below = rankMeetsMinimum("Silver III", "Platinum III", LADDER);
    expect(below.ok).toBe(false);
    expect(below.reason).toBe("below");
    expect(below.message).toContain("Platinum III");
    expect(below.message).toContain("Silver III");
  });

  it("fails a member with no rank recorded, and says to go and set it", () => {
    const check = rankMeetsMinimum(null, "Platinum III", LADDER);
    expect(check).toMatchObject({ ok: false, reason: "no_rank", userIndex: null });
    expect(check.message).toMatch(/profile/i);
  });

  it("treats an empty string as no rank rather than as a rank", () => {
    expect(rankMeetsMinimum("   ", "Platinum III", LADDER)).toMatchObject({
      ok: false,
      reason: "no_rank",
    });
  });

  it("fails a member whose rank has been dropped from the ladder, and asks again", () => {
    const check = rankMeetsMinimum("Vibranium I", "Platinum III", LADDER);
    expect(check).toMatchObject({ ok: false, reason: "unknown_rank" });
    expect(check.message).toMatch(/pick it again/i);
  });

  it("does not lock everyone out when the threshold itself left the ladder", () => {
    const check = rankMeetsMinimum("Bronze III", "Vibranium I", LADDER);
    expect(check).toMatchObject({ ok: true, reason: "minimum_unknown" });
    expect(check.message).toMatch(/not being enforced/i);
  });

  it("is tolerant of whitespace and case in either rank", () => {
    expect(rankMeetsMinimum("  diamond ii ", "PLATINUM III", LADDER).ok).toBe(true);
  });

  it("compares ladder positions rather than names", () => {
    // "Gold III" sorts before "Silver III" alphabetically but is above it here.
    expect(rankMeetsMinimum("Gold III", "Silver III", LADDER).ok).toBe(true);
    expect(rankMeetsMinimum("Silver III", "Gold III", LADDER).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("eligibility", () => {
  const gates = { minRankToEnter: "Platinum III", minRankToCaptain: "Diamond II" };

  it("lets a high enough member do both", () => {
    const result = eligibility(gates, { rank: "Diamond I" }, LADDER);
    expect(result.canEnter).toBe(true);
    expect(result.canCaptain).toBe(true);
    expect(result.captainReason).toMatch(/captain/i);
  });

  it("lets a middling member enter but not captain, and says why", () => {
    const result = eligibility(gates, { rank: "Platinum I" }, LADDER);
    expect(result.canEnter).toBe(true);
    expect(result.canCaptain).toBe(false);
    expect(result.captainReason).toContain("Diamond II");
  });

  it("refuses both below the entry threshold, and gives the entry reason twice", () => {
    const result = eligibility(gates, { rank: "Bronze III" }, LADDER);
    expect(result.canEnter).toBe(false);
    expect(result.canCaptain).toBe(false);
    expect(result.captainReason).toBe(result.enterReason);
  });

  it("lets everybody in when the event sets no thresholds", () => {
    const result = eligibility(
      { minRankToEnter: null, minRankToCaptain: null },
      { rank: null },
      LADDER
    );
    expect(result.canEnter).toBe(true);
    expect(result.canCaptain).toBe(true);
  });

  it("refuses a member with no rank when entry has a threshold", () => {
    const result = eligibility(gates, { rank: null }, LADDER);
    expect(result.canEnter).toBe(false);
    expect(result.enterCheck.reason).toBe("no_rank");
  });
});

/* ------------------------------------------------------------------ */

const submittedAt = (minute: number) => new Date(`2026-03-01T12:${String(minute).padStart(2, "0")}:00Z`);

function application(
  id: string,
  status: ApplicationStatus,
  minute: number,
  waitlistPosition: number | null = null
): WaitlistApplication {
  return { id, status, submittedAt: submittedAt(minute), waitlistPosition };
}

describe("capacityState", () => {
  it("counts accepted and queued, and works out the seats left", () => {
    const state = capacityState({ capacity: 4 }, [
      application("a", "accepted", 1),
      application("b", "accepted", 2),
      application("c", "waitlisted", 3, 1),
      application("d", "declined", 4),
      application("e", "withdrawn", 5),
    ]);
    expect(state).toMatchObject({
      capacity: 4,
      accepted: 2,
      waitlisted: 1,
      seatsLeft: 2,
      full: false,
      overCapacity: false,
    });
  });

  it("reports an uncapped event as never full, with null seats left", () => {
    const state = capacityState({ capacity: null }, [application("a", "accepted", 1)]);
    expect(state.seatsLeft).toBeNull();
    expect(state.full).toBe(false);
  });

  it("flags an admin override that has gone past the cap", () => {
    const state = capacityState({ capacity: 1 }, [
      application("a", "accepted", 1),
      application("b", "accepted", 2),
    ]);
    expect(state).toMatchObject({ seatsLeft: 0, full: true, overCapacity: true });
  });
});

describe("nextWaitlistPosition", () => {
  it("starts at 1 on an empty queue", () => {
    expect(nextWaitlistPosition([])).toBe(1);
    expect(nextWaitlistPosition([application("a", "accepted", 1)])).toBe(1);
  });

  it("goes behind the last person in the queue", () => {
    expect(
      nextWaitlistPosition([
        application("a", "waitlisted", 1, 1),
        application("b", "waitlisted", 2, 2),
      ])
    ).toBe(3);
  });

  it("uses the highest position rather than the count, so a gap cannot collide", () => {
    expect(
      nextWaitlistPosition([
        application("a", "waitlisted", 1, 1),
        application("b", "waitlisted", 2, 4),
      ])
    ).toBe(5);
  });

  it("ignores positions left on rows that are no longer queued", () => {
    expect(
      nextWaitlistPosition([
        application("a", "waitlisted", 1, 1),
        application("b", "withdrawn", 2, 9),
      ])
    ).toBe(2);
  });
});

describe("recomputeWaitlist", () => {
  it("numbers the queue from 1 with no gaps", () => {
    const assignments = recomputeWaitlist([
      application("a", "waitlisted", 1, 2),
      application("b", "waitlisted", 2, 5),
      application("c", "waitlisted", 3, 9),
    ]);
    expect(assignments.map((row) => [row.id, row.waitlistPosition])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
  });

  it("closes the gap when somebody in the middle leaves", () => {
    const assignments = recomputeWaitlist([
      application("a", "waitlisted", 1, 1),
      application("b", "withdrawn", 2, null),
      application("c", "waitlisted", 3, 3),
    ]);
    const queued = assignments.filter((row) => row.waitlistPosition !== null);
    expect(queued).toEqual([
      { id: "a", waitlistPosition: 1, changed: false },
      { id: "c", waitlistPosition: 2, changed: true },
    ]);
  });

  it("clears the stale position off a row that is no longer queued", () => {
    const assignments = recomputeWaitlist([application("a", "accepted", 1, 3)]);
    expect(assignments).toEqual([{ id: "a", waitlistPosition: null, changed: true }]);
  });

  it("marks a row that already holds the right place as unchanged", () => {
    const assignments = recomputeWaitlist([application("a", "waitlisted", 1, 1)]);
    expect(assignments[0].changed).toBe(false);
  });

  it("keeps a hand-set order rather than resorting it by submission time", () => {
    // The admin has moved the later applicant to the front; a recompute must
    // not quietly undo that.
    const assignments = recomputeWaitlist([
      application("early", "waitlisted", 1, 2),
      application("late", "waitlisted", 9, 1),
    ]);
    expect(assignments.map((row) => row.id)).toEqual(["late", "early"]);
  });

  it("puts a newcomer with no position behind everybody who has one", () => {
    const assignments = recomputeWaitlist([
      application("new", "waitlisted", 1, null),
      application("queued", "waitlisted", 9, 1),
    ]);
    expect(assignments.map((row) => [row.id, row.waitlistPosition])).toEqual([
      ["queued", 1],
      ["new", 2],
    ]);
  });

  it("orders two positionless arrivals by submission time", () => {
    const assignments = recomputeWaitlist([
      application("later", "waitlisted", 5, null),
      application("earlier", "waitlisted", 2, null),
    ]);
    expect(assignments.map((row) => row.id)).toEqual(["earlier", "later"]);
  });

  it("is stable for two applications submitted in the same millisecond", () => {
    const same = new Date("2026-03-01T12:00:00Z");
    const rows: WaitlistApplication[] = [
      { id: "b", status: "waitlisted", submittedAt: same, waitlistPosition: null },
      { id: "a", status: "waitlisted", submittedAt: same, waitlistPosition: null },
    ];
    expect(recomputeWaitlist(rows).map((row) => row.id)).toEqual(["a", "b"]);
    expect(recomputeWaitlist([...rows].reverse()).map((row) => row.id)).toEqual(["a", "b"]);
  });
});

describe("promoteFromWaitlist", () => {
  it("takes the earliest waitlister when one seat frees", () => {
    const promotion = promoteFromWaitlist(
      [
        application("in", "accepted", 1),
        application("first", "waitlisted", 2, 1),
        application("second", "waitlisted", 3, 2),
      ],
      2
    );
    expect(promotion.promoted.map((row) => row.id)).toEqual(["first"]);
    expect(promotion.seatsLeft).toBe(0);
  });

  it("renumbers everyone left behind, contiguously", () => {
    const promotion = promoteFromWaitlist(
      [
        application("first", "waitlisted", 1, 1),
        application("second", "waitlisted", 2, 2),
        application("third", "waitlisted", 3, 3),
      ],
      1
    );
    expect(promotion.promoted.map((row) => row.id)).toEqual(["first"]);
    const queued = promotion.waitlist.filter((row) => row.waitlistPosition !== null);
    expect(queued).toEqual([
      { id: "second", waitlistPosition: 1, changed: true },
      { id: "third", waitlistPosition: 2, changed: true },
    ]);
  });

  it("fills several seats at once, in queue order", () => {
    const promotion = promoteFromWaitlist(
      [
        application("a", "waitlisted", 1, 1),
        application("b", "waitlisted", 2, 2),
        application("c", "waitlisted", 3, 3),
      ],
      2
    );
    expect(promotion.promoted.map((row) => row.id)).toEqual(["a", "b"]);
    expect(promotion.seatsLeft).toBe(0);
  });

  it("promotes nobody when the seats are still full", () => {
    const promotion = promoteFromWaitlist(
      [application("in", "accepted", 1), application("queued", "waitlisted", 2, 1)],
      1
    );
    expect(promotion.promoted).toEqual([]);
    expect(promotion.waitlist).toContainEqual({
      id: "queued",
      waitlistPosition: 1,
      changed: false,
    });
  });

  it("empties the queue entirely when the event is uncapped", () => {
    const promotion = promoteFromWaitlist(
      [
        application("a", "waitlisted", 1, 1),
        application("b", "waitlisted", 2, 2),
      ],
      null
    );
    expect(promotion.promoted.map((row) => row.id)).toEqual(["a", "b"]);
    expect(promotion.seatsLeft).toBeNull();
    expect(promotion.waitlist.every((row) => row.waitlistPosition === null)).toBe(true);
  });

  it("ignores declined and withdrawn rows when counting seats", () => {
    const promotion = promoteFromWaitlist(
      [
        application("gone", "withdrawn", 1),
        application("no", "declined", 2),
        application("queued", "waitlisted", 3, 1),
      ],
      1
    );
    expect(promotion.promoted.map((row) => row.id)).toEqual(["queued"]);
  });

  it("does not invent promotions for an event with nobody queued", () => {
    const promotion = promoteFromWaitlist([application("in", "accepted", 1)], 10);
    expect(promotion.promoted).toEqual([]);
    expect(promotion.seatsLeft).toBe(9);
  });
});
