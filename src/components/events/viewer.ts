/**
 * The one thing every event surface has to answer: **what does this particular
 * viewer press?**
 *
 * The hub's next-up card, the events list and the event page's header all show
 * the same call to action, and it depends on four things at once — whether
 * anyone is signed in, whether this event is taking applications, whether this
 * member already has an application, and whether they clear the rank gate. Three
 * hand-written versions of that would be three versions that disagree the week
 * somebody withdraws.
 *
 * So it is one pure function over answers other modules already computed:
 * `applicationsOpen()` decides whether it is open and why not, `eligibility()`
 * decides whether this member may enter, and this decides what the button says.
 * No new rules — if this file ever needs to know a deadline, something has been
 * put in the wrong place.
 */

import type { ApplicationStatus } from "@/db/schema";
import type { ApplicationsState, Eligibility } from "@/lib/events-policy";
import { applicationsPill } from "./labels";

export type ViewerActionKind =
  /** Applications are open and there is a seat. */
  | "apply"
  /** Open, but the seats are gone — applying joins the queue (§14). */
  | "waitlist"
  /** They withdrew earlier and may come back. */
  | "reapply"
  /** Nobody is signed in. */
  | "signin"
  /** Signed in, open, but below the event's entry rank (§8.3). */
  | "blocked"
  /** They hold a seat. */
  | "accepted"
  /** They are in the queue. */
  | "queued"
  /** An admin decided against them. */
  | "declined"
  /** Nothing to press: closed, cancelled, not open yet, finished. */
  | "closed";

export type ViewerAction = {
  kind: ViewerActionKind;
  /** The button's words — or the headline, when `href` is null. */
  label: string;
  /** Null when there is nothing to press. */
  href: string | null;
  /** One sentence under it. Always says *why*. */
  detail: string;
  tone: "gold" | "signal" | "muted" | "ember";
  /** True for the one action a viewer is being invited to take. */
  primary: boolean;
};

export type ViewerApplication = {
  status: ApplicationStatus;
  waitlistPosition: number | null;
};

export type ViewerActionInput = {
  /** The event's slug, for the links this builds. */
  slug: string;
  signedIn: boolean;
  state: ApplicationsState;
  /** This viewer's application, if they have one. */
  application?: ViewerApplication | null;
  /** Their rank check for this event. Absent when signed out. */
  eligibility?: Eligibility | null;
};

/**
 * What this viewer's primary action is, and the sentence that goes under it.
 *
 * The order of the checks is the interesting part:
 *
 *  1. **A live application wins over everything.** Somebody who is already in
 *     must not be shown an Apply button because the signup window happens to
 *     still be open, and somebody at #3 in the queue wants to be told that
 *     rather than invited to apply again.
 *  2. **Then the clock.** A closed event says which kind of closed it is —
 *     "opens later" and "signups closed" are different pieces of news, and
 *     `applicationsPill` already spells both.
 *  3. **Then who they are.** Signed out gets an invitation to sign in, not a
 *     dead Apply button; below the rank gate gets told *before* filling
 *     anything in, which is the friction §8.3 exists to remove.
 *  4. **Only then** the difference between a seat and a queue.
 *
 * A `withdrawn` application is deliberately treated as no application: §14
 * allows re-applying, and `applyToEvent` reuses the row.
 */
export function viewerAction(input: ViewerActionInput): ViewerAction {
  const { slug, signedIn, state, application, eligibility } = input;
  const applyHref = `/events/${slug}/apply`;

  if (application && application.status === "accepted") {
    return {
      kind: "accepted",
      label: "You're in",
      href: "/me/events",
      detail: "You have a seat. Set your availability and confirm under My events.",
      tone: "signal",
      primary: false,
    };
  }

  if (application && application.status === "waitlisted") {
    const place = application.waitlistPosition;
    return {
      kind: "queued",
      label: place === null ? "You're in the queue" : `You're #${place} in the queue`,
      href: "/me/events",
      detail: "If somebody drops out you move up automatically — nothing to do but wait.",
      tone: "gold",
      primary: false,
    };
  }

  if (application && application.status === "declined") {
    return {
      kind: "declined",
      label: "Application declined",
      href: null,
      detail: "An admin decided this one. Have a word with them if that looks wrong.",
      tone: "ember",
      primary: false,
    };
  }

  if (!state.open) {
    return {
      kind: "closed",
      label: applicationsPill(state).label,
      href: null,
      detail: state.message,
      tone: state.reason === "cancelled" ? "ember" : "muted",
      primary: false,
    };
  }

  if (!signedIn) {
    return {
      kind: "signin",
      label: "Sign in to apply",
      href: "/signin",
      detail: state.willWaitlist
        ? "The seats are gone, but you can still join the waitlist once you're signed in."
        : "Applications are open. Sign in with Discord and it takes three taps.",
      tone: "gold",
      primary: true,
    };
  }

  if (eligibility && !eligibility.canEnter) {
    return {
      kind: "blocked",
      label: "Check your profile",
      href: "/me/profile",
      // The sentence the gate itself wrote — "you need Platinum III, you are
      // Gold I" — said here rather than after a form has been filled in.
      detail: eligibility.enterReason,
      tone: "ember",
      primary: false,
    };
  }

  if (application && application.status === "withdrawn") {
    return {
      kind: "reapply",
      label: state.willWaitlist ? "Apply again — waitlist" : "Apply again",
      href: applyHref,
      detail: "You withdrew from this one. Applying again puts you at the back of the queue.",
      tone: "gold",
      primary: true,
    };
  }

  if (state.willWaitlist) {
    return {
      kind: "waitlist",
      label: "Join the waitlist",
      href: applyHref,
      detail: state.message,
      tone: "gold",
      primary: true,
    };
  }

  return {
    kind: "apply",
    label: "Apply",
    href: applyHref,
    detail: state.message,
    tone: "gold",
    primary: true,
  };
}
