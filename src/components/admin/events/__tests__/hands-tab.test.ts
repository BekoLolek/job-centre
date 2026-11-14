import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Database, type HeroRole, games, heroes as heroesTable } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";
import type { DealtHand, FormerHandRow, HandsTabData, SeatHandRow } from "../types";

/*
 * Task 100 on the screen — R-239 to R-243 / UC-47 1-5a.
 *
 * Two halves, as `scoring-panel.test.ts`. The first renders the panel from
 * props and asserts over the markup: nine names under three role headings in
 * deal order, a seat that has not drawn as a row rather than an absence, a
 * hand whose holder no longer holds a seat kept and named as such, and —
 * UC-47 5a — nothing at all to click. The second renders the *page*, because
 * the failure worth catching is a tab the rail does not draw for an event
 * that has it, or draws for one that does not: the page is what reads the
 * hero list, and a panel test cannot see whether it did.
 *
 * The suite is vitest's `node` environment: nothing here clicks. What is
 * asserted is the state that arrives, and every decision behind it is held
 * directly in `hands-tabs.test.ts` (which tabs) and `hands-sheet.test.ts`
 * (which rows).
 */

const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
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

/*
 * UC-47 5b needs to know whether a hand was *read*, not only whether the page
 * threw: the guard is what keeps a non-manager out, and the proof is that it
 * runs before `handsFor` does. So the real `handsFor` is wrapped in a counter
 * and otherwise untouched — every other test in this file reads through it.
 */
const heroHands = vi.hoisted(() => ({ reads: 0 }));

vi.mock("@/lib/hero-hands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hero-hands")>();
  return {
    ...actual,
    handsFor: (...args: Parameters<typeof actual.handsFor>) => {
      heroHands.reads += 1;
      return actual.handsFor(...args);
    },
  };
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: () => {} }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

const { TAB_LABELS, tabHiddenBecause } = await import("../tabs");
const { default: HandsTab } = await import("../HandsTab");
const { default: EventEditor } = await import("../EventEditor");
const { default: AdminEventPage } = await import("@/app/admin/events/[id]/page");
const { applyToEvent, createEvent, publishEvent, withdrawApplication } = await import("@/lib/events");
const { dealFor } = await import("@/lib/hero-hands");
const { HERO_ROLES } = await import("@/lib/heroes");
const { formatWhen } = await import("@/lib/time");

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

/* --------------------------------------------------------------------- */
/* Fixtures                                                              */
/* --------------------------------------------------------------------- */

const ROLES: readonly HeroRole[] = ["Vanguard", "Duelist", "Strategist"];

/** Nine named heroes, three to a role, in the order they were dealt. */
const AMY: DealtHand = {
  roles: [
    { role: "Vanguard", names: ["Hulk", "Thor", "Groot"] },
    { role: "Duelist", names: ["Punisher", "Hela", "Psylocke"] },
    { role: "Strategist", names: ["Loki", "Mantis", "Luna Snow"] },
  ],
  dealtAt: "2026-11-01T19:00:00.000Z",
};

function dealt(holder: string, dealtAt = "2026-11-02T20:15:00.000Z"): DealtHand {
  return {
    roles: ROLES.map((role) => ({
      role,
      names: [1, 2, 3].map((n) => `${holder}-${role.slice(0, 1)}${n}`),
    })),
    dealtAt,
  };
}

const seat = (userId: string, hand: DealtHand | null = null): SeatHandRow => ({
  userId,
  name: userId,
  hand,
});

const former = (userId: string, hand: DealtHand, name: string | null = userId): FormerHandRow => ({
  userId,
  name,
  hand,
});

/*
 * Capitalised names, because the sweep reads the markup as text and the
 * panel's own copy is lower-case prose: "wit" is inside "with", and a
 * fixture that can be found inside a sentence proves nothing about a row.
 */
function panel(over: Partial<HandsTabData> = {}): string {
  const seats = over.seats ?? [seat("Amy", AMY), seat("Bob"), seat("Cal", dealt("Cal"))];
  const drawn = over.drawn ?? seats.filter((row) => row.hand !== null).length;
  // The same rule `handSheet` holds, restated so a panel test states only the
  // rows it cares about; `hands-sheet.test.ts` is where the rule is proved.
  const kind: HandsTabData["kind"] =
    seats.length === 0
      ? "no_seats"
      : drawn === 0
        ? "nobody_drawn"
        : drawn === seats.length
          ? "all_drawn"
          : "drawing";
  const data: HandsTabData = {
    kind: over.kind ?? kind,
    seats,
    former: over.former ?? [],
    drawn,
  };
  return renderToStaticMarkup(createElement(HandsTab, { data }));
}

/** The markup as a reader sees it: tags gone, React's escaped apostrophe put back. */
const text = (markup: string) =>
  markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

/* --------------------------------------------------------------------- */
/* The sheet (UC-47 2, 3, 4, 2a, 2d, 3a, 4a)                             */
/* --------------------------------------------------------------------- */

describe("the Hands panel", () => {
  it("shows a hand as nine names under three role headings, in deal order (R-241 / UC-47 2)", () => {
    const seen = text(panel());
    // One sequence, so a re-sort within a role, a swapped role, or a dropped
    // card all break the match.
    expect(seen).toMatch(
      /Vanguard Hulk Thor Groot Duelist Punisher Hela Psylocke Strategist Loki Mantis Luna Snow/
    );
  });

  it("lists the seats in the order they arrive, which is the Applicants tab's", () => {
    const seen = text(panel());
    expect(seen.indexOf("Amy")).toBeGreaterThan(-1);
    expect(seen.indexOf("Bob")).toBeGreaterThan(seen.indexOf("Amy"));
    expect(seen.indexOf("Cal")).toBeGreaterThan(seen.indexOf("Bob"));
  });

  it("gives a seat that has not drawn a row that says so, rather than leaving it out (R-240 / UC-47 3)", () => {
    // The mutation this exists to kill: dropping the not-drawn row from the
    // markup, which would read as a clean night with one fewer seat.
    const seen = text(panel());
    expect(seen).toMatch(/Bob Not drawn yet/);
    expect(seen.match(/Not drawn yet/g)).toHaveLength(1);
  });

  it("says when each hand was dealt, in the reader's own zone (R-242)", () => {
    const seen = text(panel({ seats: [seat("Amy", AMY)] }));
    expect(seen).toContain(`Dealt ${formatWhen(AMY.dealtAt)}`);
  });

  it("says how many of the seats have drawn (UC-47 4)", () => {
    expect(text(panel())).toContain("2 of 3 seats have drawn.");
  });

  it("says everyone has drawn when `handSheet` says so, and keeps a former holder's hand under it", () => {
    const seen = text(
      panel({ seats: [seat("Amy", AMY)], former: [former("Wendy", dealt("Wendy"))] })
    );
    expect(seen).toContain("Everyone has drawn.");
    expect(seen).not.toContain("seats have drawn");
    expect(seen).toContain("No longer holding a seat");
    expect(seen).toMatch(/Vanguard Wendy-V1 Wendy-V2 Wendy-V3/);
  });

  it("prints the sentence `kind` names, not one worked out from the rows", () => {
    // Handed `drawing` with every seat holding a hand: the panel prints the
    // count, because deciding "everyone has drawn" is `handSheet`'s and not
    // this file's — the fourth kind exists so that rule lives where a
    // mutation can reach it.
    const seen = text(panel({ seats: [seat("Amy", AMY)], kind: "drawing" }));
    expect(seen).toContain("1 of 1 seats have drawn.");
    expect(seen).not.toContain("Everyone has drawn.");
  });

  it("says nobody has drawn yet, and still lists every seat as waiting (UC-47 2a)", () => {
    const seen = text(panel({ seats: [seat("Amy"), seat("Bob")] }));
    expect(seen).toContain("Nobody has drawn yet.");
    expect(seen.match(/Not drawn yet/g)).toHaveLength(2);
    expect(seen).not.toContain("of 2 seats have drawn");
  });

  it("says there are no seats rather than drawing an empty sheet (UC-47 4a)", () => {
    const markup = panel({ seats: [] });
    expect(text(markup)).toContain("Nobody holds a seat yet, so there is no sheet to draw.");
    expect(text(markup)).toContain("Applicants");
    expect(markup).not.toContain("Not drawn yet");
    expect(markup).not.toContain("<ol");
  });

  it("shows the same hero in both slots when a hand names it twice (UC-47 2d)", () => {
    const twice: DealtHand = {
      ...AMY,
      roles: [
        { role: "Vanguard", names: ["Deadpool", "Thor", "Groot"] },
        { role: "Duelist", names: ["Deadpool", "Hela", "Psylocke"] },
        { role: "Strategist", names: ["Loki", "Mantis", "Luna Snow"] },
      ],
    };
    const seen = text(panel({ seats: [seat("Amy", twice)] }));
    expect(seen.match(/Deadpool/g)).toHaveLength(2);
  });

  it("keeps a hand whose holder no longer holds a seat, after the seats, named as such (R-243 / UC-47 3a)", () => {
    const seen = text(panel({ former: [former("Wendy", dealt("Wendy"))] }));
    const heading = seen.indexOf("No longer holding a seat");
    expect(heading).toBeGreaterThan(seen.indexOf("Cal"));
    expect(seen.indexOf("Wendy")).toBeGreaterThan(heading);
    expect(seen).toMatch(/Wendy Dealt .*? No seat Vanguard Wendy-V1 Wendy-V2 Wendy-V3/);
  });

  it("names a former holder with no application row honestly rather than printing an id", () => {
    const markup = panel({ former: [former("ghost-id", dealt("Ghost"), null)] });
    expect(text(markup)).toContain("A former member");
    expect(markup).not.toContain("ghost-id");
  });

  it("draws no former section when there is nobody in it", () => {
    expect(panel()).not.toContain("No longer holding a seat");
  });

  it("marks no hero as retired — what was dealt was dealt (UC-47 2b)", () => {
    // The data carries no retirement at all, so the panel cannot: asserted on
    // the words a mark would use, the way the Results sweep is.
    expect(text(panel())).not.toMatch(/retired/i);
  });
});

/* --------------------------------------------------------------------- */
/* Nothing to click (UC-47 5a)                                           */
/* --------------------------------------------------------------------- */

describe("the Hands panel offers nothing to click", () => {
  const states: Record<string, () => string> = {
    drawing: () => panel(),
    "nobody drawn": () => panel({ seats: [seat("Amy"), seat("Bob")] }),
    "all drawn": () => panel({ seats: [seat("Amy", AMY)] }),
    "no seats": () => panel({ seats: [] }),
    "former holders": () => panel({ former: [former("Wendy", dealt("Wendy"))] }),
  };

  for (const [name, render] of Object.entries(states)) {
    it(`contains no form, button or input when ${name}`, () => {
      const markup = render();
      expect(markup.length).toBeGreaterThan(100);
      expect(markup).not.toMatch(/<form\b/);
      expect(markup).not.toMatch(/<button\b/);
      expect(markup).not.toMatch(/<input\b/);
      expect(markup).not.toMatch(/<select\b/);
    });
  }

  it("imports no server action — a screen that only reads has no module to write through", () => {
    const source = readFileSync(path.resolve(__dirname, "../HandsTab.tsx"), "utf8");
    const imports = [...source.matchAll(/^\s*import\s+([^;]+?)\s+from\s+["']([^"']+)["']/gm)];
    expect(imports.length, "the sweep must see the module's imports").toBeGreaterThan(0);
    const actions = imports.map(([, , spec]) => spec).filter((spec) => /actions$/.test(spec));
    expect(actions).toEqual([]);
    expect(source).toMatch(/^\s*["']use client["']/);
  });
});

/* --------------------------------------------------------------------- */
/* The page builds the rail (UC-47 1, 1a, 1b)                            */
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

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/** A game with `perRole` heroes in each role — zero makes an empty list. */
async function makeGame(perRole: number): Promise<{ id: string; name: string }> {
  counter += 1;
  const name = `Hand game ${counter}`;
  const [game] = await db
    .insert(games)
    .values({ key: `hand-game-${counter}`, name })
    .returning({ id: games.id });
  if (perRole > 0) {
    await db.insert(heroesTable).values(
      HERO_ROLES.flatMap((role) =>
        Array.from({ length: perRole }, (_unused, index) => ({
          gameId: game.id,
          name: `${role} ${index + 1} of ${counter}`,
          roles: [role],
        }))
      )
    );
  }
  return { id: game.id, name };
}

/** A published event on `gameId` with `accepted` accepted applicants and a host reading it. */
async function hostedEvent(accepted: number, gameId: string | null) {
  counter += 1;
  const event = unwrap(
    await createEvent({ ...PUBLISHABLE, title: `Hands ${counter}`, capacity: 64, gameId }, db)
  );
  unwrap(await publishEvent(event.id, db));
  const members: string[] = [];
  for (let index = 0; index < accepted; index += 1) {
    const userId = await makeUser(db, { displayName: `Dealer ${counter}-${index}` });
    unwrap(await applyToEvent(event.id, userId, {}, db));
    members.push(userId);
  }
  const host = await makeUser(db, { displayName: `Host ${counter}` });
  await makeHost(db, event.id, host);
  return { eventId: event.id, host, members };
}

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

function selected(markup: string): string | null {
  return /aria-selected="true"[^>]*>\s*<span>([^<]+)<\/span>/.exec(markup)?.[1] ?? null;
}

/** Every item on the editor's rail, in draw order — the `role="tab"` buttons' labels. */
function rail(markup: string): string[] {
  return [...markup.matchAll(/role="tab"[^>]*>\s*<span>([^<]+)<\/span>/g)].map((hit) => hit[1]);
}

/** The count the rail prints beside one label, or null when it prints none. */
function railCount(markup: string, label: string): string | null {
  return new RegExp(`<span>${label}</span><span class="[^"]*">([^<]+)</span>`).exec(markup)?.[1] ?? null;
}

describe("the rail the page builds", () => {
  it("draws Hands for an event whose game has a hero list", async () => {
    const game = await makeGame(3);
    const { eventId, host } = await hostedEvent(2, game.id);
    const markup = await screen(eventId, host);
    expect(rail(markup)).toContain(TAB_LABELS.hands);
    expect(rail(markup).length).toBe(10);
  });

  it("does not draw Hands for an event with no game (UC-47 1a)", async () => {
    const { eventId, host } = await hostedEvent(2, null);
    const markup = await screen(eventId, host);
    expect(rail(markup)).not.toContain(TAB_LABELS.hands);
    expect(rail(markup)).toContain("Captains");
  });

  it("does not draw Hands for an event whose game has an empty hero list (UC-47 1b)", async () => {
    const game = await makeGame(0);
    const { eventId, host } = await hostedEvent(2, game.id);
    const markup = await screen(eventId, host);
    expect(rail(markup)).not.toContain(TAB_LABELS.hands);
  });

  it("lands ?tab=hands on an event with no game on Setup, and says why", async () => {
    const { eventId, host } = await hostedEvent(2, null);
    const markup = await screen(eventId, host, "hands");
    expect(selected(markup)).toBe("Setup");
    expect(markup).toContain(
      tabHiddenBecause("hands", { teamEvent: true, draft: true, heroes: true, heroList: { game: null } })
    );
    expect(markup).not.toContain("Not drawn yet");
  });

  it("lands ?tab=hands on an event whose game has no list on Setup, naming the game", async () => {
    const game = await makeGame(0);
    const { eventId, host } = await hostedEvent(2, game.id);
    const markup = await screen(eventId, host, "hands");
    expect(selected(markup)).toBe("Setup");
    // Through `text`, which puts React's escaped apostrophe back: the sentence
    // carries the game's name in the possessive.
    expect(text(markup)).toContain(
      tabHiddenBecause("hands", {
        teamEvent: true,
        draft: true,
        heroes: true,
        heroList: { game: game.name, heroes: false },
      })
    );
    expect(text(markup)).toContain(`${game.name} has no heroes yet`);
  });

  it("opens the sheet with every hand the page read, and counts the hands on the rail", async () => {
    const game = await makeGame(3);
    const { eventId, host, members } = await hostedEvent(2, game.id);
    const hand = await dealFor(eventId, members[0], Math.random, db);
    expect(hand.ok).toBe(true);

    const markup = await screen(eventId, host, "hands");
    expect(selected(markup)).toBe(TAB_LABELS.hands);
    // Three per role from a pool of three: the whole roster is the hand.
    for (const role of HERO_ROLES) {
      for (const n of [1, 2, 3]) expect(markup).toContain(`${role} ${n} of ${counter - 1}`);
    }
    expect(text(markup)).toContain("1 of 2 seats have drawn.");
    expect(text(markup)).toMatch(/Dealer \d+-1 Not drawn yet/);
    expect(railCount(markup, TAB_LABELS.hands)).toBe("1");
  });

  it("keeps the hand of somebody who withdrew after drawing, and still counts it on the rail", async () => {
    const game = await makeGame(3);
    const { eventId, host, members } = await hostedEvent(2, game.id);
    expect((await dealFor(eventId, members[0], Math.random, db)).ok).toBe(true);
    unwrap(await withdrawApplication(eventId, members[0], db));

    const markup = await screen(eventId, host, "hands");
    expect(text(markup)).toContain("No longer holding a seat");
    expect(text(markup)).toMatch(/Dealer \d+-0/);
    // The seat that is left has not drawn, and the withdrawn hand is not a seat
    // that has — `handSheet`'s rule, printed.
    expect(text(markup)).toContain("Nobody has drawn yet.");
    expect(railCount(markup, TAB_LABELS.hands)).toBe("1");
  });
});

/* --------------------------------------------------------------------- */
/* A hidden tab is not an authorisation (UC-47 5b)                       */
/* --------------------------------------------------------------------- */

describe("somebody who does not manage the event", () => {
  it("is redirected to /me by the page's guard, before any hand is read", async () => {
    /*
     * The reader is the participant whose own hand is on the sheet — a seat
     * holder, signed in, with the sharpest claim anybody short of a manager
     * has. What keeps them out is `requireEventManager`, not the rail: the
     * page throws Next's redirect before `handsFor` runs, which the counter
     * around the real read is here to show. The host's render afterwards is
     * what proves the counter is live rather than never wired.
     */
    const game = await makeGame(3);
    const { eventId, host, members } = await hostedEvent(2, game.id);
    expect((await dealFor(eventId, members[0], Math.random, db)).ok).toBe(true);
    state.userId = members[0];
    const before = heroHands.reads;

    const attempt = AdminEventPage({
      params: Promise.resolve({ id: eventId }),
      searchParams: Promise.resolve({ tab: "hands" }),
    });

    await expect(attempt).rejects.toThrow(/NEXT_REDIRECT/);
    // The rejection, read back for its destination: Next's redirect carries
    // the path in the error's `digest`.
    const thrown = (await attempt.catch((error: unknown) => error)) as { digest?: string };
    expect(String(thrown.digest)).toContain("/me");
    expect(heroHands.reads, "a hand was read before the guard refused").toBe(before);

    await screen(eventId, host, "hands");
    expect(heroHands.reads, "the counter never saw the host's read").toBe(before + 1);
  });
});
