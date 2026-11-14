import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateStage } from "@/lib/bracket";
import type { EventParticipants } from "@/lib/championship-results";
import type { EventChampionship } from "@/lib/championships";
import type { FormatView, StageView } from "@/lib/format";
import { DEFAULT_FORMAT_TIMING, normaliseStageConfig } from "@/lib/format-policy";
import { dayMinutes, planBlocks } from "@/lib/format-schedule";
import { resolveMatches } from "@/lib/format-resolve";

/*
 * An edit typed while a tab's own write is in flight — R-260, Task 136.
 *
 * No tab disables its fields while it saves. So a keystroke during the round
 * trip marks the tab dirty, and a handler that answers success with a flat
 * `"saved"` takes the unsaved bar down over an edit the request never carried.
 *
 * These are the four handlers that **adopt nothing** when they land — they do
 * not write the server's answer back into the fields — so holding `"dirty"` is
 * the whole fix: the edit is still on the screen and the bar is still up. The
 * handlers that do adopt are not here, because for them holding `"dirty"` over
 * a field the adoption has just reverted would be a different lie.
 *
 * Every tab gets the same pair: a **control** (nothing typed meanwhile, the
 * write lands, the tab says so) and the **race**. The control is what makes the
 * race's `"dirty"` mean something — a handler that never said "saved" at all
 * would pass the race alone.
 *
 * The harness is `format-tab-generate.test.ts`'s, for its reasons: the suite
 * has no DOM, so the UI components and `SaveRow` are wrapped to record the
 * props the tab handed them, and `useState` remembers what its setter was told
 * so the next render of the same tab reads it. What that does not prove is at
 * the bottom of that file and holds here unchanged.
 */

const actions = vi.hoisted(() => ({
  addEventToChampionshipAction: vi.fn(),
  removeEventFromChampionshipAction: vi.fn(),
  saveEntryRulesAction: vi.fn(),
  saveEventChampionshipAction: vi.fn(),
  saveEventPlacementsAction: vi.fn(),
}));
const formatActions = vi.hoisted(() => ({
  applyScheduleAction: vi.fn(),
  saveScheduleSettingsAction: vi.fn(),
}));
const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: () => {}, push: () => {} }));

type Seen = {
  kind: "Button" | "ChoiceChip" | "Field" | "SaveRow";
  props: Record<string, unknown>;
};
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
    ChoiceChip: watched("ChoiceChip", actual.ChoiceChip),
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
vi.mock("@/app/admin/events/actions", () => actions);
vi.mock("@/app/admin/events/format-actions", () => formatActions);

const { default: ChampionshipTab } = await import("../ChampionshipTab");
const { default: EntryRulesTab } = await import("../EntryRulesTab");
const { default: PlacementEditor } = await import("../PlacementEditor");
const { default: ScheduleTab } = await import("../ScheduleTab");

/* ------------------------------------------------------------------ */
/* The harness                                                        */
/* ------------------------------------------------------------------ */

type Screen = {
  /** The tab's markup as it stands now — rendered again on every read. */
  html: () => string;
  /** The state the tab hands its save row — `"dirty"` is what holds the unsaved bar up. */
  saveState: () => unknown;
  /** Press Save, as the bar over the page does. */
  save: () => Promise<void>;
  /** Type into the field with this label, or this `aria-label`. */
  type: (label: string, value: string) => void;
  /** Press the `nth` thing of this kind with this label. */
  press: (kind: "Button" | "ChoiceChip", label: string, nth?: number) => Promise<void>;
};

/** A turn of the task queue: after every microtask an async handler can have chained. */
const settle = () => new Promise((done) => setTimeout(done, 0));

function open(element: () => ReturnType<typeof createElement>): Screen {
  const html = () => {
    hooks.at = 0;
    seen.length = 0;
    return renderToStaticMarkup(element());
  };
  const saveRow = () => {
    html();
    const row = seen.find((entry) => entry.kind === "SaveRow");
    if (!row) throw new Error("No save row on the screen.");
    return row.props;
  };
  return {
    html,
    saveState: () => saveRow().state,
    save: async () => {
      (saveRow().onSave as () => void)();
      await settle();
    },
    type: (label, value) => {
      html();
      const field = seen.find(
        (entry) =>
          entry.kind === "Field" &&
          (entry.props.label === label || entry.props["aria-label"] === label)
      );
      if (!field) throw new Error(`No “${label}” field on the screen.`);
      (field.props.onChange as (input: { target: { value: string } }) => void)({
        target: { value },
      });
    },
    press: async (kind, label, nth = 0) => {
      html();
      const found = seen.filter(
        (entry) => entry.kind === kind && entry.props.children === label
      )[nth];
      if (!found) throw new Error(`No “${label}” ${kind} number ${nth} on the screen.`);
      (found.props.onClick as () => void)();
      await settle();
    },
  };
}

/** A write that stays in flight until the test lands it. */
function held(action: ReturnType<typeof vi.fn>): (result: unknown) => Promise<void> {
  let resolve: (result: unknown) => void = () => {};
  action.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    })
  );
  return async (result) => {
    resolve(result);
    await settle();
  };
}

beforeEach(() => {
  hooks.held.clear();
  for (const action of [...Object.values(actions), ...Object.values(formatActions)]) {
    action.mockReset();
  }
  router.refresh.mockReset();
});

/* ------------------------------------------------------------------ */
/* Entry rules                                                        */
/* ------------------------------------------------------------------ */

describe("EntryRulesTab — an edit made while its save is in flight", () => {
  const entryRules = () =>
    open(() =>
      createElement(EntryRulesTab, {
        event: {
          id: "event-1",
          game: { name: "Rivals" },
          rankLadder: ["Bronze", "Silver", "Gold"],
          minRankToEnter: "Silver",
          minRankToCaptain: "Gold",
        } as unknown as Parameters<typeof EntryRulesTab>[0]["event"],
      })
    );
  // Two thresholds, each with its own “No minimum”: entry first, captain second.
  const NO_MINIMUM = "No minimum";

  it("the control: with nothing changed meanwhile, a save that lands says so", async () => {
    actions.saveEntryRulesAction.mockResolvedValue({ ok: true });
    const screen = entryRules();
    await screen.press("ChoiceChip", NO_MINIMUM, 0);

    await screen.save();

    expect(screen.saveState()).toBe("saved");
    expect(screen.html()).toContain("Saved");
  });

  it("is still unsaved when the save lands — the bar is not taken down over it", async () => {
    const land = held(actions.saveEntryRulesAction);
    const screen = entryRules();
    await screen.press("ChoiceChip", NO_MINIMUM, 0);

    await screen.save();
    await screen.press("ChoiceChip", NO_MINIMUM, 1);
    await land({ ok: true });

    // What was sent is the tab as it stood when Save was pressed …
    expect(actions.saveEntryRulesAction).toHaveBeenCalledWith("event-1", {
      minRankToEnter: null,
      minRankToCaptain: "Gold",
    });
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // … so the captain threshold cleared since is on the screen and nowhere else.
    expect(screen.saveState()).toBe("dirty");
    expect(screen.html()).not.toContain("Gold or above");
  });
});

/* ------------------------------------------------------------------ */
/* Championship — what the event is worth                             */
/* ------------------------------------------------------------------ */

const COUNTING: EventChampionship = {
  id: "counting-1",
  eventId: "event-1",
  title: "Rivals night",
  weight: 1,
  pointsTable: null,
  season: {
    id: "season-1",
    name: "Autumn season",
    status: "published",
    pointsTable: [25, 18, 15],
    participationPoints: 1,
    countBest: null,
  },
};

describe("ChampionshipTab — an edit typed while its save is in flight", () => {
  // No result, so the only save row on the screen is the weight's own.
  const championship = () =>
    open(() =>
      createElement(ChampionshipTab, {
        eventId: "event-1",
        data: { counting: COUNTING, seasons: [], result: null },
      })
    );

  it("the control: with nothing typed meanwhile, a save that lands says so", async () => {
    actions.saveEventChampionshipAction.mockResolvedValue({ ok: true });
    const screen = championship();
    screen.type("Weight", "2");

    await screen.save();

    expect(screen.saveState()).toBe("saved");
    expect(screen.html()).toContain("Saved");
  });

  it("is still unsaved when the save lands — the bar is not taken down over it", async () => {
    const land = held(actions.saveEventChampionshipAction);
    const screen = championship();
    screen.type("Weight", "2");

    await screen.save();
    screen.type("Weight", "3");
    await land({ ok: true });

    expect(actions.saveEventChampionshipAction).toHaveBeenCalledWith("event-1", {
      weight: 2,
      pointsTable: null,
    });
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // The server has 2 and the box says 3.
    expect(screen.saveState()).toBe("dirty");
    expect(screen.html()).toContain('value="3"');
  });
});

/* ------------------------------------------------------------------ */
/* The finishing order                                                */
/* ------------------------------------------------------------------ */

const SOLO: EventParticipants = {
  teamed: false,
  rows: [
    { id: "ana", name: "Ana", members: [{ userId: "ana", name: "Ana" }] },
    { id: "ben", name: "Ben", members: [{ userId: "ben", name: "Ben" }] },
  ],
};

describe("PlacementEditor — a place typed while its save is in flight", () => {
  const editor = () =>
    open(() =>
      createElement(PlacementEditor, {
        eventId: "event-1",
        counting: COUNTING,
        participants: SOLO,
        placements: [],
      })
    );

  it("the control: with nothing typed meanwhile, a save that lands says so", async () => {
    actions.saveEventPlacementsAction.mockResolvedValue({ ok: true });
    const screen = editor();
    screen.type("Ana's place", "1");

    await screen.save();

    expect(screen.saveState()).toBe("saved");
    expect(screen.html()).toContain("Standings updated");
  });

  it("is still unsaved when the save lands — the bar is not taken down over it", async () => {
    const land = held(actions.saveEventPlacementsAction);
    const screen = editor();
    screen.type("Ana's place", "1");

    await screen.save();
    screen.type("Ben's place", "2");
    await land({ ok: true });

    const after = screen.html();
    // Ben's place was typed after the request left, so it is not in it.
    expect(actions.saveEventPlacementsAction).toHaveBeenCalledWith("event-1", [
      { id: "ana", position: 1 },
    ]);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(screen.saveState()).toBe("dirty");
    expect(after).toContain('value="2"');
    expect(after).not.toContain("Standings updated");
  });
});

/* ------------------------------------------------------------------ */
/* Schedule — “Fill start times”                                      */
/* ------------------------------------------------------------------ */

const TEAMS = Array.from({ length: 4 }, (_unused, index) => ({
  id: `team-${index + 1}`,
  name: `Team ${index + 1}`,
  seed: index + 1,
}));
const SPEC = generateStage(
  "round_robin",
  TEAMS.length,
  normaliseStageConfig("round_robin", { bestOf: 1 })
);
const SETTINGS = {
  timing: DEFAULT_FORMAT_TIMING,
  concurrentLobbies: 2,
  days: 1,
  blockDays: null,
};

function scheduleView(): FormatView {
  const stage: StageView = {
    id: "stage-1",
    name: "Table",
    kind: "round_robin",
    sort: 0,
    config: SPEC.config,
    teamCount: TEAMS.length,
    spec: SPEC,
    matches: resolveMatches({ stage: SPEC, matches: [], teams: TEAMS, seeds: null }),
    standings: [],
    groups: [],
    placements: [],
    champion: null,
    seeding: null,
    seeds: TEAMS.map((team) => team.id),
    handEditedAt: null,
    outOfDateSince: null,
  };
  const blocks = planBlocks([SPEC], SETTINGS);
  return {
    eventId: "event-1",
    teams: TEAMS,
    stages: [stage],
    blocks,
    dayMinutes: dayMinutes(blocks),
    timing: DEFAULT_FORMAT_TIMING,
    concurrentLobbies: SETTINGS.concurrentLobbies,
    days: SETTINGS.days,
  };
}

describe("ScheduleTab — an edit typed while “Fill start times” is in flight", () => {
  const FILL = "Fill start times";
  const schedule = () => {
    const format = scheduleView();
    return open(() =>
      createElement(ScheduleTab, {
        eventId: "event-1",
        // One day with a start, so there is something for the fill to fill from.
        event: {
          days: [{ startsAt: "2026-06-20T16:00:00.000Z", label: "Day 1" }],
        } as unknown as Parameters<typeof ScheduleTab>[0]["event"],
        format,
        matchIds: Object.fromEntries(
          format.stages.flatMap((stage) => stage.matches.map((m) => [m.slot, `row-${m.slot}`]))
        ),
        settings: SETTINGS,
      })
    );
  };

  it("the control: with nothing typed meanwhile, a fill that lands says what it filled", async () => {
    formatActions.applyScheduleAction.mockResolvedValue({ ok: true, data: { scheduled: 6 } });
    const screen = schedule();

    await screen.press("Button", FILL);

    expect(screen.saveState()).toBe("saved");
    expect(screen.html()).toContain("6 matches given a start time");
  });

  it("is still unsaved when the fill lands — the bar is not taken down over it", async () => {
    const land = held(formatActions.applyScheduleAction);
    const screen = schedule();

    await screen.press("Button", FILL);
    // The button is busy, the fields are not.
    screen.type("Between games", "47");
    await land({ ok: true, data: { scheduled: 6 } });

    const after = screen.html();
    // Filling also saves the settings — the ones on the screen when it was pressed.
    expect(formatActions.applyScheduleAction).toHaveBeenCalledTimes(1);
    expect(formatActions.applyScheduleAction.mock.calls[0][2]).toMatchObject({
      timing: { betweenGames: DEFAULT_FORMAT_TIMING.betweenGames },
    });
    expect(router.refresh).toHaveBeenCalledTimes(1);
    // Still dirty, with the edit in its box. The fill's own note — which only
    // a "saved" tab shows — gives way to it.
    expect(screen.saveState()).toBe("dirty");
    expect(after).toContain('value="47"');
    expect(after).not.toContain("given a start time");
  });
});
