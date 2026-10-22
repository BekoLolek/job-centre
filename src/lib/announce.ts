/**
 * What the Discord announcements *say* — and nothing about sending them
 * (docs/platform-plan.md §14, checklist.md F2).
 *
 * Every function here is pure: plain data in, a webhook payload out. That is
 * the whole reason the module exists separately from `./discord`, which does
 * the `fetch`. A message is the part with the interesting decisions in it —
 * which sentence a waitlisted applicant gets, whether a 0-cost lot says "for
 * nothing", what a 3–0 sweep reads like — and those are worth a test each.
 * Sending is the part that must not be tested against a real host, so it lives
 * behind one function in one other file.
 *
 * ## Which announcements exist, and which fire
 *
 * §14 names three; Phase 5 adds the draft sale, because a lot settling is the
 * single most-watched moment the community has, and a decline is announceable
 * too, though nobody gets it unless an admin asks. Which of them actually post
 * is an **admin setting** (`SETTING_KEYS.announcements`), read through
 * `announcementSettingsFrom`, which supplies a default for anything the stored
 * object does not mention. That is what let a seventh kind ship without a
 * migration and without a deployment silently starting to post something nobody
 * asked for.
 *
 * ## `signups_open` has no trigger yet, and that is recorded rather than hidden
 *
 * The eighth kind (R-205 / UC-38 2) is wording, vocabulary and a switch, and
 * **nothing in the site posts it**. That is not an oversight, and a reader
 * about to wire one up should know why before choosing a call site.
 *
 * Applications opening is a *clock* event. The site has exactly one thing that
 * watches a clock — `/api/cron/reminders` — and the other moments it has to
 * watch (UC-38 3, 4) are Task 63's, together with the look-ahead-and-claim
 * shape that makes a second run inside one window post nothing (UC-38 5a, 5b).
 * Posting this kind from anywhere a request happens to reach instead would be a
 * second scheduler with worse properties: a page view cannot be relied on to
 * happen, and an announcement that fires because somebody loaded a page is one
 * that arrives twice on a busy evening and never on a quiet one.
 *
 * The one moment a request *can* observe is publication, and there the question
 * is not "post it" but "is this the same moment" —
 * {@link publishingOpensSignups}, which is UC-38 2a and is why an event already
 * open when it goes up posts one announcement rather than two.
 *
 * ## Mentions (R-202 / UC-37 4c, and the mention Constraint in
 * docs/requirements.md)
 *
 * A payload with no mention chosen carries `allowed_mentions: { parse: [] }`
 * and no `content` at all — byte for byte what this module has always sent.
 * The reason that was the only shape for so long is still true and is still the
 * thing every line below is arranged around: **a member's display name is under
 * their control**, and a display name of `@everyone` that pings a server of
 * four hundred people because the site pasted it into a message is exactly the
 * sort of thing a webhook integration does once and is switched off for.
 *
 * An admin may now ask for a mention, and that hole stays closed, because of
 * how the two halves of a payload are kept apart:
 *
 *  1. **Every interpolated value stays in the embed.** A title, a display name,
 *     a team name, a season name — all of it goes into `embeds[0]`, and none of
 *     it is ever concatenated into `content`. See `mentionLine`, which reads
 *     nothing but the stored mention choice.
 *  2. **`content` is built solely from the stored template**: `@everyone` when
 *     the admin asked for it, and `<@&id>` per role id they picked. Nothing a
 *     member can type reaches it.
 *  3. **`allowed_mentions` is an allow-list of exact ids**, never
 *     `parse: ["roles"]`. A role id that appears anywhere other than the
 *     admin's own choice — in a display name, say — is not in the list, so it
 *     cannot ping. `everyone` is permitted only when the stored template itself
 *     contains it.
 *
 * Points 2 and 3 are each sufficient on their own, and that is deliberate:
 * either one alone closes the hole, so a mistake in one is not a ping.
 *
 * ## What Discord actually promises here, which is less than is often claimed
 *
 * The received wisdom is that Discord "does not parse mentions inside embeds at
 * all", and the observed behaviour does match that. But the API reference does
 * **not** say it. What it says is that `parse` is "an array of allowed mention
 * types to parse from the content", and that `allowed_mentions` governs
 * mentions "in the message content, or the content of components attached to
 * that message". Embeds are simply never named. So "embeds are inert" is an
 * undocumented behaviour, and this module does not rest on it: point 3 above is
 * what actually holds, and it holds whether or not an embed is ever parsed.
 * Were Discord to start parsing embeds tomorrow, a display name of `@everyone`
 * still could not ping, because `parse` does not contain `everyone` unless the
 * admin's own template asked for it.
 *
 * The other documented fact that shapes `allowedMentionsFor`: the reference
 * says "the `parse` field is **mutually exclusive** with the other fields", and
 * then gives `{ parse: ["everyone"], users: ["1234", "5678"] }` as a *valid*
 * example while calling `{ parse: ["users"], users: [...] }` a validation
 * error. So the exclusivity is per mention *type*, not blanket, and the
 * boundary is not stated anywhere. This module therefore never names a type in
 * both places: `parse` carries at most `everyone`, the id list carries only
 * roles, and no payload it builds matches the combination the reference calls
 * invalid.
 */

import type { SettingValue } from "@/db/schema";
import type { TopOfTable } from "./championship-policy";
// The bracket's ordinal, again. `./format-policy` imports nothing, so this
// module stays what its comment says it is: data in, a payload out.
import { ordinal } from "./format-policy";

/* ------------------------------------------------------------------ */
/* The kinds                                                          */
/* ------------------------------------------------------------------ */

export type AnnouncementKind =
  /** An event went from draft to published — the one that brings people in. */
  | "event_published"
  /**
   * Applications actually opened (R-205 / UC-38 2).
   *
   * A different moment from publishing whenever an event goes up ahead of its
   * signup window — and the *same* moment when it does not, which is UC-38 2a
   * and is decided by {@link publishingOpensSignups} rather than by two
   * announcers racing each other by a second.
   */
  | "signups_open"
  /** An application was accepted. */
  | "application_accepted"
  /** An application was waitlisted. */
  | "application_waitlisted"
  /** An application was declined. */
  | "application_declined"
  /** A draft lot settled with a winner and a price. */
  | "draft_lot_sold"
  /** A series was decided. */
  | "match_result"
  /** A counting event was scored and the championship table moved. */
  | "standings_changed";

export type AnnouncementSpec = {
  kind: AnnouncementKind;
  /** The toggle's label on the admin screen. */
  label: string;
  /** The line under it, saying what a member would actually see. */
  detail: string;
  /** Whether it fires when the admin has never touched the setting. */
  fallback: boolean;
};

/**
 * Every kind, in the order the settings screen lists them, with their defaults.
 *
 * "Sensible" here means: the ones that are *news* are on, and three are off —
 * the two that are a consolation, plus the one that says again what a message
 * already sent says. A published event and a settled lot are things people want
 * pinged about; being told, in public, that four hundred applications were each
 * waitlisted is a channel nobody reads twice, and a table that moved because of
 * a result already announced is the same night posted twice (see
 * `standings_changed` below). Accepted stays on because
 * the accepted list is already on the public event page — announcing it tells
 * people something they could look up, which is the test for whether an
 * announcement is safe.
 */
export const ANNOUNCEMENTS: readonly AnnouncementSpec[] = [
  {
    kind: "event_published",
    label: "An event is published",
    detail: "Posts the title, the dates and how many places there are, with a link to apply.",
    fallback: true,
  },
  {
    kind: "signups_open",
    label: "Applications open",
    detail:
      "Posts when applications actually open, for an event that went up ahead of its signup window. An event already open when it was published posts only the published announcement.",
    /*
     * Off, like `standings_changed` below and for the same reason — the one in
     * the module comment rather than the "consolation" rule. This is a brand
     * new kind arriving on installs that already have a webhook, and a kind
     * that ships with its switch on is a deployment silently starting to post
     * something nobody asked for. An admin who published an event a week ahead
     * of its window *wants* this; an admin who always publishes into an open
     * window would get a message that never fires, and neither of them asked.
     *
     * It is also the honest default while nothing fires it: see the module
     * comment on the trigger, which is Task 63's scheduler.
     */
    fallback: false,
  },
  {
    kind: "application_accepted",
    label: "Somebody is accepted",
    detail: "Names the member and the event. The accepted list is already on the event page.",
    fallback: true,
  },
  {
    kind: "application_waitlisted",
    label: "Somebody is waitlisted",
    detail: "Names the member and their place in the queue. Off by default — a full event posts one of these per applicant.",
    fallback: false,
  },
  {
    kind: "application_declined",
    label: "Somebody is declined",
    detail: "Names the member and the event. Off by default — being turned down is somebody's afternoon, not the channel's news.",
    fallback: false,
  },
  {
    kind: "draft_lot_sold",
    label: "A draft lot sells",
    detail: "The player, the team and the price, as the room sees it.",
    fallback: true,
  },
  {
    kind: "match_result",
    label: "A result is recorded",
    detail: "Posts only when a series is actually decided, never on a part-recorded card.",
    fallback: true,
  },
  {
    kind: "standings_changed",
    label: "The championship table moves",
    detail:
      "Posts the top three after a counting event is scored, and says whether the lead changed hands. Off by default — a season that also announces its results posts twice a night until somebody asks for both.",
    /*
     * Off, unlike the other four pieces of news, and for the reason this
     * whole object exists (see the module comment): a kind that ships with its
     * switch on is a deployment that silently starts posting something nobody
     * asked for. `match_result` already posts when a series is decided, so on
     * an install that runs brackets this is the second message about the same
     * night — which is a choice an admin should make rather than inherit.
     */
    fallback: false,
  },
] as const;

export type AnnouncementSettings = Record<AnnouncementKind, boolean>;

/** The defaults, as a whole object. */
export function defaultAnnouncementSettings(): AnnouncementSettings {
  const out = {} as AnnouncementSettings;
  for (const spec of ANNOUNCEMENTS) out[spec.kind] = spec.fallback;
  return out;
}

/**
 * Read the stored setting into a complete object.
 *
 * Anything that is not a boolean is treated as "not said" and falls back to the
 * default — including the whole setting being absent, being a string, or naming
 * a kind that no longer exists. A settings row is written by an older version of
 * this screen more often than anybody expects, and a reader that trusts its
 * shape is a reader that crashes the admin page one deploy later.
 */
export function announcementSettingsFrom(stored: unknown): AnnouncementSettings {
  const out = defaultAnnouncementSettings();
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return out;
  const raw = stored as Record<string, unknown>;
  for (const spec of ANNOUNCEMENTS) {
    const value = raw[spec.kind];
    if (typeof value === "boolean") out[spec.kind] = value;
  }
  return out;
}

/** Narrow a settings object back to something the `settings` table can hold. */
export function announcementSettingsValue(settings: AnnouncementSettings): SettingValue {
  const out: Record<string, SettingValue> = {};
  for (const spec of ANNOUNCEMENTS) out[spec.kind] = settings[spec.kind];
  return out;
}

/** Keep only the kinds that exist, and only the booleans. */
export function normaliseAnnouncementSettings(patch: unknown): AnnouncementSettings {
  return announcementSettingsFrom(patch);
}

/* ------------------------------------------------------------------ */
/* The wording, as data (R-201 / UC-37)                               */
/* ------------------------------------------------------------------ */

/**
 * One placeholder a kind offers, and everything a screen needs to say about it.
 *
 * `example` is for the preview an admin sees before saving (UC-37 5a): a
 * placeholder with no value on the event being previewed shows this instead,
 * marked as an example by the screen rather than by this string.
 *
 * `whenAbsent` is the other half, and the more important one — it is what gets
 * **posted** when the value is genuinely missing on the night. It is never the
 * empty string, and that is the whole point: a wording that silently renders a
 * placeholder as nothing is a mistake found in the channel by four hundred
 * people, which is the same argument that makes an unoffered placeholder a
 * refusal below. A placeholder with no `whenAbsent` is one the kind always has
 * a value for.
 */
export type Placeholder = {
  /** Written `{name}` in a wording. */
  name: string;
  /** The line beside it on the settings screen. */
  describe: string;
  /** Shown in a preview when the thing being previewed has no value. */
  example: string;
  /** Posted when the value is missing for real. Absent means it never is. */
  whenAbsent?: string;
};

/**
 * What each kind offers — **and only what that kind actually has.**
 *
 * This is the table a save is checked against, and the reason it is a table
 * rather than one shared list: `{position}` is a fact about a waitlisting and
 * about nothing else, and `{winner}` is a fact about a series. A wording that
 * reaches for `{captain}` on a lot selling, or `{position}` on an acceptance,
 * is refused by name at save time (`announcementTemplateProblem`) instead of
 * rendering as a hole in a message nobody can unsend.
 *
 * Every entry is derivable from the input the kind's builder below already
 * receives. Nothing here needs a new read, a new argument or a changed call
 * site — which is what keeps Task 59 inside this file and `src/lib/discord.ts`.
 *
 * **There is deliberately no `{link}`.** The link is not wording: it is the
 * embed's `url`, which is how every one of these messages has always linked,
 * and it goes on being that whether or not the wording is edited. A `{link}`
 * placeholder would also be the one value with no honest `whenAbsent` — an
 * install that has never set a site origin has no URL to render, and "the
 * event page" is a sentence this module would be inventing.
 */
export const ANNOUNCEMENT_PLACEHOLDERS: Readonly<Record<AnnouncementKind, readonly Placeholder[]>> =
  {
    event_published: [
      { name: "title", describe: "The event's title", example: "Friday REPO night" },
      {
        name: "places",
        describe: "How many seats there are, or “No limit”",
        example: "12",
      },
      {
        name: "starts",
        describe: "When it starts, in each reader's own timezone",
        example: "<t:1800000000:F>",
        // An event with no dated day has no start to render (R-24). The
        // compiled copy drops the field; a wording cannot drop a sentence.
        whenAbsent: "a time still to be confirmed",
      },
      {
        name: "closes",
        describe: "When applications close, as a countdown",
        example: "<t:1800000000:R>",
        whenAbsent: "no closing date",
      },
    ],
    /*
     * The same four facts as `event_published`, because it is the same event
     * and a reader deciding whether to apply needs the same things — when it
     * is on, when applications shut, and how many seats there are. Written out
     * rather than shared with `event_published`, for the reason this is a table
     * at all: two kinds happening to offer the same vocabulary today is not a
     * promise that they always will, and the next fact either one gains would
     * silently appear on the other.
     *
     * No `{opens}`. By the time this posts, "when do applications open" is
     * "now", and a placeholder whose only honest rendering is the present
     * instant would be a formatted date on the server — the one thing this
     * module never emits (see `stamp`).
     */
    signups_open: [
      { name: "title", describe: "The event's title", example: "Friday REPO night" },
      {
        name: "places",
        describe: "How many seats there are, or “No limit”",
        example: "12",
      },
      {
        name: "starts",
        describe: "When it starts, in each reader's own timezone",
        example: "<t:1800000000:F>",
        // An event with no dated day has no start to render (R-24), exactly as
        // for `event_published`.
        whenAbsent: "a time still to be confirmed",
      },
      {
        name: "closes",
        describe: "When applications close, as a countdown",
        example: "<t:1800000000:R>",
        whenAbsent: "no closing date",
      },
    ],
    application_accepted: [
      { name: "member", describe: "The member's display name", example: "Beko Lolek" },
      { name: "event", describe: "The event's title", example: "Friday REPO night" },
    ],
    application_waitlisted: [
      { name: "member", describe: "The member's display name", example: "Beko Lolek" },
      { name: "event", describe: "The event's title", example: "Friday REPO night" },
      {
        name: "position",
        describe: "Their place in the queue, 1 being the front",
        example: "3",
        // The one kind that has it, which is the point of this table.
        whenAbsent: "a place not yet numbered",
      },
    ],
    application_declined: [
      { name: "member", describe: "The member's display name", example: "Beko Lolek" },
      { name: "event", describe: "The event's title", example: "Friday REPO night" },
    ],
    draft_lot_sold: [
      { name: "player", describe: "The player who went under the hammer", example: "Beko Lolek" },
      { name: "team", describe: "The team that bought them", example: "Rivals Red" },
      {
        name: "price",
        describe: "What they went for, or “nothing” at a price of nought",
        example: "1,200",
      },
      { name: "event", describe: "The event's title", example: "Friday REPO night" },
    ],
    match_result: [
      { name: "teamA", describe: "The team listed first", example: "Rivals Red" },
      { name: "teamB", describe: "The team listed second", example: "Rivals Blue" },
      { name: "score", describe: "The games won, as a scoreline", example: "2–1" },
      {
        name: "winner",
        describe: "Who took the series",
        example: "Rivals Red",
        // A drawn series an admin still has to call (`matchResultMessage`).
        whenAbsent: "nobody yet",
      },
      {
        name: "match",
        describe: "The round, as the board labels it",
        example: "Upper semi-final",
        whenAbsent: "this round",
      },
      { name: "event", describe: "The event's title", example: "Friday REPO night" },
    ],
    standings_changed: [
      { name: "season", describe: "The season's name", example: "Spring 2026" },
      { name: "event", describe: "The event that was just scored", example: "Friday REPO night" },
      {
        name: "leader",
        describe: "Who is top, both names when they are level",
        example: "Beko Lolek",
        // A season with nobody in it; `standingsMessage` has the same case.
        whenAbsent: "nobody",
      },
    ],
  };

/** The placeholder names one kind offers, for a message or a screen. */
export function placeholdersFor(kind: AnnouncementKind): readonly Placeholder[] {
  return ANNOUNCEMENT_PLACEHOLDERS[kind] ?? [];
}

/**
 * Discord's own per-field limits, as the API reference states them.
 *
 * The `clamp()` calls further down already respect these for the compiled
 * copy; an edited wording has to respect them too, and UC-37 3c says that is a
 * refusal *before* saving rather than a post that silently vanishes. Both
 * numbers are therefore used twice: once by `announcementTemplateProblem`, to
 * refuse, and once at render, where `clamp` stays as the belt-and-braces it
 * already was. A refusal at save means the clamp never actually bites — but a
 * row written by an older version of the screen, or by hand, must still not be
 * able to produce a message Discord drops on the floor.
 */
export const DISCORD_LIMITS = {
  /** An embed description. */
  description: 4096,
  /** The `content` the mention line goes in. */
  content: 2000,
} as const;

/**
 * A role id, as Discord mints them.
 *
 * Snowflakes are decimal digits and nothing else, and this is checked **twice**
 * on purpose: once when a mention choice is saved, and again in `mentionLine`
 * when one is rendered. The second check is the one that matters, because it is
 * the only thing standing between a stored value and the `content` field — and
 * the whole security argument of this module is that `content` holds nothing
 * but digits wrapped in `<@&…>`. A row written by an older screen, a hand-run
 * UPDATE or a future bug cannot smuggle text into a mention line past it.
 *
 * 17 to 20 digits covers every snowflake Discord has issued or will issue for
 * decades; the lower bound is what stops `"1"` being accepted as an id.
 */
const ROLE_ID = /^[0-9]{17,20}$/;

/** Who an announcement mentions. Built by an admin, never from member data. */
export type AnnouncementMention = {
  /** Pings the whole server. Audited when it is set (UC-37 4c). */
  everyone: boolean;
  /** Discord role ids — ids, never names: `@RoleName` is inert on Discord. */
  roleIds: readonly string[];
};

/**
 * An admin's override for one kind.
 *
 * `body` is **nullable, and null is not the same as absent**. The absence of a
 * whole row means "nobody has touched this kind": no wording of their own and
 * no mention, so the compiled copy posts exactly what it posts today. A row
 * with a null `body` means an admin chose a *mention* and left the wording
 * alone — and that must keep posting the compiled copy too.
 *
 * The alternative was to make `body` required and have the settings screen
 * pre-fill it with the current wording, so that choosing a mention saved a copy
 * of the compiled sentence. That is the trap this module's whole existence is a
 * reaction to (see `announcementSettingsFrom`): the compiled copy is not one
 * sentence per kind, it is a *function* — a waitlisting with and without a
 * number, a lot that went for nothing, a drawn series, four different things a
 * moved table can say. Freezing one of those variants into a row because
 * somebody ticked "mention @everyone" is a deployment quietly starting to post
 * something nobody asked for, one kind at a time.
 */
export type AnnouncementTemplate = {
  /** The admin's wording, or null for "they have not edited the wording". */
  body: string | null;
  mention: AnnouncementMention;
};

/** Nobody has touched this kind. The compiled copy, and no mention. */
export const NO_MENTION: AnnouncementMention = { everyone: false, roleIds: [] };

/**
 * Read a stored row into a complete template, the same way
 * `announcementSettingsFrom` reads a stored settings object.
 *
 * Same doctrine, same reason: a row written by an older version of the screen
 * is commoner than anybody expects, and a reader that trusts its shape is a
 * reader that crashes the admin page — or worse, posts something odd — one
 * deploy later. Anything that is not a string is "no wording"; anything that is
 * not an array of snowflakes is "no roles"; anything that is not `true` is "not
 * everyone", so the whole-server ping can only ever come from a real `true`.
 */
export function announcementTemplateFrom(stored: unknown): AnnouncementTemplate {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return { body: null, mention: NO_MENTION };
  }
  const raw = stored as Record<string, unknown>;
  const body = typeof raw.body === "string" && raw.body.trim() !== "" ? raw.body : null;
  const roleIds = Array.isArray(raw.roleIds)
    ? raw.roleIds.filter((id): id is string => typeof id === "string" && ROLE_ID.test(id))
    : [];
  return { body, mention: { everyone: raw.everyone === true, roleIds } };
}

/**
 * The placeholders a wording reaches for.
 *
 * `{word}` and nothing cleverer. A consequence worth stating out loud: an
 * admin cannot write a literal `{word}` in an announcement, because it would be
 * read as a placeholder and refused by name. Braces are not something this
 * community's channel messages have ever contained, and the alternative — an
 * escape — is a syntax to explain on a settings screen in exchange for nothing.
 */
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

function placeholdersIn(body: string): string[] {
  return [...body.matchAll(PLACEHOLDER)].map((match) => match[1]);
}

/** The offered names, as the refusal lists them: `{a}, {b}, {c}`. */
function offeredList(kind: AnnouncementKind): string {
  return placeholdersFor(kind)
    .map((placeholder) => `{${placeholder.name}}`)
    .join(", ");
}

/**
 * Why this wording and mention choice cannot be saved, or `null` when it can.
 *
 * Every refusal UC-37 names, in the order a screen would hit them, and all of
 * them **before** anything is stored:
 *
 *  - **3b** — empty wording. An announcement with no words is the switch being
 *    off, and the switch is a separate control that already exists. (A `null`
 *    body is not empty wording: it is "leave the compiled copy alone", which is
 *    the ordinary state and always allowed.)
 *  - **3a** — a placeholder this kind does not offer, named along with the ones
 *    it does.
 *  - **3c** — longer than Discord accepts, saying the limit, rather than being
 *    discovered later as a post that never appeared.
 *
 * Plus the two the mention line needs, which are not in UC-37 because UC-37
 * describes a role *picker* (R-203, Task 61) rather than the field behind it:
 * an id that is not a snowflake, and a mention line over Discord's `content`
 * limit. A non-snowflake id would render as nothing on Discord — `@RoleName`
 * is inert — so an admin who pastes a role *name* must be told, not left
 * wondering why nobody was notified.
 */
export function announcementTemplateProblem(
  kind: AnnouncementKind,
  template: AnnouncementTemplate
): string | null {
  if (template.body !== null) {
    if (template.body.trim() === "") {
      return "An announcement with no words is the switch being off — use the switch instead.";
    }

    const offered = new Set(placeholdersFor(kind).map((placeholder) => placeholder.name));
    for (const used of placeholdersIn(template.body)) {
      if (!offered.has(used)) {
        const list = offeredList(kind);
        return list
          ? `This announcement has no {${used}}. It offers ${list}.`
          : `This announcement has no {${used}}, and offers no placeholders at all.`;
      }
    }

    const length = template.body.trim().length;
    if (length > DISCORD_LIMITS.description) {
      return `Discord accepts ${DISCORD_LIMITS.description} characters in an announcement; that is ${length}.`;
    }
  }

  for (const id of template.mention.roleIds) {
    if (!ROLE_ID.test(id)) {
      return `“${id}” is not a role id. A role ping needs the id Discord gives the role, not its name.`;
    }
  }

  const line = mentionLine(template.mention);
  if (line.length > DISCORD_LIMITS.content) {
    return `That is more roles than one message can mention (${DISCORD_LIMITS.content} characters).`;
  }

  return null;
}

/**
 * The mention line, which is the entire contents of `content`.
 *
 * Read the module comment before changing a character of this. It takes the
 * stored mention choice and **nothing else**: no argument it could be handed a
 * display name through, no interpolation, no concatenation with anything from
 * the embed. `@everyone` is a literal, and every role is `<@&digits>` with the
 * digits re-checked against {@link ROLE_ID} on the way out.
 *
 * `@everyone` first, then roles in the order the admin picked them, so the same
 * choice always produces the same line.
 */
export function mentionLine(mention: AnnouncementMention): string {
  const parts: string[] = [];
  if (mention.everyone) parts.push("@everyone");
  for (const id of mention.roleIds) {
    if (ROLE_ID.test(id)) parts.push(`<@&${id}>`);
  }
  return parts.join(" ");
}

/**
 * What Discord is allowed to honour — an allow-list of exact ids.
 *
 * **Never `parse: ["roles"]`.** That would allow *any* role id anywhere in the
 * message, which is precisely the hole a display name of `<@&…>` would walk
 * through; naming the ids the template used means a role id appearing anywhere
 * else is inert. `everyone` has no id list in the API, so it can only be
 * allowed through `parse` — and it is only ever put there when the stored
 * template contains `@everyone` itself.
 *
 * On the shape: `parse` carries at most `everyone` and the id list carries only
 * roles, so no type is ever named in both places. See the module comment for
 * why that matters — the reference calls `parse` "mutually exclusive with the
 * other fields" and then shows a valid payload that combines them, so the only
 * safe reading is to never test the boundary.
 *
 * With no mention chosen the answer is `{ parse: [] }` with no `roles` key at
 * all, which is byte for byte what this module sent before R-202 existed.
 */
export function allowedMentionsFor(mention: AnnouncementMention = NO_MENTION): AllowedMentions {
  const roles = mention.roleIds.filter((id) => ROLE_ID.test(id));
  return {
    parse: mention.everyone ? ["everyone"] : [],
    ...(roles.length > 0 ? { roles } : {}),
  };
}

/** Fill a wording's placeholders from the values its kind supplies. */
function render(body: string, values: Readonly<Record<string, string>>): string {
  /*
   * A name with no value here cannot be one the kind does not offer — that is
   * refused at save — so it is one the vocabulary gained or lost between the
   * save and the post. The literal `{name}` is left standing rather than
   * replaced with nothing, for the reason the whole refusal exists: a visible
   * oddity gets fixed, and a silent hole gets read by four hundred people.
   */
  return body.replace(PLACEHOLDER, (whole, name: string) => values[name] ?? whole);
}

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

export type AnnounceEnv = {
  DISCORD_WEBHOOK_URL?: string;
  /** Where the links in a message point. `AUTH_URL` is the one already set. */
  NEXT_PUBLIC_SITE_URL?: string;
  AUTH_URL?: string;
};

/**
 * The webhook an admin set, or the one the deployment was given.
 *
 * Settings first, environment second — the same order and for the same reason
 * as `resolveGateConfig`: a value an admin typed on a screen is a more recent
 * statement of intent than one somebody typed into Vercel months ago, and a
 * database that cannot be read must not take the feature down with it.
 *
 * A stored value that is not a URL falls through to the environment rather
 * than switching announcements off. Silence is the worst possible response to
 * a typo, because nothing is ever going to tell you.
 *
 * `null` — neither says anything usable — is the entire off switch. A value
 * that is not an http(s) URL is treated as unset rather than tried: `fetch` on
 * a nonsense string throws a different error every runtime, and a typo must
 * never become a failed application.
 */
export function resolveWebhookUrl(
  stored: string | null | undefined,
  env: AnnounceEnv = process.env as AnnounceEnv
): string | null {
  return httpUrl(stored) ?? httpUrl(env.DISCORD_WEBHOOK_URL);
}

/**
 * http as well as https, because the local listener the feature is driven
 * against is http — and a webhook that can only be tested against Discord is a
 * webhook nobody tests.
 */
function httpUrl(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The origin the links in a message point at, without a trailing slash, or
 * `null` when nothing says.
 *
 * A message with no links is a smaller message, not a broken one, so an unset
 * origin drops the links rather than emitting `undefined/events/rivals`.
 */
export function siteOrigin(env: AnnounceEnv = process.env as AnnounceEnv): string | null {
  return resolveSiteOrigin(undefined, env);
}

/** The address an admin set, or whatever the deployment happens to know. */
export function resolveSiteOrigin(
  stored: string | null | undefined,
  env: AnnounceEnv = process.env as AnnounceEnv
): string | null {
  const first = httpUrl(stored);
  if (first) return new URL(first).origin;
  const fallback = httpUrl(env.NEXT_PUBLIC_SITE_URL ?? env.AUTH_URL);
  return fallback ? new URL(fallback).origin : null;
}

/**
 * A webhook with its secret half hidden: the id stays, the token goes.
 *
 * Discord webhook URLs end `/api/webhooks/<id>/<token>`, and the token is the
 * whole credential. The screen has to show *something* — "configured" alone
 * cannot tell you whether it is the right channel — so it shows the part that
 * identifies without the part that authorises. Anything that is not a Discord
 * webhook is masked from the last path segment on the same way.
 */
export function maskWebhook(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return `${parsed.origin}/…`;
    const secret = parts[parts.length - 1];
    /*
     * Four characters of a 68-character Discord token identify it without
     * being useful. Four characters of a four-character one *are* it — so
     * anything short enough for the prefix to be a meaningful fraction of the
     * whole is hidden completely. The threshold is what makes this a mask
     * rather than a truncation.
     */
    const shown = secret.length > 16 ? secret.slice(0, 4) : "";
    parts[parts.length - 1] = `${shown}${"•".repeat(12)}`;
    return `${parsed.origin}/${parts.join("/")}`;
  } catch {
    return "•••";
  }
}

/** Join an origin and a path, or give back `null` when there is no origin. */
export function linkTo(path: string, origin: string | null): string | null {
  if (!origin) return null;
  return `${origin}${path.startsWith("/") ? path : `/${path}`}`;
}

/* ------------------------------------------------------------------ */
/* The payload                                                        */
/* ------------------------------------------------------------------ */

/** The subset of Discord's webhook body this site sends. */
export type DiscordEmbed = {
  title: string;
  description?: string;
  url?: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
};

/**
 * What Discord may honour.
 *
 * `parse` carries at most `"everyone"`, and `roles` is an allow-list of exact
 * ids that is absent rather than empty when there are none — so a payload with
 * no mention chosen is `{ parse: [] }` and nothing else, exactly as it was
 * before R-202. `users` is deliberately not in this type: this site has never
 * had a reason to ping an individual, and a field that cannot be set cannot be
 * set wrongly.
 */
export type AllowedMentions = {
  parse: readonly "everyone"[];
  roles?: readonly string[];
};

export type DiscordMessage = {
  username: string;
  /**
   * The mention line, and **only** the mention line (R-202).
   *
   * Absent unless the admin asked for a mention. Nothing interpolated ever
   * reaches this field — see the module comment, and `mentionLine`.
   */
  content?: string;
  embeds: DiscordEmbed[];
  /** An allow-list, never `parse: ["roles"]`. See the module comment. */
  allowed_mentions: AllowedMentions;
};

/** The site's own palette (§5), as Discord's integer colours. */
export const COLOURS = {
  gold: 0xe3b23c,
  signal: 0x3ddc84,
  ember: 0xff4d1c,
  chalk: 0xf1ede4,
} as const;

const USERNAME = "Job Centre Events";

/**
 * An admin's override for the kind being built, and the values its placeholders
 * stand for.
 *
 * `values` is assembled by the builder, because the builder is the only thing
 * that has the input. It is the same data the compiled sentence is made of,
 * which is what makes "the same message, in the admin's words" a true
 * description rather than an aspiration.
 */
type Edit = {
  template: AnnouncementTemplate | null;
  values: Readonly<Record<string, string>>;
};

/**
 * One payload.
 *
 * **With no override — `edit` absent, or its `template` null, or its template's
 * `body` null — this returns the embed object it was handed, untouched, with no
 * `content` key and `allowed_mentions: { parse: [] }`.** That is not "near
 * enough": it is the same object and the same two literals this function has
 * always produced, so an unedited kind posts byte for byte what it posted
 * before Task 59, and the migration needs no backfill because there is nothing
 * for a backfill to reproduce (R-201 / UC-37 2a).
 *
 * The key order matters for that claim, since the payload is serialised with
 * `JSON.stringify`: `content` is inserted between `username` and `embeds` only
 * when there is one, so the no-mention body is unchanged to the byte.
 */
function message(embed: DiscordEmbed, edit?: Edit): DiscordMessage {
  const template = edit?.template ?? null;
  const mention = template?.mention ?? NO_MENTION;
  const content = mentionLine(mention);

  /*
   * The admin's wording replaces the embed's description and nothing else. The
   * title, the fields, the colour, the footer and the link are structure rather
   * than wording — they are what makes the message a Job Centre announcement
   * instead of a line of text — and R-201 asks for the sentence.
   *
   * `clamp` is applied to the rendered result, not to the stored body, and
   * `announcementTemplateProblem` has already refused a body over the limit. So
   * this only ever fires when a long value lands in a body that was close to
   * it, and when it does, a clamped message is strictly better than one Discord
   * drops silently (see `clamp`).
   */
  const described =
    template?.body != null
      ? {
          ...embed,
          description: clamp(
            render(template.body, edit?.values ?? {}),
            DISCORD_LIMITS.description
          ),
        }
      : embed;

  return {
    username: USERNAME,
    ...(content ? { content } : {}),
    embeds: [described],
    allowed_mentions: allowedMentionsFor(mention),
  };
}

/**
 * Discord truncates at 256 characters for a title and 4096 for a description,
 * and silently rejects the whole message when a field is over. An event title
 * is admin-entered and capped at 120 by `events.ts`, so this is belt and
 * braces — but a message that vanishes is indistinguishable from a webhook that
 * is down, and that is the one failure this feature must not have.
 */
function clamp(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/* ------------------------------------------------------------------ */
/* The messages                                                       */
/* ------------------------------------------------------------------ */

export type EventPublishedInput = {
  title: string;
  slug: string;
  type?: string | null;
  description?: string | null;
  /** Null when the event is uncapped. */
  capacity?: number | null;
  /** Rendered as a Discord timestamp so every reader sees their own zone. */
  startsAt?: Date | null;
  signupClosesAt?: Date | null;
  origin?: string | null;
};

/**
 * A Discord `<t:…:F>` stamp — the one way to put a time in a message without
 * choosing somebody's timezone for them.
 *
 * The same rule the whole site runs on (README, "Times"): every instant is
 * stored in UTC and rendered in the reader's own zone. Discord does the
 * rendering here, which is why no message ever contains a formatted date.
 */
export function stamp(at: Date, style: "F" | "R" | "d" = "F"): string {
  return `<t:${Math.floor(at.getTime() / 1000)}:${style}>`;
}

/**
 * A placeholder's value, or the documented thing to post when there is none.
 *
 * One helper rather than a ternary per value, so "absent renders as the
 * declared `whenAbsent`, never as nothing" is one line that can be read and
 * one line that can be broken — and `ANNOUNCEMENT_PLACEHOLDERS` stays the only
 * place those words are written down.
 */
function valueOr(
  kind: AnnouncementKind,
  name: string,
  value: string | null | undefined
): string {
  if (value != null && value !== "") return value;
  const declared = placeholdersFor(kind).find((placeholder) => placeholder.name === name);
  return declared?.whenAbsent ?? "";
}

export function eventPublishedMessage(
  input: EventPublishedInput,
  template: AnnouncementTemplate | null = null
): DiscordMessage {
  const fields: DiscordEmbed["fields"] = [];
  if (input.startsAt) {
    fields.push({ name: "Starts", value: stamp(input.startsAt), inline: true });
  }
  if (input.signupClosesAt) {
    fields.push({
      name: "Applications close",
      value: stamp(input.signupClosesAt, "R"),
      inline: true,
    });
  }
  // One expression, read by the "Places" field and by `{places}`, so an edited
  // wording cannot disagree with the embed beside it about the seat count.
  const places = input.capacity && input.capacity > 0 ? String(input.capacity) : "No limit";
  fields.push({ name: "Places", value: places, inline: true });

  const url = linkTo(`/events/${input.slug}`, input.origin ?? null);

  return message(
    {
      title: clamp(input.title, 240),
      description: input.description
        ? clamp(input.description, 600)
        : "Applications are open — three taps if your profile is filled in.",
      ...(url ? { url } : {}),
      color: COLOURS.gold,
      fields,
      footer: { text: "New event" },
    },
    {
      template,
      values: {
        title: clamp(input.title, 240),
        places,
        // Stamps, never a formatted date: the repo invariant, and the reason
        // an edited wording still renders in each reader's own timezone.
        starts: valueOr(
          "event_published",
          "starts",
          input.startsAt ? stamp(input.startsAt) : null
        ),
        closes: valueOr(
          "event_published",
          "closes",
          input.signupClosesAt ? stamp(input.signupClosesAt, "R") : null
        ),
      },
    }
  );
}

/**
 * Whether publishing this event at `at` is *also* the moment its signups open
 * (R-205 / UC-38 2a).
 *
 * **This is the decision the whole kind is arranged around**, and it is here
 * rather than beside the signup window in `./events-policy` because it is a
 * question about which announcement is due, not about whether a member may
 * apply. `applicationsOpen` is still the authority on "are signups open" — it
 * is the only thing that reads the window against a clock, and `too_early` is
 * the only state it has for "not yet". This answers the narrower question that
 * state implies: is there a *second* moment to announce at all?
 *
 * `true` means there is not, so the published announcement is the only one due.
 * Two cases reach it:
 *
 *  - **`signupOpensAt` is already past.** Publishing and opening are one
 *    moment, and two posts a second apart is what a channel gets muted for.
 *  - **`signupOpensAt` is null.** There is then no instant at which signups
 *    open, because nothing holds them shut: `applicationsOpen` only ever
 *    answers `too_early` when the window has a start. Unreachable through the
 *    publish gate — `missingToPublish` demands both ends of the window — but
 *    this is the right answer rather than a guess, and a status patch is not
 *    obliged to stay inside that gate forever.
 *
 * The comparison is `<=`, matching `applicationsOpen`'s inclusive boundary: an
 * event published at exactly the instant its signups open is open, so it is
 * one moment, not two.
 *
 * **It is also the guard a scheduler needs**, called with `now` instead of the
 * publish instant: `true` then means the moment has gone by (or never existed),
 * which is how UC-38 2a stays satisfied without anybody storing when an event
 * was published — `events` has no `published_at` column, so the publish instant
 * is knowable only while it is happening.
 */
export function publishingOpensSignups(
  window: { signupOpensAt: Date | null },
  at: Date
): boolean {
  const opens = window.signupOpensAt;
  if (!opens) return true;
  return opens.getTime() <= at.getTime();
}

export type SignupsOpenInput = {
  title: string;
  slug: string;
  /** Null when the event is uncapped. */
  capacity?: number | null;
  /** The derived start — its first dated day's (R-24), never a stored column. */
  startsAt?: Date | null;
  signupClosesAt?: Date | null;
  origin?: string | null;
};

/**
 * Applications have opened (R-205 / UC-38 2).
 *
 * The same facts as `eventPublishedMessage` — a reader deciding whether to
 * apply needs the same three — said at the other moment, and told apart from it
 * by the footer and the colour rather than by leaving something out. Green
 * rather than gold, because gold is "here is a new event" and this is "the door
 * is open"; the same reason `application_accepted` is `signal`.
 *
 * Nothing in the site calls this yet, and that is deliberate rather than
 * unfinished: the only moment a request can observe is publication, and at
 * publication the answer is {@link publishingOpensSignups}. An event published
 * ahead of its window opens on the clock, and the clock belongs to the
 * scheduler — see the module comment.
 */
export function signupsOpenMessage(
  input: SignupsOpenInput,
  template: AnnouncementTemplate | null = null
): DiscordMessage {
  const fields: DiscordEmbed["fields"] = [];
  if (input.startsAt) {
    fields.push({ name: "Starts", value: stamp(input.startsAt), inline: true });
  }
  if (input.signupClosesAt) {
    fields.push({
      name: "Applications close",
      value: stamp(input.signupClosesAt, "R"),
      inline: true,
    });
  }
  // One expression, read by the "Places" field and by `{places}`, so an edited
  // wording cannot disagree with the embed beside it about the seat count.
  const places = input.capacity && input.capacity > 0 ? String(input.capacity) : "No limit";

  const url = linkTo(`/events/${input.slug}`, input.origin ?? null);
  fields.push({ name: "Places", value: places, inline: true });

  return message(
    {
      title: clamp(input.title, 240),
      description: "Applications have opened — three taps if your profile is filled in.",
      ...(url ? { url } : {}),
      color: COLOURS.signal,
      fields,
      footer: { text: "Applications open" },
    },
    {
      template,
      values: {
        title: clamp(input.title, 240),
        places,
        // Stamps, never a formatted date: the repo invariant, and the reason
        // an edited wording still renders in each reader's own timezone.
        starts: valueOr("signups_open", "starts", input.startsAt ? stamp(input.startsAt) : null),
        closes: valueOr(
          "signups_open",
          "closes",
          input.signupClosesAt ? stamp(input.signupClosesAt, "R") : null
        ),
      },
    }
  );
}

export type ApplicationDecidedInput = {
  member: string;
  eventTitle: string;
  slug: string;
  /** Only meaningful when waitlisted; 1 is the front of the queue. */
  waitlistPosition?: number | null;
  origin?: string | null;
};

/**
 * Accepted, waitlisted with a place in the queue, or declined.
 *
 * One function for three kinds because they are one sentence with three
 * endings, and splitting them would let them drift into disagreeing about what
 * an event is called. A decline says no more than that — never why.
 */
export function applicationDecidedMessage(
  kind: "application_accepted" | "application_waitlisted" | "application_declined",
  input: ApplicationDecidedInput,
  template: AnnouncementTemplate | null = null
): DiscordMessage {
  const member = `**${clamp(input.member, 80)}**`;
  const queue = input.waitlistPosition;
  const url = linkTo(`/events/${input.slug}`, input.origin ?? null);

  const ending = {
    application_accepted: { text: `${member} is in.`, color: COLOURS.signal, footer: "Accepted" },
    application_waitlisted: {
      text:
        queue && queue > 0
          ? `${member} is on the waitlist, number ${queue} in the queue.`
          : `${member} is on the waitlist.`,
      color: COLOURS.chalk,
      footer: "Waitlisted",
    },
    application_declined: {
      text: `${member} was not accepted this time.`,
      color: COLOURS.ember,
      footer: "Declined",
    },
  }[kind];

  return message(
    {
      title: clamp(input.eventTitle, 240),
      description: ending.text,
      ...(url ? { url } : {}),
      color: ending.color,
      footer: { text: ending.footer },
    },
    {
      template,
      values: {
        /*
         * The display name, clamped to 80 exactly as the compiled sentence
         * clamps it — an edited wording must not be a way to get a longer
         * member-controlled string into a message than the compiled copy
         * allows. It lands in the embed's description, which is the half of
         * the payload a mention cannot be parsed out of (module comment).
         */
        member: clamp(input.member, 80),
        event: clamp(input.eventTitle, 240),
        // Only `application_waitlisted` offers this, so only it can use it;
        // the other two refuse `{position}` at save time.
        position: valueOr(
          kind,
          "position",
          queue && queue > 0 ? String(queue) : null
        ),
      },
    }
  );
}

export type LotSoldInput = {
  player: string;
  team: string;
  price: number;
  eventTitle: string;
  slug: string;
  origin?: string | null;
};

/**
 * A lot settling.
 *
 * A price of zero says so in words. "0" in the money face reads as a missing
 * number, and going for nothing is a real and funny outcome that the room
 * should be able to celebrate rather than look like a bug.
 */
export function lotSoldMessage(
  input: LotSoldInput,
  template: AnnouncementTemplate | null = null
): DiscordMessage {
  const url = linkTo(`/events/${input.slug}/draft`, input.origin ?? null);

  return message(
    {
      title: clamp(`${input.player} → ${input.team}`, 240),
      description:
        input.price > 0
          ? `Sold for **${input.price.toLocaleString("en-GB")}**.`
          : "Went for nothing.",
      ...(url ? { url } : {}),
      color: COLOURS.gold,
      fields: [{ name: "Event", value: clamp(input.eventTitle, 200), inline: true }],
      footer: { text: "Draft" },
    },
    {
      template,
      values: {
        player: clamp(input.player, 80),
        team: clamp(input.team, 80),
        // The nought says so in words here too: "0" in the money face reads as
        // a missing number, and going for nothing is a real outcome.
        price: input.price > 0 ? input.price.toLocaleString("en-GB") : "nothing",
        event: clamp(input.eventTitle, 240),
      },
    }
  );
}

export type MatchResultInput = {
  /** The round or slot as the board labels it — "Upper semi-final". */
  label: string;
  teamA: string;
  teamB: string;
  gamesWonA: number;
  gamesWonB: number;
  /** The winning team's name, or null for a draw somebody still has to break. */
  winner: string | null;
  eventTitle: string;
  slug: string;
  origin?: string | null;
};

export function matchResultMessage(
  input: MatchResultInput,
  template: AnnouncementTemplate | null = null
): DiscordMessage {
  const url = linkTo(`/events/${input.slug}?tab=results`, input.origin ?? null);
  const score = `${input.gamesWonA}–${input.gamesWonB}`;

  return message(
    {
      title: clamp(`${input.teamA} ${score} ${input.teamB}`, 240),
      description: input.winner
        ? `**${clamp(input.winner, 80)}** take it.`
        : "Drawn — the admin still has to call it.",
      ...(url ? { url } : {}),
      color: input.winner ? COLOURS.signal : COLOURS.ember,
      fields: [
        { name: input.label ? "Match" : "Event", value: clamp(input.label || input.eventTitle, 200), inline: true },
        ...(input.label
          ? [{ name: "Event", value: clamp(input.eventTitle, 200), inline: true }]
          : []),
      ],
      footer: { text: "Result" },
    },
    {
      template,
      values: {
        teamA: clamp(input.teamA, 80),
        teamB: clamp(input.teamB, 80),
        score,
        // A drawn series has no winner, which is a real state an admin still
        // has to call — so it renders the declared words, not nothing.
        winner: valueOr("match_result", "winner", input.winner ? clamp(input.winner, 80) : null),
        match: valueOr("match_result", "match", input.label ? clamp(input.label, 200) : null),
        event: clamp(input.eventTitle, 240),
      },
    }
  );
}

export type StandingsInput = {
  seasonName: string;
  /** The season's own slug — every link here goes to `/championship/<slug>`. */
  slug: string;
  /** The event that was just scored, named so the message says what moved it. */
  eventTitle: string;
  /** The top of the table and what happened to the lead — `topOfTheTable`'s answer. */
  top: TopOfTable;
  origin?: string | null;
};

/**
 * The new top of the table (R-197, UC-36 3).
 *
 * Three places, not the whole standings. A channel message is read in a
 * glance and a forty-row table is not one; the page it links to is where the
 * rest of the season lives, and this is the line that makes somebody click it.
 *
 * What it *says* is `topOfTheTable`'s decision, not this function's: whether
 * somebody took the lead, held it, or whether these are the first standings of
 * the season is a fact about the season, so it is worked out in
 * `./championship-policy` and turned into a sentence here. A season with
 * nobody in it produces a message about the event and no names, rather than an
 * empty bold pair of asterisks — the builder above it returns `null` for that
 * case, and this stays total anyway because a message that renders wrong is
 * indistinguishable from a webhook that is down.
 *
 * Level at the top puts both names in the sentence, for the same reason the
 * standings show them level rather than picking one.
 */
export function standingsMessage(
  input: StandingsInput,
  template: AnnouncementTemplate | null = null
): DiscordMessage {
  const leaders = input.top.rows
    .filter((row) => row.position === 1)
    .map((row) => `**${clamp(row.name, 80)}**`);
  const named = leaders.join(" and ");
  const event = `**${clamp(input.eventTitle, 120)}**`;

  const plural = leaders.length > 1;
  const description = !named
    ? `The table moved after ${event}.`
    : input.top.lead === "first"
      ? `The first standings are in after ${event}. ${named} ${plural ? "lead" : "leads"}.`
      : input.top.lead === "changed"
        ? `${named} ${plural ? "take" : "takes"} the lead after ${event}.`
        : input.top.lead === "held"
          ? `${named} ${plural ? "stay" : "stays"} top after ${event}.`
          /*
           * `unknown`: the table moved, and who took the lead from whom is
           * not something this event can say — see `Movement`. So the message
           * says what is true, which is where the table stands now.
           */
          : `The table has moved after ${event}. ${named} ${plural ? "lead" : "leads"}.`;

  const url = linkTo(`/championship/${input.slug}`, input.origin ?? null);

  return message(
    {
      title: clamp(input.seasonName, 240),
      description,
      ...(url ? { url } : {}),
      color: COLOURS.gold,
      fields: input.top.rows.map((row) => ({
        // `=1st` for a shared place, exactly as the standings table prints it.
        name: row.level ? `=${ordinal(row.position)}` : ordinal(row.position),
        value: `${clamp(row.name, 80)} — ${row.points}`,
        inline: true,
      })),
      footer: { text: "Standings" },
    },
    {
      template,
      values: {
        season: clamp(input.seasonName, 240),
        event: clamp(input.eventTitle, 240),
        /*
         * Both names when they are level, for the reason the standings show
         * them level rather than picking one — and the plain names, not the
         * bolded `named` above, so an admin's own wording decides its own
         * emphasis. A season with nobody in it renders the declared words.
         */
        leader: valueOr(
          "standings_changed",
          "leader",
          input.top.rows
            .filter((row) => row.position === 1)
            .map((row) => clamp(row.name, 80))
            .join(" and ")
        ),
      },
    }
  );
}
