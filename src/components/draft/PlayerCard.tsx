import { Avatar, Badge, Eyebrow } from "@/components/ui";
import type { ApplicantView } from "@/lib/events";

/**
 * One person, on a card: their picture (or initials), name, current rank and
 * preferred roles — what an admin needs in front of them to balance the sides
 * without opening anybody's profile (R-258).
 *
 * **It renders and nothing else.** No drag, no buttons, no link, no slot to
 * put one in, and no idea what a team is. Whatever moves a player around wraps
 * this; it does not grow into it. `PlayerChip` is the one-line row with `meta`
 * and `actions` slots, and this is deliberately not that with more height.
 * `player-card.test.ts` holds the prop list shut.
 *
 * ## Two fields, three kinds of nothing
 *
 * `rank` and `roles` are `ApplicantView`'s, and their `null`s do not mean the
 * same thing:
 *
 *  - `rank: null` — this player has no rank recorded. Said in words.
 *  - `roles: []` — the game asks for roles and this player chose none. Said
 *    in words.
 *  - `roles: null` — the game asks no roles question. A fact about the event
 *    rather than the player, so there is no roles line at all: "no roles
 *    chosen" on every card would blame each player for a question nobody
 *    asked them.
 *
 * ## What it cannot know
 *
 * The roles arrive as plain strings: a live option by its catalogue label, an
 * option an admin has since removed by its stored value. The card cannot tell
 * the two apart and prints both the same way.
 */

/**
 * What a screen says about a player with no rank recorded. Exported so the
 * Captains tab's override list says the same words — the arrangement
 * `UNSIZED_ROSTER_NOTE` has with `TeamCard` — and a player is not
 * "unranked" on one screen and this on another.
 */
export const NO_RANK = "No rank recorded";

const NO_ROLES = "No roles chosen";

export type PlayerCardProps = {
  name: string;
  /** Their Discord picture; null draws their initials. See `playerAvatar`. */
  avatarUrl: string | null;
  rank: ApplicantView["rank"];
  roles: ApplicantView["roles"];
};

export default function PlayerCard({ name, avatarUrl, rank, roles }: PlayerCardProps) {
  return (
    <div className="space-y-3 rounded-lg border border-hair p-3">
      <div className="flex items-center gap-3">
        <Avatar name={name} src={avatarUrl} size="lg" />
        <span className="min-w-0 flex-1 truncate text-14 leading-tight text-chalk">{name}</span>
      </div>

      <dl className="space-y-2">
        <div>
          <Eyebrow as="dt">Rank</Eyebrow>
          {rank === null ? (
            <dd className="text-12 text-muted">{NO_RANK}</dd>
          ) : (
            <dd className="text-14 text-chalk">{rank}</dd>
          )}
        </div>

        {roles !== null && (
          <div>
            <Eyebrow as="dt">Roles</Eyebrow>
            {roles.length === 0 ? (
              <dd className="text-12 text-muted">{NO_ROLES}</dd>
            ) : (
              <dd className="mt-1 flex flex-wrap gap-1.5">
                {roles.map((role, index) => (
                  <Badge key={`${index}-${role}`}>{role}</Badge>
                ))}
              </dd>
            )}
          </div>
        )}
      </dl>
    </div>
  );
}
