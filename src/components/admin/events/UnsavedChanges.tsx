"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cx } from "@/components/ui";

/**
 * The unsaved-changes bar, and the lock that stops you walking away from one
 * (R-31 / UC-08 9a).
 *
 * Every tab in the editor saves itself, which is right — an event is a dozen
 * separate decisions and forcing them into one transaction would mean an admin
 * cannot fix a typo without re-confirming the format. What it cost was a save
 * button at the bottom of each tab and no consequence for ignoring it. Change
 * the capacity, click Days, and the change is gone with nothing said.
 *
 * So: while a tab is dirty, a bar sits over the bottom of the screen with the
 * two answers on it, and nothing else moves until one of them is given. Four
 * ways out of the editor all have to be caught, because a lock with a hole in
 * it is worse than no lock — you learn to trust it and then it loses your work.
 *
 *   1. **The editor navigating itself** — switching tab, opening another step,
 *      a `router.push` from a panel. Every one of those asks
 *      {@link useNavigationLock} first, which is {@link navigationDecision}'s
 *      `programmatic` attempt. `router.refresh()` is deliberately *not* a
 *      departure: it re-renders the server tree in place and every panel keeps
 *      the state it seeded from props, so it abandons nothing — which is why
 *      the panels may call it the moment a save returns.
 *   2. **Following a link.** A capture-phase click listener on the document.
 *      The App Router gives no route-change hook to hang this on — Next 16's
 *      only interception point is `onNavigate`, which is per-`<Link>` and so no
 *      use to a lock that has to cover links it has never heard of — so the
 *      click is caught before React sees it and cancelled while dirty.
 *   3. **Back and forward.** {@link unsavedHistoryLock}, below.
 *   4. **Closing the tab or reloading.** `beforeunload`, which is all the
 *      browser will allow — the wording is the browser's, not ours.
 *
 * Discard is a remount, not an undo. Every tab seeds its state from props with
 * `useState(event.something)`, so throwing the subtree away and building it
 * again *is* the reset, exactly, for every field including the ones nobody
 * remembered to list. Anything less general would rot the first time somebody
 * adds a field.
 *
 * ## Why the rules are pure functions with their inputs handed in
 *
 * {@link navigationDecision} and {@link unsavedHistoryLock} take the browser
 * facts they need — where the page is, what `history.state` holds, tell me when
 * the user goes back — as arguments rather than reaching for `document`,
 * `window` or `location`. That is not indirection for its own sake: this repo's
 * test setup is Node with no DOM (`vitest.config.ts`: `environment: "node"`),
 * so a listener inside a `useEffect` is not a thing any test here can drive.
 * Lifted out, the decision is an ordinary function that a table of inputs
 * exercises exactly, and the component is left holding nothing but the wiring.
 * `src/components/events/LiveRefresh.tsx` splits its polling loop the same way
 * and for the same reason.
 */

/* ------------------------------------------------------------------ */
/* What counts as unsaved work                                        */
/* ------------------------------------------------------------------ */

/** The two bits of a tab's save state the lock reasons about. */
export type WorkState = {
  dirty: boolean;
  saving: boolean;
};

/**
 * Is this tab holding work that leaving would lose?
 *
 * `saving` counts as well as `dirty`. A save is a round trip to a server action,
 * and a tab that is mid-flight has edits that exist only in the browser until
 * it comes back — so the window where the lock is most needed is exactly the
 * one where `dirty` has already been set to false by an optimistic panel.
 */
export function holdingWork(entry: WorkState): boolean {
  return entry.dirty || entry.saving;
}

/** Is anything in the editor holding unsaved work? */
export function countsAsDirty(entries: Iterable<WorkState>): boolean {
  for (const entry of entries) {
    if (holdingWork(entry)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* What a navigation attempt should do                                */
/* ------------------------------------------------------------------ */

/** Where the browser is, as the link rules need to see it. */
export type Here = {
  origin: string;
  pathname: string;
  search: string;
};

/** Somebody clicked an anchor. Every field is read off the DOM event. */
export type LinkAttempt = {
  kind: "link";
  /** The anchor's resolved absolute href (`HTMLAnchorElement.href`). */
  href: string;
  /** The `href` *attribute* as written — `#somewhere` is not a departure. */
  attribute: string;
  /** `_blank` and friends open elsewhere and abandon nothing. */
  target: string | null;
  download: boolean;
  /** `MouseEvent.button`; anything but 0 is not a plain left click. */
  button: number;
  /** Any of meta/ctrl/shift/alt — a new tab or window, not a departure. */
  modified: boolean;
  defaultPrevented: boolean;
};

/** Back or forward: a `popstate`. */
export type HistoryAttempt = { kind: "history" };

/**
 * The editor moving itself — a tab switch, a `router.push`, anything that is
 * neither a click on an anchor nor the browser's own buttons.
 */
export type ProgrammaticAttempt = { kind: "programmatic" };

export type NavigationAttempt = LinkAttempt | HistoryAttempt | ProgrammaticAttempt;

/**
 * What to do about an attempt: let it happen, or refuse it and show the bar.
 *
 * Two words rather than a boolean, because `false` has meant both of these in
 * different handlers in this file's history and reading one for the other is
 * how a lock ends up with a hole in it.
 */
export type NavigationDecision = "allow" | "hold";

/**
 * The whole rule, for all three kinds of attempt (R-31 / UC-08 9a).
 *
 * Nothing is dirty: everything is allowed, always — a lock that refuses a click
 * on a clean editor is a bug, not a safe default.
 *
 * Dirty: the browser's own buttons and the editor's own navigation are held
 * outright, because both abandon the page and neither has a harmless spelling.
 * A click has several, and they are the fiddly part:
 *
 *  - another origin, `target` other than `_self`, `download`, a middle click or
 *    any modifier — none of these abandon this page, they open something else;
 *  - `#somewhere`, and the same path and query by any other spelling — these go
 *    nowhere at all, and refusing them would stop an in-page anchor working for
 *    no gain whatsoever;
 *  - already `defaultPrevented` — somebody else has handled it.
 *
 * An unparseable href is allowed rather than held. There is nothing to compare
 * and so no reason to believe work is about to be lost, and `beforeunload`
 * still covers it if the browser does navigate.
 */
export function navigationDecision(
  attempt: NavigationAttempt,
  context: { dirty: boolean; here: Here }
): NavigationDecision {
  if (!context.dirty) return "allow";

  switch (attempt.kind) {
    case "history":
    case "programmatic":
      return "hold";
    case "link":
      return linkDecision(attempt, context.here);
  }
}

function linkDecision(attempt: LinkAttempt, here: Here): NavigationDecision {
  if (attempt.defaultPrevented) return "allow";
  if (attempt.button !== 0) return "allow";
  if (attempt.modified) return "allow";
  if (attempt.target && attempt.target !== "_self") return "allow";
  if (attempt.download) return "allow";
  if (attempt.attribute.startsWith("#")) return "allow";

  let url: URL;
  try {
    url = new URL(attempt.href, `${here.origin}${here.pathname}${here.search}`);
  } catch {
    return "allow";
  }

  if (url.origin !== here.origin) return "allow";
  // Same page, different hash — still not going anywhere.
  if (url.pathname === here.pathname && url.search === here.search) return "allow";

  return "hold";
}

/* ------------------------------------------------------------------ */
/* Back and forward                                                   */
/* ------------------------------------------------------------------ */

/**
 * The flag this file puts on a history entry of its own making.
 *
 * Namespaced, because `history.state` belongs to the App Router as much as to
 * us — Next 16 documents `pushState` as something it integrates with rather
 * than owns — and the existing state is copied across rather than replaced for
 * the same reason.
 */
export const UNSAVED_HISTORY_MARK = "jobCentreUnsavedLock";

/** Just enough of `window.history` to be handed a fake one in a test. */
export type HistoryLike = {
  readonly state: unknown;
  pushState(state: unknown, unused: string, url?: string | null): void;
};

export type HistoryLockOptions = {
  history: HistoryLike;
  /** The address to hold, read at the moment it is needed. */
  href: () => string;
  /** Subscribe to back/forward; returns the unsubscribe. */
  onPopState: (listener: () => void) => () => void;
  /** Asked at the moment of the attempt, never sampled once. */
  isDirty: () => boolean;
  /** Flash the bar: a refused Back has to be *seen* to be refused. */
  onHeld: () => void;
};

/** Is this history entry one of ours? */
export function isLockEntry(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  return (state as Record<string, unknown>)[UNSAVED_HISTORY_MARK] === true;
}

/**
 * Hold the page against the browser's Back and Forward buttons while a tab is
 * dirty, and hand back the stop (UC-08 9a).
 *
 * ## Why an extra history entry, rather than cancelling the pop
 *
 * `popstate` cannot be cancelled. By the time it fires the browser has already
 * moved, and the App Router has already begun rendering wherever it moved to —
 * which unmounts the editor, which is the work gone. So the lock does not try
 * to cancel anything. It pushes **one extra entry for the page it is already
 * on**, so that the first Back lands on this same address: the URL does not
 * change, the router sees no route change, nothing unmounts, and the handler
 * then pushes the entry again to put the stack back where it was.
 *
 * The same-address part is the whole trick. An entry with any other URL would
 * make Back a real navigation and there would be nothing left to protect.
 *
 * ## What this costs, stated plainly
 *
 * Each refused Back leaves one more entry for this page in the stack, so after
 * saving, that many Back presses land on this page again before one leaves it.
 * No browser offers a way to remove a history entry, so every popstate guard
 * pays this; pushing (rather than stepping forward) is the version that cannot
 * be beaten by a second Back arriving before the first has been answered, and
 * being hard to outrun matters more here than a tidy stack.
 *
 * ## Why the dirtiness is a function
 *
 * It is read when the user presses Back, not when the lock was installed. The
 * entry outlives the edit — it is still in the stack after a save — and an
 * entry that refused to be left after the work was saved would be a page you
 * cannot get out of.
 */
export function unsavedHistoryLock(options: HistoryLockOptions): () => void {
  const mark = () => {
    const current = options.history.state;
    const base = current && typeof current === "object" ? current : {};
    options.history.pushState(
      { ...base, [UNSAVED_HISTORY_MARK]: true },
      "",
      options.href()
    );
  };

  // One entry, however many times the editor goes dirty and clean again: the
  // one already at the top of the stack does the same job.
  if (!isLockEntry(options.history.state)) mark();

  return options.onPopState(() => {
    // Already back where we belong — the pop was our own answer landing.
    if (isLockEntry(options.history.state)) return;
    if (!options.isDirty()) return;
    mark();
    options.onHeld();
  });
}

/* ------------------------------------------------------------------ */
/* The context                                                        */
/* ------------------------------------------------------------------ */

type Registration = WorkState & {
  /** Blocks the bar's save button — invalid input, nothing to send. */
  blocked?: boolean;
  /** What the bar's save button says. */
  label?: string;
  /** Why saving is blocked, if it is. */
  reason?: ReactNode;
  save: () => void;
};

type Ctx = {
  register: (id: string, value: Registration | null) => void;
  /** True when anything in the editor is holding unsaved edits. */
  dirty: boolean;
  /** Run `go` unless something is dirty; if it is, flash the bar instead. */
  guard: (go: () => void) => void;
};

const UnsavedContext = createContext<Ctx | null>(null);

/**
 * Publishes a tab's save state to the bar.
 *
 * Registration is keyed by a stable id and cleared on unmount, so a tab that
 * disappears cannot leave the bar up. The value is held in a ref and mirrored
 * into state on change, because a tab re-renders on every keystroke and the
 * bar only cares when `dirty`, `saving` or the label actually moved.
 */
export function useUnsavedChanges(id: string, value: Registration) {
  const ctx = useContext(UnsavedContext);
  const register = ctx?.register;

  const { dirty, saving, blocked, label, reason, save } = value;
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!register) return;
    register(id, {
      dirty,
      saving,
      blocked,
      label,
      reason,
      // Read through the ref so a fresh closure each render does not count as
      // a change and re-register on every keystroke.
      save: () => saveRef.current(),
    });
    return () => register(id, null);
  }, [register, id, dirty, saving, blocked, label, reason]);
}

/**
 * The guard for anything inside the editor that would abandon a dirty tab —
 * switching tab, opening another step. Returns a function that runs its
 * argument when it is safe and refuses when it is not.
 */
export function useNavigationLock() {
  const ctx = useContext(UnsavedContext);
  return ctx?.guard ?? ((go: () => void) => go());
}

/** Whether anything is dirty — for styling a control that is about to refuse. */
export function useIsDirty() {
  return useContext(UnsavedContext)?.dirty ?? false;
}

export default function UnsavedChangesProvider({
  onDiscard,
  children,
}: {
  /**
   * Rebuild the dirty subtree. The editor bumps a key; React does the rest.
   */
  onDiscard: () => void;
  children: ReactNode;
}) {
  const [entries, setEntries] = useState<ReadonlyMap<string, Registration>>(new Map());
  const [nudge, setNudge] = useState(0);

  const register = useCallback((id: string, value: Registration | null) => {
    setEntries((was) => {
      const next = new Map(was);
      if (value) next.set(id, value);
      else next.delete(id);
      return next;
    });
  }, []);

  const active = useMemo(
    () => [...entries.values()].find((entry) => holdingWork(entry)) ?? null,
    [entries]
  );
  const dirty = countsAsDirty(entries.values());

  // Read by the listeners below, which are installed once per dirty spell and
  // must answer with what is true when the user acts rather than with what was
  // true when they were attached.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  /** Refuse, visibly: re-run the bar's entrance so a refusal reads as one. */
  const hold = useCallback(() => setNudge((n) => n + 1), []);

  const decide = useCallback(
    (attempt: NavigationAttempt) =>
      navigationDecision(attempt, {
        dirty: dirtyRef.current,
        here: {
          origin: window.location.origin,
          pathname: window.location.pathname,
          search: window.location.search,
        },
      }),
    []
  );

  const guard = useCallback(
    (go: () => void) => {
      if (decide({ kind: "programmatic" }) === "allow") go();
      else hold();
    },
    [decide, hold]
  );

  /* --- Leaving the page entirely --------------------------------- */
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Set for the browsers that still read it; the string is ignored.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  /* --- Back and forward ------------------------------------------ */
  useEffect(() => {
    if (!dirty) return;
    return unsavedHistoryLock({
      history: window.history,
      href: () => window.location.href,
      onPopState: (listener) => {
        window.addEventListener("popstate", listener);
        return () => window.removeEventListener("popstate", listener);
      },
      // The ref, not `dirty`: the entry this installs outlives the edit, and
      // the answer has to be the one that is true when Back is pressed.
      isDirty: () => dirtyRef.current,
      onHeld: hold,
    });
  }, [dirty, hold]);

  /* --- Following a link ------------------------------------------ */
  useEffect(() => {
    if (!dirty) return;
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;

      const decision = decide({
        kind: "link",
        href: anchor.href,
        attribute: anchor.getAttribute("href") ?? "",
        target: anchor.target || null,
        download: anchor.hasAttribute("download"),
        button: event.button,
        modified: event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
        defaultPrevented: event.defaultPrevented,
      });
      if (decision === "allow") return;

      event.preventDefault();
      event.stopPropagation();
      hold();
    };
    // Capture, so this runs before the router's own handler.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty, decide, hold]);

  const value = useMemo<Ctx>(() => ({ register, dirty, guard }), [register, dirty, guard]);

  return (
    <UnsavedContext.Provider value={value}>
      {children}
      {active && (
        <UnsavedBar
          key={nudge}
          entry={active}
          onDiscard={() => {
            onDiscard();
            // The remount clears the registration; drop it now so the bar goes
            // immediately rather than after the subtree has rebuilt.
            setEntries(new Map());
          }}
        />
      )}
    </UnsavedContext.Provider>
  );
}

function UnsavedBar({ entry, onDiscard }: { entry: Registration; onDiscard: () => void }) {
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      /*
       * Above `z-50`, which is not a round number for its own sake: the
       * development sign-in banner is `fixed bottom-0 z-50` and 45px tall, it
       * is rendered from the root layout *after* the page, and at equal
       * stacking it therefore took the clicks meant for Save and Discard — the
       * two buttons the whole lock exists to offer (docs/plan.md, Task 33).
       * One step up is enough: the bar is opaque, so it sits over the banner
       * rather than behind it, and the banner is dev-only and transient while
       * this bar is up.
       */
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center px-4 pb-5"
    >
      <div
        className={cx(
          "unsaved-bar pointer-events-auto flex w-full max-w-[760px] flex-wrap items-center",
          "gap-x-4 gap-y-2 rounded-lg border border-hair bg-raised px-4 py-3 shadow-lift"
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="text-13 leading-tight text-chalk">
            {entry.saving ? "Saving…" : "You have unsaved changes."}
          </p>
          {entry.reason && (
            <p className="mt-0.5 text-12 leading-tight text-flare">{entry.reason}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="btn"
            onClick={onDiscard}
            disabled={entry.saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-union"
            onClick={entry.save}
            disabled={entry.saving || entry.blocked}
          >
            {entry.saving ? "Saving…" : (entry.label ?? "Save changes")}
          </button>
        </div>
      </div>
    </div>
  );
}
