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
 * single most-watched moment the community has. Which of the five actually post
 * is an **admin setting** (`SETTING_KEYS.announcements`), read through
 * `announcementSettingsFrom`, which supplies a default for anything the stored
 * object does not mention. That is what lets a sixth kind ship without a
 * migration and without a deployment silently starting to post something nobody
 * asked for.
 *
 * ## Mentions
 *
 * Every payload carries `allowed_mentions: { parse: [] }`. A member's display
 * name is under their control, and a display name of `@everyone` that pings a
 * server of four hundred people because the site pasted it into a message is
 * exactly the sort of thing a webhook integration does once and is switched off
 * for. Discord only honours mentions this list allows, so the answer is to
 * allow none: the site never has a reason to ping anybody.
 */

import type { SettingValue } from "@/db/schema";

/* ------------------------------------------------------------------ */
/* The kinds                                                          */
/* ------------------------------------------------------------------ */

export type AnnouncementKind =
  /** An event went from draft to published — the one that brings people in. */
  | "event_published"
  /** An application was accepted. */
  | "application_accepted"
  /** An application was waitlisted. */
  | "application_waitlisted"
  /** A draft lot settled with a winner and a price. */
  | "draft_lot_sold"
  /** A series was decided. */
  | "match_result";

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
 * The five, in the order the settings screen lists them, with their defaults.
 *
 * "Sensible" here means: the two that are *news* are on, the one that is a
 * consolation is off. A published event and a settled lot are things people
 * want pinged about; being told, in public, that four hundred applications were
 * each waitlisted is a channel nobody reads twice. Accepted stays on because
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
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

export type AnnounceEnv = {
  DISCORD_WEBHOOK_URL?: string;
  /** Where the links in a message point. `AUTH_URL` is the one already set. */
  NEXT_PUBLIC_SITE_URL?: string;
  AUTH_URL?: string;
};

/**
 * The webhook, or `null`.
 *
 * `null` is the entire off switch: with `DISCORD_WEBHOOK_URL` unset the whole
 * feature is an inert no-op, exactly as blank Discord credentials are on
 * `/signin`. Nothing throws, nothing warns on every request, and no caller
 * branches — `postAnnouncement` simply has nowhere to post.
 *
 * A value that is not an https URL is treated as unset rather than tried:
 * `fetch` on a nonsense string throws a different error every runtime, and the
 * one thing this feature must never do is turn a typo in an environment
 * variable into a failed application.
 */
export function webhookUrl(env: AnnounceEnv = process.env as AnnounceEnv): string | null {
  const raw = (env.DISCORD_WEBHOOK_URL ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    // http as well as https, because the local listener the feature is driven
    // against is http — and a webhook that can only be tested against Discord
    // is a webhook nobody tests.
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
  const raw = (env.NEXT_PUBLIC_SITE_URL ?? env.AUTH_URL ?? "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
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

export type DiscordMessage = {
  username: string;
  embeds: DiscordEmbed[];
  /** Never parsed. See the module comment. */
  allowed_mentions: { parse: [] };
};

/** The site's own palette (§5), as Discord's integer colours. */
export const COLOURS = {
  gold: 0xe3b23c,
  signal: 0x3ddc84,
  ember: 0xff4d1c,
  chalk: 0xf1ede4,
} as const;

const USERNAME = "Job Centre Events";

function message(embed: DiscordEmbed): DiscordMessage {
  return { username: USERNAME, embeds: [embed], allowed_mentions: { parse: [] } };
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
/* The five messages                                                  */
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

export function eventPublishedMessage(input: EventPublishedInput): DiscordMessage {
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
  fields.push({
    name: "Places",
    value: input.capacity && input.capacity > 0 ? String(input.capacity) : "No limit",
    inline: true,
  });

  const url = linkTo(`/events/${input.slug}`, input.origin ?? null);

  return message({
    title: clamp(input.title, 240),
    description: input.description
      ? clamp(input.description, 600)
      : "Applications are open — three taps if your profile is filled in.",
    ...(url ? { url } : {}),
    color: COLOURS.gold,
    fields,
    footer: { text: "New event" },
  });
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
 * Accepted, or waitlisted with a place in the queue.
 *
 * One function for two kinds because they are one sentence with two endings,
 * and splitting them would let the two drift into disagreeing about what an
 * event is called.
 */
export function applicationDecidedMessage(
  kind: "application_accepted" | "application_waitlisted",
  input: ApplicationDecidedInput
): DiscordMessage {
  const accepted = kind === "application_accepted";
  const queue = input.waitlistPosition;
  const url = linkTo(`/events/${input.slug}`, input.origin ?? null);

  return message({
    title: clamp(input.eventTitle, 240),
    description: accepted
      ? `**${clamp(input.member, 80)}** is in.`
      : queue && queue > 0
        ? `**${clamp(input.member, 80)}** is on the waitlist, number ${queue} in the queue.`
        : `**${clamp(input.member, 80)}** is on the waitlist.`,
    ...(url ? { url } : {}),
    color: accepted ? COLOURS.signal : COLOURS.chalk,
    footer: { text: accepted ? "Accepted" : "Waitlisted" },
  });
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
export function lotSoldMessage(input: LotSoldInput): DiscordMessage {
  const url = linkTo(`/events/${input.slug}/draft`, input.origin ?? null);

  return message({
    title: clamp(`${input.player} → ${input.team}`, 240),
    description:
      input.price > 0
        ? `Sold for **${input.price.toLocaleString("en-GB")}**.`
        : "Went for nothing.",
    ...(url ? { url } : {}),
    color: COLOURS.gold,
    fields: [{ name: "Event", value: clamp(input.eventTitle, 200), inline: true }],
    footer: { text: "Draft" },
  });
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

export function matchResultMessage(input: MatchResultInput): DiscordMessage {
  const url = linkTo(`/events/${input.slug}?tab=results`, input.origin ?? null);
  const score = `${input.gamesWonA}–${input.gamesWonB}`;

  return message({
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
  });
}
