"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import MatchCard from "./MatchCard";
import AdminTools from "./AdminTools";
import type { TournamentView } from "@/lib/types";

const POLL_MS = 4000;

export default function TournamentBoard() {
  const [view, setView] = useState<TournamentView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/tournament", { cache: "no-store" });
      if (!res.ok) return;
      setView((await res.json()) as TournamentView);
    } catch {
      /* keep the last good board on a blip */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await refresh();
      if (alive) timer = setTimeout(loop, POLL_MS);
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [refresh]);

  const run = useCallback(
    async (body: Record<string, unknown>) => {
      setError(null);
      const res = await fetch("/api/tournament", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not save");
        await refresh();
        return;
      }
      setView(data as unknown as TournamentView);
    },
    [refresh]
  );

  if (!view) {
    return (
      <div className="min-h-screen grid place-items-center">
        <div className="eyebrow animate-pulse">Loading the board…</div>
      </div>
    );
  }

  const byId = (id: string) => view.matches.find((m) => m.id === id)!;
  const rrRounds = [1, 2, 3].map((n) =>
    view.matches.filter((m) => m.kind === "rr" && m.phase === n)
  );
  const teamName = (id: string) => view.teams.find((t) => t.id === id)?.name ?? "—";
  const podium = view.placements;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-hair bg-ink/85 backdrop-blur">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 h-16 flex items-center gap-4">
          <div className="font-display text-xl tracking-wide">
            MARVEL RIVALS<span className="text-gold"> TOURNAMENT</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {view.isAdmin && <span className="eyebrow text-gold">Admin</span>}
            <Link href="/draft" className="btn px-3 py-1.5">
              Draft board
            </Link>
          </div>
        </div>
      </header>

      {error && (
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 pt-4">
          <div className="border border-ember/40 bg-ember/10 px-3 py-2 text-sm text-ember">
            {error}
          </div>
        </div>
      )}

      <main className="mx-auto max-w-[1400px] px-4 sm:px-6 py-8 space-y-10">
        {podium && (
          <section className="panel p-6 rise">
            <div className="eyebrow mb-4">Final standings</div>
            <div className="grid gap-4 sm:grid-cols-4">
              {[
                { label: "Champion", id: podium.first, tone: "text-gold" },
                { label: "Runner-up", id: podium.second, tone: "text-chalk" },
                { label: "Bronze", id: podium.third, tone: "text-chalk/80" },
                { label: "Fourth", id: podium.fourth, tone: "text-muted" },
              ].map((row) => (
                <div key={row.label}>
                  <div className="eyebrow mb-1">{row.label}</div>
                  <div className={`font-display text-2xl leading-tight ${row.tone}`}>
                    {teamName(row.id)}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="font-display text-2xl">Round robin</h2>
            <span className="eyebrow">
              {view.seeds ? "Seeds locked" : "Single map · draws allowed"}
            </span>
          </div>

          <div className="panel overflow-x-auto mb-6">
            <table className="w-full text-sm min-w-[520px]">
              <thead>
                <tr className="border-b border-hair">
                  {["", "Team", "P", "W", "D", "L", "Diff", "Pts"].map((h, i) => (
                    <th
                      key={h + i}
                      className={`eyebrow px-3 py-2 ${i > 1 ? "text-right" : "text-left"}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.standings.map((row, i) => (
                  <tr key={row.id} className="border-b border-hair/60 last:border-0">
                    <td className="num px-3 py-2 text-muted">{i + 1}</td>
                    <td className="px-3 py-2">{row.name}</td>
                    <td className="num px-3 py-2 text-right text-muted">{row.played}</td>
                    <td className="num px-3 py-2 text-right">{row.won}</td>
                    <td className="num px-3 py-2 text-right">{row.drawn}</td>
                    <td className="num px-3 py-2 text-right">{row.lost}</td>
                    <td className="num px-3 py-2 text-right text-muted">
                      {row.diff > 0 ? `+${row.diff}` : row.diff}
                    </td>
                    <td className="num px-3 py-2 text-right text-gold">{row.points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-5">
            {rrRounds.map((round, i) => (
              <div key={i}>
                <div className="eyebrow mb-2">Round {i + 1}</div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {round.map((m) => (
                    <MatchCard key={m.id} match={m} view={view} run={run} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="font-display text-2xl">Double elimination</h2>
            <span className="eyebrow">
              {view.seeds
                ? `Seeds · ${view.seeds.map((id, i) => `${i + 1} ${teamName(id)}`).join("  ·  ")}`
                : "Bracket fills once the round robin is complete"}
            </span>
          </div>

          <div className="space-y-6">
            <div>
              <div className="eyebrow mb-2">Upper bracket</div>
              <div className="grid gap-4 lg:grid-cols-3">
                <MatchCard match={byId("ubsf1")} view={view} run={run} />
                <MatchCard match={byId("ubsf2")} view={view} run={run} />
                <MatchCard match={byId("ubf")} view={view} run={run} />
              </div>
            </div>

            <div>
              <div className="eyebrow mb-2">Lower bracket</div>
              <div className="grid gap-4 lg:grid-cols-3">
                <MatchCard match={byId("lbr1")} view={view} run={run} />
                <MatchCard match={byId("lbf")} view={view} run={run} />
              </div>
            </div>

            <div>
              <div className="eyebrow mb-2">Grand final</div>
              <div className="grid gap-4 lg:grid-cols-3">
                <MatchCard match={byId("gf")} view={view} run={run} featured />
              </div>
            </div>
          </div>
        </section>

        {view.isAdmin && <AdminTools view={view} run={run} />}
      </main>
    </div>
  );
}
