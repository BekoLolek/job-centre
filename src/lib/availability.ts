import { eq, inArray } from "drizzle-orm";
import {
  type AvailabilityState,
  type Database,
  availabilityExceptions,
  availabilityRules,
  db as defaultDb,
  users,
} from "@/db";
import { type PlainDate, addDays, formatDate, parseDate, todayIn } from "./zoned-time";
import {
  type AvailabilityAnswer,
  type AvailabilityException,
  type AvailabilityRule,
  type PersonAvailability,
  mergeExceptions,
  mergeRules,
  rangeRefusal,
  weekDays,
  weekdayName,
} from "./availability-resolve";

/*
 * The pure half is re-exported, so every server caller keeps one import and
 * only client components have to know the split exists.
 */
export * from "./availability-resolve";

/**
 * General availability: when somebody is free, independent of any event.
 *
 * The shape of the answer is in `src/db/schema.ts`. What lives here is the
 * two operations nobody should reimplement:
 *
 *  1. **Writing a person's answer**, which is a whole-list replace rather than
 *     a diff. Availability is small, it is edited as one form, and a diff
 *     would mean reconciling ids the browser has no reason to hold.
 *  2. **Resolving it against a real week**, which is the only place the weekly
 *     pattern, the exceptions and the timezone all meet.
 *
 * Resolution returns absolute instants. Every consumer — the admin grid, a
 * future "when could this event run" suggestion — then works in milliseconds
 * and never has to think about clocks again, which is the same bargain the
 * rest of the codebase makes.
 */

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

/** One person's answer, for the profile form. */
export async function getAvailability(
  userId: string,
  database: Database = defaultDb
): Promise<AvailabilityAnswer> {
  const [person] = await database
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId));

  const rules = await database
    .select()
    .from(availabilityRules)
    .where(eq(availabilityRules.userId, userId));

  const exceptions = await database
    .select()
    .from(availabilityExceptions)
    .where(eq(availabilityExceptions.userId, userId));

  return {
    timezone: person?.timezone ?? null,
    rules: rules
      .map((row) => ({
        weekday: row.weekday,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
        state: row.state === "maybe" ? ("maybe" as const) : ("yes" as const),
      }))
      .sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute),
    exceptions: exceptions
      .map((row) => ({
        date: row.onDate,
        startMinute: row.startMinute,
        endMinute: row.endMinute,
        state: row.state,
        note: row.note,
      }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.startMinute - b.startMinute),
  };
}

/**
 * Everybody's answer at once, for the admin grid.
 *
 * Three queries rather than a join: the join would multiply rules by
 * exceptions per person, and stitching that back apart in JavaScript is more
 * code than asking three times for a table this size. Only members who have
 * said something are returned — an empty answer is not a row on a heatmap.
 */
export async function getEveryoneAvailability(
  database: Database = defaultDb,
  dates?: readonly string[]
): Promise<PersonAvailability[]> {
  const rules = await database.select().from(availabilityRules);
  const exceptions = dates
    ? await database
        .select()
        .from(availabilityExceptions)
        .where(inArray(availabilityExceptions.onDate, [...dates]))
    : await database.select().from(availabilityExceptions);

  const ids = [...new Set([...rules, ...exceptions].map((row) => row.userId))];
  if (ids.length === 0) return [];

  const people = await database
    .select({
      id: users.id,
      displayName: users.displayName,
      name: users.name,
      handle: users.handle,
      timezone: users.timezone,
    })
    .from(users)
    .where(inArray(users.id, ids));

  return people
    .map((person) => ({
      userId: person.id,
      name: person.displayName ?? person.name ?? person.handle ?? "Member",
      handle: person.handle,
      timezone: person.timezone,
      rules: rules
        .filter((row) => row.userId === person.id)
        .map((row) => ({
          weekday: row.weekday,
          startMinute: row.startMinute,
          endMinute: row.endMinute,
          state: row.state === "maybe" ? ("maybe" as const) : ("yes" as const),
        })),
      exceptions: exceptions
        .filter((row) => row.userId === person.id)
        .map((row) => ({
          date: row.onDate,
          startMinute: row.startMinute,
          endMinute: row.endMinute,
          state: row.state,
          note: row.note,
        })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* Writing                                                            */
/* ------------------------------------------------------------------ */

export type SaveResult =
  | { ok: true; data: { rules: number; exceptions: number } }
  | { ok: false; error: string };

const MAX_RULES = 60;
const MAX_EXCEPTIONS = 120;

/**
 * Replace one person's whole answer (UC-06 7, 7b, 7c, 7d).
 *
 * Three rules, and which of them repairs and which refuses is the point:
 *
 *  - **Overlapping ranges merge** (7d, the approved amendment to 7b in
 *    `docs/plan.md`). Merging loses nothing: every minute the member claimed
 *    is still claimed after it.
 *  - **A range that ends before it starts is refused, by name** (7b). There is
 *    no repair that keeps what they said — moving either end writes a time
 *    they did not type — so nothing is saved and the message identifies the
 *    one row that is wrong.
 *  - **A date in the past is refused** (7c), unless the member already has
 *    that date stored. An override for a date that has been and gone cannot
 *    change any future week, and the form loads what is stored: refusing those
 *    too would mean a member who booked a holiday last year could never save
 *    anything again until they hunted down a row they had forgotten. So the
 *    rule is about what is being *added*, which is what step 6 is about.
 *
 * `now` is a parameter so that "the past" is testable. The day it is compared
 * against is the member's own — the zone they are writing in, the zone the
 * dates mean something in — and not the server's.
 */
export async function setAvailability(
  userId: string,
  input: AvailabilityAnswer,
  database: Database = defaultDb,
  now: Date = new Date()
): Promise<SaveResult> {
  if (input.rules.length > MAX_RULES) {
    return { ok: false, error: `That is more than ${MAX_RULES} weekly windows.` };
  }
  if (input.exceptions.length > MAX_EXCEPTIONS) {
    return { ok: false, error: `That is more than ${MAX_EXCEPTIONS} dates.` };
  }

  const zone = (input.timezone ?? "").trim();
  if (zone && !isZone(zone)) return { ok: false, error: "That is not a timezone." };

  for (const rule of input.rules) {
    if (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6) {
      return { ok: false, error: "That is not a day of the week." };
    }
    const bad = rangeRefusal(weekdayName(rule.weekday), rule.startMinute, rule.endMinute);
    if (bad) return { ok: false, error: bad };
  }

  // The dates this member already has, read before anything is validated:
  // a stored past date is history, not something they are adding now.
  const already = new Set(
    (
      await database
        .select({ onDate: availabilityExceptions.onDate })
        .from(availabilityExceptions)
        .where(eq(availabilityExceptions.userId, userId))
    ).map((row) => row.onDate)
  );
  const today = formatDate(todayIn(zone || "UTC", now));

  for (const exception of input.exceptions) {
    if (!parseDate(exception.date)) {
      return { ok: false, error: `"${exception.date}" is not a date.` };
    }
    if (exception.date < today && !already.has(exception.date)) {
      return { ok: false, error: `${exception.date} has already been — pick a date from today on.` };
    }
    const bad = rangeRefusal(exception.date, exception.startMinute, exception.endMinute);
    if (bad) return { ok: false, error: bad };
  }

  return database.transaction(async (tx) => {
    if (zone) await tx.update(users).set({ timezone: zone }).where(eq(users.id, userId));

    await tx.delete(availabilityRules).where(eq(availabilityRules.userId, userId));
    await tx.delete(availabilityExceptions).where(eq(availabilityExceptions.userId, userId));

    const merged = mergeRules(input.rules);
    if (merged.length > 0) {
      await tx.insert(availabilityRules).values(
        merged.map((rule) => ({
          userId,
          weekday: rule.weekday,
          startMinute: rule.startMinute,
          endMinute: rule.endMinute,
          state: rule.state,
        }))
      );
    }

    const dates = mergeExceptions(input.exceptions);
    if (dates.length > 0) {
      await tx.insert(availabilityExceptions).values(
        dates.map((exception) => ({
          userId,
          onDate: exception.date,
          startMinute: exception.startMinute,
          endMinute: exception.endMinute,
          state: exception.state,
          note: exception.note?.trim() || null,
        }))
      );
    }

    return { ok: true as const, data: { rules: merged.length, exceptions: dates.length } };
  });
}

function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Everything the grid needs about a week, in the shape the page hands down. */
export async function availabilityWeek(
  monday: PlainDate,
  database: Database = defaultDb
): Promise<PersonAvailability[]> {
  const days = weekDays(monday);
  // A window running past midnight can reach the following date, so the
  // exception read has to cover one more day than the grid shows.
  const span = [...days, addDays(monday, 7)].map(formatDate);
  return getEveryoneAvailability(database, span);
}
