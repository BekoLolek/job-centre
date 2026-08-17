/**
 * Instant formatting for event screens.
 *
 * Deliberately *not* inside `EventDateRange.tsx`: that file is a client
 * component, and a plain function exported from a `"use client"` module becomes
 * an unusable reference the moment a server component imports it. Keeping the
 * helpers here means both sides can call them.
 */

import { formatWhen, toLocalInput } from "@/lib/time";

/** Accepts what the database hands back, and what a form hands over. */
export type Stamp = Date | string | null | undefined;

/** Anything time-shaped, as the ISO string `src/lib/time.ts` expects. */
export function iso(value: Stamp): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** "Sat 12 Sep · 18:00" in the reader's zone, or null when there is no instant. */
export function whenText(value: Stamp): string | null {
  return formatWhen(iso(value));
}

/** A value a `datetime-local` input accepts, or "" — the editor's round trip. */
export function localInput(value: Stamp): string {
  return toLocalInput(iso(value) ?? undefined);
}
