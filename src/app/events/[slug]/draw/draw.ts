/**
 * What one player is given about their draw, assembled on the server
 * (R-211, R-213 / UC-39 1, 1a, 1b, 2, 2a, 6, 6a, 7a; R-269 / UC-58 3a).
 *
 * The page renders one of seven screens and this module decides which. It is a
 * route-local loader for the same reason `draft/room.ts` is one: what it
 * assembles is this screen's answer to "what is in front of you", built out of
 * libraries that each own their own half, and there is nothing in it another
 * caller wants.
 *
 * ## The hand is decided before the first card turns, and this is where that is
 * held
 *
 * R-212 is the whole of the shape here. A hand is dealt by `dealFor` in
 * `src/lib/hero-hands.ts`, inside a transaction, against a unique index on
 * (event, user) — and only ever by the server action. Nothing in the browser
 * deals, and nothing in the browser is sent a pool it *could* deal from: a
 * `ready` payload carries either the hand that is already stored — at the
 * width the row holds, whatever the event asks for now (R-271) — or null.
 * There is no third case, and in particular there is no list of drawable heroes
 * in the payload, because a reveal holding the pool is one refresh away from
 * being a reroll.
 *
 * So the reveal in `HandReveal.tsx` can only ever uncover. `reveal.ts` has the
 * other half of that argument.
 *
 * ## Why `handFor` arrives as a parameter
 *
 * {@link loadDraw} takes the stored-hand read rather than importing it. That is
 * not indirection for its own sake: it is how the seven screens below are
 * testable as decisions. A hand that is stored, a hand that is not, and a game
 * whose list is too thin are three different answers to one question, and
 * injecting the read means a test states the stored hand instead of arranging a
 * deal to produce one. `page.tsx` passes the real `handFor` and is the only
 * file here that names it.
 *
 * The signature is `src/lib/hero-hands.ts`'s exactly, including the optional
 * `database`, so the page passes the function straight through with no adapter
 * to fall out of step.
 */

import { and, eq } from "drizzle-orm";
import {
  type Database,
  type Hero,
  type HeroRole,
  applications,
  db as defaultDb,
} from "@/db";
import type { EventDetail } from "@/lib/events";
import { type TeamFormat, eventShapeFrom, teamFormatFrom } from "@/lib/events-policy";
import { HERO_ROLES, drawableByRole, listHeroes } from "@/lib/heroes";
import { drawHand } from "@/lib/heroes-policy";
import type { RevealCard } from "./reveal";

/**
 * A stored hand, as `src/lib/hero-hands.ts` returns one.
 *
 * Declared to that module's published contract rather than imported from it:
 * see the module note on why the read is a parameter. `heroes` is full rows
 * with ids (Task 74's note: a hand survives a later rename, because the hand is
 * the rows and not the names it was dealt under).
 */
export type StoredHand = { heroes: Record<HeroRole, Hero[]>; dealtAt: Date };

/** `handFor` from `src/lib/hero-hands.ts`, to the letter. */
export type StoredHandReader = (
  eventId: string,
  userId: string,
  database?: Database
) => Promise<StoredHand | null>;

/**
 * Which of the seven screens, and everything it needs.
 *
 * A union rather than a bag of nullable fields, so the page cannot render the
 * draw button on a screen that refused the draw — the thing UC-39 1a and 1b
 * both exist to stop ("told so rather than shown an empty draw").
 *
 * ## Which answers refuse a deal, and which one shows a hand
 *
 * Two different questions are answered here, and they pull apart the moment a
 * setting changes after somebody has drawn:
 *
 *  - **"May the next hand be dealt?"** `draw_off`, `no_game`, `no_heroes` and
 *    `too_thin` all say no, each for its own reason, and `ready` with
 *    `hand: null` says yes. These are only ever given to a player who holds
 *    nothing.
 *  - **"What does this player already hold?"** `ready` with a `hand` — and
 *    nothing else. It is the answer whenever a hand is stored, whatever the
 *    event says now: the draw turned off, the game taken away, the list
 *    emptied, the width changed. None of the four refusals above can be given
 *    to somebody who holds a hand, because none of them is about them.
 *
 * `former_seat` is the second question answered for somebody the first no
 * longer includes: a hand is stored and its holder has no seat now. It is its
 * own kind, rather than `ready` with a flag or `no_seat` with a hand, so that
 * neither the page nor the action can treat it as one of those by default —
 * see {@link loadDraw} for why the hand is shown at all.
 *
 * `no_seat` is neither: it is "this page is not yours", and it is only ever
 * given to somebody who holds nothing here.
 */
export type DrawPayload =
  /**
   * UC-39 1a. No seat at this event and no hand from it, so there is nothing
   * to deal them and nothing of theirs to show.
   */
  | { kind: "no_seat" }
  /**
   * They drew, and then the seat went — withdrawn, declined, or moved to the
   * queue. The hand is still shown, to its owner, as the record of a draw that
   * happened (R-212, R-271; the manager's sheet keeps the same row, UC-47 3a).
   * `hand` is never null here and no draw is on offer: this kind is never
   * given to somebody who holds nothing, and the action refuses it.
   */
  | {
      kind: "former_seat";
      format: TeamFormat;
      roles: readonly HeroRole[];
      /** The hand's own width, as on a held `ready`. */
      perRole: number;
      hand: RevealCard[];
    }
  /**
   * R-269 / UC-58 3a. The manager turned the draw off for this event, so no
   * hand is dealt on it. A decision, not a fault — the screen says so.
   */
  | { kind: "draw_off" }
  /** The event has no game, so there is no list to deal from. */
  | { kind: "no_game" }
  /**
   * UC-39 1b. The game exists and its hero list is empty. Named, not blank —
   * and carrying the event's width (R-270), because the sentence on that
   * screen says how many the draw needs in each role.
   */
  | { kind: "no_heroes"; game: string; perRole: number }
  /** UC-39 2a. Refused before any draw, naming every thin role. */
  | { kind: "too_thin"; game: string; refusal: string }
  /**
   * UC-39 2, 6, 6a. The draw may happen (`hand: null`), or already has.
   *
   * No game name: the reveal never showed one, and a hand outlives the event's
   * game (see {@link loadDraw}), so a field the held hand could not always
   * fill would be the reason to hide it.
   */
  | {
      kind: "ready";
      /** The comp the admin chose — stated, never enforced (UC-39 7a). */
      format: TeamFormat;
      /** The roles a hand covers, in deal order, for the copy above the button. */
      roles: readonly HeroRole[];
      /**
       * How many in each role (R-210): the stored hand's own width when there
       * is one, the event's when there is not (R-271 / UC-58 7a).
       */
      perRole: number;
      /**
       * The hand already stored against this player and this event, in deal
       * order and at the width it was dealt — or null when they have not
       * drawn (UC-39 6a vs 2).
       */
      hand: RevealCard[] | null;
    };

/**
 * A stored hand flattened into the order the cards turn in.
 *
 * `HERO_ROLES` order, three at a time, which is the order `drawHand` deals in —
 * so what a player watches is the order they were dealt rather than an order
 * this file invented. Reading it off the shared constant is what keeps the two
 * the same thing; see `heroes-policy.ts`, which takes its own walk order from
 * there for exactly this reason.
 *
 * Only `id`, `name` and `role` cross to the browser. The rest of a hero row —
 * `gameId`, `retiredAt`, `createdAt` — is nothing a card shows, and a payload
 * carrying it would be telling every player which heroes have been retired.
 */
export function handCards(heroes: Record<HeroRole, Hero[]>): RevealCard[] {
  return HERO_ROLES.flatMap((role) =>
    (heroes[role] ?? []).map((hero) => ({ id: hero.id, name: hero.name, role }))
  );
}

/** Thrown by the probe below, and never anywhere else. */
class ProbeDealt extends Error {}

/**
 * `drawHand`'s refusal for these pools at this width, or null when it would
 * deal. `perRole` is the event's own (`eventShapeFrom`, R-270), so the page
 * refuses for the width `dealFor` is about to ask for and not for three.
 *
 * UC-39 2a's sentence is `drawHand`'s own (it names **every** thin role, which
 * is Task 74's correction to the use case), and asking the real function for it
 * is what stops the page growing a second opinion about what "too thin" means.
 * Counting the pools here instead would miss `distinctPool` — a pool holding
 * one hero twice clears a naive "at least three" and then deals that hero
 * twice — so the guard and the promise have to be the same question, and the
 * only way to ask it is to ask `drawHand`.
 *
 * The generator throws, so this **cannot** deal: if control reaches the first
 * `random()` call the probe is over and the answer is "not thin". That is the
 * same device `heroes-policy.test.ts` uses to tell "refused before any draw"
 * from "dealt nine and threw them away", and here it is load-bearing rather
 * than a test trick — the page must never produce a hand, because a hand that
 * was not stored is not a hand (UC-39 5a).
 */
export function refusalFor(
  pools: Record<HeroRole, readonly Hero[]>,
  perRole: number
): string | null {
  try {
    const probe = drawHand(
      pools,
      () => {
        throw new ProbeDealt();
      },
      perRole
    );
    return probe.ok ? null : probe.error;
  } catch (cause) {
    if (cause instanceof ProbeDealt) return null;
    throw cause;
  }
}

/**
 * Does this member hold a seat at this event (UC-39 precondition 2)?
 *
 * `accepted` only. A pending application is a decision somebody has yet to
 * take and a waitlisted one is a queue place, and neither is a seat — the same
 * line `getUnpooledApplicants` and the draft's own roster writes draw, and the
 * same line the public "Who's in" list draws, where it is a privacy promise.
 *
 * One row by construction (`applications_event_user_uniq`), so the first row is
 * the answer rather than the first of several.
 */
async function holdsSeat(
  database: Database,
  eventId: string,
  userId: string
): Promise<boolean> {
  const [row] = await database
    .select({ id: applications.id })
    .from(applications)
    .where(
      and(
        eq(applications.eventId, eventId),
        eq(applications.userId, userId),
        eq(applications.status, "accepted")
      )
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The whole screen for one player.
 *
 * Two facts about the player come first and are read together: whether they
 * hold a seat (UC-39 1a) and whether they already hold a hand (6a). Then, only
 * for a seat holding nothing, the questions about the next deal in the order
 * the player would want them: whether this night draws heroes (UC-58 3a),
 * whether there is anything to deal from (1b), whether what there is can make
 * a hand (2a), and only then the draw. Each of those refusals arrives
 * **before** the work the next question would do — the hero list is not read
 * for somebody with no seat, for somebody who holds a hand, or at a night
 * that deals none.
 *
 * ## A hand is shown to whoever drew it, seat or no seat — decided, not ordered
 *
 * The seat and the stored hand are **both** read before anything is answered,
 * and the answer is a table of the two:
 *
 *  | seat | hand | answer                                              |
 *  |------|------|-----------------------------------------------------|
 *  | yes  | yes  | `ready`, with the hand                              |
 *  | no   | yes  | `former_seat`, with the hand                        |
 *  | yes  | no   | the questions about the next deal, below            |
 *  | no   | no   | `no_seat`                                           |
 *
 * The second row used to be `no_seat`, and nobody chose that: the seat was
 * asked first and returned before the hand was read, so a player who drew and
 * then withdrew — or was declined, or moved to the queue — was told there was
 * "nothing here to turn over" about nine heroes the manager's Hands tab was
 * still listing under their name (UC-47 3a). It is the same violation as the
 * two below: a thing that happened to the player, hidden by a change made
 * afterwards.
 *
 * It is decided for the hand. "The draw happens once and stands" (R-212) has
 * no clause about still being there on the night, R-271 says what was dealt
 * stays exactly as it was dealt, and the requirements' own rule is that a hand
 * is shown "to its owner and to a manager" — the owner, not the seat. The row
 * is not deleted when a seat goes, so the alternative was a page denying a
 * record the site keeps and shows to somebody else.
 *
 * The argument against — a removed applicant is no longer part of the night —
 * is true, and it is answered by **saying so** rather than by hiding the
 * cards: `former_seat` is its own kind, and the page puts one sentence above
 * the hand. That is the opposite call from the closed draw below, and for the
 * same reason. "The draw is off" is about a deal the holder is not waiting
 * for, so beside their cards it would only mislead. "You no longer hold a
 * seat" is about *them*, and a hand shown without it would read as "you are
 * still playing", which is the thing that changed.
 *
 * What a seat still decides is the **next** deal, and only that: `no_seat`
 * for somebody holding nothing is UC-39 1a unchanged, and `former_seat` is
 * not `ready`, so the action never takes it as far as `dealFor`.
 *
 * ## A hand already held is answered before the event is asked anything
 *
 * Every question after those two reads is about the **next** deal, as the
 * event stands **now**. Somebody who holds a hand is not getting another (R-212),
 * so none of them is theirs — and each one asked first is a setting changed
 * afterwards hiding what somebody drew (R-271 / UC-58 7a):
 *
 *  - "Too thin" hid a hand dealt at three the moment the event asked for five.
 *  - **"This night is not drawing heroes" would hide every hand dealt before
 *    the manager turned the draw off.** The switch stops the next deal; it
 *    does not un-deal one. So a holder at a closed draw sees their hand, flat
 *    and with no button, exactly as on any return visit (UC-39 6a) — and is
 *    *not* told the draw is off, because that sentence is about a deal they
 *    are not waiting for, and beside their cards it would read as "these no
 *    longer count", which nobody decided.
 *  - **"This event has no game" hid a hand whose event later lost its game.**
 *    It was asked first only because `ready` used to carry the game's name,
 *    which nothing rendered. A hand is hero rows, read by id; they belong to
 *    the game the event had when it dealt, and they are still there. So the
 *    holder sees the same hand, by the same names, and the page simply has no
 *    game badge to show above it. `no_game` is now what it says: nothing to
 *    deal the *next* hand from.
 *
 * So neither the event's shape, its game nor the hero list is consulted for a
 * hand's holder at all — seated or not.
 *
 * ## The draw being off outranks the game being missing
 *
 * An event with the draw off and no game is refused as `draw_off`. "A manager
 * can set a game" would send the player to have something fixed that the
 * manager has already decided not to use.
 *
 * Its `perRole` is the hand's own, counted off the stored roles as
 * `unflatten` rebuilt them, for the same reason: the screen's sentence counts
 * the cards in front of the player, not the ones the next player will get.
 */
export async function loadDraw(
  event: EventDetail,
  userId: string,
  readHand: StoredHandReader,
  database: Database = defaultDb
): Promise<DrawPayload> {
  const seated = await holdsSeat(database, event.id, userId);

  const shown = { format: teamFormatFrom(event.config), roles: HERO_ROLES } as const;

  /*
   * `dealtAt` is read and deliberately not carried. "You already hold these"
   * is the fact the screen needs (UC-39 6a) and the hand's presence is what
   * says it; an instant would also have to be formatted in the player's zone
   * on the client, which is a hydration problem bought for a line nobody
   * asked for. It stays on `StoredHand` for whoever does want it.
   */
  const stored = await readHand(event.id, userId, database);
  if (stored) {
    return {
      // The table in the docblock, rows one and two: the hand either way.
      kind: seated ? "ready" : "former_seat",
      ...shown,
      perRole: stored.heroes[HERO_ROLES[0]].length,
      hand: handCards(stored.heroes),
    };
  }

  /* Row four: no seat and nothing held (UC-39 1a). */
  if (!seated) return { kind: "no_seat" };

  /* Row three: a seat and nothing held, so the next deal — as the event stands. */
  const shape = eventShapeFrom(event.config);
  if (!shape.heroes) return { kind: "draw_off" };

  const game = event.game;
  if (!game) return { kind: "no_game" };

  const perRole = shape.heroesPerRole;

  const catalogue = await listHeroes(game.id, database);
  if (catalogue.length === 0) return { kind: "no_heroes", game: game.name, perRole };

  const refusal = refusalFor(drawableByRole(catalogue), perRole);
  if (refusal !== null) return { kind: "too_thin", game: game.name, refusal };

  return { kind: "ready", ...shown, perRole, hand: null };
}
