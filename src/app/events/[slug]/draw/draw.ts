/**
 * What one player is given about their draw, assembled on the server
 * (R-211, R-213 / UC-39 1, 1a, 1b, 2, 2a, 6, 6a, 7a).
 *
 * The page renders one of five screens and this module decides which. It is a
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
 * `ready` payload carries either the nine that are already stored, or null.
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
 * not indirection for its own sake: it is how the five screens below are
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
import { type TeamFormat, teamFormatFrom } from "@/lib/events-policy";
import { HERO_ROLES, drawableByRole, listHeroes } from "@/lib/heroes";
import { HEROES_PER_ROLE, drawHand } from "@/lib/heroes-policy";
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
 * Which of the five screens, and everything it needs.
 *
 * A union rather than a bag of nullable fields, so the page cannot render the
 * draw button on a screen that refused the draw — the thing UC-39 1a and 1b
 * both exist to stop ("told so rather than shown an empty draw").
 */
export type DrawPayload =
  /** UC-39 1a. No seat at this event, so there is no hand to deal them. */
  | { kind: "no_seat" }
  /** The event was never given a game, so there is no list to deal from. */
  | { kind: "no_game" }
  /** UC-39 1b. The game exists and its hero list is empty. Named, not blank. */
  | { kind: "no_heroes"; game: string }
  /** UC-39 2a. Refused before any draw, naming every thin role. */
  | { kind: "too_thin"; game: string; refusal: string }
  /** UC-39 2, 6, 6a. The draw may happen, or already has. */
  | {
      kind: "ready";
      game: string;
      /** The comp the admin chose — stated, never enforced (UC-39 7a). */
      format: TeamFormat;
      /** The roles a hand covers, in deal order, for the copy above the button. */
      roles: readonly HeroRole[];
      /** How many in each role (R-210). */
      perRole: number;
      /**
       * The nine already stored against this player and this event, in deal
       * order — or null when they have not drawn (UC-39 6a vs 2).
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
 * `drawHand`'s refusal for these pools, or null when it would deal.
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
export function refusalFor(pools: Record<HeroRole, readonly Hero[]>): string | null {
  try {
    const probe = drawHand(pools, () => {
      throw new ProbeDealt();
    });
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
 * The order of the questions is the order of UC-39's alternate flows, and it is
 * the order the player would want them in: whether this page is theirs at all
 * (1a), whether there is anything to deal from (1b), whether what there is can
 * make a hand (2a), and only then the draw. Each refusal arrives **before** the
 * work the next question would do — the hero list is not read for somebody with
 * no seat, and no hand is looked up for a game that cannot deal one.
 */
export async function loadDraw(
  event: EventDetail,
  userId: string,
  readHand: StoredHandReader,
  database: Database = defaultDb
): Promise<DrawPayload> {
  if (!(await holdsSeat(database, event.id, userId))) return { kind: "no_seat" };

  const game = event.game;
  if (!game) return { kind: "no_game" };

  const catalogue = await listHeroes(game.id, database);
  if (catalogue.length === 0) return { kind: "no_heroes", game: game.name };

  const pools = drawableByRole(catalogue);
  const refusal = refusalFor(pools);
  if (refusal !== null) return { kind: "too_thin", game: game.name, refusal };

  const stored = await readHand(event.id, userId, database);

  return {
    kind: "ready",
    game: game.name,
    format: teamFormatFrom(event.config),
    roles: HERO_ROLES,
    perRole: HEROES_PER_ROLE,
    /*
     * `dealtAt` is read and deliberately not carried. "You already hold these"
     * is the fact the screen needs (UC-39 6a) and the hand's presence is what
     * says it; an instant would also have to be formatted in the player's zone
     * on the client, which is a hydration problem bought for a line nobody
     * asked for. It stays on `StoredHand` for whoever does want it.
     */
    hand: stored ? handCards(stored.heroes) : null,
  };
}
