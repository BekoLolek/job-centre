"use client";

import { Badge, EmptyState, Eyebrow, Panel } from "@/components/ui";
import type { DraftView } from "@/lib/types";

const money = (n: number) => n.toLocaleString("en-US");

export default function CaptainsRail({ view }: { view: DraftView }) {
  const sold = view.history.filter((r) => r.action === "award");
  const spent = sold.reduce((total, r) => total + (r.amount ?? 0), 0);

  return (
    <Panel as="aside" padding="md" className="h-fit lg:sticky lg:top-24">
      <div className="flex items-baseline justify-between mb-5">
        <Eyebrow as="h2">Captains</Eyebrow>
        <Eyebrow as="span">{view.allBidsIn ? "All bids in" : "Awaiting bids"}</Eyebrow>
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
                  {isMe && <Eyebrow className="mt-1 text-gold/70">You</Eyebrow>}
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
                    <Badge key={p}>{p}</Badge>
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
        <div className="flex items-baseline justify-between mb-3">
          <Eyebrow as="h3">Lots</Eyebrow>
          {view.history.length > 0 && (
            <Eyebrow as="span">
              <span className="num text-gold">{sold.length}</span> sold ·{" "}
              <span className="num text-gold">{money(spent)}</span> spent
            </Eyebrow>
          )}
        </div>
        {view.history.length === 0 ? (
          <EmptyState size="sm">Nothing drafted yet.</EmptyState>
        ) : (
          // Every lot, newest first — the list scrolls rather than being cut short.
          <ul className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
            {view.history.map((r, i) => (
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
    </Panel>
  );
}
