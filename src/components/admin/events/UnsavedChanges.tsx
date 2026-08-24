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
 * The unsaved-changes bar, and the lock that stops you walking away from one.
 *
 * Every tab in the editor saves itself, which is right — an event is a dozen
 * separate decisions and forcing them into one transaction would mean an admin
 * cannot fix a typo without re-confirming the format. What it cost was a save
 * button at the bottom of each tab and no consequence for ignoring it. Change
 * the capacity, click Days, and the change is gone with nothing said.
 *
 * So: while a tab is dirty, a bar sits over the bottom of the screen with the
 * two answers on it, and nothing else moves until one of them is given. Three
 * ways out of the editor all have to be caught, because a lock with a hole in
 * it is worse than no lock — you learn to trust it and then it loses your work.
 *
 *   1. **Switching tab.** The editor asks {@link useNavigationLock} first.
 *   2. **Following a link.** A capture-phase click listener on the document.
 *      The App Router gives no route-change hook to hang this on, so the click
 *      is caught before React sees it and cancelled while dirty.
 *   3. **Closing the tab or hitting back.** `beforeunload`, which is all the
 *      browser will allow — the wording is the browser's, not ours.
 *
 * Discard is a remount, not an undo. Every tab seeds its state from props with
 * `useState(event.something)`, so throwing the subtree away and building it
 * again *is* the reset, exactly, for every field including the ones nobody
 * remembered to list. Anything less general would rot the first time somebody
 * adds a field.
 */

type Registration = {
  dirty: boolean;
  saving: boolean;
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
    () => [...entries.values()].find((entry) => entry.dirty || entry.saving) ?? null,
    [entries]
  );
  const dirty = Boolean(active);

  const guard = useCallback(
    (go: () => void) => {
      if (!dirty) {
        go();
        return;
      }
      // Re-run the bar's entrance so a refused click is visibly refused. An
      // action that silently does nothing reads as a broken button.
      setNudge((n) => n + 1);
    },
    [dirty]
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

  /* --- Following a link ------------------------------------------ */
  useEffect(() => {
    if (!dirty) return;
    const onClick = (event: MouseEvent) => {
      // Leave modified clicks alone: opening in a new tab abandons nothing.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target && anchor.target !== "_self") return;
      if (anchor.hasAttribute("download")) return;

      // An in-page anchor is not navigation away.
      const href = anchor.getAttribute("href") ?? "";
      if (href.startsWith("#")) return;

      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Same page, different hash — still not going anywhere.
      if (url.pathname === window.location.pathname && url.search === window.location.search) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setNudge((n) => n + 1);
    };
    // Capture, so this runs before the router's own handler.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty]);

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
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-5"
    >
      <div
        className={cx(
          "unsaved-bar pointer-events-auto flex w-full max-w-[760px] flex-wrap items-center",
          "gap-x-4 gap-y-2 rounded-[10px] border border-hair bg-raised px-4 py-3 shadow-lift"
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] leading-tight text-chalk">
            {entry.saving ? "Saving…" : "You have unsaved changes."}
          </p>
          {entry.reason && (
            <p className="mt-0.5 text-[12px] leading-tight text-flare">{entry.reason}</p>
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
            className="btn btn-gold"
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
