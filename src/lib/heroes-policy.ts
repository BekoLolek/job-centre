/**
 * The draw itself — nine heroes, three in each role (R-209, R-210 / UC-39 4,
 * 4a, 2a).
 *
 * No database and no React, which is the whole reason this file is not part of
 * the draw page: the only interesting things here are whether the three in a
 * role are distinct, whether every hero in a pool can actually be dealt, and
 * what happens when a role is too thin to deal from — and all three are
 * answerable with a list and a sequence of numbers on a desk.
 * `src/lib/heroes.ts` hands over the pools (`drawableByRole`), Task 75 stores
 * the hand, and Task 76 reveals it a card at a time.
 *
 * ## Randomness is injected, never called
 *
 * Nothing in this file reaches for `Math.random`, and nothing it imports does
 * either. A function that does cannot be tested — "it looked random" is not
 * evidence, and this is the one place on the site where that matters — so the
 * source arrives as a parameter and the action layer is the one place that
 * passes the real one. `heroes-policy.test.ts` hands it a known sequence and
 * asserts the exact nine that come out, and it proves the injection rather than
 * asserting it: it deletes `Math.random` from the global object, replaces it
 * with a thrower, and runs the whole draw again.
 *
 * The shuffle is {@link shuffled} from `src/lib/random-teams.ts` rather than a
 * second Fisher-Yates written out here. Both halves of section K deal a list
 * out at random against an injected generator, and the off-by-one that makes a
 * third of the permutations unreachable is documented and mutation-proved
 * there; a copy in this file would be a second thing to keep uniform and a
 * second thing to get wrong. The module name says teams, but the function is
 * about lists.
 *
 * ## Distinct within a role, repeating freely across players
 *
 * A player's three Vanguards are distinct from each other, because dealing
 * somebody the same hero twice is a wasted roll. Across players they repeat as
 * often as the draw happens to repeat them, which the pool sizes force rather
 * than permit: 13 drawable Strategists against six players needing three each
 * cannot be made unique (UC-39 4a). Nothing in this file knows about other
 * players, so there is nothing here to enforce.
 *
 * A hero holding several roles may appear in more than one of a player's
 * role-sets — somebody can hold Deadpool as a Vanguard *and* as a Duelist.
 * That looks like a bug the first time it is seen and it is correct: the three
 * draws are three separate draws from three separate pools.
 */

import type { Hero, HeroRole } from "@/db";
import { HERO_ROLES } from "@/lib/heroes";
import { shuffled } from "@/lib/random-teams";

/**
 * Three in each role, so nine in a hand (R-210).
 *
 * Named rather than written as a literal in four places because the refusal
 * sentence quotes it, and a guard that refuses below three while the deal takes
 * four would be a draw that passes its own check and then throws.
 */
export const HEROES_PER_ROLE = 3;

/** What a player holds: {@link HEROES_PER_ROLE} heroes under each role. */
export type HeroHand = Record<HeroRole, Hero[]>;

export type HeroDrawResult =
  | { ok: true; hand: HeroHand }
  | { ok: false; error: string };

/**
 * The heroes a role can actually deal, with any row repeated inside a single
 * pool counted once.
 *
 * `drawableByRole` cannot produce a repeat today — `heroes_roles_distinct_
 * nonempty` refuses a row whose `roles` array holds the same role twice — but
 * the three-are-distinct promise is this module's to keep, and a pool of
 * `[A, A, B]` would otherwise clear the "at least three" guard and then deal A
 * twice. Counting distinct heroes is what makes the guard and the promise the
 * same question.
 */
function distinctPool(pool: readonly Hero[]): Hero[] {
  return [...new Map(pool.map((hero) => [hero.id, hero])).values()];
}

/** "a", "a and b", "a, b and c" — the refusal names every thin role, not the first. */
function sentenceList(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Deal a hand from these pools, or say which role is too thin to deal from.
 *
 * ## The refusal comes before anything is dealt (UC-39 2a)
 *
 * Every role is counted first, and a role holding fewer than
 * {@link HEROES_PER_ROLE} heroes refuses the whole draw **by name**. A partial
 * hand is worse than none: a player holding three Vanguards, three Duelists and
 * one Strategist has to find out on the night that the site let them draw, and
 * the thing to fix — a hero list with two Strategists on it — is an admin
 * screen away and nothing to do with them. Naming the role is what turns the
 * refusal into an instruction.
 *
 * Every thin role is named, not just the first one found, because a game whose
 * hero list was half filled in has two or three of them and an admin who fixes
 * one and is refused again learns the count one deployment at a time.
 *
 * ## One shuffle per role, taken from the front
 *
 * Each pool is shuffled whole and the first {@link HEROES_PER_ROLE} taken. A
 * partial shuffle — three passes over a 28-hero pool rather than 27 — would
 * deal the same distribution for nine numbers instead of 53, and it is still
 * not worth writing: the saving is 44 floats once per player per night, and the
 * cost is a second shuffle to audit beside the one function in the repo whose
 * uniformity is proved by enumeration.
 *
 * The roles are walked in {@link HERO_ROLES} order, so the generator is
 * consumed Vanguard, then Duelist, then Strategist. A test predicting an exact
 * hand from a known sequence is predicting that order and how many numbers each
 * role burns, which is why the order is taken from the shared constant rather
 * than written out again here.
 */
export function drawHand(
  pools: Record<HeroRole, readonly Hero[]>,
  random: () => number
): HeroDrawResult {
  const drawable = Object.fromEntries(
    HERO_ROLES.map((role) => [role, distinctPool(pools[role])])
  ) as Record<HeroRole, Hero[]>;

  const thin = HERO_ROLES.filter((role) => drawable[role].length < HEROES_PER_ROLE).map(
    (role) => {
      const held = drawable[role].length;
      return `${role} has ${held} ${held === 1 ? "hero" : "heroes"}`;
    }
  );

  if (thin.length > 0) {
    return {
      ok: false,
      error: `${sentenceList(thin)}. A draw needs ${HEROES_PER_ROLE} in each role, so nothing was dealt. Add more on the game's hero list.`,
    };
  }

  return {
    ok: true,
    hand: Object.fromEntries(
      HERO_ROLES.map((role) => [
        role,
        shuffled(drawable[role], random).slice(0, HEROES_PER_ROLE),
      ])
    ) as HeroHand,
  };
}
