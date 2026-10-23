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
import { type ApplicationsState, entryMode } from "@/lib/events-policy";
import type { ApplicationStatus } from "@/db/schema";

/* ------------------------------------------------------------------ */
/* Event status                                                       */
/* ------------------------------------------------------------------ */

/**
 * The five event statuses onto the six pill tones.
 *
 * `published` becomes `open` rather than getting a tone of its own: a published
 * event is the one members can act on, and union blue is what makes it the
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

/**
 * One line saying what this status means, for a screen with room to explain.
 *
 * **The draft line names nobody.** It used to read "Only admins can see this",
 * which was true until R-32 / UC-08 2 were built: an unpublished event is
 * visible to its *managers* — an admin, or a host of that event (`canSeeEvent`
 * in `src/lib/hosting.ts`) — and the draft banner on `/events/[slug]` is
 * therefore read by a host who is not an admin, being told that only admins
 * can see the page in front of them. The reader least sure of their own
 * permissions was the one being misinformed.
 *
 * So it describes the *event* rather than the audience. "Not public" is true
 * for every reader who gets this far and names none of them, which is also why
 * it does not list the two roles instead: a host should not have to work out
 * whether "managers" includes them, and a third reader added later would make
 * any such list wrong again rather than merely incomplete.
 */
const STATUS_MEANING: Record<EventStatus, string> = {
  draft: "Not published yet, so it is not public. Nobody can apply.",
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
  pending: "open",
  accepted: "complete",
  waitlisted: "open",
  declined: "cancelled",
  withdrawn: "closed",
};

const APPLICATION_LABEL: Record<ApplicationStatus, string> = {
  pending: "Awaiting review",
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
  // The waitlist switch is a first-come rule (R-27), so an approval event says
  // how people get in instead — "no waitlist" would be true of it in the least
  // useful possible sense.
  if (entryMode(config) === "approval") parts.push("by approval");
  else if (config.waitlist === false) parts.push("no waitlist");

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
  if (state === "yes") return "text-success";
  if (state === "maybe") return "text-union";
  if (state === "no") return "text-flare";
  return "text-muted";
}

/* ------------------------------------------------------------------ */
/* "Are you still coming?"                                            */
/* ------------------------------------------------------------------ */

/**
 * The three answers, in the order they are offered (R-56, R-199).
 *
 * This array is the order, not the enum. `confirmation_state` appends `maybe`
 * after `out` because `ALTER TYPE … ADD VALUE` appends, and the one place the
 * order matters to anybody is here: yes, unsure, no, so the uncertain answer
 * sits between the two it is uncertain between rather than at the end looking
 * like an afterthought.
 */
export const CONFIRMATION_CHOICES = [
  { value: "in", label: "I'll be there" },
  { value: "maybe", label: "Not sure yet" },
  { value: "out", label: "I can't make it" },
] as const;

/**
 * The answer read back to the member who gave it.
 *
 * Phrased as *theirs* — "You said …" — because after the deadline (R-200,
 * UC-13 8) this line is the whole section: the chips are gone and this is all
 * that is left to say what they are held to.
 */
const CONFIRMATION_SAID: Record<string, string> = {
  in: "✓ You said you'll be there",
  maybe: "~ You said you are not sure",
  out: "✕ You said you cannot make it",
};

export function confirmationSaid(state: string | null | undefined): string | null {
  if (!state) return null;
  return CONFIRMATION_SAID[state] ?? null;
}

/** The colour that answer carries, matching `availabilityTone`'s three. */
export function confirmationTone(state: string | null | undefined): string {
  if (state === "in") return "text-success";
  if (state === "maybe") return "text-union";
  if (state === "out") return "text-flare";
  return "text-muted";
}

/**
 * The answer as a manager's badge — three states, three tones.
 *
 * It used to read `Confirmed {state}` on a success-or-flare tone, which gave
 * "Confirmed out" for somebody who had said the opposite of confirming, and
 * had no tone left for a third answer: `maybe` would have been painted as a
 * refusal. So the words say what the member said and `maybe` takes union
 * blue, the tone this site already uses for "needs you to look at it" —
 * the unresolved ones are the admin's to resolve (UC-13 extensions E4).
 */
const CONFIRMATION_BADGE: Record<string, { tone: "success" | "union" | "flare"; label: string }> = {
  in: { tone: "success", label: "Coming" },
  maybe: { tone: "union", label: "Not sure" },
  out: { tone: "flare", label: "Not coming" },
};

export function confirmationBadge(
  state: string | null | undefined
): { tone: "success" | "union" | "flare"; label: string } | null {
  if (!state) return null;
  return CONFIRMATION_BADGE[state] ?? null;
}
