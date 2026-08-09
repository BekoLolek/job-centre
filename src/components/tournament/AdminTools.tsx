"use client";

import { useState } from "react";
import type { TournamentView } from "@/lib/types";

export default function AdminTools({
  view,
  run,
}: {
  view: TournamentView;
  run: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [day1, setDay1] = useState("");
  const [day2, setDay2] = useState("");
  const [seeds, setSeeds] = useState<string[]>(view.seeds ?? view.teams.map((t) => t.id));

  const name = (id: string) => view.teams.find((t) => t.id === id)?.name ?? id;
  const seedsValid = new Set(seeds).size === 4;

  return (
    <section className="panel p-6">
      <h2 className="font-display text-2xl mb-1">Admin tools</h2>
      <p className="text-sm text-muted mb-6">
        Only visible to you. Everyone else sees the board read-only.
      </p>

      <div className="grid gap-8 lg:grid-cols-3">
        <div>
          <h3 className="eyebrow mb-3">Auto-fill the schedule</h3>
          <p className="text-[11px] leading-relaxed text-muted mb-3">
            Walks both days block by block using 30 min convoy, 15 min domination, 5 min
            between games and 10 min between series. Parallel matches share a start time.
          </p>
          <label className="block mb-2">
            <span className="eyebrow block mb-1">Day 1 start</span>
            <input
              type="datetime-local"
              className="field text-xs py-1.5"
              value={day1}
              onChange={(e) => setDay1(e.target.value)}
            />
          </label>
          <label className="block mb-3">
            <span className="eyebrow block mb-1">Day 2 start</span>
            <input
              type="datetime-local"
              className="field text-xs py-1.5"
              value={day2}
              onChange={(e) => setDay2(e.target.value)}
            />
          </label>
          <button
            className="btn w-full"
            disabled={!day1 && !day2}
            onClick={() => run({ type: "schedule", day1, day2 })}
          >
            Fill start times
          </button>
        </div>

        <div>
          <h3 className="eyebrow mb-3">Seeding</h3>
          <p className="text-[11px] leading-relaxed text-muted mb-3">
            Seeds come from the standings automatically. Override them here if the tiebreakers
            leave two teams level.
          </p>
          <div className="space-y-2 mb-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="num text-xs text-muted w-4">{i + 1}</span>
                <select
                  className="field text-xs py-1.5"
                  value={seeds[i] ?? ""}
                  onChange={(e) =>
                    setSeeds(seeds.map((s, j) => (j === i ? e.target.value : s)))
                  }
                >
                  {view.teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          {!seedsValid && (
            <p className="text-[11px] text-ember mb-2">Each team can hold only one seed.</p>
          )}
          <div className="flex gap-2">
            <button
              className="btn flex-1"
              disabled={!seedsValid}
              onClick={() => run({ type: "seedOverride", seedOverride: seeds })}
            >
              Lock seeds
            </button>
            <button className="btn" onClick={() => run({ type: "seedOverride", seedOverride: [] })}>
              Auto
            </button>
          </div>
          <p className="mt-2 text-[11px] text-muted">
            Current: {view.seeds ? view.seeds.map(name).join(", ") : "not set yet"}
          </p>
        </div>

        <div>
          <h3 className="eyebrow mb-3">Danger zone</h3>
          <p className="text-[11px] leading-relaxed text-muted mb-3">
            Wipes every recorded game, schedule and seed override. The draft and rosters are
            untouched.
          </p>
          <button
            className="btn btn-ember w-full"
            onClick={() => {
              if (confirm("Clear every match result and start the tournament over?")) {
                run({ type: "resetTournament" });
              }
            }}
          >
            Reset tournament
          </button>
        </div>
      </div>
    </section>
  );
}
