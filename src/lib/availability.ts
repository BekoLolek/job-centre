import { eq, inArray } from "drizzle-orm";
import {
  type AvailabilityState,
  type Database,
  availabilityExceptions,
  availabilityRules,
  db as defaultDb,
  users,
} from "@/db";
import { type PlainDate, addDays, formatDate, parseDate } from "./zoned-time";
import {
  type AvailabilityAnswer,
  type AvailabilityException,
  type AvailabilityRule,
  type PersonAvailability,
  mergeRules,
  weekDays,
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
 * Replace one person's whole answer.
 *
 * Validation refuses rather than repairs. A window that ends before it starts
 * is a bug in the caller, and silently swapping the ends would hide it while
 * writing something the member never said.
 */
export async function setAvailability(
  userId: string,
  input: AvailabilityAnswer,
  database: Database = defaultDb
): Promise<SaveResult> {
  if (input.rules.length > MAX_RULES) {
    return { ok: false, error: `That is more than ${MAX_RULES} weekly windows.` };
  }
  if (input.exceptions.length > MAX_EXCEPTIONS) {
    return { ok: false, error: `That is more than ${MAX_EXCEPTIONS} dates.` };
  }

  for (const rule of input.rules) {
    if (!Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6) {
      return { ok: false, error: "That is not a day of the week." };
    }
    const bad = windowRefusal(rule.startMinute, rule.endMinute);
    if (bad) return { ok: false, error: bad };
  }

  for (const exception of input.exceptions) {
    if (!parseDate(exception.date)) {
      return { ok: false, error: `"${exception.date}" is not a date.` };
    }
    const bad = windowRefusal(exception.startMinute, exception.endMinute);
    if (bad) return { ok: false, error: bad };
  }

  const zone = (input.timezone ?? "").trim();
  if (zone && !isZone(zone)) return { ok: false, error: "That is not a timezone." };

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

    if (input.exceptions.length > 0) {
      await tx.insert(availabilityExceptions).values(
        input.exceptions.map((exception) => ({
          userId,
          onDate: exception.date,
          startMinute: exception.startMinute,
          endMinute: exception.endMinute,
          state: exception.state,
          note: exception.note?.trim() || null,
        }))
      );
    }

    return { ok: true as const, data: { rules: merged.length, exceptions: input.exceptions.length } };
  });
}

function windowRefusal(start: number, end: number): string | null {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return "That is not a time.";
  if (start < 0 || end > 1740) return "Times run from midnight to 05:00 the next day.";
  if (end <= start) return "A window has to end after it starts.";
  return null;
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
