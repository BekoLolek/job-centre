import { Avatar, Badge, Eyebrow, Panel, cx } from "@/components/ui";
import type { SeasonPlayer } from "@/lib/championship-season";
import { ordinal } from "@/lib/format-policy";

/**
 * The top of the season, read before the table (UC-34 2).
 *
 * One object, not three cards. The three places share a surface, a baseline and
 * a single heading, and what separates the leader from the other two is size
 * and space — a bigger figure and a taller block — rather than a colour nobody
 * else on the page is allowed to use. That is the whole of "a cut above" inside
 * a token system: hierarchy from the type scale and the spacing scale, with the
 * palette left alone.
 *
 * Reading order is 1st, 2nd, 3rd — which is also the stacking order on a phone.
 * From `sm` up the columns are re-ordered so the leader stands in the middle
 * with the runners-up either side, because that is the shape a podium has; the
 * DOM order does not move, so a screen reader and a keyboard still meet the
 * champion first.
 */

/** Where each of the first three sits from `sm` up: 2nd, 1st, 3rd. */
const COLUMN = ["sm:order-2", "sm:order-1", "sm:order-3"];

export default function Podium({
  players,
  countBest,
}: {
  /** The standings' first three rows, in order. */
  players: SeasonPlayer[];
  /** Set when only the best N results count, so each block can say so. */
  countBest: number | null;
}) {
  if (players.length === 0) return null;

  return (
    <Panel as="section" tone="wash" padding="lg" className="rise">
      <Eyebrow as="h3" className="mb-6">
        At the top
      </Eyebrow>

      <ol className="grid gap-3 sm:grid-cols-3 sm:items-end sm:gap-4">
        {players.map((player, index) => {
          const leader = index === 0;
          return (
            <li
              key={player.userId}
              className={cx(
                "rounded px-5 py-5",
                COLUMN[index],
                leader ? "bg-union-tint-10 sm:py-8" : "bg-overlay-1"
              )}
            >
              <Eyebrow className="mb-3">
                {ordinal(player.position)}
                {player.level && " equal"}
              </Eyebrow>

              <div className="flex min-w-0 items-center gap-2.5">
                <Avatar
                  name={player.name}
                  src={player.avatarUrl}
                  size={leader ? "md" : "sm"}
                />
                <span
                  className={cx(
                    "min-w-0 truncate font-display text-chalk",
                    leader ? "text-20" : "text-16"
                  )}
                >
                  {player.name}
                </span>
              </div>

              <div className="mt-4 flex items-baseline gap-2">
                <span
                  className={cx("num leading-none text-chalk", leader ? "text-36" : "text-24")}
                >
                  {player.points}
                </span>
                <span className="text-12 text-muted">points</span>
              </div>

              {countBest !== null && (
                <p className="mt-2 text-12 text-muted">
                  {player.counted} of {player.played} results count
                </p>
              )}

              {leader && player.level && (
                <Badge tone="union" className="mt-3">
                  Level at the top
                </Badge>
              )}
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
