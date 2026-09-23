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
import {
  Alert,
  Button,
  EmptyState,
  Eyebrow,
  PAGE_SHELL,
  Page,
  Panel,
  cx,
} from "@/components/ui";
import { completionSentence, playerName } from "@/components/draft";
import { tieNotice } from "@/lib/draft-policy";
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
  /*
   * UC-16 6b: "System shows the room that it was a tie."
   *
   * Here rather than in the console, because "the room" is everybody — the
   * watcher who cannot see a single amount most of all, since without this the
   * draft simply appears to stop. `tieNotice` builds the sentence from the two
   * public facts the payload carries (`tied` and the team ids) and never from
   * the amount, which only an admin's payload has at all.
   */
  const tie = tieNotice(view.lot, view.teams);
  const noTeams = view.teams.length === 0;
  const noCaptains = !noTeams && view.teams.every((team) => team.captainUserId === null);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-hair bg-ink/85 backdrop-blur">
        <div className={cx(PAGE_SHELL, "flex h-16 items-center gap-4")}>
          {/* The same mark as `AppHeader`, at the room's own size. What this
              screen is, the title and the live pill under it already say. */}
          <Link href="/" className="wordmark wordmark-accent text-16">
            Job Centre
          </Link>

          <Eyebrow as="span" className="hidden items-center gap-2 sm:inline-flex">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                offline ? "bg-flare" : "bg-success live-dot"
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

      <div className={cx(PAGE_SHELL, "space-y-2 pt-4")}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="font-display text-24 leading-none">
            {event.title}
          </h1>
          <Eyebrow as="span">
            {view.config.biddingMode === "open" ? "Open bidding" : "Sealed bids"}
            {" · "}
            {view.config.rosterTarget} per roster
          </Eyebrow>
        </div>

        {error && <Alert tone="flare">{error}</Alert>}
        {note && <Alert tone="success">{note}</Alert>}
        {tie && !spinning && <Alert tone="flare">{tie}</Alert>}
        {completion && <Alert tone="union">{completion}</Alert>}
        {noCaptains && (
          <Alert tone="union">
            No team has a captain yet, so nobody can bid. An admin sets captains on the
            event&rsquo;s Teams tab.
          </Alert>
        )}
      </div>

      {noTeams ? (
        <Page>
          <Panel>
            <EmptyState>
              This event has no draft set up yet — no teams, so no wheel and nothing to bid
              on. {isAdmin ? "Add teams on the event's Teams tab and seed the pool." : "Check back once it starts."}
            </EmptyState>
            {isAdmin && (
              <div className="mt-4">
                <Button href={`/admin/events/${event.id}`} size="sm" variant="union">
                  Set the draft up
                </Button>
              </div>
            )}
          </Panel>
        </Page>
      ) : (
        /*
          Two columns, never three.

          The pool rail used to take a third column at `xl`, which worked only
          because this page was 1500px wide. Inside the shared 1100px shell the
          arithmetic does not close: 320 for the teams rail + 340 for the pool
          + two 24px gaps leaves the stage 344px, and the stage — the wheel and
          the player on the block — is the room. It needs about 560px before
          the wheel and the lot card stop reading, and 320 + 24 + 560 + 24 +
          340 is 1268 against a content box that tops out at 1052. There is no
          viewport where three columns fit, so there is no breakpoint to push
          them to; the pool goes underneath instead, across the full width.

          Two columns start at `lg`, where the stage is already 632px, and it
          settles at 708px from 1100 up. Below `lg` all three stack.
        */
        <Page className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
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

          {isAdmin && (
            <div className="lg:col-span-2">
              <PoolRail view={view} busy={busy} run={run} />
            </div>
          )}
        </Page>
      )}
    </div>
  );
}

/** §11's four viewers, in the words the room uses for them. */
function roleWord(role: string): string {
  switch (role) {
    // An admin, or a host of this event — both run the room the same way.
    case "admin":
      return "Manager";
    case "captain":
      return "Captain";
    case "player":
      return "In this draft";
    default:
      return "Watching";
  }
}
