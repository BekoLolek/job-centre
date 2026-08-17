"use client";

/**
 * A captain's bid: a number, a submit, then locked with their amount showing.
 *
 * ## Nothing here decides whether a bid is allowed
 *
 * Not one branch below computes a limit. The ceiling comes from `maxBidFor` on
 * the server (`view.you.maxBid`), the sentence explaining it comes from
 * `ceilingFor`, and every refusal is `canPlaceBid`'s own message with its
 * reason code attached. The submit button is deliberately **not** disabled on a
 * "too big" figure the way the old panel's was: a greyed-out button teaches a
 * captain nothing, whereas eleven distinct sentences tell them exactly which
 * rule they hit and what to do instead.
 *
 * That is also why the input accepts a stray dot or minus rather than stripping
 * them. `not_a_whole_number` and `negative` are real refusals with real
 * wording; silently editing what somebody typed hides the rule and leaves them
 * wondering why their keystroke vanished.
 *
 * ## The ceiling is stated before they type, not after they are refused
 *
 * §9's must-fill-your-roster rule is invisible until it bites, and a captain
 * whose 900 is refused mid-draft concludes the board is broken. So the figure
 * and the reason for it are on screen above the empty box.
 */

import { useEffect, useState } from "react";
import { Alert, Button, Eyebrow, Field, Panel } from "@/components/ui";
import { Money } from "@/components/draft";
import type { BidRefusalReason } from "@/lib/draft-policy";
import type { DraftRoomView } from "@/lib/draft";
import type { BidOutcome } from "./actions";
import type { BidStanding } from "./room";

/**
 * Refusals that are a *state* rather than a correction: no amount typed into
 * the box would help, so the box does not appear. The others leave it open,
 * because typing a different number is exactly the fix.
 */
const STANDING_BLOCKS: ReadonlySet<BidRefusalReason> = new Set<BidRefusalReason>([
  "lot_not_open",
  "bidding_ended",
  "roster_full",
  "cannot_afford_minimum",
  "over_balance",
  "over_roster_cap",
]);

export type BidBoxProps = {
  view: DraftRoomView;
  /** The server's answer to "may you bid at all right now". */
  standing: BidStanding | null;
  spinning: boolean;
  onBlock: string | null;
  now: number;
  bid: (amount: number) => Promise<BidOutcome>;
};

export default function BidBox({ view, standing, spinning, onBlock, now, bid }: BidBoxProps) {
  const me = view.teams.find((team) => team.id === view.you.teamId) ?? null;
  const lotId = view.lot?.id ?? null;

  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<BidRefusalReason | null>(null);
  const [busy, setBusy] = useState(false);

  // A fresh lot means a fresh box: an amount left over from the last player is
  // the single easiest way to buy somebody by accident.
  useEffect(() => {
    setAmount("");
    setError(null);
    setReason(null);
  }, [lotId]);

  if (!me) return null;

  const check = standing?.check ?? null;
  const refusal = check && !check.ok ? check : null;
  // Sealed bidding is one bid per lot and the box locks. Open bidding is the
  // opposite — a captain with a bid in is exactly the person who may want to
  // raise it — so a standing bid must never lock the box there.
  const placed =
    view.config.biddingMode === "sealed" &&
    (me.bid !== null || refusal?.reason === "already_bid");
  const endsAt = view.lot?.endsAt ?? null;
  const closed = endsAt !== null && now >= endsAt;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || amount.trim() === "") return;
    setBusy(true);
    setError(null);
    setReason(null);
    // Whatever was typed goes to the server as-is. `canPlaceBid` owns "is that
    // even a number", and its answer is a sentence rather than a shrug.
    const outcome = await bid(Number(amount));
    if (!outcome.ok) {
      setError(outcome.error);
      setReason(outcome.reason);
    } else {
      setAmount("");
    }
    setBusy(false);
  }

  /* ---- Already bid: the sealed-bid lock ------------------------------- */

  if (placed && view.lot) {
    return (
      <Panel className="rise text-center">
        <Eyebrow className="mb-3">Your bid is locked</Eyebrow>
        <div className="stamp leading-none">
          {me.bid !== null ? (
            <Money value={me.bid} tone="signal" size="xl" className="text-5xl" />
          ) : (
            <span className="font-display text-5xl text-signal">In</span>
          )}
        </div>
        <p className="mt-4 text-sm text-muted">
          {refusal?.message ??
            "Waiting on the other captains."}{" "}
          {view.config.bidVisibility === "admin_only"
            ? "Nobody but the admin sees your number until the lot is settled."
            : null}
        </p>
      </Panel>
    );
  }

  /* ---- Nothing to bid on yet ----------------------------------------- */

  if (!view.lot || spinning) {
    return (
      <Panel className="rise">
        <div className="mb-3 flex items-baseline justify-between">
          <Eyebrow as="span">Your bid</Eyebrow>
          <Eyebrow as="span">
            Balance <Money value={me.balance} />
          </Eyebrow>
        </div>
        <p className="text-sm text-muted">
          {spinning
            ? "The wheel is running — bidding opens the moment it stops."
            : "Bidding opens once the wheel stops on a player."}
        </p>
        {standing && <Ceiling standing={standing} maxBid={view.you.maxBid} />}
      </Panel>
    );
  }

  /* ---- Blocked outright ---------------------------------------------- */

  if (refusal && STANDING_BLOCKS.has(refusal.reason)) {
    return (
      <Panel className="rise">
        <div className="mb-3 flex items-baseline justify-between">
          <Eyebrow as="span">You cannot bid on this lot</Eyebrow>
          <Eyebrow as="span">
            Balance <Money value={me.balance} />
          </Eyebrow>
        </div>
        <div data-reason={refusal.reason}>
          <Alert tone="ember">{refusal.message}</Alert>
        </div>
        {refusal.reason === "roster_full" && (
          <p className="mt-3 text-sm text-muted">
            Your draft is done — {me.roster.size} of {me.roster.target} on the roster.
          </p>
        )}
        {standing && <Ceiling standing={standing} maxBid={view.you.maxBid} />}
      </Panel>
    );
  }

  /* ---- The box ------------------------------------------------------- */

  return (
    <Panel as="form" onSubmit={submit} className="rise">
      <div className="mb-4 flex items-baseline justify-between">
        <Eyebrow as="span">Your bid on {onBlock ?? "this player"}</Eyebrow>
        <Eyebrow as="span">
          Balance <Money value={me.balance} />
        </Eyebrow>
      </div>

      {standing && <Ceiling standing={standing} maxBid={view.you.maxBid} above />}

      <div className="flex gap-3">
        <Field
          className="text-2xl"
          inputMode="numeric"
          placeholder={String(standing?.opening ?? view.config.minBid)}
          value={amount}
          disabled={busy || closed}
          aria-label="Your bid"
          onChange={(event) => setAmount(event.target.value.replace(/[^0-9.\-]/g, ""))}
        />
        <Button
          type="submit"
          variant="gold"
          className="px-8"
          disabled={busy || closed || amount.trim() === ""}
        >
          {busy ? "Sending…" : "Submit"}
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {view.you.maxBid !== null && view.you.maxBid > 0 && (
          <Button size="sm" onClick={() => setAmount(String(view.you.maxBid))} type="button">
            Bid the maximum
          </Button>
        )}
        {closed && <span className="text-xs text-ember">Bidding on this player has closed.</span>}
      </div>

      {/* An open-bidding floor, in the server's words: "the bid is 250, so the
          next one has to be at least 260". Not an error — a target. */}
      {refusal && !closed && (
        <p className="mt-3 text-xs text-gold" data-reason={refusal.reason}>
          {refusal.message}
        </p>
      )}

      {error && (
        <p className="mt-3 text-xs text-ember" data-reason={reason ?? "unknown"} role="alert">
          {error}
        </p>
      )}
    </Panel>
  );
}

/** The must-fill ceiling, said in money before anybody types a figure. */
function Ceiling({
  standing,
  maxBid,
  above,
}: {
  standing: BidStanding;
  maxBid: number | null;
  above?: boolean;
}) {
  return (
    <div className={above ? "mb-4" : "mt-4"}>
      <div className="flex flex-wrap items-baseline gap-2">
        <Eyebrow as="span">You can bid up to</Eyebrow>
        <Money value={maxBid ?? 0} size="xl" tone={maxBid === 0 ? "muted" : "gold"} />
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted">{standing.ceiling}</p>
    </div>
  );
}
