import type { EventStatus } from "@/db/schema";

/**
 * What `/events` and `/archive` agree on.
 *
 * A plain module rather than an export from either page: importing a value
 * *from* a page module drags that page's whole render into the importer, which
 * is how two sibling routes end up in one bundle.
 */

/**
 * Everything a member may see. Deliberately not `draft`.
 *
 * `cancelled` is here on purpose. An event that was called off is part of the
 * record — somebody who applied to it should be able to find it again — and
 * hiding it would make the archive quietly disagree with the notification that
 * told them it was off.
 */
export const PUBLIC_STATUSES: EventStatus[] = [
  "published",
  "live",
  "complete",
  "cancelled",
];

/** The first value of a query parameter, trimmed, or null when it says nothing. */
export function firstParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.trim() !== "" ? raw.trim() : null;
}
