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

import Link from "next/link";
import { Badge, EmptyState, Eyebrow, Panel } from "@/components/ui";
import { Money, TeamCard, lotLine, playerHref, playerName } from "@/components/draft";
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
          <Eyebrow as="span" className={view.lot?.allBidsIn ? "text-success" : undefined}>
            {view.lot?.allBidsIn
              ? "All bids in"
              : `${view.lot?.bidCount ?? 0} of ${view.teams.length} bid`}
          </Eyebrow>
        )}
      </div>

      {/*
        The rosters scroll inside the rail, exactly as the lot history below
        them and both pool lists already do. Nothing is hidden — every team is
        still here — but the rail stops setting the height of the grid row it
        sits in, which is what `lg:sticky` needs before it can mean anything:
        at 66 roster rows this list ran 3028px, the row ran with it, and the
        pool band underneath started 3256px down a 3655px page.

        `50vh - 8rem` is the same cap as the lot list below, and the pair of
        them is what sizes the rail: two lists plus the headings and the lot
        panel's own chrome come to `100vh - 130px`, which is inside the
        `100vh - 96px` the sticky offset leaves. That is the property worth
        holding — a sticky rail taller than the screen pins with its bottom
        below the fold, and whatever is down there can never be read. Sized off
        the viewport it holds on a laptop and on a 1440-tall monitor alike.
      */}
      <ul className="space-y-3 lg:max-h-[calc(50vh-8rem)] lg:overflow-y-auto lg:pr-1">
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
                  {mine && <Badge tone="union">You</Badge>}

                  {lotOpen &&
                    (team.hasBid ? (
                      <span className="flex items-baseline gap-1.5">
                        <Badge tone="success">✓ Bid in</Badge>
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
                      prefix={<span className="mr-1 text-11">Max </span>}
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
              <span className="num text-union">{sold.length}</span> sold ·{" "}
              <Money value={spent} size="sm" /> spent
            </Eyebrow>
          )}
        </div>

        {view.history.length === 0 ? (
          <EmptyState size="sm">Nothing drafted yet.</EmptyState>
        ) : (
          // Every lot, newest first. The list scrolls rather than being cut
          // short: the prices are the record, and the record is the point.
          <ul className="max-h-[420px] space-y-2 overflow-y-auto pr-1 lg:max-h-[calc(50vh-8rem)]">
            {view.history.map((lot) => {
              const line = lotLine(lot, { players: view.players, teams: view.teams });
              // The lot history is the other half of §4's "link to it from
              // rosters and the draft history": this list is a permanent record
              // of what somebody went for, so the name in it should reach the
              // page that collects every such record for them.
              const href = playerHref(view.players, lot.playerUserId);
              const name = (
                <span
                  className={lot.status === "voided" ? "text-muted line-through" : "text-chalk/90"}
                >
                  {line.player}
                </span>
              );
              return (
                <li key={lot.id} className="text-12 leading-snug">
                  {href ? (
                    <Link href={href} className="hover:text-union">
                      {name}
                    </Link>
                  ) : (
                    name
                  )}{" "}
                  <span className={line.tone === "flare" ? "text-flare" : "text-muted"}>
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
          <p className="text-12 text-muted">
            {playerName(view.players, view.you.userId, "You")} — in the{" "}
            {view.you.inPool === "reserve" ? "reserve" : "main"} pool, waiting to come up.
          </p>
        </Panel>
      )}
    </aside>
  );
}
