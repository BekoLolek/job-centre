import { Alert, Eyebrow, Panel, cx } from "@/components/ui";
import type { DraftConfig } from "@/lib/draft-policy";
import Money from "./MoneyFigure";
import { ceilingsFor } from "./ceiling";
import type { PlayerBook, TeamLike } from "./types";

/**
 * What the must-fill rule costs, per team, in money — §9's blind-bid protection
 * made visible.
 *
 * This exists because of a specific failure: a rule nobody can see the effect
 * of gets switched on, and then gets blamed. The admin turns on "must keep
 * enough to fill your roster", the draft runs, a captain's bid of 900 is
 * refused with a sentence about slots, and the conclusion in the room is that
 * the board is wrong. Showing the ceiling *while the setting is being chosen*
 * turns the same rule into a decision somebody made on purpose.
 *
 * The figures come from `maxBidFor` against the config passed in — including an
 * unsaved one — so the numbers move as the roster size and the minimum bid are
 * dragged around.
 */

export type BidCeilingProps = {
  teams: readonly TeamLike[];
  /** The rules to price against — usually the ones on screen, not the saved ones. */
  config: DraftConfig;
  players?: PlayerBook;
  /** Rendered as a plain list rather than inside its own panel. */
  bare?: boolean;
  className?: string;
};

export default function BidCeiling({ teams, config, bare, className }: BidCeilingProps) {
  const rows = ceilingsFor(teams, config);
  const stuck = rows.filter((row) => row.stuck);

  const body = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Eyebrow>What that means in money</Eyebrow>
        <span className="text-xs text-muted">
          {config.mustFillRoster
            ? `Each unfilled slot is held at ${config.minBid > 0 ? "the minimum bid" : "1"}, so a team can never arrive at its last pick with nothing.`
            : "The rule is off, so a team may spend everything on one player and finish short."}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted">
          Add some teams and this fills in with what each of them could bid.
        </p>
      ) : (
        <ul className="divide-y divide-hair/50 border border-hair">
          {rows.map((row) => (
            <li
              key={row.team.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2"
            >
              <span className="min-w-[8rem] flex-1 truncate text-sm">{row.team.name}</span>

              <span className="num text-xs text-muted">
                {row.roster.slotsLeft > 0
                  ? `${row.roster.slotsLeft} ${row.roster.slotsLeft === 1 ? "slot" : "slots"} left`
                  : "full"}
              </span>

              <span className="flex items-baseline gap-1">
                <Eyebrow as="span">Max bid</Eyebrow>
                <Money
                  value={row.max}
                  tone={row.stuck ? "ember" : row.max === 0 ? "muted" : "gold"}
                  size="lg"
                />
              </span>

              {row.roster.reserved > 0 && (
                <span className="flex items-baseline gap-1">
                  <Eyebrow as="span">Held back</Eyebrow>
                  <Money value={row.roster.reserved} tone="muted" size="sm" />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {rows.length > 0 && (
        <p className={cx("text-xs leading-relaxed text-muted")}>{rows[0].sentence}</p>
      )}

      {stuck.length > 0 && (
        <Alert tone="ember">
          <span className="block font-medium">
            {stuck.length === 1 ? "One team cannot" : `${stuck.length} teams cannot`} meet the
            minimum bid
          </span>
          <span className="mt-1 block opacity-90">
            {stuck.map((row) => row.team.name).join(", ")} still {stuck.length === 1 ? "has" : "have"}{" "}
            slots to fill, but holding money back for them leaves less than the minimum bid
            of {config.minBid}. Lower the minimum, lower the roster size, or raise the
            balances.
          </span>
        </Alert>
      )}
    </div>
  );

  if (bare) return <div className={className}>{body}</div>;
  return (
    <Panel as="section" className={className}>
      {body}
    </Panel>
  );
}
