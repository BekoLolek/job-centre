"use client";

/**
 * The admin's console: spin, then settle the lot.
 *
 * Everything it can do is one call into `src/lib/draft.ts` — `openLot`,
 * `awardLot`, `discardLot`, `moveToReserve`, `clearBid`, `voidLot`,
 * `voidLastLot` — and it sends a command rather than a lot id, because the lot
 * is whichever one is open and the server is the one that knows.
 *
 * ## A tie is never broken here, or anywhere else
 *
 * `resolveLot` reports two equal top bids as a fact about the lot. It does not
 * pick, and neither does this: the tied teams are named, the award buttons stay
 * side by side, and an admin decides in front of everyone. Earliest-bid-wins
 * would reward a fast connection and a coin flip would be a decision nobody in
 * the room saw being made.
 *
 * ## Undo says what it will undo
 *
 * `voidLastLot` takes the newest non-voided lot — and an **open** lot counts,
 * so the same button cancels the live lot when there is one and reverses the
 * last award when there is not. `undoPlan` works out which, and the sentence is
 * on screen before the button is pressed rather than in a tooltip after it. The
 * press is confirmed too: an undo of an undo is not a thing `voidLot` offers.
 */

import { useState } from "react";
import { Alert, Button, Eyebrow, Panel, Tabs } from "@/components/ui";
import { Money, undoPlan } from "@/components/draft";
import type { DraftPoolKind } from "@/db/schema";
import type { DraftRoomView } from "@/lib/draft";
import type { AdminCommand } from "./actions";

export type AdminConsoleProps = {
  view: DraftRoomView;
  /** Which wheel the next spin comes from. The admin's own screen until they spin. */
  wheelKind: DraftPoolKind;
  onWheelKind: (kind: DraftPoolKind) => void;
  spinning: boolean;
  onBlock: string | null;
  busy: boolean;
  run: (command: AdminCommand) => Promise<void>;
};

export default function AdminConsole({
  view,
  wheelKind,
  onWheelKind,
  spinning,
  onBlock,
  busy,
  run,
}: AdminConsoleProps) {
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const lot = view.lot;
  const lotOpen = Boolean(lot) && !spinning;
  const kind: DraftPoolKind = lot ? lot.fromKind : wheelKind;
  const poolSize = kind === "reserve" ? view.reservePoolCount : view.mainPoolCount;
  const plan = undoPlan(view, view.players, view.teams);
  /** §9's admin-pick mode: `openLot` refuses to choose, so the pool list does. */
  const byHand = view.config.selectionMode === "admin_pick";
  const resolution = lot?.resolution ?? null;

  const bidders = view.teams.filter((team) => team.hasBid);
  const leaderId = resolution?.kind === "winner" ? resolution.teamId : null;
  const tiedIds = resolution?.kind === "tie" ? resolution.teamIds : [];

  return (
    <Panel className="rise">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Tabs
          items={[
            { value: "main", label: "Main", count: view.mainPoolCount },
            { value: "reserve", label: "Reserve", count: view.reservePoolCount },
          ]}
          value={kind}
          onChange={onWheelKind}
          disabled={Boolean(lot) || !view.config.reserveEnabled}
        />

        <Button
          variant="gold"
          className="min-w-[160px] flex-1 text-sm"
          disabled={busy || spinning || Boolean(lot) || poolSize === 0 || byHand}
          onClick={() => run({ type: "spin", kind })}
          title={
            byHand ? "This draft is set to admin picks — choose from the pool list" : undefined
          }
        >
          {spinning
            ? "Spinning…"
            : byHand
              ? "Pick from the pool list"
              : view.config.selectionMode === "fixed_order"
                ? "Put the next player up"
                : "Spin the wheel"}
        </Button>
      </div>

      {/* Undo, with the consequence spelled out. */}
      <div className="mb-5 rounded-xl border border-hair px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          {confirmUndo ? (
            <>
              <Button
                variant="ember"
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setConfirmUndo(false);
                  await run({ type: "undo" });
                }}
              >
                Yes, {plan.label.toLowerCase()}
              </Button>
              <Button size="sm" onClick={() => setConfirmUndo(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={busy || !plan.available}
              onClick={() => setConfirmUndo(true)}
            >
              {plan.label}
            </Button>
          )}
          <span className="min-w-[12rem] flex-1 text-xs leading-relaxed text-muted">
            {plan.sentence}
          </span>
        </div>
      </div>

      {!lotOpen ? (
        <p className="text-sm text-muted">
          {spinning
            ? "The wheel is running — bidding opens the moment it stops."
            : byHand && poolSize > 0
              ? "This draft is set to admin picks. Choose who goes up next from the pool list."
              : poolSize === 0
              ? kind === "main"
                ? "The main pool is empty. Switch to the reserve wheel, or add players on the event's Draft tab."
                : "The reserve pool is empty."
              : "Spin to put the next player on the block."}
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <Eyebrow as="span">
              Bids · {lot?.bidCount ?? 0}/{view.teams.length} on {onBlock ?? "this player"}
            </Eyebrow>
            <Eyebrow as="span" className={lot?.allBidsIn ? "text-signal" : "text-ember"}>
              {lot?.allBidsIn ? "All in" : "Incomplete"}
            </Eyebrow>
          </div>

          {resolution?.kind === "tie" && (
            <Alert tone="ember" className="mb-3">
              <span className="block font-medium">
                Tied at {resolution.amount}
              </span>
              <span className="mt-1 block opacity-90">
                {resolution.teamIds
                  .map((id) => view.teams.find((team) => team.id === id)?.name ?? "A team")
                  .join(" and ")}{" "}
                bid the same. Nothing is decided until you award one of them — clear a bid
                and have it placed again if they would rather settle it themselves.
              </span>
            </Alert>
          )}

          {resolution?.kind === "winner" && (
            <p className="mb-3 text-xs text-muted">
              {view.teams.find((team) => team.id === resolution.teamId)?.name ?? "A team"} leads
              at <Money value={resolution.amount} size="sm" />
              {resolution.contested && resolution.runnerUp !== null ? (
                <>
                  {" "}
                  · next best <Money value={resolution.runnerUp} size="sm" tone="muted" />
                </>
              ) : (
                " · the only bid"
              )}
            </p>
          )}

          {resolution?.kind === "none" && (
            <p className="mb-3 text-xs text-muted">
              Nobody has bid yet. You can take {onBlock ?? "them"} off the list or hold them
              over for the reserve wheel.
            </p>
          )}

          <ul className="mb-5 space-y-2">
            {view.teams.map((team) => {
              const leads = team.id === leaderId;
              const tied = tiedIds.includes(team.id);
              return (
                <li
                  key={team.id}
                  className={`flex items-center gap-3 border px-3 py-2 ${
                    leads ? "border-gold/60 bg-gold/[0.06]" : tied ? "border-ember/50" : "border-hair"
                  }`}
                >
                  <span className="flex-1 truncate text-sm">
                    {team.name}
                    {team.roster.slotsLeft === 0 && (
                      <span className="eyebrow ml-2 text-muted">full</span>
                    )}
                  </span>
                  <span className="w-24 text-right">
                    {team.hasBid && team.bid !== null ? (
                      <Money value={team.bid} size="lg" />
                    ) : (
                      <span className="num text-muted">—</span>
                    )}
                  </span>
                  <Button
                    size="sm"
                    disabled={busy || !team.hasBid}
                    onClick={() => run({ type: "clearBid", teamId: team.id })}
                    title="Clear this bid so they can enter another"
                  >
                    Clear
                  </Button>
                  <Button
                    size="sm"
                    variant={leads ? "gold" : "default"}
                    disabled={busy || !team.hasBid}
                    onClick={() => run({ type: "award", teamId: team.id })}
                  >
                    Award
                  </Button>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-wrap gap-2">
            <Button variant="ember" disabled={busy} onClick={() => run({ type: "discard" })}>
              Take off the list
            </Button>
            <Button
              disabled={busy || kind === "reserve" || !view.config.reserveEnabled}
              onClick={() => run({ type: "reserve" })}
              title={
                kind === "reserve"
                  ? "They are already in the reserve pool"
                  : "Send them round again on the reserve wheel"
              }
            >
              Hold over to reserve
            </Button>
            <Button
              disabled={busy || (lot?.bidCount ?? 0) === 0}
              onClick={() => run({ type: "clearBids" })}
            >
              Clear all bids
            </Button>
            {confirmCancel ? (
              <>
                <Button
                  variant="ember"
                  disabled={busy}
                  onClick={async () => {
                    setConfirmCancel(false);
                    await run({ type: "cancel" });
                  }}
                >
                  Yes, cancel the lot
                </Button>
                <Button onClick={() => setConfirmCancel(false)}>Keep it</Button>
              </>
            ) : (
              <Button disabled={busy} onClick={() => setConfirmCancel(true)}>
                Cancel lot
              </Button>
            )}
          </div>

          <p className="mt-3 text-[11px] leading-relaxed text-muted">
            Cancelling puts {onBlock ?? "them"} back on the wheel and loses the bids. Taking
            them off the list ends their draft; holding them over sends them round again on
            the reserve wheel.
          </p>
        </>
      )}
    </Panel>
  );
}
