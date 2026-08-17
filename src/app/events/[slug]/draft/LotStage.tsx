"use client";

/**
 * The middle of the room: the wheel, the name it lands on, and the clock.
 *
 * `Wheel` is the current board's component, untouched. It takes a pool of
 * *names* and a spin payload, and animates deterministically from
 * `spin.startedAt` against a clock offset — which is exactly why the stored
 * spin shape was kept identical when the draft moved onto Postgres. All this
 * does is translate user ids into display names on the way in.
 *
 * The player's name is not shown until the animation lands. That is not a
 * courtesy: `redactDraft` withholds `lot.playerUserId` from *everyone*,
 * including the admin, while the wheel is turning, so there is nothing to
 * reveal early even in the payload.
 */

import Wheel from "@/components/Wheel";
import { Eyebrow } from "@/components/ui";
import { lotSentence, playerName, poolLabel, stageLabel } from "@/components/draft";
import type { DraftPoolKind } from "@/db/schema";
import type { DraftRoomView } from "@/lib/draft";
import type { PoolPlayer } from "@/lib/draft-policy";

export type LotStageProps = {
  view: DraftRoomView;
  /** The names on the wheel between spins. During one, the spin's own pool wins. */
  pool: readonly PoolPlayer[];
  poolKind: DraftPoolKind;
  spinning: boolean;
  /** The name on the block, or null while it is still hidden. */
  onBlock: string | null;
  /** `serverNow - clientNow`, so every browser animates on the same clock. */
  clockOffset: number;
  now: number;
  onSettled: () => void;
};

export default function LotStage({
  view,
  pool,
  poolKind,
  spinning,
  onBlock,
  clockOffset,
  now,
  onSettled,
}: LotStageProps) {
  const spin = view.lot?.spin ?? null;
  const names = pool.map((entry) => playerName(view.players, entry.userId));

  const wheelSpin = spin
    ? {
        wheel: view.lot?.fromKind ?? poolKind,
        pool: spin.pool.map((userId) => playerName(view.players, userId)),
        targetIndex: spin.targetIndex,
        startedAt: spin.startedAt,
        durationMs: spin.durationMs,
        turns: spin.turns,
      }
    : null;

  const endsAt = view.lot?.endsAt ?? null;
  const secondsLeft =
    endsAt === null ? null : Math.max(0, Math.ceil((endsAt - now) / 1000));
  const last = view.history.find((lot) => lot.status !== "voided") ?? null;

  return (
    <>
      <Eyebrow className="flex flex-wrap items-center gap-2">
        {poolLabel(poolKind)}
        <span className="text-hair">/</span>
        {spinning ? (
          <span className="text-ember">{stageLabel(view.phase, Boolean(view.lot))}</span>
        ) : view.lot ? (
          <span className="text-gold">{stageLabel(view.phase, true)}</span>
        ) : (
          <span>{stageLabel(view.phase, false)}</span>
        )}
        {secondsLeft !== null && (
          <>
            <span className="text-hair">/</span>
            <span className={secondsLeft === 0 ? "text-ember" : "text-chalk"}>
              {secondsLeft === 0 ? "Bidding closed" : `${secondsLeft}s left`}
            </span>
          </>
        )}
      </Eyebrow>

      <Wheel
        pool={names}
        spin={wheelSpin}
        clockOffset={clockOffset}
        onSettled={onSettled}
      />

      <div className="w-full max-w-2xl text-center">
        <Eyebrow className="mb-2">On the block</Eyebrow>
        <div
          key={onBlock ?? "none"}
          className={`font-display text-[clamp(2rem,6vw,4rem)] leading-none ${
            onBlock ? "stamp text-chalk" : "text-hair"
          }`}
        >
          {spinning ? "…" : (onBlock ?? "—")}
        </div>

        {!view.lot && last && (
          <p className="mt-3 text-sm text-muted">
            {lotSentence(last, { players: view.players, teams: view.teams })}
          </p>
        )}
      </div>
    </>
  );
}
