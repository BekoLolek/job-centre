"use client";

/**
 * The live draft room.
 *
 * The layout is the current board's, deliberately: teams down the left with
 * balances, ticks and rosters, the wheel in the middle, the lot and the action
 * beneath it, the admin's console below that. That arrangement has been run in
 * front of real people and it works — what changed is everything underneath it,
 * which is now `src/lib/draft.ts` and a redacted view instead of a JSON blob.
 *
 * ## Everything on screen is the server's answer
 *
 * This component decides no rules. It does not know what a captain may bid, who
 * is winning, or whether the draft is over — `maxBidFor`, `resolveLot` and
 * `draftComplete` answer those on the server and the answers arrive in the
 * payload. The only arithmetic here is on the clock: how far through the spin
 * animation we are, and whether the bid timer has run out, both against
 * `view.now` rather than the browser's idea of the time.
 *
 * ## One clock for every browser
 *
 * Each payload carries the server's `now`. The offset between that and
 * `Date.now()` is kept and handed to `Wheel`, which animates against
 * `spin.startedAt` — an absolute instant — so two laptops and a projector all
 * land on the same name at the same moment, whatever their clocks say. A
 * browser that opens mid-spin computes the same angle and joins the animation
 * already in progress; one that opens after it lands sees it settled. Neither
 * is a special case, which is the point of the spin being a stored payload
 * rather than an event.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Alert, Button, EmptyState, Eyebrow, Panel } from "@/components/ui";
import { completionSentence, playerName } from "@/components/draft";
import type { DraftPoolKind } from "@/db/schema";
import AdminConsole from "./AdminConsole";
import BidBox from "./BidBox";
import LotStage from "./LotStage";
import PoolRail from "./PoolRail";
import TeamsRail from "./TeamsRail";
import WatchPanel from "./WatchPanel";
import type { AdminCommand } from "./actions";
import { loadRoomAction, placeBidAction, runDraftAction } from "./actions";
import type { RoomPayload } from "./room";

/** §3.4: a live draft polls at about a second. Everything else on the site is slower. */
const POLL_MS = 1000;

/**
 * A coarse re-render so the spin/bid switch and the bid timer do not have to
 * wait for the next poll. It changes no state — it only makes the clock
 * arithmetic above run again.
 */
function useTicker(ms: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

export type DraftRoomProps = {
  event: { id: string; slug: string; title: string };
  initial: RoomPayload;
  signedIn: boolean;
  /**
   * `<SessionNav />`, rendered on the server and passed through.
   *
   * The boards each build their own header rather than importing `AppHeader`,
   * and here that is not only style: `SessionNav` reads the session, so pulling
   * it into a client component would drag the database driver — `node:fs` and
   * all — into the browser bundle. A server component passed as a prop is
   * rendered before it crosses the boundary.
   */
  nav?: ReactNode;
};

export default function DraftRoom({ event, initial, signedIn, nav }: DraftRoomProps) {
  const [payload, setPayload] = useState<RoomPayload>(initial);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Which wheel the admin is about to spin — their own screen only, until they
   * do. It starts on the server's `activeKind` rather than on "main", so an
   * admin who reloads once the main pool is empty finds the reserve wheel
   * already selected instead of a spin button that will not press.
   */
  const [wheelKind, setWheelKind] = useState<DraftPoolKind>(initial.view.activeKind);

  const clockOffset = useRef(initial.view.now - Date.now());
  const alive = useRef(true);
  useTicker(250);

  const apply = useCallback((next: RoomPayload | null) => {
    if (!next) {
      setOffline(true);
      return;
    }
    clockOffset.current = next.view.now - Date.now();
    setPayload(next);
    setOffline(false);
  }, []);

  const refresh = useCallback(async () => {
    try {
      apply(await loadRoomAction(event.id));
    } catch {
      // A failed poll is a blip, not a state change: the last payload stays on
      // screen with the light turned red rather than the room going blank.
      setOffline(true);
    }
  }, [apply, event.id]);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await refresh();
      if (alive.current) timer = setTimeout(loop, POLL_MS);
    };
    timer = setTimeout(loop, POLL_MS);

    // A browser throttles timers in a tab nobody is looking at, so a room left
    // in a background tab can be a minute stale by the time somebody switches
    // back to it — during a draft, that is a spin and two awards ago. Coming
    // back into view refreshes at once rather than waiting for the next tick.
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      alive.current = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const run = useCallback(
    async (command: AdminCommand) => {
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        const outcome = await runDraftAction(event.id, command);
        apply(outcome.payload);
        if (!outcome.ok) setError(outcome.error);
        else if (outcome.note) setNote(outcome.note);
      } catch {
        setError("That did not reach the server. Nothing has changed — try again.");
      } finally {
        setBusy(false);
      }
    },
    [apply, event.id]
  );

  const bid = useCallback(
    async (amount: number) => {
      setError(null);
      setNote(null);
      const outcome = await placeBidAction(event.id, amount);
      apply(outcome.payload);
      return outcome;
    },
    [apply, event.id]
  );

  const view = payload.view;
  const now = Date.now() + clockOffset.current;
  const isAdmin = view.role === "admin";

  const spin = view.lot?.spin ?? null;
  const spinning = spin !== null && now < spin.startedAt + spin.durationMs;

  // The server withholds the name while the wheel is turning. Once the
  // animation has landed, the spin payload names the winner without waiting for
  // the next poll — the same trick the current board uses, and the reason the
  // reveal is not a second late on a slow connection.
  const onBlockId =
    view.lot?.playerUserId ??
    (spin && !spinning ? (spin.pool[spin.targetIndex] ?? null) : null);
  const onBlock = onBlockId ? playerName(view.players, onBlockId) : null;

  // Between lots the admin may look at the other wheel; everyone else sees the
  // pool the next spin will actually come from.
  const previewKind: DraftPoolKind = view.lot ? view.lot.fromKind : isAdmin ? wheelKind : view.activeKind;
  const previewPool =
    view.lot || !isAdmin
      ? view.activePool
      : previewKind === "reserve"
        ? (view.reservePool ?? [])
        : (view.mainPool ?? []);

  const completion = completionSentence(view);
  const noTeams = view.teams.length === 0;
  const noCaptains = !noTeams && view.teams.every((team) => team.captainUserId === null);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-hair bg-ink/85 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1500px] items-center gap-4 px-4 sm:px-6">
          <Link href="/" className="wordmark text-base tracking-wide hover:text-hot">
            JOB CENTRE<span className="text-union"> DRAFT</span>
          </Link>

          <Eyebrow as="span" className="hidden items-center gap-2 sm:inline-flex">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                offline ? "bg-ember" : "bg-signal live-dot"
              }`}
            />
            {offline ? "Reconnecting" : "Live"}
          </Eyebrow>

          <div className="ml-auto flex items-center gap-3">
            <Eyebrow as="span" className="hidden md:inline">
              Pool {view.mainPoolCount}
              {view.reservePoolCount > 0 && ` · Reserve ${view.reservePoolCount}`}
            </Eyebrow>
            <Eyebrow as="span" className="hidden text-chalk/80 lg:inline">
              {roleWord(view.role)}
            </Eyebrow>
            <Button href={`/events/${event.slug}`} size="sm">
              Event
            </Button>
            {nav}
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] space-y-2 px-4 pt-4 sm:px-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="font-display text-2xl leading-none tracking-wide">
            {event.title}
          </h1>
          <Eyebrow as="span">
            {view.config.biddingMode === "open" ? "Open bidding" : "Sealed bids"}
            {" · "}
            {view.config.rosterTarget} per roster
          </Eyebrow>
        </div>

        {error && <Alert tone="ember">{error}</Alert>}
        {note && <Alert tone="signal">{note}</Alert>}
        {completion && <Alert tone="gold">{completion}</Alert>}
        {noCaptains && (
          <Alert tone="gold">
            No team has a captain yet, so nobody can bid. An admin sets captains on the
            event&rsquo;s Teams tab.
          </Alert>
        )}
      </div>

      {noTeams ? (
        <main className="mx-auto max-w-[1500px] px-4 py-10 sm:px-6">
          <Panel>
            <EmptyState>
              This event has no draft set up yet — no teams, so no wheel and nothing to bid
              on. {isAdmin ? "Add teams on the event's Teams tab and seed the pool." : "Check back once it starts."}
            </EmptyState>
            {isAdmin && (
              <div className="mt-4">
                <Button href={`/admin/events/${event.id}`} size="sm" variant="gold">
                  Set the draft up
                </Button>
              </div>
            )}
          </Panel>
        </main>
      ) : (
        <main
          className={`mx-auto grid max-w-[1500px] gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[320px_minmax(0,1fr)] ${
            isAdmin ? "xl:grid-cols-[320px_minmax(0,1fr)_340px]" : ""
          }`}
        >
          <TeamsRail view={view} />

          <section className="flex min-w-0 flex-col items-center gap-6">
            <LotStage
              view={view}
              pool={previewPool}
              poolKind={previewKind}
              spinning={spinning}
              onBlock={onBlock}
              clockOffset={clockOffset.current}
              now={now}
              onSettled={refresh}
            />

            <div className="w-full max-w-2xl">
              {isAdmin ? (
                <AdminConsole
                  view={view}
                  wheelKind={wheelKind}
                  onWheelKind={setWheelKind}
                  spinning={spinning}
                  onBlock={onBlock}
                  busy={busy}
                  run={run}
                />
              ) : view.role === "captain" ? (
                <BidBox
                  view={view}
                  standing={payload.standing}
                  spinning={spinning}
                  onBlock={onBlock}
                  now={now}
                  bid={bid}
                />
              ) : (
                <WatchPanel
                  view={view}
                  spinning={spinning}
                  onBlock={onBlock}
                  signedIn={signedIn}
                />
              )}
            </div>
          </section>

          {isAdmin && <PoolRail view={view} busy={busy} run={run} />}
        </main>
      )}
    </div>
  );
}

/** §11's four viewers, in the words the room uses for them. */
function roleWord(role: string): string {
  switch (role) {
    case "admin":
      return "Admin";
    case "captain":
      return "Captain";
    case "player":
      return "In this draft";
    default:
      return "Watching";
  }
}
