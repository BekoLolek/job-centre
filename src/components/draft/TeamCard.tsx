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
 */

export type TeamCardProps = {
  team: TeamLike;
  players: PlayerBook;
  /** Draw the roster inside the card, with its empty slots. */
  showRoster?: boolean;
  hidePrices?: boolean;
  /** Says "no captain yet" in gold rather than staying quiet about it. */
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
      className={cx("space-y-3", active && "border-gold/60", className)}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-display text-lg leading-tight tracking-wide">
            {team.name}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {team.seed !== null && <Badge>Seed {team.seed}</Badge>}
            {team.captainUserId ? (
              <span className="eyebrow truncate text-chalk/70">
                © {playerName(players, team.captainUserId)}
              </span>
            ) : warnNoCaptain ? (
              <Badge tone="gold">No captain</Badge>
            ) : null}
          </div>
        </div>

        {!hidePrices && (
          <div className="shrink-0 text-right">
            <Eyebrow className="mb-0.5">Left</Eyebrow>
            <Money value={team.balance} size="xl" />
            <div className="num mt-0.5 text-[10px] text-muted">
              {spent > 0
                ? `${formatMoney(team.balanceStart)} − ${formatMoney(spent)} spent`
                : `of ${formatMoney(team.balanceStart)}`}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-hair/60 pt-2">
        <span className="num text-xs text-muted">
          {team.roster.size}/{team.roster.target} on the roster
        </span>
        {team.roster.slotsLeft > 0 ? (
          <span className="num text-xs text-signal">
            {team.roster.slotsLeft} to fill
          </span>
        ) : (
          <span className="num text-xs text-gold">Full</span>
        )}
        {team.roster.overfilled && <Badge tone="ember">Over target</Badge>}
      </div>

      {children}

      {showRoster && (
        <div className="border-t border-hair/60 pt-2">
          <RosterList
            members={team.members}
            players={players}
            target={team.roster.target}
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
