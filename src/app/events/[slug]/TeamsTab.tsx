import { Money, TeamCard, formatMoney } from "@/components/draft";
import { Badge, EmptyState, Eyebrow, Panel, plural } from "@/components/ui";
import type { EventBoard } from "@/lib/event-board";

/**
 * The Teams tab (§4: rosters, captains, what each player cost, what is left).
 *
 * This is where the draft stops being a live room and becomes a record. The
 * prices on these cards are `team_members.price` rows written once when a lot
 * was awarded and never rewritten, so they are the same numbers the captains
 * saw on the night — permanently, publicly, without anybody having to keep a
 * screenshot.
 *
 * The card itself is `src/components/draft/TeamCard`, the same one the admin's
 * Teams tab and the live draft room draw, so a balance never looks like two
 * different things on two different pages. Nothing here is public-specific
 * except that there are no controls: everybody sees the same figures, because
 * by the time a team page exists there is nothing left to redact (§11).
 *
 * No instants are formatted anywhere in this file, which is why it can stay a
 * server component.
 */

export type TeamsTabProps = {
  board: EventBoard;
};

export default function TeamsTab({ board }: TeamsTabProps) {
  const { teams, players } = board;

  if (teams.length === 0) {
    return (
      <Panel as="section">
        <Eyebrow className="mb-4">Teams</Eyebrow>
        <EmptyState>
          No teams yet. They appear here as soon as the admin names them, and fill up as the
          draft runs.
        </EmptyState>
      </Panel>
    );
  }

  const drafted = teams.reduce(
    (total, team) => total + team.members.filter((member) => !member.isCaptain).length,
    0
  );
  const spent = teams.reduce((total, team) => total + (team.balanceStart - team.balance), 0);
  const priced = teams.flatMap((team) =>
    team.members.filter((member) => !member.isCaptain).map((member) => member.price)
  );
  const dearest = priced.length > 0 ? Math.max(...priced) : 0;
  const withoutCaptain = teams.filter((team) => !team.captainUserId).length;

  return (
    <section className="space-y-6">
      <Panel padding="md">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3">
          <Eyebrow>
            {plural(teams.length, "team")} · {plural(drafted, "player")} drafted
          </Eyebrow>

          {spent > 0 && (
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
              <span className="flex items-baseline gap-2">
                <Eyebrow as="span">Total spent</Eyebrow>
                <Money value={spent} />
              </span>
              {dearest > 0 && (
                <span className="flex items-baseline gap-2">
                  <Eyebrow as="span">Top price</Eyebrow>
                  <Money value={dearest} />
                </span>
              )}
            </div>
          )}
        </div>

        {withoutCaptain > 0 && (
          <p className="mt-4 border-t border-hair pt-3 text-xs text-muted">
            {withoutCaptain === teams.length
              ? "Captains have not been chosen yet."
              : `${plural(withoutCaptain, "team")} still without a captain.`}
          </p>
        )}
      </Panel>

      <ul className="grid gap-4 lg:grid-cols-2">
        {teams.map((team) => (
          <li key={team.id}>
            <TeamCard team={team} players={players} showRoster warnNoCaptain />
          </li>
        ))}
      </ul>

      <p className="text-xs leading-relaxed text-muted">
        Every price is what that player actually went for at the draft, and a captain costs
        nothing because they were never bid for. A team&apos;s remaining balance is worked out
        from the lots it won rather than stored, so it can never disagree with the roster above
        it — the figures add up to {formatMoney(spent)} spent across every team.
      </p>
    </section>
  );
}
