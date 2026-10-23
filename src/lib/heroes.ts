/**
 * The hero catalogue: what a game's heroes are, and which of them a draw may
 * deal (R-214 / UC-40; the multi-role Constraint in docs/requirements.md).
 *
 * This is the data layer only. The deal itself — nine heroes, three per role,
 * from an injected source of randomness — is Task 74's `heroes-policy.ts`, and
 * the admin screen that adds, renames and retires is Task 77. What lives here
 * is the part both of those need: reading a game's heroes, grouping the
 * drawable ones by role, and the one rule about roles that has to hold before
 * anything is written.
 *
 * ## Roles are a set
 *
 * `heroes.roles` is an array of the `hero_role` enum rather than a column, and
 * Deadpool is the reason rather than an illustration of it: he is playable as
 * Vanguard, Duelist **and** Strategist, so the roster of 54 at Season 10.5 is
 * 14 + 27 + 12 plus one hero in all three — which is why the pools this module
 * hands the draw are **15 / 28 / 13** and not 14 / 27 / 12. `src/db/schema.ts`
 * and drizzle/0031 carry the long form of the argument.
 *
 * A consequence worth stating, because it looks like a bug the first time it is
 * seen on screen: the same hero legitimately appears in more than one pool, so
 * summing the pool sizes gives 56 rather than 54. The row count is the number
 * of heroes; the pool sizes are what each role can deal from.
 */

import { asc, eq } from "drizzle-orm";
import {
  type Database,
  type Hero,
  type HeroRole,
  db as defaultDb,
  heroRole,
  heroes,
} from "@/db";

/**
 * The three roles, in the order the draw deals and the screen reads them.
 *
 * Taken from the enum rather than written out again, so the database's idea of
 * the roles and the code's cannot drift: adding a fourth would be a migration
 * and this list would follow it without being edited.
 */
export const HERO_ROLES: readonly HeroRole[] = heroRole.enumValues;

/**
 * Clean a set of roles that arrived from outside — a form, a seed literal, a
 * server action's `FormData`.
 *
 * Returns the roles in `HERO_ROLES` order, de-duplicated, with anything that is
 * not a role dropped. **An empty result is the refusal** (UC-40 3b): a hero in
 * no role can never be drawn, so a list containing one is the list lying rather
 * than a hero being unavailable. Every caller has to look at the length.
 *
 * This is the code half of a rule the database also holds —
 * `heroes_roles_distinct_nonempty` refuses the same thing in SQL. Both halves
 * are deliberate: the check constraint is what makes it true of rows written by
 * anything at all, and this is what lets a screen say so in words instead of
 * showing somebody a Postgres error.
 */
export function parseHeroRoles(raw: unknown): HeroRole[] {
  const values = Array.isArray(raw) ? raw : [raw];
  return HERO_ROLES.filter((role) => values.includes(role));
}

/** Every hero of one game, retired ones included, by name. */
export async function listHeroes(
  gameId: string,
  database: Database = defaultDb
): Promise<Hero[]> {
  return database
    .select()
    .from(heroes)
    .where(eq(heroes.gameId, gameId))
    .orderBy(asc(heroes.name));
}

/**
 * The pools a draw deals from: the heroes holding each role, retired ones left
 * out (UC-40 4a — a retired hero is not dealt again, and a hand that already
 * holds it still names it, because the row is still there).
 *
 * Every role is a key even when its pool is empty, so a caller counting them
 * sees `0` rather than `undefined`. Deadpool is in three of these lists at
 * once, which is the whole point of the set.
 */
export function drawableByRole(catalogue: readonly Hero[]): Record<HeroRole, Hero[]> {
  const pools = Object.fromEntries(HERO_ROLES.map((role) => [role, [] as Hero[]])) as Record<
    HeroRole,
    Hero[]
  >;
  for (const hero of catalogue) {
    if (hero.retiredAt !== null) continue;
    for (const role of hero.roles) pools[role].push(hero);
  }
  return pools;
}
