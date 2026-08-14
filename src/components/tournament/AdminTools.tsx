"use client";

import { useState } from "react";
import { DEFAULT_TIMING, dayMinutes, schedulePlan } from "@/lib/tournament";
import { addMinutesTo, formatClock, toInstant, zoneLabel } from "@/lib/time";
import type { Timing, TournamentView } from "@/lib/types";

const FIELDS: Array<{ key: keyof Timing; label: string; hint: string }> = [
  { key: "convoy", label: "Convoy / convergence", hint: "per map" },
  { key: "domination", label: "Domination", hint: "deciders" },
  { key: "betweenGames", label: "Between games", hint: "inside a series" },
  { key: "betweenSeries", label: "Between series", hint: "between blocks" },
];

function hhmm(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** `start` is the naive datetime-local value; the clock shown is the admin's own zone. */
function clockAt(start: string, offset: number) {
  const instant = start ? toInstant(start) : null;
  const at = instant ? addMinutesTo(instant, offset) : null;
  return at ? formatClock(at) : null;
}

export default function AdminTools({
  view,
  run,
}: {
  view: TournamentView;
  run: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [day1, setDay1] = useState("");
  const [day2, setDay2] = useState("");
  const [timing, setTiming] = useState<Record<keyof Timing, string>>({
    convoy: String(view.timing.convoy),
    domination: String(view.timing.domination),
    betweenGames: String(view.timing.betweenGames),
    betweenSeries: String(view.timing.betweenSeries),
  });
  const [seeds, setSeeds] = useState<string[]>(view.seeds ?? view.teams.map((t) => t.id));

  const name = (id: string) => view.teams.find((t) => t.id === id)?.name ?? id;
  const seedsValid = new Set(seeds).size === 4;

  const numeric: Timing = {
    convoy: Number(timing.convoy || 0),
    domination: Number(timing.domination || 0),
    betweenGames: Number(timing.betweenGames || 0),
    betweenSeries: Number(timing.betweenSeries || 0),
  };
  const timingValid = numeric.convoy > 0 && numeric.domination > 0;
  const plan = timingValid ? schedulePlan(numeric) : [];
  const days = timingValid ? dayMinutes(numeric) : { day1: 0, day2: 0 };
  const changed = FIELDS.some((f) => numeric[f.key] !== view.timing[f.key]);

  return (
    <section className="panel p-6">
      <h2 className="font-display text-2xl mb-1">Admin tools</h2>
      <p className="text-sm text-muted mb-6">
        Only visible to you. Everyone else sees the board read-only.
      </p>

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <h3 className="eyebrow mb-3">Schedule</h3>

          <div className="grid gap-3 sm:grid-cols-4 mb-4">
            {FIELDS.map((f) => (
              <label key={f.key}>
                <span className="eyebrow block mb-1 truncate">{f.label}</span>
                <div className="flex items-center gap-2">
                  <input
                    inputMode="numeric"
                    className="field text-xs py-1.5"
                    value={timing[f.key]}
                    onChange={(e) =>
                      setTiming({ ...timing, [f.key]: e.target.value.replace(/[^0-9]/g, "") })
                    }
                  />
                  <span className="eyebrow shrink-0">min</span>
                </div>
                <span className="eyebrow block mt-1 text-muted/70">{f.hint}</span>
              </label>
            ))}
          </div>

          {!timingValid && (
            <p className="text-[11px] text-ember mb-3">
              Map lengths have to be at least one minute.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2 mb-4">
            <label>
              <span className="eyebrow block mb-1">Day 1 start</span>
              <input
                type="datetime-local"
                className="field text-xs py-1.5"
                value={day1}
                onChange={(e) => setDay1(e.target.value)}
              />
            </label>
            <label>
              <span className="eyebrow block mb-1">Day 2 start</span>
              <input
                type="datetime-local"
                className="field text-xs py-1.5"
                value={day2}
                onChange={(e) => setDay2(e.target.value)}
              />
            </label>
          </div>

          {timingValid && (
            <div className="border border-hair mb-4">
              <div className="flex items-baseline justify-between px-3 py-2 border-b border-hair">
                <span className="eyebrow">Preview · longest case</span>
                <span className="eyebrow">
                  Day 1 <span className="num text-gold">{hhmm(days.day1)}</span> · Day 2{" "}
                  <span className="num text-gold">{hhmm(days.day2)}</span>
                </span>
              </div>
              <ul>
                {plan.map((p) => {
                  const start = p.day === 1 ? day1 : day2;
                  const at = clockAt(start, p.offsetMin);
                  const end = clockAt(start, p.offsetMin + p.lengthMin);
                  return (
                    <li
                      key={p.label}
                      className="flex items-baseline gap-3 px-3 py-1.5 text-[11px] border-b border-hair/50 last:border-0"
                    >
                      <span className="eyebrow w-12 shrink-0">Day {p.day}</span>
                      <span className="flex-1 truncate text-chalk/80">{p.label}</span>
                      <span className="num text-muted shrink-0">
                        {at ? `${at} – ${end}` : `+${hhmm(p.offsetMin)}`}
                      </span>
                      <span className="num text-muted w-14 text-right shrink-0">
                        {p.lengthMin}m
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-gold"
              disabled={!timingValid || (!day1 && !day2)}
              onClick={() =>
                run({
                  type: "schedule",
                  day1: toInstant(day1) ?? "",
                  day2: toInstant(day2) ?? "",
                  timing: numeric,
                })
              }
            >
              Fill start times
            </button>
            <button
              className="btn"
              disabled={!timingValid || !changed}
              onClick={() => run({ type: "timing", timing: numeric })}
            >
              Save lengths only
            </button>
            <button
              className="btn"
              onClick={() =>
                setTiming({
                  convoy: String(DEFAULT_TIMING.convoy),
                  domination: String(DEFAULT_TIMING.domination),
                  betweenGames: String(DEFAULT_TIMING.betweenGames),
                  betweenSeries: String(DEFAULT_TIMING.betweenSeries),
                })
              }
            >
              Reset to defaults
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            Matches inside a block run in parallel and share a start time, so a block lasts
            as long as its slowest series. Filling start times also saves the lengths. You
            are entering times in <span className="text-chalk/80">{zoneLabel()}</span>; each
            viewer sees them converted to their own zone.
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            Once a block is complete the rest of that day re-flows from when it actually
            finished, so running late or early carries forward on its own. The other day
            keeps its own start time.
          </p>
        </div>

        <div className="space-y-8">
          <div>
            <h3 className="eyebrow mb-3">Seeding</h3>
            <p className="text-[11px] leading-relaxed text-muted mb-3">
              Seeds come from the standings automatically. Override them here if the
              tiebreakers leave two teams level.
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
              <button
                className="btn"
                onClick={() => run({ type: "seedOverride", seedOverride: [] })}
              >
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
              Wipes every recorded game, schedule and seed override. The draft and rosters
              are untouched.
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
      </div>
    </section>
  );
}
