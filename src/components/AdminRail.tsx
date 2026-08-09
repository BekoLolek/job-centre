"use client";

import { useEffect, useState } from "react";
import type { DraftView } from "@/lib/types";

export default function AdminRail({
  view,
  run,
}: {
  view: DraftView;
  run: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [tab, setTab] = useState<"pools" | "setup">("pools");
  const [roster, setRoster] = useState("");
  const [teams, setTeams] = useState(
    view.captains.map((c) => ({ id: c.id, name: c.name, balance: String(c.balance) }))
  );
  const [dirty, setDirty] = useState(false);

  // Keep the editor in step with the server unless the admin is mid-edit.
  useEffect(() => {
    if (dirty) return;
    setTeams(view.captains.map((c) => ({ id: c.id, name: c.name, balance: String(c.balance) })));
  }, [view.captains, dirty]);

  const mainPool = view.mainPool ?? [];
  const reservePool = view.reservePool ?? [];

  return (
    <aside className="panel p-5 h-fit xl:sticky xl:top-24">
      <div className="flex border border-hair mb-5">
        {(["pools", "setup"] as const).map((t) => (
          <button
            key={t}
            className={`btn flex-1 border-0 ${
              tab === t ? "text-gold bg-gold/10" : "text-muted bg-transparent"
            }`}
            onClick={() => setTab(t)}
          >
            {t === "pools" ? "Pools" : "Setup"}
          </button>
        ))}
      </div>

      {tab === "pools" ? (
        <div className="space-y-6">
          <PoolList
            title={`Main wheel · ${mainPool.length}`}
            players={mainPool}
            empty="No players left on the main wheel."
            onRemove={(player) => run({ type: "removePlayer", player, wheel: "main" })}
          />
          <div className="border-t border-hair pt-5">
            <PoolList
              title={`Reserve wheel · ${reservePool.length}`}
              players={reservePool}
              empty="Nothing held back yet."
              accent
              onRemove={(player) => run({ type: "removePlayer", player, wheel: "reserve" })}
            />
            <p className="mt-3 text-[11px] leading-relaxed text-muted">
              Only you can see this list. Switch the active wheel to Reserve when you are
              ready to draft these.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <div>
            <h3 className="eyebrow mb-3">Player pool</h3>
            <textarea
              className="field h-40 text-xs leading-relaxed resize-y"
              placeholder={"One name per line\nJordan Reyes\nSam Okafor"}
              value={roster}
              onChange={(e) => setRoster(e.target.value)}
            />
            <div className="mt-2 flex gap-2">
              <button
                className="btn flex-1"
                disabled={!roster.trim()}
                onClick={async () => {
                  await run({ type: "addPlayers", players: roster.split("\n") });
                  setRoster("");
                }}
              >
                Add
              </button>
              <button
                className="btn btn-ember flex-1"
                disabled={!roster.trim()}
                onClick={async () => {
                  await run({ type: "setup", players: roster.split("\n") });
                  setRoster("");
                }}
                title="Replace the main wheel with exactly this list"
              >
                Replace
              </button>
            </div>
            {mainPool.length > 0 && (
              <button
                className="btn w-full mt-2"
                onClick={() => setRoster(mainPool.join("\n"))}
              >
                Load current pool
              </button>
            )}
          </div>

          <div className="border-t border-hair pt-5">
            <h3 className="eyebrow mb-3">Starting balances</h3>
            <div className="space-y-2">
              {teams.map((t, i) => (
                <div key={t.id} className="flex items-center gap-2">
                  <span className="flex-1 truncate text-xs text-chalk/80">{t.name}</span>
                  <input
                    className="field text-xs w-24"
                    inputMode="numeric"
                    value={t.balance}
                    onChange={(e) => {
                      setDirty(true);
                      setTeams((prev) =>
                        prev.map((p, j) =>
                          j === i ? { ...p, balance: e.target.value.replace(/[^0-9]/g, "") } : p
                        )
                      );
                    }}
                  />
                </div>
              ))}
            </div>
            <button
              className="btn w-full mt-2"
              disabled={!dirty}
              onClick={async () => {
                await run({
                  type: "setup",
                  captains: teams.map((t) => ({ id: t.id, balance: Number(t.balance || 0) })),
                });
                setDirty(false);
              }}
            >
              Save balances
            </button>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              Team names come from each captain&apos;s login name — change
              <span className="num"> CAPTAIN&#123;n&#125;_USERNAME</span> to rename a team.
            </p>
          </div>

          <div className="border-t border-hair pt-5">
            <h3 className="eyebrow mb-3">Danger zone</h3>
            <button
              className="btn btn-ember w-full"
              onClick={() => {
                if (
                  confirm(
                    "Reset the draft? Rosters, bids and history are cleared and every player goes back on the main wheel."
                  )
                ) {
                  run({ type: "reset", returnPlayers: true });
                }
              }}
            >
              Reset draft
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

function PoolList({
  title,
  players,
  empty,
  accent,
  onRemove,
}: {
  title: string;
  players: string[];
  empty: string;
  accent?: boolean;
  onRemove: (player: string) => void;
}) {
  return (
    <div>
      <h3 className={`eyebrow mb-3 ${accent ? "text-gold/80" : ""}`}>{title}</h3>
      {players.length === 0 ? (
        <p className="text-xs text-muted">{empty}</p>
      ) : (
        <ul className="max-h-64 overflow-y-auto pr-1 space-y-1">
          {players.map((p) => (
            <li
              key={p}
              className="group flex items-center justify-between border border-hair bg-raised/50 px-2 py-1.5 text-xs"
            >
              <span className="truncate">{p}</span>
              <button
                className="opacity-0 group-hover:opacity-100 text-muted hover:text-ember transition-opacity px-1"
                title="Remove from this wheel"
                onClick={() => onRemove(p)}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
