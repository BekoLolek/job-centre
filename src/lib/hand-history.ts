/**
 * How many nights each hero has come up for one player (R-245 / UC-48 5, 4c,
 * 5a).
 *
 * An admin opens a player's hand history to answer one question — *has Bob had
 * Hulk three weeks running?* — and this module is the number in that answer:
 * every hero the player has been dealt, and on how many nights, most nights
 * first. The page lists the hands themselves beside it; this is the tally.
 *
 * ## Why this is a function rather than a few lines in the panel
 *
 * For the reason `handSheet` in `src/lib/hands-sheet.ts` is: the same lines
 * inside a component could not be mutation-proved in a node suite with nothing
 * to click, and these lines decide what an admin believes about a run of
 * repeats. One rule in particular could silently answer a different question
 * than the one asked, and it is the rule `hand-history.test.ts` is built around:
 *
 * **A hero in two slots of one hand is one night, not two cards** (UC-48 4c).
 * Deadpool is playable as Vanguard, Duelist and Strategist, so a single hand
 * can name him twice — `hero-hands.ts` says why the slot, not the id, is the
 * key. A tally that walked the nine slots and incremented per slot would report
 * "2 nights" for a hero who came up once, and nothing on screen would look
 * wrong. The question is about recurrence *across* nights, so each hand is
 * first reduced to the set of distinct ids in it, and only then counted.
 *
 * ## No value imports, on purpose
 *
 * A `"use client"` panel may hold this module and the server page that feeds
 * it may too, so it is read by both sides. `client-boundary.test.ts` says why
 * that is a runtime contract and not a type. Every import here is
 * `import type` — erased before either runtime sees it — and the test asserts
 * that on the file's text, the way the boundary sweep does. `@/db` is named
 * only for {@link Hero} and {@link HeroRole}; a value from it would carry
 * Postgres into the browser. In particular `HERO_ROLES` is not imported: the
 * roles of a hand are walked with `Object.values`, which also means a fourth
 * role would be counted without this file being edited.
 *
 * ## The hands arrive in the narrowest shape this reads
 *
 * {@link TalliedHand} is declared here rather than imported, the way
 * `src/app/events/[slug]/draw/draw.ts` declares `StoredHandReader` to
 * `hero-hands.ts`'s published contract and `hands-sheet.ts` declares
 * `SheetHands`: the per-player read (`handsOfPlayer`) is being written
 * alongside this, and it returns hands that carry the event they came from
 * and when they were dealt. This module reads none of that. Its one fact is
 * *one hand is one night*, and from each hand it reads only the hero lists,
 * and from each hero only `id` and `name`. Declaring exactly that is what lets
 * the test build a night from two strings per hero, and what keeps the
 * sibling's shape free to change around the two fields this needs. A
 * `StoredHand` satisfies it as it is; `hand-history.test.ts` passes one in so
 * `tsc` would refuse the pair drifting apart.
 *
 * `id` is the identity: a hand is the rows it was dealt and not the names they
 * carried (`hero-hands.ts`, UC-47 2c), so a hero renamed between two nights is
 * still one hero on two nights. `name` is read for the tie order below and so
 * the screen can name the row without a second lookup.
 *
 * ## Most nights first, then by name, then by id — stated, not incidental
 *
 * R-245 asks for most-repeated first, and that is the primary key. Ties need a
 * stated order rather than whatever the grouping happened to produce, because
 * an unstated order is a screen that reshuffles itself between reads: the
 * hands arrive newest first, so a new night would reorder every hero on equal
 * nights. Name is the order chosen, because it is the one a reader can
 * predict and scan — an id is a uuid and means nothing on screen. Then id,
 * because a player's hands span events and two games may each carry a "Hulk":
 * name alone cannot separate them and the order would otherwise fall back to
 * insertion order, which is the unstated order this paragraph exists to
 * forbid. Both keys compare with `localeCompare`, as every name sort in `src/`
 * does (`events-policy.ts`, `availability.ts`, the listing components).
 *
 * ## What this module does not do
 *
 * It does not list a hero the player has never had (UC-48 5a): the tally is
 * what they have had, not the catalogue, and it has no catalogue to list from.
 * It does not count per role or per event, find a streak of consecutive
 * events, or compute an expected frequency or a fairness verdict — the
 * requirement asks for a count, and the page beside it lists the hands, which
 * is where "three weeks running" is read off. It does not format anything:
 * the screen writes "4 nights".
 */

import type { Hero, HeroRole } from "@/db";

/** The two fields of a hero the tally reads: the identity, and the name to order and show by. */
export type TalliedHero = Pick<Hero, "id" | "name">;

/**
 * One night, as the tally sees it: the hero lists of one hand. `StoredHand`
 * from `hero-hands.ts` satisfies this; the module note says why the rest of it
 * is not named here.
 */
export type TalliedHand = {
  heroes: Readonly<Record<HeroRole, readonly TalliedHero[]>>;
};

/** One row of the tally: a hero the player has had, and on how many nights. */
export type HeroNights = {
  /** The hero as it arrived in the first hand that named it. */
  hero: TalliedHero;
  /** How many of the hands name this hero at least once. Never zero. */
  nights: number;
};

/**
 * Every hero that has come up for one player, and on how many nights — most
 * nights first, then by name, then by id (UC-48 5).
 *
 * One hand is one night. A hero in two slots of the same hand counts that
 * night once (UC-48 4c). A hero in none of the hands is absent (UC-48 5a). No
 * hands gives an empty tally.
 */
export function heroNights(hands: readonly TalliedHand[]): HeroNights[] {
  const tally = new Map<string, HeroNights>();

  for (const hand of hands) {
    // The distinct heroes of this night, before anything is counted — this is
    // the line UC-48 4c lives on.
    const tonight = new Map<string, TalliedHero>();
    for (const slot of Object.values(hand.heroes)) {
      for (const hero of slot) tonight.set(hero.id, hero);
    }

    for (const [id, hero] of tonight) {
      const entry = tally.get(id);
      if (entry) entry.nights += 1;
      else tally.set(id, { hero, nights: 1 });
    }
  }

  return [...tally.values()].sort(
    (a, b) =>
      b.nights - a.nights ||
      a.hero.name.localeCompare(b.hero.name) ||
      a.hero.id.localeCompare(b.hero.id)
  );
}
