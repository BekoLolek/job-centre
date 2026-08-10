"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import MatchCard from "./MatchCard";
import AdminTools from "./AdminTools";
import { formatWhen, zoneLabel } from "@/lib/time";
import type { ResolvedMatch, TournamentView } from "@/lib/types";

const POLL_MS = 4000;

export default function TournamentBoard({ admin = false }: { admin?: boolean }) {
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

  const played = view.matches.filter((m) => m.status === "done").length;
  const live = view.matches.filter((m) => m.status === "live");
  const pending = view.matches.filter((m) => m.status === "pending");
  const scheduled = pending
    .filter((m) => m.scheduledAt)
    .sort((a, b) => (a.scheduledAt! < b.scheduledAt! ? -1 : 1));
  // With no schedule filled in, fall back to bracket order so the block is never empty.
  const upNext = [...live, ...scheduled, ...pending.filter((m) => !m.scheduledAt)].slice(0, 3);

  const card = (m: ResolvedMatch, featured?: boolean) => (
    <MatchCard
      key={m.id}
      match={m}
      editable={admin}
      run={admin ? run : undefined}
      featured={featured}
    />
  );

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-hair bg-ink/85 backdrop-blur">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 h-16 flex items-center gap-4">
          <div className="font-display text-xl tracking-wide">
            MARVEL RIVALS
            <span className="text-gold">{admin ? " SCHEDULE" : " TOURNAMENT"}</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {admin ? (
              <>
                <span className="eyebrow text-gold">Admin</span>
                <Link href="/" className="btn px-3 py-1.5">
                  Public board
                </Link>
                <Link href="/draft" className="btn px-3 py-1.5">
                  Draft
                </Link>
              </>
            ) : (
              <>
                {view.isAdmin && (
                  <Link href="/draft/schedule" className="btn px-3 py-1.5">
                    Edit results
                  </Link>
                )}
                <Link href="/draft" className="btn px-3 py-1.5">
                  Draft board
                </Link>
              </>
            )}
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
        {podium ? (
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
        ) : (
          <section className="panel p-6 rise">
            <div className="flex flex-wrap items-baseline justify-between gap-3 mb-4">
              <div className="eyebrow">Up next</div>
              <div className="eyebrow">
                <span className="num text-gold">{played}</span> of {view.matches.length}{" "}
                matches played · times in {zoneLabel()}
              </div>
            </div>
            {upNext.length === 0 ? (
              <p className="text-sm text-muted">
                Every match is in. Waiting on the last result to settle.
              </p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-3">
                {upNext.map((m) => (
                  <li key={m.id} className="border border-hair bg-raised/50 p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="eyebrow truncate">
                        {m.label} · Bo{m.bestOf}
                      </span>
                      {m.status === "live" && <span className="eyebrow text-ember">Live</span>}
                    </div>
                    <div className="mt-1.5 text-sm truncate">
                      {m.nameA} <span className="text-muted">vs</span> {m.nameB}
                    </div>
                    {m.scheduledAt && (
                      <div className="num mt-1 text-[11px] text-muted">
                        {formatWhen(m.scheduledAt)}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
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
                <div className="grid gap-4 sm:grid-cols-2">{round.map((m) => card(m))}</div>
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
                {card(byId("ubsf1"))}
                {card(byId("ubsf2"))}
                {card(byId("ubf"))}
              </div>
            </div>

            <div>
              <div className="eyebrow mb-2">Lower bracket</div>
              <div className="grid gap-4 lg:grid-cols-3">
                {card(byId("lbr1"))}
                {card(byId("lbf"))}
              </div>
            </div>

            <div>
              <div className="eyebrow mb-2">Grand final</div>
              <div className="grid gap-4 lg:grid-cols-3">{card(byId("gf"), true)}</div>
            </div>
          </div>
        </section>

        {admin && <AdminTools view={view} run={run} />}
      </main>
    </div>
  );
}
