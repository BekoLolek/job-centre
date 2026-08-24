import { Badge, EmptyState } from "@/components/ui";
import Money from "./MoneyFigure";
import PlayerChip from "./PlayerChip";
import type { MemberLike, PlayerBook } from "./types";
import { playerHref, playerName } from "./types";

/**
 * A team's roster, captain first, with the empty slots drawn in.
 *
 * The empty slots are the point. §14 makes the captain a roster row, so "four
 * of six" on a six-player target means two more to buy *including* nobody else
 * free — and a list that simply stops after the names it has makes the admin do
 * that subtraction in their head every time. Drawing the gaps turns the roster
 * target from a number in a form into something visible on the card.
 *
 * The captain is pinned to the top regardless of the order handed in, because
 * they are the one row that is never bought and never moves.
 */

export type RosterListProps = {
  members: readonly MemberLike[];
  players: PlayerBook;
  /** Roster size *including* the captain. Empty slots are drawn up to it. */
  target?: number;
  /** Hide prices — the room does this for a viewer who may not see amounts. */
  hidePrices?: boolean;
  /** `null` renders nothing at all rather than a "no captain yet" row. */
  emptyMessage?: string | null;
  className?: string;
};

export default function RosterList({
  members,
  players,
  target,
  hidePrices,
  emptyMessage = "Nobody on this roster yet.",
  className,
}: RosterListProps) {
  const ordered = [...members].sort((a, b) => Number(b.isCaptain) - Number(a.isCaptain));
  const blanks = target === undefined ? 0 : Math.max(0, target - ordered.length);

  if (ordered.length === 0 && blanks === 0) {
    return emptyMessage === null ? null : (
      <EmptyState size="sm" className={className}>
        {emptyMessage}
      </EmptyState>
    );
  }

  return (
    <ul className={className}>
      {ordered.map((member) => (
        <li key={member.userId}>
          <PlayerChip
            name={playerName(players, member.userId)}
            // Every roster on the site — the public Teams tab, the admin's
            // Teams tab and the live room — is this one component, so linking
            // here is what makes §4's player profiles reachable from all three
            // at once rather than from whichever page somebody remembered.
            href={playerHref(players, member.userId)}
            trailing={
              member.isCaptain ? (
                <Badge tone="gold">Captain</Badge>
              ) : hidePrices ? null : (
                <Money value={member.price} size="sm" />
              )
            }
          />
        </li>
      ))}

      {Array.from({ length: blanks }, (_, index) => (
        <li
          key={`blank-${index}`}
          className="flex items-center gap-2 py-1.5 text-sm text-dim"
        >
          <span className="inline-block h-6 w-6 shrink-0 rounded-full border border-dashed border-hair" />
          <span className="eyebrow">Empty slot</span>
        </li>
      ))}
    </ul>
  );
}
