"use client";

/**
 * What the room sees: everyone who is not running the draft and not bidding in
 * it — signed out included (§11 puts the whole room in one row for watching).
 *
 * The bar of ticks is the whole idea. Amounts are sealed until the lot settles,
 * but *who has bid* never is, so a spectator can see the draft is waiting on
 * one captain without being told what anybody offered. When the event's
 * visibility setting is wider than that, the amounts arrive in the payload
 * already and the team cards on the left show them; nothing here has to decide
 * whether they may.
 */

import { Eyebrow, Panel } from "@/components/ui";
import { Money, lotSentence, playerName } from "@/components/draft";
import type { DraftRoomView } from "@/lib/draft";

export type WatchPanelProps = {
  view: DraftRoomView;
  spinning: boolean;
  onBlock: string | null;
  signedIn: boolean;
};

export default function WatchPanel({ view, spinning, onBlock, signedIn }: WatchPanelProps) {
  const submitted = view.teams.filter((team) => team.hasBid).length;
  const last = view.history.find((lot) => lot.status !== "voided") ?? null;
  const lastAward = view.history.find((lot) => lot.status === "awarded") ?? null;

  return (
    <Panel className="rise">
      <div className="mb-4 flex items-baseline justify-between">
        <Eyebrow as="span">Watching</Eyebrow>
        <Eyebrow as="span">
          Bids in <span className="num text-gold">{submitted}</span>/{view.teams.length}
        </Eyebrow>
      </div>

      <div className="mb-5 flex gap-1.5">
        {view.teams.map((team) => (
          <div
            key={team.id}
            title={team.name}
            className={`h-1.5 flex-1 transition-colors ${
              team.hasBid ? "bg-signal" : "bg-hair"
            }`}
          />
        ))}
      </div>

      {view.lot && !spinning ? (
        <p className="text-sm text-muted">
          Bidding is open on <span className="text-chalk">{onBlock ?? "a player"}</span>.{" "}
          {view.config.bidVisibility === "everyone"
            ? "Amounts are on the team cards as they come in."
            : "Amounts stay sealed until the lot is settled."}
        </p>
      ) : spinning ? (
        <p className="text-sm text-muted">The wheel is running.</p>
      ) : lastAward && last?.id === lastAward.id ? (
        <div>
          <Eyebrow className="mb-2">Last sale</Eyebrow>
          <div className="font-display text-3xl leading-none">
            {playerName(view.players, lastAward.playerUserId)}{" "}
            <span className="text-xl text-muted">
              → {view.teams.find((team) => team.id === lastAward.winnerTeamId)?.name ?? "—"}
            </span>
          </div>
          <Money value={lastAward.price ?? 0} size="xl" className="mt-2 block text-2xl" />
        </div>
      ) : last ? (
        <p className="text-sm text-muted">
          {lotSentence(last, { players: view.players, teams: view.teams })}
        </p>
      ) : (
        <p className="text-sm text-muted">Waiting on the first spin.</p>
      )}

      {view.you.inPool && (
        <p className="mt-4 border-t border-hair/60 pt-3 text-xs text-muted">
          You are in this draft&rsquo;s {view.you.inPool === "reserve" ? "reserve" : "main"} pool
          — your name is on the wheel.
        </p>
      )}

      {!signedIn && (
        <p className="mt-4 border-t border-hair/60 pt-3 text-xs text-muted">
          You are watching signed out. Signing in changes nothing here unless you are a
          captain in this draft.
        </p>
      )}
    </Panel>
  );
}
