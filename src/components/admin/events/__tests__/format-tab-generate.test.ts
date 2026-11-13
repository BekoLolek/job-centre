import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateStage } from "@/lib/bracket";
import { eventShapeFrom } from "@/lib/events-policy";
import type { FormatView, StageView } from "@/lib/format";
import {
  type StageConfig,
  type StageKind,
  DEFAULT_FORMAT_TIMING,
  normaliseStageConfig,
} from "@/lib/format-policy";
import { dayMinutes, planBlocks } from "@/lib/format-schedule";
import { resolveMatches } from "@/lib/format-resolve";

/*
 * A stage with no matches, and the button that builds them — R-268 / UC-18 9b, 9c.
 *
 * The matches line used to answer a saved stage holding no rows with "saving
 * builds them", on a tab where nothing was dirty and so no save bar was up to
 * press. This file is about the one button that state now has, and about every
 * neighbouring state that must *not* have it.
 *
 * ## What this harness is, because a markup test cannot press anything
 *
 * The suite has no DOM. `renderToStaticMarkup` runs the real component under
 * the real React, but it hands back a string, and a string has no `onClick`.
 * Two small spies close that gap, and neither replaces anything:
 *
 *  - **`@/components/ui` is wrapped, not faked.** `Button` and `Field` record
 *    the props they were handed and then render the real component. So a test
 *    can take the `onClick` the tab actually gave the button labelled "Generate
 *    matches" and call it — the handler that runs is the tab's own closure.
 *    `SaveRow` is wrapped the same way, for its `onSave`: the save button lives
 *    on a bar outside this tab, and `onSave` is what that bar presses.
 *  - **`useState` remembers what its setter was told.** The server renderer
 *    drops a `setState` made after the render, which is correct for a server
 *    and useless here. The wrapper calls the real hook, and keeps any value a
 *    setter is given under the hook's call position, so the *next* render of
 *    the same tab reads it. The tab is the root, so its own hooks are always
 *    the first calls of a render and their positions never move.
 *
 * So "press, then render again" walks the tab's real handler and its real
 * markup. **What it does not do** is said at the bottom of the file.
 */

const actions = vi.hoisted(() => ({
  generateStageAction: vi.fn(),
  previewStagesAction: vi.fn(async () => []),
  rebuildStageAction: vi.fn(),
  saveStagesAction: vi.fn(),
}));

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: () => {}, push: () => {} }));

type Seen = { kind: "Button" | "Field" | "SaveRow"; props: Record<string, unknown> };
const seen = vi.hoisted(() => [] as Seen[]);
const hooks = vi.hoisted(() => ({ at: 0, held: new Map<number, unknown>() }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  function useState<T>(initial: T | (() => T)) {
    const at = hooks.at;
    hooks.at += 1;
    const [rendered] = actual.useState(initial);
    const read = () => (hooks.held.has(at) ? (hooks.held.get(at) as T) : rendered);
    const write = (next: T | ((was: T) => T)) => {
      hooks.held.set(at, typeof next === "function" ? (next as (was: T) => T)(read()) : next);
    };
    return [read(), write];
  }
  return { ...actual, useState };
});

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  const react = await import("react");
  const watched =
    (kind: Seen["kind"], real: unknown) => (props: Record<string, unknown>) => {
      seen.push({ kind, props });
      return react.createElement(real as never, props);
    };
  return {
    ...actual,
    Button: watched("Button", actual.Button),
    Field: watched("Field", actual.Field),
  };
});

vi.mock("../SaveRow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../SaveRow")>();
  const react = await import("react");
  return {
    ...actual,
    default: (props: Record<string, unknown>) => {
      seen.push({ kind: "SaveRow", props });
      return react.createElement(actual.default as never, props);
    },
  };
});

vi.mock("next/navigation", () => ({ useRouter: () => router }));

vi.mock("@/app/admin/events/format-actions", () => actions);

const { default: FormatTab } = await import("../FormatTab");

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

const TEAMS = Array.from({ length: 4 }, (_unused, index) => ({
  id: `team-${index + 1}`,
  name: `Team ${index + 1}`,
  seed: index + 1,
}));

/** A round robin for four wants six matches; every sentence below leans on it. */
function stageView(
  over: Partial<StageView> = {},
  kind: StageKind = "round_robin",
  config: Partial<StageConfig> = {}
): StageView {
  const spec = generateStage(
    kind,
    TEAMS.length,
    normaliseStageConfig(kind, { bestOf: 1, ...config })
  );
  return {
    id: "stage-1",
    name: "Round robin",
    kind,
    sort: 0,
    config: spec.config,
    teamCount: TEAMS.length,
    spec,
    matches: resolveMatches({ stage: spec, matches: [], teams: TEAMS, seeds: null }),
    standings: [],
    groups: [],
    placements: [],
    champion: null,
    seeding: null,
    seeds: TEAMS.map((team) => team.id),
    handEditedAt: null,
    outOfDateSince: null,
    ...over,
  };
}

function formatView(stage: StageView, teams: FormatView["teams"] = TEAMS): FormatView {
  const blocks = planBlocks([stage.spec], {
    timing: DEFAULT_FORMAT_TIMING,
    concurrentLobbies: 2,
    days: 1,
    blockDays: null,
  });
  return {
    eventId: "event-1",
    teams,
    stages: [stage],
    blocks,
    dayMinutes: dayMinutes(blocks),
    timing: DEFAULT_FORMAT_TIMING,
    concurrentLobbies: 2,
    days: 1,
  };
}

type Screen = {
  /** The tab's markup as it stands now — rendered again on every read. */
  html: () => string;
  /** The props of the button with this label, or null when it is not on the screen. */
  button: (label: string) => Record<string, unknown> | null;
  press: (label: string) => Promise<void>;
  /** Type into the stage's Name field, which is the smallest edit that dirties the tab. */
  rename: (name: string) => void;
  /** Press Save, as the bar over the page does, and let whatever can settle, settle. */
  save: () => Promise<void>;
};

/**
 * One tab, kept across renders. `matchIds` defaults to **no rows at all**: every
 * test here is about a stage that has none, and a fixture that quietly had six
 * would hide the button for a reason the test did not name.
 */
function open(
  stage: StageView,
  { teams = TEAMS, matchIds = {} }: { teams?: FormatView["teams"]; matchIds?: Record<string, string> } = {}
): Screen {
  const view = formatView(stage, teams);
  const html = () => {
    hooks.at = 0;
    seen.length = 0;
    return renderToStaticMarkup(
      createElement(FormatTab, {
        eventId: "event-1",
        format: view,
        matchIds,
        maxStages: 4,
        shape: eventShapeFrom({}),
        accepted: 24,
        capacity: null,
      })
    );
  };
  const button = (label: string) => {
    html();
    return seen.find((entry) => entry.kind === "Button" && entry.props.children === label)?.props ?? null;
  };
  return {
    html,
    button,
    press: async (label) => {
      const props = button(label);
      if (!props) throw new Error(`No “${label}” button on the screen.`);
      (props.onClick as () => void)();
      // The handler is async and the button does not hand its promise back, so
      // wait for the queue it sits in to drain — a turn of the task queue is
      // after every microtask the handler can have chained.
      await new Promise((done) => setTimeout(done, 0));
    },
    rename: (name) => {
      html();
      const field = seen.find((entry) => entry.kind === "Field" && entry.props.label === "Name");
      if (!field) throw new Error("No Name field on the screen.");
      (field.props.onChange as (input: { target: { value: string } }) => void)({
        target: { value: name },
      });
    },
    save: async () => {
      html();
      const row = seen.find((entry) => entry.kind === "SaveRow");
      if (!row) throw new Error("No save row on the screen.");
      (row.props.onSave as () => void)();
      await new Promise((done) => setTimeout(done, 0));
    },
  };
}

const NO_ROWS = "0 matches in the database. This shape wants 6.";
const SAVING_BUILDS = "0 matches in the database. This shape wants 6, and saving builds them.";
const GENERATE = "Generate matches";

beforeEach(() => {
  hooks.held.clear();
  actions.generateStageAction.mockReset();
  actions.saveStagesAction.mockReset();
  router.refresh.mockReset();
});

/* ------------------------------------------------------------------ */
/* UC-18 9b — the state that needed an action                         */
/* ------------------------------------------------------------------ */

describe("a saved stage with real teams and no stored matches (UC-18 9b)", () => {
  it("offers “Generate matches”, and stops naming a save that is not on the screen", () => {
    const screen = open(stageView());

    expect(screen.html()).toContain(NO_ROWS);
    expect(screen.html()).not.toContain("saving builds them");
    expect(screen.button(GENERATE)).not.toBeNull();
    expect(screen.button(GENERATE)?.disabled).toBe(false);
  });

  it("is a full-height tap target, whatever the compact size beside it does", () => {
    // `size="sm"` alone is well under the 44px floor; `min-h-11` is 2.75rem.
    const screen = open(stageView());

    expect(screen.button(GENERATE)?.className).toBe("min-h-11");
  });

  it("is still offered after a save that went through — nothing is unsaved any more", async () => {
    const stage = stageView();
    actions.saveStagesAction.mockResolvedValue({
      ok: true,
      data: {
        stages: [{ id: stage.id, name: "Finals", kind: stage.kind, config: stage.config }],
        sync: null,
      },
    });
    const screen = open(stage);
    screen.rename("Finals");

    await screen.save();

    const after = screen.html();
    expect(after).toContain("Saved");
    expect(after).toContain(NO_ROWS);
    expect(after).not.toContain("saving builds them");
    expect(screen.button(GENERATE)).not.toBeNull();
  });

  it("generates nothing by being rendered — only by being pressed, and then for that stage", async () => {
    actions.generateStageAction.mockResolvedValue({ ok: true, data: { created: 6, view: null } });
    const screen = open(stageView({ id: "stage-finals" }));

    screen.html();
    expect(actions.generateStageAction).not.toHaveBeenCalled();

    await screen.press(GENERATE);
    expect(actions.generateStageAction).toHaveBeenCalledTimes(1);
    expect(actions.generateStageAction).toHaveBeenCalledWith("stage-finals");
  });

  it("refreshes the route after a successful generate, and says what was built", async () => {
    actions.generateStageAction.mockResolvedValue({ ok: true, data: { created: 6, view: null } });
    const screen = open(stageView());

    await screen.press(GENERATE);

    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(screen.html()).toContain("6 matches generated");
    expect(screen.html()).not.toContain('role="alert"');
  });
});

describe("an edit typed while a generate is in flight", () => {
  it("is still unsaved when the generate lands — the save bar is not taken down over it", async () => {
    let land: (result: unknown) => void = () => {};
    actions.generateStageAction.mockReturnValue(
      new Promise((resolve) => {
        land = resolve;
      })
    );
    const screen = open(stageView());

    await screen.press(GENERATE);
    // The button is busy, the fields are not.
    screen.rename("Finals");
    land({ ok: true, data: { created: 6, view: null } });
    await new Promise((done) => setTimeout(done, 0));

    const after = screen.html();
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // Still dirty: the line names the save, and the generate's own note — which
    // only a "saved" tab shows — gives way to the edit.
    expect(after).toContain(SAVING_BUILDS);
    expect(after).not.toContain("matches generated");
    expect(screen.button(GENERATE)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* A failed generate                                                  */
/* ------------------------------------------------------------------ */

describe("a generate that fails", () => {
  it("says the server's own reason, refreshes nothing, and leaves the line and the button as they were", async () => {
    actions.generateStageAction.mockResolvedValue({
      ok: false,
      error: "This stage has results. Rebuild it instead.",
    });
    const screen = open(stageView());
    const before = screen.html();

    await screen.press(GENERATE);

    const after = screen.html();
    expect(after).toContain('role="alert"');
    expect(after).toContain("This stage has results. Rebuild it instead.");
    expect(router.refresh).not.toHaveBeenCalled();
    expect(after).not.toContain("matches generated");
    // The line is the one that was there, and the button can be pressed again.
    expect(before).toContain(NO_ROWS);
    expect(after).toContain(NO_ROWS);
    expect(screen.button(GENERATE)?.disabled).toBe(false);
  });

  it("says so when the server cannot be reached at all", async () => {
    actions.generateStageAction.mockRejectedValue(new Error("fetch failed"));
    const screen = open(stageView());

    await screen.press(GENERATE);

    const after = screen.html();
    expect(after).toContain('role="alert"');
    expect(after).toContain("Could not reach the server. Nothing was generated.");
    expect(router.refresh).not.toHaveBeenCalled();
    expect(after).toContain(NO_ROWS);
    expect(screen.button(GENERATE)?.disabled).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The neighbouring states, none of which may have the button         */
/* ------------------------------------------------------------------ */

describe("where “Generate matches” is not offered", () => {
  /*
   * Every fixture below is the offering one with exactly one thing changed, and
   * every one still has **no rows** — so the button is absent because of the
   * state the test names and not because there was nothing to generate.
   */

  it("not while the stage is out of date — “Rebuild anyway” stays the only button", () => {
    const screen = open(stageView({ outOfDateSince: "2026-06-20T18:00:00Z" }));

    expect(screen.html()).toContain("Out of date since");
    expect(screen.button("Rebuild anyway")).not.toBeNull();
    expect(screen.button(GENERATE)).toBeNull();
  });

  it("not on placeholder teams, and the placeholder sentence is unchanged", () => {
    const screen = open(stageView(), { teams: [] });

    expect(screen.html()).toContain(
      "Nothing written yet — these are placeholder teams. The matches are built once the real teams exist."
    );
    expect(screen.button(GENERATE)).toBeNull();
  });

  it("not while the tab is dirty, where saving really does build them", () => {
    const screen = open(stageView());
    expect(screen.button(GENERATE)).not.toBeNull();

    screen.rename("Finals");

    expect(screen.html()).toContain(SAVING_BUILDS);
    expect(screen.button(GENERATE)).toBeNull();
  });

  it("not while a save is in flight — the edits are still only in this browser", async () => {
    // Never settles: the tab is held in the middle of its save.
    actions.saveStagesAction.mockReturnValue(new Promise(() => {}));
    const screen = open(stageView());
    screen.rename("Finals");

    await screen.save();

    expect(actions.saveStagesAction).toHaveBeenCalledTimes(1);
    expect(screen.html()).toContain(SAVING_BUILDS);
    expect(screen.button(GENERATE)).toBeNull();
  });

  it("not after a save that failed — the edits are still unsaved, and saving still builds them", async () => {
    actions.saveStagesAction.mockRejectedValue(new Error("fetch failed"));
    const screen = open(stageView());
    screen.rename("Finals");

    await screen.save();

    const after = screen.html();
    expect(after).toContain("Could not reach the server. Nothing was saved.");
    expect(after).toContain("Not saved");
    expect(after).toContain(SAVING_BUILDS);
    expect(screen.button(GENERATE)).toBeNull();
  });

  it("not where some rows exist — it is offered only where there is nothing to clear", () => {
    const stage = stageView();
    const some = Object.fromEntries(
      stage.matches.slice(0, 3).map((match) => [match.slot, `row-${match.slot}`])
    );
    const screen = open(stage, { matchIds: some });

    expect(screen.html()).toContain("3 matches in the database. This shape wants 6");
    expect(screen.button(GENERATE)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* UC-18 9c — a team count the shape cannot take                      */
/* ------------------------------------------------------------------ */

describe("a real team count the stage's shape cannot take (UC-18 9c)", () => {
  // Three groups need six teams — two a group — and this event has four.
  const REFUSAL =
    "Groups then a playoff with 3 groups needs between 6 and 8 teams. This event has 4.";
  const threeGroups = () => stageView({}, "group_playoff", { groups: 3 });

  it("prints the range refusal instead of a promise, and offers no button", () => {
    const screen = open(threeGroups());

    expect(screen.html()).toContain(REFUSAL);
    expect(screen.html()).not.toContain("saving builds them");
    expect(screen.button(GENERATE)).toBeNull();
  });

  it("does not promise the save either once the tab is dirty — the sync would refuse it", () => {
    const screen = open(threeGroups());

    screen.rename("Groups");

    expect(screen.html()).toContain(REFUSAL);
    expect(screen.html()).not.toContain("saving builds them");
    expect(screen.button(GENERATE)).toBeNull();
  });

  it("says nothing of the kind about a shape the same four teams do fit", () => {
    // The control: same teams, same absence of rows, a kind whose range holds four.
    const screen = open(stageView());

    expect(screen.html()).not.toContain("needs between");
    expect(screen.button(GENERATE)).not.toBeNull();
  });
});

/*
 * ## What this file does not prove
 *
 *  - **That a browser click reaches the handler.** The `onClick` is called
 *    directly. That the real `<button>` forwards a click to it is `Button`'s
 *    business and React's, and neither is exercised here.
 *  - **That the count on the screen changes after a generate.** The stored
 *    count is a server prop. What is proven is that `router.refresh()` is called
 *    — the same call the rebuild path makes — and nothing here runs the server
 *    render that call asks for. That is a browser's to walk.
 *  - **That React re-renders.** State is carried between renders by the wrapper
 *    above, not by a live root, so a bug that only exists in React's own
 *    scheduling could not show up here.
 */
