import { describe, expect, it } from "vitest";
import type { ApplicationStatus, EventStatus } from "@/db";
import {
  CONFIRMATION_LEAD_MS,
  EVENT_STATUS_FLOW,
  type EventTimingView,
  MIN_CAPACITY,
  NIGHT_FORMATS,
  isNightFormat,
  teamFormatFrom,
  type WaitlistApplication,
  applicationsOpen,
  canTransition,
  capacityProblem,
  capacityState,
  changedSetupFields,
  dayName,
  daySequenceProblem,
  confirmationDeadline,
  confirmationsOpen,
  eligibility,
  entryMode,
  eventDates,
  missingToPublish,
  nextWaitlistPosition,
  promoteFromWaitlist,
  rankMeetsMinimum,
  recomputeWaitlist,
  signupWindowProblem,
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
  // docs/diagrams/event-state.md, edge for edge, over every pair. UC-09 3a:
  // any other transition is refused — including staying put, which is not a
  // transition (`updateEvent` treats an unchanged status as no move at all).
  // This replaces the old "a mistaken cancellation can be undone" test: the
  // diagram makes cancelled terminal.
  it.each([
    ["draft", "draft", false],
    ["draft", "published", true],
    ["draft", "live", false],
    ["draft", "complete", false],
    ["draft", "cancelled", false],
    ["published", "draft", true],
    ["published", "published", false],
    ["published", "live", true],
    ["published", "complete", false],
    ["published", "cancelled", true],
    ["live", "draft", false],
    ["live", "published", false],
    ["live", "live", false],
    ["live", "complete", true],
    ["live", "cancelled", true],
    ["complete", "draft", false],
    ["complete", "published", false],
    ["complete", "live", true],
    ["complete", "complete", false],
    ["complete", "cancelled", false],
    ["cancelled", "draft", false],
    ["cancelled", "published", false],
    ["cancelled", "live", false],
    ["cancelled", "complete", false],
    ["cancelled", "cancelled", false],
  ] as Array<[EventStatus, EventStatus, boolean]>)("%s → %s allowed: %s", (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
  });

  it("treats cancelled as terminal", () => {
    expect(EVENT_STATUS_FLOW.cancelled).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

describe("missingToPublish — UC-09 2 and 2a", () => {
  const ready = {
    title: "Rivals Cup",
    signupOpensAt: hoursFromNow(1),
    signupClosesAt: hoursFromNow(24),
    days: [{ startsAt: hoursFromNow(48) }],
  };

  it("asks for nothing when there is a name, a timed day and a sign-up window", () => {
    expect(missingToPublish(ready)).toEqual([]);
  });

  it("asks for a name", () => {
    expect(missingToPublish({ ...ready, title: "   " })).toEqual(["name"]);
  });

  it("asks for a day when there are none", () => {
    expect(missingToPublish({ ...ready, days: [] })).toEqual(["day"]);
  });

  it("asks for a day when no day has a start time", () => {
    expect(missingToPublish({ ...ready, days: [{ startsAt: null }] })).toEqual(["day"]);
  });

  it("asks for the sign-up window when it has no opening time", () => {
    expect(missingToPublish({ ...ready, signupOpensAt: null })).toEqual(["window"]);
  });

  it("asks for the sign-up window when it has no closing time", () => {
    expect(missingToPublish({ ...ready, signupClosesAt: null })).toEqual(["window"]);
  });

  it("lists everything missing at once", () => {
    const bare = { title: "", signupOpensAt: null, signupClosesAt: null, days: [] };
    expect(missingToPublish(bare)).toEqual(["name", "day", "window"]);
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

  it("keeps an approval event open once the seats are full, waitlist or not (UC-12 7b)", () => {
    const state = applicationsOpen(
      event({ capacity: 12, config: { entryMode: "approval", waitlist: false } }),
      NOW,
      { accepted: 12 }
    );
    expect(state.open).toBe(true);
    if (!state.open) return;
    expect(state.willWaitlist).toBe(false);
    expect(state.message).toMatch(/review/i);
  });

  it("reads an event with no entry mode as first come, so existing events are unchanged", () => {
    expect(entryMode(null)).toBe("first_come");
    expect(entryMode({})).toBe("first_come");
    expect(entryMode({ waitlist: false })).toBe("first_come");
    expect(entryMode({ entryMode: "approval" })).toBe("approval");
  });

  it("defaults the waitlist on, and only an explicit false turns it off", () => {
    expect(waitlistEnabled(null)).toBe(true);
    expect(waitlistEnabled({})).toBe(true);
    expect(waitlistEnabled({ waitlist: true })).toBe(true);
    expect(waitlistEnabled({ waitlist: false })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

/*
 * When the "still coming?" answer closes — R-200, UC-13 7, 7a.
 *
 * Three things, and the third is the one that bites. The deadline is two days
 * before the start; the boundary is inclusive, the same way `applicationsOpen`
 * is inclusive at `signupClosesAt`, so the minute either side of it is worth
 * pinning separately; and an event with **no start date** has no deadline at
 * all, which must not collapse into "closed". That last case is a real event in
 * the local fixtures (`qa-undated-lan`), and reading null as closed locks every
 * applicant out of an event nobody has scheduled yet.
 */
describe("confirmationDeadline and confirmationsOpen — UC-13 7", () => {
  const STARTS = new Date("2026-03-20T19:00:00Z");
  const DEADLINE = new Date("2026-03-18T19:00:00Z");
  const minutesFrom = (at: Date, minutes: number) =>
    new Date(at.getTime() + minutes * 60_000);

  it("is two days before the start, to the minute", () => {
    expect(CONFIRMATION_LEAD_MS).toBe(48 * 60 * 60 * 1000);
    expect(confirmationDeadline(STARTS)).toEqual(DEADLINE);
  });

  it("is open a minute before the deadline and shut a minute after it", () => {
    expect(confirmationsOpen(STARTS, minutesFrom(DEADLINE, -1))).toBe(true);
    expect(confirmationsOpen(STARTS, minutesFrom(DEADLINE, 1))).toBe(false);
  });

  it("counts an answer landing exactly on the deadline as in time", () => {
    // Inclusive, like the signup window: "closes at 19:00" accepts 19:00. The
    // millisecond after is the first one that is late.
    expect(confirmationsOpen(STARTS, DEADLINE)).toBe(true);
    expect(confirmationsOpen(STARTS, new Date(DEADLINE.getTime() + 1))).toBe(false);
  });

  it("stays shut for the whole run-up once it has closed", () => {
    expect(confirmationsOpen(STARTS, minutesFrom(STARTS, -60))).toBe(false);
    expect(confirmationsOpen(STARTS, STARTS)).toBe(false);
  });

  it("gives an event with no start date no deadline, and leaves it answerable", () => {
    expect(confirmationDeadline(null)).toBeNull();
    expect(confirmationDeadline(undefined)).toBeNull();
    // Null is "no deadline", not "the deadline has passed" — the difference
    // between an unscheduled event members can still answer about and one they
    // are locked out of for ever.
    expect(confirmationsOpen(null, NOW)).toBe(true);
    expect(confirmationsOpen(undefined, NOW)).toBe(true);
    expect(confirmationsOpen(null, new Date("2099-01-01T00:00:00Z"))).toBe(true);
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

/* ------------------------------------------------------------------ */
/* When an event runs — derived from its days (R-24)                  */
/* ------------------------------------------------------------------ */

describe("eventDates", () => {
  const day = (hours: number | null, label?: string) => ({
    startsAt: hours === null ? null : hoursFromNow(hours),
    label,
  });

  // UC-11 2, and the point of the whole change: the event page's date range,
  // the hub's countdown and the archive split all read this.
  it("starts at the first day and ends at the last", () => {
    expect(eventDates([day(24), day(48), day(72)])).toEqual({
      startsAt: hoursFromNow(24),
      endsAt: hoursFromNow(72),
    });
  });

  /*
   * One evening is not a range. Everything that asks "when was this over"
   * reads `endsAt ?? startsAt` and gets the same answer either way, while
   * every date range on the site would otherwise print the same instant twice
   * with an arrow between them.
   */
  it("gives a single-day event no end", () => {
    expect(eventDates([day(24)])).toEqual({ startsAt: hoursFromNow(24), endsAt: null });
  });

  it("gives an event nobody has scheduled no dates at all", () => {
    expect(eventDates([])).toEqual({ startsAt: null, endsAt: null });
    // A day with no time yet is a real state (`event_days.starts_at` is
    // nullable on purpose) and it is not a date (UC-13 7a).
    expect(eventDates([day(null), day(null)])).toEqual({ startsAt: null, endsAt: null });
  });

  it("skips the days whose time is still to be agreed", () => {
    expect(eventDates([day(24), day(null), day(72)])).toEqual({
      startsAt: hoursFromNow(24),
      endsAt: hoursFromNow(72),
    });
  });

  /*
   * `daySequenceProblem` stops a day list being *written* out of order, so
   * normally the earliest day is also day 0. A row written before that rule
   * existed can still be the other way round, and an event reporting an end
   * before its own start would put a backwards range on every screen.
   */
  it("reads the earliest and the latest even if the stored rows run backwards", () => {
    expect(eventDates([day(72), day(24)])).toEqual({
      startsAt: hoursFromNow(24),
      endsAt: hoursFromNow(72),
    });
  });
});

/* ------------------------------------------------------------------ */
/* Setting one up (UC-08 10, 10c)                                     */
/* ------------------------------------------------------------------ */

describe("capacityProblem", () => {
  // R-26, and docs/domain-model.md: "seatCap | number | at least 2".
  it("refuses a cap below two, saying what the minimum is", () => {
    expect(capacityProblem(1)).toMatch(/at least 2 seats/);
    expect(capacityProblem(0)).toMatch(/at least 2 seats/);
    expect(capacityProblem(-4)).toMatch(/at least 2 seats/);
  });

  it("accepts the minimum and anything above it", () => {
    expect(capacityProblem(MIN_CAPACITY)).toBeNull();
    expect(capacityProblem(40)).toBeNull();
  });

  /*
   * UC-08 E5 lists "no cap" as something the checklist *advises* about rather
   * than something that blocks, and the local fixtures have an uncapped LAN in
   * them. Null is no limit at all, which is not a limit below two.
   */
  it("leaves an uncapped event alone", () => {
    expect(capacityProblem(null)).toBeNull();
  });

  it("refuses something that is not a whole number of seats", () => {
    expect(capacityProblem(2.5)).toMatch(/whole number of seats/);
    expect(capacityProblem(Number.NaN)).toMatch(/whole number of seats/);
  });
});

/*
 * UC-08 E3's label, and the one rule for it: the event page's day list, the
 * admin's day list and the sequence refusals all name a day with this, so a
 * refusal that says "Saturday starts before Friday" names the days the reader
 * is looking at.
 */
describe("dayName", () => {
  it("prefers the label the manager typed", () => {
    expect(dayName({ startsAt: null, label: "Finals night" }, 2)).toBe("Finals night");
  });

  it("falls back to the day's number, counting from one", () => {
    expect(dayName({ startsAt: null, label: null }, 0)).toBe("Day 1");
    expect(dayName({ startsAt: null }, 3)).toBe("Day 4");
  });

  /*
   * A label of spaces is not a label. `label ?? …` — which is what the copies
   * in the components still do (docs/plan.md, Task 51) — renders it as nothing
   * at all, so the day on the page has no name beside its time.
   */
  it("treats a whitespace-only label as no label", () => {
    expect(dayName({ startsAt: null, label: "   " }, 0)).toBe("Day 1");
    // Trimmed, not rejected, when there is something inside it.
    expect(dayName({ startsAt: null, label: "  Sunday  " }, 1)).toBe("Sunday");
  });
});

describe("daySequenceProblem", () => {
  const day = (hours: number | null, label?: string | null) => ({
    startsAt: hours === null ? null : hoursFromNow(hours),
    label,
  });

  it("accepts days that run in the order they are listed", () => {
    expect(daySequenceProblem([day(24), day(48), day(72)])).toBeNull();
  });

  // UC-08 10c, "days overlap". With a start and no length, two days starting
  // at the same moment is the whole of what overlapping can mean.
  it("refuses two days that start at the same moment", () => {
    expect(daySequenceProblem([day(24), day(24)])).toBe(
      "Day 2 starts at the same time as Day 1. Two days of one event cannot run at once."
    );
  });

  it("refuses a day that starts before the one in front of it", () => {
    expect(daySequenceProblem([day(24), day(72), day(48)])).toBe(
      "Day 3 starts before Day 2. Put the days in the order they run."
    );
  });

  // UC-08 E3: the label is used wherever the day is named, and a refusal is
  // one of the places a day gets named.
  it("names the days the way the manager labelled them", () => {
    expect(daySequenceProblem([day(48, "Saturday"), day(24, "Sunday")])).toBe(
      "Sunday starts before Saturday. Put the days in the order they run."
    );
  });

  it("ignores days whose time is still to be agreed", () => {
    expect(daySequenceProblem([day(24), day(null), day(48)])).toBeNull();
    expect(daySequenceProblem([day(null), day(null)])).toBeNull();
  });
});

describe("signupWindowProblem", () => {
  const window = (opens: number | null, closes: number | null) => ({
    signupOpensAt: opens === null ? null : hoursFromNow(opens),
    signupClosesAt: closes === null ? null : hoursFromNow(closes),
  });

  // UC-08 10c, "sign-ups close after the first day starts": R-25's window has
  // to fit inside the event it is a window onto.
  it("refuses sign-ups that close after the first day starts", () => {
    expect(signupWindowProblem(window(0, 48), hoursFromNow(24))).toMatch(
      /close them no later than the start/i
    );
  });

  /*
   * Inclusive, like every other deadline here — `applicationsOpen` accepts an
   * application timestamped exactly on the closing time, and "sign up right up
   * to the minute it starts" is a real intention.
   */
  it("allows sign-ups that close exactly as it starts", () => {
    expect(signupWindowProblem(window(0, 24), hoursFromNow(24))).toBeNull();
  });

  it("refuses a window that closes before it opens", () => {
    expect(signupWindowProblem(window(48, 24), hoursFromNow(72))).toMatch(
      /close before they open/i
    );
  });

  it("refuses sign-ups that open after the event has started", () => {
    expect(signupWindowProblem(window(48, 72), hoursFromNow(24))).toMatch(
      /nobody could ever apply/i
    );
  });

  // An event nobody has scheduled has no first day to be later than, so a
  // window on it is whatever the manager says it is.
  it("has nothing to say about an event with no date", () => {
    expect(signupWindowProblem(window(0, 48), null)).toBeNull();
  });

  it("has nothing to say when there is no window", () => {
    expect(signupWindowProblem(window(null, null), hoursFromNow(24))).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Is this save worth telling anybody about? (R-98, UC-08 10b)        */
/* ------------------------------------------------------------------ */

describe("changedSetupFields", () => {
  const setup = (over: Record<string, unknown> = {}) => ({
    title: "Spring Rivals",
    type: "tournament",
    description: "A thing",
    slug: "spring-rivals",
    gameId: "game-1",
    capacity: 8,
    signupOpensAt: hoursFromNow(0),
    signupClosesAt: hoursFromNow(24),
    minRankToEnter: null,
    minRankToCaptain: null,
    ...over,
  });

  // The rule behind "notifications only when something actually changed": a
  // manager who presses Save having touched nothing has produced no news
  // (UC-08 10b).
  it("finds nothing in a save that changed nothing", () => {
    expect(changedSetupFields(setup(), setup())).toEqual([]);
  });

  it("names the fields that moved", () => {
    expect(changedSetupFields(setup(), setup({ title: "Autumn Rivals", capacity: 16 }))).toEqual([
      "title",
      "capacity",
    ]);
  });

  /*
   * Two `Date` objects for the same instant are the same answer, and `!==` on
   * them is always true — so comparing them by identity would report a change
   * on every save, which is the same bug as not comparing at all.
   */
  it("compares dates by instant rather than by identity", () => {
    const again = new Date(hoursFromNow(24).getTime());
    expect(changedSetupFields(setup(), setup({ signupClosesAt: again }))).toEqual([]);
    expect(changedSetupFields(setup(), setup({ signupClosesAt: hoursFromNow(25) }))).toEqual([
      "signupClosesAt",
    ]);
    expect(changedSetupFields(setup(), setup({ signupClosesAt: null }))).toEqual([
      "signupClosesAt",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* The night's format (R-215 / UC-41 1, 2)                            */
/* ------------------------------------------------------------------ */

describe("the night's format", () => {
  it("reads 6v6 as a 2-2-2 comp and teams of six", () => {
    expect(teamFormatFrom({ teamFormat: "6v6" })).toEqual({
      format: "6v6",
      teamSize: 6,
      comp: "2-2-2",
    });
  });

  it("reads 3v3 as a 1-1-1 comp and teams of three", () => {
    expect(teamFormatFrom({ teamFormat: "3v3" })).toEqual({
      format: "3v3",
      teamSize: 3,
      comp: "1-1-1",
    });
  });

  /*
   * The same tolerance `entryMode` has, and for the same reason: an event
   * stored before the format existed, or a template carrying a value nobody
   * recognises, behaves as the common night rather than as nothing.
   */
  it("falls back to 6v6 for anything it does not recognise", () => {
    expect(teamFormatFrom(null).format).toBe("6v6");
    expect(teamFormatFrom(undefined).format).toBe("6v6");
    expect(teamFormatFrom({}).format).toBe("6v6");
    expect(teamFormatFrom({ teamFormat: "5v5" }).format).toBe("6v6");
    expect(teamFormatFrom({ teamFormat: 6 }).format).toBe("6v6");
    expect(teamFormatFrom({ teamFormat: null }).format).toBe("6v6");
  });

  it("is not derived from anything else on the config", () => {
    // The correction the plan records: the format is the admin's stored call,
    // so a head count sitting beside it changes nothing.
    expect(teamFormatFrom({ teamFormat: "3v3", teams: 2, capacity: 12 }).teamSize).toBe(3);
    expect(teamFormatFrom({ teams: 4 }).format).toBe("6v6");
  });

  it("knows which strings off the wire are formats at all", () => {
    expect(isNightFormat("6v6")).toBe(true);
    expect(isNightFormat("3v3")).toBe(true);
    expect(isNightFormat("5v5")).toBe(false);
    expect(isNightFormat("")).toBe(false);
    expect(isNightFormat(undefined)).toBe(false);
    expect(isNightFormat(6)).toBe(false);
  });

  it("offers exactly the two formats R-215 names", () => {
    expect([...NIGHT_FORMATS]).toEqual(["6v6", "3v3"]);
  });
});
