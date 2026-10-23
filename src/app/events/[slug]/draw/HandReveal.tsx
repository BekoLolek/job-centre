"use client";

/**
 * One click, nine cards turning about a second apart, then the hand by role
 * (R-211, R-213 / UC-39 2, 3, 4, 6, 7a).
 *
 * ## Nothing here decides anything about the hand
 *
 * Not one branch below picks a hero, and there is no source of randomness in
 * this file or in anything it imports. `draw()` is a server action: it calls
 * `dealFor`, which deals inside a transaction against a unique index on
 * (event, user) and hands back the nine it stored. Only then does the first
 * card turn. So the reveal **cannot** be a reroll, which is the whole of R-212:
 * a player who closes the tab, reloads, or clicks again holds exactly the nine
 * that were written down before they saw any of them.
 *
 * That is held by shape rather than by discipline. What the component owns is a
 * tick count; what it is given is a list it cannot extend; and the only
 * function that reads the two together is `revealView`, whose single job is to
 * say how much of the list is visible. `reveal.ts` carries the argument in
 * full, and every state after the click is tested there, because the suite runs
 * in a node environment and nothing in it can click a button.
 *
 * ## The comp is stated, never enforced (UC-39 7a)
 *
 * The format and its comp are printed above the button and read nowhere else.
 * Nothing on this screen assigns a role, suggests one, orders the nine by how
 * well they fit 2-2-2, or refuses a team that fields three Duelists — who plays
 * what is the team's conversation (R-215), and the site's job is to make sure
 * everybody can see what everybody holds before it happens (R-211).
 *
 * ## Reduced motion
 *
 * A nine-step reveal on a timer is exactly what `prefers-reduced-motion` is
 * for, and CSS cannot answer it: `globals.css` can stop `.stamp` easing, but
 * the stepping is a `setInterval` in JavaScript and would still take nine
 * seconds. So the query is read here and `revealView` turns the whole hand face
 * up at once — and reports `revealing: false`, so the interval is never started
 * rather than started and hidden.
 *
 * It is read in an effect rather than during render because the server has no
 * media queries to read, and a render that guessed would either flash the hand
 * open or hydrate differently from the markup it was given. The effect runs
 * before any click can happen, and a player who changes the setting mid-session
 * is picked up by the listener.
 */

import { useEffect, useState } from "react";
import type { HeroRole } from "@/db";
import { Alert, Button, Eyebrow, Panel, cx } from "@/components/ui";
import type { TeamFormat } from "@/lib/events-policy";
import {
  REDUCED_MOTION_QUERY,
  REVEAL_INTERVAL_MS,
  type DrawOutcome,
  type RevealCard,
  type RoleGroup,
  revealProgress,
  revealView,
} from "./reveal";

export type HandRevealProps = {
  /**
   * The nine this player already holds, in deal order, or null when they have
   * not drawn (UC-39 6a vs 2).
   *
   * Server-decided in both directions: when it is a list, the list came out of
   * the database on this request; when it is null, the only way it becomes a
   * list is {@link HandRevealProps.draw}.
   */
  initialHand: RevealCard[] | null;
  /** The comp the admin chose, printed and nothing more (UC-39 7a). */
  format: TeamFormat;
  /** The roles a hand covers, in the order they are dealt. */
  roles: readonly HeroRole[];
  /** How many in each role (R-210). */
  perRole: number;
  /** The server action. Deals once and returns what is stored. */
  draw: () => Promise<DrawOutcome>;
};

export default function HandReveal({
  initialHand,
  format,
  roles,
  perRole,
  draw,
}: HandRevealProps) {
  const [cards, setCards] = useState<RevealCard[] | null>(initialHand);
  /*
   * A hand that was already in the payload was dealt at some earlier moment, so
   * there is nothing to play out — the same branch a second click lands on.
   */
  const [alreadyHeld, setAlreadyHeld] = useState(initialHand !== null);
  const [ticks, setTicks] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    setReducedMotion(query.matches);
    const listen = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    query.addEventListener("change", listen);
    return () => query.removeEventListener("change", listen);
  }, []);

  const view = revealView({ cards, ticks, reducedMotion, alreadyHeld });

  useEffect(() => {
    /*
     * `revealing` is `faceUp < total`, and a hand shown whole already has
     * every card turned — so reduced motion and a hand this player already
     * held both land here as false and **no interval is ever created**. Not a
     * second guard: the same fact that turned the cards is the fact that
     * leaves nothing to turn. Somebody who switches reduced motion on
     * mid-reveal lands here too, and the cleanup stops the timer they had.
     */
    if (!view.revealing) return;
    const timer = setInterval(() => setTicks((turned) => turned + 1), REVEAL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [view.revealing]);

  async function click() {
    if (busy || cards !== null) return;
    setBusy(true);
    setError(null);

    const outcome = await draw();
    if (!outcome.ok) {
      // UC-39 5a. Nothing is shown as drawn and the button comes back: a hand
      // that was never stored is not a hand.
      setError(outcome.error);
      setBusy(false);
      return;
    }

    setAlreadyHeld(outcome.alreadyHeld);
    setTicks(0);
    setCards(outcome.cards);
    setBusy(false);
  }

  const progress = revealProgress(view);

  return (
    <div className="space-y-6">
      {/* --- Said before the button, not after it (UC-39 2) ---------- */}
      <Panel as="section" padding="none" className="space-y-4">
        <Eyebrow>The night&rsquo;s format</Eyebrow>

        <p className="max-w-prose text-14 leading-relaxed text-muted">
          {format.format} states a {format.comp} comp. The comp is stated, never enforced
          — nobody is assigned a role, and a team that fields three Duelists is not
          refused. Who plays what is yours to settle once you can all see what you hold.
        </p>

        <h2 className="font-display text-24 leading-tight">
          {perRole} in each of {roles.length} roles, so {perRole * roles.length} in a hand
        </h2>

        {cards === null ? (
          <p className="max-w-prose text-14 leading-relaxed text-muted">
            <span className="text-chalk">The draw happens once.</span> Your{" "}
            {perRole * roles.length} are decided and written down the moment you click,
            before the first card turns — so closing this tab, reloading, or clicking again
            shows you exactly the same hand. There is no reroll, and nobody gets a second
            go.
          </p>
        ) : (
          <p className="max-w-prose text-14 leading-relaxed text-muted">
            <span className="text-chalk">The draw happened once.</span> These{" "}
            {perRole * roles.length} were decided and written down before the first card
            turned, and they are what you hold however many times this page is opened.
          </p>
        )}
      </Panel>

      {/* --- The click, or the hand ---------------------------------- */}
      {cards === null ? (
        <Panel as="section" padding="none" className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <div className="flex flex-wrap items-center gap-4">
            <Button variant="union" onClick={() => void click()} disabled={busy}>
              {busy ? "Dealing…" : `Draw my ${perRole * roles.length}`}
            </Button>
            <span className="text-12 text-dim">
              {roles.join(" · ")}
            </span>
          </div>
        </Panel>
      ) : (
        <Panel as="section" padding="none" className="space-y-5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <Eyebrow>{view.complete ? "Your hand" : "Dealing"}</Eyebrow>
            {/*
             * Polite, not assertive: the cards arriving are the content, and a
             * count that interrupted nine times in nine seconds would be worse
             * than silence. Null while a hand is shown whole — see
             * `revealProgress`.
             */}
            <p role="status" aria-live="polite" className="text-12 text-dim">
              {progress}
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-3">
            {view.groups.map((group) => (
              <RoleColumn key={group.role} group={group} />
            ))}
          </div>

          {view.complete && (
            <p className="max-w-prose text-14 leading-relaxed text-muted">
              That is the hand, and it stands. Compare it with your team&rsquo;s before you
              settle who plays what — knowing what everybody holds is the point of drawing
              all {roles.length} roles rather than one.
            </p>
          )}
        </Panel>
      )}
    </div>
  );
}

/**
 * One role's three, in deal order.
 *
 * The column is its full height from the first card, with the ones still to
 * turn drawn as empty slots: nothing on the screen moves while the hand fills
 * in, and a player can see the shape they are being dealt into. At 400px the
 * grid is one column, so this is three stacked lists of three rather than nine
 * cards fighting for a row — the case most likely to overflow, and the reason
 * the card is a full-width row and not a square tile.
 *
 * Exported for the same reason the pure functions in `reveal.ts` are: the
 * mid-reveal states — four turned, five still face-down — are reachable only by
 * clicking, and nothing in a node environment can click. A test renders this
 * with a group `groupsOf` built at a given count, which is the real card markup
 * at a real step of the reveal rather than a claim about one.
 */
export function RoleColumn({ group }: { group: RoleGroup }) {
  return (
    <div className="space-y-2">
      <Eyebrow as="h3">{group.role}</Eyebrow>
      <ul className="space-y-2">
        {group.slots.map((slot) => (
          <li
            /*
             * Role *and* id. A hero holding several roles can be dealt in two
             * of a player's role-sets, so the id alone is not unique in a hand.
             */
            key={`${slot.role}-${slot.id}`}
            /*
             * A card that has not turned says nothing, so it is hidden from
             * assistive technology rather than read out as an empty row or as a
             * dash. What it is doing is holding the column's height so the
             * layout does not jump — a visual job, and only a visual job.
             */
            aria-hidden={slot.faceUp ? undefined : "true"}
            /*
             * The fill is what says "turned", not an opacity fade — a card
             * that only became less transparent would read as disabled. The
             * border is the same `hair` on both, so the row holds its place
             * exactly; `rounded-lg border border-hair bg-raised` is the card
             * the event page and the schedule tab already use, so a dealt hero
             * looks like everything else on the site that is a thing rather
             * than a space for one.
             */
            className={cx(
              "rounded-lg border border-hair px-3 py-2.5 text-14",
              slot.faceUp ? "stamp bg-raised text-chalk" : "text-dim"
            )}
          >
            {slot.faceUp ? slot.name : "—"}
          </li>
        ))}
      </ul>
    </div>
  );
}
