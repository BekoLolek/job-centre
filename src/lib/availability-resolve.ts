import type { AvailabilityState } from "@/db/schema";
import {
  type PlainDate,
  addDays,
  clockWithDay,
  formatDate,
  weekdayOf,
  zonedToInstant,
} from "./zoned-time";

/**
 * Availability arithmetic, with no database in it.
 *
 * Split from `availability.ts` for one hard reason: the admin grid counts in
 * the browser, and `availability.ts` imports `@/db`, which reaches PGlite,
 * which reaches `node:fs`. Importing any value from it in a client component
 * does not merely bloat the bundle — Turbopack refuses to build at all, which
 * is at least an honest failure.
 *
 * The rule this file exists to enforce: client components import types from
 * `availability.ts` and functions from here.
 */

export const SLOT_MINUTES = 30;

/** A weekly rule cannot say "no"; absence already does. */
export type RuleState = Extract<AvailabilityState, "yes" | "maybe">;

export type AvailabilityRule = {
  /** 0 = Monday. */
  weekday: number;
  startMinute: number;
  endMinute: number;
  state: RuleState;
};

export type AvailabilityException = {
  /** "2026-08-24". */
  date: string;
  startMinute: number;
  endMinute: number;
  state: AvailabilityState;
  note: string | null;
};

export type AvailabilityAnswer = {
  timezone: string | null;
  rules: AvailabilityRule[];
  exceptions: AvailabilityException[];
};

export const EMPTY_ANSWER: AvailabilityAnswer = { timezone: null, rules: [], exceptions: [] };

export type PersonAvailability = AvailabilityAnswer & {
  userId: string;
  name: string;
  handle: string | null;
};

/**
 * The general shape merging works on: a range, on some day, in some state.
 *
 * `on` is whatever identifies the day the range belongs to — a weekday number
 * for the usual week, a date string for a named day — so one implementation
 * covers both. It is only ever compared for equality.
 */
type Range = { on: string; startMinute: number; endMinute: number; state: AvailabilityState };

/**
 * Fold overlapping ranges on the same day into one (UC-06 7d).
 *
 * This is the approved amendment to UC-06 7b, in `docs/plan.md` under "Spec
 * amendments proposed": overlapping ranges were written as an error and are
 * merged instead, because merging loses nothing — every minute the member
 * claimed is still claimed afterwards. Only *end before start* is an error,
 * because there is no reading of it that keeps what they said.
 *
 * Two ranges that merely touch are one range as well. Storing them apart shows
 * up on the grid as a seam nobody drew.
 *
 * `strength` is the order in which a stronger claim swallows a weaker one it
 * fully covers: a `maybe` sitting under a `yes` is not news. A partial overlap
 * between two different states is left alone — trimming it would be the system
 * deciding which half of a sentence the member meant.
 */
function mergeRanges<T extends Range>(
  ranges: readonly T[],
  strength: readonly AvailabilityState[]
): T[] {
  const out: T[] = [];
  const days = [...new Set(ranges.map((range) => range.on))];

  for (const state of strength) {
    for (const on of days) {
      const same = ranges
        .filter((range) => range.on === on && range.state === state)
        .sort((a, b) => a.startMinute - b.startMinute);

      let open: T | null = null;
      for (const range of same) {
        if (open && range.startMinute <= open.endMinute) {
          open.endMinute = Math.max(open.endMinute, range.endMinute);
          continue;
        }
        open = { ...range };
        out.push(open);
      }
    }
  }

  const rank = (state: AvailabilityState) => strength.indexOf(state);
  return out
    .filter((range) => !coveredByStronger(range, out, rank))
    .sort((a, b) => a.on.localeCompare(b.on) || a.startMinute - b.startMinute);
}

function coveredByStronger<T extends Range>(
  range: T,
  by: readonly T[],
  rank: (state: AvailabilityState) => number
): boolean {
  return by.some(
    (other) =>
      other.on === range.on &&
      rank(other.state) < rank(range.state) &&
      other.startMinute <= range.startMinute &&
      other.endMinute >= range.endMinute
  );
}

/**
 * Fold a member's usual week (UC-06 7d).
 *
 * `yes` swallows `maybe`: somebody definitely free from six and possibly free
 * from five is definitely free from six.
 */
export function mergeRules(rules: readonly AvailabilityRule[]): AvailabilityRule[] {
  const merged = mergeRanges(
    rules.map((rule) => ({ ...rule, on: String(rule.weekday) })),
    ["yes", "maybe"]
  );
  return merged
    .map(({ on: _unused, ...rule }) => rule)
    .sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
}

/**
 * Fold the named dates, the same way (UC-06 7d).
 *
 * `no` leads the order here, which `mergeRules` has no equivalent of. A named
 * date is the member overriding their usual week, and the reason they name one
 * is nearly always that they cannot make it; "I am away" covering a window
 * they also marked maybe is them saying the maybe is off, not both at once.
 * A partial overlap between the two is still kept whole, because half a
 * refusal is a real thing to say — "free all evening, out from eight".
 */
export function mergeExceptions(
  exceptions: readonly AvailabilityException[]
): AvailabilityException[] {
  return mergeRanges(
    exceptions.map((exception) => ({ ...exception, on: exception.date })),
    ["no", "yes", "maybe"]
  )
    .map(({ on: _unused, ...exception }) => exception)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute);
}

/* ------------------------------------------------------------------ */
/* Refusing a range, by name                                          */
/* ------------------------------------------------------------------ */

/** 05:00 the next morning is as late as a range may run. */
export const LATEST_MINUTE = 1740;

/**
 * Why this range cannot be saved, or null when it can (UC-06 7b).
 *
 * The range is **named** in every message. "A window has to end after it
 * starts" is useless in a form holding fourteen of them: the member has to
 * find the wrong one themselves, and the one place they will not look is the
 * one they thought they had already fixed. `name` is the day or the date, and
 * the times are quoted back, so the sentence identifies exactly one row.
 *
 * It refuses rather than repairs, and that is the other half of the amendment:
 * the client used to shunt the end forward whenever it landed before the
 * start, which wrote something the member never said and hid the slip that
 * caused it. Overlaps merge (nothing is lost); a backwards range is refused
 * (something would be invented).
 */
export function rangeRefusal(name: string, startMinute: number, endMinute: number): string | null {
  if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)) {
    return `${name}: that is not a time.`;
  }
  if (startMinute < 0 || endMinute > LATEST_MINUTE) {
    return `${name}: times run from midnight to 05:00 the next day.`;
  }
  if (endMinute <= startMinute) {
    return (
      `${name} ${clockWithDay(startMinute)} – ${clockWithDay(endMinute)} ends before it starts.`
    );
  }
  return null;
}

/** "Monday", "Tuesday"… for naming a weekly range in a refusal. */
export const WEEKDAY_NAMES = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

/** The name a weekly range carries in a refusal. Out-of-range days say so. */
export function weekdayName(weekday: number): string {
  return WEEKDAY_NAMES[weekday] ?? `Day ${weekday}`;
}

/* ------------------------------------------------------------------ */
/* Resolving against a real week                                      */
/* ------------------------------------------------------------------ */

export type ResolvedInterval = {
  /** Absolute, so nothing downstream has to know about clocks. */
  from: number;
  to: number;
  state: AvailabilityState;
};

/**
 * One person's availability across `days`, as instants.
 *
 * A date carrying any exception is described entirely by its exceptions — see
 * the schema note. That is checked per date, before the weekly pattern is
 * consulted at all, which is what keeps the rule to one sentence.
 *
 * The zone is the *person's*, not the reader's. Someone who wrote "Tuesdays
 * after eight" in Warsaw is free from 19:00 in London, and the whole point of
 * storing the zone is that the grid can say so.
 */
export function resolveFor(
  person: Pick<PersonAvailability, "rules" | "exceptions" | "timezone">,
  days: readonly PlainDate[],
  fallbackZone: string
): ResolvedInterval[] {
  const zone = person.timezone ?? fallbackZone;
  const byDate = new Map<string, AvailabilityException[]>();
  for (const exception of person.exceptions) {
    const list = byDate.get(exception.date);
    if (list) list.push(exception);
    else byDate.set(exception.date, [exception]);
  }

  const out: ResolvedInterval[] = [];
  for (const day of days) {
    const key = formatDate(day);
    const named = byDate.get(key);

    const windows: Array<{ startMinute: number; endMinute: number; state: AvailabilityState }> =
      named ?? person.rules.filter((rule) => rule.weekday === weekdayOf(day));

    for (const window of windows) {
      if (window.state === "no") continue;
      out.push({
        from: zonedToInstant(day, window.startMinute, zone).getTime(),
        to: zonedToInstant(day, window.endMinute, zone).getTime(),
        state: window.state,
      });
    }
  }
  return out;
}

/** Whether a person said an outright "not that day". */
export function refusedOn(
  person: Pick<PersonAvailability, "exceptions">,
  date: PlainDate
): boolean {
  const key = formatDate(date);
  const named = person.exceptions.filter((exception) => exception.date === key);
  return named.length > 0 && named.every((exception) => exception.state === "no");
}

/** The seven dates of the week beginning `monday`. */
export function weekDays(monday: PlainDate): PlainDate[] {
  return Array.from({ length: 7 }, (_unused, index) => addDays(monday, index));
}

/* ------------------------------------------------------------------ */
/* The grid                                                           */
/* ------------------------------------------------------------------ */

export type SlotTally = {
  /** Slot start, absolute. */
  from: number;
  to: number;
  yes: string[];
  maybe: string[];
};

/**
 * Count who is free in every slot of a week (UC-07 2, 4a; R-19, R-20).
 *
 * The window may cross midnight — an admin looking for evening slots wants
 * 14:00 to 01:00, and the hour after midnight belongs to the evening it
 * followed, not to the next morning. That is why the end is allowed past 1440
 * rather than the grid wrapping onto the following column.
 *
 * A person counts for a slot only when they cover *all* of it. Covering half
 * of a half-hour is not availability you can schedule a match in, and counting
 * it would make the darkest cell on the grid a lie.
 *
 * ## The slots are cut from instants, not from the clock face
 *
 * Only the two ends of the window are wall-clock times. Everything between
 * them is `from + 30 minutes`, in real milliseconds, until the window's end
 * instant — which is the only way a clock-change week comes out right
 * (UC-07 4a):
 *
 *  - **Spring forward.** 02:00 to 03:00 never happens. Walking the clock face
 *    asks for 02:00 and for 02:30, and `zonedToInstant` answers both with the
 *    instant past the gap — the same instant 03:00 and 03:30 get. The grid
 *    then drew four cells over two real half-hours, counted the same people
 *    twice and offered the admin a slot nobody can play in. Walking instants,
 *    the day is simply two slots shorter, and every cell is a half-hour that
 *    exists.
 *  - **Fall back.** 02:00 to 03:00 happens twice. `zonedToInstant` answers
 *    with the earlier of the two, so the hour's second pass belonged to no
 *    slot at all and an hour of real availability was invisible. Walking
 *    instants, the day is two slots longer and both passes are on the grid.
 *
 * A column is therefore as long as its day really is, and different columns of
 * one week can differ in length. That is not an inconvenience to paper over —
 * it is the fact the old grid was hiding.
 */
export function tallyWeek(
  people: readonly PersonAvailability[],
  days: readonly PlainDate[],
  window: { startMinute: number; endMinute: number },
  viewerZone: string,
  slotMinutes = SLOT_MINUTES
): SlotTally[][] {
  const resolved = people.map((person) => ({
    name: person.name,
    intervals: resolveFor(person, days, viewerZone),
  }));
  const step = slotMinutes * 60_000;

  return days.map((day) => {
    const column: SlotTally[] = [];
    const opens = zonedToInstant(day, window.startMinute, viewerZone).getTime();
    const closes = zonedToInstant(day, window.endMinute, viewerZone).getTime();

    for (let from = opens; from + step <= closes; from += step) {
      const to = from + step;

      const yes: string[] = [];
      const maybe: string[] = [];
      for (const person of resolved) {
        const covering = person.intervals.find(
          (interval) => interval.from <= from && interval.to >= to
        );
        if (!covering) continue;
        (covering.state === "maybe" ? maybe : yes).push(person.name);
      }
      column.push({ from, to, yes, maybe });
    }
    return column;
  });
}

/* ------------------------------------------------------------------ */
/* Clock faces for instants                                           */
/* ------------------------------------------------------------------ */

const clockCache = new Map<string, Intl.DateTimeFormat>();

/**
 * An instant as a clock face in a zone: "02:30".
 *
 * Because the grid's slots are instants, a cell's label cannot be worked out
 * from its row any more — on a clock-change day the row and the clock have
 * parted company, which is the whole point. Each slot is asked what time it
 * is, and `Intl` answers with the real local time (UC-07 4a).
 *
 * This lives here, not in a page: nothing in this codebase formats an instant
 * on the server, because the server has no reader and would have to pick
 * somebody's clock to do it in.
 */
export function clockAt(instant: number, zone: string): string {
  let formatter = clockCache.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    });
    clockCache.set(zone, formatter);
  }
  // Some ICU versions render midnight as 24:00 under h23.
  return formatter.format(new Date(instant)).replace(/^24:/, "00:");
}
