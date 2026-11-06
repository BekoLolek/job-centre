import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type Database,
  type HeroRole,
  events as eventsTable,
  games,
  heroHands,
  heroes as heroesTable,
  users,
} from "@/db";
import { type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";
import type { PlayerWithHands } from "@/lib/hero-hands";
import type { HeroTally, PlayerHandsData, PlayerNight } from "../PlayerHands";

/*
 * Task 103 on the screen — R-244 to R-247 / UC-48 1-5b.
 *
 * Two halves, as `hands-tab.test.ts`. The first renders the panel from props
 * and asserts over the markup: the picker with its counts, a hand as nine
 * names under three role headings naming its night, the tally in the order it
 * arrived with "nights" said properly, and — UC-48 5b — nothing to click but
 * the player links. The second renders the *page* against a real Postgres,
 * because every decision this screen makes is the page's: who is listed (only
 * members who hold a hand), whose hands are shown (the one `?player=` names
 * and nobody else), what an id naming nobody gets (a sentence, not another
 * player's hands), and who is turned away (anybody short of an admin, a host
 * included).
 *
 * The suite is vitest's `node` environment: nothing here clicks. What is
 * asserted is the state that arrives, and the two reads behind it are held
 * directly in `hero-hands.test.ts` (which hands, which players) and
 * `hand-history.test.ts` (how many nights).
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
 * UC-48 1a needs to know whether anything was *read*, not only whether the
 * page threw: the guard is what keeps a host out, and the proof is that it
 * runs before either read does. So the two real reads are wrapped in one
 * counter and otherwise untouched — every other test in this file reads
 * through them.
 */
const heroHandsReads = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/lib/hero-hands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hero-hands")>();
  return {
    ...actual,
    handsOfPlayer: (...args: Parameters<typeof actual.handsOfPlayer>) => {
      heroHandsReads.count += 1;
      return actual.handsOfPlayer(...args);
    },
    playersWithHands: (...args: Parameters<typeof actual.playersWithHands>) => {
      heroHandsReads.count += 1;
      return actual.playersWithHands(...args);
    },
  };
});

const { default: PlayerHands } = await import("../PlayerHands");
const { default: AdminHandsPage } = await import("@/app/admin/hands/page");
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

const AMY: PlayerWithHands = { userId: "amy-id", displayName: "Amy", hands: 2 };
const BOB: PlayerWithHands = { userId: "bob-id", displayName: "Bob", hands: 1 };

/** One night: nine names, three to a role, named after the night. */
function night(label: string, dealtAt: string, over: Partial<PlayerNight> = {}): PlayerNight {
  return {
    event: { id: `${label}-id`, title: `${label} night` },
    roles: ROLES.map((role) => ({
      role,
      names: [1, 2, 3].map((n) => `${label}-${role.slice(0, 1)}${n}`),
    })),
    dealtAt,
    ...over,
  };
}

const tally = (name: string, nights: number): HeroTally => ({ name, nights });

/**
 * Capitalised names, because the sweep reads the markup as text and the
 * panel's own copy is lower-case prose: "wit" is inside "with", and a
 * fixture that can be found inside a sentence proves nothing about a row.
 */
function panel(over: Partial<PlayerHandsData> = {}): string {
  const data: PlayerHandsData = {
    players: over.players ?? [AMY, BOB],
    view: over.view ?? { kind: "pick" },
  };
  return renderToStaticMarkup(createElement(PlayerHands, { data }));
}

/** Amy, picked, with two nights and the tally those nights give. */
const AMY_PICKED: PlayerHandsData["view"] = {
  kind: "player",
  player: AMY,
  hands: [night("Later", "2026-11-02T20:15:00.000Z"), night("Earlier", "2026-10-26T20:00:00.000Z")],
  tally: [tally("Hulk", 2), tally("Groot", 1), tally("Thor", 1)],
};

/** The markup as a reader sees it: tags gone, React's escaped apostrophe put back. */
const text = (markup: string) =>
  markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

/** Every `href` in the markup, in order. */
const hrefs = (markup: string) => [...markup.matchAll(/href="([^"]*)"/g)].map((hit) => hit[1]);

/* --------------------------------------------------------------------- */
/* The panel (UC-48 2, 3, 4, 5, 4a, 4c)                                  */
/* --------------------------------------------------------------------- */

describe("the Hands panel", () => {
  it("lists every player handed to it with how many nights they have drawn on (R-246 / UC-48 2)", () => {
    const seen = text(panel());
    expect(seen).toMatch(/Amy 2 nights/);
    expect(seen).toMatch(/Bob 1 night\b/);
    expect(seen.indexOf("Amy")).toBeLessThan(seen.indexOf("Bob"));
  });

  it("links each player to their own history by id, and nowhere else (UC-48 3)", () => {
    expect(hrefs(panel())).toEqual(["/admin/hands?player=amy-id", "/admin/hands?player=bob-id"]);
  });

  it("asks for a player when none is picked, and names nobody's hands (UC-48 3a)", () => {
    const markup = panel();
    expect(text(markup)).toContain("Pick a player to see every hand they have been dealt.");
    expect(markup).not.toContain("<ol");
    expect(markup).not.toContain("Dealt ");
    expect(markup).not.toMatch(/aria-current/);
  });

  it("says when the link names nobody who has drawn, and still offers the list", () => {
    const markup = panel({ view: { kind: "unknown" } });
    expect(text(markup)).toContain("That link does not name a player who has drawn");
    expect(hrefs(markup)).toHaveLength(2);
    expect(markup).not.toContain("<ol");
  });

  it("says nobody has drawn yet rather than drawing an empty picker (UC-48 2a)", () => {
    const markup = panel({ players: [] });
    expect(text(markup)).toContain("Nobody has been dealt a hand yet.");
    expect(hrefs(markup)).toEqual([]);
    expect(text(markup)).not.toContain("Pick a player");
  });

  it("lights the picked player and nobody else", () => {
    const markup = panel({ view: AMY_PICKED });
    const lit = [...markup.matchAll(/aria-current="page"[^>]*>([^<]+)/g)].map((hit) => hit[1]);
    expect(lit).toEqual(["Amy"]);
  });

  it("shows each hand as nine names under three role headings, naming its night and when it was dealt (R-244 / UC-48 4)", () => {
    const seen = text(panel({ view: AMY_PICKED }));
    // One sequence, so a re-sort within a role, a swapped role, or a dropped
    // card all break the match.
    expect(seen).toMatch(
      /Later night Dealt .*? Vanguard Later-V1 Later-V2 Later-V3 Duelist Later-D1 Later-D2 Later-D3 Strategist Later-S1 Later-S2 Later-S3/
    );
    expect(seen).toContain(`Dealt ${formatWhen("2026-11-02T20:15:00.000Z")}`);
  });

  it("keeps the hands in the order they arrive, which is newest first", () => {
    // The order is `handsOfPlayer`'s, settled in the query; the panel's job is
    // not to disturb it. A reversed or re-sorted list fails here.
    const seen = text(panel({ view: AMY_PICKED }));
    expect(seen.indexOf("Later night")).toBeGreaterThan(-1);
    expect(seen.indexOf("Later night")).toBeLessThan(seen.indexOf("Earlier night"));
  });

  it("shows the tally in the order it arrives, saying nights and not cards (R-245 / UC-48 5)", () => {
    const seen = text(panel({ view: AMY_PICKED }));
    expect(seen).toMatch(/Hulk 2 nights .*?Groot 1 night .*?Thor 1 night\b/);
    expect(seen).not.toMatch(/\bcards?\b/);
  });

  it("shows the same hero in both slots when a hand names it twice (UC-48 4c)", () => {
    const twice = night("Twice", "2026-11-02T20:15:00.000Z", {
      roles: [
        { role: "Vanguard", names: ["Deadpool", "Thor", "Groot"] },
        { role: "Duelist", names: ["Deadpool", "Hela", "Psylocke"] },
        { role: "Strategist", names: ["Loki", "Mantis", "Luna Snow"] },
      ],
    });
    const seen = text(
      panel({ view: { ...AMY_PICKED, hands: [twice], tally: [tally("Deadpool", 1)] } })
    );
    // Both slots in the hand; the tally says one night, as it was told.
    expect(seen.match(/Deadpool/g)).toHaveLength(3);
    expect(seen).toMatch(/Deadpool 1 night\b/);
  });

  it("says nothing different for a player who has drawn once (UC-48 4a)", () => {
    const once: PlayerHandsData["view"] = {
      kind: "player",
      player: BOB,
      hands: [night("Only", "2026-11-02T20:15:00.000Z")],
      tally: [1, 2, 3].flatMap((n) => ROLES.map((role) => tally(`Only-${role.slice(0, 1)}${n}`, 1))),
    };
    const seen = text(panel({ view: once }));
    expect(seen).toMatch(/Only night Dealt/);
    expect(seen.match(/ 1 night\b/g)).toHaveLength(9 + 1);
  });

  it("marks no hero as retired — what was dealt was dealt (UC-48 4b)", () => {
    // The data carries no retirement at all, so the panel cannot: asserted on
    // the words a mark would use, the way the Hands tab's sweep is.
    expect(text(panel({ view: AMY_PICKED }))).not.toMatch(/retired/i);
  });
});

/* --------------------------------------------------------------------- */
/* Nothing to click but the player links (R-212 / UC-48 5b)              */
/* --------------------------------------------------------------------- */

describe("the Hands panel offers nothing to act on", () => {
  const states: Record<string, () => string> = {
    "nobody picked": () => panel(),
    "a player picked": () => panel({ view: AMY_PICKED }),
    "an id naming nobody": () => panel({ view: { kind: "unknown" } }),
    "nobody has drawn": () => panel({ players: [] }),
  };

  for (const [name, render] of Object.entries(states)) {
    it(`contains no form, button or input, and links only to a player, when ${name}`, () => {
      const markup = render();
      expect(markup.length).toBeGreaterThan(100);
      expect(markup).not.toMatch(/<form\b/);
      expect(markup).not.toMatch(/<button\b/);
      expect(markup).not.toMatch(/<input\b/);
      expect(markup).not.toMatch(/<select\b/);
      for (const href of hrefs(markup)) expect(href).toMatch(/^\/admin\/hands\?player=/);
    });
  }

  /**
   * Both files, because they are different sides of the boundary: the panel
   * is `"use client"` and could only reach an action through an import the
   * boundary sweep would see, but the page is a server component — the one
   * file that could import and call a server action directly, with nothing
   * else to catch it. A screen that only reads has no module to write through.
   */
  const SWEPT = {
    panel: path.resolve(__dirname, "../PlayerHands.tsx"),
    page: path.resolve(__dirname, "../../../app/admin/hands/page.tsx"),
  };

  function actionImports(file: string): string[] {
    const source = readFileSync(file, "utf8");
    const imports = [...source.matchAll(/^\s*import\s+([^;]+?)\s+from\s+["']([^"']+)["']/gm)];
    expect(imports.length, `the sweep must see ${file}'s imports`).toBeGreaterThan(0);
    return imports.map(([, , spec]) => spec).filter((spec) => /actions$/.test(spec));
  }

  it("imports no server action, in the panel or in the page", () => {
    expect(actionImports(SWEPT.panel)).toEqual([]);
    expect(actionImports(SWEPT.page)).toEqual([]);
  });

  it("is a client panel fed by a server page, as the per-event sheet is", () => {
    expect(readFileSync(SWEPT.panel, "utf8")).toMatch(/^\s*["']use client["']/);
    expect(readFileSync(SWEPT.page, "utf8")).not.toMatch(/["']use client["']/);
  });
});

/* --------------------------------------------------------------------- */
/* The page (UC-48 1, 2, 3, 2a, 3a, 1a)                                  */
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

/** A game with `perRole` heroes in each role, named so a hand's nine are known. */
async function makeGame(perRole = 3): Promise<{ id: string; stamp: number }> {
  counter += 1;
  const [game] = await db
    .insert(games)
    .values({ key: `hands-game-${counter}`, name: `Hands game ${counter}` })
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
  return { id: game.id, stamp: counter };
}

/**
 * A game whose pools are exactly three each, with one hero in two of them:
 * two single-role Vanguards and Duelists plus one hero playable as both, and
 * three Strategists. Every pool being exactly three is what makes the deal
 * certain — `drawHand` slices the first three of a shuffled pool, and a pool
 * of three has nothing to drop — so the dual hero lands in both slots of any
 * hand dealt on it.
 */
async function makeDualRoleGame(): Promise<{ id: string; dual: string }> {
  counter += 1;
  const [game] = await db
    .insert(games)
    .values({ key: `dual-game-${counter}`, name: `Dual game ${counter}` })
    .returning({ id: games.id });
  const dual = `Dual ${counter}`;
  await db.insert(heroesTable).values([
    { gameId: game.id, name: dual, roles: ["Vanguard", "Duelist"] },
    ...(["Vanguard", "Duelist"] as const).flatMap((role) =>
      [1, 2].map((n) => ({ gameId: game.id, name: `${role} ${n} of ${counter}`, roles: [role] }))
    ),
    ...[1, 2, 3].map((n) => ({
      gameId: game.id,
      name: `Strategist ${n} of ${counter}`,
      roles: ["Strategist" as const],
    })),
  ]);
  return { id: game.id, dual };
}

/** A published event on `gameId`, written straight in — nothing here applies or publishes. */
async function anEvent(gameId: string, title: string): Promise<string> {
  counter += 1;
  const [event] = await db
    .insert(eventsTable)
    .values({ slug: `hands-event-${counter}`, title, gameId, status: "published" })
    .returning({ id: eventsTable.id });
  return event.id;
}

async function anAdmin(): Promise<string> {
  const id = await makeUser(db, { displayName: `Admin ${++counter}` });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, id));
  return id;
}

/**
 * Deal `userId` a hand on `eventId`, dated `at` so dealt order is not storage
 * order. A constant generator, as every deal in this file: `makeGame`'s pools
 * are exactly three so the whole roster is dealt whatever the number, but that
 * is a fact about the fixture and not about this helper, and a fixture with
 * four per role must not turn these tests flaky.
 */
async function dealt(eventId: string, userId: string, at: string): Promise<void> {
  const result = await dealFor(eventId, userId, () => 0.5, db);
  expect(result.ok).toBe(true);
  await db
    .update(heroHands)
    .set({ dealtAt: new Date(at) })
    .where(and(eq(heroHands.eventId, eventId), eq(heroHands.userId, userId)));
}

/** The page as `userId`, rendered down to the panel and the props it was given. */
async function screen(
  userId: string,
  params: Record<string, string | string[] | undefined> = {}
): Promise<{ markup: string; data: PlayerHandsData }> {
  state.userId = userId;
  const tree = await AdminHandsPage({ searchParams: Promise.resolve(params) });
  const element = findElement(tree, PlayerHands);
  expect(element, "the page no longer renders the Hands panel").not.toBeNull();
  const data = (element!.props as { data: PlayerHandsData }).data;
  return { markup: renderToStaticMarkup(element!), data };
}

beforeEach(async () => {
  // Every hand is this test's own: the picker is derived from the hands, so
  // clearing them is what makes "nobody has drawn" true again.
  await db.delete(heroHands);
});

describe("the Hands page", () => {
  it("lists the players who have drawn with their counts, and no member who has not (UC-48 2)", async () => {
    const game = await makeGame();
    const first = await anEvent(game.id, "First night");
    const second = await anEvent(game.id, "Second night");
    const twice = await makeUser(db, { displayName: "Twice Drawn" });
    const once = await makeUser(db, { displayName: "Once Drawn" });
    const never = await makeUser(db, { displayName: "Never Drawn" });
    await dealt(first, twice, "2026-10-26T20:00:00Z");
    await dealt(second, twice, "2026-11-02T20:00:00Z");
    await dealt(first, once, "2026-10-26T20:05:00Z");

    const { markup, data } = await screen(await anAdmin());

    expect(data.players.map((player) => [player.displayName, player.hands])).toEqual([
      ["Twice Drawn", 2],
      ["Once Drawn", 1],
    ]);
    expect(text(markup)).toMatch(/Twice Drawn 2 nights/);
    expect(markup).not.toContain("Never Drawn");
    expect(markup).not.toContain(never);
  });

  it("shows the picker and asks for a player when none is named, and names nobody's hands (UC-48 3a)", async () => {
    const game = await makeGame();
    const event = await anEvent(game.id, "Alone night");
    await dealt(event, await makeUser(db, { displayName: "Solo Drawer" }), "2026-11-02T20:00:00Z");

    const { markup, data } = await screen(await anAdmin());

    expect(data.view).toEqual({ kind: "pick" });
    expect(text(markup)).toContain("Pick a player to see every hand they have been dealt.");
    expect(text(markup)).toMatch(/Solo Drawer 1 night\b/);
    expect(markup).not.toContain("Alone night");
    expect(markup).not.toContain("<ol");
  });

  it("shows the hands of the player named, newest first, each naming its event, with the tally (UC-48 3, 4, 5)", async () => {
    const game = await makeGame();
    const older = await anEvent(game.id, "October night");
    const newer = await anEvent(game.id, "November night");
    const wanted = await makeUser(db, { displayName: "Wanted Player" });
    const other = await makeUser(db, { displayName: "Other Player" });
    // Stored newest first and dated the other way round, so a page that
    // trusted storage order would put October on top.
    await dealt(newer, wanted, "2026-11-02T20:00:00Z");
    await dealt(older, wanted, "2026-10-26T20:00:00Z");
    await dealt(older, other, "2026-10-26T20:10:00Z");

    const { markup, data } = await screen(await anAdmin(), { player: wanted });

    expect(data.view.kind).toBe("player");
    if (data.view.kind !== "player") return;
    expect(data.view.player.displayName).toBe("Wanted Player");
    expect(data.view.hands.map((hand) => hand.event.title)).toEqual([
      "November night",
      "October night",
    ]);
    // Three per role from a pool of three: the whole roster is the hand, on
    // both nights, so every hero has come up on two of them.
    expect(data.view.tally.map((entry) => entry.nights)).toEqual(Array(9).fill(2));
    const seen = text(markup);
    expect(seen.indexOf("November night")).toBeLessThan(seen.indexOf("October night"));
    expect(seen).toContain(`Vanguard 1 of ${game.stamp} 2 nights`);
    expect(seen).toMatch(/Wanted Player 2 nights/);
    expect(seen).toMatch(/Other Player 1 night\b/);
    // The other player's hand is not here, in any form.
    expect(data.view.hands).toHaveLength(2);
    expect(data.view.player.userId).toBe(wanted);
    expect(data.view.player.userId).not.toBe(other);
  });

  it("shows the second player's hands when the second is named — not the first's (UC-48 3)", async () => {
    // The mutation this exists to kill: ignoring `?player=` and showing the
    // first player in the list. Two players, the list's first is not the one
    // named, and the one named has one hand on a night the first never saw.
    const game = await makeGame();
    const shared = await anEvent(game.id, "Shared night");
    const own = await anEvent(game.id, "Private night");
    const first = await makeUser(db, { displayName: "Aaron First" });
    const second = await makeUser(db, { displayName: "Zed Second" });
    await dealt(shared, first, "2026-10-26T20:00:00Z");
    await dealt(shared, second, "2026-10-26T20:01:00Z");
    await dealt(own, second, "2026-11-02T20:00:00Z");

    const { data } = await screen(await anAdmin(), { player: first });

    expect(data.players[0].displayName).toBe("Zed Second");
    expect(data.view.kind).toBe("player");
    if (data.view.kind !== "player") return;
    expect(data.view.player.userId).toBe(first);
    expect(data.view.hands.map((hand) => hand.event.title)).toEqual(["Shared night"]);
  });

  it("says so when ?player= names a member with no hands, reads no hand, and shows nobody's (UC-48 3)", async () => {
    const game = await makeGame();
    const event = await anEvent(game.id, "Busy night");
    await dealt(event, await makeUser(db, { displayName: "Has Drawn" }), "2026-11-02T20:00:00Z");
    const never = await makeUser(db, { displayName: "Has Not" });
    const before = heroHandsReads.count;

    const { markup, data } = await screen(await anAdmin(), { player: never });

    expect(data.view).toEqual({ kind: "unknown" });
    expect(text(markup)).toContain("That link does not name a player who has drawn");
    expect(text(markup)).toMatch(/Has Drawn 1 night\b/);
    expect(markup).not.toContain("Busy night");
    // One read — the list — and not a second for a history that cannot exist.
    expect(heroHandsReads.count).toBe(before + 1);
  });

  it("says so when ?player= names nobody at all", async () => {
    const game = await makeGame();
    const event = await anEvent(game.id, "Any night");
    await dealt(event, await makeUser(db, { displayName: "Someone" }), "2026-11-02T20:00:00Z");

    const { markup, data } = await screen(await anAdmin(), {
      player: "00000000-0000-0000-0000-0000000000ff",
    });

    expect(data.view).toEqual({ kind: "unknown" });
    expect(markup).not.toContain("Any night");
  });

  it("says nobody has drawn when nobody has, instead of an empty picker (UC-48 2a)", async () => {
    await makeUser(db, { displayName: "Signed Up Only" });

    const { markup, data } = await screen(await anAdmin());

    expect(data.players).toEqual([]);
    expect(text(markup)).toContain("Nobody has been dealt a hand yet.");
    expect(hrefs(markup)).toEqual([]);
    expect(markup).not.toContain("Signed Up Only");
  });

  it("counts a hero dealt in two slots of one hand as one night, not two cards (R-245 / UC-48 4c)", async () => {
    /*
     * The one rule the page could silently get wrong and nothing on screen
     * would look off: every other fixture here is single-role heroes, so a
     * page that tallied *cards* across hands prints the same numbers as one
     * that tallies nights. This hero is playable in two roles, every pool is
     * exactly three, so the whole of each pool is dealt whatever the generator
     * says — and the generator is a constant anyway, so the nine are fixed.
     * The hand names them twice; the tally must say once.
     */
    const game = await makeDualRoleGame();
    const event = await anEvent(game.id, "Double night");
    const player = await makeUser(db, { displayName: "Dual Player" });
    expect((await dealFor(event, player, () => 0.5, db)).ok).toBe(true);

    const { markup, data } = await screen(await anAdmin(), { player });

    expect(data.view.kind).toBe("player");
    if (data.view.kind !== "player") return;
    const [hand] = data.view.hands;
    const slot = (role: HeroRole) => hand.roles.find((group) => group.role === role)!.names;
    expect(slot("Vanguard")).toContain(game.dual);
    expect(slot("Duelist")).toContain(game.dual);
    expect(text(markup).match(new RegExp(game.dual, "g"))).toHaveLength(2 + 1);
    expect(data.view.tally.find((entry) => entry.name === game.dual)).toEqual({
      name: game.dual,
      nights: 1,
    });
    expect(text(markup)).toMatch(new RegExp(`${game.dual} 1 night\\b`));
    // Eight distinct heroes over nine slots, every one of them one night.
    expect(data.view.tally).toHaveLength(8);
    expect(data.view.tally.map((entry) => entry.nights)).toEqual(Array(8).fill(1));
  });

  it("hands the panel only names, roles, the event and an ISO string — no hero row crosses", async () => {
    const game = await makeGame();
    const event = await anEvent(game.id, "Crossing night");
    const player = await makeUser(db, { displayName: "Crossing Player" });
    await dealt(event, player, "2026-11-02T20:00:00Z");

    const { data } = await screen(await anAdmin(), { player });

    expect(data.view.kind).toBe("player");
    if (data.view.kind !== "player") return;
    const [hand] = data.view.hands;
    expect(Object.keys(hand).sort()).toEqual(["dealtAt", "event", "roles"]);
    expect(Object.keys(hand.event).sort()).toEqual(["id", "title"]);
    expect(hand.dealtAt).toBe("2026-11-02T20:00:00.000Z");
    expect(hand.roles.map((group) => group.role)).toEqual(HERO_ROLES);
    for (const group of hand.roles) {
      expect(Object.keys(group).sort()).toEqual(["names", "role"]);
      expect(group.names).toHaveLength(3);
      for (const name of group.names) expect(typeof name).toBe("string");
    }
    for (const entry of data.view.tally) {
      expect(Object.keys(entry).sort()).toEqual(["name", "nights"]);
    }
    const crossed = JSON.stringify(data);
    expect(crossed).not.toContain("retiredAt");
    expect(crossed).not.toContain("gameId");
    expect(crossed).not.toContain("slug");
  });
});

/* --------------------------------------------------------------------- */
/* A host is turned away (R-247 / UC-48 1a)                              */
/* --------------------------------------------------------------------- */

describe("somebody who is not an admin", () => {
  it("is sent to sign-in as admin-only by the page's own guard, before anything is read — a host included", async () => {
    /*
     * The reader is a host: signed in, managing an event somebody has drawn
     * on, with the sharpest claim anybody short of an admin has. The
     * per-event sheet admits them; this page spans every event and must not.
     * What keeps them out is `requireAdmin` — the page throws Next's redirect
     * before either read runs, which the counter around the real reads is
     * here to show — and the destination is the admin-only refusal, not the
     * `/me` that `requireEventManager` sends a stranger to. The admin's render
     * afterwards is what proves the counter is live rather than never wired.
     */
    const game = await makeGame();
    const event = await anEvent(game.id, "Hosted night");
    const player = await makeUser(db, { displayName: "Hosted Player" });
    await dealt(event, player, "2026-11-02T20:00:00Z");
    const host = await makeUser(db, { displayName: "The Host" });
    await makeHost(db, event, host);
    state.userId = host;
    const before = heroHandsReads.count;

    const attempt = AdminHandsPage({ searchParams: Promise.resolve({ player }) });

    await expect(attempt).rejects.toThrow(/NEXT_REDIRECT/);
    // The rejection, read back for its destination: Next's redirect carries
    // the path in the error's `digest`.
    const thrown = (await attempt.catch((error: unknown) => error)) as { digest?: string };
    expect(String(thrown.digest)).toContain("/signin");
    expect(String(thrown.digest)).toContain("error=admin-only");
    expect(heroHandsReads.count, "something was read before the guard refused").toBe(before);

    await screen(await anAdmin(), { player });
    expect(heroHandsReads.count, "the counter never saw the admin's reads").toBe(before + 2);
  });
});
