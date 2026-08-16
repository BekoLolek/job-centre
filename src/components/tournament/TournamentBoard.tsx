"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import MatchCard from "./MatchCard";
import AdminTools from "./AdminTools";
import {
  Alert,
  Button,
  EmptyState,
  Eyebrow,
  Panel,
  StatTile,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeadCell,
  TableRow,
} from "@/components/ui";
import { formatWhen, zoneLabel } from "@/lib/time";
import type { ResolvedMatch, TournamentView } from "@/lib/types";

const POLL_MS = 4000;

export default function TournamentBoard({
  admin = false,
  /**
   * The session-aware links from plan §4 (Profile, and Admin for admins),
   * rendered on the server and passed in — this component cannot read a cookie.
   */
  nav,
}: {
  admin?: boolean;
  nav?: ReactNode;
}) {
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
        <Eyebrow className="animate-pulse">Loading the board…</Eyebrow>
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
  // The matches array is already in play order, and a later match having a start time
  // while an earlier one does not must not float it to the front.
  const pending = view.matches.filter((m) => m.status === "pending");
  const upNext = [...live, ...pending].slice(0, 3);

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
            JOB CENTRE
            <span className="text-gold">{admin ? " SCHEDULE" : " EVENTS"}</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {admin ? (
              <>
                <Eyebrow as="span" className="text-gold">
                  Admin
                </Eyebrow>
                <Button href="/" size="sm">
                  Public board
                </Button>
                <Button href="/draft" size="sm">
                  Draft
                </Button>
              </>
            ) : (
              <>
                {view.isAdmin && (
                  <Button href="/draft/schedule" size="sm">
                    Edit results
                  </Button>
                )}
                <Button href="/draft" size="sm">
                  Draft board
                </Button>
              </>
            )}
            {nav}
          </div>
        </div>
      </header>

      {error && (
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 pt-4">
          <Alert>{error}</Alert>
        </div>
      )}

      <main className="mx-auto max-w-[1400px] px-4 sm:px-6 py-8 space-y-10">
        {podium ? (
          <Panel as="section" className="rise">
            <Eyebrow className="mb-4">Final standings</Eyebrow>
            <div className="grid gap-4 sm:grid-cols-4">
              {[
                { label: "Champion", id: podium.first, tone: "text-gold" },
                { label: "Runner-up", id: podium.second, tone: "text-chalk" },
                { label: "Bronze", id: podium.third, tone: "text-chalk/80" },
                { label: "Fourth", id: podium.fourth, tone: "text-muted" },
              ].map((row) => (
                <StatTile
                  key={row.label}
                  label={row.label}
                  value={teamName(row.id)}
                  valueClassName={row.tone}
                />
              ))}
            </div>
          </Panel>
        ) : (
          <Panel as="section" className="rise">
            <div className="flex flex-wrap items-baseline justify-between gap-3 mb-4">
              <Eyebrow>Up next</Eyebrow>
              <Eyebrow>
                <span className="num text-gold">{played}</span> of {view.matches.length}{" "}
                matches played · times in {zoneLabel()}
              </Eyebrow>
            </div>
            {upNext.length === 0 ? (
              <EmptyState>
                Every match is in. Waiting on the last result to settle.
              </EmptyState>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-3">
                {upNext.map((m) => (
                  <li key={m.id} className="border border-hair bg-raised/50 p-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <Eyebrow as="span" className="truncate">
                        {m.label} · Bo{m.bestOf}
                      </Eyebrow>
                      {m.status === "live" && (
                        <Eyebrow as="span" className="text-ember">
                          Live
                        </Eyebrow>
                      )}
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
          </Panel>
        )}

        <section>
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="font-display text-2xl">Round robin</h2>
            <Eyebrow as="span">
              {view.seeds ? "Seeds locked" : "Single map · draws allowed"}
            </Eyebrow>
          </div>

          <Panel padding="none" className="overflow-x-auto mb-6">
            <Table className="min-w-[520px]">
              <TableHead>
                {["", "Team", "P", "W", "D", "L", "Diff", "Pts"].map((h, i) => (
                  <TableHeadCell key={h + i} align={i > 1 ? "right" : "left"}>
                    {h}
                  </TableHeadCell>
                ))}
              </TableHead>
              <TableBody>
                {view.standings.map((row, i) => (
                  <TableRow key={row.id}>
                    <TableCell numeric className="text-muted">
                      {i + 1}
                    </TableCell>
                    <TableCell>{row.name}</TableCell>
                    <TableCell numeric align="right" className="text-muted">
                      {row.played}
                    </TableCell>
                    <TableCell numeric align="right">
                      {row.won}
                    </TableCell>
                    <TableCell numeric align="right">
                      {row.drawn}
                    </TableCell>
                    <TableCell numeric align="right">
                      {row.lost}
                    </TableCell>
                    <TableCell numeric align="right" className="text-muted">
                      {row.diff > 0 ? `+${row.diff}` : row.diff}
                    </TableCell>
                    <TableCell numeric align="right" className="text-gold">
                      {row.points}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>

          <div className="space-y-5">
            {rrRounds.map((round, i) => (
              <div key={i}>
                <Eyebrow className="mb-2">Round {i + 1}</Eyebrow>
                <div className="grid gap-4 sm:grid-cols-2">{round.map((m) => card(m))}</div>
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="font-display text-2xl">Double elimination</h2>
            <Eyebrow as="span">
              {view.seeds
                ? `Seeds · ${view.seeds.map((id, i) => `${i + 1} ${teamName(id)}`).join("  ·  ")}`
                : "Bracket fills once the round robin is complete"}
            </Eyebrow>
          </div>

          <div className="space-y-6">
            <div>
              <Eyebrow className="mb-2">Upper bracket</Eyebrow>
              <div className="grid gap-4 lg:grid-cols-3">
                {card(byId("ubsf1"))}
                {card(byId("ubsf2"))}
                {card(byId("ubf"))}
              </div>
            </div>

            <div>
              <Eyebrow className="mb-2">Lower bracket</Eyebrow>
              <div className="grid gap-4 lg:grid-cols-3">
                {card(byId("lbr1"))}
                {card(byId("lbf"))}
              </div>
            </div>

            <div>
              <Eyebrow className="mb-2">Grand final</Eyebrow>
              <div className="grid gap-4 lg:grid-cols-3">{card(byId("gf"), true)}</div>
            </div>
          </div>
        </section>

        {admin && <AdminTools view={view} run={run} />}
      </main>
    </div>
  );
}
