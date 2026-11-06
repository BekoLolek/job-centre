"use client";

import Link from "next/link";
import { Alert, EmptyState, Eyebrow, Section, cx, plural } from "@/components/ui";
import LocalTime from "@/components/format/LocalTime";
import type { HeroRole } from "@/db";
import type { PlayerWithHands } from "@/lib/hero-hands";

/**
 * Hands — every hand one player has ever been dealt, across every event, and
 * on how many nights each hero has come up for them (R-244 to R-246 / UC-48).
 *
 * The per-event sheet (`events/HandsTab.tsx`) answers "what does the room
 * hold tonight"; this answers "has Bob had Hulk three weeks running". So the
 * picker is the people who have drawn and nobody else (R-246), the tally is
 * first because it is the number the admin came for (R-245), and under it
 * every hand reads the way the player's own screen does — three roles in deal
 * order, three names each, naming its night and when it was dealt (R-244 /
 * UC-48 4) — so "three weeks running" is read off the rows rather than from
 * memory.
 *
 * ## It only reads (R-212 / UC-48 5b)
 *
 * There is no form, no button and no action import in this file, and
 * `player-hands.test.ts` asserts all three — and that the only links on the
 * screen are the player links. The draw happens once and stands: an admin
 * looking here for a way to reroll a run, or to keep a hero out of somebody's
 * next draw, finds none, because a control that did either would be the
 * feature failing rather than a convenience.
 *
 * ## It decides nothing
 *
 * The page read the list and chose which of the three views applies — picked,
 * nobody picked, or a link naming somebody who has not drawn — and mapped each
 * hand down to what a card shows ({@link PlayerNight} has the standard). The
 * tally arrived counted and ordered by `heroNights` in `src/lib/hand-history.ts`,
 * which is where "a hero in two slots of one hand is one night" lives (UC-48
 * 4c). This file draws what it is given and regroups, sorts, filters and counts
 * nothing; the one branch it takes on its own is an empty list, which is the
 * empty state the way every list on the site draws one (UC-48 2a).
 *
 * A hero that has since been retired is named with no mark against it (UC-48
 * 4b), and the data could not say otherwise if the panel wanted to: a
 * {@link PlayerNight} carries names and nothing about the rows they came from.
 */

/*
 * The picker's row is `PlayerWithHands` as `playersWithHands` returns it — a
 * type-only import, erased before either runtime sees it, the way
 * `events/types.ts` names `HandSheet`. It is not redeclared here: the lib's
 * shape is already exactly what a chip shows (a name and a count, nothing of
 * the row they came from), so a copy would narrow nothing and could only
 * drift. `PlayerNight` below *is* declared here, because it is narrower than
 * `PlayerHand` by everything that must not cross.
 */

/**
 * One hand as this panel draws it (R-244 / UC-48 4).
 *
 * `handsOfPlayer` hands the page `PlayerHand`s — full hero rows, `gameId`,
 * `retiredAt` and `createdAt` included, a `Date`, and the event's slug — and
 * none of that crosses to the browser. The standard is `handCards` in
 * `src/app/events/[slug]/draw/draw.ts`, the same one `DealtHand` on the
 * per-event sheet settled on: only what a card shows crosses, because a payload
 * carrying `retiredAt` would be telling the reader which heroes have been
 * retired, and UC-48 4b says a retired hero is named with no mark against it.
 * The event is named, not linked, so its id is here as the row's key and its
 * title as the night's name. `dealtAt` is ISO rather than a `Date` because
 * this is a client component and `LocalTime` formats the instant in the
 * reader's own zone.
 *
 * The roles arrive **already grouped, in deal order** — `HERO_ROLES` order,
 * three names each — so the panel draws what it is given. `HERO_ROLES` lives
 * in `src/lib/heroes.ts`, which reaches Postgres, so the page is the side that
 * knows the order.
 */
export type PlayerNight = {
  event: { id: string; title: string };
  roles: { role: HeroRole; names: string[] }[];
  /** When Postgres stored it, ISO. */
  dealtAt: string;
};

/** One row of the tally (R-245 / UC-48 5): a hero they have had, and on how many nights. */
export type HeroTally = {
  name: string;
  nights: number;
};

/**
 * Which of the three screens, and everything it needs — the page's decision,
 * from `?player=` and the list.
 *
 * A union rather than a nullable player, so the hands and the tally cannot be
 * present for a screen that picked nobody: "names nobody's hands" (UC-48 3a)
 * is then a property of the type rather than a branch to get right.
 */
export type PlayerHandsView =
  /** UC-48 3a. No `?player=`: the list, and a sentence asking for one. */
  | { kind: "pick" }
  /** `?player=` names nobody in the list — a member with no hand, or no member at all. */
  | { kind: "unknown" }
  /** UC-48 4, 5. The one named, every hand newest first, and the tally. */
  | { kind: "player"; player: PlayerWithHands; hands: PlayerNight[]; tally: HeroTally[] };

export type PlayerHandsData = {
  /** Everyone who has drawn, most nights first — `playersWithHands`' order. */
  players: PlayerWithHands[];
  view: PlayerHandsView;
};

export default function PlayerHands({ data }: { data: PlayerHandsData }) {
  const { players, view } = data;
  const picked = view.kind === "player" ? view.player.userId : null;

  return (
    <>
      {/* --- Who has drawn (R-246 / UC-48 2, 2a, 3) ---------------------- */}
      <Section
        first
        icon="people"
        title="Who has drawn"
        description="Everyone who has been dealt at least one hand, most nights first. A member who has never drawn has no history to show and is not listed."
      >
        {players.length === 0 ? (
          <EmptyState>
            Nobody has been dealt a hand yet. A player appears here once they have drawn on
            an event, with every hand they have held since.
          </EmptyState>
        ) : (
          <>
            {/*
              Stateless the way the audit page's filter chip is: picking a
              player is a navigation to a URL somebody can send, not a form
              to submit, so there is no state here to lose and nothing to
              submit. `aria-current` is the one that is open.

              Taller than that chip, deliberately. The audit's is one control
              beside a select; this is a wrapped list of a dozen and the
              page's only navigation, read on a phone as often as a desk, so
              each one is a real tap target rather than a 23px strip.
            */}
            <ul className="flex flex-wrap gap-3">
              {players.map((player) => {
                const current = player.userId === picked;
                return (
                  <li key={player.userId}>
                    <Link
                      href={`/admin/hands?player=${player.userId}`}
                      aria-current={current ? "page" : undefined}
                      className={cx(
                        "btn border px-2 py-2 text-12",
                        current
                          ? "border-union/50 bg-union-tint-10 text-union"
                          : "border-hair text-muted"
                      )}
                    >
                      {player.displayName}
                      {/*
                        The count takes the chip's own colour when lit and
                        the quiet label colour otherwise. No `/80` tint on
                        the lit one: `design-tokens.test.ts` measures it at
                        3.8:1 on the page, under the 4.5:1 body text needs.
                      */}
                      <span className={cx("num", current ? "text-union" : "text-dim")}>
                        {plural(player.hands, "night")}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>

            {view.kind === "pick" && (
              <p className="mt-5 text-14 leading-relaxed text-muted">
                Pick a player to see every hand they have been dealt.
              </p>
            )}

            {view.kind === "unknown" && (
              <Alert tone="flare" standing className="mt-5">
                <span className="block font-medium">
                  That link does not name a player who has drawn
                </span>
                <span className="mt-1 block opacity-90">
                  Nothing was read: the id in it is not a member who holds a hand. They may
                  never have drawn, or the link may be wrong. Pick one above.
                </span>
              </Alert>
            )}
          </>
        )}
      </Section>

      {view.kind === "player" && (
        <>
          {/* --- The number the admin came for (R-245 / UC-48 5, 4c, 5a) --- */}
          <Section
            icon="history"
            title="Every hero that has come up"
            description={`How many nights ${view.player.displayName} has held each hero, most nights first. A hero dealt in two slots of one hand counts that night once; a hero they have never had is not listed.`}
          >
            {/*
              Keyed by position, not by name: a player's hands span events,
              and two games may each carry a "Hulk". The list is drawn once
              in the order it arrived and never reordered here, so position
              is a stable key.
            */}
            <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2 md:grid-cols-3">
              {view.tally.map((entry, position) => (
                <li
                  key={position}
                  className="flex items-baseline justify-between gap-3 border-b border-hair/60 py-1.5"
                >
                  <span className="min-w-0 text-14 text-chalk">{entry.name}</span>
                  <span className="num shrink-0 text-12 text-muted">
                    {plural(entry.nights, "night")}
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          {/* --- The rows the answer is read off (R-244 / UC-48 4, 4b) ---- */}
          <Section
            icon="list"
            title="Every hand, newest first"
            description="Each hand as it was dealt: three roles in deal order, three names each, with the event it came from and when it was dealt."
          >
            <ul className="divide-y divide-hair/60 border-t border-hair">
              {view.hands.map((hand) => (
                <HandRow key={hand.event.id} hand={hand} />
              ))}
            </ul>
          </Section>
        </>
      )}
    </>
  );
}

/**
 * One night: the event it was on, when it was dealt, and the nine names under
 * three role headings — the per-event sheet's row, with the night's name where
 * that sheet has the player's.
 *
 * The roles sit side by side from `sm` up and stack below it, so the history
 * reads at a phone's width without a sideways scroll.
 */
function HandRow({ hand }: { hand: PlayerNight }) {
  return (
    <li className="space-y-3 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-14 text-chalk">{hand.event.title}</span>
        <span className="text-12 text-muted">
          Dealt <LocalTime at={hand.dealtAt} />
        </span>
      </div>

      <dl className="grid gap-3 sm:grid-cols-3">
        {hand.roles.map((group) => (
          <div key={group.role}>
            <Eyebrow as="dt" className="mb-1">
              {group.role}
            </Eyebrow>
            <dd>
              {/*
                Keyed by slot, not by name: one hand can name the same hero
                twice — Deadpool in two roles — and both slots are drawn
                (UC-48 4c).
              */}
              <ol className="space-y-0.5 text-14">
                {group.names.map((hero, slot) => (
                  <li key={slot}>{hero}</li>
                ))}
              </ol>
            </dd>
          </div>
        ))}
      </dl>
    </li>
  );
}
