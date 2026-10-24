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
  SettingValue,
} from "@/db/schema";
import { MAX_TEAMS, MIN_TEAMS } from "@/lib/draft-policy";
import { type TeamPlanResult, planTeams } from "@/lib/random-teams";
import { MAX_ROUNDS, type RoundSetup } from "@/lib/round-scoring";

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
  return dayLabel(day) ?? `Day ${index + 1}`;
}

/**
 * The name the manager gave this day, or `null` when they did not.
 *
 * Split out of `dayName` because two screens need the *question* rather than
 * the answer: the schedule tab's start-time fields are labelled by position
 * ("Day 2 start") and show the manager's name as a hint beside them, so a day
 * with no name of its own must show no hint rather than the words "Day 2"
 * twice. Written with `??` that reads as a blank — the original defect, one
 * surface further on.
 *
 * One trim, in one place, so "is there a name?" and "what is this day called?"
 * cannot disagree about a label of spaces.
 */
export function dayLabel(day: DayView | undefined): string | null {
  const label = typeof day?.label === "string" ? day.label.trim() : "";
  return label === "" ? null : label;
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
  /** Still a draft, so it is not public — only its managers reach it at all. */
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

/* ------------------------------------------------------------------ */
/* The night's format (R-215 / UC-41 1, 2)                            */
/* ------------------------------------------------------------------ */

/** The two sizes a night runs at (R-215). */
export const NIGHT_FORMATS = ["6v6", "3v3"] as const;

export type NightFormat = (typeof NIGHT_FORMATS)[number];

export type TeamFormat = {
  format: NightFormat;
  /** How many players a team holds — and so the size the random shuffle makes. */
  teamSize: number;
  /**
   * The composition this format implies. **Stated, never enforced** (R-215 /
   * UC-41 2): the site prints it and nothing anywhere reads it back to refuse
   * a team. See the type's docblock below for why that is a decision.
   */
  comp: string;
};

/**
 * The format, resolved — and the reason it is a *stored admin choice* rather
 * than arithmetic over the head count.
 *
 * An earlier draft of the plan had the site compute 6v6 from 11-12 accepted
 * players and 3v3 from fewer, and the user corrected it: "11 players means
 * 6v6" is how *they* decide which night to run, not a rule the site should
 * reverse-engineer from a number that is still moving while people apply. A
 * guess would also be wrong in the one case that matters — 12 people who came
 * to play 3v3 — and wrong in a way nobody could override.
 *
 * ## Why `events.config`, and why this needed no migration
 *
 * The schedule settings already live there (`scheduleSettingsFrom` in
 * `src/lib/format.ts` is the worked example, and its docblock gives the
 * argument: a value read once per screen and saved with its neighbours is not
 * worth a table). `events.config` is a `json<EventConfig>` column whose type
 * ends in `& { [key: string]: SettingValue | undefined }`, so a new key needs
 * no column, no enum and no migration — which is the whole point of putting it
 * here.
 *
 * ## A *top-level* key, deliberately not inside `config.format`
 *
 * `updateEvent` merges a config patch **one level deep**:
 * `{ ...current.config, ...patch.config }`. So `config.format` is replaced
 * wholesale by any save that writes it, and `saveScheduleSettingsAction`
 * writes all four of its fields together every time. A `teamFormat` nested in
 * there would be silently erased the next time anybody touched the Schedule
 * tab. As a sibling of `format` it survives, and the schedule survives this.
 *
 * Unrecognised or absent falls back to 6v6 — the common night — the same way
 * `entryMode` reads anything but an explicit `approval` as first come, so an
 * event stored before this existed behaves as one rather than as nothing.
 */
export function teamFormatFrom(config: EventConfig | null | undefined): TeamFormat {
  const stored = config?.teamFormat;
  return stored === "3v3"
    ? { format: "3v3", teamSize: 3, comp: "1-1-1" }
    : { format: "6v6", teamSize: 6, comp: "2-2-2" };
}

/** Whether a string off the wire is a format at all — the action's guard. */
export function isNightFormat(raw: unknown): raw is NightFormat {
  return raw === "6v6" || raw === "3v3";
}

/* ------------------------------------------------------------------ */
/* What kind of event this is (R-217, R-218 / UC-42 1-4)              */
/* ------------------------------------------------------------------ */

/**
 * Which of the two figures the admin settled (R-218).
 *
 * `teams` is a count of sides; `perTeam` is how many play on one. **One mode at
 * a time**, because the two are the same decision read from opposite ends and
 * storing both is storing a disagreement waiting to happen: an admin who sets
 * 3 teams, accepts six more players and comes back to find "6 per team" still
 * sitting beside it has been told something that is no longer true. The other
 * figure is {@link sizingConsequence}'s, computed on every read and never
 * written down.
 */
export const SIZING_MODES = ["teams", "perTeam"] as const;

export type SizingMode = (typeof SIZING_MODES)[number];

/** The one figure, and which figure it is. */
export type TeamSizing = {
  mode: SizingMode;
  /** A count of sides under `teams`; players on one side under `perTeam`. */
  value: number;
};

/**
 * The three decisions the Format panel holds — R-217 and R-218, per event.
 *
 * Per event and not a flag on the game, which is R-217's own note: a Fall Guys
 * night is solo one week and teams the next, and a game that decided it for
 * every event would make the second of those impossible to set up.
 *
 * `draft` is kept even while `teamEvent` is false rather than being folded into
 * it. A solo event shows no Draft tab whatever `draft` says — that is
 * `tabHiddenBecause`'s rule, one place — and keeping the admin's answer means
 * turning teams back on restores the event they were describing instead of
 * silently clearing the draft they had already asked for.
 */
export type EventShape = {
  teamEvent: boolean;
  draft: boolean;
  sizing: TeamSizing;
};

/**
 * The largest side this will store, and it is a typo guard rather than a rule
 * about sport.
 *
 * The biggest format the site has a name for is 6v6 ({@link NIGHT_FORMATS}),
 * and `MAX_TEAMS` caps the other mode at eight — so an unbounded `perTeam`
 * would be the one box on the panel where `66` typed for `6` is stored and
 * then quietly derives one team from eighteen accepted players. Thirty-two is
 * past anything this site runs and short of any plausible slip.
 */
export const MAX_PER_TEAM = 32;

/** An object off the stored config, or an empty one — never an array. */
function record(value: SettingValue | undefined): Record<string, SettingValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, SettingValue>)
    : {};
}

/**
 * The shape, resolved — and **why it is one top-level `events.config` key**.
 *
 * ## No migration, for `teamFormat`'s reason
 *
 * `events.config` is a `json<EventConfig>` column whose type ends in
 * `& { [key: string]: SettingValue | undefined }`, so a new key needs no
 * column, no enum and no migration. `teamFormatFrom` above is the worked
 * example and `drizzle/` is untouched by this.
 *
 * ## And a *top-level* key, deliberately not inside `config.format`
 *
 * This is the correction Task 78's `Left over` note paid for, and it applies
 * here unchanged. `updateEvent` merges a config patch **one level deep**
 * (`{ ...current.config, ...patch.config }`), and `saveScheduleSettingsAction`
 * rewrites the whole `config.format` object on every save — so anything nested
 * inside it is erased the first time somebody opens the Schedule tab.
 * `scheduleSettingsFrom`'s *placement* is therefore the one thing not to copy;
 * `teamFormat`'s is. `config.eventShape` is a sibling of `config.format`, and
 * the only writer of it is `saveEventShapeAction`, which writes the whole
 * object every time — so the one-level merge replaces it wholesale and there is
 * no half-written shape to read.
 *
 * ## Absent reads as the event that exists today
 *
 * `teamEvent` and `draft` default to **true**, the way `waitlistEnabled` reads
 * an absent switch as on: every event stored before this panel existed showed
 * all nine tabs, and a default of false would take four of them away from every
 * event on the site at once. Nothing is migrated because nothing needs to be.
 *
 * The sizing default is the night's own format — 6v6 means six to a side, 3v3
 * three — rather than a number invented here, so the panel opens agreeing with
 * what Task 78 already stored instead of contradicting it.
 */
export function eventShapeFrom(config: EventConfig | null | undefined): EventShape {
  const shape = record(config?.eventShape);
  const sizing = record(shape.sizing);

  const mode: SizingMode = sizing.mode === "teams" ? "teams" : "perTeam";
  const stored = sizing.value;
  const value =
    typeof stored === "number" && Number.isInteger(stored) && stored > 0
      ? stored
      : mode === "teams"
        ? MIN_TEAMS
        : teamFormatFrom(config).teamSize;

  return {
    teamEvent: shape.teamEvent !== false,
    draft: shape.draft !== false,
    sizing: { mode, value },
  };
}

/** Whether a string off the wire names a sizing mode — the action's guard. */
export function isSizingMode(raw: unknown): raw is SizingMode {
  return raw === "teams" || raw === "perTeam";
}

/**
 * Why this shape cannot be saved, or null when it can.
 *
 * Pure and shared, like every other refusal in this module, so the sentence the
 * panel shows before a round trip is the sentence the save would have been
 * refused with. A solo event is not sized at all, so nothing about the figure
 * is held against it — an admin who turns teams off should not be stopped by a
 * number that no longer describes anything.
 */
export function shapeProblem(shape: EventShape): string | null {
  if (!shape.teamEvent) return null;

  const { mode, value } = shape.sizing;
  if (!Number.isInteger(value)) {
    return mode === "teams"
      ? "How many teams has to be a whole number."
      : "How many players a team holds has to be a whole number.";
  }
  if (mode === "teams") {
    if (value < MIN_TEAMS || value > MAX_TEAMS) {
      return `An event has between ${MIN_TEAMS} and ${MAX_TEAMS} teams.`;
    }
    return null;
  }
  if (value < 1 || value > MAX_PER_TEAM) {
    return `A team holds between 1 and ${MAX_PER_TEAM} players.`;
  }
  return null;
}

/**
 * `people` dealt into `teams` sides, **the remainder one per team**
 * (UC-42 4b) — eighteen into four is 5, 5, 4, 4 and never 6, 4, 4, 4.
 *
 * The same deal `planTeams` makes in `src/lib/random-teams.ts`, read from the
 * other end: that one is given a side size and works out how many sides, this
 * one is given the number of sides. They have to agree, so
 * `shape-sizing.test.ts` holds them against each other over every legal count
 * rather than trusting that two readings of one sentence stay the same.
 */
export function dealSizes(people: number, teams: number): number[] {
  if (!Number.isInteger(teams) || teams < 1) return [];
  const base = Math.floor(Math.max(0, people) / teams);
  const spare = Math.max(0, people) % teams;
  return Array.from({ length: teams }, (_, index) => (index < spare ? base + 1 : base));
}

/**
 * The figure that follows from the one the admin set — **derived on every
 * read, never stored** (R-218 / UC-42 4).
 *
 * This is the whole of why the two figures cannot drift: there is no second
 * value to go stale. Accept three more players and the sentence changes with
 * no save, because the sentence is arithmetic over the accepted count rather
 * than something written down beside it.
 *
 * `assumed` is UC-42 4a. With nobody accepted yet there is no count to divide,
 * and printing "0 teams" or a confident 3 from an assumption would both be
 * saying something untrue — so the panel says what it is assuming instead.
 */
export type SizingConsequence = {
  /** The figure the admin set, in words: "6 per team". */
  stated: string;
  /** What follows from it, in words — or the assumption (UC-42 4a). */
  consequence: string;
  /** How many sides, once the accepted count settles it. */
  teams: number | null;
  /** Each side's size, biggest first. Empty while it cannot be worked out. */
  sizes: number[];
  /** 1-based positions short of a full side (UC-42 4b). */
  short: number[];
  /** True when the consequence is an assumption rather than a count. */
  assumed: boolean;
  /** Why nothing can be derived — too few accepted, too many sides. */
  problem: string | null;
};

export function sizingConsequence(
  sizing: TeamSizing,
  accepted: number,
  planner: (people: number, teamSize: number) => TeamPlanResult = planTeams
): SizingConsequence {
  const people = Number.isInteger(accepted) && accepted > 0 ? accepted : 0;
  const from = `from the ${people} accepted`;

  if (sizing.mode === "perTeam") {
    const stated = `${sizing.value} per team`;
    if (people === 0) {
      return {
        stated,
        consequence: `one team per ${sizing.value} accepted, once anybody is`,
        teams: null,
        sizes: [],
        short: [],
        assumed: true,
        problem: null,
      };
    }
    // Task 78's own planner, not a second copy of it: the number this panel
    // prints is the number the random shuffle would make.
    const plan = planner(people, sizing.value);
    if (!plan.ok) {
      return {
        stated,
        consequence: plan.error,
        teams: null,
        sizes: [],
        short: [],
        assumed: false,
        problem: plan.error,
      };
    }
    return {
      stated,
      consequence: `${plan.plan.teams} ${plan.plan.teams === 1 ? "team" : "teams"} ${from}`,
      teams: plan.plan.teams,
      sizes: plan.plan.sizes,
      short: plan.plan.short,
      assumed: false,
      problem: null,
    };
  }

  const stated = `${sizing.value} ${sizing.value === 1 ? "team" : "teams"}`;
  if (people === 0) {
    return {
      stated,
      consequence: `the accepted players split ${sizing.value} ways, once anybody is`,
      teams: sizing.value,
      sizes: [],
      short: [],
      assumed: true,
      problem: null,
    };
  }

  const sizes = dealSizes(people, sizing.value);
  const biggest = sizes[0] ?? 0;
  const even = sizes.every((size) => size === biggest);
  return {
    stated,
    consequence: even
      ? `${biggest} per team ${from}`
      : `${sizes.join(", ")} ${from} — the remainder one per team`,
    teams: sizing.value,
    sizes,
    // Short against the biggest side, because in this mode the side size is
    // the derived figure: there is no stored target to be short of.
    short: sizes.flatMap((size, index) => (size < biggest ? [index + 1] : [])),
    assumed: false,
    problem: null,
  };
}

/**
 * UC-42 2a — turning teams off on an event that already has them.
 *
 * Refused until the admin says to discard them, and the sentence names how
 * many go, because the teams are the only record of who was on whose side and
 * a switch that quietly took them would be the destructive act this site does
 * not do.
 */
export function teamsInTheWayRefusal(count: number): string {
  const one = count === 1;
  return `This event already has ${count} ${one ? "team" : "teams"}. Turning teams off discards ${one ? "it" : "them"}, and the ${one ? "roster" : "rosters"} with ${one ? "it" : "them"} — confirm below and ${one ? "it goes" : "they go"}.`;
}

/**
 * UC-42 3a — turning the draft off once lots have been awarded.
 *
 * Refused outright, with no confirmation offered: the awarded lots are where
 * the teams' rosters and the prices on them came from, so a draft switched off
 * underneath them leaves a roster nothing explains. Voiding the lots is the
 * deliberate act that makes this possible, and it has its own screen.
 *
 * Worded so it shares no sentence with `removeTeamsIn`'s "Void those lots
 * first." — Task 78's `Left over` note records a `toContain` assertion that
 * stayed green because a *different* refusal carried the same phrase.
 */
export const DRAFT_AWARDED_REFUSAL =
  "Lots have already been awarded in this event's draft, and the teams' rosters came from them. Void the awards on the Draft tab before turning the draft off.";

/* ------------------------------------------------------------------ */
/* The sides the Format panel implies (R-220 / UC-42 6)               */
/* ------------------------------------------------------------------ */

/**
 * The plan a random fill writes, from whichever figure the panel holds — the
 * one place both readings of {@link TeamSizing} become a `TeamPlan`.
 *
 * **Players per team is Task 78's `planTeams`, called and not copied**: the
 * remainder rounds *up* into one more side, short, rather than being dropped,
 * and the refusals are its refusals (UC-41 4b, 4c). **A count of teams** deals
 * the accepted players into exactly that many sides with {@link dealSizes} —
 * the remainder one per side, as UC-42 4b says — and refuses fewer people than
 * sides, naming both numbers, because a side with nobody on it is not a side.
 *
 * This is what `assignRandomTeams` plans with and what the Teams tab prints
 * before asking, so the two cannot disagree about how many teams a shuffle
 * makes. `sizingConsequence` above prints the Format panel's own sentence from
 * the same arithmetic; `teams-three-ways.test.ts` holds the two against each
 * other over every legal count.
 */
export function planSides(sizing: TeamSizing, people: number): TeamPlanResult {
  if (sizing.mode === "perTeam") return planTeams(people, sizing.value);

  const sides = sizing.value;
  const count = Number.isInteger(people) && people > 0 ? people : 0;
  if (count < sides) {
    return {
      ok: false,
      error: `Only ${count} ${count === 1 ? "player is" : "players are"} accepted, and ${sides} teams need at least one player each. Accept more on the Applicants tab, or lower the team count in Setup → Format.`,
    };
  }

  const sizes = dealSizes(count, sides);
  const biggest = sizes[0] ?? 0;
  return {
    ok: true,
    plan: {
      teams: sides,
      sizes,
      short: sizes.flatMap((size, index) => (size < biggest ? [index + 1] : [])),
    },
  };
}

/**
 * How many teams the Format panel says this event has — or `null` when it
 * cannot say yet.
 *
 * This is the figure "the team count follows" (Task 81), and the two modes
 * answer it differently on purpose. **A count of teams is the admin's own
 * number** and stands whoever is accepted — three teams with nobody accepted
 * is still three teams. **Players per team** yields a count only once the
 * accepted players make two or more sides; it is `planTeams`'s count, so a
 * fractional team rounds **up** into a short side rather than being dropped
 * (UC-41 4a). With nobody accepted, too few, or exactly one team's worth,
 * there is no count — UC-42 4a's "an assumption rather than a number" — and
 * the caller treats the count as free.
 *
 * A solo event has no count at all. That is deliberately not a refusal here:
 * a hidden Teams tab is not a forbidden one (UC-42 5b), and `setTeamCount`
 * stays callable on a solo event exactly as `event-shape.test.ts` proves.
 */
export function teamCountFrom(shape: EventShape, accepted: number): number | null {
  if (!shape.teamEvent) return null;
  if (shape.sizing.mode === "teams") return shape.sizing.value;
  const plan = planTeams(accepted, shape.sizing.value);
  return plan.ok ? plan.plan.teams : null;
}

/**
 * Why a team count that disagrees with the Format panel is refused — the
 * sentence `setTeamCount` answers with and the Teams tab shows beside the
 * control, so the admin reads the same words before and after the round trip.
 *
 * Both halves name where to settle it: the count is the panel's decision, and
 * the Teams tab is where it is carried out, not where it is argued.
 */
export function countFollowsFormatRefusal(
  shape: EventShape,
  accepted: number,
  expected: number,
  asked: number
): string {
  if (shape.sizing.mode === "teams") {
    return `Setup → Format says this event has ${expected} teams, so it cannot be set to ${asked} here. Change it there, or make it ${expected}.`;
  }
  return `Setup → Format sizes the teams at ${shape.sizing.value} a side, which makes ${expected} teams from the ${accepted} accepted — so it cannot be set to ${asked} here. Change the sizing there, or make it ${expected}.`;
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

/* ------------------------------------------------------------------ */
/* How a solo night is scored (R-225, R-226, R-229 / UC-44)           */
/* ------------------------------------------------------------------ */

/** A round as the naming rule needs it: what it is called, if anything. */
export type RoundView = {
  /** The name the manager gave it. Absent is "Round N" (R-225). */
  name?: string | null;
};

/**
 * The Scoring panel's whole answer — UC-44 2, 3 and 4 — and the one shape the
 * stored key, the panel, the action and the ranking all agree on.
 *
 * **Extends `RoundSetup` rather than restating its two fields**, so a stored
 * setup is `rankRounds`'s input with no mapping step: there is one vocabulary
 * for "which way does this night score" and "what is a bonus worth", and it is
 * `src/lib/round-scoring.ts`'s. What this adds is what the ranking does not
 * care about — how many rounds there are and what each is called.
 *
 * The count is `rounds.length`, not a second field beside the list, because
 * two fields for one fact are a disagreement waiting to happen.
 *
 * A bonus's `key` is its **name**. UC-44 4b says a bonus is picked out on the
 * scoring screen by its name, and the awards on a score row are keyed by the
 * same string — so renaming a bonus is deleting the old one, and
 * {@link roundScoringLosses} says so rather than letting the awards go quiet.
 */
export type RoundScoring = RoundSetup & {
  /** `name` is `null` rather than absent, so the stored object is a `SettingValue`. */
  rounds: readonly { name: string | null }[];
};

/**
 * Where the panel starts on a night nobody has set up: one round, highest
 * score wins, no bonuses. The smallest legal setup, and nothing it says is a
 * guess about the game — the manager changes every part of it on the panel.
 */
export const DEFAULT_ROUND_SCORING: RoundScoring = Object.freeze({
  rounds: Object.freeze([{ name: null }]),
  lowWins: false,
  bonuses: Object.freeze([]),
});

/**
 * The name the manager gave this round, or `null` when they did not — `dayLabel`'s
 * question, asked of a round.
 *
 * One trim, in one place, so "is there a name?" and "what is this round called?"
 * cannot disagree about a name of spaces. The panel labels each name box by
 * position ("Round 3"), so it needs this rather than {@link roundName}: a round
 * with no name of its own must show no hint rather than "Round 3" twice.
 */
export function givenRoundName(round: RoundView | undefined): string | null {
  const name = typeof round?.name === "string" ? round.name.trim() : "";
  return name === "" ? null : name;
}

/**
 * "Round 2", or the name the manager gave it (R-225) — `dayName`'s rule.
 *
 * `index` is the round's **position in the list**, 0-based like `dayName`'s, so
 * `rounds.map(roundName)` works; an `event_round_scores.roundIndex` is 1-based
 * and a caller holding one passes `roundIndex - 1`.
 */
export function roundName(round: RoundView | undefined, index: number): string {
  return givenRoundName(round) ?? `Round ${index + 1}`;
}

/**
 * The scoring setup, resolved — or **`null` for an event that is not scored in
 * rounds**, which is every event that has never saved the Scoring panel.
 *
 * ## Absent reads as the event that exists today
 *
 * The opposite default from `eventShapeFrom`, for exactly its reason: absent
 * must read as the event that already exists, and today no event on the site is
 * scored in rounds. A default of "scored" would make every solo event claim a
 * scoring system it has never had — a Results tab asking for rounds nobody
 * played, and a championship reading places off an empty table (R-236).
 *
 * ## One top-level key, for Task 78's reason
 *
 * `config.roundScoring` is a sibling of `config.format`, never inside it.
 * `updateEvent` merges a config patch one level deep and
 * `saveScheduleSettingsAction` rewrites the whole of `config.format`, so a
 * setup nested there would be erased the next time anybody opened the Schedule
 * tab. The only writer is `saveRoundScoring`, which writes the whole object, so
 * there is no half-written setup to read. No migration: `EventConfig` ends in
 * an index signature.
 *
 * ## What counts as a setup
 *
 * An object with a `rounds` list is one. Anything else under the key — a
 * string, an array, an object with no rounds — is not a setup and reads as not
 * round-scored, since there is nothing in it a round could be scored against.
 * Inside a setup, a round that is not an object is an unnamed round and a bonus
 * missing a string name or a numeric value is dropped; the reader is lenient
 * because the public page reads this, and {@link roundScoringProblem} is where
 * a bad setup is refused rather than here.
 */
export function roundScoringFrom(config: EventConfig | null | undefined): RoundScoring | null {
  const stored = record(config?.roundScoring);
  if (!Array.isArray(stored.rounds)) return null;

  const bonuses = Array.isArray(stored.bonuses) ? stored.bonuses : [];
  return {
    rounds: stored.rounds.map((round) => ({ name: givenRoundName({ name: storedName(round) }) })),
    lowWins: stored.lowWins === true,
    bonuses: bonuses.flatMap((bonus) => {
      const row = record(bonus);
      return typeof row.key === "string" && typeof row.value === "number"
        ? [{ key: row.key, value: row.value }]
        : [];
    }),
  };
}

/** The `name` off a stored round, when it is a string; a round that is anything else has none. */
function storedName(round: SettingValue): string | null {
  const name = record(round).name;
  return typeof name === "string" ? name : null;
}

/**
 * Why this setup cannot be saved, or null when it can (UC-44 4b, 4c).
 *
 * Pure and shared, like every other refusal in this module, so the sentence the
 * panel shows before a round trip is the sentence the save would have been
 * refused with. Names are compared trimmed and without case: "Fast" and " fast"
 * would be two boxes nobody could tell apart on the scoring screen, which is the
 * whole of 4b's reason.
 *
 * Bonus values are whole numbers because scores are (decision 006): a bonus
 * worth 1.5 would be the one fraction in an integer table.
 *
 * The three sentences share no phrase — Task 78's `toContain` escape.
 */
export function roundScoringProblem(setup: RoundScoring): string | null {
  if (setup.rounds.length < 1) return "A night has at least one round.";
  if (setup.rounds.length > MAX_ROUNDS) return `A night has at most ${MAX_ROUNDS} rounds.`;

  const seen = new Set<string>();
  for (const bonus of setup.bonuses) {
    const name = bonus.key.trim();
    if (name === "") return "Every bonus needs a name. The scoring screen picks a bonus out by it.";
    const folded = name.toLowerCase();
    if (seen.has(folded)) {
      return `Two bonuses are called "${name}". The scoring screen picks a bonus out by its name, so each needs its own.`;
    }
    seen.add(folded);
    if (!Number.isInteger(bonus.value)) return `"${name}" has to be worth a whole number of points.`;
    if (bonus.value < 1) return `"${name}" has to be worth at least a point. A penalty is not a bonus.`;
  }
  return null;
}

/** UC-44 5's sentence: "6 rounds, highest total wins, 2 bonuses". */
export function roundScoringSummary(setup: RoundScoring): string {
  const bonuses =
    setup.bonuses.length === 0 ? "no bonuses" : counted(setup.bonuses.length, "bonus", "bonuses");
  return `${counted(setup.rounds.length, "round")}, ${setup.lowWins ? "lowest" : "highest"} total wins, ${bonuses}`;
}

/**
 * A score row as the destructive rules need it — the fields of an
 * `event_round_scores` row that say which round, whose, and which bonuses. A
 * full `RoundScoreRow` fits; the score itself is not read.
 */
export type ScoredRow = {
  /** 1-based, as the table stores it. */
  roundIndex: number;
  userId: string;
  bonuses: Readonly<Record<string, number>>;
};

/**
 * What saving `after` over `before` would take away, as sentences — empty when
 * nothing would (UC-44 2b, 3a, 4d).
 *
 * ## Why a list of sentences rather than three booleans
 *
 * `tabHiddenBecause`'s reason, one level down: each of these states has to be
 * *named* to the manager — how many scores, from which rounds, how many awards,
 * to whom — and a predicate gives the panel and the action nothing to print.
 * The same list is the panel's standing warning and, joined by
 * {@link roundScoringConfirmRefusal}, the action's refusal, so the two cannot
 * say different things about the same save.
 *
 * ## Why it is pure, and takes the rows
 *
 * The confirm states are reachable only by editing, and the suite has nothing
 * to click — so this is a decision over plain data, asserted directly over
 * every combination, the way Task 83's `manualPostStep` and Task 80's
 * `standingOn` were. The rows come in rather than being read here for the
 * reason `rankRounds` takes them: the panel holds the page's read, the action
 * reads its own, and both run the identical arithmetic.
 *
 * ## The three, in the order the panel asks
 *
 *  1. **Fewer rounds than are scored** (2b): every row in a round past the new
 *     count goes, named by round — the name given, or "Round N".
 *  2. **A bonus deleted that has been awarded** (4d): every award of a key the
 *     new setup no longer defines goes, counted and named by player. Only
 *     awards in rounds that *survive* are counted, so an award in a round that
 *     is going anyway is not named twice. Task 86 decided an award with no
 *     definition counts nothing rather than throwing; this is what keeps that
 *     state unreachable.
 *  3. **The direction flipped with scores on the board** (3a): nothing is
 *     deleted, but the table turns upside down, and the manager is told so.
 *     Not asked when every recorded score is going anyway — there is no table
 *     left to invert.
 */
export function roundScoringLosses(
  before: RoundScoring | null,
  after: RoundScoring,
  rows: readonly ScoredRow[],
  nameOf: (userId: string) => string
): string[] {
  const losses: string[] = [];
  const kept = after.rounds.length;

  const cut = rows.filter((row) => row.roundIndex > kept);
  if (cut.length > 0) {
    const roundsHit = [...new Set(cut.map((row) => row.roundIndex))]
      .sort((x, y) => x - y)
      .map((index) => roundName(before?.rounds[index - 1], index - 1));
    losses.push(
      `Cutting the night to ${counted(kept, "round")} discards ${counted(cut.length, "score")}, from ${listed(roundsHit)}.`
    );
  }

  const surviving = rows.filter((row) => row.roundIndex <= kept);
  const defined = new Set(after.bonuses.map((bonus) => bonus.key.trim()));
  // Key → player → how many times, in the order the old setup listed its
  // bonuses so the sentences come out in a stable order.
  const awarded = new Map<string, Map<string, number>>();
  for (const bonus of before?.bonuses ?? []) {
    if (!defined.has(bonus.key)) awarded.set(bonus.key, new Map());
  }
  for (const row of surviving) {
    for (const [key, count] of Object.entries(row.bonuses)) {
      if (defined.has(key) || count < 1) continue;
      const byPlayer = awarded.get(key) ?? new Map<string, number>();
      byPlayer.set(row.userId, (byPlayer.get(row.userId) ?? 0) + count);
      awarded.set(key, byPlayer);
    }
  }
  for (const [key, byPlayer] of awarded) {
    if (byPlayer.size === 0) continue;
    let total = 0;
    const who: string[] = [];
    for (const [userId, count] of byPlayer) {
      total += count;
      who.push(count > 1 ? `${nameOf(userId)} (x${count})` : nameOf(userId));
    }
    losses.push(`Dropping "${key}" takes back ${counted(total, "award")}, from ${listed(who)}.`);
  }

  if (before !== null && before.lowWins !== after.lowWins && surviving.length > 0) {
    const one = surviving.length === 1;
    losses.push(
      `Switching to ${after.lowWins ? "lowest" : "highest"} total wins turns the table upside down: the ${counted(surviving.length, "score")} already recorded ${one ? "ranks" : "rank"} the other way round.`
    );
  }

  return losses;
}

/**
 * The action's refusal when a save would take something away and the manager
 * has not yet said so — the losses, then what to do about it. Worded to share
 * no phrase with {@link roundScoringProblem}'s sentences.
 */
export function roundScoringConfirmRefusal(losses: readonly string[]): string {
  return `${losses.join(" ")} Tick the box below to go ahead.`;
}

/** "1 round", "3 scores", "2 bonuses". */
function counted(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "A", "A and B", "A, B and C". */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
