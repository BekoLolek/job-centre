"use client";

import type { DraftView } from "@/lib/types";

const money = (n: number) => n.toLocaleString("en-US");

export default function ObserverPanel({
  view,
  player,
  spinning,
}: {
  view: DraftView;
  player: string | null;
  spinning: boolean;
}) {
  const submitted = view.captains.filter((c) => c.hasBid).length;
  const result = view.lastResult;

  return (
    <div className="panel p-6 rise">
      <div className="flex items-baseline justify-between mb-4">
        <span className="eyebrow">Watching</span>
        <span className="eyebrow">
          Bids in <span className="num text-gold">{submitted}</span>/{view.captains.length}
        </span>
      </div>

      <div className="flex gap-1.5 mb-5">
        {view.captains.map((c) => (
          <div
            key={c.id}
            title={c.name}
            className={`h-1.5 flex-1 transition-colors ${
              c.hasBid ? "bg-signal" : "bg-hair"
            }`}
          />
        ))}
      </div>

      {player && !spinning ? (
        <p className="text-sm text-muted">
          Bidding is open on <span className="text-chalk">{player}</span>. Amounts stay
          sealed until the lot is settled.
        </p>
      ) : spinning ? (
        <p className="text-sm text-muted">The wheel is running.</p>
      ) : result?.action === "award" ? (
        <div>
          <div className="eyebrow mb-2">Last sale</div>
          <div className="font-display text-3xl leading-none">
            {result.player}{" "}
            <span className="text-muted text-xl">→ {result.winnerName}</span>
          </div>
          <div className="num mt-2 text-2xl text-gold">{money(result.amount ?? 0)}</div>
        </div>
      ) : (
        <p className="text-sm text-muted">Waiting on the next spin.</p>
      )}
    </div>
  );
}
