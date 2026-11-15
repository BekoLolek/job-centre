"use server";

/**
 * The one write behind the draw screen (R-209, R-212 / UC-39 3, 3a, 3b, 5, 5a).
 *
 * Thin, like every other action file here: `src/lib/hero-hands.ts` owns the
 * transaction, the unique index on (event, user) and the
 * `insert … onConflictDoNothing … returning()` that makes two simultaneous
 * clicks store one hand; `src/lib/heroes-policy.ts` owns the deal. Nothing
 * below re-decides either. What this adds is the trust boundary.
 *
 * ## Nothing arrives from the client that could change the hand
 *
 * The call carries an event id and nothing else. It does **not** carry the
 * player — that is the signed-in user, so nobody can deal themselves a hand
 * under somebody else's name or read one. And it does not carry a seed, a pool
 * or a count: `Math.random` is passed here, at the one place that is allowed to
 * reach for it (Task 74's rule, which is why `drawHand` takes the generator as
 * a parameter), so a payload cannot aim the draw.
 *
 * ## Whether they hold a seat is asked again here
 *
 * The page refused a non-participant before rendering (UC-39 1a), and a server
 * action is a public endpoint regardless of what the page decided — so the
 * question is asked again, against the same `loadDraw` the page used, rather
 * than trusted from the fact that somebody had the button. That also means the
 * two can never disagree about what counts as a seat or about a game whose list
 * is too thin.
 *
 * ## Nothing revalidates
 *
 * The outcome carries the hand, and the client reveals from it. A
 * `revalidatePath` would re-render the page under a reveal that is mid-flight
 * and show the whole hand at card four — the one moment this screen must not
 * be replaced.
 */

import { getEventBySlug } from "@/lib/events";
import { HAND_DRAW_OFF, dealFor, handFor } from "@/lib/hero-hands";
import { canSeeEvent } from "@/lib/hosting";
import { getCurrentUser } from "@/lib/session-guards";
import { handCards, loadDraw } from "./draw";
import type { DrawOutcome } from "./reveal";

/**
 * The sentence every refusal that is not `dealFor`'s own comes back as.
 *
 * Deliberately one sentence for all of them. The cases are "you are not signed
 * in any more", "that event has gone" and "you do not hold a seat", and the
 * screen a player is looking at was rendered for somebody who did hold one — so
 * whichever it is, the honest instruction is to reload rather than to explain a
 * state that has already changed underneath them. The page's own refusals, the
 * ones somebody can act on, are `loadDraw`'s and are rendered as screens.
 */
const GONE = "That draw is no longer available to you. Reload the page to see where you stand.";

/**
 * Deal this player their hand, or hand back the one they already hold.
 *
 * `dealFor`'s `alreadyHeld` is passed straight through rather than re-derived
 * from whether a hand was found first: a read followed by a write is the race
 * UC-39 3b is about, and the only run that knows whether *it* did the dealing
 * is the one that got a row back from the insert.
 */
export async function drawAction(slug: string): Promise<DrawOutcome> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: GONE };

  const event = await getEventBySlug(slug);
  if (!event || !(await canSeeEvent(user, event))) return { ok: false, error: GONE };

  /*
   * The same loader the page ran, so the seat check and the thin-list refusal
   * are one decision rather than two that have to be kept in step. **This call
   * is the seat check**: anything but `ready` refuses, and `no_seat` is one of
   * those, so a payload that is not ready is the only gate this needs.
   *
   * There used to be an explicit `if (payload.kind === "no_seat")` line above
   * this, and a mutation proved it dead — deleting it changed no answer,
   * because the line below already refuses every kind that is not `ready` with
   * the same sentence. Two guards for one fact is one of them going stale.
   *
   * Two kinds have a sentence worth repeating. `too_thin` is the one an admin
   * can act on. `draw_off` is a click that landed after a manager turned the
   * draw off (R-269 / UC-58 3a): the player is told the night is not drawing
   * heroes, in `dealFor`'s own words, rather than that their draw has gone
   * missing. The rest share the catch-all, which deliberately shares no phrase
   * with either.
   *
   * A seated player who already holds a hand never reaches these: `loadDraw`
   * answers `ready` for them whatever the event says now, and `dealFor` hands
   * back the hand that stands.
   *
   * `former_seat` — a hand held by somebody whose seat has since gone — is
   * refused here with the catch-all, on purpose, and never reaches `dealFor`.
   * The page shows that hand with no button, so a click from one is a stale
   * screen, and "reload to see where you stand" is exactly right: the reload
   * shows them the hand and the sentence about the seat. `dealFor` asks about
   * no seat at all (its docblock says why), so **this line is what keeps a
   * deal from being attempted for somebody without one**, hand or no hand.
   */
  const payload = await loadDraw(event, user.id, handFor);
  if (payload.kind === "too_thin") return { ok: false, error: payload.refusal };
  if (payload.kind === "draw_off") return { ok: false, error: HAND_DRAW_OFF };
  if (payload.kind !== "ready") return { ok: false, error: GONE };

  const dealt = await dealFor(event.id, user.id, Math.random);
  if (!dealt.ok) return { ok: false, error: dealt.error };

  return {
    ok: true,
    cards: handCards(dealt.hand.heroes),
    alreadyHeld: dealt.alreadyHeld,
  };
}
