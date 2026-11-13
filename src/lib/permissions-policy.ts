/**
 * The powers a member can be given, the presets that name a usual set of them,
 * and the question "may they" — with no database (R-261, R-262, R-264 / UC-55,
 * decision 007).
 *
 * Split from `src/lib/permissions.ts` the way `admin-users-policy.ts` is split
 * from `admin-users.ts`: this half is plain data and pure functions, so a
 * client component can import it, while the half that reads `user_permissions`
 * stays on the server. This file imports nothing at all, and
 * `__tests__/permissions-policy.test.ts` holds it to that.
 *
 * ## There is no power that grants powers, and that is on purpose
 *
 * Nothing below reaches the granting of powers — no `permissions.grant`, no
 * `members.manage`. It is not an oversight to tidy up "for consistency".
 * Granting and revoking belong to the admin flag alone (R-264), so no holder of
 * any combination of these can give anybody, themselves included, a power from
 * this vocabulary or the admin flag. UC-55 5a is this absence: the power is
 * not refused on a screen, it does not exist. Adding one here undoes the
 * requirement.
 *
 * That is a narrower claim than "nobody here can hand out authority", and one
 * power is why. `hosts.approve` confers authority of a different kind:
 * approving an application writes an `event_hosts` row, and within that one
 * event a host can do what an admin can. Nothing in `src/lib/hosting.ts` stops
 * the decider being the applicant, so a holder approving their own application
 * would be an escalation. Refusing that is an acceptance criterion of Task 126
 * in docs/plan.md, the task that makes the power reachable.
 *
 * ## The admin flag is not in here either
 *
 * `users.is_admin` is a superuser above the vocabulary, not a bundle of it.
 * {@link holds} takes the flag beside the list, so an admin is never
 * represented as "somebody with all fourteen rows" — a representation that
 * would quietly stop being true the day a fifteenth is added.
 */

/**
 * Every power there is, as the owner approved them (docs/plan.md, section T).
 *
 * Thirteen areas and one modifier. `destructive` reaches nothing by itself: it
 * is required *in addition to* an area's power for the actions `src/lib/audit.ts`
 * already marks destructive (R-267). Nothing enforces that yet.
 *
 * These are stored as text, not a Postgres enum, so a new name is a line here
 * and not a migration — the convention `audit_log.action` follows.
 */
export const POWERS = Object.freeze([
  /** Creating an event. */
  "events.create",
  /** Every event, as a host has their own one. */
  "events.manage",
  /** Posting an announcement to Discord by hand. */
  "announce.post",
  /** Which announcements go out, their wording, their mentions. */
  "settings.announcements",
  /** The webhook URL, the site origin, the guild gate. */
  "settings.integrations",
  /** Games, rank ladders, profile fields, heroes. */
  "games.manage",
  /** Event templates. */
  "templates.manage",
  /** Seasons, points tables, opening and closing. */
  "championships.manage",
  /** Creating, closing and deleting polls. */
  "polls.manage",
  /** A suggestion's status; deleting any. */
  "suggestions.moderate",
  /** Approving and declining host applications. */
  "hosts.approve",
  /** The member list, availability, and what people have drawn. */
  "members.read",
  /** The audit log. */
  "audit.read",
  /** The modifier: see above. */
  "destructive",
] as const);

export type Power = (typeof POWERS)[number];

/** Is this name in the vocabulary? */
export function isPower(name: string): name is Power {
  return (POWERS as readonly string[]).includes(name);
}

/**
 * Refuse a name that is not a power, saying which name it was.
 *
 * A thrown error rather than a `false`: an unknown power is never a member
 * being turned away, it is a typo at a call site or a form posting something
 * the screen did not offer, and either should be loud.
 */
export function assertPower(name: string): asserts name is Power {
  if (!isPower(name)) {
    throw new Error(
      `"${name}" is not a power. The vocabulary is in src/lib/permissions-policy.ts.`
    );
  }
}

/**
 * The usual sets, by the names the owner gave them.
 *
 * **Applied, not followed** (R-262 / UC-55 6a). A preset is a shortcut for
 * marking these powers at the moment of granting; what is stored is the
 * member's own list, with no record of which preset it came from. Editing a
 * list here changes what the shortcut marks next time and changes nobody who
 * already holds anything.
 */
export const PRESETS = Object.freeze({
  Organiser: Object.freeze([
    "events.create",
    "events.manage",
    "announce.post",
    "championships.manage",
  ]),
  Announcer: Object.freeze(["announce.post", "settings.announcements"]),
  Moderator: Object.freeze([
    "polls.manage",
    "suggestions.moderate",
    "members.read",
    "audit.read",
  ]),
  Curator: Object.freeze(["games.manage", "templates.manage"]),
} satisfies Record<string, readonly Power[]>);

/** Whoever is being asked about: the admin flag, and beside it their own list. */
export type Holder = {
  isAdmin: boolean;
  /** The powers stored for them — what `powersOf` reads. */
  powers: ReadonlySet<Power>;
};

/**
 * May this holder do what this power reaches?
 *
 * An admin may, whatever their list says; anybody else may when the power is
 * on their list. The shape is `canManageEvent`'s: the flag first, then the
 * grant.
 *
 * The power is checked against the vocabulary before either, so asking about
 * one that does not exist throws for an admin as well — "an admin holds
 * everything" means everything there is. The types already refuse a misspelt
 * literal and a list of plain strings; the check is for a name that arrived as
 * a string and was cast.
 */
export function holds(holder: Holder, power: Power): boolean {
  assertPower(power);
  if (holder.isAdmin) return true;
  return holder.powers.has(power);
}
