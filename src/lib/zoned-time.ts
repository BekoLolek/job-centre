/**
 * Wall-clock times in a named zone, resolved against real dates.
 *
 * Everything else in this codebase stores absolute instants, for the reason in
 * `src/lib/time.ts`: a match at 18:00 CEST has to read as 17:00 BST. General
 * availability is the one thing that cannot work that way. "Tuesdays after
 * eight" is a claim about a clock face, not about a moment — pin it to UTC and
 * it silently becomes "Tuesdays after seven" for four months of the year.
 *
 * So availability is stored as minutes-past-midnight plus the zone it was
 * written in, and converted here, at the point where there is a real date to
 * convert against and the daylight-saving question finally has an answer.
 *
 * No dependency. `Intl` already knows every zone rule the platform knows, and
 * a date library for two functions is a megabyte for something the browser
 * ships.
 */

/**
 * What a zone's offset from UTC is at a given instant, in minutes.
 *
 * The trick: ask `Intl` to render the instant in the target zone, read the
 * rendered fields back as if they were UTC, and subtract. The difference *is*
 * the offset, because rendering is the only thing in the platform that knows
 * the zone's rules.
 */
export function offsetAt(utcMs: number, zone: string): number {
  const parts = formatter(zone).formatToParts(new Date(utcMs));
  const field = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  // `hourCycle: "h23"` still renders midnight as 24 in some ICU versions.
  const hour = field("hour") % 24;
  const asIfUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    hour,
    field("minute"),
    field("second")
  );
  return (asIfUtc - utcMs) / 60_000;
}

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = cache.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    cache.set(zone, found);
  }
  return found;
}

/**
 * A wall-clock time in a zone, as an instant.
 *
 * `minutes` may run past 1440, which is how a Friday night that ends at 2am
 * stays one interval belonging to Friday.
 *
 * Twice a year a wall clock is not a moment, and both cases need answering
 * rather than crashing:
 *
 *  - **The skipped hour.** Clocks jump 01:00 to 02:00, so 01:30 never happens.
 *    Neither candidate offset renders back to the time asked for, and the
 *    answer is the later one, which shifts forward by exactly the size of the
 *    gap — 01:30 becomes 02:30. That is what `Temporal`, `java.time` and every
 *    calendar application do.
 *  - **The repeated hour.** Clocks fall back, so 01:30 happens twice. Both
 *    candidates are valid and the answer is the earlier one, again matching
 *    the standard.
 *
 * A candidate is checked by rendering it back: an instant is the wall time it
 * claims only if the zone's offset *there* is the offset used to build it.
 * Sampling half a day either side is what finds the two candidates, and no
 * clock change is anywhere near that large.
 */
export function zonedToInstant(
  date: { year: number; month: number; day: number },
  minutes: number,
  zone: string
): Date {
  const wall = Date.UTC(date.year, date.month - 1, date.day) + minutes * 60_000;
  const half = 12 * 60 * 60_000;

  const before = offsetAt(wall - half, zone);
  const after = offsetAt(wall + half, zone);
  if (before === after) return new Date(wall - before * 60_000);

  const earlier = wall - before * 60_000;
  const later = wall - after * 60_000;
  const earlierHolds = offsetAt(earlier, zone) === before;
  const laterHolds = offsetAt(later, zone) === after;

  if (earlierHolds && laterHolds) return new Date(Math.min(earlier, later));
  if (earlierHolds) return new Date(earlier);
  if (laterHolds) return new Date(later);
  // The gap: neither exists, so take the one past it.
  return new Date(Math.max(earlier, later));
}

export type PlainDate = { year: number; month: number; day: number };

/** "2026-08-24" to its parts. Dates are stored as dates, never as instants. */
export function parseDate(value: string): PlainDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const parsed = { year: Number(year), month: Number(month), day: Number(day) };
  // Rejects the 31st of February rather than rolling it into March.
  const round = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  return round.getUTCMonth() + 1 === parsed.month && round.getUTCDate() === parsed.day
    ? parsed
    : null;
}

/** Back to "2026-08-24". */
export function formatDate(date: PlainDate): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.year}-${pad(date.month)}-${pad(date.day)}`;
}

/** 0 = Monday, matching `availabilityRules.weekday`. */
export function weekdayOf(date: PlainDate): number {
  const day = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return (day + 6) % 7;
}

export function addDays(date: PlainDate, days: number): PlainDate {
  const at = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

/** The Monday on or before `date`. */
export function weekStart(date: PlainDate): PlainDate {
  return addDays(date, -weekdayOf(date));
}

/** Today, as a date in the given zone rather than in UTC. */
export function todayIn(zone: string, now: Date = new Date()): PlainDate {
  const parts = formatter(zone).formatToParts(now);
  const field = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: field("year"), month: field("month"), day: field("day") };
}

/** The viewer's own zone, or UTC where the platform will not say. */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/* ------------------------------------------------------------------ */
/* Clock faces                                                        */
/* ------------------------------------------------------------------ */

/** 1230 to "20:30". Minutes past 1440 wrap, so 1560 reads as "02:00". */
export function clockOf(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(wrapped / 60))}:${pad(wrapped % 60)}`;
}

/**
 * The same, but says which day it lands on: "02:00" after midnight becomes
 * "02:00 +1". Without it a rule reading "20:00 – 02:00" is ambiguous about
 * whether it is six hours long or minus eighteen.
 */
export function clockWithDay(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  return days > 0 ? `${clockOf(minutes)} +${days}` : clockOf(minutes);
}

/** Every half hour from `from` to `to`, for a dropdown. */
export function clockSteps(from: number, to: number, step = 30): number[] {
  const out: number[] = [];
  for (let minute = from; minute <= to; minute += step) out.push(minute);
  return out;
}
