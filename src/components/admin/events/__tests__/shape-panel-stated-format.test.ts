import { isValidElement, type ReactElement, type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, type EventConfig } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";
import type { SaveRowProps } from "../SaveRow";

/*
 * Task 110 — R-251 / UC-49 1d, and the half of Task 107 (R-249 / UC-49 1c)
 * that could not be done without the panel.
 *
 * Two things that look alike and are opposites, held in one file so the
 * difference is what the file is about:
 *
 * **A stated format that disagrees with the sizing is a note.** It is on the
 * panel, and the panel is not blocked by it — R-215 is "stated, never
 * enforced".
 *
 * **A sizing below a roster the draft awarded is a refusal**, and the panel
 * prints the action's own sentence before the round trip, which is `ShapeTab`'s
 * standard for every refusal it has.
 *
 * ## How "not blocked" is observed with nothing to click
 *
 * The suite is Node with no DOM, and the save button lives on the
 * unsaved-changes bar, which only draws once something is dirty. What the panel
 * *does* decide is the `disabled` and `reason` it hands `SaveRow` — that pair
 * is the block, and the bar only repeats it. So `SaveRow` is wrapped, not
 * replaced: the real one still renders, and the props the panel handed it are
 * kept. Without that, a note that also quietly disabled the save would pass
 * every markup assertion here.
 *
 * ## Half of it renders the page
 *
 * For `shape-panel.test.ts`'s reason: the figures this needs — the stated
 * format, each team's roster — are handed down by the editor, and a test that
 * hands the panel its own props cannot see the editor forget to.
 */

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
  saveRows: [] as SaveRowProps[],
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  const db = new Proxy({} as Database, {
    get(_target, property) {
      const real = state.db as unknown as Record<string | symbol, unknown>;
      const value = Reflect.get(real, property, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
  return { ...actual, db };
});

vi.mock("@/lib/auth", () => ({
  SIGN_IN_PATH: "/signin",
  auth: async () => (state.userId ? { user: { id: state.userId } } : null),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: () => {} }));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

// A spy around the real component — see the note at the top of the file.
vi.mock("../SaveRow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../SaveRow")>();
  const react = await import("react");
  return {
    ...actual,
    default: (props: SaveRowProps) => {
      state.saveRows.push(props);
      return react.createElement(actual.default, props);
    },
  };
});

const { default: ShapeTab } = await import("../ShapeTab");
const { default: EventEditor } = await import("../EventEditor");
const { default: AdminEventPage } = await import("@/app/admin/events/[id]/page");
const { saveEventShapeAction } = await import("@/app/admin/events/actions");
const { saveNightFormatAction, setTeamCountAction } = await import(
  "@/app/admin/events/draft-actions"
);
const { applyToEvent, createEvent, getEventById, publishEvent, updateEvent } = await import(
  "@/lib/events"
);
const { eventShapeFrom, rosterBelowAwardedRefusal, teamFormatFrom } = await import(
  "@/lib/events-policy"
);
const { awardLot, getTeams, openLot, placeBid, setDraftPool } = await import("@/lib/draft");

let handle: TestDatabase;
let db: Database;
let counter = 0;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  state.saveRows.length = 0;
});

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/** The words only the note says. */
const NOTE = "The Teams tab states";

const THREES = teamFormatFrom({ teamFormat: "3v3" });
const SIXES = teamFormatFrom({ teamFormat: "6v6" });

const sized = (mode: "teams" | "perTeam", value: number): EventConfig => ({
  eventShape: { teamEvent: true, draft: true, sizing: { mode, value } },
});

/** The panel, and what it handed `SaveRow`. Six a side unless a test says. */
function panel(over: Partial<Parameters<typeof ShapeTab>[0]> & { config?: EventConfig } = {}) {
  const { config, ...rest } = over;
  state.saveRows.length = 0;
  const markup = renderToStaticMarkup(
    createElement(ShapeTab, {
      eventId: "event-1",
      shape: eventShapeFrom(config ?? {}),
      heroList: { game: null },
      accepted: 18,
      existingTeams: 0,
      draftStarted: false,
      teamFormat: SIXES,
      rosters: [],
      ...rest,
    })
  );
  expect(state.saveRows.length, "the panel renders one save row").toBe(1);
  return { markup, saveRow: state.saveRows[0] };
}

/* --------------------------------------------------------------------- */
/* The note (R-251 / UC-49 1d)                                           */
/* --------------------------------------------------------------------- */

describe("a stated format that disagrees with the sizing", () => {
  it("is said in a note on a 3v3 event sized at six a side", () => {
    // The pair with the next test: the stated format is the only difference.
    const { markup } = panel({ teamFormat: THREES });

    expect(markup).toContain(
      "The Teams tab states a 3v3 night — 3 a side — and the sizing here allows 6. That is a note, not a refusal: the format is stated, never enforced, so this saves as it is."
    );
  });

  it("is not said when the stated format agrees", () => {
    const { markup } = panel({ teamFormat: SIXES });

    expect(markup).not.toContain(NOTE);
  });

  it("reads the figure a count of teams implies, not the count itself", () => {
    // Three teams from eighteen is six a side, so 3v3 disagrees — though the
    // number in the box is a 3.
    const { markup } = panel({ teamFormat: THREES, config: sized("teams", 3) });

    expect(markup).toContain("3v3 night — 3 a side — and the sizing here allows 6.");
  });

  it("says nothing where the sizing derives no figure to disagree with", () => {
    // UC-49 1b: a count of teams with nobody accepted has no places yet.
    const { markup } = panel({ teamFormat: THREES, config: sized("teams", 3), accepted: 0 });

    expect(markup).not.toContain(NOTE);
  });

  it("says nothing beside a figure the bounds refuse", () => {
    // "1o" is not a size, and a note measuring the format against it would be
    // a sentence about nothing. The bound is what the panel says there.
    const { markup, saveRow } = panel({ teamFormat: THREES, config: sized("perTeam", 99) });

    expect(saveRow.disabled).toBe(true);
    expect(markup).not.toContain(NOTE);
  });

  it("does not block the save: no refusal is printed and the save row is open", () => {
    const { markup, saveRow } = panel({ teamFormat: THREES });

    expect(markup).toContain(NOTE);
    expect(markup).not.toContain('role="status"');
    expect(saveRow.disabled).toBe(false);
    expect(saveRow.reason).toBeNull();
  });

  it("stays on screen beside a refusal, and does not promise the save the refusal blocks", () => {
    // A 6v6 night sized at two a side, below rosters the draft awarded: the
    // disagreement is still true, and something else is stopping the save.
    const { markup, saveRow } = panel({
      accepted: 6,
      existingTeams: 2,
      rosters: [
        { name: "Team 1", size: 3 },
        { name: "Team 2", size: 3 },
      ],
      draftStarted: true,
      teamFormat: SIXES,
      config: sized("perTeam", 2),
    });

    expect(saveRow.disabled).toBe(true);
    expect(markup).toContain(
      "The Teams tab states a 6v6 night — 6 a side — and the sizing here allows 2. That is a note, not a refusal: the format is stated, never enforced, and it is not what is stopping this save."
    );
    expect(markup).not.toContain("so this saves as it is");
  });

  it("is saved by the action as it stands, the format still stated", async () => {
    const { eventId } = await hostedEvent(12);
    unwrap(await saveNightFormatAction(eventId, "3v3"));

    const saved = unwrap(
      await saveEventShapeAction(eventId, {
        teamEvent: true,
        draft: true,
        mode: "perTeam",
        value: 6,
      })
    );

    expect(saved.shape.sizing).toEqual({ mode: "perTeam", value: 6 });
    const stored = (await getEventById(eventId, {}, db))?.config;
    expect(eventShapeFrom(stored).sizing).toEqual({ mode: "perTeam", value: 6 });
    expect(teamFormatFrom(stored).format).toBe("3v3");
  });
});

/* --------------------------------------------------------------------- */
/* The refusal, before the round trip (R-249 / UC-49 1c)                 */
/* --------------------------------------------------------------------- */

const ROSTERS = [
  { name: "Team 1", size: 3 },
  { name: "Team 2", size: 3 },
];

/** Six accepted and two rosters of three: `event-shape.test.ts`'s `filledDraft`. */
const FILLED = { accepted: 6, existingTeams: 2, rosters: ROSTERS } as const;

describe("sizing the teams below a roster the draft awarded", () => {
  it("is refused on the panel in the action's own sentence, and blocks the save", () => {
    const { markup, saveRow } = panel({
      ...FILLED,
      draftStarted: true,
      config: sized("perTeam", 2),
    });

    const sentence = rosterBelowAwardedRefusal(ROSTERS, 2, true);
    expect(sentence).not.toBeNull();
    expect(markup).toContain(sentence);
    expect(saveRow.disabled).toBe(true);
    expect(saveRow.reason).toBe(sentence);
  });

  it("is not refused when no lot has been awarded (UC-49 3a)", () => {
    // The pair with the test above: `draftStarted` is the only difference.
    const { markup, saveRow } = panel({
      ...FILLED,
      draftStarted: false,
      config: sized("perTeam", 2),
    });

    expect(markup).not.toContain("holds 3 players");
    expect(saveRow.disabled).toBe(false);
  });

  it("is not refused when the figure leaves room for every roster", () => {
    // The other pair: the figure is the only difference.
    const { markup, saveRow } = panel({
      ...FILLED,
      draftStarted: true,
      config: sized("perTeam", 3),
    });

    expect(markup).not.toContain("holds 3 players");
    expect(saveRow.disabled).toBe(false);
  });

  it("measures against the figure a count of teams implies", () => {
    // Three teams from six accepted is two a side, below rosters of three.
    const { saveRow } = panel({ ...FILLED, draftStarted: true, config: sized("teams", 3) });

    expect(saveRow.reason).toBe(rosterBelowAwardedRefusal(ROSTERS, 2, true));
  });

  it("gives way to the bounds, as the action does", () => {
    // Nine teams from eighteen is two a side, below rosters of three — and
    // nine is more teams than an event has. The action checks the bounds
    // first, so that is the sentence, not one about a figure nobody may save.
    const { markup, saveRow } = panel({
      ...FILLED,
      accepted: 18,
      draftStarted: true,
      config: sized("teams", 9),
    });

    expect(saveRow.reason).toBe("An event has between 2 and 8 teams.");
    expect(markup).not.toContain("holds 3 players");
  });
});

/* --------------------------------------------------------------------- */
/* The editor hands the panel what both need                             */
/* --------------------------------------------------------------------- */

async function hostedEvent(accepted: number, config?: EventConfig) {
  counter += 1;
  const event = unwrap(
    await createEvent({ ...PUBLISHABLE, title: `Stated ${counter}`, capacity: 64 }, db)
  );
  unwrap(await publishEvent(event.id, db));

  const members: string[] = [];
  for (let index = 0; index < accepted; index += 1) {
    const userId = await makeUser(db, { displayName: `Stated ${counter}-${index}` });
    unwrap(await applyToEvent(event.id, userId, {}, db));
    members.push(userId);
  }

  if (config) unwrap(await updateEvent(event.id, { config }, db));

  const host = await makeUser(db, { displayName: `Host ${counter}` });
  await makeHost(db, event.id, host);
  state.userId = host;
  return { eventId: event.id, host, members };
}

function findElement(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child as ReactNode, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  const props = node.props as { children?: ReactNode };
  return findElement(props.children, type);
}

/** `/admin/events/[id]?tab=shape` as the page builds it — `shape-panel.test.ts`'s `screen`. */
async function formatPanel(eventId: string, host: string) {
  state.userId = host;
  const tree = await AdminEventPage({
    params: Promise.resolve({ id: eventId }),
    searchParams: Promise.resolve({ tab: "shape" }),
  });
  const editor = findElement(tree, EventEditor);
  expect(editor, "the page no longer renders the event editor").not.toBeNull();
  state.saveRows.length = 0;
  return renderToStaticMarkup(editor!);
}

describe("the Format panel the page builds", () => {
  it("carries the note for an event stored as 3v3 and sized at six a side", async () => {
    // The pair with the next test: the stored format is the only difference.
    // The sizing is stored too, because an event with none reads its default
    // off the format and so agrees with it.
    const { eventId, host } = await hostedEvent(12, {
      ...sized("perTeam", 6),
      teamFormat: "3v3",
    });

    expect(await formatPanel(eventId, host)).toContain(
      "The Teams tab states a 3v3 night — 3 a side — and the sizing here allows 6."
    );
  });

  it("carries none for the same event stored as 6v6", async () => {
    const { eventId, host } = await hostedEvent(12, {
      ...sized("perTeam", 6),
      teamFormat: "6v6",
    });

    const markup = await formatPanel(eventId, host);

    expect(markup).toContain("How are the teams sized?");
    expect(markup).not.toContain(NOTE);
  });

  it("prints the refusal from the rosters and the awards the page read", async () => {
    /*
     * `filledDraft` from `event-shape.test.ts`: six accepted, three a side, two
     * teams, three players awarded to each. The stored figure is then put
     * below them through the library, which has no refusal of its own — the
     * state the action exists to prevent, and the only way to have the panel
     * *arrive* on it with nothing to click.
     */
    const { eventId, host, members } = await hostedEvent(6);
    unwrap(
      await saveEventShapeAction(eventId, {
        teamEvent: true,
        draft: true,
        mode: "perTeam",
        value: 3,
      })
    );
    unwrap(await setTeamCountAction(eventId, 2));
    const built = await getTeams(eventId, db);
    unwrap(await setDraftPool(eventId, {}, db));
    for (const [index, userId] of members.entries()) {
      const team = built[index < 3 ? 0 : 1];
      const lot = unwrap(await openLot(eventId, { userId }, db));
      unwrap(await placeBid(lot.id, team.id, 10, {}, db));
      unwrap(await awardLot(lot.id, team.id, {}, db));
    }
    unwrap(await updateEvent(eventId, { config: sized("perTeam", 2) }, db));

    const markup = await formatPanel(eventId, host);

    expect(markup).toContain(
      rosterBelowAwardedRefusal(
        [
          { name: built[0].name, size: 3 },
          { name: built[1].name, size: 3 },
        ],
        2,
        true
      )
    );
  });
});
