"use client";

import { useEffect, useState } from "react";
import type { DraftView } from "@/lib/types";

const money = (n: number) => n.toLocaleString("en-US");

export default function BidPanel({
  view,
  player,
  onDone,
}: {
  view: DraftView;
  player: string | null;
  onDone: () => void;
}) {
  const me = view.captains.find((c) => c.id === view.captainId);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A fresh lot means a fresh box.
  useEffect(() => {
    setAmount("");
    setError(null);
  }, [player]);

  if (!me) return null;

  const open = view.phase === "bidding" && !!player;
  const placed = me.hasBid;
  const value = Number(amount);
  const valid =
    amount !== "" && Number.isInteger(value) && value >= 0 && value <= me.balance;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/bid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: value }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) setError(data.error ?? "Bid rejected");
    setBusy(false);
    onDone();
  }

  if (placed) {
    return (
      <div className="panel p-6 text-center rise">
        <div className="eyebrow mb-3">Your bid is locked</div>
        <div className="font-display text-5xl text-signal leading-none stamp">
          {money(me.bid ?? 0)}
        </div>
        <p className="mt-4 text-sm text-muted">
          Waiting on the other captains. Nobody sees your number until the lot is settled.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="panel p-6 rise">
      <div className="flex items-baseline justify-between mb-4">
        <span className="eyebrow">Your bid</span>
        <span className="eyebrow">
          Balance <span className="num text-gold">{money(me.balance)}</span>
        </span>
      </div>

      <div className="flex gap-3">
        <input
          className="field text-2xl"
          inputMode="numeric"
          pattern="[0-9]*"
          placeholder="0"
          value={amount}
          disabled={!open || busy}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ""))}
        />
        <button type="submit" className="btn btn-gold px-8" disabled={!open || !valid || busy}>
          {busy ? "Sending…" : "Submit"}
        </button>
      </div>

      {!open && (
        <p className="mt-3 text-xs text-muted">
          Bidding opens once the wheel stops on a player.
        </p>
      )}
      {open && amount !== "" && !valid && (
        <p className="mt-3 text-xs text-ember">
          Enter a whole number no higher than {money(me.balance)}.
        </p>
      )}
      {error && <p className="mt-3 text-xs text-ember">{error}</p>}
    </form>
  );
}
