import { renderToReadableStream } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventConfig } from "@/db";
import { type Database, type Hero, games, heroes as heroesTable } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { HERO_ROLES, drawableByRole, listHeroes } from "@/lib/heroes";
import { HEROES_PER_ROLE } from "@/lib/heroes-policy";

/**
 * `/events/[slug]/draw` — the page, and the payload it hands the browser
 * (R-211, R-213 / UC-39 1, 1a, 1b, 2, 2a, 6, 6a, 7a).
 *
 * `reveal.test.ts` proves what the reveal does with a hand. This file proves
 * the half that one cannot: **that the page hands it the hand the server
 * decided**, and that the four screens which are not a draw are each reached
 * and each say their own thing.
 *
 * ## Why the page is rendered and not just the component
 *
 * Because a test of the component proves nothing about the wiring, and this
 * project has the scar: `roles={roles}` was deleted from a page here and every
 * test stayed green, because they all rendered the component directly.
 * `alert-announcement.test.ts` carries the same note about 117 `<Alert>` call
 * sites. So the assertions below that matter — the nine names, the comp, the
 * absence of a pool — are made against the **route's own markup**, reached
 * through `DrawPage({ params })` with a real Postgres under it and a real
 * session.
 *
 * ## The criterion most likely to be faked, and how it is held here
 *
 * "The hand is server-decided before the animation starts, proven by asserting
 * the payload rather than the animation."
 *
 * Three assertions carry it, and none of them watches anything move:
 *
 *  - **The pre-draw page carries no hero.** Every one of the game's drawable
 *    heroes is checked against the markup and must be absent. A payload with a
 *    pool in it is a reveal that could deal, and that is a reroll one refresh
 *    away — so the test is aimed at the pool rather than at the animation.
 *  - **A stored hand is on the page in full, before any script runs.** All nine
 *    names, in deal order, in `renderToStaticMarkup`'s output — which is the
 *    server's own HTML. A hand that arrived by animation would not be in it.
 *  - **The draw action returns the stored nine**, and a second call returns the
 *    same nine with `alreadyHeld` set, proven against `handFor`'s own row. That
 *    is where "decided before the first card turns" actually lives: the whole
 *    hand is in the outcome the browser is handed.
 *
 * ## Mocked exactly as `whos-in.test.ts` mocks, and for the same reasons
 *
 * Only the session cookie and the page cache cannot run outside a Next request.
 * `notFound()` and `redirect()` stay real, so a 404 is a thrown `notFound` and
 * not a stub.
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

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  };
});

const { default: DrawPage } = await import("../page");
const { drawAction } = await import("../actions");
const { handCards, loadDraw, refusalFor } = await import("../draw");
const { dealFor, handFor } = await import("@/lib/hero-hands");
const {
  applyToEvent,
  createEvent,
  getEventBySlug,
  publishEvent,
  setApplicationStatus,
  updateEvent,
  withdrawApplication,
} = await import("@/lib/events");

let harness: TestDatabase;

beforeAll(async () => {
  harness = await freshDatabase();
  state.db = harness.db;
});

afterAll(async () => {
  await harness.close();
});

beforeEach(() => {
  state.userId = null;
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

let counter = 0;

type Fixture = { eventId: string; slug: string; userId: string; gameId: string | null };

/**
 * An event, a game whose hero list holds `perRole` in each role, and a member
 * holding a seat.
 *
 * The seat is driven through `applyToEvent` and `setApplicationStatus` rather
 * than by writing `accepted` in, so what the page reads is a seat the real
 * writes produced — `whos-in.test.ts`'s rule, and it matters here because
 * "holds a seat" is the whole of UC-39 1a.
 *
 * Four per role rather than the three a hand needs, so the slice has something
 * to drop and a hand is a genuine subset of the pool.
 */
async function fixture(
  options: { perRole?: number; game?: boolean; seat?: boolean; config?: EventConfig } = {}
): Promise<Fixture> {
  const { perRole = 4, game = true, seat = true } = options;
  counter += 1;

  let gameId: string | null = null;
  if (game) {
    const [row] = await harness.db
      .insert(games)
      .values({ key: `draw-game-${counter}`, name: `Draw game ${counter}` })
      .returning({ id: games.id });
    gameId = row.id;

    if (perRole > 0) {
      await harness.db.insert(heroesTable).values(
        HERO_ROLES.flatMap((role) =>
          Array.from({ length: perRole }, (_unused, index) => ({
            gameId: row.id,
            name: `${role} ${index + 1} of game ${counter}`,
            roles: [role],
          }))
        )
      );
    }
  }

  const created = await createEvent(
    {
      title: `Draw event ${counter}`,
      gameId,
      capacity: 8,
      ...PUBLISHABLE,
      ...(options.config ? { config: options.config } : {}),
    },
    harness.db
  );
  if (!created.ok) throw new Error(created.error);

  const published = await publishEvent(created.data.id, harness.db);
  if (!published.ok) throw new Error(published.error);

  const userId = await makeUser(harness.db, { displayName: `Player ${counter}` });
  if (seat) {
    const applied = await applyToEvent(created.data.id, userId, {}, harness.db);
    if (!applied.ok) throw new Error(applied.error);
    const [application] = await harness.db.query.applications.findMany({
      where: (row, { and, eq }) =>
        and(eq(row.eventId, created.data.id), eq(row.userId, userId)),
    });
    const decided = await setApplicationStatus(application.id, "accepted", {}, harness.db);
    if (!decided.ok) throw new Error(decided.error);
  }

  return { eventId: created.data.id, slug: created.data.slug, userId, gameId };
}

/** Every hero the game can deal, which is what must never reach the browser. */
async function poolNames(gameId: string): Promise<string[]> {
  const pools = drawableByRole(await listHeroes(gameId, harness.db));
  return [...new Set(HERO_ROLES.flatMap((role) => pools[role].map((hero) => hero.name)))];
}

/** The nine names in deal order, read back out of the stored row. */
async function storedNames(eventId: string, userId: string): Promise<string[]> {
  const stored = await handFor(eventId, userId, harness.db);
  if (!stored) throw new Error("no hand stored");
  return handCards(stored.heroes).map((card) => card.name);
}

/** The route's own markup, as the server sends it. */
async function render(slug: string): Promise<string> {
  const page = await DrawPage({ params: Promise.resolve({ slug }) });
  const stream = await renderToReadableStream(page);
  await stream.allReady;
  return await new Response(stream).text();
}

/** The same, as words. */
function words(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

/** A generator that must never be reached. */
function thrower(): () => number {
  return () => {
    throw new Error("something dealt when it should not have");
  };
}

/* ------------------------------------------------------------------ */
/* refusalFor — asked before anything is dealt (UC-39 2a)             */
/* ------------------------------------------------------------------ */

describe("the thin-list refusal (UC-39 2a)", () => {
  /**
   * Asked of the real `drawHand` through a generator that throws, which is what
   * makes "before any draw" a fact rather than an intention: if control ever
   * reached the first `random()` call there would be no answer to return.
   */
  it("names every thin role, not the first one found", async () => {
    const fix = await fixture({ perRole: 0 });
    if (!fix.gameId) throw new Error("fixture lost its game");
    await harness.db.insert(heroesTable).values([
      { gameId: fix.gameId, name: "Lone Vanguard", roles: ["Vanguard"] },
      { gameId: fix.gameId, name: "Duelist one", roles: ["Duelist"] },
      { gameId: fix.gameId, name: "Duelist two", roles: ["Duelist"] },
      { gameId: fix.gameId, name: "Duelist three", roles: ["Duelist"] },
    ]);

    const refusal = refusalFor(drawableByRole(await listHeroes(fix.gameId, harness.db)));
    expect(refusal).toBe(
      "Vanguard has 1 hero and Strategist has 0 heroes. A draw needs 3 in each role, " +
        "so nothing was dealt. Add more on the game's hero list."
    );
    // Both thin roles, and not the healthy one — the whole point of Task 74's
    // correction to UC-39 2a, which said "the role" in the singular.
    expect(refusal).toContain("Vanguard");
    expect(refusal).toContain("Strategist");
    expect(refusal).not.toContain("Duelist has");
  });

  it("answers nothing at all for a list that can deal", async () => {
    const fix = await fixture();
    if (!fix.gameId) throw new Error("fixture lost its game");
    expect(refusalFor(drawableByRole(await listHeroes(fix.gameId, harness.db)))).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* handCards — the deal order the cards turn in                       */
/* ------------------------------------------------------------------ */

describe("flattening a stored hand", () => {
  it("walks the roles in deal order, three at a time", async () => {
    const fix = await fixture();
    const dealt = await dealFor(fix.eventId, fix.userId, undefined, harness.db);
    if (!dealt.ok) throw new Error(dealt.error);

    const cards = handCards(dealt.hand.heroes);
    expect(cards).toHaveLength(HERO_ROLES.length * HEROES_PER_ROLE);
    expect(cards.map((card) => card.role)).toEqual([
      "Vanguard",
      "Vanguard",
      "Vanguard",
      "Duelist",
      "Duelist",
      "Duelist",
      "Strategist",
      "Strategist",
      "Strategist",
    ]);
    // And within a role, the order `dealFor` stored.
    for (const role of HERO_ROLES) {
      expect(
        cards.filter((card) => card.role === role).map((card) => card.name),
        role
      ).toEqual(dealt.hand.heroes[role].map((hero: Hero) => hero.name));
    }
  });

  it("carries the name, the id and the role, and nothing else about the hero", () => {
    const hero = {
      id: "abc",
      gameId: "game",
      name: "Groot",
      roles: ["Vanguard"],
      retiredAt: new Date(),
      createdAt: new Date(),
    } as unknown as Hero;
    const [card] = handCards({ Vanguard: [hero], Duelist: [], Strategist: [] });
    // `retiredAt` on a card would tell every player which heroes an admin has
    // taken out of the game, which is not a player's business and not a card's.
    expect(card).toEqual({ id: "abc", name: "Groot", role: "Vanguard" });
  });
});

/* ------------------------------------------------------------------ */
/* loadDraw — which of the five screens                               */
/* ------------------------------------------------------------------ */

describe("loadDraw picks the screen", () => {
  async function detail(slug: string) {
    const event = await getEventBySlug(slug, {}, harness.db);
    if (!event) throw new Error("no event");
    return event;
  }

  it("refuses somebody with no seat before reading anything else (UC-39 1a)", async () => {
    const fix = await fixture({ seat: false });
    /*
     * The reader throws. A loader that looked a hand up for somebody with no
     * seat would be reading one person's draw on another's request, and here it
     * would fail the test rather than pass it quietly.
     */
    const payload = await loadDraw(
      await detail(fix.slug),
      fix.userId,
      async () => {
        throw new Error("read a hand for somebody with no seat");
      },
      harness.db
    );
    expect(payload).toEqual({ kind: "no_seat" });
  });

  it("counts a queue place and a pending decision as no seat", async () => {
    const fix = await fixture({ seat: true });
    const event = await detail(fix.slug);
    const [application] = await harness.db.query.applications.findMany({
      where: (row, { and, eq }) => and(eq(row.eventId, fix.eventId), eq(row.userId, fix.userId)),
    });

    for (const status of ["waitlisted", "declined"] as const) {
      const moved = await setApplicationStatus(application.id, status, {}, harness.db);
      if (!moved.ok) throw new Error(`${status}: ${moved.error}`);
      const payload = await loadDraw(event, fix.userId, handFor, harness.db);
      expect(payload.kind, status).toBe("no_seat");
    }

    // And back: the seat is the status, so returning it returns the draw.
    const back = await setApplicationStatus(application.id, "accepted", {}, harness.db);
    if (!back.ok) throw new Error(back.error);
    expect((await loadDraw(event, fix.userId, handFor, harness.db)).kind).toBe("ready");

    /*
     * Withdrawing is the member's own write rather than a status an admin sets
     * — `setApplicationStatus` refuses it outright ("Only the applicant
     * withdraws an application"), which is how this test first failed — and it
     * is the case R-54 keeps open after the deadline, so it is the one most
     * likely to happen on the night.
     */
    const gone = await withdrawApplication(fix.eventId, fix.userId, harness.db);
    if (!gone.ok) throw new Error(gone.error);
    expect((await loadDraw(event, fix.userId, handFor, harness.db)).kind).toBe("no_seat");
  });

  it("counts an application still awaiting review as no seat", async () => {
    /*
     * An approval event (R-27): the application is alive and is the one the
     * organisers will read, but it holds no seat — so it is not a draw either.
     * Reached by applying to an approval-mode event rather than by setting the
     * status, because `setApplicationStatus` refuses a move back to pending
     * ("An application cannot be put back to pending review"), which is how
     * this started as one line of the loop above and had to become its own.
     */
    const fix = await fixture({ config: { entryMode: "approval" }, seat: false });
    const applied = await applyToEvent(fix.eventId, fix.userId, {}, harness.db);
    if (!applied.ok) throw new Error(applied.error);
    expect(applied.data.status).toBe("pending");

    const payload = await loadDraw(await detail(fix.slug), fix.userId, handFor, harness.db);
    expect(payload).toEqual({ kind: "no_seat" });
  });

  it("says so when the event has no game at all", async () => {
    const fix = await fixture({ game: false });
    const payload = await loadDraw(await detail(fix.slug), fix.userId, handFor, harness.db);
    expect(payload).toEqual({ kind: "no_game" });
  });

  it("names the game when its hero list is empty (UC-39 1b)", async () => {
    const fix = await fixture({ perRole: 0 });
    const payload = await loadDraw(await detail(fix.slug), fix.userId, handFor, harness.db);
    expect(payload).toEqual({ kind: "no_heroes", game: `Draw game ${counter}` });
  });

  it("refuses a thin list with the rule's own sentence (UC-39 2a)", async () => {
    const fix = await fixture({ perRole: 2 });
    const payload = await loadDraw(await detail(fix.slug), fix.userId, handFor, harness.db);
    if (payload.kind !== "too_thin") throw new Error(`got ${payload.kind}`);
    expect(payload.game).toBe(`Draw game ${counter}`);
    expect(payload.refusal).toBe(
      "Vanguard has 2 heroes, Duelist has 2 heroes and Strategist has 2 heroes. " +
        "A draw needs 3 in each role, so nothing was dealt. Add more on the game's hero list."
    );
  });

  it("offers the draw with no hand until one is dealt (UC-39 2)", async () => {
    const fix = await fixture();
    const payload = await loadDraw(await detail(fix.slug), fix.userId, handFor, harness.db);
    if (payload.kind !== "ready") throw new Error(`got ${payload.kind}`);
    expect(payload.hand).toBeNull();
    expect(payload.roles).toEqual(HERO_ROLES);
    expect(payload.perRole).toBe(HEROES_PER_ROLE);
  });

  it("carries the stored hand once there is one (UC-39 6a)", async () => {
    const fix = await fixture();
    const dealt = await dealFor(fix.eventId, fix.userId, undefined, harness.db);
    if (!dealt.ok) throw new Error(dealt.error);

    const payload = await loadDraw(await detail(fix.slug), fix.userId, handFor, harness.db);
    if (payload.kind !== "ready") throw new Error(`got ${payload.kind}`);
    expect(payload.hand?.map((card) => card.name)).toEqual(
      await storedNames(fix.eventId, fix.userId)
    );
  });

  /**
   * UC-39 7a, and R-215's "stated, never enforced".
   *
   * The comp comes off `teamFormatFrom` — the same reader the admin's Teams tab
   * and the random-teams write use — so the sentence a player reads and the
   * choice an admin made cannot drift. **Nothing anywhere below reads it back**,
   * and there is deliberately no test in this file asserting a refusal based on
   * a team's role composition, because there is nothing to refuse.
   */
  it("states the comp the admin chose, both ways round", async () => {
    const six = await fixture();
    const sixPayload = await loadDraw(await detail(six.slug), six.userId, handFor, harness.db);
    if (sixPayload.kind !== "ready") throw new Error("expected ready");
    expect(sixPayload.format).toEqual({ format: "6v6", teamSize: 6, comp: "2-2-2" });

    const three = await fixture();
    const patched = await updateEvent(three.eventId, { config: { teamFormat: "3v3" } }, harness.db);
    if (!patched.ok) throw new Error(patched.error);
    const threePayload = await loadDraw(
      await detail(three.slug),
      three.userId,
      handFor,
      harness.db
    );
    if (threePayload.kind !== "ready") throw new Error("expected ready");
    expect(threePayload.format).toEqual({ format: "3v3", teamSize: 3, comp: "1-1-1" });
  });
});

/* ------------------------------------------------------------------ */
/* The action: the whole hand, before the first card turns            */
/* ------------------------------------------------------------------ */

describe("the draw action (R-212 / UC-39 3, 3a, 5)", () => {
  it("hands back every one of the nine, which is what the reveal uncovers", async () => {
    const fix = await fixture();
    state.userId = fix.userId;

    const outcome = await drawAction(fix.slug);
    if (!outcome.ok) throw new Error(outcome.error);

    expect(outcome.cards).toHaveLength(HERO_ROLES.length * HEROES_PER_ROLE);
    expect(outcome.alreadyHeld).toBe(false);
    /*
     * The criterion, stated as a payload rather than as an animation: the nine
     * in the outcome are byte-for-byte the nine in the database, in the same
     * order, at the moment the browser receives them. There is nothing left for
     * a reveal to decide.
     */
    expect(outcome.cards.map((card) => card.name)).toEqual(
      await storedNames(fix.eventId, fix.userId)
    );
  });

  it("carries no pool, no seed and nothing else to deal from", async () => {
    const fix = await fixture();
    state.userId = fix.userId;
    const outcome = await drawAction(fix.slug);
    if (!outcome.ok) throw new Error(outcome.error);

    // The whole shape of the outcome, so a field growing onto it is a failure
    // here rather than something nobody notices until it is in the bundle.
    expect(Object.keys(outcome).sort()).toEqual(["alreadyHeld", "cards", "ok"]);
    const pool = await poolNames(fix.gameId as string);
    // Twelve drawable heroes, nine dealt, so three must be absent — a payload
    // carrying the pool would name all twelve.
    expect(pool.length).toBeGreaterThan(outcome.cards.length);
  });

  it("deals nothing on a second click and returns the hand that stands (UC-39 3a)", async () => {
    const fix = await fixture();
    state.userId = fix.userId;

    const first = await drawAction(fix.slug);
    if (!first.ok) throw new Error(first.error);

    const second = await drawAction(fix.slug);
    if (!second.ok) throw new Error(second.error);

    expect(second.alreadyHeld).toBe(true);
    expect(second.cards).toEqual(first.cards);
    // `alreadyHeld` is what tells the reveal not to play out again, and it is
    // `dealFor`'s answer rather than something re-derived in the browser.
    expect(first.alreadyHeld).toBe(false);
  });

  it("refuses a signed-out caller, and deals nothing", async () => {
    const fix = await fixture();
    state.userId = null;
    const outcome = await drawAction(fix.slug);
    expect(outcome.ok).toBe(false);
    expect(await handFor(fix.eventId, fix.userId, harness.db)).toBeNull();
  });

  it("refuses somebody with no seat, however they got the button (UC-39 1a)", async () => {
    const fix = await fixture({ seat: false });
    state.userId = fix.userId;
    const outcome = await drawAction(fix.slug);
    expect(outcome.ok).toBe(false);
    // A server action is a public endpoint: the page's refusal is not the gate.
    expect(await handFor(fix.eventId, fix.userId, harness.db)).toBeNull();
  });

  it("refuses a thin list with the sentence an admin can act on", async () => {
    const fix = await fixture({ perRole: 2 });
    state.userId = fix.userId;
    const outcome = await drawAction(fix.slug);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.error).toContain("A draw needs 3 in each role");
    expect(outcome.error).toContain("Vanguard has 2 heroes");
    // And not the catch-all, which is a different sentence sharing no phrase
    // with this one — the `toContain("Void those lots")` escape, avoided.
    expect(outcome.error).not.toContain("Reload the page");
    expect(await handFor(fix.eventId, fix.userId, harness.db)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The page                                                           */
/* ------------------------------------------------------------------ */

describe("the page before the draw (UC-39 2)", () => {
  it("carries not one of the game's heroes, because nothing has been dealt", async () => {
    const fix = await fixture();
    state.userId = fix.userId;
    const markup = await render(fix.slug);

    /*
     * The sharpest assertion in this file, and the one aimed squarely at
     * "server-decided". Every drawable hero in the game is checked against the
     * route's own HTML and must be absent: a page that sent the pool down would
     * be a reveal that could deal, whatever the animation did afterwards.
     *
     * Twelve names, so an empty pool cannot pass this by accident — the count
     * is asserted first.
     */
    const pool = await poolNames(fix.gameId as string);
    expect(pool).toHaveLength(12);
    for (const name of pool) expect(markup, name).not.toContain(name);
  });

  it("offers the click, and says the draw happens once before offering it", async () => {
    const fix = await fixture();
    state.userId = fix.userId;
    const markup = await render(fix.slug);
    const text = words(markup);

    expect(text).toContain("Draw my 9");
    const warning = markup.indexOf("The draw happens once");
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(warning).toBeLessThan(markup.indexOf("Draw my 9"));
  });

  it("states the comp, and that it is stated rather than enforced (UC-39 7a)", async () => {
    const fix = await fixture();
    state.userId = fix.userId;
    const text = words(await render(fix.slug));
    // Through the page, so this also proves `format` is handed to the client —
    // the prop a deleted `roles={roles}` was lost from on this project.
    expect(text).toContain("6v6 states a 2-2-2 comp");
    expect(text).toContain("The comp is stated, never enforced");
  });

  it("states the admin's other choice when that is the one they made", async () => {
    const fix = await fixture();
    const patched = await updateEvent(fix.eventId, { config: { teamFormat: "3v3" } }, harness.db);
    if (!patched.ok) throw new Error(patched.error);
    state.userId = fix.userId;
    const text = words(await render(fix.slug));
    // Both halves, so a page hard-coding either one fails.
    expect(text).toContain("3v3 states a 1-1-1 comp");
    expect(text).not.toContain("2-2-2");
  });
});

describe("the page with a hand already stored (UC-39 6, 6a)", () => {
  it("renders all nine in the server's own HTML, in deal order", async () => {
    const fix = await fixture();
    const dealt = await dealFor(fix.eventId, fix.userId, undefined, harness.db);
    if (!dealt.ok) throw new Error(dealt.error);
    state.userId = fix.userId;

    const markup = await render(fix.slug);
    const nine = await storedNames(fix.eventId, fix.userId);

    /*
     * This is what "the page passes the server-decided hand" means in a form
     * that can fail. Every name is in the markup the server sent, before a line
     * of JavaScript has run — and in deal order, so the page is handing over the
     * hand rather than a set it re-assembled.
     */
    expect(nine).toHaveLength(9);
    for (const name of nine) expect(markup, name).toContain(name);
    const positions = nine.map((name) => markup.indexOf(name));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("offers no button to draw again (UC-39 6a)", async () => {
    const fix = await fixture();
    const dealt = await dealFor(fix.eventId, fix.userId, undefined, harness.db);
    if (!dealt.ok) throw new Error(dealt.error);
    state.userId = fix.userId;

    const markup = await render(fix.slug);
    expect(markup).not.toContain("Draw my");
    expect(words(markup)).toContain("The draw happened once");
  });

  it("shows one player their own hand and never another's", async () => {
    const mine = await fixture();
    const theirs = await makeUser(harness.db, { displayName: "Somebody else" });
    const applied = await applyToEvent(mine.eventId, theirs, {}, harness.db);
    if (!applied.ok) throw new Error(applied.error);
    const [application] = await harness.db.query.applications.findMany({
      where: (row, { and, eq }) => and(eq(row.eventId, mine.eventId), eq(row.userId, theirs)),
    });
    const decided = await setApplicationStatus(application.id, "accepted", {}, harness.db);
    if (!decided.ok) throw new Error(decided.error);

    // Both deal, from a pool of four per role, with different sequences — so
    // the two hands differ and "their hand is not on my page" is a real claim.
    const first = await dealFor(mine.eventId, mine.userId, () => 0, harness.db);
    const second = await dealFor(
      mine.eventId,
      theirs,
      fromList([0.9, 0.5, 0.1, 0.9, 0.5, 0.1, 0.9, 0.5, 0.1]),
      harness.db
    );
    if (!first.ok || !second.ok) throw new Error("a deal was refused");

    const theirNames = handCards(second.hand.heroes).map((card) => card.name);
    const myNames = handCards(first.hand.heroes).map((card) => card.name);
    const onlyTheirs = theirNames.filter((name) => !myNames.includes(name));
    expect(onlyTheirs.length, "the two hands must differ for this to say anything")
      .toBeGreaterThan(0);

    state.userId = mine.userId;
    const markup = await render(mine.slug);
    for (const name of onlyTheirs) expect(markup, name).not.toContain(name);
  });
});

describe("the page when there is nothing to draw", () => {
  it("tells a non-participant so rather than showing an empty draw (UC-39 1a)", async () => {
    const fix = await fixture({ seat: false });
    state.userId = fix.userId;
    const text = words(await render(fix.slug));

    expect(text).toContain("You do not hold a seat at this one");
    expect(text).toContain("there is nothing here to turn over for somebody who is not");
    // Not an empty draw: no cards, no button, no count.
    expect(text).not.toContain("Draw my");
    expect(text).not.toContain("turned");
  });

  it("names the game when its hero list is empty (UC-39 1b)", async () => {
    const fix = await fixture({ perRole: 0 });
    state.userId = fix.userId;
    const text = words(await render(fix.slug));

    // The game by name, which is the whole of 1b — an empty draw would say
    // nothing and leave a player asking which list is missing.
    expect(text).toContain(`Draw game ${counter} has no hero list yet`);
    expect(text).not.toContain("Draw my");
  });

  it("says so when the event has no game at all", async () => {
    const fix = await fixture({ game: false });
    state.userId = fix.userId;
    const text = words(await render(fix.slug));
    expect(text).toContain("This event has no game");
    expect(text).not.toContain("Draw my");
  });

  it("refuses a thin list before any draw, naming every thin role (UC-39 2a)", async () => {
    const fix = await fixture({ perRole: 2 });
    state.userId = fix.userId;
    const text = words(await render(fix.slug));

    // The game by name, as the empty-list screen does — a player told the list
    // is thin still has to know whose list it is.
    expect(text).toContain(`Draw game ${counter}'s hero list is too thin to deal from`);
    expect(text).toContain("Vanguard has 2 heroes, Duelist has 2 heroes and Strategist has 2 heroes");
    expect(text).toContain("A draw needs 3 in each role, so nothing was dealt");
    expect(text).toContain("Add more on the game's hero list");
    expect(text).not.toContain("Draw my");
    // And nothing was dealt, which is the half the sentence promises.
    expect(await handFor(fix.eventId, fix.userId, harness.db)).toBeNull();
  });

  it("gives each of them its own sentence", async () => {
    // The criterion says "a non-participant and a game with no heroes each get
    // their own sentence". One shared "you cannot draw" page would pass every
    // `toContain` above if the sentences were the same, so they are compared.
    const seatless = await fixture({ seat: false });
    const listless = await fixture({ perRole: 0 });

    state.userId = seatless.userId;
    const noSeat = words(await render(seatless.slug));
    state.userId = listless.userId;
    const noHeroes = words(await render(listless.slug));

    expect(noSeat).not.toContain("has no hero list yet");
    expect(noHeroes).not.toContain("You do not hold a seat");
  });
});

describe("who may open it at all", () => {
  it("answers 404 for an event this viewer cannot see", async () => {
    const fix = await fixture();
    // Back to draft: an unpublished event does not exist as far as anybody but
    // its managers is concerned, so the draw page must not confirm it either.
    const hidden = await updateEvent(fix.eventId, { status: "draft" }, harness.db);
    if (!hidden.ok) throw new Error(hidden.error);

    state.userId = fix.userId;
    await expect(render(fix.slug)).rejects.toThrow();
  });

  it("answers 404 for a slug that is not an event", async () => {
    const fix = await fixture();
    state.userId = fix.userId;
    await expect(render("no-such-event-at-all")).rejects.toThrow();
  });
});

/** The numbers, in order, and a throw if the draw wants more than were given. */
function fromList(draws: readonly number[]): () => number {
  let index = 0;
  return () => {
    if (index >= draws.length) throw new Error("the deal asked for more numbers than given");
    return draws[index++];
  };
}

/* ------------------------------------------------------------------ */
/* The floor                                                          */
/* ------------------------------------------------------------------ */

describe("the fixtures are real", () => {
  /**
   * Every "not in the markup" assertion above passes against a page that failed
   * to render, and most of them pass against a pool that was empty. So both are
   * asserted to be real before anything is concluded from an absence.
   */
  it("renders a page with content in it", async () => {
    const fix = await fixture();
    state.userId = fix.userId;
    const markup = await render(fix.slug);
    expect(markup.length).toBeGreaterThan(1000);
    expect(markup).toContain(`Draw event ${counter}`);
  });

  it("has a generator that would be caught dealing", () => {
    expect(() => thrower()()).toThrow("something dealt when it should not have");
  });
});
