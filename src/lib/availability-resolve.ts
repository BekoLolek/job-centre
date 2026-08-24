import type { AvailabilityState } from "@/db/schema";
import { type PlainDate, addDays, formatDate, weekdayOf, zonedToInstant } from "./zoned-time";

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
 * Fold overlapping windows on the same day into one.
 *
 * Two windows that touch are one window, and storing them apart would show up
 * on the grid as a seam nobody drew. `yes` swallows `maybe`, because a person
 * who is definitely free from six and possibly free from five is definitely
 * free from six — the stronger claim wins where they overlap.
 */
export function mergeRules(rules: readonly AvailabilityRule[]): AvailabilityRule[] {
  const out: AvailabilityRule[] = [];

  for (const state of ["yes", "maybe"] as const) {
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const same = rules
        .filter((rule) => rule.weekday === weekday && rule.state === state)
        .sort((a, b) => a.startMinute - b.startMinute);

      let open: AvailabilityRule | null = null;
      for (const rule of same) {
        if (open && rule.startMinute <= open.endMinute) {
          open.endMinute = Math.max(open.endMinute, rule.endMinute);
          continue;
        }
        open = { ...rule };
        out.push(open);
      }
    }
  }

  // A `maybe` under a `yes` is not news. Trim it rather than storing both.
  const firm = out.filter((rule) => rule.state === "yes");
  return out
    .filter((rule) => rule.state === "yes" || !covered(rule, firm))
    .sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute);
}

function covered(rule: AvailabilityRule, by: readonly AvailabilityRule[]): boolean {
  return by.some(
    (other) =>
      other.weekday === rule.weekday &&
      other.startMinute <= rule.startMinute &&
      other.endMinute >= rule.endMinute
  );
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
 * Count who is free in every slot of a week.
 *
 * The window may cross midnight — an admin looking for evening slots wants
 * 14:00 to 01:00, and the hour after midnight belongs to the evening it
 * followed, not to the next morning. That is why `windowEnd` is allowed past
 * 1440 rather than the grid wrapping onto the following column.
 *
 * A person counts for a slot only when they cover *all* of it. Covering half
 * of a half-hour is not availability you can schedule a match in, and counting
 * it would make the darkest cell on the grid a lie.
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

  return days.map((day) => {
    const column: SlotTally[] = [];
    for (
      let minute = window.startMinute;
      minute + slotMinutes <= window.endMinute;
      minute += slotMinutes
    ) {
      const from = zonedToInstant(day, minute, viewerZone).getTime();
      const to = zonedToInstant(day, minute + slotMinutes, viewerZone).getTime();

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
