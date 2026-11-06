import type { ReactNode } from "react";
import { Badge, Eyebrow, Panel, cx } from "@/components/ui";
import Money from "./MoneyFigure";
import RosterList from "./RosterList";
import { formatMoney } from "./money";
import type { PlayerBook, TeamLike } from "./types";
import { playerName } from "./types";

/**
 * A team, on a card: name, seed, captain, what is left, and who is on it.
 *
 * The same card serves the admin's Teams tab and the live room's rail, which is
 * why every part of it below the name is optional. The room wants the roster
 * and the balance; the setup screens want the seed and the starting balance and
 * their own controls in the footer. What must never differ between them is
 * where the money sits and what colour it is, and that is the bit this fixes.
 *
 * Note what is *not* here: no bid, no "you", no lot. Those belong to the room
 * alone and putting them here would make every admin screen import a concept it
 * has no use for.
 *
 * ## The places on a team are said three ways, because they mean three things
 *
 * `rosterSizingFrom` answers in three states and the roster line below reads
 * differently in each (R-250 / UC-49 1a, 1b):
 *
 *  - **A stated target** — the admin set "Players on a team", so `target`
 *    and `cap` are the same number. The figure is a decision, so it reads
 *    `4/6 on the roster`, counts what is left to fill, and the list draws
 *    the empty places up to it. This is the overwhelmingly common case and it
 *    renders exactly as it did before the other two existed —
 *    `team-card.test.ts` holds it byte for byte.
 *  - **A cap with no target** — the admin set "How many teams", and the
 *    per-team figure is a consequence of how many are accepted, uneven by
 *    arithmetic: eighteen into four is 5, 5, 4, 4, and the cap is the five.
 *    It reads `4 on the roster, up to 5` and draws no empty place, because a
 *    team of four under that deal is not short and has no gap to fill; the
 *    "to fill" count is left off for the same reason. "Full" is still said at
 *    the cap — a team at the most it may hold can hold no more — and "Over
 *    target" still fires above it, because the cap is the largest legal side
 *    and only a genuinely illegal roster can exceed it.
 *  - **No figure at all** — a count of teams with fewer accepted than sides,
 *    where `planSides` deals nothing and `cap` is null. Said in words, and
 *    the words point at the panel. Before this the line read `0/ on the
 *    roster`, which looks like a roster of nothing rather than a decision
 *    nobody has made yet.
 *
 * The sentence for that third state is `UNSIZED_ROSTER_NOTE`, exported so the
 * bid box and the room's header say the same words — a figure must never look
 * like two things on two pages, and neither must its absence.
 */

/**
 * What every roster surface says when the Format panel has no figure for the
 * places on a team (UC-49 1b).
 *
 * "An admin decides that", rather than the admin tabs' "Setup → Format is
 * where that is decided": two of the three surfaces that say this — the draft
 * room's header and a captain's bid box — are read by captains and observers
 * who have no Setup → Format to open, so the sentence names who can act, the
 * way the room already says "An admin sets captains on the event's Teams tab."
 */
export const UNSIZED_ROSTER_NOTE =
  "The Format panel has not sized the teams yet. An admin decides that in Setup → Format.";

export type TeamCardProps = {
  team: TeamLike;
  players: PlayerBook;
  /** Draw the roster inside the card, with its empty slots. */
  showRoster?: boolean;
  hidePrices?: boolean;
  /** Says "no captain yet" in union blue rather than staying quiet about it. */
  warnNoCaptain?: boolean;
  /** Lit border — the team on the block, the team being edited. */
  active?: boolean;
  /** Extra readouts under the balance — a bid ceiling, a bid. */
  children?: ReactNode;
  /** Controls, ruled off at the bottom. */
  footer?: ReactNode;
  className?: string;
};

export default function TeamCard({
  team,
  players,
  showRoster,
  hidePrices,
  warnNoCaptain,
  active,
  children,
  footer,
  className,
}: TeamCardProps) {
  const spent = team.balanceStart - team.balance;

  return (
    <Panel
      padding="sm"
      className={cx("space-y-3", active && "border-union/60", className)}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-display text-20 leading-tight">
            {team.name}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {team.seed !== null && <Badge>Seed {team.seed}</Badge>}
            {team.captainUserId ? (
              <Eyebrow as="span" className="truncate text-chalk/70">
                © {playerName(players, team.captainUserId)}
              </Eyebrow>
            ) : warnNoCaptain ? (
              <Badge tone="union">No captain</Badge>
            ) : null}
          </div>
        </div>

        {!hidePrices && (
          <div className="shrink-0 text-right">
            <Eyebrow className="mb-0.5">Left</Eyebrow>
            <Money value={team.balance} size="xl" />
            <div className="num mt-0.5 text-11 text-muted">
              {spent > 0
                ? `${formatMoney(team.balanceStart)} − ${formatMoney(spent)} spent`
                : `of ${formatMoney(team.balanceStart)}`}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-hair/60 pt-2">
        {team.roster.cap === null ? (
          <span className="text-12 text-muted">{UNSIZED_ROSTER_NOTE}</span>
        ) : team.roster.target === null ? (
          <>
            <span className="num text-12 text-muted">
              {team.roster.size} on the roster, up to {team.roster.cap}
            </span>
            {team.roster.full && <span className="num text-12 text-union">Full</span>}
            {team.roster.overfilled && <Badge tone="flare">Over target</Badge>}
          </>
        ) : (
          <>
            <span className="num text-12 text-muted">
              {team.roster.size}/{team.roster.cap} on the roster
            </span>
            {team.roster.slotsLeft > 0 ? (
              <span className="num text-12 text-body">
                {team.roster.slotsLeft} to fill
              </span>
            ) : (
              <span className="num text-12 text-union">Full</span>
            )}
            {team.roster.overfilled && <Badge tone="flare">Over target</Badge>}
          </>
        )}
      </div>

      {children}

      {showRoster && (
        <div className="border-t border-hair/60 pt-2">
          <RosterList
            members={team.members}
            players={players}
            // The stated target, never the cap: under a count of teams the
            // places drawn empty would be places that may not exist.
            target={team.roster.target ?? undefined}
            hidePrices={hidePrices}
          />
        </div>
      )}

      {footer && (
        <div className="flex flex-wrap items-center gap-2 border-t border-hair/60 pt-3">
          {footer}
        </div>
      )}
    </Panel>
  );
}
