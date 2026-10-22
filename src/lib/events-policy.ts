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

import type {
  ApplicationStatus,
  EntryMode,
  EntryRule,
  EventConfig,
  EventStatus,
} from "@/db/schema";

/* ------------------------------------------------------------------ */
/* Status                                                             */
/* ------------------------------------------------------------------ */

/**
 * Which status may follow which — docs/diagrams/event-state.md, edge for edge.
 *
 * Nothing else is allowed (UC-09 3a). An event cannot go from `draft` straight
 * to `live` without ever being published, so applications cannot have been
 * impossible and then suddenly be too late; a `live` event cannot be hidden or
 * un-started, because people are playing in it; and `cancelled` is terminal —
 * the record of an event called off stays exactly that. The one way back is
 * `complete → live`, the reopen, because a finished event with a recorded
 * mistake in it has to be correctable, and the action layer writes down who
 * did it.
 */
export const EVENT_STATUS_FLOW: Readonly<Record<EventStatus, readonly EventStatus[]>> = {
  draft: ["published"],
  published: ["draft", "live", "cancelled"],
  live: ["complete", "cancelled"],
  complete: ["live"],
  cancelled: [],
};

/**
 * Is this status change allowed? Staying put is not a change, so it is not in
 * the map; a caller saving an unchanged status should not be asking.
 */
export function canTransition(from: EventStatus, to: EventStatus): boolean {
  return EVENT_STATUS_FLOW[from].includes(to);
}

/** The things UC-09 2 requires before an event may be published. */
export type PublishRequirement = "name" | "day" | "window";

/** Each requirement as the words that finish "It still needs …". */
export const PUBLISH_REQUIREMENT_TEXT: Readonly<Record<PublishRequirement, string>> = {
  name: "a name",
  day: "at least one day with a start time",
  window: "a sign-up window (when sign-ups open and when they close)",
};

/** Just enough of an event, with its days, to decide whether it may be published. */
export type PublishView = {
  title: string;
  signupOpensAt: Date | null;
  signupClosesAt: Date | null;
  days: ReadonlyArray<{ startsAt: Date | null }>;
};

/**
 * What this event still lacks before it may be published, in a fixed order;
 * empty when nothing does.
 *
 * The gate on every publishing path — the Publish tab, the status control, a
 * status patch — and the source of the checklist's refusals, so the screen
 * never disagrees with the server about what stops the button.
 */
export function missingToPublish(event: PublishView): PublishRequirement[] {
  const missing: PublishRequirement[] = [];
  if (!event.title.trim()) missing.push("name");
  if (!event.days.some((day) => day.startsAt !== null)) missing.push("day");
  if (!event.signupOpensAt || !event.signupClosesAt) missing.push("window");
  return missing;
}

/* ------------------------------------------------------------------ */
/* When an event runs — derived from its days (R-24)                  */
/* ------------------------------------------------------------------ */

/** A day as every rule below needs it: when it starts, and what it is called. */
export type DayView = {
  startsAt: Date | null;
  /** UC-08 E3's label, used wherever the day is named. Absent is "Day N". */
  label?: string | null;
};

/** The two instants an event has: when it starts and when it ends. */
export type EventDates = {
  startsAt: Date | null;
  endsAt: Date | null;
};

/**
 * "Day 2", or the label the manager gave it (UC-08 E3).
 *
 * A *trimmed* label, so a day labelled with spaces is still called "Day 2"
 * rather than nothing at all — the difference from the `label ?? \`Day N\``
 * copies that used to sit in the components, which only caught `null` and
 * rendered the spaces as a blank.
 *
 * **Every surface that names a day calls this**: the event overview, the
 * schedule, the apply form, a member's own event card, the applicants drawer —
 * and `daySequenceProblem` below, which is what makes a refusal ("Saturday
 * starts before Friday") and the page agree about what a day is called.
 * `src/components/__tests__/day-names.test.ts` renders each of them.
 *
 * **`index` is the day's stored `dayIndex`**, and every screen passes that
 * rather than the day's position in whatever array it happens to hold. The two
 * agree only while the list is whole and in order; pass the position and
 * filtering or reordering the list renames every day on that screen. The one
 * caller that passes a position is `daySequenceProblem` below, which names days
 * in a list that is *about to be saved* — `setEventDays` writes each day's
 * index from its position, so there the position is the `dayIndex` the day is
 * about to have, and there is no stored one to read yet.
 */
export function dayName(day: DayView, index: number): string {
  const label = typeof day.label === "string" ? day.label.trim() : "";
  return label === "" ? `Day ${index + 1}` : label;
}

/**
 * When this event starts and ends: **its first day's start and its last
 * day's** (R-24).
 *
 * There is no `starts_at` column to read any more, for the same reason there is
 * no `applications_open` one: an event's dates are its days', and a copy on the
 * event row is a second answer to one question that goes stale the moment a
 * manager moves a day. Every screen that orders, filters or counts down to an
 * event (R-40, R-41, UC-10 4, UC-11 2) reads this.
 *
 * Two deliberate details:
 *
 *  - **The earliest and latest dated day, not index 0 and index n.** With the
 *    day list validated in order (`daySequenceProblem`) the two are the same
 *    answer, so this costs nothing — but a row written before that rule
 *    existed, or a day whose time is still to be agreed sitting between two
 *    dated ones, must not be able to report an event that ends before it
 *    starts. Undated days are simply not dates yet and are skipped.
 *  - **One dated day means no end.** An event that runs for one evening has
 *    nothing to put after an arrow; "19:00 → 19:00" is not a range, it is the
 *    same instant printed twice. Everything that needs "when was this over"
 *    already reads `endsAt ?? startsAt`, which gives the same answer either
 *    way.
 */
export function eventDates(days: readonly DayView[]): EventDates {
  const dated = days
    .map((day) => day.startsAt)
    .filter((startsAt): startsAt is Date => startsAt !== null)
    .sort((a, b) => a.getTime() - b.getTime());

  if (dated.length === 0) return { startsAt: null, endsAt: null };
  return {
    startsAt: dated[0],
    endsAt: dated.length > 1 ? dated[dated.length - 1] : null,
  };
}

/* ------------------------------------------------------------------ */
/* Setting one up: what a save is refused for (UC-08 10, 10c)         */
/* ------------------------------------------------------------------ */

/**
 * The fewest seats an event may be set up with (R-26, domain-model.md).
 *
 * Two, because one seat is not an event — it is a booking. A manager who wants
 * to run something for one person does not need a seat cap, a waitlist or a
 * promotion rule, and every one of those behaves strangely with a single seat:
 * the first application fills the event and everybody else queues behind a seat
 * that can only free if that one person pulls out.
 *
 * **Uncapped stays legal.** `null` is not "below two" — it is no limit at all,
 * which is a real and supported setup (UC-08 E5 lists "no cap" as advice, not a
 * blocker, and the local fixtures have an uncapped LAN in them). Only a *number*
 * is held to the minimum.
 *
 * ## Why there is no database constraint to match
 *
 * `events_capacity_positive` still reads `capacity is null or capacity > 0`,
 * and tightening it to `>= 2` is a follow-up that needs a look at the live
 * rows first, not a line in this commit:
 *
 *  - Deployed rows may hold `capacity = 1` — legal under the rule this
 *    replaces, so a plain `ALTER TABLE … ADD CONSTRAINT` would **fail the
 *    deploy** and take every later migration with it, exactly the failure
 *    drizzle/0015 and drizzle/0018 exist to avoid.
 *  - Clamping them to 2 is worse than leaving them: it hands a finished event
 *    a seat it never had, and on a published one it reopens applications and
 *    promotes the next person off the waitlist — a notification saying "you're
 *    in" that no manager sent.
 *  - `ADD CONSTRAINT … NOT VALID` skips the existing rows at migration time but
 *    re-checks any row it *updates* afterwards, so a legacy one-seat event
 *    could never be cancelled or completed again.
 *
 * So the rule is enforced here, on the way in, where it can be refused with a
 * sentence instead of a 23514. The follow-up is: read the live rows, decide per
 * row what the right cap is (an owner's decision, not a migration's), then
 * tighten the check.
 */
export const MIN_CAPACITY = 2;

/**
 * Why this seat cap cannot be saved, or null when it can (UC-08 10c).
 *
 * Refused only by callers that are *writing* a capacity — `createEvent`,
 * `updateEvent` when `capacity` is in the patch, and therefore the Basics save
 * only when the manager moved the cap. An event carrying a cap from before this
 * rule is not re-validated by a save that does not touch it, because refusing
 * to cancel a one-seat event from 2024 until somebody edits its cap is the rule
 * getting in the way of the record.
 *
 * The admin checklist calls it too, to *say* the cap is below the minimum
 * without refusing anything (`readiness.ts`). That is the point of there being
 * one function: the sentence the manager reads on the Publish tab and the
 * sentence a save is refused with cannot drift apart.
 */
export function capacityProblem(capacity: number | null): string | null {
  if (capacity === null) return null;
  if (!Number.isInteger(capacity)) {
    return "Capacity has to be a whole number of seats, or empty for unlimited.";
  }
  if (capacity < MIN_CAPACITY) {
    return `An event needs at least ${MIN_CAPACITY} seats. Clear the box for an uncapped event.`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The web address (R-114 / UC-08 E2, E2a)                            */
/* ------------------------------------------------------------------ */

/** What a web address may be made of (UC-08 E2a). */
const WEB_ADDRESS = /^[a-z0-9-]+$/;

/** The longest address the editor's box allows, and the longest stored. */
export const SLUG_MAX = 64;

/** The address a manager typed, as it would be stored. Case only — never repair. */
export function readWebAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Why this web address cannot be used, or null when it can (UC-08 E2a).
 *
 * **Refuses rather than repairs**, which is the whole of E2a: "Address taken or
 * not letters, numbers and hyphens — System rejects with the reason; the old
 * address stays." `updateEvent` used to run the typed address through `slugify`
 * and save whatever came out, so a manager who typed `Summer Cup!` was given
 * `summer-cup` with nothing said — a URL they did not choose, found out about
 * later from a link that worked but was not the one already pasted into
 * Discord. Silently *changing* what somebody typed is worse than refusing it:
 * a refusal they can answer, and a change they cannot see.
 *
 * Case is not content, so {@link readWebAddress} lowercases first and
 * `Summer-Cup` is accepted as `summer-cup`. Everything else is the manager's to
 * fix.
 *
 * Taken-ness is not decided here — that needs the database — only shape. Pure,
 * like every other sentence in this module, so the editor refuses before a
 * round trip and refuses for exactly the reason the save would have.
 */
export function webAddressRefusal(address: string): string | null {
  if (!address) return "Give the event a web address.";
  if (address.length > SLUG_MAX) {
    return `A web address is at most ${SLUG_MAX} characters; that one is ${address.length}.`;
  }
  if (!WEB_ADDRESS.test(address)) {
    return `"${address}" is not a web address — letters, numbers and hyphens only.`;
  }
  if (address.startsWith("-") || address.endsWith("-")) {
    return `"${address}" cannot start or end with a hyphen.`;
  }
  return null;
}

/**
 * Why this day list cannot be saved, or null when it can (R-24, UC-08 4, 10c).
 *
 * Two problems, each with its own sentence, because they are two different
 * mistakes and "check the days" tells a manager nothing:
 *
 *  - **Out of order.** Day 2 starting before Day 1 is almost always two times
 *    typed into the wrong boxes, and silently sorting them would move the
 *    availability answers people have already given against "Day 1".
 *  - **The same instant twice.** Two days of one event cannot run at once;
 *    domain-model.md puts it as "days do not overlap" and "a day's schedule
 *    never moves another day's". With a start time and no length, two days
 *    starting at the same moment is the whole of what overlapping can mean
 *    here — which is why this is the rule rather than a guess at how long a
 *    day lasts. The running order (`format-schedule.ts`) builds each day's
 *    blocks forward from its own start, so two days sharing a start produce
 *    two schedules on top of each other.
 *
 * Undated days are skipped rather than refused: "Fri / Sat / Sun before the
 * times are agreed" is how this gets filled in (see `event_days.starts_at`),
 * and the comparison is only ever between two days that *have* times.
 */
export function daySequenceProblem(days: readonly DayView[]): string | null {
  const dated = days.flatMap((day, index) =>
    day.startsAt ? [{ name: dayName(day, index), at: day.startsAt.getTime() }] : []
  );

  for (let index = 1; index < dated.length; index += 1) {
    const previous = dated[index - 1];
    const current = dated[index];
    if (current.at === previous.at) {
      return `${current.name} starts at the same time as ${previous.name}. Two days of one event cannot run at once.`;
    }
    if (current.at < previous.at) {
      return `${current.name} starts before ${previous.name}. Put the days in the order they run.`;
    }
  }

  return null;
}

/**
 * Why this sign-up window cannot be saved, or null when it can (R-25,
 * UC-08 5, 10c).
 *
 * `startsAt` is the event's own start — the first day's (`eventDates`) — so
 * this is one rule checked from both directions: a window moved past the first
 * day is refused when the window is saved, and a first day pulled back before
 * the closing time is refused when the days are saved. Either way the pair is
 * the thing that has to make sense, and whichever save made it stop making
 * sense is the one that is told.
 *
 * Why sign-ups may not close *after* the start: `applicationsOpen` already
 * refuses an application to an event that has begun, so a closing time past
 * the start is a promise the event page makes ("applications close in 2 days")
 * and the apply action breaks. Closing exactly *at* the start is allowed —
 * both deadlines are inclusive, and "sign up right up to the minute it
 * starts" is a real intention.
 */
export function signupWindowProblem(
  window: { signupOpensAt: Date | null; signupClosesAt: Date | null },
  startsAt: Date | null
): string | null {
  const { signupOpensAt: opens, signupClosesAt: closes } = window;

  if (opens && closes && closes.getTime() < opens.getTime()) {
    return "Signups cannot close before they open.";
  }
  if (opens && startsAt && startsAt.getTime() < opens.getTime()) {
    return "Signups open after the event starts, so nobody could ever apply.";
  }
  if (closes && startsAt && closes.getTime() > startsAt.getTime()) {
    return "Signups close after the first day starts, so somebody could apply to an event already under way. Close them no later than the start.";
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Is this save worth telling anybody about? (R-98, UC-08 10b)        */
/* ------------------------------------------------------------------ */

/** The parts of a setup an applicant's plans depend on. */
const TOLD_ABOUT = [
  "title",
  "type",
  "description",
  "slug",
  "gameId",
  "capacity",
  "signupOpensAt",
  "signupClosesAt",
  "minRankToEnter",
  "minRankToCaptain",
] as const;

export type SetupField = (typeof TOLD_ABOUT)[number];

/** Enough of an event row to compare two saves of it. */
export type SetupView = Readonly<Record<SetupField, unknown>>;

/**
 * Which of the things an applicant cares about this save actually changed
 * (R-98, UC-08 10b).
 *
 * The audience for "this event has changed" is people who already applied, and
 * what they are owed is news. A manager who opens Basics, types nothing and
 * presses Save has produced none: the row is identical, and a notification
 * saying otherwise is the one that teaches somebody to switch the kind off
 * (R-104's switch is the escape hatch, not the plan). So the message is sent
 * off the *difference between two rows*, not off the fact that a write
 * happened.
 *
 * Dates are compared by instant, not by identity — two `Date` objects for the
 * same moment are the same answer, and `!==` on them is always true.
 *
 * `config` is deliberately not in the list. The entry mode and the waitlist
 * switch change what happens to a *future* application, not the plans of
 * somebody who already holds a seat, and UC-08 6/6a does not ask for them to
 * be announced. The audit line records them either way, which is where a
 * question about who changed the entry mode gets answered.
 */
export function changedSetupFields(before: SetupView, after: SetupView): SetupField[] {
  return TOLD_ABOUT.filter((field) => {
    const left = before[field];
    const right = after[field];
    if (left instanceof Date || right instanceof Date) {
      const leftTime = left instanceof Date ? left.getTime() : null;
      const rightTime = right instanceof Date ? right.getTime() : null;
      return leftTime !== rightTime;
    }
    return left !== right;
  });
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

/**
 * How this event's applications land (R-27). Anything but an explicit
 * `approval` is first come, so every event written before approval existed —
 * and a template carrying a value nobody recognises — behaves exactly as it did.
 */
export function entryMode(config: EventConfig | null | undefined): EntryMode {
  return config?.entryMode === "approval" ? "approval" : "first_come";
}

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
 * An approval event is open whatever its seat count; see `entryMode`.
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

  // An approval event never closes on seats: the application waits for a
  // manager, who can still accept past the cap or put it in the queue. The
  // waitlist switch is a first-come setting and means nothing here.
  if (entryMode(event.config) === "approval") {
    return {
      open: true,
      willWaitlist: false,
      seatsLeft,
      closesAt,
      message: "Applications are open — each one is reviewed by the organisers.",
    };
  }

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
/* When the "still coming?" answer closes                             */
/* ------------------------------------------------------------------ */

/**
 * How long before the start the "still coming?" answer closes — two days
 * (R-200, UC-13 7).
 *
 * Two days is the point at which the running order stops being a draft: the
 * blocks, the teams and who is on which are built from who said they were
 * coming, and an answer that can still move the night before is an answer none
 * of that can be built on.
 */
export const CONFIRMATION_LEAD_MS = 48 * 60 * 60 * 1000;

/**
 * The instant the answer closes, or null for an event with no start date.
 *
 * **Derived, every read.** There is no `confirmations_close_at` column and
 * there must never be one, for exactly the reason there is no
 * `applications_open` column above: a manager who moves the event two days
 * later has moved the deadline, and a stored copy would still be describing
 * the old date while the screen, the reminder and the write check disagreed
 * about which one was true.
 *
 * Null is not "closed" and not "open" — it is *no deadline at all*. An event
 * nobody has scheduled cannot have a cut-off two days before a start it does
 * not have, and the alternative (treating null as closed) locks members out of
 * an event that has not been arranged yet.
 */
export function confirmationDeadline(startsAt: Date | null | undefined): Date | null {
  if (!startsAt) return null;
  return new Date(startsAt.getTime() - CONFIRMATION_LEAD_MS);
}

/**
 * Can the member still answer "still coming?" at `now` (R-200, UC-13 5, 7)?
 *
 * Inclusive at the deadline, the same way `applicationsOpen` is inclusive at
 * `signupClosesAt`: an answer timestamped exactly on the deadline is in time,
 * and the millisecond after it is not. One rule for every deadline on the site
 * is worth more than a tie-break argument about this one.
 *
 * An undated event is always answerable (`confirmationDeadline` null) —
 * UC-13 7a.
 *
 * This decides only the *answer*. Withdrawing is not an answer and is not
 * governed by it (R-54, UC-13 extensions E3): somebody taken ill the day
 * before still gives their seat up, and the only reason closing the answer is
 * acceptable at all is that the way out stays open.
 */
export function confirmationsOpen(startsAt: Date | null | undefined, now: Date): boolean {
  const deadline = confirmationDeadline(startsAt);
  return deadline === null || now.getTime() <= deadline.getTime();
}

/* ------------------------------------------------------------------ */
/* Decisions                                                          */
/* ------------------------------------------------------------------ */

/**
 * Where a manager may send an application — the three states a decision can
 * land in, written out rather than subtracted from `ApplicationStatus`.
 *
 * Two states are missing, and for two different reasons.
 *
 * `pending` is where an approval event's application *arrives* (R-27, UC-12
 * 7b); the state diagram (docs/diagrams/application-state.md) has no edge back
 * into it. So a pending application is not a decision: it is not announced, it
 * is not notified, and nothing carrying this type can name it.
 *
 * `withdrawn` is **the applicant's**. Every edge into it on the diagram reads
 * "applicant withdraws", and the Applicants tab offers the status as a filter
 * and never as a button, so no screen has ever needed it. Leaving it in this
 * type was not cosmetic: `applyToEvent` refuses a *declined* member and lets a
 * *withdrawn* one back in (R-122 "Beats R-121" / UC-12 E1, E2), so a manager
 * decision naming `withdrawn` over a declined row turned the decline off — the
 * same hole `withdrawApplication` was closed against, one door along. Listing
 * the three states is what stops `Exclude` quietly re-opening it the next time
 * a status is added.
 *
 * The type is the outer door; `setApplicationStatus` refuses both states again
 * in the write, because an action is a public POST and a type is not a guard.
 */
export type ApplicationDecision = Extract<
  ApplicationStatus,
  "accepted" | "waitlisted" | "declined"
>;

/* ------------------------------------------------------------------ */
/* Rank thresholds (§8.3)                                             */
/* ------------------------------------------------------------------ */

/**
 * Why these two rank thresholds cannot be saved against this game, or null when
 * they can (UC-08 7, 10d / §8.3).
 *
 * A threshold is stored as a ladder *entry name*, so it is only meaningful
 * beside the game whose ladder it names — which makes three things refusable: a
 * threshold with no game at all, a threshold on a game that has no ladder, and
 * a threshold naming a rank the ladder does not have.
 *
 * One function rather than a copy per caller, and that is the whole reason it
 * is here rather than inline in `createEvent`. Two places write a threshold
 * now: `validateFields` when an event is created or edited, and
 * `createTemplate`/`updateTemplate` since drizzle/0027 gave a template columns
 * to hold one. A template allowed to store "Diamond" against a game whose
 * ladder stops at Gold would be a template that every `createEvent` from it
 * refused — the refusal arriving at the wrong end, against the wrong person, on
 * a setup they did not just type. Same check, same sentence, both ends.
 *
 * `ladderIndex`'s tolerance is deliberately *not* used here: this is the write
 * path, where "Diamond " and "diamond" should be accepted and stored as the
 * admin's string, but a rank that is simply not on the ladder must be refused.
 * So the comparison folds case and trims, exactly as `ladderIndex` does, rather
 * than as `=` would.
 */
export function rankGateProblem(
  gates: ReadonlyArray<[rank: string | null, label: string]>,
  game: { name: string; rankLadder: readonly string[] } | null
): string | null {
  for (const [rank, label] of gates) {
    if (!rank) continue;
    if (!game) return `Pick the game before setting a ${label}.`;
    if (game.rankLadder.length === 0) {
      return `${game.name} has no rank ladder to compare against.`;
    }
    if (ladderIndex(rank, game.rankLadder) === -1) {
      return `"${rank}" is not one of ${game.name}'s ranks.`;
    }
  }
  return null;
}

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

/* ------------------------------------------------------------------ */
/* Waivers (R-59 / UC-14 3b)                                          */
/* ------------------------------------------------------------------ */

/**
 * Which of the two rules a manager has waived for one member on one event.
 *
 * A pair of booleans rather than the rows themselves: by the time a gate is
 * being evaluated the only question left is "was this rule waived", and who
 * granted it and when belong to the screens that *report* a waiver and to the
 * audit log, not to the comparison. `entry_waivers` is unique on
 * (event, member, rule), so there is never more than one row to fold in.
 */
export type WaivedRules = {
  readonly enter: boolean;
  readonly captain: boolean;
};

/**
 * Nobody has waived anything — the ordinary case, and the default.
 *
 * Frozen, and the fields above are `readonly`, because this one object is the
 * default argument of {@link eligibility} and is therefore *shared by every
 * caller that passes nothing*. A single `waived.enter = true` anywhere would
 * not be a local mistake; it would hand every unwaived member on the site a
 * waiver for the life of the process.
 */
export const NO_WAIVERS: WaivedRules = Object.freeze({ enter: false, captain: false });

/** Fold a member's `entry_waivers` rows into the pair the gate reads. */
export function waivedRulesFrom(rows: readonly { rule: EntryRule }[]): WaivedRules {
  return {
    enter: rows.some((row) => row.rule === "enter"),
    captain: rows.some((row) => row.rule === "captain"),
  };
}

export type Eligibility = {
  canEnter: boolean;
  /** One sentence, for the member. */
  enterReason: string;
  canCaptain: boolean;
  captainReason: string;
  /** The underlying comparisons, for a UI that wants to be more specific. */
  enterCheck: RankCheck;
  captainCheck: RankCheck;
  /**
   * True when a manager's waiver is the *only* reason they are eligible — the
   * rank comparison itself failed (UC-12 2a's "and no manager has waived it
   * for them on this event").
   *
   * Separate from `canEnter` / `canCaptain` because a screen has to be able to
   * say *why* somebody is in: "you clear it" and "a manager let you past it"
   * are different sentences, and a waiver rendered as though the member met the
   * bar hides the one fact a manager may later want to revisit.
   */
  enterWaived: boolean;
  captainWaived: boolean;
  /**
   * The captain rule on its own, waiver included — **what `setCaptains`
   * enforces** (R-59 / UC-15 3a).
   *
   * `canCaptain` folds in the entry rule, because nobody who cannot get into an
   * event can lead a team in it, and that is the right answer for a member
   * reading a public page. It is the wrong one for the captain picker: its
   * candidates are *accepted applicants*, so entry has already been decided by
   * a manager (`setApplicationStatus` accepts anybody), and refusing a captain
   * over an entry bar that acceptance already settled would make the server
   * refuse — and the override dialog fire — for a rule nobody is enforcing.
   */
  meetsCaptainRule: boolean;
};

/**
 * Can this member enter, and can they captain — with a sentence for each.
 *
 * Captaincy implies entry: somebody who cannot get into the event cannot lead a
 * team in it, so a failed entry check is reported as the captain reason too
 * rather than showing two contradictory messages.
 *
 * ## Where the override lives
 *
 * This used to end with a note that neither answer is a wall, because §8.3
 * requires an override and `setApplicationStatus` provides one by letting an
 * admin accept anybody. That is still true of *acceptance*, and it was never
 * the whole of R-59: the override for the rank rules themselves is the `waived`
 * argument — a recorded decision read from `entry_waivers` — and it is what
 * lets a below-rank member apply at all (UC-12 2a) and a below-bar captain be
 * saved (UC-15 3a). A caller that passes nothing gets the unwaived answer,
 * which is the right default for every pure-rules caller with no database to
 * read waivers from.
 */
export function eligibility(
  event: EventGateView,
  member: MemberRankView,
  ladder: readonly string[],
  waived: WaivedRules = NO_WAIVERS
): Eligibility {
  const enterCheck = rankMeetsMinimum(member.rank, event.minRankToEnter, ladder);
  const captainCheck = rankMeetsMinimum(member.rank, event.minRankToCaptain, ladder);

  // A waiver on a rule the member already clears is not "waived": it changes
  // no answer, and reporting it would tell a manager a gate was overridden
  // when nobody was ever stopped by it.
  const enterWaived = !enterCheck.ok && waived.enter;
  const captainWaived = !captainCheck.ok && waived.captain;

  const canEnter = enterCheck.ok || enterWaived;
  const meetsCaptainRule = captainCheck.ok || captainWaived;
  const canCaptain = canEnter && meetsCaptainRule;

  return {
    canEnter,
    enterReason: enterWaived
      ? "A manager has waived this event's entry requirement for you, so you can apply."
      : enterCheck.ok
        ? "You can apply to this event."
        : enterCheck.message,
    canCaptain,
    captainReason: !canEnter
      ? enterCheck.message
      : captainWaived
        ? "A manager has waived this event's captain requirement for you."
        : captainCheck.ok
          ? "You can captain a team in this event."
          : captainCheck.message,
    enterCheck,
    captainCheck,
    enterWaived,
    captainWaived,
    meetsCaptainRule,
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
