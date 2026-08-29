import type { NotificationKind } from "@/db/schema";

/**
 * What the site tells you about, and what it takes to switch it off.
 *
 * Pure, so the preferences screen can import it into the browser and describe
 * every kind without dragging Drizzle and PGlite in with it — the same split
 * `auth-policy.ts` and `availability-resolve.ts` make, and for the same reason.
 */

export type NotificationChannels = { inApp: boolean; discord: boolean };

export type KindSpec = {
  kind: NotificationKind;
  label: string;
  /** One line on the screen: what arrives, and when. */
  blurb: string;
  /** Who gets it at all — the thing that makes the defaults reasonable. */
  audience: string;
  /**
   * Whether it can be switched off.
   *
   * `application_decided` cannot. Being told the answer to something you asked
   * for is not a notification in the sense the others are — it is the reply,
   * and a site that lets you mute the reply to your own application will
   * eventually leave somebody waiting for a seat they were given a month ago.
   */
  fixed?: boolean;
  defaults: NotificationChannels;
};

/**
 * Every kind, in the order the screen lists them.
 *
 * In-app on, Discord off, everywhere. A dot on a bell is something you find
 * when you come looking; a direct message arrives whether or not you wanted it,
 * and opting somebody into that on their behalf is the sort of thing that gets
 * an integration muted at the Discord end and never turned back on.
 */
export const NOTIFICATION_KINDS: readonly KindSpec[] = [
  {
    kind: "event_published",
    label: "New events",
    blurb: "When an event goes up on the hub.",
    audience: "Everyone",
    defaults: { inApp: true, discord: false },
  },
  {
    kind: "event_reminder",
    label: "Starting tomorrow",
    blurb: "The day before an event you have a seat at.",
    audience: "People holding a seat",
    defaults: { inApp: true, discord: false },
  },
  {
    kind: "event_updated",
    label: "Event details changed",
    blurb: "When the dates or the description of something you applied to move.",
    audience: "People who applied",
    defaults: { inApp: true, discord: false },
  },
  {
    kind: "event_cancelled",
    label: "Event called off",
    blurb: "When something you applied to is cancelled.",
    audience: "People who applied",
    defaults: { inApp: true, discord: false },
  },
  {
    kind: "questions_changed",
    label: "Questions changed",
    blurb: "When the sign-up questions change after you have answered them, so you can check your answers still say what you meant.",
    audience: "People who already applied",
    defaults: { inApp: true, discord: false },
  },
  {
    kind: "application_decided",
    label: "Your application",
    blurb: "Whether you are in, or in the queue.",
    audience: "You",
    fixed: true,
    defaults: { inApp: true, discord: false },
  },
  {
    kind: "poll_posted",
    label: "New polls",
    blurb: "When there is something to vote on.",
    audience: "Everyone",
    defaults: { inApp: true, discord: false },
  },
  {
    kind: "host_decision",
    label: "Hosting",
    blurb: "When your application to run an event is decided.",
    audience: "You",
    fixed: true,
    defaults: { inApp: true, discord: false },
  },
];

const BY_KIND = new Map(NOTIFICATION_KINDS.map((spec) => [spec.kind, spec]));

export function kindSpec(kind: NotificationKind): KindSpec | undefined {
  return BY_KIND.get(kind);
}

export type PrefOverride = {
  kind: NotificationKind;
  inApp: boolean;
  discord: boolean;
};

/**
 * What to do for one person and one kind.
 *
 * An override wins; absence means the default. A kind marked `fixed` ignores
 * the in-app override entirely — the switch is not offered on the screen, and
 * accepting one from a hand-made request would let somebody mute the answer to
 * their own application.
 *
 * Discord stays a real choice on every kind, fixed ones included: being unable
 * to mute the *reply* is not a reason to be unable to mute the *DM*.
 */
export function channelsFor(
  kind: NotificationKind,
  overrides: readonly PrefOverride[] | null
): NotificationChannels {
  const spec = BY_KIND.get(kind);
  const fallback = spec?.defaults ?? { inApp: true, discord: false };
  const override = overrides?.find((row) => row.kind === kind);

  return {
    inApp: spec?.fixed ? true : (override?.inApp ?? fallback.inApp),
    discord: override?.discord ?? fallback.discord,
  };
}

/** Everything the preferences screen renders, resolved. */
export function allChannels(
  overrides: readonly PrefOverride[] | null
): Array<KindSpec & { channels: NotificationChannels }> {
  return NOTIFICATION_KINDS.map((spec) => ({
    ...spec,
    channels: channelsFor(spec.kind, overrides),
  }));
}

/* ------------------------------------------------------------------ */
/* Dedupe keys                                                        */
/* ------------------------------------------------------------------ */

/**
 * What makes one piece of news distinct from the next.
 *
 * The insert is keyed on `(userId, dedupeKey)` and does nothing on a clash, so
 * this function is the entire collapse rule. Two shapes:
 *
 *  - **Once ever.** A published event, a decided application, a poll. The key
 *    is the kind and the subject, and a second send is silently dropped.
 *  - **Once a day.** Questions changing, details moving. An admin editing the
 *    questions five times in a minute has produced one piece of news, not
 *    five, and the day is the natural grain — you want to be told again
 *    tomorrow if they change them again tomorrow.
 */
export function dedupeKey(
  kind: NotificationKind,
  subject: string,
  day?: string
): string {
  return day ? `${kind}:${subject}:${day}` : `${kind}:${subject}`;
}

/** "2026-08-24" for an instant, in UTC — the grain, not a display value. */
export function dayStamp(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}
