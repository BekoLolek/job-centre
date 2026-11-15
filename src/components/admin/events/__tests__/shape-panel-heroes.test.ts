import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Database, type EventConfig, events, games, heroHands, heroes as heroesTable } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";
import type { SaveRowProps } from "../SaveRow";

/*
 * Task 143 — the hero toggle and its number on Setup → Format
 * (R-269, R-270 / UC-58 2, 4, 5a, 6).
 *
 * Three layers, because each one alone has a hole the others cover:
 *
 *  - **the panel**, rendered from props: what it offers and what it says. Every
 *    on/off comparison is made across {@link ON} and {@link OFF}, two configs
 *    that differ in the toggle and nothing else — the same width, the same
 *    sizing — so a difference in the markup can only be the toggle's.
 *  - **the action**, against a real database: what a save stores, what it
 *    refuses, and that turning the draw off is never one of the refusals.
 *  - **the page**, which builds the editor: that a toggle saved through the
 *    action takes Hands off the rail. A panel-only test would pass while the
 *    tab stayed.
 *
 * The suite is vitest's `node` environment and nothing here clicks. The one
 * link no test can walk — the panel handing its two answers to the action — is
 * held by a source sweep at the bottom and said plainly to be that.
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

// A spy around the real component: `disabled` and `reason` are what the panel
// decides about the save, and there is no button in the markup to read them off.
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
const { Stepper } = await import("@/components/ui");
const { default: EventEditor } = await import("../EventEditor");
const { default: AdminEventPage } = await import("@/app/admin/events/[id]/page");
const { saveEventShapeAction } = await import("@/app/admin/events/actions");
const { applyToEvent, createEvent, publishEvent, updateEvent } = await import("@/lib/events");
const { MAX_HEROES_PER_ROLE, eventShapeFrom, heroWidthProblem, teamFormatFrom } = await import(
  "@/lib/events-policy"
);
const { dealFor } = await import("@/lib/hero-hands");
const { HERO_ROLES } = await import("@/lib/heroes");

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

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function refusal<T>(result: { ok: true; data: T } | { ok: false; error: string }): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

/* --------------------------------------------------------------------- */
/* The one fixture pair                                                  */
/* --------------------------------------------------------------------- */

const SIZING = { mode: "perTeam", value: 6 } as const;

/** Six a side, drafting, four heroes a role — and the draw `heroes` says. */
const drawing = (heroes: boolean, heroesPerRole = 4): EventConfig => ({
  eventShape: { teamEvent: true, draft: true, sizing: { ...SIZING }, heroes, heroesPerRole },
});

const ON = drawing(true);
const OFF = drawing(false);

/** The words only the number box carries. */
const NUMBER_BOX = 'aria-label="Heroes each player draws in each role"';
const TOO_WIDE = `A player draws between 1 and ${MAX_HEROES_PER_ROLE} heroes in each role.`;
const NOT_WHOLE = "How many heroes a player draws in each role has to be a whole number.";

function panel(config: EventConfig, over: Partial<Parameters<typeof ShapeTab>[0]> = {}) {
  state.saveRows.length = 0;
  const markup = renderToStaticMarkup(
    createElement(ShapeTab, {
      eventId: "event-1",
      shape: eventShapeFrom(config),
      heroList: { game: "Marvel Rivals", heroes: true },
      accepted: 18,
      existingTeams: 0,
      draftStarted: false,
      teamFormat: teamFormatFrom(config),
      rosters: [],
      ...over,
    })
  );
  expect(state.saveRows, "the panel renders one save row").toHaveLength(1);
  return { markup, saveRow: state.saveRows[0] };
}

/** The first element of this host type in a tree nobody has rendered. */
function findByType(node: ReactNode, type: string): ReactElement | null {
  if (Array.isArray(node)) {
    return node.map((child) => findByType(child as ReactNode, type)).find(Boolean) ?? null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  return findByType((node.props as { children?: ReactNode }).children, type);
}

/** Whether the toggle's chip with this label is the lit one. */
function lit(markup: string, label: string): boolean {
  return new RegExp(`aria-pressed="true"[^>]*>${label}<`).test(markup);
}

describe("the fixture pair", () => {
  it("differs in the toggle and in nothing else", () => {
    const { heroes: on, ...restOn } = eventShapeFrom(ON);
    const { heroes: off, ...restOff } = eventShapeFrom(OFF);

    expect(on).toBe(true);
    expect(off).toBe(false);
    expect(restOn).toEqual(restOff);
  });
});

/* --------------------------------------------------------------------- */
/* The panel (UC-58 2, 4, 6)                                             */
/* --------------------------------------------------------------------- */

describe("the hero toggle on the Format panel", () => {
  it("asks the question whichever way it is answered", () => {
    expect(panel(ON).markup).toContain("Does it draw random heroes?");
    expect(panel(OFF).markup).toContain("Does it draw random heroes?");
  });

  it("lights the stored answer", () => {
    const on = panel(ON).markup;
    const off = panel(OFF).markup;

    expect(lit(on, "Random heroes")).toBe(true);
    expect(lit(on, "No heroes")).toBe(false);
    expect(lit(off, "No heroes")).toBe(true);
    expect(lit(off, "Random heroes")).toBe(false);
  });

  it("offers the number only when the toggle is on", () => {
    expect(panel(ON).markup).toContain(NUMBER_BOX);
    expect(panel(OFF).markup).not.toContain(NUMBER_BOX);
  });

  it("opens the number on the stored width", () => {
    expect(panel(ON).markup).toMatch(new RegExp(`${NUMBER_BOX}[^>]*value="4"`));
    expect(panel(drawing(true, 2)).markup).toMatch(new RegExp(`${NUMBER_BOX}[^>]*value="2"`));
  });

  it("still asks on a solo event — a solo night deals hands too", () => {
    const solo: EventConfig = {
      eventShape: { teamEvent: false, draft: false, sizing: { ...SIZING }, heroes: true, heroesPerRole: 4 },
    };
    const { markup } = panel(solo);

    expect(markup).not.toContain("How are the teams sized?");
    expect(markup).toContain("Does it draw random heroes?");
    expect(markup).toContain(NUMBER_BOX);
  });
});

describe("what the panel says the next draw will deal", () => {
  it("names the width when the toggle is on", () => {
    const { markup } = panel(ON);

    expect(markup).toContain("4 per role");
    expect(markup).toContain("The next draw deals each player 4 heroes in every role.");
  });

  it("follows the width", () => {
    const { markup } = panel(drawing(true, 1));

    expect(markup).toContain("1 per role");
    expect(markup).toContain("The next draw deals each player 1 hero in every role.");
    expect(markup).not.toContain("4 heroes in every role");
  });

  it("says something else when the toggle is off, and not the width", () => {
    const { markup } = panel(OFF);

    expect(markup).toContain("The next draw deals nobody a hand");
    expect(markup).not.toContain("The next draw deals each player");
    expect(markup).not.toContain("4 per role");
  });

  it("does not say the off sentence when the toggle is on", () => {
    expect(panel(ON).markup).not.toContain("The next draw deals nobody a hand");
  });

  it("says what turning it off takes away", () => {
    const { markup } = panel(OFF);

    expect(markup).toContain("Hands goes from the rail");
    expect(markup).toContain("the draw page closes");
  });
});

describe("a width outside the bound, on the panel", () => {
  it("is a bound of one to ten", () => {
    // The floor of the rows below: a bound nobody pinned is a bound a slip can move.
    expect(MAX_HEROES_PER_ROLE).toBe(10);
  });

  it("is refused before the round trip, in the action's own sentence", () => {
    const { markup, saveRow } = panel(drawing(true, MAX_HEROES_PER_ROLE + 1));

    expect(markup).toContain(`role="status">${TOO_WIDE}`);
    expect(saveRow.disabled).toBe(true);
    expect(saveRow.reason).toBe(TOO_WIDE);
  });

  it("is not refused at the top of the bound", () => {
    const { markup, saveRow } = panel(drawing(true, MAX_HEROES_PER_ROLE));

    expect(markup).not.toContain('role="status"');
    expect(saveRow.disabled).toBe(false);
  });

  it("is not capped at the bound by the box — a typed slip stands, to be refused", () => {
    // `Stepper` clamps what is typed to the `max` it is given. Handed the
    // bound, a typed 33 would be saved as 10 with nothing said.
    const { markup } = panel(ON);

    expect(markup).toMatch(new RegExp(`${NUMBER_BOX}[^>]*min="1"`));
    expect(markup).not.toMatch(new RegExp(`${NUMBER_BOX}[^>]*max="${MAX_HEROES_PER_ROLE}"`));
  });

  it("is what a typed 33 reaches, through the box as the panel configures it", () => {
    // `Stepper` holds no state, so it can be called for its tree and its
    // input typed into — the one keystroke this suite can make. The props are
    // the panel's (a floor of one, no ceiling); that they *are* the panel's is
    // what the test above holds.
    const typed: (number | null)[] = [];
    const tree = Stepper({ value: 3, min: 1, onChange: (next) => typed.push(next) });
    const input = findByType(tree, "input");

    (input!.props as { onChange: (event: { target: { value: string } }) => void }).onChange({
      target: { value: "33" },
    });

    expect(typed).toEqual([33]);
    expect(heroWidthProblem({ ...eventShapeFrom(ON), heroesPerRole: typed[0]! })).toBe(TOO_WIDE);
  });

  it("is refused on a solo event as well", () => {
    const solo: EventConfig = {
      eventShape: {
        teamEvent: false,
        draft: false,
        sizing: { ...SIZING },
        heroes: true,
        heroesPerRole: MAX_HEROES_PER_ROLE + 1,
      },
    };
    const { markup, saveRow } = panel(solo);

    expect(markup).toContain(`role="status">${TOO_WIDE}`);
    expect(saveRow.disabled).toBe(true);
  });

  it("is never held against a panel with the toggle off", () => {
    // The number is not on screen to be corrected, so a refusal about it
    // would be one the manager could not answer.
    const { markup, saveRow } = panel(drawing(false, MAX_HEROES_PER_ROLE + 1));

    expect(markup).not.toContain('role="status"');
    expect(saveRow.disabled).toBe(false);
  });

  it("does not print a deal it is refusing", () => {
    const { markup } = panel(drawing(true, MAX_HEROES_PER_ROLE + 1));

    expect(markup).not.toContain("The next draw deals each player");
  });

  it("leaves the stated-format note standing, saying it is not the reason", () => {
    // Task 110's note (UC-49 1d): 3v3 stated, six a side allowed.
    const { markup } = panel({ ...drawing(true, MAX_HEROES_PER_ROLE + 1), teamFormat: "3v3" });

    expect(markup).toContain("The Teams tab states");
    expect(markup).toContain("and it is not what is stopping this save.");
  });

  it("leaves the note saying the save goes through when the width is fine", () => {
    const { markup, saveRow } = panel({ ...ON, teamFormat: "3v3" });

    expect(markup).toContain("The Teams tab states");
    expect(markup).toContain("so this saves as it is.");
    expect(saveRow.disabled).toBe(false);
  });
});

describe("heroWidthProblem", () => {
  const shape = (heroes: boolean, heroesPerRole: number) => ({
    ...eventShapeFrom({}),
    heroes,
    heroesPerRole,
  });

  it.each([[1], [3], [MAX_HEROES_PER_ROLE]])("allows %i", (width) => {
    expect(heroWidthProblem(shape(true, width))).toBeNull();
  });

  it.each([[0], [-1], [MAX_HEROES_PER_ROLE + 1], [33]])("refuses %i", (width) => {
    expect(heroWidthProblem(shape(true, width))).toBe(TOO_WIDE);
  });

  it.each([[2.5], [Number.NaN]])("refuses %d as not a whole number", (width) => {
    expect(heroWidthProblem(shape(true, width))).toBe(NOT_WHOLE);
  });

  it.each([[0], [33], [Number.NaN]])("holds %d against nothing while the draw is off", (width) => {
    expect(heroWidthProblem(shape(false, width))).toBeNull();
  });
});

/* --------------------------------------------------------------------- */
/* The action (UC-58 2, 4, 5a, 6)                                        */
/* --------------------------------------------------------------------- */

/** A game with `perRole` heroes in each role. */
async function makeGame(perRole: number): Promise<string> {
  counter += 1;
  const [game] = await db
    .insert(games)
    .values({ key: `width-game-${counter}`, name: `Width game ${counter}` })
    .returning({ id: games.id });
  await db.insert(heroesTable).values(
    HERO_ROLES.flatMap((role) =>
      Array.from({ length: perRole }, (_unused, index) => ({
        gameId: game.id,
        name: `${role} ${index + 1} of ${counter}`,
        roles: [role],
      }))
    )
  );
  return game.id;
}

/** A published event on `gameId` with `accepted` accepted applicants, and its host signed in. */
async function hostedEvent(accepted: number, gameId: string | null = null) {
  counter += 1;
  const event = unwrap(
    await createEvent({ ...PUBLISHABLE, title: `Width ${counter}`, capacity: 64, gameId }, db)
  );
  unwrap(await publishEvent(event.id, db));
  const members: string[] = [];
  for (let index = 0; index < accepted; index += 1) {
    const userId = await makeUser(db, { displayName: `Drawer ${counter}-${index}` });
    unwrap(await applyToEvent(event.id, userId, {}, db));
    members.push(userId);
  }
  const host = await makeUser(db, { displayName: `Host ${counter}` });
  await makeHost(db, event.id, host);
  state.userId = host;
  return { eventId: event.id, host, members };
}

async function storedShape(eventId: string) {
  const [row] = await db.select({ config: events.config }).from(events).where(eq(events.id, eventId));
  return eventShapeFrom(row.config);
}

async function handCount(eventId: string): Promise<number> {
  const rows = await db.select({ id: heroHands.id }).from(heroHands).where(eq(heroHands.eventId, eventId));
  return rows.length;
}

const TEAMS = { teamEvent: true, draft: true, mode: "perTeam", value: 6 } as const;

describe("saving the hero answers", () => {
  it("stores the toggle turned off", async () => {
    const { eventId } = await hostedEvent(12);

    const saved = unwrap(await saveEventShapeAction(eventId, { ...TEAMS, heroes: false, heroesPerRole: 3 }));

    expect(saved.shape.heroes).toBe(false);
    expect((await storedShape(eventId)).heroes).toBe(false);
  });

  it("stores the toggle turned back on", async () => {
    const { eventId } = await hostedEvent(12);
    unwrap(await updateEvent(eventId, { config: OFF }, db));

    unwrap(await saveEventShapeAction(eventId, { ...TEAMS, heroes: true, heroesPerRole: 4 }));

    expect((await storedShape(eventId)).heroes).toBe(true);
  });

  it("stores the number", async () => {
    const { eventId } = await hostedEvent(12);

    const saved = unwrap(await saveEventShapeAction(eventId, { ...TEAMS, heroes: true, heroesPerRole: 5 }));

    expect(saved.shape.heroesPerRole).toBe(5);
    expect((await storedShape(eventId)).heroesPerRole).toBe(5);
  });

  it("keeps the stored number when the toggle goes off, whatever the form sent", async () => {
    // The number is not on screen while the toggle is off, so the form's
    // figure is nobody's answer — and turning the draw back on has to restore
    // the night that was described (`EventShape`'s docblock).
    const { eventId } = await hostedEvent(12);
    unwrap(await updateEvent(eventId, { config: ON }, db));

    unwrap(await saveEventShapeAction(eventId, { ...TEAMS, heroes: false, heroesPerRole: 9 }));

    expect(await storedShape(eventId)).toMatchObject({ heroes: false, heroesPerRole: 4 });
  });

  it("stores the three other answers that travelled with them", async () => {
    // Sent as something an untouched event does not already hold — no draft,
    // three teams — so "stored" cannot be mistaken for "left at the default".
    const { eventId } = await hostedEvent(12);
    expect(await storedShape(eventId)).toMatchObject({ draft: true, sizing: { mode: "perTeam", value: 6 } });

    unwrap(
      await saveEventShapeAction(eventId, {
        teamEvent: true,
        draft: false,
        mode: "teams",
        value: 3,
        heroes: false,
        heroesPerRole: 5,
      })
    );

    expect(await storedShape(eventId)).toMatchObject({
      teamEvent: true,
      draft: false,
      sizing: { mode: "teams", value: 3 },
    });
  });

  it("saves a width the game cannot deal — the draw refuses that, not the save (UC-58 5a)", async () => {
    const { eventId } = await hostedEvent(12, await makeGame(3));

    unwrap(await saveEventShapeAction(eventId, { ...TEAMS, heroes: true, heroesPerRole: 5 }));

    expect((await storedShape(eventId)).heroesPerRole).toBe(5);
  });

  it.each([[MAX_HEROES_PER_ROLE + 1], [0]])("refuses a width of %i and stores nothing", async (width) => {
    const { eventId } = await hostedEvent(12);
    unwrap(await updateEvent(eventId, { config: ON }, db));

    const said = refusal(
      await saveEventShapeAction(eventId, { ...TEAMS, value: 4, heroes: true, heroesPerRole: width })
    );

    expect(said).toBe(TOO_WIDE);
    // Neither the width nor the sizing that travelled with it.
    expect(await storedShape(eventId)).toEqual(eventShapeFrom(ON));
  });

  it("refuses a width that is not a whole number", async () => {
    const { eventId } = await hostedEvent(12);

    expect(
      refusal(await saveEventShapeAction(eventId, { ...TEAMS, heroes: true, heroesPerRole: 2.5 }))
    ).toBe(NOT_WHOLE);
  });
});

describe("turning the draw off", () => {
  it("is not refused with hands already dealt, and deletes none of them", async () => {
    const { eventId, members } = await hostedEvent(4, await makeGame(4));
    for (const member of members) {
      expect((await dealFor(eventId, member, Math.random, db)).ok).toBe(true);
    }
    expect(await handCount(eventId)).toBe(4);

    const saved = await saveEventShapeAction(eventId, { ...TEAMS, value: 2, heroes: false, heroesPerRole: 3 });

    expect(saved.ok).toBe(true);
    expect((await storedShape(eventId)).heroes).toBe(false);
    expect(await handCount(eventId)).toBe(4);
  });

  it("is not refused for a number outside the bound", async () => {
    const { eventId } = await hostedEvent(12);

    const saved = await saveEventShapeAction(eventId, {
      ...TEAMS,
      heroes: false,
      heroesPerRole: MAX_HEROES_PER_ROLE + 1,
    });

    expect(saved.ok).toBe(true);
    expect((await storedShape(eventId)).heroes).toBe(false);
  });

  it("is not refused when the width already stored is outside the bound, hands and all", async () => {
    // The state that would strand a manager: an illegal width is what the
    // event *holds*, the draw is on, hands are dealt — and the number is not
    // on the panel to be corrected once the toggle is off. Thirty-three a role
    // from a list of thirty-three, so the hands are real ones.
    const { eventId, members } = await hostedEvent(4, await makeGame(33));
    unwrap(await updateEvent(eventId, { config: drawing(true, 33) }, db));
    for (const member of members) {
      expect((await dealFor(eventId, member, Math.random, db)).ok).toBe(true);
    }
    expect(await handCount(eventId)).toBe(4);

    const saved = await saveEventShapeAction(eventId, { ...TEAMS, value: 2, heroes: false, heroesPerRole: 33 });

    expect(saved.ok).toBe(true);
    expect(await storedShape(eventId)).toMatchObject({ heroes: false, heroesPerRole: 33 });
    expect(await handCount(eventId)).toBe(4);
  });
});

/* --------------------------------------------------------------------- */
/* Through the editor (UC-58 3a)                                         */
/* --------------------------------------------------------------------- */

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

/** `/admin/events/[id]` as the page itself builds it — no prop is handed to the editor here. */
async function screen(eventId: string, host: string, tab?: string) {
  state.userId = host;
  const tree = await AdminEventPage({
    params: Promise.resolve({ id: eventId }),
    searchParams: Promise.resolve(tab === undefined ? {} : { tab }),
  });
  const editor = findElement(tree, EventEditor);
  expect(editor, "the page no longer renders the event editor").not.toBeNull();
  return renderToStaticMarkup(editor!);
}

/** Every item on the editor's rail, in draw order. */
function rail(markup: string): string[] {
  return [...markup.matchAll(/role="tab"[^>]*>\s*<span>([^<]+)<\/span>/g)].map((hit) => hit[1]);
}

describe("the editor, after the toggle is saved", () => {
  it("loses Hands and nothing else when the toggle is saved off", async () => {
    // One event, saved both ways through the action, read through the page:
    // the only thing that moves between the two rails is the toggle.
    const { eventId, host } = await hostedEvent(4, await makeGame(4));

    unwrap(await saveEventShapeAction(eventId, { ...TEAMS, value: 2, heroes: true, heroesPerRole: 4 }));
    const on = rail(await screen(eventId, host));

    unwrap(await saveEventShapeAction(eventId, { ...TEAMS, value: 2, heroes: false, heroesPerRole: 4 }));
    const off = rail(await screen(eventId, host));

    expect(on).toContain("Hands");
    expect(off).not.toContain("Hands");
    expect(off).toEqual(on.filter((label) => label !== "Hands"));
  });

  it("brings Hands back when the toggle is saved on again", async () => {
    const { eventId, host } = await hostedEvent(4, await makeGame(4));
    unwrap(await saveEventShapeAction(eventId, { ...TEAMS, value: 2, heroes: false, heroesPerRole: 4 }));
    expect(rail(await screen(eventId, host))).not.toContain("Hands");

    unwrap(await saveEventShapeAction(eventId, { ...TEAMS, value: 2, heroes: true, heroesPerRole: 4 }));

    expect(rail(await screen(eventId, host))).toContain("Hands");
  });

  it("opens the panel the page built on the answers that were saved", async () => {
    const { eventId, host } = await hostedEvent(4, await makeGame(4));
    unwrap(await saveEventShapeAction(eventId, { ...TEAMS, value: 2, heroes: true, heroesPerRole: 5 }));

    const on = await screen(eventId, host, "shape");
    expect(lit(on, "Random heroes")).toBe(true);
    expect(on).toMatch(new RegExp(`${NUMBER_BOX}[^>]*value="5"`));

    unwrap(await saveEventShapeAction(eventId, { ...TEAMS, value: 2, heroes: false, heroesPerRole: 5 }));

    const off = await screen(eventId, host, "shape");
    expect(lit(off, "No heroes")).toBe(true);
    expect(off).not.toContain(NUMBER_BOX);
  });
});

/* --------------------------------------------------------------------- */
/* The one link nothing here can click                                   */
/* --------------------------------------------------------------------- */

describe("the panel's save call", () => {
  /*
   * A source sweep, and the weakest test in the file: there is no DOM in this
   * suite, so the save cannot be pressed. It holds only that the call names
   * both answers — a panel that drew the controls and sent neither would pass
   * everything above, because the action carries an absent answer through
   * from what is stored.
   */
  const source = readFileSync(path.resolve(__dirname, "../ShapeTab.tsx"), "utf8");
  const call = /saveEventShapeAction\(eventId, \{([\s\S]*?)\}\);/.exec(source)?.[1] ?? "";

  it("is found", () => {
    expect(call).toContain("teamEvent");
  });

  it("sends the toggle as it stands on the panel", () => {
    expect(call).toMatch(/^\s*heroes,$/m);
  });

  it("sends the number as it stands on the panel", () => {
    expect(call).toMatch(/^\s*heroesPerRole: edited\.heroesPerRole,$/m);
  });
});
