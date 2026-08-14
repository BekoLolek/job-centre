"use client";

import { useEffect, useState } from "react";
import { formatClock, formatWhen, toInstant, toLocalInput } from "@/lib/time";
import type { ResolvedMatch } from "@/lib/types";

const MODE_LABEL = { convoy: "Convoy / convergence", domination: "Domination" } as const;

type Draft = {
  scheduledAt: string;
  durationMin: string;
  winnerOverride: string;
  games: Array<{ map: string; scoreA: string; scoreB: string; played: boolean }>;
};

function draftFrom(match: ResolvedMatch): Draft {
  return {
    // The input is naive; it shows the instant in the admin's own zone.
    scheduledAt: toLocalInput(match.scheduledAt),
    durationMin: match.durationMin === null ? "" : String(match.durationMin),
    winnerOverride: match.winnerOverride ?? "",
    games: match.games.map((g) => ({
      map: g.map,
      scoreA: String(g.scoreA),
      scoreB: String(g.scoreB),
      played: g.played,
    })),
  };
}

export default function MatchCard({
  match,
  editable,
  run,
  featured,
}: {
  match: ResolvedMatch;
  /** Only the admin schedule page passes this; the public board is read-only. */
  editable?: boolean;
  run?: (body: Record<string, unknown>) => Promise<void>;
  featured?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Draft>(() => draftFrom(match));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) setForm(draftFrom(match));
  }, [match, open]);

  const when = formatWhen(match.scheduledAt);
  const playedGames = match.games.filter((g) => g.played);
  const aWins = match.status === "done" && match.winner === match.teamA;
  const bWins = match.status === "done" && match.winner === match.teamB;

  /**
   * Typing a score marks the game as played. Without this an admin can fill in a whole
   * series, hit save, and have nothing count because a checkbox was left untouched.
   */
  const setScore = (index: number, field: "scoreA" | "scoreB", raw: string) => {
    const value = raw.replace(/[^0-9]/g, "");
    setForm({
      ...form,
      games: form.games.map((g, j) =>
        j === index ? { ...g, [field]: value, played: value !== "" ? true : g.played } : g
      ),
    });
  };

  const save = async () => {
    if (!run) return;
    setBusy(true);
    await run({
      type: "saveMatch",
      matchId: match.id,
      scheduledAt: form.scheduledAt ? toInstant(form.scheduledAt) : "",
      durationMin: form.durationMin,
      winnerOverride: form.winnerOverride,
      games: form.games.map((g) => ({
        map: g.map,
        scoreA: g.scoreA,
        scoreB: g.scoreB,
        played: g.played,
      })),
    });
    setBusy(false);
    setOpen(false);
  };

  return (
    <article
      className={`panel p-4 ${featured ? "border-gold/40" : ""} ${
        match.status === "live" ? "border-ember/40" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <div className="eyebrow truncate">
            {match.label} · Bo{match.bestOf}
          </div>
          {match.note && <div className="eyebrow text-muted/70 mt-1">{match.note}</div>}
        </div>
        <div className="text-right shrink-0">
          {when && <div className="num text-[11px] text-muted">{when}</div>}
          {match.finishedAt ? (
            <div className="num text-[11px] text-muted">
              ran to {formatClock(match.finishedAt)}
              {match.durationMin !== null && ` · ${match.durationMin} min`}
            </div>
          ) : (
            match.durationMin !== null && (
              <div className="num text-[11px] text-muted">{match.durationMin} min</div>
            )
          )}
          {match.needsDecision ? (
            <div className="eyebrow text-ember mt-1">Needs a winner</div>
          ) : match.status === "live" ? (
            <div className="eyebrow text-ember mt-1">In progress</div>
          ) : null}
        </div>
      </div>

      <div className="space-y-1.5">
        <TeamRow
          name={match.nameA}
          score={match.bestOf === 1 ? (match.games[0]?.scoreA ?? 0) : match.gamesWonA}
          won={aWins}
          dim={!match.teamA}
        />
        <TeamRow
          name={match.nameB}
          score={match.bestOf === 1 ? (match.games[0]?.scoreB ?? 0) : match.gamesWonB}
          won={bWins}
          dim={!match.teamB}
        />
      </div>

      {playedGames.length > 0 && match.bestOf > 1 && (
        <ul className="mt-3 border-t border-hair pt-3 space-y-1">
          {match.games.map((g, i) =>
            g.played ? (
              <li key={i} className="flex items-baseline gap-2 text-[11px]">
                <span className="eyebrow shrink-0">G{i + 1}</span>
                <span className="text-muted truncate flex-1">
                  {g.map || MODE_LABEL[g.mode]}
                  {g.map && g.mode === "domination" ? " · domination" : ""}
                </span>
                <span className="num text-chalk/80">
                  {g.scoreA}–{g.scoreB}
                </span>
              </li>
            ) : null
          )}
        </ul>
      )}

      {playedGames.length > 0 && match.bestOf === 1 && match.games[0].map && (
        <p className="mt-3 border-t border-hair pt-3 text-[11px] text-muted">
          {match.games[0].map}
        </p>
      )}

      {editable && run && (
        <div className="mt-3 border-t border-hair pt-3">
          {!open ? (
            <button className="btn w-full py-1.5" onClick={() => setOpen(true)}>
              Record result
            </button>
          ) : (
            <div className="space-y-3">
              <div className="flex gap-2">
                <label className="flex-1">
                  <span className="eyebrow block mb-1">Start</span>
                  <input
                    type="datetime-local"
                    className="field text-[11px] py-1.5"
                    value={form.scheduledAt}
                    onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
                  />
                </label>
                <label className="w-24">
                  <span className="eyebrow block mb-1">Mins</span>
                  <input
                    inputMode="numeric"
                    className="field text-[11px] py-1.5"
                    value={form.durationMin}
                    onChange={(e) =>
                      setForm({ ...form, durationMin: e.target.value.replace(/[^0-9]/g, "") })
                    }
                  />
                </label>
              </div>

              {form.games.map((g, i) => (
                <div key={i} className="border border-hair p-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="eyebrow">
                      G{i + 1} · {MODE_LABEL[match.games[i].mode]}
                    </span>
                    <label className="flex items-center gap-1.5 eyebrow cursor-pointer">
                      <input
                        type="checkbox"
                        checked={g.played}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            games: form.games.map((x, j) =>
                              j === i ? { ...x, played: e.target.checked } : x
                            ),
                          })
                        }
                      />
                      Played
                    </label>
                  </div>
                  <input
                    className="field text-[11px] py-1.5 mb-1.5"
                    placeholder="Map"
                    value={g.map}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        games: form.games.map((x, j) =>
                          j === i ? { ...x, map: e.target.value } : x
                        ),
                      })
                    }
                  />
                  <div className="flex items-center gap-2">
                    <input
                      inputMode="numeric"
                      className="field text-[11px] py-1.5"
                      value={g.scoreA}
                      onChange={(e) => setScore(i, "scoreA", e.target.value)}
                    />
                    <span className="eyebrow shrink-0">vs</span>
                    <input
                      inputMode="numeric"
                      className="field text-[11px] py-1.5"
                      value={g.scoreB}
                      onChange={(e) => setScore(i, "scoreB", e.target.value)}
                    />
                  </div>
                </div>
              ))}

              {match.bestOf > 1 && (
                <label className="block">
                  <span className="eyebrow block mb-1">Winner override</span>
                  <select
                    className="field text-[11px] py-1.5"
                    value={form.winnerOverride}
                    onChange={(e) => setForm({ ...form, winnerOverride: e.target.value })}
                  >
                    <option value="">Decide from the games</option>
                    {match.teamA && <option value={match.teamA}>{match.nameA}</option>}
                    {match.teamB && <option value={match.teamB}>{match.nameB}</option>}
                  </select>
                </label>
              )}

              <div className="flex gap-2">
                <button className="btn btn-gold flex-1 py-1.5" disabled={busy} onClick={save}>
                  {busy ? "Saving…" : "Save"}
                </button>
                <button className="btn py-1.5" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button
                  className="btn btn-ember py-1.5"
                  onClick={async () => {
                    if (!confirm(`Clear all recorded games for ${match.label}?`)) return;
                    await run({ type: "clearMatch", matchId: match.id });
                    setOpen(false);
                  }}
                >
                  Clear
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

function TeamRow({
  name,
  score,
  won,
  dim,
}: {
  name: string;
  score: number;
  won: boolean;
  dim: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3">
      <span
        className={`flex-1 truncate ${
          dim
            ? "text-muted italic"
            : won
              ? "text-gold font-display text-lg leading-tight"
              : "text-chalk"
        }`}
      >
        {name}
      </span>
      <span className={`num text-lg ${won ? "text-gold" : "text-muted"}`}>{dim ? "–" : score}</span>
    </div>
  );
}
