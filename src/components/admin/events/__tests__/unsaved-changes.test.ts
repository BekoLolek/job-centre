import { describe, expect, it } from "vitest";
import {
  type Here,
  type LinkAttempt,
  type WorkState,
  UNSAVED_HISTORY_MARK,
  countsAsDirty,
  holdingWork,
  isLockEntry,
  navigationDecision,
  unsavedHistoryLock,
} from "../UnsavedChanges";

/*
 * The lock that stops a manager walking away from unsaved edits
 * (R-31 / UC-08 9a: "Manager tries to leave with unsaved changes — System
 * holds the navigation and offers save or discard; leaving is only possible
 * after one of them").
 *
 * The lock had a hole in it: it caught a click on a link and a tab close, and
 * it did not catch the browser's Back button or the editor navigating itself.
 * Both of those abandon the page, so both lost the work — and a lock you have
 * learned to trust losing your work is worse than no lock at all.
 *
 * What is tested here is the decision, not the wiring. `navigationDecision`
 * and `unsavedHistoryLock` take where-the-page-is, what-`history.state`-holds
 * and tell-me-when-the-user-went-back as arguments, so a Node test with no DOM
 * can drive every branch of them. What cannot be reached from here is said
 * plainly at the bottom of the file.
 */

const HERE: Here = {
  origin: "https://events.test",
  pathname: "/admin/events/e1",
  search: "",
};

/** A plain left click on an ordinary same-origin link, for one field to vary. */
function click(overrides: Partial<LinkAttempt> = {}): LinkAttempt {
  return {
    kind: "link",
    href: "https://events.test/admin/events",
    attribute: "/admin/events",
    target: null,
    download: false,
    button: 0,
    modified: false,
    defaultPrevented: false,
    ...overrides,
  };
}

function work(overrides: Partial<WorkState> = {}): WorkState {
  return { dirty: false, saving: false, ...overrides };
}

/* ------------------------------------------------------------------ */
/* What counts as unsaved work                                        */
/* ------------------------------------------------------------------ */

describe("what counts as unsaved work", () => {
  it("counts a tab that is mid-save, not only one that is dirty", () => {
    // The window the lock is needed in most: an optimistic panel has already
    // cleared `dirty`, and the edits exist nowhere but this browser until the
    // server action comes back.
    expect(holdingWork(work({ dirty: false, saving: true }))).toBe(true);
    expect(holdingWork(work({ dirty: true, saving: false }))).toBe(true);
    expect(holdingWork(work())).toBe(false);
  });

  it("is dirty when any one tab is, and clean when none are", () => {
    expect(countsAsDirty([work(), work(), work({ saving: true })])).toBe(true);
    expect(countsAsDirty([work(), work()])).toBe(false);
    expect(countsAsDirty([])).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* UC-08 9a — the decision                                            */
/* ------------------------------------------------------------------ */

describe("a clean editor", () => {
  it("allows every kind of navigation", () => {
    const clean = { dirty: false, here: HERE };
    expect(navigationDecision({ kind: "history" }, clean)).toBe("allow");
    expect(navigationDecision({ kind: "programmatic" }, clean)).toBe("allow");
    expect(navigationDecision(click(), clean)).toBe("allow");
  });
});

describe("back and forward with unsaved edits (UC-08 9a)", () => {
  const dirty = { dirty: true, here: HERE };

  it("is held, because a pop abandons the page like any other departure", () => {
    expect(navigationDecision({ kind: "history" }, dirty)).toBe("hold");
  });

  it("is allowed again the moment the work is saved", () => {
    expect(navigationDecision({ kind: "history" }, { dirty: false, here: HERE })).toBe(
      "allow"
    );
  });
});

describe("the editor navigating itself with unsaved edits (UC-08 9a)", () => {
  it("is held — a tab switch or a router.push is no more harmless than a click", () => {
    expect(navigationDecision({ kind: "programmatic" }, { dirty: true, here: HERE })).toBe(
      "hold"
    );
  });
});

describe("a link clicked with unsaved edits (UC-08 9a)", () => {
  const dirty = { dirty: true, here: HERE };
  const decide = (attempt: Partial<LinkAttempt>) =>
    navigationDecision(click(attempt), dirty);

  it("holds a plain left click on another page of this site", () => {
    expect(decide({})).toBe("hold");
  });

  it("holds a link to the same path with a different query", () => {
    expect(
      decide({
        href: "https://events.test/admin/events/e1?tab=days",
        attribute: "?tab=days",
      })
    ).toBe("hold");
  });

  it("allows what opens somewhere else instead of leaving this page", () => {
    expect(decide({ target: "_blank" })).toBe("allow");
    expect(decide({ modified: true })).toBe("allow");
    expect(decide({ button: 1 })).toBe("allow");
    expect(decide({ download: true })).toBe("allow");
    expect(
      decide({ href: "https://discord.test/invite", attribute: "https://discord.test/invite" })
    ).toBe("allow");
  });

  it("holds a target of _self, which is this page and nothing clever", () => {
    expect(decide({ target: "_self" })).toBe("hold");
  });

  it("allows an in-page anchor and a bare hash change — they go nowhere", () => {
    expect(
      decide({ href: "https://events.test/admin/events/e1#rules", attribute: "#rules" })
    ).toBe("allow");
    // Same path, same query, different hash, spelled out in full rather than
    // as a fragment: still not a departure.
    expect(
      decide({
        href: "https://events.test/admin/events/e1#rules",
        attribute: "/admin/events/e1#rules",
      })
    ).toBe("allow");
  });

  it("allows a click somebody else has already handled", () => {
    expect(decide({ defaultPrevented: true })).toBe("allow");
  });

  it("allows an href it cannot parse rather than guessing", () => {
    // Nothing to compare, so no reason to believe work is about to be lost;
    // `beforeunload` is still behind it if the browser does navigate.
    expect(decide({ href: "http://[", attribute: "http://[" })).toBe("allow");
  });

  it("holds a link that only differs in query, from a page that has one", () => {
    const withQuery = {
      dirty: true,
      here: { ...HERE, search: "?tab=days" },
    };
    expect(
      navigationDecision(
        click({
          href: "https://events.test/admin/events/e1?tab=questions",
          attribute: "?tab=questions",
        }),
        withQuery
      )
    ).toBe("hold");
    // ...and allows the one that lands back on the page we are already on.
    expect(
      navigationDecision(
        click({
          href: "https://events.test/admin/events/e1?tab=days",
          attribute: "?tab=days",
        }),
        withQuery
      )
    ).toBe("allow");
  });
});

/* ------------------------------------------------------------------ */
/* UC-08 9a — holding the browser's Back button                       */
/* ------------------------------------------------------------------ */

/**
 * A history stack that behaves like the browser's: `pushState` truncates
 * anything ahead and lands on the new entry, and `back()` is what the user's
 * Back button does to the index before `popstate` fires.
 */
function fakeHistory(initial: unknown = { router: "next" }) {
  const states: unknown[] = [initial];
  const pushedUrls: Array<string | null | undefined> = [];
  let index = 0;

  return {
    get state() {
      return states[index];
    },
    pushState(state: unknown, _unused: string, url?: string | null) {
      states.length = index + 1;
      states.push(state);
      pushedUrls.push(url);
      index = states.length - 1;
    },
    /** The Back press itself. The listener runs after this, as in a browser. */
    back() {
      if (index > 0) index -= 1;
    },
    get depth() {
      return states.length;
    },
    get at() {
      return index;
    },
    pushedUrls,
  };
}

/** Install the lock over a fake stack and a fake popstate subscription. */
function lockOver(options: { dirty: () => boolean; initial?: unknown }) {
  const history = fakeHistory(options.initial ?? { router: "next" });
  const listeners = new Set<() => void>();
  let held = 0;

  const stop = unsavedHistoryLock({
    history,
    href: () => "https://events.test/admin/events/e1",
    onPopState: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isDirty: options.dirty,
    onHeld: () => {
      held += 1;
    },
  });

  /** What a Back press is: the stack moves, then `popstate` fires. */
  const pressBack = () => {
    history.back();
    for (const listener of [...listeners]) listener();
  };

  return {
    history,
    stop,
    pressBack,
    get held() {
      return held;
    },
    get listening() {
      return listeners.size;
    },
  };
}

describe("the history lock (UC-08 9a)", () => {
  it("marks one extra entry for this same address, so Back has somewhere to land", () => {
    const lock = lockOver({ dirty: () => true });

    expect(lock.history.depth).toBe(2);
    expect(isLockEntry(lock.history.state)).toBe(true);
    // The same address. An entry with any other URL would make Back a real
    // navigation and there would be nothing left to protect.
    expect(lock.history.pushedUrls).toEqual(["https://events.test/admin/events/e1"]);
  });

  it("keeps whatever the router had in the entry it copies", () => {
    const lock = lockOver({ dirty: () => true, initial: { router: "next", tree: 7 } });
    expect(lock.history.state).toMatchObject({ router: "next", tree: 7 });
  });

  it("does not stack a second entry when one is already ours", () => {
    const lock = lockOver({
      dirty: () => true,
      initial: { [UNSAVED_HISTORY_MARK]: true },
    });
    expect(lock.history.depth).toBe(1);
    expect(lock.history.pushedUrls).toEqual([]);
  });

  it("holds a Back with unsaved edits, and shows that it has (the bar)", () => {
    const lock = lockOver({ dirty: () => true });

    lock.pressBack();

    // Back on our own entry, so the address never changed and the editor was
    // never unmounted — which is the whole point.
    expect(isLockEntry(lock.history.state)).toBe(true);
    expect(lock.held).toBe(1);
  });

  it("holds Back again, and again — one press does not use the lock up", () => {
    const lock = lockOver({ dirty: () => true });

    lock.pressBack();
    lock.pressBack();
    lock.pressBack();

    expect(lock.held).toBe(3);
    expect(isLockEntry(lock.history.state)).toBe(true);
  });

  it("lets Back through once the work is saved", () => {
    let dirty = true;
    const lock = lockOver({ dirty: () => dirty });

    dirty = false;
    lock.pressBack();

    // Off our entry and left there: nothing pushed, nothing flashed, and the
    // next press is a real navigation away.
    expect(isLockEntry(lock.history.state)).toBe(false);
    expect(lock.held).toBe(0);
    expect(lock.history.pushedUrls).toHaveLength(1);
  });

  it("answers with the dirtiness at the moment of the press, not at install", () => {
    // The entry outlives the edit — it is still in the stack after a save — so
    // an installed-time answer would make the page one you cannot get out of.
    let dirty = true;
    const lock = lockOver({ dirty: () => dirty });

    lock.pressBack();
    expect(lock.held).toBe(1);

    dirty = false;
    lock.pressBack();
    expect(lock.held).toBe(1);
    expect(isLockEntry(lock.history.state)).toBe(false);
  });

  it("does nothing on a pop that lands back on our own entry", () => {
    const lock = lockOver({
      dirty: () => true,
      initial: { [UNSAVED_HISTORY_MARK]: true },
    });

    // No `back()` first: a pop that arrives while we are already on the lock
    // entry is our own answer landing, and answering it again would be a loop.
    lock.pressBack();
    expect(lock.history.depth).toBe(1);
  });

  it("stops listening when the editor is done with it", () => {
    const lock = lockOver({ dirty: () => true });
    expect(lock.listening).toBe(1);

    lock.stop();

    expect(lock.listening).toBe(0);
    lock.pressBack();
    expect(lock.held).toBe(0);
  });
});

describe("isLockEntry", () => {
  it("recognises only an entry this file marked", () => {
    expect(isLockEntry({ [UNSAVED_HISTORY_MARK]: true })).toBe(true);
    expect(isLockEntry({ [UNSAVED_HISTORY_MARK]: "yes" })).toBe(false);
    expect(isLockEntry({ router: "next" })).toBe(false);
    expect(isLockEntry(null)).toBe(false);
    expect(isLockEntry(undefined)).toBe(false);
    expect(isLockEntry("marked")).toBe(false);
  });
});

/*
 * ## What this file cannot reach, stated rather than faked
 *
 * Three things in `UnsavedChanges.tsx` are browser wiring and have no pure
 * half, so nothing here covers them and no test in this repo can:
 *
 *  - that the click listener is attached to `document` in the capture phase,
 *    and that its `preventDefault` is what actually stops `next/link` —
 *    `environment: "node"`, so there is no document and no `<Link>` to click;
 *  - that `beforeunload` is registered while dirty and removed after, and that
 *    a browser honours it (the wording is the browser's and not ours anyway);
 *  - that `window.history.pushState` of a same-address entry leaves the App
 *    Router alone. Next 16 documents `pushState` as integrating with the
 *    router rather than being owned by it, and the lock depends on that, but
 *    it is a fact about the router and only a browser can show it.
 *
 * The first and third are what the plan's browser pass over section B is for.
 */
