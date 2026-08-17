"use client";

/**
 * Who is left — the admin's third column.
 *
 * Both pools, in wheel order, and only an admin gets them: `redactDraft` sends
 * `mainPool` and `reservePool` as null to everybody else, so the reserve list
 * stays hidden while it is still being held back. The counts are public and are
 * in the header; the *names* in the reserve pool are not.
 *
 * Nothing here is a control. Moving somebody between pools before the draft
 * reaches them is setup, and setup belongs on the event's Draft tab where it
 * leaves no lot behind — `setPoolKind`'s note explains why doing it from here
 * would record a spin that never happened.
 */

import { Button, EmptyState, Eyebrow, Panel } from "@/components/ui";
import { PlayerChip, playerName } from "@/components/draft";
import type { DraftPoolKind } from "@/db/schema";
import type { DraftRoomView } from "@/lib/draft";
import type { PoolPlayer } from "@/lib/draft-policy";
import type { AdminCommand } from "./actions";

export type PoolRailProps = {
  view: DraftRoomView;
  busy: boolean;
  run: (command: AdminCommand) => Promise<void>;
};

export default function PoolRail({ view, busy, run }: PoolRailProps) {
  const main = view.mainPool ?? [];
  const reserve = view.reservePool ?? [];
  const onBlockId = view.lot?.playerUserId ?? null;
  // §9's third selection mode has no wheel to press, so the pool list is where
  // the next player is chosen. `openLot` still checks they are in that pool.
  const picking = view.config.selectionMode === "admin_pick" && view.lot === null;

  return (
    <Panel as="aside" padding="md" className="h-fit xl:sticky xl:top-24">
      <List
        title={`Main wheel · ${main.length}`}
        players={main}
        view={view}
        onBlockId={onBlockId}
        empty="Nobody left on the main wheel."
        onPick={picking ? (userId) => run({ type: "pick", userId, kind: "main" }) : undefined}
        busy={busy}
      />

      <div className="mt-6 border-t border-hair pt-5">
        <List
          title={`Reserve wheel · ${reserve.length}`}
          players={reserve}
          view={view}
          onBlockId={onBlockId}
          empty="Nothing held back yet."
          onPick={
            picking ? (userId) => run({ type: "pick", userId, kind: "reserve" }) : undefined
          }
          busy={busy}
        />
        <p className="mt-3 text-[11px] leading-relaxed text-muted">
          Only you can see these names. Switch the wheel above to Reserve once the main pool
          is done.
        </p>
      </div>

      {view.completion.short.length > 0 && (
        <div className="mt-6 border-t border-hair pt-5">
          <Eyebrow as="h3" className="mb-2">
            Still short
          </Eyebrow>
          <ul className="space-y-1 text-xs text-muted">
            {view.completion.short.map((entry) => (
              <li key={entry.teamId}>
                {view.teams.find((team) => team.id === entry.teamId)?.name ?? "A team"} ·{" "}
                <span className="num text-chalk/80">{entry.slotsLeft}</span> to fill
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function List({
  title,
  players,
  view,
  onBlockId,
  empty,
  onPick,
  busy,
}: {
  title: string;
  players: readonly PoolPlayer[];
  view: DraftRoomView;
  onBlockId: string | null;
  empty: string;
  /** Present only under admin-pick selection: put this player up now. */
  onPick?: (userId: string) => void;
  busy?: boolean;
}) {
  return (
    <div>
      <Eyebrow as="h3" className="mb-2">
        {title}
      </Eyebrow>
      {players.length === 0 ? (
        <EmptyState size="sm">{empty}</EmptyState>
      ) : (
        <ul className="max-h-[320px] overflow-y-auto pr-1">
          {players.map((entry, index) => (
            <li key={entry.userId}>
              <PlayerChip
                index={index + 1}
                name={playerName(view.players, entry.userId)}
                meta={entry.userId === onBlockId ? "on the block" : undefined}
                dimmed={entry.userId === onBlockId}
                actions={
                  onPick && (
                    <Button size="sm" disabled={busy} onClick={() => onPick(entry.userId)}>
                      Put up
                    </Button>
                  )
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
