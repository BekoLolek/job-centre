/**
 * Where a dealt hand lives: dealt once, and it stands (R-212 / UC-39 3a, 3b,
 * 5a, 6a).
 *
 * The storage half of the draw, and the only half that touches Postgres.
 * `heroes-policy.ts` decides *which* nine (Task 74, no database, randomness
 * injected); `heroes.ts` supplies the catalogue and the pools; this file is the
 * two sentences in between — "what does this participant already hold" and
 * "deal them one if they hold nothing" — and Task 76's page is the only caller.
 *
 * It is a module of its own rather than more of `heroes.ts` because the two
 * answer different questions about different tables: that file is the hero
 * *catalogue* and the admin screen underneath it, this one is one row of
 * `hero_hands`. The only thing shared is the direction of the import, which
 * runs one way.
 *
 * ## Dealt once is a constraint, not a check
 *
 * `hero_hands_event_user_uniq` is R-212 (see `src/db/schema.ts` and
 * drizzle/0032). The uniqueness lives in Postgres because that is the only
 * place it can be *true* rather than merely tested: two devices clicking in the
 * same instant (UC-39 3b) both read "no hand" and both deal, whatever this file
 * checks first. So {@link dealFor} does not guard the write — it *attempts* it,
 * with `on conflict do nothing … returning()`, and reads an empty return as
 * "somebody else got there first". `claim` in `src/lib/discord.ts` is the same
 * three lines against `announcement_claims`, and it is the pattern this one
 * follows deliberately; a read-then-write is the race `applyToEvent` had to
 * take a lock for.
 *
 * ## There is no transaction here, and that is the point
 *
 * `docs/decisions/004-refusals-inside-transactions.md` says a refusal *returned*
 * from a transaction callback commits everything written before it — so if the
 * deal wrote and then refused, the hand would be stored and the player told it
 * was not, which is UC-39 5a exactly inverted: "a hand that was never stored is
 * not a hand" would become "a hand that was stored is not a hand".
 *
 * The decision's first safe shape is "decide everything before you write
 * anything", and {@link dealFor} is that shape taken as far as it goes: **it
 * makes exactly one write, it is the last thing the function does, and every
 * refusal is reached before it.** A missing event, an event with no game, a
 * role too thin to deal from — all three are answered while nothing has been
 * written, so there is nothing for a rollback to undo and no transaction to
 * need one. The read that follows the write cannot refuse on its own behalf
 * either: it runs only when the insert wrote *nothing*.
 *
 * That ordering is the invariant to preserve. A future edit that writes
 * anything else here — an audit line, a notification — must either go before
 * the refusals or accept that it needs a transaction and the decision's rules.
 *
 * ## `alreadyHeld` rather than a second query
 *
 * {@link dealFor} says whether the hand it is returning was dealt by this call
 * or found already stored, because the page needs that distinction and cannot
 * safely recover it: "I just dealt you these" is a nine-card reveal, "you
 * already had these" is the hand shown flat with no button (UC-39 3a, 6a). A
 * page inferring it from a prior read would be guessing across a gap in which
 * the other device's click lands, and a second source of truth for a thing this
 * function already knows for certain.
 *
 * ## What this file does not decide
 *
 * **Whether the person may draw at all.** Holding a seat (UC-39 precondition 2)
 * and being told so when they do not (UC-39 1a), and an event whose game has no
 * hero list naming the game (1b), are the page's — Task 76 serves those flows.
 * Repeating a participation check here would be a second copy of a rule that
 * lives one layer up, and the two would drift. What is here is the pair the
 * *row* is keyed by.
 */

import { and, eq, inArray } from "drizzle-orm";
import {
  type Database,
  type Hero,
  type HeroRole,
  db as defaultDb,
  events,
  heroHands,
  heroes,
} from "@/db";
import { HERO_ROLES, drawableByRole, listHeroes } from "@/lib/heroes";
import { HEROES_PER_ROLE, type HeroHand, drawHand } from "@/lib/heroes-policy";

/** What one participant holds for one event, and when they were dealt it. */
export type StoredHand = {
  heroes: Record<HeroRole, Hero[]>;
  dealtAt: Date;
};

export type HeroDealResult =
  | { ok: true; hand: StoredHand; alreadyHeld: boolean }
  | { ok: false; error: string };

/**
 * How many ids a stored hand holds: three roles at three each.
 *
 * Derived rather than written as 9, because `hero_hands_nine_distinct_per_role`
 * has to say `9` out loud — a CHECK constraint cannot import a constant — and a
 * fourth role would otherwise leave this file and that constraint disagreeing
 * in silence. `hero-hands.test.ts` asserts the two are the same number, which
 * is the only place they can be compared.
 */
export const HAND_SIZE = HERO_ROLES.length * HEROES_PER_ROLE;

/* --- The refusals, each one distinct ------------------------------ */

/**
 * The event went between the render and the click.
 *
 * Exported so the page and the tests read one string, as the hero writes in
 * `heroes.ts` are. The three below share no phrase with each other on purpose:
 * a `toContain` on a fragment two of them carried is how a refusal assertion on
 * this plan went green for the wrong reason, so each is asserted whole.
 */
export const HAND_EVENT_GONE = "That event is no longer here.";

/** No game, so no roster, so nothing to deal. The page's 1b, reached from here. */
export const HAND_NO_GAME =
  "This event has no game set, so there is no hero list to draw from.";

/**
 * UC-39 5a, in the words the use case uses: a hand that was never stored is not
 * a hand, so nothing is shown as drawn and the participant may click again.
 */
export const HAND_NOT_STORED =
  "Your hand could not be stored, so nothing was dealt. Click again.";

/* --- Flattening, and getting it back ------------------------------ */

/**
 * The three role lists as one array of ids, in `HERO_ROLES` order.
 *
 * Position is what carries the role, and it has to, because **Deadpool is
 * playable in all three**: the same id can appear twice in one hand, so
 * (hand, hero) is not a key and a `role` column could not tell "Deadpool as my
 * Vanguard" from "Deadpool as my Duelist". Only the slot can.
 */
function flatten(hand: HeroHand): string[] {
  return HERO_ROLES.flatMap((role) => hand[role].map((hero) => hero.id));
}

/**
 * The inverse: nine ids and the rows they name, back into three role lists.
 *
 * Reads the roles out of `HERO_ROLES` at `HEROES_PER_ROLE` a time rather than
 * slicing at 3, 6 and 9, so the pair of functions stays one fact.
 *
 * **Throws on an id with no row.** It cannot happen through the site — nothing
 * deletes a hero, `retireHero` writes `retired_at` and leaves the row where it
 * is — and the one statement that could, a hard `delete` of a `games` row,
 * exists nowhere outside test teardown. If it ever did happen, a hand of eight
 * returned as though it were whole is the failure worth avoiding: the player
 * would see a gap and have no way to know it was not what they were dealt, and
 * nothing would be recorded anywhere. So it is loud.
 */
function unflatten(heroIds: readonly string[], rows: readonly Hero[]): Record<HeroRole, Hero[]> {
  const byId = new Map(rows.map((hero) => [hero.id, hero]));
  const out = Object.fromEntries(HERO_ROLES.map((role) => [role, [] as Hero[]])) as Record<
    HeroRole,
    Hero[]
  >;

  HERO_ROLES.forEach((role, roleIndex) => {
    const from = roleIndex * HEROES_PER_ROLE;
    for (const id of heroIds.slice(from, from + HEROES_PER_ROLE)) {
      const hero = byId.get(id);
      if (!hero) {
        throw new Error(
          `A stored hand names hero ${id}, which is no longer in the heroes table. ` +
            `A hand keeps its heroes through a rename and a retirement, so this is a ` +
            `deleted row rather than an edited one.`
        );
      }
      out[role].push(hero);
    }
  });

  return out;
}

/* --- Reading, and dealing ----------------------------------------- */

/**
 * The hand this participant already holds for this event, or null.
 *
 * **Retired heroes included, deliberately** (UC-40 4a): the hero rows are read
 * by id with no `retired_at` filter, which is what makes "what was dealt stays
 * dealt" true. `drawableByRole` is where retirement is honoured, and it is
 * about the *next* draw rather than this hand.
 *
 * Two queries rather than a join, because a hand of nine can name the same
 * hero twice — Deadpool in two roles — and a join would hand back eight rows
 * for nine cards and lose which slot each belonged to. The ids are de-duplicated
 * for the `in` list and the slots are rebuilt from the stored order.
 */
export async function handFor(
  eventId: string,
  userId: string,
  database: Database = defaultDb
): Promise<StoredHand | null> {
  const [row] = await database
    .select()
    .from(heroHands)
    .where(and(eq(heroHands.eventId, eventId), eq(heroHands.userId, userId)))
    .limit(1);
  if (!row) return null;

  const rows = await database
    .select()
    .from(heroes)
    .where(inArray(heroes.id, [...new Set(row.heroIds)]));

  return { heroes: unflatten(row.heroIds, rows), dealtAt: row.dealtAt };
}

/**
 * Deal this participant a hand and store it, or hand back the one they already
 * hold. **Never deals twice** (R-212).
 *
 * `alreadyHeld` tells the two apart: `false` means these nine were dealt by
 * this call and have just been stored, `true` means they were already there and
 * nothing was written. UC-39 3a and 6a are the same answer from this function's
 * point of view and two different screens.
 *
 * ## The order of the steps is the correctness
 *
 * Read `docs/decisions/004` and the module comment above before reordering any
 * of this. Every refusal is reached before the single write; the single write
 * is the last statement that writes anything; the read after it runs only when
 * that write wrote nothing. There is no transaction because, in that order,
 * there is nothing a rollback would have to undo.
 *
 * The early read is a convenience and not the guard — it saves shuffling a
 * roster for somebody who already holds a hand, and it is the common case,
 * because UC-39 6a (coming back later) happens far more often than a first
 * click. Deleting it would cost a wasted draw and change no outcome: the insert
 * would conflict, write nothing, and the hand already held would be read and
 * returned with `alreadyHeld: true` exactly as it is now. That is worth knowing
 * when reading the two tests that look alike — one covers the read, one covers
 * the conflict, and they are not duplicates of each other.
 *
 * ## Randomness
 *
 * Injected, for the reason `heroes-policy.ts` argues at length: a draw that
 * reaches for `Math.random` cannot be tested, and "it looked random" is not
 * evidence. The default is the real generator and the page is the only caller
 * that takes it; every test passes a known sequence and asserts the exact nine.
 */
export async function dealFor(
  eventId: string,
  userId: string,
  random: () => number = Math.random,
  database: Database = defaultDb
): Promise<HeroDealResult> {
  // UC-39 3a, 6a — already dealt, so nothing is dealt again.
  const held = await handFor(eventId, userId, database);
  if (held) return { ok: true, hand: held, alreadyHeld: true };

  /* Everything that can refuse, before anything is written (decision 004). */
  const [event] = await database
    .select({ gameId: events.gameId })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!event) return { ok: false, error: HAND_EVENT_GONE };
  if (!event.gameId) return { ok: false, error: HAND_NO_GAME };

  // Refuses by name when a role holds fewer than three, before any roll
  // (UC-39 2a). The sentence is Task 74's and is passed through unaltered —
  // it names every thin role, and restating it here would be a second copy.
  const drawn = drawHand(drawableByRole(await listHeroes(event.gameId, database)), random);
  if (!drawn.ok) return { ok: false, error: drawn.error };

  /*
   * The one write. Either this call wins the pair or somebody else already has
   * it (UC-39 3b) — `returning()` empty *is* the answer, and asking beforehand
   * would be the race.
   */
  const [stored] = await database
    .insert(heroHands)
    .values({ eventId, userId, heroIds: flatten(drawn.hand) })
    .onConflictDoNothing({ target: [heroHands.eventId, heroHands.userId] })
    .returning();

  if (stored) {
    // `dealtAt` from the row rather than from a clock here, so the hand says
    // when Postgres stored it and a later read of the same row agrees.
    return { ok: true, hand: { heroes: drawn.hand, dealtAt: stored.dealtAt }, alreadyHeld: false };
  }

  /*
   * Lost the pair. The hand that is stored is the hand, and both callers see
   * the same nine (UC-39 3b) — this call's nine are discarded, never shown.
   *
   * The null branch is UC-39 5a: the insert stored nothing and there is nothing
   * to read, so nothing is reported as drawn and the participant may click
   * again. Nothing was written by this call, so the refusal is honest rather
   * than the lie decision 004 is about.
   */
  const winner = await handFor(eventId, userId, database);
  if (winner) return { ok: true, hand: winner, alreadyHeld: true };
  return { ok: false, error: HAND_NOT_STORED };
}
