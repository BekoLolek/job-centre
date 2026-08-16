"use client";

import { Button, Eyebrow, Panel, Tabs } from "@/components/ui";
import type { DraftView } from "@/lib/types";

const money = (n: number) => n.toLocaleString("en-US");

export default function AdminControls({
  view,
  player,
  spinning,
  run,
}: {
  view: DraftView;
  player: string | null;
  spinning: boolean;
  run: (body: Record<string, unknown>) => Promise<void>;
}) {
  const poolSize = view.activeWheel === "main" ? view.mainPoolCount : view.reservePoolCount;
  const lotOpen = !!player && !spinning;
  const bids = view.captains.filter((c) => c.hasBid);
  const top = bids.reduce((best, c) => (c.bid! > (best?.bid ?? -1) ? c : best), bids[0]);

  return (
    <Panel className="rise">
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <Tabs
          items={[
            { value: "main", label: `Main ${view.mainPoolCount}` },
            { value: "reserve", label: `Reserve ${view.reservePoolCount}` },
          ]}
          value={view.activeWheel}
          onChange={(wheel) => run({ type: "setWheel", wheel })}
          disabled={!!player}
        />

        <Button
          variant="gold"
          className="flex-1 min-w-[160px] text-sm"
          disabled={spinning || !!player || poolSize === 0}
          onClick={() => run({ type: "spin" })}
        >
          {spinning ? "Spinning…" : "Spin the wheel"}
        </Button>

        <Button disabled={view.history.length === 0} onClick={() => run({ type: "undo" })}>
          Undo
        </Button>
      </div>

      {!lotOpen ? (
        <p className="text-sm text-muted">
          {spinning
            ? "Wheel is running — bidding opens the moment it stops."
            : poolSize === 0
              ? "This wheel is empty. Add players or switch wheels."
              : "Spin to put the next player on the block."}
        </p>
      ) : (
        <>
          <div className="flex items-baseline justify-between mb-3">
            <Eyebrow as="span">
              Bids · {bids.length}/{view.captains.length}
            </Eyebrow>
            {!view.allBidsIn && (
              <Eyebrow as="span" className="text-ember">
                Incomplete
              </Eyebrow>
            )}
          </div>

          <ul className="space-y-2 mb-5">
            {view.captains.map((c) => {
              const isTop = view.allBidsIn && top?.id === c.id && (c.bid ?? 0) > 0;
              return (
                <li
                  key={c.id}
                  className={`flex items-center gap-3 border px-3 py-2 ${
                    isTop ? "border-gold/60 bg-gold/[0.06]" : "border-hair"
                  }`}
                >
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="num text-lg text-gold w-24 text-right">
                    {c.hasBid ? money(c.bid ?? 0) : "—"}
                  </span>
                  <Button
                    size="sm"
                    disabled={!c.hasBid}
                    onClick={() => run({ type: "clearBid", captainId: c.id })}
                    title="Clear this bid so they can re-enter it"
                  >
                    Clear
                  </Button>
                  <Button
                    size="sm"
                    variant={isTop ? "gold" : "default"}
                    disabled={!c.hasBid || (c.bid ?? 0) > c.balance}
                    onClick={() => run({ type: "award", captainId: c.id })}
                  >
                    Award
                  </Button>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-wrap gap-2">
            <Button variant="ember" onClick={() => run({ type: "discard" })}>
              Take off the list
            </Button>
            <Button
              disabled={view.activeWheel === "reserve"}
              onClick={() => run({ type: "toReserve" })}
            >
              Move to reserve wheel
            </Button>
            <Button onClick={() => run({ type: "clearBids" })}>Clear all bids</Button>
            <Button onClick={() => run({ type: "cancel" })}>Cancel lot</Button>
          </div>
        </>
      )}
    </Panel>
  );
}
