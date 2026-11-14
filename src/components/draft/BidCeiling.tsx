import { Alert, Eyebrow, Panel, cx } from "@/components/ui";
import type { DraftConfig } from "@/lib/draft-policy";
import type { RosterSizing } from "@/lib/events-policy";
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
 * unsaved one — so the numbers move as the minimum bid is dragged around. The
 * places on a team are the Format panel's `sizing` (R-248), not a rule on this
 * screen, so they arrive from the same read that sized the teams' own rosters.
 *
 * A row says how many places are left, and what the team may bid, only when
 * the panel has sized the teams. `rosterState` offers an unsized roster no slot
 * (`slotsLeft` is 0), which is not the same as being full, and `maxBidFor`
 * answers a roster with no slot with 0, which is not the same as a ceiling: it
 * is a sum over places nobody has counted. So with no cap the row is the team's
 * name and nothing else, and the sentence under the list —
 * `UNSIZED_ROSTER_NOTE`, from `ceilingFor` — is the block's one word on it
 * (R-250 / UC-49 1b). That is the captain's bid box's answer for the same team:
 * the note in place of the whole ceiling, label and figure both.
 */

export type BidCeilingProps = {
  teams: readonly TeamLike[];
  /** The rules to price against — usually the ones on screen, not the saved ones. */
  config: DraftConfig;
  /** The places on a team, from the Format panel (R-248) — not a rule on screen. */
  sizing: RosterSizing;
  players?: PlayerBook;
  /** Rendered as a plain list rather than inside its own panel. */
  bare?: boolean;
  className?: string;
};

export default function BidCeiling({ teams, config, sizing, bare, className }: BidCeilingProps) {
  const rows = ceilingsFor(teams, config, sizing);
  const stuck = rows.filter((row) => row.stuck);

  const body = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Eyebrow>What that means in money</Eyebrow>
        <span className="text-12 text-muted">
          {config.mustFillRoster
            ? `Each unfilled slot is held at ${config.minBid > 0 ? "the minimum bid" : "1"}, so a team can never arrive at its last pick with nothing.`
            : "The rule is off, so a team may spend everything on one player and finish short."}
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-14 text-muted">
          Add some teams and this fills in with what each of them could bid.
        </p>
      ) : (
        <ul className="divide-y divide-hair/50 rounded-lg border border-hair">
          {rows.map((row) => (
            <li
              key={row.team.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2"
            >
              <span className="min-w-[8rem] flex-1 truncate text-14">{row.team.name}</span>

              {row.roster.cap !== null && (
                <>
                  <span className="num text-12 text-muted">
                    {row.roster.slotsLeft > 0
                      ? `${row.roster.slotsLeft} ${row.roster.slotsLeft === 1 ? "slot" : "slots"} left`
                      : "full"}
                  </span>

                  <span className="flex items-baseline gap-1">
                    <Eyebrow as="span">Max bid</Eyebrow>
                    <Money
                      value={row.max}
                      tone={row.stuck ? "flare" : row.max === 0 ? "muted" : "union"}
                      size="lg"
                    />
                  </span>
                </>
              )}

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
        <p className={cx("text-12 leading-relaxed text-muted")}>{rows[0].sentence}</p>
      )}

      {stuck.length > 0 && (
        <Alert tone="flare" standing>
          <span className="block font-medium">
            {stuck.length === 1 ? "One team cannot" : `${stuck.length} teams cannot`} meet the
            minimum bid
          </span>
          <span className="mt-1 block opacity-90">
            {stuck.map((row) => row.team.name).join(", ")} still {stuck.length === 1 ? "has" : "have"}{" "}
            slots to fill, but holding money back for them leaves less than the minimum bid
            of {config.minBid}. Lower the minimum, lower the places on a team in Setup →
            Format, or raise the balances.
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
