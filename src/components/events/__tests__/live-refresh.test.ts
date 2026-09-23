import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_REFRESH_MS,
  isRunning,
  liveRefreshLoop,
} from "@/components/events/LiveRefresh";
import type { EventStatus } from "@/db/schema";

/**
 * When a running event's page asks for itself again — UC-11's outcome.
 *
 * docs/decisions/002-live-event-pages.md chose polling over SSE and over a
 * hosted realtime service, and made two conditions load-bearing: poll only
 * while the status is running, and only while the tab is visible. The first
 * keeps a page left open on a finished event from reading Neon forever; the
 * second does the same for the twelve tabs nobody is looking at. Neither is
 * observable from a screenshot, so they are the two things worth testing.
 *
 * ## Fake timers, and a fake tab
 *
 * There is no jsdom in this repo — `vitest.config.ts` is `environment: "node"`
 * — so `document.visibilitychange` is not a thing any test here can fire, and
 * `useEffect` does not run under `renderToStaticMarkup` (which is how
 * `match-card.test.ts` renders a component at all). That is exactly why
 * `liveRefreshLoop` takes the two browser facts as arguments: visibility is a
 * function this file controls, the listener is a callback this file holds, and
 * the interval is `vi.useFakeTimers()`'s. What is left untested is the ten
 * lines of `useEffect` that pass `document` to it, which is the smallest
 * untestable surface the split could leave behind.
 *
 * The alternative — adding jsdom and a rendering library for one component —
 * was not taken. It would be a test-only dependency, a second environment in
 * the config, and it would still be driving the same two conditions through
 * two more layers.
 */

/** A tab whose visibility this file decides, and the listener the loop adds. */
function fakeTab(visible = true) {
  let listener: (() => void) | null = null;
  let subscribed = 0;
  return {
    isVisible: () => visible,
    onVisibilityChange: (fn: () => void) => {
      listener = fn;
      subscribed += 1;
      return () => {
        listener = null;
        subscribed -= 1;
      };
    },
    /** What the browser does: change the fact, then fire the event. */
    setVisible(next: boolean) {
      visible = next;
      listener?.();
    },
    get listening() {
      return subscribed > 0;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isRunning", () => {
  it("is true for the one status that means the event is being played", () => {
    const statuses: EventStatus[] = ["draft", "published", "live", "complete", "cancelled"];
    expect(statuses.filter(isRunning)).toEqual(["live"]);
  });
});

describe("liveRefreshLoop — while the event is running", () => {
  it("asks for the page again every ten seconds", () => {
    const refresh = vi.fn();
    const tab = fakeTab();

    const stop = liveRefreshLoop(refresh, { status: "live", ...tab });

    // Nothing on mount: the server render is already current.
    expect(refresh).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(LIVE_REFRESH_MS - 1);
    expect(refresh).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(LIVE_REFRESH_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(4);

    stop();
  });

  it("stops the moment the tab is hidden, and starts again when it comes back", () => {
    const refresh = vi.fn();
    const tab = fakeTab();

    const stop = liveRefreshLoop(refresh, { status: "live", ...tab });

    vi.advanceTimersByTime(LIVE_REFRESH_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(2);

    tab.setVisible(false);
    vi.advanceTimersByTime(LIVE_REFRESH_MS * 10);
    // Ten intervals went by behind another tab and cost the database nothing.
    expect(refresh).toHaveBeenCalledTimes(2);

    tab.setVisible(true);
    vi.advanceTimersByTime(LIVE_REFRESH_MS);
    expect(refresh).toHaveBeenCalledTimes(3);

    stop();
  });

  it("does not start at all while the tab is already hidden", () => {
    const refresh = vi.fn();
    const tab = fakeTab(false);

    const stop = liveRefreshLoop(refresh, { status: "live", ...tab });

    vi.advanceTimersByTime(LIVE_REFRESH_MS * 5);
    expect(refresh).toHaveBeenCalledTimes(0);

    stop();
  });

  it("runs one interval however many times the browser says the tab came back", () => {
    const refresh = vi.fn();
    const tab = fakeTab();

    const stop = liveRefreshLoop(refresh, { status: "live", ...tab });

    // Some browsers fire `visibilitychange` more than once for one switch. A
    // second interval here would double every refresh for the rest of the page.
    tab.setVisible(true);
    tab.setVisible(true);

    vi.advanceTimersByTime(LIVE_REFRESH_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    stop();
  });
});

describe("liveRefreshLoop — while the event is not running", () => {
  const idle: EventStatus[] = ["draft", "published", "complete", "cancelled"];

  for (const status of idle) {
    it(`never polls a ${status} event, and subscribes to nothing`, () => {
      const refresh = vi.fn();
      const tab = fakeTab();

      const stop = liveRefreshLoop(refresh, { status, ...tab });

      vi.advanceTimersByTime(LIVE_REFRESH_MS * 20);
      expect(refresh).toHaveBeenCalledTimes(0);
      expect(tab.listening).toBe(false);

      stop();
    });
  }
});

describe("liveRefreshLoop — leaving", () => {
  it("leaves no timer and no listener behind", () => {
    const refresh = vi.fn();
    const tab = fakeTab();

    const stop = liveRefreshLoop(refresh, { status: "live", ...tab });
    expect(tab.listening).toBe(true);

    stop();

    expect(tab.listening).toBe(false);
    vi.advanceTimersByTime(LIVE_REFRESH_MS * 20);
    expect(refresh).toHaveBeenCalledTimes(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leaves no listener behind when it unmounts while the tab is hidden", () => {
    const refresh = vi.fn();
    const tab = fakeTab();

    const stop = liveRefreshLoop(refresh, { status: "live", ...tab });
    tab.setVisible(false);
    stop();

    // The timer was already cleared by the hide; the subscription is the one
    // that would otherwise survive and start a timer nobody holds the stop for.
    expect(tab.listening).toBe(false);
    tab.setVisible(true);
    vi.advanceTimersByTime(LIVE_REFRESH_MS * 5);
    expect(refresh).toHaveBeenCalledTimes(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
