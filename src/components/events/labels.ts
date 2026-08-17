/**
 * The words an event is described with, in one place.
 *
 * Presentation only — no database, no policy. Every rule about what an event
 * *is* lives in `src/lib/events-policy.ts`; this module only decides how the
 * answers are spelled, so that "Applications open" reads the same on the admin
 * list, the public hub and the event page rather than being retyped three times
 * with three different capitalisations.
 */

import type { Status } from "@/components/ui";
import type { EventConfig, EventStatus } from "@/db/schema";
import type { ApplicationsState } from "@/lib/events-policy";
import type { ApplicationStatus } from "@/db/schema";

/* ------------------------------------------------------------------ */
/* Event status                                                       */
/* ------------------------------------------------------------------ */

/**
 * The five event statuses onto the six pill tones.
 *
 * `published` becomes `open` rather than getting a tone of its own: a published
 * event is the one members can act on, and the gold tone is what makes it the
 * thing the eye lands on in a list of drafts.
 */
const STATUS_TONE: Record<EventStatus, Status> = {
  draft: "draft",
  published: "open",
  live: "live",
  complete: "complete",
  cancelled: "cancelled",
};

const STATUS_LABEL: Record<EventStatus, string> = {
  draft: "Draft",
  published: "Published",
  live: "Live",
  complete: "Complete",
  cancelled: "Cancelled",
};

export function eventStatusTone(status: EventStatus): Status {
  return STATUS_TONE[status];
}

export function eventStatusLabel(status: EventStatus): string {
  return STATUS_LABEL[status];
}

/** One line saying what this status means, for a screen with room to explain. */
const STATUS_MEANING: Record<EventStatus, string> = {
  draft: "Only admins can see this. Nobody can apply.",
  published: "Members can see it; applications follow the signup window.",
  live: "Running now. Applications are closed.",
  complete: "Finished. Kept for the record.",
  cancelled: "Called off. Applications stay for the record.",
};

export function eventStatusMeaning(status: EventStatus): string {
  return STATUS_MEANING[status];
}

/* ------------------------------------------------------------------ */
/* Applications                                                       */
/* ------------------------------------------------------------------ */

/** The short pill next to an event: are applications open, and in what way? */
export function applicationsPill(state: ApplicationsState): { tone: Status; label: string } {
  if (!state.open) {
    if (state.reason === "not_published") return { tone: "draft", label: "Not published" };
    if (state.reason === "too_early") return { tone: "closed", label: "Opens later" };
    if (state.reason === "cancelled") return { tone: "cancelled", label: "Cancelled" };
    return { tone: "closed", label: "Applications closed" };
  }
  return state.willWaitlist
    ? { tone: "open", label: "Waitlist only" }
    : { tone: "open", label: "Applications open" };
}

/* ------------------------------------------------------------------ */
/* Application status                                                 */
/* ------------------------------------------------------------------ */

const APPLICATION_TONE: Record<ApplicationStatus, Status> = {
  accepted: "complete",
  waitlisted: "open",
  declined: "cancelled",
  withdrawn: "closed",
};

const APPLICATION_LABEL: Record<ApplicationStatus, string> = {
  accepted: "Accepted",
  waitlisted: "Waitlisted",
  declined: "Declined",
  withdrawn: "Withdrawn",
};

export function applicationStatusTone(status: ApplicationStatus): Status {
  return APPLICATION_TONE[status];
}

export function applicationStatusLabel(status: ApplicationStatus): string {
  return APPLICATION_LABEL[status];
}

/* ------------------------------------------------------------------ */
/* Event type                                                         */
/* ------------------------------------------------------------------ */

/**
 * §8.1 makes an event type a capability set stored as free text, so this is a
 * prettifier and not a lookup: an unknown type gets title-cased rather than
 * falling through to "Unknown", because adding "Among Us night" must not need a
 * code change here either.
 */
const TYPE_LABEL: Record<string, string> = {
  tournament: "Tournament",
  casual: "Casual",
  jackbox: "Jackbox",
  repo: "REPO",
  custom: "Custom",
};

/**
 * The types the admin picker offers as one-tap options.
 *
 * A *suggestion list*, not a constraint — `events.type` is free text precisely
 * so that adding "Among Us night" is a row rather than a migration (§8.1), and
 * the editor keeps a text box next to these chips for exactly that. It is
 * spelled out here rather than imported from `@/db/schema` because that module
 * builds every Drizzle table at import time, and a client bundle has no use for
 * any of it.
 */
export const EVENT_TYPE_SUGGESTIONS = [
  "tournament",
  "casual",
  "jackbox",
  "repo",
  "custom",
] as const;

export function eventTypeLabel(type: string): string {
  const key = type.trim().toLowerCase();
  if (TYPE_LABEL[key]) return TYPE_LABEL[key];
  return key
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/* ------------------------------------------------------------------ */
/* The format, in plain words                                         */
/* ------------------------------------------------------------------ */

export type FormatView = {
  type: string;
  config: EventConfig | null | undefined;
  /** How many `event_days` rows it has. */
  days: number;
  /** Null is unlimited. */
  capacity: number | null;
};

/**
 * "Tournament · 8 teams · bid draft · 2 days · 24 seats" — plan §6.2's format
 * summary in plain words, as phrases a page can lay out however it likes.
 *
 * Deliberately says only what the event data actually knows. §8.1 makes a type
 * a capability set rather than a code branch, so a Jackbox night comes back as
 * "Jackbox · 1 day · 12 seats" without anything here testing for Jackbox — and
 * the series lengths and bracket shape §6.2 mentions arrive in Phase 4, at
 * which point they are more phrases here rather than a new component.
 */
export function formatSummary(event: FormatView): string[] {
  const parts: string[] = [eventTypeLabel(event.type)];
  const config = event.config ?? {};

  const teams = typeof config.teams === "number" ? config.teams : null;
  if (teams && teams > 0) parts.push(`${teams} teams`);
  if (config.draft === true) parts.push("bid draft");
  if (config.bracket === true) parts.push("bracket");

  if (event.days > 0) parts.push(event.days === 1 ? "one day" : `${event.days} days`);

  parts.push(event.capacity === null ? "no seat limit" : `${event.capacity} seats`);
  if (config.waitlist === false) parts.push("no waitlist");

  return parts;
}

/* ------------------------------------------------------------------ */
/* Availability                                                       */
/* ------------------------------------------------------------------ */

/** The three availability answers, in the order they should be offered. */
export const AVAILABILITY_CHOICES = [
  { value: "yes", label: "Yes" },
  { value: "maybe", label: "Maybe" },
  { value: "no", label: "No" },
] as const;

const AVAILABILITY_MARK: Record<string, string> = {
  yes: "✓",
  maybe: "~",
  no: "✕",
};

/** A one-character answer for a dense table cell. `—` when they never said. */
export function availabilityMark(state: string | null | undefined): string {
  if (!state) return "—";
  return AVAILABILITY_MARK[state] ?? "—";
}

/** The colour that mark should carry. */
export function availabilityTone(state: string | null | undefined): string {
  if (state === "yes") return "text-signal";
  if (state === "maybe") return "text-gold";
  if (state === "no") return "text-ember";
  return "text-muted";
}
