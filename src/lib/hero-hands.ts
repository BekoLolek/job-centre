/**
 * Where a dealt hand lives: dealt once, and it stands (R-212 / UC-39 3a, 3b,
 * 5a, 6a).
 *
 * The storage half of the draw, and the only half that touches Postgres.
 * `heroes-policy.ts` decides *which* nine (Task 74, no database, randomness
 * injected); `heroes.ts` supplies the catalogue and the pools; this file is the
 * five sentences in between — "what does this participant already hold",
 * "deal them one if they hold nothing", "what does everybody on this event
 * hold", "what has this player been dealt, night after night", and "who has
 * been dealt anything at all" — with three callers: Task 76's draw page for
 * the first two, the manager's hands sheet (R-239 / UC-47) for the third, and
 * the admin's player history (R-244, R-246 / UC-48) for the last two.
 *
 * Three readers of hands — {@link handFor}, {@link handsFor},
 * {@link handsOfPlayer} — and one pair of private functions under them:
 * `heroesNamedBy` reads the rows a set of hands name, retired and renamed
 * included, and `unflatten` rebuilds the hand's slots from those rows. Every reader
 * goes through both, so no two screens can disagree about whether a retired
 * hero is still named or which slot is which role; the tests assert each later
 * reader against {@link handFor} hand for hand, which is what keeps that true.
 * {@link playersWithHands} is the fourth read of the table but not of hands:
 * it counts rows and names nobody's heroes, so it has nothing to rebuild.
 *
 * It is a module of its own rather than more of `heroes.ts` because the two
 * answer different questions about different tables: that file is the hero
 * *catalogue* and the admin screen underneath it, this one is the rows of
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

import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import {
  type Database,
  type Hero,
  type HeroRole,
  db as defaultDb,
  events,
  heroHands,
  heroes,
  users,
} from "@/db";
import { eventShapeFrom } from "@/lib/events-policy";
import { HERO_ROLES, drawableByRole, listHeroes } from "@/lib/heroes";
import { type HeroHand, drawHand } from "@/lib/heroes-policy";

/** What one participant holds for one event, and when they were dealt it. */
export type StoredHand = {
  heroes: Record<HeroRole, Hero[]>;
  dealtAt: Date;
};

export type HeroDealResult =
  | { ok: true; hand: StoredHand; alreadyHeld: boolean }
  | { ok: false; error: string };

/**
 * One night in a player's history: the hand, and the event it was dealt on
 * (UC-48 4).
 *
 * Joined to `events` for the title and slug, because a hand that cannot name
 * its night answers nothing — "Hulk three weeks running" is a claim about
 * *which* three weeks. The screen names the night and does not link it (UC-48
 * 5b: nothing on that page is clickable but the player picker), so the id is
 * here as the row's key and the slug for whoever does want a link; nothing
 * else of the event is, because nothing else is asked for.
 */
export type PlayerHand = StoredHand & {
  event: { id: string; title: string; slug: string };
};

/** A member who holds at least one hand, and on how many nights (UC-48 2). */
export type PlayerWithHands = {
  userId: string;
  displayName: string;
  /** How many hands — one per event, so how many nights they have drawn on. */
  hands: number;
};

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
 * The inverse: a hand's ids and the rows they name, back into three role lists.
 *
 * ## The width is read off the hand, not off the event
 *
 * `flatten` writes the same number of ids for every role, so the stored array
 * divides evenly across `HERO_ROLES` and the quotient is the width the hand
 * was dealt at. That is the only width that can rebuild it: an event's width
 * can be changed after a hand is dealt, and a hand dealt at another width is
 * shown as it was dealt (UC-58 7a) — so the event's present number is not
 * asked, and is not a parameter.
 *
 * **Throws on a length the roles do not divide.** Nothing writes one —
 * `flatten` cannot — and slicing by a fraction would put heroes under the
 * wrong role and say nothing, which is the same silent wrongness the next
 * paragraph refuses.
 *
 * Exported for `hero-hands.test.ts` alone, which proves it on widths the
 * database cannot yet store.
 *
 * **Throws on an id with no row.** It cannot happen through the site — nothing
 * deletes a hero, `retireHero` writes `retired_at` and leaves the row where it
 * is — and the one statement that could, a hard `delete` of a `games` row,
 * exists nowhere outside test teardown. If it ever did happen, a hand of eight
 * returned as though it were whole is the failure worth avoiding: the player
 * would see a gap and have no way to know it was not what they were dealt, and
 * nothing would be recorded anywhere. So it is loud.
 */
export function unflatten(
  heroIds: readonly string[],
  rows: readonly Hero[]
): Record<HeroRole, Hero[]> {
  const perRole = heroIds.length / HERO_ROLES.length;
  if (!Number.isInteger(perRole)) {
    throw new Error(
      `A stored hand holds ${heroIds.length} heroes, which does not divide evenly across ` +
        `${HERO_ROLES.length} roles. A hand is dealt the same number in every role, so ` +
        `this row was not written by the draw.`
    );
  }

  const byId = new Map(rows.map((hero) => [hero.id, hero]));
  const out = Object.fromEntries(HERO_ROLES.map((role) => [role, [] as Hero[]])) as Record<
    HeroRole,
    Hero[]
  >;

  HERO_ROLES.forEach((role, roleIndex) => {
    const from = roleIndex * perRole;
    for (const id of heroIds.slice(from, from + perRole)) {
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

/**
 * The hero rows a set of hands name — every reader's second query, and the one
 * place the rule about retirement lives.
 *
 * **No `retired_at` filter, deliberately** (UC-40 4a, UC-47 2b, UC-48 4b): the
 * rows are read by id and nothing else, which is what makes "what was dealt
 * stays dealt" true on every screen at once. A rename comes through as the new
 * name for the same reason — a hand is the rows it was dealt and not the names
 * they carried (UC-47 2c). `drawableByRole` is where retirement is honoured,
 * and it is about the *next* draw rather than any hand already held.
 *
 * One function rather than the same four lines in each reader, because all
 * three readers change for the same reason and a `retired_at` filter added to
 * one copy would break "what was dealt stays dealt" on one screen only — a
 * drift {@link unflatten} cannot catch, since it only sees the rows it is
 * handed. The third reader was the third strike.
 *
 * A second query rather than a join, because a hand of nine can name the same
 * hero twice — Deadpool in two roles — and a join would hand back eight rows
 * for nine cards and lose which slot each belonged to. So the ids are
 * de-duplicated for the `in` list, and {@link unflatten} rebuilds the slots
 * from each hand's stored order.
 *
 * Callers return their own empty value before reaching this, which keeps the
 * no-hands case off Drizzle's empty-`in` rule ({@link handsFor} has the
 * history). Handed an empty list, this would build exactly that `in`.
 */
async function heroesNamedBy(
  hands: readonly { heroIds: string[] }[],
  database: Database
): Promise<Hero[]> {
  return database
    .select()
    .from(heroes)
    .where(inArray(heroes.id, [...new Set(hands.flatMap((hand) => hand.heroIds))]));
}

/* --- Reading, and dealing ----------------------------------------- */

/**
 * The hand this participant already holds for this event, or null.
 *
 * The hero rows come through {@link heroesNamedBy}, which is where retired and
 * renamed heroes are kept in the hand (UC-40 4a) and where the de-duplicated
 * `in` list is argued; the slots are rebuilt from the stored order by
 * {@link unflatten}.
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

  const rows = await heroesNamedBy([row], database);

  return { heroes: unflatten(row.heroIds, rows), dealtAt: row.dealtAt };
}

/**
 * Every hand dealt on one event, keyed by the user id that holds it — the
 * manager's sheet (R-239, R-242 / UC-47 2, 2b, 2c, 2d).
 *
 * Each value is exactly what {@link handFor} returns for that participant, and
 * the two are built through the same two functions on purpose:
 * {@link heroesNamedBy} for the rows of every hand on the event, then
 * {@link unflatten} per hand. The sheet and the player's own screen read rows
 * and slots through one pair, so they cannot disagree about whether a retired
 * hero is still named (UC-47 2b), what a renamed one is called (UC-47 2c), or
 * which slot is which role (UC-47 2d — Deadpool in two slots is two cards). An
 * id with no row throws, from the same line the single read throws from.
 *
 * Keyed by user rather than returned as a list because that is the question
 * the sheet asks of it — "what does *this* seat hold" for each participant the
 * Applicants tab lists, in that tab's order (UC-47 2). Who holds a seat is not
 * decided here; this is every hand that exists, and an event nobody has drawn
 * on, or an id that names no event, is an empty record rather than a refusal.
 *
 * The early return is what keeps the no-hands case off Drizzle's empty-list
 * rule. What `inArray` does with `[]` is Drizzle's to decide and it has decided
 * it more than once: the installed 0.45.2 compiles it to `false`
 * (`node_modules/drizzle-orm/sql/expressions/conditions.js`, lines 73-76),
 * where earlier releases threw. Returning before the `in` list is ever built
 * means neither answer is this function's problem, and it is the shape the
 * file already has — {@link handFor}'s `if (!row) return null` is the same
 * line for one hand. That it also saves a query is incidental, and would not
 * on its own be a reason to keep it.
 */
export async function handsFor(
  eventId: string,
  database: Database = defaultDb
): Promise<Record<string, StoredHand>> {
  const hands = await database.select().from(heroHands).where(eq(heroHands.eventId, eventId));
  if (hands.length === 0) return {};

  const rows = await heroesNamedBy(hands, database);

  const out: Record<string, StoredHand> = {};
  for (const hand of hands) {
    out[hand.userId] = { heroes: unflatten(hand.heroIds, rows), dealtAt: hand.dealtAt };
  }
  return out;
}

/**
 * Every hand one player has been dealt, newest first, each naming the event it
 * came from — the admin's player history (R-244 / UC-48 4, 4b).
 *
 * The third reader of `hero_hands`, and built the way {@link handsFor} is: the
 * hands this player holds, {@link heroesNamedBy} for their rows, then
 * {@link unflatten} per hand. The tests assert it against {@link handFor} hand
 * for hand, so a hand in the history *is* the hand the player's own page shows
 * — retired and renamed heroes included (UC-48 4b), which is that function's
 * rule and not restated here.
 *
 * **Ordered by `dealt_at desc` in the query**, because that is the order the
 * screen reads and not the screen's job to impose: "have they had Hulk three
 * weeks running" is read top-down from the most recent night, and a list the
 * page had to sort would be a second place for the order to be wrong. Storage
 * order is not dealt order — nothing about a uuid primary key says when a row
 * went in — which is why the test dates its three hands out of insertion order.
 *
 * **Inner-joined to `events`**, so a hand names its night. A hand whose event
 * is gone cannot exist: `hero_hands.event_id` cascades on delete, so the join
 * drops nothing the table still holds.
 *
 * No filter by game, status or date — every hand this player holds, in
 * one order. A member who has never drawn, or an id that names nobody, is an
 * empty list rather than a refusal, and the early return keeps that case off
 * Drizzle's empty-`in` rule exactly as {@link handsFor}'s does.
 */
export async function handsOfPlayer(
  userId: string,
  database: Database = defaultDb
): Promise<PlayerHand[]> {
  const hands = await database
    .select({
      heroIds: heroHands.heroIds,
      dealtAt: heroHands.dealtAt,
      event: { id: events.id, title: events.title, slug: events.slug },
    })
    .from(heroHands)
    .innerJoin(events, eq(events.id, heroHands.eventId))
    .where(eq(heroHands.userId, userId))
    .orderBy(desc(heroHands.dealtAt));
  if (hands.length === 0) return [];

  const rows = await heroesNamedBy(hands, database);

  return hands.map((hand) => ({
    heroes: unflatten(hand.heroIds, rows),
    dealtAt: hand.dealtAt,
    event: hand.event,
  }));
}

/**
 * Every member who holds at least one hand, with their display name and how
 * many nights they have drawn on, most nights first — the picker on the
 * admin's player history (R-246 / UC-48 2).
 *
 * **One grouped query, not a read per player**, for `loadAdminGames`' reason
 * (`src/lib/admin-games.ts`): forty members would otherwise be forty round
 * trips, and on Neon that is forty HTTP requests. Postgres counts the hands and
 * orders the members; this function only names them. The test counts the
 * statements begun and asserts exactly one.
 *
 * Driven from `hero_hands` and joined *to* `users`, rather than the other way
 * round with a `left join` and a `having`, because the question is "who has
 * drawn" and not "which members have not": a member with no hand has no
 * history to show, so they are not in the result at all, and an inner join
 * from the hands is the shape that says so without a filter to forget.
 *
 * `hands` is a count of rows, and one row is one event (R-212's unique pair),
 * so it is also how many nights. Ties on nights are broken by display name,
 * and ties on that by id, so the picker holds still between loads: both name
 * columns are nullable, and two members with neither set on the same number
 * of nights would otherwise have no defined order at all. The terminal key is
 * the repo's idiom — `loadAdminUsers` ends on `createdAt`, and the notes read
 * in the same file on `id`, for this reason. The display name falls back to
 * `name` as `loadAdminUsers` does, and the fallback is the name of an account
 * rather than a refusal because the picker is a list of people who *have* a
 * hand, whatever their row says they are called.
 */
export async function playersWithHands(database: Database = defaultDb): Promise<PlayerWithHands[]> {
  const rows = await database
    .select({
      userId: users.id,
      displayName: users.displayName,
      name: users.name,
      hands: count(),
    })
    .from(heroHands)
    .innerJoin(users, eq(users.id, heroHands.userId))
    .groupBy(users.id)
    .orderBy(desc(count()), asc(users.displayName), asc(users.id));

  return rows.map((row) => ({
    userId: row.userId,
    displayName: row.displayName ?? row.name ?? "Unknown member",
    hands: Number(row.hands),
  }));
}

/**
 * Deal this participant a hand and store it, or hand back the one they already
 * hold. **Never deals twice** (R-212).
 *
 * `alreadyHeld` tells the two apart: `false` means these were dealt by
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
    .select({ gameId: events.gameId, config: events.config })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!event) return { ok: false, error: HAND_EVENT_GONE };
  if (!event.gameId) return { ok: false, error: HAND_NO_GAME };

  // Refuses by name when a role holds fewer than the event's width, before
  // any roll (UC-39 2a, UC-58 5a). The sentence is Task 74's and is passed
  // through unaltered — it names every thin role and the width it needed, and
  // restating it here would be a second copy. The width is the event's own
  // (R-270), read off the row this call already holds.
  const drawn = drawHand(
    drawableByRole(await listHeroes(event.gameId, database)),
    random,
    eventShapeFrom(event.config).heroesPerRole
  );
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
