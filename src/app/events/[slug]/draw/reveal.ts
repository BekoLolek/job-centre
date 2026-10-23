/**
 * What the draw screen shows, as a decision rather than an animation (R-213 /
 * UC-39 4, 6).
 *
 * The reveal is nine cards turning about a second apart, and this module is the
 * whole of what that means on screen: how many are face-up, whether the timer
 * should still be running, and how the nine read as three roles. `HandReveal`
 * holds the state and the `setInterval`; it decides nothing.
 *
 * ## Why this is a separate file with no React in it
 *
 * Two reasons, and the second is the one that matters.
 *
 * The suite runs in vitest's `node` environment — no DOM, no jsdom, no
 * testing-library — so **nothing can click the button.** Every state after the
 * first click is unreachable by rendering. Task 64 hit the same wall and took
 * the same way out (`draftBody`, `editorStatus`, `withRole`): where a state is
 * reachable only by interacting, the decision becomes an exported pure function
 * and the test calls it. A test here that *looked* like it clicked would be a
 * worse lie than admitting it cannot.
 *
 * And the reveal must be **presentation only** (R-212). The hand is dealt and
 * stored on the server before the first card turns, and what arrives in the
 * browser is nine heroes that are already a fact. A reveal that decided
 * anything — which hero, or whether a hero is dealt at all — would be a reroll
 * waiting to happen. {@link revealView} is how that is kept true by shape
 * rather than by care: it takes a list it cannot add to and an integer, and the
 * only thing it can do with them is say how much of the list is visible. There
 * is no source of randomness in this file, nothing imported that has one, and
 * nothing here that can change which nine `cards` holds.
 *
 * It is also deliberately free of anything that reaches Postgres. `@/lib/heroes`
 * owns the role order and imports Drizzle, so a `"use client"` file that
 * value-imported from it would drag the database client into the browser
 * bundle — the boundary `HeroEditor.tsx` and `FormatTab.tsx` both carry a note
 * about. So the roles are not read from a constant here: they arrive **in the
 * cards**, in the order the server dealt them, and {@link groupsOf} recovers
 * the grouping by first appearance. The deal order is the server's to state and
 * this file's to preserve.
 */

import type { HeroRole } from "@/db";

/**
 * One hero in one role, as the browser is given it.
 *
 * `id` and `role` together identify a slot, not `id` alone: a hero holding more
 * than one role can legitimately be dealt in two of a player's three role-sets
 * — somebody can hold Deadpool as a Vanguard *and* as a Duelist — so the same
 * `id` appears twice in a hand and a React key built from it alone would
 * collide. `heroes-policy.ts` has the long form of why that is correct.
 */
export type RevealCard = { id: string; name: string; role: HeroRole };

/**
 * What one click comes back with (UC-39 3a, 5a, 6).
 *
 * Declared here, in the module with no directive, rather than in `actions.ts`,
 * so the reveal and the action agree about the shape without the browser bundle
 * reaching toward the server action's imports.
 *
 * **The whole hand arrives before the first card turns.** That is R-212 in one
 * line of types: there is no outcome that carries a pool, a seed or a partial
 * hand, so the only thing the browser can do with a successful draw is uncover
 * nine heroes that were decided and stored while it was waiting. A player who
 * closes the tab mid-reveal has already been dealt exactly these.
 *
 * `alreadyHeld` is `dealFor`'s own, passed straight through: "I have just dealt
 * you these" and "you already had these" are different facts, and re-deriving
 * the difference in the browser would be a second source of truth for the one
 * thing on this screen that must not have two.
 */
export type DrawOutcome =
  | { ok: true; cards: RevealCard[]; alreadyHeld: boolean }
  | { ok: false; error: string };

/** A card in its place in the deal, and whether it has turned yet. */
export type RevealSlot = RevealCard & {
  /** Position in the deal, from 0. The order the server dealt, never re-sorted. */
  index: number;
  faceUp: boolean;
};

/** One role's slots, in deal order. */
export type RoleGroup = { role: HeroRole; slots: RevealSlot[] };

/**
 * Everything the screen's shape depends on.
 *
 * `cards` is null before anything has been dealt — not an empty array, because
 * "nothing was dealt" and "a hand of none" are different facts and only one of
 * them can happen.
 */
export type RevealState = {
  cards: readonly RevealCard[] | null;
  /** How many times the reveal timer has fired. Nothing else moves this. */
  ticks: number;
  /** `prefers-reduced-motion: reduce`, read from the browser. */
  reducedMotion: boolean;
  /**
   * True when these nine were already stored before this page asked for them —
   * `dealFor`'s own `alreadyHeld` (UC-39 3a, 6a).
   *
   * Not re-derived here or in the component. A hand somebody already holds has
   * been dealt once already, and replaying the reveal for it would stage a
   * draw that did not happen.
   */
  alreadyHeld: boolean;
};

export type RevealView = {
  /** How many of `total` have turned. */
  faceUp: number;
  /** How many there are. Taken from the hand, never from a constant. */
  total: number;
  /**
   * Whether the timer should still be running. The component's effect returns
   * early on false, so this is also what says "never start one" — see the
   * reduced-motion note on {@link revealView}.
   */
  revealing: boolean;
  /** Every slot turned. */
  complete: boolean;
  /**
   * Whether a reveal is actually playing out in front of this player, and so
   * whether there is a count worth narrating in a live region.
   *
   * False for both of the cases that show the hand whole: a stored hand on
   * arrival has nothing to narrate, and somebody who asked for reduced motion
   * is the last person who should be read a running commentary.
   */
  narrate: boolean;
  /** The hand as three roles, for the screen (UC-39 6: grouped by role). */
  groups: RoleGroup[];
};

/**
 * The nine as three roles, with the first `faceUp` of them turned.
 *
 * The grouping is by **first appearance**, so the role headings read in the
 * order the server dealt and this file needs no copy of `HERO_ROLES` (see the
 * module note). Within a role the cards keep their deal order too.
 *
 * Every card is in a group whatever `faceUp` is, face-down ones included. That
 * is the layout decision as much as the honest one: the three roles are their
 * full height from the first card, so nothing on the screen moves while the
 * hand fills in, and a player watching can see the shape they are being dealt
 * into. It is also what makes "the animation only uncovers" checkable — the
 * set of nine is identical at every count, and only the flags move.
 */
export function groupsOf(cards: readonly RevealCard[], faceUp: number): RoleGroup[] {
  const groups: RoleGroup[] = [];
  for (const [index, card] of cards.entries()) {
    const slot: RevealSlot = { ...card, index, faceUp: index < faceUp };
    const existing = groups.find((group) => group.role === card.role);
    if (existing) existing.slots.push(slot);
    else groups.push({ role: card.role, slots: [slot] });
  }
  return groups;
}

/**
 * The screen, from the state.
 *
 * Four decisions, in the order they override each other:
 *
 *  - **Nothing dealt is nothing shown.** `cards` null means the player has not
 *    clicked, so there is no hand, no count and nothing to run a timer for.
 *  - **Reduced motion shows the hand** (the Constraints; UC-39's reveal is
 *    R-213, a *Could*). A nine-step reveal driven by a timer is precisely what
 *    `prefers-reduced-motion` exists for, and CSS cannot answer it: the steps
 *    are an interval in JavaScript, so `animation: none` in `globals.css` would
 *    leave somebody watching nine cards turn with the easing removed. `faceUp`
 *    goes straight to `total` and `revealing` is false, so **the interval is
 *    never started** rather than started and hidden.
 *  - **A hand already held does not re-deal itself.** `alreadyHeld` is the
 *    second click and the reload (UC-39 3a): the nine were dealt once, at some
 *    earlier moment, and turning them over again would be theatre for an event
 *    that is already in the past. Same shape as reduced motion — shown whole,
 *    no timer.
 *  - **Otherwise the timer governs**, clamped at both ends so a tick count that
 *    ran past the end cannot report ten of nine and a negative one cannot turn
 *    a card back over.
 *
 * `revealing` is `faceUp < total` and deliberately **not** `!whole && faceUp <
 * total`. It was the second of those, and a mutation proved the `!whole` dead:
 * a hand shown whole has `faceUp === total` already, so the comparison is
 * false by itself and the extra clause could never change an answer. Removing
 * it leaves one fact doing the work instead of two that have to agree — and it
 * is worth knowing *why* reduced motion starts no timer, which is not a second
 * guard but the same guarantee that turned every card: there is nothing left
 * to turn.
 */
export function revealView(state: RevealState): RevealView {
  const cards = state.cards;
  if (cards === null) {
    return {
      faceUp: 0,
      total: 0,
      revealing: false,
      complete: false,
      narrate: false,
      groups: [],
    };
  }

  const total = cards.length;
  const whole = state.reducedMotion || state.alreadyHeld;
  const faceUp = whole ? total : Math.min(Math.max(state.ticks, 0), total);

  return {
    faceUp,
    total,
    revealing: faceUp < total,
    complete: faceUp === total,
    narrate: !whole && total > 0,
    groups: groupsOf(cards, faceUp),
  };
}

/**
 * About a second per hero (R-213), one click for all nine.
 *
 * Named rather than written into the `setInterval` call because R-213 is the
 * only reason it is a second rather than instant, and a test asserting the
 * requirement should be able to read the number the requirement is about.
 */
export const REVEAL_INTERVAL_MS = 1000;

/** The media query the reveal is switched off by. */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * The line a live region reads while the cards turn — "4 of 9 turned", then
 * "That is your hand."
 *
 * Null when there is nothing playing out, which {@link RevealView.narrate}
 * already decided: a hand shown whole is read by the hand itself, in the
 * reading order, and a count beside it would announce a reveal nobody saw.
 *
 * The total is taken off the view rather than written as "nine", so a hand of
 * some other size cannot be narrated with the wrong number.
 */
export function revealProgress(view: RevealView): string | null {
  if (!view.narrate) return null;
  if (view.complete) return "That is your hand.";
  return `${view.faceUp} of ${view.total} turned.`;
}
