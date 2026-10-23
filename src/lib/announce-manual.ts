/**
 * Posting one of an event's announcements **by hand** (R-221, R-222, R-223 /
 * UC-43).
 *
 * ## Why this is a module of its own
 *
 * The same shape `./announce-schedule` has, for the same reason: `./announce`
 * decides what a message *says*, `./discord` is the only thing that talks to
 * Discord, and the decision of **whether a kind may be posted at all** belongs
 * beside neither. It is also the half that has to be readable from the screen,
 * and the screen is a `"use client"` module — so every value here is pure and
 * nothing in this file imports the database.
 *
 * That last point is load-bearing rather than tidy. `src/lib/discord.ts` reaches
 * Postgres, so a client component importing a function from it would drag
 * Drizzle and PGlite into the browser bundle; and the mirror of that mistake —
 * a server component calling a function that lives in a `"use client"` module —
 * is a *runtime* failure on the deployed page that nothing in this repo's guards
 * can see. `src/components/admin/announcement-posting.ts` exists because that
 * one has already happened here. So the sentences both sides need live in this
 * file, which has no directive and no database.
 *
 * ## The five, and why the other five are not here
 *
 * An announcement can be posted by hand only if it is *about an event*, because
 * an event id is the only thing a button on an event screen has to post with.
 * Five of the ten announcers take exactly that (`announceEventPublished`,
 * the three the clock posts, and `announceStandings`). The other five are about
 * one application, one draft lot or one match, and a button that posted
 * "somebody was accepted" would have to ask *which* somebody — which is a
 * different screen and a different feature (R-221).
 *
 * ## What is refused, and what is merely said
 *
 * The two switches a reader expects to be refusals are not:
 *
 *  - **A kind that is switched off still posts** (R-223 / UC-43 2a). The switch
 *    governs what posts *automatically*; pressing a button is an explicit
 *    decision, and refusing would mean switching a setting on for a one-off and
 *    remembering to switch it back. The screen says it is off
 *    ({@link switchedOffNote}) so that is not a surprise.
 *  - **A kind that has already gone out is a warning, not a refusal**
 *    (R-222 / UC-43 3a). The case this whole feature exists for is the one where
 *    it *did* go out and nobody saw it, because Discord was down or the webhook
 *    was wrong. So the screen says **when** it went and asks for confirmation
 *    ({@link alreadyPostedWarning}, {@link manualPostStep}).
 *
 * What is refused is a message that **cannot be built honestly** (UC-43 4a).
 * Every placeholder in `ANNOUNCEMENT_PLACEHOLDERS` that can be missing declares
 * the words it renders as when it is, and two of them — "a time still to be
 * confirmed" and "no closing date" — are the whole content of the announcement
 * that would be posted: a starting-soon reminder for an event with no dated day
 * is a true sentence about nothing. Those are refused by name, so the admin is
 * told what to fill in rather than being handed a message they cannot unsend.
 */

import { ANNOUNCEMENTS, type AnnouncementKind } from "./announce";

/* ------------------------------------------------------------------ */
/* The five                                                           */
/* ------------------------------------------------------------------ */

/**
 * The kinds whose announcer takes an `eventId`, in the order the panel lists
 * them — which is the order they happen in: it goes up, applications open,
 * they close, it starts, the table moves.
 */
export const MANUAL_ANNOUNCEMENT_KINDS = [
  "event_published",
  "signups_open",
  "signups_closing_soon",
  "event_starting_soon",
  "standings_changed",
] as const;

export type ManualAnnouncementKind = (typeof MANUAL_ANNOUNCEMENT_KINDS)[number];

/**
 * Whether a string names one of the five.
 *
 * A server action is a public endpoint (Next's own guidance: treat every one as
 * untrusted), so the kind a button sends is checked rather than trusted. Without
 * this, a crafted call could ask for `application_declined` — whose announcer
 * takes an application id, not an event id — and the action would be building a
 * message about nothing.
 */
export function isManualAnnouncementKind(kind: string): kind is ManualAnnouncementKind {
  return (MANUAL_ANNOUNCEMENT_KINDS as readonly string[]).includes(kind);
}

/**
 * What each one is called on the button and in the sentences.
 *
 * **These are the footer each message actually carries**, not new names: the
 * admin presses "Closing soon" and the channel shows a post footed "Closing
 * soon", so the button and the result say the same word. `ANNOUNCEMENTS[].label`
 * is the *setting's* label — "Applications close tomorrow" — which is a sentence
 * about when it fires automatically and reads wrong on a button that fires now.
 *
 * Written out here rather than read off the builders, because a builder's footer
 * is inside a `DiscordMessage` and reaching it would mean building a message to
 * find out what to call the button. `announce-manual.test.ts` holds this map
 * against the real footers, so a renamed footer fails rather than drifting.
 */
export const MANUAL_ANNOUNCEMENT_NAMES: Record<ManualAnnouncementKind, string> = {
  event_published: "New event",
  signups_open: "Applications open",
  signups_closing_soon: "Closing soon",
  event_starting_soon: "Starting soon",
  standings_changed: "Standings",
};

/** The line under a button, saying what that post would actually contain. */
export function manualAnnouncementDetail(kind: ManualAnnouncementKind): string {
  return ANNOUNCEMENTS.find((spec) => spec.kind === kind)?.detail ?? "";
}

/* ------------------------------------------------------------------ */
/* What may be offered, and what is refused                           */
/* ------------------------------------------------------------------ */

/**
 * As much of an event as a decision about it needs.
 *
 * `startsAt` is the **derived** start — its first dated day's (R-24), which is
 * `readDatesFor`'s answer and not a column: there is no start on the event row
 * to read, and there has not been one since drizzle/0026.
 */
export type ManualAnnouncementFacts = {
  startsAt: Date | null;
  signupClosesAt: Date | null;
  /** Whether this event counts towards a championship at all. */
  inChampionship: boolean;
};

/**
 * Which of the five this event is offered (UC-43 2b).
 *
 * `standings_changed` is **absent** for an event that counts towards no
 * championship, rather than offered and then refused, and the difference is the
 * point: there is no table for it to be about, so there is nothing an admin
 * could fill in to make the button work. An offered-then-refused button says
 * "you have got something wrong"; an absent one says "this does not apply
 * here", which is true.
 *
 * The other four are offered on every event, including a draft. A draft's
 * published announcement is the one case worth naming: posting it does not
 * publish the event, and `announceEventPublished` would refuse to build it —
 * but *this* path builds the message from the event as it stands rather than
 * from a status change, so the only thing that stops it is the webhook and the
 * admin's own judgement.
 */
export function offeredManualKinds(
  facts: Pick<ManualAnnouncementFacts, "inChampionship">
): readonly ManualAnnouncementKind[] {
  return MANUAL_ANNOUNCEMENT_KINDS.filter(
    (kind) => kind !== "standings_changed" || facts.inChampionship
  );
}

/**
 * The sentences a refusal is made of.
 *
 * Constants rather than inline strings for the reason `CLOSING_SOON_FULLNESS`
 * is: they are asserted whole, in one place, by tests that would otherwise be
 * asserting a substring of whatever the code happens to say. A refusal that
 * reads almost right is the failure mode here — Task 78 had a test satisfied by
 * a *different* refusal containing the same phrase — so each of these is a
 * complete sentence, distinct from every other, and names the thing to fill in.
 */
export const MANUAL_REFUSALS = {
  /** UC-43 3b. Nothing is configured to post to, so nothing would happen. */
  noWebhook:
    "No Discord webhook is configured, so nothing would be posted. Set one on the Settings screen first.",
  /** UC-43 4a. `{starts}` would render as "a time still to be confirmed". */
  noDatedDay:
    "This event has no dated day, so there is no start time to announce. Give it a day on the Days tab first.",
  /** UC-43 4a. `{closes}` would render as "no closing date". */
  noClosingTime:
    "This event has no closing time, so there is nothing to count down to. Set one on the Setup tab first.",
  /** UC-43 2b, for the endpoint rather than the screen — see `offeredManualKinds`. */
  noChampionship:
    "This event counts towards no championship, so there is no table to announce.",
  /**
   * The three a standings post discovers only once the season is read, in the
   * order {@link offeredManualKinds}' comment cannot see them: a hidden season
   * is an admin's draft (R-189) and announcing it is the loudest possible way to
   * publish something nobody published; an event with no finishing order has not
   * counted towards the table yet (`seasonPage`); and a season nobody has scored
   * in has no top three to post.
   */
  seasonNotPublished:
    "The season this event counts towards is not published yet, so its table is not public. Publish the season first.",
  noFinishingOrder:
    "This event has no finishing order recorded, so it has not counted towards the table yet. Record one on the Championship tab first.",
  noStandings: "This season has no standings yet, so there is no top of the table to post.",
  /** The event was deleted between the page render and the button. */
  noEvent: "That event no longer exists.",
  /** A kind the five do not include — see `isManualAnnouncementKind`. */
  notManual: "That is not an announcement this screen can post.",
} as const;

/**
 * Why this kind cannot be posted for this event, or null (UC-43 4a).
 *
 * Only the refusals that are decidable from the facts a screen already has.
 * The three standings ones above are decided at post time, where the season has
 * actually been read, and the webhook is a fact about the install rather than
 * about the event — see {@link manualPostStep}.
 */
export function manualPostRefusal(
  kind: ManualAnnouncementKind,
  facts: ManualAnnouncementFacts
): string | null {
  if (kind === "event_starting_soon" && !facts.startsAt) return MANUAL_REFUSALS.noDatedDay;
  if (kind === "signups_closing_soon" && !facts.signupClosesAt) {
    return MANUAL_REFUSALS.noClosingTime;
  }
  if (kind === "standings_changed" && !facts.inChampionship) {
    return MANUAL_REFUSALS.noChampionship;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* What the screen says                                               */
/* ------------------------------------------------------------------ */

/** R-223 / UC-43 2a. Said on the screen so a post from an off kind is no surprise. */
export function switchedOffNote(kind: ManualAnnouncementKind): string {
  return `“${MANUAL_ANNOUNCEMENT_NAMES[kind]}” is switched off, so nothing posts it on its own. This button posts it anyway.`;
}

/**
 * R-222 / UC-43 3a. Says **when** it went, and asks rather than refusing.
 *
 * Takes the instant already rendered, rather than a `Date`, so the sentence is
 * a pure function of two strings and can be asserted whole. The reader's own
 * zone is the browser's to decide (`whenText`), and a server that formatted the
 * date here would be choosing somebody else's clock for them.
 */
export function alreadyPostedWarning(kind: ManualAnnouncementKind, when: string): string {
  return `The “${MANUAL_ANNOUNCEMENT_NAMES[kind]}” announcement for this event already went out: ${when}. Post it again?`;
}

/** What pressing a kind's button does next. */
export type ManualPostStep =
  /** Nothing is posted: there is no webhook, or the message cannot be built. */
  | "refused"
  /** It has gone out before, so say when and ask (R-222 / UC-43 3a). */
  | "confirm"
  /** Post it. */
  | "post";

/**
 * The screen's one decision, as a function.
 *
 * Extracted because the state it decides between is only reachable by *clicking*
 * — and this suite renders to static markup in a node environment, with no DOM
 * and nothing to click with. A test that mimed a click would be a test that
 * looks like it exercises the confirm flow and does not, so the decision is
 * taken out of the handler and asserted directly, and the handler does nothing
 * but call this.
 *
 * `webhook` first, because an install with nowhere to post must not be asked to
 * confirm a repost that could not happen either way.
 */
export function manualPostStep(
  row: { refusal: string | null; postedAt: Date | null },
  options: { webhook: boolean; confirmed: boolean }
): ManualPostStep {
  if (!options.webhook || row.refusal) return "refused";
  if (row.postedAt && !options.confirmed) return "confirm";
  return "post";
}

/** The sentence the screen shows when a post went out. */
export function postedNote(kind: ManualAnnouncementKind, claimed: boolean): string {
  return claimed
    ? `Posted. “${MANUAL_ANNOUNCEMENT_NAMES[kind]}” is in the channel, and the scheduler will not post it again.`
    : `Posted. “${MANUAL_ANNOUNCEMENT_NAMES[kind]}” is in the channel.`;
}

/**
 * The sentence the screen shows when Discord refused it (UC-43 5a).
 *
 * It says what happened and where the record is, and it does **not** say
 * posted — a screen that reported success for a post the channel never got is
 * the one outcome this flow must not have.
 */
export function failedNote(reason: string): string {
  return `Discord refused the post: ${reason} Nothing reached the channel, and the failure is in the audit log.`;
}

/**
 * The audit log's sentence for a manual post (UC-43 5).
 *
 * It names **who** in the sentence as well as in the row's actor columns, the
 * way `event.reopened` does and for the same reason: the log is read by
 * scanning summaries, and "by hand" without a name beside it is the half of the
 * line somebody is actually asking about.
 */
export function manualPostSummary(
  kind: ManualAnnouncementKind,
  title: string,
  who: string
): string {
  return `${who} posted the “${MANUAL_ANNOUNCEMENT_NAMES[kind]}” announcement for “${title}” by hand.`;
}
