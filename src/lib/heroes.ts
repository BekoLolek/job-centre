/**
 * The hero catalogue: what a game's heroes are, and which of them a draw may
 * deal (R-214 / UC-40; the multi-role Constraint in docs/requirements.md).
 *
 * This is the data layer only. The deal itself — nine heroes, three per role,
 * from an injected source of randomness — is Task 74's `heroes-policy.ts`. What
 * lives here is the part every caller needs: reading a game's heroes, grouping
 * the drawable ones by role, the one rule about roles that has to hold before
 * anything is written, and the five writes behind the admin screen.
 *
 * ## The writes (R-214 / UC-40, Task 77)
 *
 * `createHero`, `renameHero`, `setHeroRoles`, `retireHero` and `restoreHero`
 * are the bottom half of `HeroEditor`. They are down here rather than in the
 * component for the reason every rules module on this site gives: a server
 * action is a public endpoint, so the validation has to live somewhere a test
 * can call directly against a real Postgres, and the screen's copy has to be
 * the same strings the refusals are. Those strings are exported from here.
 *
 * **Nothing deletes a hero**, and that is the whole shape of the retire half —
 * see `retireHero`, and `HERO_RETIRING_EXPLAINER` in `HeroEditor.tsx` for the
 * sentence that says so on screen.
 *
 * The screen's own copy lives in the component rather than here, and that is
 * the boundary rather than an oversight: this module reaches Postgres, so a
 * `"use client"` file that value-imported from it would drag Drizzle and the
 * database client into the browser bundle. `FormatTab.tsx` carries the same
 * note against `src/lib/format.ts`. What belongs here is what the *writes*
 * return — the refusal sentences below — because a test has to be able to
 * assert that the string the screen shows is the string the write produced.
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
import type { AdminResult } from "./admin-games";

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

/** Every game's heroes at once, keyed by game id (Task 77's screen loads all of them). */
export async function listHeroesByGame(
  database: Database = defaultDb
): Promise<Record<string, Hero[]>> {
  const rows = await database.select().from(heroes).orderBy(asc(heroes.name));
  const out: Record<string, Hero[]> = {};
  for (const hero of rows) (out[hero.gameId] ??= []).push(hero);
  return out;
}

/* ------------------------------------------------------------------ */
/* Editing the list (R-214 / UC-40)                                   */
/* ------------------------------------------------------------------ */

/**
 * The longest a hero's name may be. The same 60 the game and rank boxes use, so
 * the `maxLength` on the input and the slice here agree.
 */
const NAME_MAX = 60;

/**
 * Trim and collapse, exactly as `cleanName` does for a game.
 *
 * `" Thor"` and `"Thor"` are two rows to Postgres and one hero to a reader —
 * `heroes.test.ts` already asserts the seeded roster carries no padded name for
 * that reason, and a name arriving from a form is where one would come from.
 */
function cleanHeroName(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().replace(/\s+/g, " ").slice(0, NAME_MAX) : "";
}

/**
 * The name some *other* hero of this game already carries (UC-40 3a), or null.
 *
 * Returns the stored spelling rather than a boolean, because the refusal names
 * it and "Venom is already on the list" is only useful if it prints the name
 * that is actually there. Folded for case and space for `nameTaken`'s reason:
 * "Venom" and "venom" are the same hero to everyone except `=`.
 *
 * **Deliberately stricter than the database.** `heroes_game_name_uniq` is on
 * the exact bytes, so Postgres would happily store "venom" beside "Venom"; this
 * is what stops the admin creating a pair only a reader can tell apart.
 */
async function heroNameTaken(
  database: Database,
  gameId: string,
  name: string,
  exceptId?: string
): Promise<string | null> {
  const rows = await database
    .select({ id: heroes.id, name: heroes.name })
    .from(heroes)
    .where(eq(heroes.gameId, gameId));
  const wanted = name.toLowerCase();
  const clash = rows.find((row) => row.id !== exceptId && row.name.toLowerCase() === wanted);
  return clash?.name ?? null;
}

/* --- The sentences, each one distinct ----------------------------- */

/**
 * UC-40 3a, naming the name.
 *
 * Exported so the screen and the tests read one string. The three refusals
 * below share no phrase with each other on purpose: a `toContain` on a fragment
 * two of them carried is how a refusal assertion on this plan last went green
 * for the wrong reason, so each is asserted whole with `toBe`.
 */
export function heroNameTakenRefusal(name: string): string {
  return `${name} is already on this game's hero list.`;
}

/** A hero with no name at all — there is nothing to put on a card. */
export const HERO_NAME_REQUIRED = "Give the hero a name.";

/**
 * UC-40 3b, in the words the use case uses.
 *
 * A hero in no role can never be drawn, so storing one would make the list lie
 * about what the game has rather than record a hero being unavailable —
 * retiring is the control for that, and it is on every row.
 */
export const HERO_ROLE_REQUIRED =
  "Tick at least one role. A hero in no role can never be dealt, so the list would be " +
  "saying this hero exists and cannot appear — retire it instead.";

/** The row vanished between the render and the click. */
export const HERO_GONE = "That hero is no longer on the list.";

/* --- The writes --------------------------------------------------- */

/**
 * Add a hero (UC-40 3, 3a, 3b, 3c).
 *
 * `parseHeroRoles` is the only role validator — it canonicalises the order,
 * de-duplicates, drops anything that is not a role, and comes back **empty** as
 * its refusal, which is the length check below. A second validator here would
 * be a second answer to one question, and the pair would drift.
 *
 * Both refusals are returned rather than thrown, and both are checked *before*
 * the insert, so the admin reads a sentence instead of a Postgres error.
 * `heroes_game_name_uniq` and `heroes_roles_distinct_nonempty` still stand
 * underneath and still refuse the same two things — that is the point of them.
 * A refusal that reaches the database is a worse version of this same answer,
 * not a different one.
 */
export async function createHero(
  gameId: string,
  rawName: string,
  rawRoles: unknown,
  database: Database = defaultDb
): Promise<AdminResult<Hero>> {
  const name = cleanHeroName(rawName);
  if (!name) return { ok: false, error: HERO_NAME_REQUIRED };

  const roles = parseHeroRoles(rawRoles);
  if (roles.length === 0) return { ok: false, error: HERO_ROLE_REQUIRED };

  const taken = await heroNameTaken(database, gameId, name);
  if (taken) return { ok: false, error: heroNameTakenRefusal(taken) };

  const [created] = await database.insert(heroes).values({ gameId, name, roles }).returning();
  return { ok: true, data: created };
}

/**
 * Rename a hero, keeping its id and therefore every hand that holds it.
 *
 * Returns the name it used to carry, because that is the only place the old
 * name survives the write — the action needs it for the audit line and the
 * screen has already warned about it.
 *
 * ## The (game, name) trap, which this function does not fix
 *
 * **A hero is identified by `(game, name)`.** There is no stable `key` column:
 * Task 73 declined one deliberately, and adding one now would be the migration
 * Task 77 is not allowed to run. So a rename *vacates* `(game, old name)`.
 * `plantHeroes` in `src/db/seed.ts` skips a pair that is **present** and has no
 * way to know one used to be, so the next run of the seed — or of
 * `scripts/seed-heroes.sql` — finds the old name free and plants it again, as a
 * second row beside the renamed one. Its own docblock states this, and
 * `src/db/__tests__/seed.test.ts` asserts it rather than leaving it a claim.
 *
 * This function does not and should not prevent that: renaming is a thing an
 * admin legitimately wants, and the roster the seed carries is not knowable
 * from here. What must not happen is the screen presenting a rename as though
 * it changed one hero's identity when it has also scheduled a second hero. So
 * `HeroEditor` refuses to write one without a confirm carrying
 * `heroRenameSeedWarning`, and `hero.renamed` records **both** names — after
 * this write, nothing on the row says the hero was ever called anything else,
 * and the audit line is the only way to recognise the duplicate when it lands.
 *
 * Retire-and-insert was the alternative considered and rejected. It would block
 * the re-plant, because the old name would still be occupied — but it is not a
 * rename: it gives the hero a new id, leaves a retired stub behind every
 * corrected typo, and splits one hero's history across two rows.
 */
export async function renameHero(
  heroId: string,
  rawName: string,
  database: Database = defaultDb
): Promise<AdminResult<{ hero: Hero; previousName: string }>> {
  const name = cleanHeroName(rawName);
  if (!name) return { ok: false, error: HERO_NAME_REQUIRED };

  const [existing] = await database
    .select()
    .from(heroes)
    .where(eq(heroes.id, heroId))
    .limit(1);
  if (!existing) return { ok: false, error: HERO_GONE };

  const taken = await heroNameTaken(database, existing.gameId, name, heroId);
  if (taken) return { ok: false, error: heroNameTakenRefusal(taken) };

  const [updated] = await database
    .update(heroes)
    .set({ name })
    .where(eq(heroes.id, heroId))
    .returning();
  return { ok: true, data: { hero: updated, previousName: existing.name } };
}

/**
 * Change which roles a hero may be played in (UC-40 3b, 3c).
 *
 * The rework case the use case exists for, and the one that must accept all
 * three at once: Deadpool is why `roles` is a set rather than a column.
 */
export async function setHeroRoles(
  heroId: string,
  rawRoles: unknown,
  database: Database = defaultDb
): Promise<AdminResult<Hero>> {
  const roles = parseHeroRoles(rawRoles);
  if (roles.length === 0) return { ok: false, error: HERO_ROLE_REQUIRED };

  const [updated] = await database
    .update(heroes)
    .set({ roles })
    .where(eq(heroes.id, heroId))
    .returning();
  return updated ? { ok: true, data: updated } : { ok: false, error: HERO_GONE };
}

/**
 * Take a hero out of future draws (UC-40 4a).
 *
 * Writes `retired_at` and touches nothing else. `drawableByRole` is what makes
 * that mean anything — it skips a retired row — and a stored hand reads its own
 * hero rows, so the hand keeps the hero. There is no delete here and there is
 * not meant to be: deleting the row would either break those hands or silently
 * rewrite what was dealt.
 *
 * `existing.retiredAt ?? now` for `retireField`'s reason: retiring twice must
 * not move the date, because the second click would otherwise rewrite when it
 * happened.
 *
 * `HERO_RETIRING_EXPLAINER` in `HeroEditor.tsx` is the sentence this is
 * documented against, and a test pins the two together.
 */
export async function retireHero(
  heroId: string,
  database: Database = defaultDb,
  now: Date = new Date()
): Promise<AdminResult<Hero>> {
  const [existing] = await database
    .select()
    .from(heroes)
    .where(eq(heroes.id, heroId))
    .limit(1);
  if (!existing) return { ok: false, error: HERO_GONE };

  const [updated] = await database
    .update(heroes)
    .set({ retiredAt: existing.retiredAt ?? now })
    .where(eq(heroes.id, heroId))
    .returning();
  return { ok: true, data: updated };
}

/** Put a hero back in the draw. The row never left, so nothing is rebuilt. */
export async function restoreHero(
  heroId: string,
  database: Database = defaultDb
): Promise<AdminResult<Hero>> {
  const [updated] = await database
    .update(heroes)
    .set({ retiredAt: null })
    .where(eq(heroes.id, heroId))
    .returning();
  return updated ? { ok: true, data: updated } : { ok: false, error: HERO_GONE };
}
