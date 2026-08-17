"use client";

/**
 * The teams, down the left: balance, tick, roster — and every lot so far.
 *
 * The tick is the load-bearing part. §11 makes *that* a team has bid public to
 * the whole room while the amount is not, so a captain watching can see three
 * ticks and know they are the one holding everybody up. `team.hasBid` is
 * `redactDraft`'s and is always present; `team.bid` is the number and is null
 * for anybody not entitled to it — so a card that shows the tick and no figure
 * is the redaction working, not data missing.
 *
 * The card itself is `src/components/draft/TeamCard`, the same one the admin's
 * setup screens draw, so a balance never looks like two different things on two
 * different pages.
 */

import { Badge, EmptyState, Eyebrow, Panel } from "@/components/ui";
import { Money, TeamCard, lotLine, playerName } from "@/components/draft";
import type { DraftRoomView } from "@/lib/draft";

export type TeamsRailProps = {
  view: DraftRoomView;
};

export default function TeamsRail({ view }: TeamsRailProps) {
  const lotOpen = Boolean(view.lot);
  const sold = view.history.filter((lot) => lot.status === "awarded");
  const spent = sold.reduce((total, lot) => total + (lot.price ?? 0), 0);

  return (
    <aside className="h-fit space-y-4 lg:sticky lg:top-24">
      <div className="flex items-baseline justify-between">
        <Eyebrow as="h2">Teams</Eyebrow>
        {lotOpen && (
          <Eyebrow as="span" className={view.lot?.allBidsIn ? "text-signal" : undefined}>
            {view.lot?.allBidsIn
              ? "All bids in"
              : `${view.lot?.bidCount ?? 0} of ${view.teams.length} bid`}
          </Eyebrow>
        )}
      </div>

      <ul className="space-y-3">
        {view.teams.map((team) => {
          const mine = team.id === view.you.teamId;
          return (
            <li key={team.id}>
              <TeamCard
                team={team}
                players={view.players}
                showRoster
                warnNoCaptain
                active={mine || (lotOpen && team.hasBid)}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {mine && <Badge tone="gold">You</Badge>}

                  {lotOpen &&
                    (team.hasBid ? (
                      <span className="flex items-baseline gap-1.5">
                        <Badge tone="signal">✓ Bid in</Badge>
                        {team.bid !== null && <Money value={team.bid} size="lg" />}
                      </span>
                    ) : (
                      <span className="eyebrow text-muted">No bid yet</span>
                    ))}

                  {team.maxBid !== null && (
                    <Money
                      value={team.maxBid}
                      tone="muted"
                      size="sm"
                      prefix={<span className="mr-1 text-[10px] uppercase">Max </span>}
                    />
                  )}
                </div>
              </TeamCard>
            </li>
          );
        })}
      </ul>

      <Panel padding="md">
        <div className="mb-3 flex items-baseline justify-between">
          <Eyebrow as="h3">Lots</Eyebrow>
          {view.history.length > 0 && (
            <Eyebrow as="span">
              <span className="num text-gold">{sold.length}</span> sold ·{" "}
              <Money value={spent} size="sm" /> spent
            </Eyebrow>
          )}
        </div>

        {view.history.length === 0 ? (
          <EmptyState size="sm">Nothing drafted yet.</EmptyState>
        ) : (
          // Every lot, newest first. The list scrolls rather than being cut
          // short: the prices are the record, and the record is the point.
          <ul className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
            {view.history.map((lot) => {
              const line = lotLine(lot, { players: view.players, teams: view.teams });
              return (
                <li key={lot.id} className="text-xs leading-snug">
                  <span
                    className={lot.status === "voided" ? "text-muted line-through" : "text-chalk/90"}
                  >
                    {line.player}
                  </span>{" "}
                  <span className={line.tone === "ember" ? "text-ember/80" : "text-muted"}>
                    {line.outcome}
                  </span>
                  {line.price !== null && (
                    <>
                      {" · "}
                      <Money value={line.price} size="sm" />
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {view.you.inPool && (
        <Panel padding="sm">
          <Eyebrow className="mb-1">You</Eyebrow>
          <p className="text-xs text-muted">
            {playerName(view.players, view.you.userId, "You")} — in the{" "}
            {view.you.inPool === "reserve" ? "reserve" : "main"} pool, waiting to come up.
          </p>
        </Panel>
      )}
    </aside>
  );
}
