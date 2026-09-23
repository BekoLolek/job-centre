"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { EventStatus } from "@/db/schema";

/**
 * A running event's page, keeping itself current.
 *
 * UC-11's outcome, in one component: *while the event is running, the page
 * keeps itself current without a reload* — the schedule shifting as matches
 * finish (R-45, R-77), the bracket resolving as results land (R-46) and each
 * map's score appearing as it is recorded (R-47). None of that is rendered
 * here. The page is already `force-dynamic` server components, so the only
 * thing missing was somebody asking for them again; this asks.
 *
 * docs/decisions/002-live-event-pages.md picked polling over SSE and over a
 * hosted realtime service, and the two conditions in it are the whole design:
 * poll **only while the status is running**, and **only while the tab is
 * visible**. A ten-second-old bracket satisfies a community watching on
 * Discord; a page left open on a finished event, or behind forty other tabs,
 * must cost Neon nothing at all. That is also the escape hatch the decision
 * names: if viewer counts ever make this expensive, option C replaces this one
 * file and nothing else knows how refresh happens.
 *
 * ## Why the loop is a separate, injected function
 *
 * `liveRefreshLoop` takes the clock's two browser facts — is the tab visible,
 * and tell me when that changes — as arguments rather than reaching for
 * `document`. That is not indirection for its own sake: this repo's test setup
 * is Node with no DOM (`vitest.config.ts`: `environment: "node"`), so a
 * `visibilitychange` listener inside a `useEffect` is not a thing any test here
 * can drive. Lifted out, the rule is an ordinary function that fake timers and
 * a two-line fake visibility source exercise exactly, and the component is left
 * holding nothing but the wiring.
 *
 * ## It stops rather than skips
 *
 * A hidden tab clears the interval instead of letting it fire into a `return`.
 * Both cost the same in Neon compute, but only one of them is what the decision
 * says, and an interval that is still ticking is an interval somebody will
 * later attach a second job to.
 */

/** Decision 002's interval: ten seconds, ~a fifth of the draft room's rate. */
export const LIVE_REFRESH_MS = 10_000;

/**
 * Is this event running right now?
 *
 * `live` is the status the rest of the codebase calls running
 * (docs/diagrams/event-state.md); there is no other, and a `complete` event
 * that an admin reopens goes back to it, so the page starts polling again on
 * its own.
 */
export function isRunning(status: EventStatus): boolean {
  return status === "live";
}

export type LiveRefreshOptions = {
  status: EventStatus;
  /** Whether the tab is on screen at this instant. */
  isVisible: () => boolean;
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onVisibilityChange: (listener: () => void) => () => void;
  /** Overridable for tests. Defaults to {@link LIVE_REFRESH_MS}. */
  every?: number;
};

/**
 * Start asking for the page again every `every` ms, and hand back the stop.
 *
 * Both conditions are live, not sampled once: the status decides whether there
 * is a loop at all, and visibility starts and stops it for as long as there is.
 * The stop is unconditional — it removes the listener *and* clears any running
 * timer — because a component that unmounts while the tab happens to be hidden
 * must not leave a subscription behind to start a timer nobody can clear.
 */
export function liveRefreshLoop(
  refresh: () => void,
  options: LiveRefreshOptions
): () => void {
  if (!isRunning(options.status)) return () => {};

  const every = options.every ?? LIVE_REFRESH_MS;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stopTimer = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  // Idempotent on purpose: a browser that fires `visibilitychange` twice for
  // one switch must not end up with two intervals refreshing the same page.
  const sync = () => {
    if (options.isVisible()) {
      if (timer === null) timer = setInterval(refresh, every);
    } else {
      stopTimer();
    }
  };

  const unsubscribe = options.onVisibilityChange(sync);
  sync();

  return () => {
    unsubscribe();
    stopTimer();
  };
}

export type LiveRefreshProps = {
  status: EventStatus;
  /** Overridable for a caller that wants a different rate. Rarely used. */
  every?: number;
};

export default function LiveRefresh({ status, every }: LiveRefreshProps) {
  const router = useRouter();

  useEffect(
    () =>
      liveRefreshLoop(() => router.refresh(), {
        status,
        every,
        // `visibilityState` rather than `document.hidden` so a tab that is
        // merely `prerender`ing still counts as away.
        isVisible: () => document.visibilityState === "visible",
        onVisibilityChange: (listener) => {
          document.addEventListener("visibilitychange", listener);
          return () => document.removeEventListener("visibilitychange", listener);
        },
      }),
    [status, every, router]
  );

  return null;
}
