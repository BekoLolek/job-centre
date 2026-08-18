/**
 * The shapes the draft components render, kept deliberately structural.
 *
 * There are two sources of team data on this site and they are not the same
 * type: the admin's setup screens read `TeamWithRoster` from `src/lib/draft.ts`
 * (a database row plus its derived balance), and the live room reads `TeamCard`
 * from `src/lib/draft-policy.ts` (the same figures, redacted for one viewer).
 * A component that named either of them would be unusable by the other half of
 * the build for no reason at all, so everything here asks for the *subset both
 * already satisfy* and nothing more.
 *
 * `RosterState` is the one exception, imported rather than restated, because it
 * is the answer to "how many slots are left and what must stay back" and a
 * second copy of that is a second copy that drifts.
 */

import type { RosterState } from "@/lib/draft-policy";

/**
 * One roster row. A captain is `isCaptain` with `price` 0 (plan §14).
 *
 * `teamId` is here even though these arrive already grouped by team, because
 * `rosterState` filters on it and re-deriving a roster against a pending config
 * is the whole point of `./ceiling`.
 */
export type MemberLike = {
  teamId: string;
  userId: string;
  price: number;
  isCaptain: boolean;
};

/**
 * A team as anything here wants it — satisfied by `TeamWithRoster` and by the
 * room's `TeamCard` without either being converted first.
 */
export type TeamLike = {
  id: string;
  name: string;
  seed: number | null;
  captainUserId: string | null;
  balanceStart: number;
  /** Derived from the awarded lots, never stored. */
  balance: number;
  roster: RosterState;
  members: readonly MemberLike[];
};

/** Enough of a person to draw them. `PlayerCard` from `src/lib/draft.ts` fits. */
export type PlayerLike = {
  displayName: string;
  avatarUrl?: string | null;
  /**
   * Their `/players/[handle]` segment, when they have one.
   *
   * Optional, and every renderer must cope without it: `users.handle` is filled
   * in lazily (see `ensureHandles`), so a member the live draft room names one
   * second after they were created genuinely has no profile URL yet. A name
   * with no link is a fine thing to draw; a link to `/players/undefined` is not.
   */
  handle?: string | null;
};

/** Everyone a screen might name, keyed by user id. */
export type PlayerBook = Readonly<Record<string, PlayerLike>>;

/**
 * The display name for a user id, or something honest when we do not have one.
 *
 * Ids reach these components from three directions — rosters, pools and lot
 * history — and any of them can name somebody the book does not cover (an
 * account deleted mid-event, a player accepted after the page rendered). A
 * blank cell in a roster is indistinguishable from an empty slot, so the
 * fallback says a name rather than nothing.
 */
export function playerName(
  players: PlayerBook,
  userId: string | null | undefined,
  fallback = "Unknown player"
): string {
  if (!userId) return fallback;
  return players[userId]?.displayName ?? fallback;
}

/**
 * The public profile link for a user id, or `null`.
 *
 * `null` rather than a `#` or a link to nowhere: a roster row for somebody
 * without a handle should read as plain text, not as a link that goes to a 404.
 */
export function playerHref(
  players: PlayerBook,
  userId: string | null | undefined
): string | null {
  if (!userId) return null;
  const handle = players[userId]?.handle;
  return handle ? `/players/${handle}` : null;
}
