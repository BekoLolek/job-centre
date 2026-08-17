/**
 * The rules an event obeys — all of them, in one place, with no database.
 *
 * docs/platform-plan.md §14 settles the application model: **first come, with a
 * waitlist and automatic promotion**. §8.3 adds two optional rank thresholds.
 * Between them there are four questions that get asked from at least three
 * places each — the public event page, the member's application form, and the
 * admin's applicant list:
 *
 *  1. Can anyone apply right now, and if not, *why* not?
 *  2. Is this member allowed in, and are they allowed to captain?
 *  3. Where does a new application land — a seat, or which place in the queue?
 *  4. Who moves up when a seat frees?
 *
 * Every answer here is a pure function over plain data. That is what makes the
 * awkward cases cheap to test: a signup window that closes before it opens, a
 * member whose recorded rank was deleted from the ladder last week, a waitlist
 * that has had three people withdraw out of order.
 *
 * ## The one thing this module refuses to do
 *
 * There is no `applications_open` column, and there must never be one. It would
 * be a copy of `applicationsOpen()` that goes stale the instant a deadline
 * passes with nobody looking. The same goes for "seats left": derived, always.
 */

import type { ApplicationStatus, EventConfig, EventStatus } from "@/db/schema";

/* ------------------------------------------------------------------ */
/* Status                                                             */
/* ------------------------------------------------------------------ */

/**
 * Which status may follow which.
 *
 * Nothing here is destructive — `cancelled` and `complete` are not dead ends,
 * because the usual reason to leave one is that somebody clicked the wrong
 * button. What the map does stop is the nonsense: an event cannot go from
 * `draft` straight to `live` without ever being published, so applications
 * cannot have been impossible and then suddenly be too late.
 */
export const EVENT_STATUS_FLOW: Readonly<Record<EventStatus, readonly EventStatus[]>> = {
  draft: ["published", "cancelled"],
  published: ["draft", "live", "complete", "cancelled"],
  live: ["published", "complete", "cancelled"],
  complete: ["live"],
  cancelled: ["draft", "published"],
};

/** The statuses an admin may move this event to. Never includes its own. */
export function nextStatuses(from: EventStatus): EventStatus[] {
  return [...EVENT_STATUS_FLOW[from]];
}

/** Is this status change allowed? Staying put always is. */
export function canTransition(from: EventStatus, to: EventStatus): boolean {
  return from === to || EVENT_STATUS_FLOW[from].includes(to);
}

/* ------------------------------------------------------------------ */
/* Are applications open?                                             */
/* ------------------------------------------------------------------ */

/** Just enough of an event to decide whether it is taking applications. */
export type EventTimingView = {
  status: EventStatus;
  signupOpensAt: Date | null;
  signupClosesAt: Date | null;
  startsAt: Date | null;
  /** Null is unlimited. */
  capacity: number | null;
  config?: EventConfig | null;
};

/** How many seats are already spoken for. */
export type SeatCounts = {
  accepted: number;
  waitlisted?: number;
};

/** Why a member cannot apply. The UI shows the reason, not a shrug. */
export type ClosedReason =
  /** Still a draft — members cannot even see it. */
  | "not_published"
  | "cancelled"
  /** The event has been and gone. */
  | "finished"
  /** Signups have a start date and it has not arrived. */
  | "too_early"
  /** Signups had a deadline and it has passed. */
  | "signups_closed"
  /** The event itself has started. */
  | "event_started"
  /** Every seat is taken and this event has its waitlist switched off. */
  | "full";

export type ApplicationsState =
  | {
      open: true;
      /** True when the seats are gone and a new application joins the queue. */
      willWaitlist: boolean;
      /** Null when the event is uncapped. */
      seatsLeft: number | null;
      closesAt: Date | null;
      message: string;
    }
  | {
      open: false;
      reason: ClosedReason;
      message: string;
      opensAt: Date | null;
      closesAt: Date | null;
    };

/** §14's default: a full event queues people rather than turning them away. */
export function waitlistEnabled(config: EventConfig | null | undefined): boolean {
  return config?.waitlist !== false;
}

/**
 * Whether this event is taking applications at `now`, and if not, why not.
 *
 * Boundaries are inclusive at both ends of the signup window — an event whose
 * signups close at 20:00 accepts an application timestamped exactly 20:00 —
 * and exclusive at the start of the event itself, because an event that has
 * begun is not one you can still sign up for.
 *
 * Being **full is not the same as being closed**. With the waitlist on (the
 * default) a full event still takes applications; they simply join the queue,
 * which is what `willWaitlist` tells the form to say before anyone types. Only
 * an event that has deliberately switched the waitlist off closes on `full`.
 *
 * `seats` is optional because the answer only depends on it for a capped
 * event; a caller with no counts to hand gets the timing answer.
 */
export function applicationsOpen(
  event: EventTimingView,
  now: Date,
  seats: SeatCounts = { accepted: 0 }
): ApplicationsState {
  const opensAt = event.signupOpensAt ?? null;
  const closesAt = event.signupClosesAt ?? null;
  const shut = (reason: ClosedReason, message: string): ApplicationsState => ({
    open: false,
    reason,
    message,
    opensAt,
    closesAt,
  });

  switch (event.status) {
    case "draft":
      return shut("not_published", "This event has not been published yet.");
    case "cancelled":
      return shut("cancelled", "This event was cancelled.");
    case "complete":
      return shut("finished", "This event is over.");
    case "live":
      return shut("event_started", "This event has already started.");
    case "published":
      break;
  }

  if (event.startsAt && now.getTime() >= event.startsAt.getTime()) {
    return shut("event_started", "This event has already started.");
  }
  if (opensAt && now.getTime() < opensAt.getTime()) {
    return shut("too_early", "Signups have not opened yet.");
  }
  if (closesAt && now.getTime() > closesAt.getTime()) {
    return shut("signups_closed", "Signups have closed.");
  }

  const seatsLeft =
    event.capacity === null ? null : Math.max(0, event.capacity - Math.max(0, seats.accepted));

  if (seatsLeft === 0) {
    if (!waitlistEnabled(event.config)) {
      return shut("full", "This event is full.");
    }
    return {
      open: true,
      willWaitlist: true,
      seatsLeft: 0,
      closesAt,
      message: "This event is full — apply and you will join the waitlist.",
    };
  }

  return {
    open: true,
    willWaitlist: false,
    seatsLeft,
    closesAt,
    message: "Applications are open.",
  };
}

/* ------------------------------------------------------------------ */
/* Rank thresholds (§8.3)                                             */
/* ------------------------------------------------------------------ */

export type RankReason =
  /** No threshold set — everybody clears it. */
  | "no_minimum"
  /** The game has no ladder, so a threshold cannot mean anything. */
  | "no_ladder"
  /** The threshold names a rank the ladder no longer has. Admin's problem. */
  | "minimum_unknown"
  /** The member has not recorded a rank. */
  | "no_rank"
  /** Their recorded rank was removed from the ladder. */
  | "unknown_rank"
  | "meets"
  | "below";

export type RankCheck = {
  ok: boolean;
  reason: RankReason;
  /** A sentence the member can read. */
  message: string;
  /** Ladder position of the member's rank, or null when it has none. */
  userIndex: number | null;
  minIndex: number | null;
};

/** Ladder lookup, tolerant of stray whitespace and admin capitalisation. */
function ladderIndex(rank: string | null | undefined, ladder: readonly string[]): number {
  if (typeof rank !== "string") return -1;
  const wanted = rank.trim().toLowerCase();
  if (!wanted) return -1;
  return ladder.findIndex((entry) => entry.trim().toLowerCase() === wanted);
}

/**
 * Does this member's rank clear the threshold?
 *
 * A comparison of two positions in the ordered ladder, which is the whole
 * reason §7 makes rank a picker rather than a typed string. Three edge cases
 * decide how this behaves in practice:
 *
 *  - **No threshold** (or a game with no ladder): everybody passes. An absent
 *    gate is not a closed one.
 *  - **A threshold naming a rank the ladder no longer has**: everybody passes,
 *    and the reason says so. Locking every member out of an event because an
 *    admin renamed a ladder entry would be the worst of the available
 *    behaviours; the event page can surface `minimum_unknown` to the admin.
 *  - **A member whose recorded rank is gone from the ladder**: they do *not*
 *    pass, and the message asks them to pick it again. §8.3 is explicit that a
 *    stored rank is a claim made on some past date, so re-asking is right.
 */
export function rankMeetsMinimum(
  userRank: string | null | undefined,
  minRank: string | null | undefined,
  ladder: readonly string[]
): RankCheck {
  const wantsRank = typeof minRank === "string" && minRank.trim() !== "";
  if (!wantsRank) {
    return {
      ok: true,
      reason: "no_minimum",
      message: "No rank requirement.",
      userIndex: ladderIndex(userRank, ladder),
      minIndex: null,
    };
  }

  if (ladder.length === 0) {
    return {
      ok: true,
      reason: "no_ladder",
      message: "This game has no ranks, so the rank requirement does not apply.",
      userIndex: null,
      minIndex: null,
    };
  }

  const minIndex = ladderIndex(minRank, ladder);
  if (minIndex === -1) {
    return {
      ok: true,
      reason: "minimum_unknown",
      message: `The rank requirement (${minRank}) is not in this game's ladder any more, so it is not being enforced.`,
      userIndex: ladderIndex(userRank, ladder),
      minIndex: null,
    };
  }

  const hasRank = typeof userRank === "string" && userRank.trim() !== "";
  if (!hasRank) {
    return {
      ok: false,
      reason: "no_rank",
      message: `This event needs ${ladder[minIndex]} or above. Add your rank to your profile first.`,
      userIndex: null,
      minIndex,
    };
  }

  const userIndex = ladderIndex(userRank, ladder);
  if (userIndex === -1) {
    return {
      ok: false,
      reason: "unknown_rank",
      message: `Your recorded rank (${userRank}) is not in this game's ladder any more. Pick it again on your profile.`,
      userIndex: null,
      minIndex,
    };
  }

  if (userIndex >= minIndex) {
    return {
      ok: true,
      reason: "meets",
      message: `${ladder[userIndex]} meets the ${ladder[minIndex]} requirement.`,
      userIndex,
      minIndex,
    };
  }

  return {
    ok: false,
    reason: "below",
    message: `This event needs ${ladder[minIndex]} or above; you are ${ladder[userIndex]}.`,
    userIndex,
    minIndex,
  };
}

/** The two thresholds an event can carry. */
export type EventGateView = {
  minRankToEnter: string | null;
  minRankToCaptain: string | null;
};

/** What this module needs to know about a member: their rank for this game. */
export type MemberRankView = {
  rank: string | null;
};

export type Eligibility = {
  canEnter: boolean;
  /** One sentence, for the member. */
  enterReason: string;
  canCaptain: boolean;
  captainReason: string;
  /** The underlying comparisons, for a UI that wants to be more specific. */
  enterCheck: RankCheck;
  captainCheck: RankCheck;
};

/**
 * Can this member enter, and can they captain — with a sentence for each.
 *
 * Captaincy implies entry: somebody who cannot get into the event cannot lead a
 * team in it, so a failed entry check is reported as the captain reason too
 * rather than showing two contradictory messages.
 *
 * Neither answer is a wall. §8.3 is explicit that an admin override must exist,
 * and it does: `setApplicationStatus` lets an admin accept anybody. This is the
 * guidance that stops someone wasting their time, not the enforcement.
 */
export function eligibility(
  event: EventGateView,
  member: MemberRankView,
  ladder: readonly string[]
): Eligibility {
  const enterCheck = rankMeetsMinimum(member.rank, event.minRankToEnter, ladder);
  const captainCheck = rankMeetsMinimum(member.rank, event.minRankToCaptain, ladder);

  const canEnter = enterCheck.ok;
  const canCaptain = canEnter && captainCheck.ok;

  return {
    canEnter,
    enterReason: enterCheck.ok ? "You can apply to this event." : enterCheck.message,
    canCaptain,
    captainReason: !canEnter
      ? enterCheck.message
      : captainCheck.ok
        ? "You can captain a team in this event."
        : captainCheck.message,
    enterCheck,
    captainCheck,
  };
}

/* ------------------------------------------------------------------ */
/* Seats and the queue (§14)                                          */
/* ------------------------------------------------------------------ */

/** Just enough of an application to place it in the queue. */
export type WaitlistApplication = {
  id: string;
  status: ApplicationStatus;
  submittedAt: Date;
  waitlistPosition: number | null;
};

export type CapacityState = {
  /** Null is unlimited. */
  capacity: number | null;
  accepted: number;
  waitlisted: number;
  /** Null when uncapped; never negative. */
  seatsLeft: number | null;
  full: boolean;
  /** True when an admin override has put more people in than the cap allows. */
  overCapacity: boolean;
};

/** Accepted, seats left and queue length — the three numbers every screen shows. */
export function capacityState(
  event: { capacity: number | null },
  applications: ReadonlyArray<{ status: ApplicationStatus }>
): CapacityState {
  const accepted = applications.filter((row) => row.status === "accepted").length;
  const waitlisted = applications.filter((row) => row.status === "waitlisted").length;
  const capacity = event.capacity ?? null;

  return {
    capacity,
    accepted,
    waitlisted,
    seatsLeft: capacity === null ? null : Math.max(0, capacity - accepted),
    full: capacity !== null && accepted >= capacity,
    overCapacity: capacity !== null && accepted > capacity,
  };
}

/**
 * Queue order: the place already held, then submission time, then id.
 *
 * Position first so an admin who reorders the queue by hand is not undone by
 * the next recompute; submission time as the tie-break because §14 says
 * first-come; id last so the order is total and two applications submitted in
 * the same millisecond do not swap places between two reads.
 */
function byQueueOrder(a: WaitlistApplication, b: WaitlistApplication): number {
  const positionA = a.waitlistPosition ?? Number.MAX_SAFE_INTEGER;
  const positionB = b.waitlistPosition ?? Number.MAX_SAFE_INTEGER;
  if (positionA !== positionB) return positionA - positionB;
  const timeA = a.submittedAt.getTime();
  const timeB = b.submittedAt.getTime();
  if (timeA !== timeB) return timeA - timeB;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The place at the back of the queue.
 *
 * Deliberately `max + 1` rather than `count + 1`: if the stored positions have
 * somehow developed a gap, counting would hand out a number somebody already
 * holds. Callers that renumber afterwards close the gap anyway.
 */
export function nextWaitlistPosition(
  existing: ReadonlyArray<{ status?: ApplicationStatus; waitlistPosition: number | null }>
): number {
  let highest = 0;
  for (const row of existing) {
    if (row.status !== undefined && row.status !== "waitlisted") continue;
    if (typeof row.waitlistPosition === "number" && row.waitlistPosition > highest) {
      highest = row.waitlistPosition;
    }
  }
  return highest + 1;
}

export type WaitlistAssignment = {
  id: string;
  /** The place this application should now hold; null when it is not queued. */
  waitlistPosition: number | null;
  /** False when the row already holds this value and needs no write. */
  changed: boolean;
};

/**
 * The position every application should hold, 1…n with no gaps.
 *
 * Called after *any* change to the set — an arrival, a withdrawal, an admin
 * decision — because a queue with a hole in it is a queue nobody trusts: "you
 * are #4" with only three people ahead is the bug members notice immediately.
 *
 * Every application comes back, not just the queued ones, so a caller can clear
 * the stale position off a row that has just been accepted. The result is
 * ordered by the new position, queued rows first.
 */
export function recomputeWaitlist(
  applications: ReadonlyArray<WaitlistApplication>
): WaitlistAssignment[] {
  const queued = applications.filter((row) => row.status === "waitlisted").sort(byQueueOrder);
  const rest = applications.filter((row) => row.status !== "waitlisted");

  const assigned: WaitlistAssignment[] = queued.map((row, index) => ({
    id: row.id,
    waitlistPosition: index + 1,
    changed: row.waitlistPosition !== index + 1,
  }));

  for (const row of rest) {
    assigned.push({
      id: row.id,
      waitlistPosition: null,
      changed: row.waitlistPosition !== null,
    });
  }

  return assigned;
}

export type Promotion<T extends WaitlistApplication> = {
  /** Queued applications a free seat lets in, earliest first. */
  promoted: T[];
  /** Where everyone stands afterwards, including the promoted rows (null). */
  waitlist: WaitlistAssignment[];
  /** Seats still free once the promotions are applied. Null when uncapped. */
  seatsLeft: number | null;
};

/**
 * Who moves up when a seat frees.
 *
 * The rule from §14, in one place: earliest submission first, as many as there
 * are seats. An uncapped event promotes the entire queue — a waitlist on an
 * event with no limit is a leftover from when there was one, and leaving people
 * queueing for a seat that cannot run out would be a bug.
 *
 * This does not care *why* the seat freed. Whether a withdrawal should promote
 * automatically and an admin decline should not is a decision for the caller
 * (`src/lib/events.ts` makes it); the arithmetic is the same either way.
 */
export function promoteFromWaitlist<T extends WaitlistApplication>(
  applications: readonly T[],
  capacity: number | null
): Promotion<T> {
  const accepted = applications.filter((row) => row.status === "accepted").length;
  const queued = applications.filter((row) => row.status === "waitlisted").sort(byQueueOrder);

  const seats = capacity === null ? queued.length : Math.max(0, capacity - accepted);
  const promoted = queued.slice(0, seats);
  const promotedIds = new Set(promoted.map((row) => row.id));

  // Recompute against the world as it will be, so the promoted rows drop out of
  // the queue and everyone behind them closes up.
  const after = applications.map((row) =>
    promotedIds.has(row.id) ? { ...row, status: "accepted" as ApplicationStatus } : row
  );

  return {
    promoted,
    waitlist: recomputeWaitlist(after),
    seatsLeft: capacity === null ? null : Math.max(0, capacity - accepted - promoted.length),
  };
}
