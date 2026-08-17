"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Eyebrow } from "@/components/ui";
import Wheel from "@/components/Wheel";
import CaptainsRail from "@/components/CaptainsRail";
import BidPanel from "@/components/BidPanel";
import AdminControls from "@/components/AdminControls";
import AdminRail from "@/components/AdminRail";
import ObserverPanel from "@/components/ObserverPanel";
import { useDraft } from "@/lib/useDraft";
import type { DraftView } from "@/lib/types";

const money = (n: number) => n.toLocaleString("en-US");

/** Coarse ticker so the spin/bidding switch does not have to wait for the next poll. */
function useTicker(ms: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export default function DraftBoard() {
  const router = useRouter();
  const { view, offline, refresh, apply, clockOffset } = useDraft();
  const [error, setError] = useState<string | null>(null);
  useTicker(250);

  const run = useCallback(
    async (body: Record<string, unknown>) => {
      setError(null);
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        state?: DraftView;
      };
      if (!res.ok) {
        setError(data.error ?? "Action failed");
        if (data.state) apply(data.state);
        return;
      }
      apply(data as unknown as DraftView);
    },
    [apply]
  );

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  if (!view) {
    return (
      <div className="min-h-screen grid place-items-center">
        <Eyebrow className="animate-pulse">Loading the board…</Eyebrow>
      </div>
    );
  }

  const now = Date.now() + clockOffset.current;
  const spinning = !!view.spin && now < view.spin.startedAt + view.spin.durationMs;
  // The server withholds the name mid-spin; once the animation lands, the snapshot
  // in the spin payload is the answer — no need to wait for the next poll.
  const player =
    view.currentPlayer ?? (view.spin && !spinning ? view.spin.pool[view.spin.targetIndex] : null);
  const isAdmin = view.role === "admin";
  const result = view.lastResult;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-hair bg-ink/85 backdrop-blur">
        <div className="mx-auto max-w-[1500px] px-4 sm:px-6 h-16 flex items-center gap-4">
          <div className="font-display text-xl tracking-wide">
            JOB CENTRE<span className="text-gold"> DRAFT</span>
          </div>

          <Eyebrow className="hidden sm:flex items-center gap-2">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                offline ? "bg-ember" : "bg-signal"
              } ${offline ? "" : "live-dot"}`}
            />
            {offline ? "Reconnecting" : "Live"}
          </Eyebrow>

          <div className="ml-auto flex items-center gap-4">
            <Eyebrow as="span" className="hidden md:inline">
              Pool {view.mainPoolCount}
              {isAdmin && view.reservePoolCount > 0 && ` · Reserve ${view.reservePoolCount}`}
            </Eyebrow>
            <Eyebrow as="span" className="text-chalk/80">
              {isAdmin
                ? "Admin"
                : view.role === "observer"
                  ? "Observer"
                  : view.captains.find((c) => c.id === view.captainId)?.name}
            </Eyebrow>
            <Button href="/board" size="sm">
              Results
            </Button>
            {isAdmin && (
              <Button href="/draft/schedule" size="sm">
                Schedule
              </Button>
            )}
            <Button size="sm" onClick={logout}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      {error && (
        <div className="mx-auto max-w-[1500px] px-4 sm:px-6 pt-4">
          <Alert>{error}</Alert>
        </div>
      )}

      <main
        className={`mx-auto max-w-[1500px] px-4 sm:px-6 py-6 grid gap-6 lg:grid-cols-[300px_minmax(0,1fr)] ${
          isAdmin ? "xl:grid-cols-[300px_minmax(0,1fr)_330px]" : ""
        }`}
      >
        <CaptainsRail view={view} />

        <section className="flex flex-col items-center gap-6 min-w-0">
          <Eyebrow className="flex items-center gap-2">
            {view.activeWheel === "reserve" ? "Reserve wheel" : "Main wheel"}
            <span className="text-hair">/</span>
            {spinning ? (
              <span className="text-ember">Spinning</span>
            ) : player ? (
              <span className="text-gold">Bidding open</span>
            ) : (
              <span>Standby</span>
            )}
          </Eyebrow>

          <Wheel
            pool={view.spin ? view.spin.pool : view.activePool}
            spin={view.spin}
            clockOffset={clockOffset.current}
            onSettled={() => refresh()}
          />

          <div className="w-full max-w-2xl text-center">
            <Eyebrow className="mb-2">On the block</Eyebrow>
            <div
              key={player ?? "none"}
              className={`font-display text-[clamp(2rem,6vw,4rem)] leading-none ${
                player ? "text-chalk stamp" : "text-hair"
              }`}
            >
              {spinning ? "…" : (player ?? "—")}
            </div>

            {!player && result && (
              <p className="mt-3 text-sm text-muted">
                {result.action === "award" ? (
                  <>
                    <span className="text-chalk">{result.player}</span> went to{" "}
                    <span className="text-chalk">{result.winnerName}</span> for{" "}
                    <span className="num text-gold">{money(result.amount ?? 0)}</span>
                  </>
                ) : result.action === "reserve" ? (
                  <>
                    <span className="text-chalk">{result.player}</span> was held back for later
                  </>
                ) : (
                  <>
                    <span className="text-chalk">{result.player}</span> was taken off the list
                  </>
                )}
              </p>
            )}
          </div>

          <div className="w-full max-w-2xl">
            {isAdmin ? (
              <AdminControls view={view} player={player} spinning={spinning} run={run} />
            ) : view.role === "captain" ? (
              <BidPanel view={view} player={player} onDone={refresh} />
            ) : (
              <ObserverPanel view={view} player={player} spinning={spinning} />
            )}
          </div>
        </section>

        {isAdmin && <AdminRail view={view} run={run} />}
      </main>
    </div>
  );
}
