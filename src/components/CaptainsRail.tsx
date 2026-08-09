"use client";

import type { DraftView } from "@/lib/types";

const money = (n: number) => n.toLocaleString("en-US");

export default function CaptainsRail({ view }: { view: DraftView }) {
  return (
    <aside className="panel p-5 h-fit lg:sticky lg:top-24">
      <div className="flex items-baseline justify-between mb-5">
        <h2 className="eyebrow">Captains</h2>
        <span className="eyebrow">{view.allBidsIn ? "All bids in" : "Awaiting bids"}</span>
      </div>

      <ul className="space-y-3">
        {view.captains.map((c, i) => {
          const isMe = c.id === view.captainId;
          const winning = view.lastResult?.winnerId === c.id;
          return (
            <li
              key={c.id}
              className={`relative border p-3 transition-colors rise ${
                isMe ? "border-gold/50 bg-gold/[0.04]" : "border-hair bg-raised/60"
              }`}
              style={{ animationDelay: `${i * 60}ms` }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-display text-lg leading-none truncate">
                      {c.name}
                    </span>
                    {c.hasBid && (
                      <span
                        title="Bid submitted"
                        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-signal/15 text-signal text-[10px] leading-none"
                      >
                        ✓
                      </span>
                    )}
                  </div>
                  {isMe && <div className="eyebrow mt-1 text-gold/70">You</div>}
                </div>
                <div className="text-right shrink-0">
                  <div className="num text-gold text-base leading-none">{money(c.balance)}</div>
                  {c.bid !== null && (
                    <div className="num text-[10px] text-muted mt-1">bid {money(c.bid)}</div>
                  )}
                </div>
              </div>

              {c.roster.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {c.roster.map((p) => (
                    <span
                      key={p}
                      className="border border-hair bg-ink/60 px-1.5 py-0.5 text-[11px] text-chalk/80"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              )}

              {winning && (
                <span className="absolute -top-2 -right-2 bg-gold px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-widest text-ink stamp">
                  Won
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-6 border-t border-hair pt-4">
        <h3 className="eyebrow mb-3">Recent lots</h3>
        {view.history.length === 0 ? (
          <p className="text-xs text-muted">Nothing drafted yet.</p>
        ) : (
          <ul className="space-y-2">
            {view.history.slice(0, 8).map((r, i) => (
              <li key={`${r.player}-${r.at}-${i}`} className="text-xs leading-snug">
                <span className="text-chalk/90">{r.player}</span>{" "}
                {r.action === "award" ? (
                  <span className="text-muted">
                    → {r.winnerName} ·{" "}
                    <span className="num text-gold">{money(r.amount ?? 0)}</span>
                  </span>
                ) : r.action === "reserve" ? (
                  <span className="text-muted">→ held back</span>
                ) : (
                  <span className="text-muted">→ removed</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
