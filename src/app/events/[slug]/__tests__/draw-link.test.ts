import fs from "node:fs";
import path from "node:path";
import { renderToReadableStream } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, games, heroes as heroesTable } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { HERO_ROLES } from "@/lib/heroes";

/**
 * The event page's link to `/events/[slug]/draw`, and the sweep that would have
 * found it missing (R-211 / UC-39 1).
 *
 * > **UC-39 1.** Participant opens the event's draw page.
 *
 * Step one of the use case, and before Task 84 there was no way to take it:
 * `/events/[slug]/draw` was written, browser-verified and reachable only by
 * typing the URL, because `page.tsx` sat outside the ownership of the task that
 * built it. The route was the first unreachable page on this project. The sweep
 * at the bottom of this file is what makes it the last one that ships.
 *
 * ## The link and the page have to admit the same people
 *
 * A link is a promise about what is behind it. `loadDraw` answers one of five
 * payloads — `no_seat`, `no_game`, `no_heroes`, `too_thin`, `ready` — and four
 * of them are refusals. A link that offered the route to somebody `loadDraw`
 * would answer `no_seat` is the dead end UC-39 1a was written to stop ("they are
 * told so rather than shown an empty draw"), only now the site walked them into
 * it. So the page asks `loadDraw` itself and shows the link on `ready` alone,
 * and the tests below are aimed at the refusals rather than at the happy path:
 * each of the four is arranged for real and the link must be absent.
 *
 * ## Why the page is rendered rather than the condition tested
 *
 * `draw-page.test.ts` records the scar this project has: `roles={roles}` was
 * deleted from a page here and every test stayed green, because they all
 * rendered components directly. `alert-announcement.test.ts` carries the same
 * note about its 117 call sites. So every assertion below is made against the
 * **route's own markup**, reached through `EventPage({ params, searchParams })`
 * with a real Postgres under it and a real session.
 *
 * ## Mocked exactly as `whos-in.test.ts` mocks, and for the same reasons
 *
 * Only the session cookie and the page cache cannot run outside a Next request,
 * and `useRouter` throws outside a mounted router. `notFound()` stays real.
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

const { default: EventPage } = await import("../page");
const { dealFor, handFor } = await import("@/lib/hero-hands");
const { applyToEvent, createEvent, publishEvent, setApplicationStatus } = await import(
  "@/lib/events"
);

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

type Fixture = {
  eventId: string;
  slug: string;
  /** Asserted before every absence, so "no link" is never "no render". */
  title: string;
  userId: string;
  gameId: string | null;
};

/**
 * An event, a game whose hero list holds `perRole` in each role, and a member
 * who does or does not hold a seat.
 *
 * `draw-page.test.ts`'s fixture, narrowed to what the link needs. The seat goes
 * through `applyToEvent` and `setApplicationStatus` rather than being written
 * in, so "holds a seat" is a seat the real writes produced — which is the whole
 * of UC-39 1a and therefore the whole of who the link is for.
 */
async function fixture(
  options: { perRole?: number; game?: boolean; seat?: boolean; capacity?: number } = {}
): Promise<Fixture> {
  const { perRole = 4, game = true, seat = true, capacity = 8 } = options;
  counter += 1;

  let gameId: string | null = null;
  if (game) {
    const [row] = await harness.db
      .insert(games)
      .values({ key: `link-game-${counter}`, name: `Link game ${counter}` })
      .returning({ id: games.id });
    gameId = row.id;

    if (perRole > 0) {
      await harness.db.insert(heroesTable).values(
        HERO_ROLES.flatMap((role) =>
          Array.from({ length: perRole }, (_unused, index) => ({
            gameId: row.id,
            name: `${role} ${index + 1} of link game ${counter}`,
            roles: [role],
          }))
        )
      );
    }
  }

  const title = `Link event ${counter}`;
  const created = await createEvent({ title, gameId, capacity, ...PUBLISHABLE }, harness.db);
  if (!created.ok) throw new Error(created.error);

  const published = await publishEvent(created.data.id, harness.db);
  if (!published.ok) throw new Error(published.error);

  const userId = await makeUser(harness.db, { displayName: `Linked player ${counter}` });
  if (seat) {
    const applied = await applyToEvent(created.data.id, userId, {}, harness.db);
    if (!applied.ok) throw new Error(applied.error);
    const [application] = await harness.db.query.applications.findMany({
      where: (row, { and, eq }) => and(eq(row.eventId, created.data.id), eq(row.userId, userId)),
    });
    const decided = await setApplicationStatus(application.id, "accepted", {}, harness.db);
    if (!decided.ok) throw new Error(decided.error);
  }

  return { eventId: created.data.id, slug: created.data.slug, title, userId, gameId };
}

/** The route's own markup, as the server sends it. */
async function render(slug: string): Promise<string> {
  const page = await EventPage({
    params: Promise.resolve({ slug }),
    searchParams: Promise.resolve({}),
  });
  const stream = await renderToReadableStream(page);
  await stream.allReady;
  return await new Response(stream).text();
}

/** The same, as words: no tags, no entities. */
function words(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

/**
 * The attribute name, assembled rather than written.
 *
 * Measured, not decorative: with the attribute and the draw path spelled out
 * next to each other anywhere in this file, **this file became an inbound link
 * to the route it is testing** — the sweep at the bottom read its own helper as
 * a link and passed with the real link deleted. The `__tests__` exclusion down
 * there catches that, but a sweep should not depend on one exclusion to avoid
 * quoting itself as evidence, so the pair is only ever joined at runtime.
 */
const ATTR = `${"hr"}${"ef"}`;

/**
 * Does the rendered page carry an anchor to this event's draw?
 *
 * The attribute and not the label, so a test cannot be satisfied by the words
 * "your draw" appearing in a heading somewhere. And this event's slug, so one
 * fixture's link cannot answer for another's.
 */
function linksToDraw(markup: string, slug: string): boolean {
  return new RegExp(`${ATTR}="/events/${slug}/draw"`).test(markup);
}

/* ------------------------------------------------------------------ */
/* UC-39 1 — the link exists at all                                   */
/* ------------------------------------------------------------------ */

describe("UC-39 1: a participant can open the draw", () => {
  it("offers the draw to somebody holding a seat at a hero-game event", async () => {
    const fix = await fixture();
    state.userId = fix.userId;

    const markup = await render(fix.slug);
    // The page rendered at all, first: every absence assertion below is
    // satisfied by a render that never happened.
    expect(words(markup)).toContain(fix.title);
    expect(linksToDraw(markup, fix.slug)).toBe(true);
  });

  it("names it as theirs, in the words the draw page uses for itself", async () => {
    const fix = await fixture();
    state.userId = fix.userId;

    expect(words(await render(fix.slug))).toContain("Your draw");
  });
});

/* ------------------------------------------------------------------ */
/* The four refusals the link must not offer                          */
/* ------------------------------------------------------------------ */

describe("the link admits exactly who the page admits", () => {
  it("does not offer it to a member who never applied (no_seat)", async () => {
    const fix = await fixture({ seat: false });
    state.userId = fix.userId;

    const markup = await render(fix.slug);
    expect(words(markup)).toContain(fix.title);
    expect(linksToDraw(markup, fix.slug)).toBe(false);
  });

  it("does not offer it to somebody sitting in the queue (no_seat)", async () => {
    /*
     * The case that catches a seat test written as "has an application". One
     * seat, taken by the fixture's own member, so the next applicant is
     * *waitlisted* by the real write rather than by this test saying so — and a
     * queue place is not a seat, which is the line `holdsSeat` draws and the
     * same line the public "Who's in" list draws.
     */
    const fix = await fixture({ capacity: 2 });
    // Two is the smallest an event may be, so the second seat is filled before
    // the queue starts.
    const second = await makeUser(harness.db, { displayName: `Second seat ${counter}` });
    const seated = await applyToEvent(fix.eventId, second, {}, harness.db);
    if (!seated.ok) throw new Error(seated.error);

    const queued = await makeUser(harness.db, { displayName: `Queued player ${counter}` });
    const applied = await applyToEvent(fix.eventId, queued, {}, harness.db);
    if (!applied.ok) throw new Error(applied.error);
    const [application] = await harness.db.query.applications.findMany({
      where: (row, { and, eq }) => and(eq(row.eventId, fix.eventId), eq(row.userId, queued)),
    });
    // The premise. An application that came back `accepted` would make the
    // absence below a statement about nothing.
    expect(application.status).toBe("waitlisted");
    state.userId = queued;

    const markup = await render(fix.slug);
    expect(words(markup)).toContain(fix.title);
    expect(linksToDraw(markup, fix.slug)).toBe(false);
    // And the member who does hold the one seat still gets it, so the absence
    // above is about the queue and not about the event.
    state.userId = fix.userId;
    expect(linksToDraw(await render(fix.slug), fix.slug)).toBe(true);
  });

  it("does not offer it to a signed-out visitor", async () => {
    const fix = await fixture();
    state.userId = null;

    const markup = await render(fix.slug);
    expect(words(markup)).toContain(fix.title);
    expect(linksToDraw(markup, fix.slug)).toBe(false);
  });

  it("does not offer it to a seated member of an event with no game (no_game)", async () => {
    const fix = await fixture({ game: false });
    state.userId = fix.userId;

    const markup = await render(fix.slug);
    expect(words(markup)).toContain(fix.title);
    expect(linksToDraw(markup, fix.slug)).toBe(false);
  });

  it("does not advertise a draw for a game with no hero list (no_heroes)", async () => {
    const fix = await fixture({ perRole: 0 });
    state.userId = fix.userId;

    const markup = await render(fix.slug);
    expect(words(markup)).toContain(fix.title);
    expect(linksToDraw(markup, fix.slug)).toBe(false);
  });

  it("does not offer it while a role is too thin to deal from (too_thin)", async () => {
    /*
     * The fifth payload, and the one an acceptance criterion does not mention.
     * It is held to the same rule for the same reason: the page behind the link
     * refuses, naming every short role (UC-39 2a), so offering the route would
     * be the site walking somebody into a refusal it could already see coming.
     */
    const fix = await fixture({ perRole: 0 });
    if (!fix.gameId) throw new Error("fixture lost its game");
    await harness.db.insert(heroesTable).values([
      { gameId: fix.gameId, name: `Thin Vanguard ${counter}`, roles: ["Vanguard"] },
      { gameId: fix.gameId, name: `Thin Duelist ${counter}`, roles: ["Duelist"] },
      { gameId: fix.gameId, name: `Thin Strategist ${counter}`, roles: ["Strategist"] },
    ]);
    state.userId = fix.userId;

    const markup = await render(fix.slug);
    expect(words(markup)).toContain(fix.title);
    expect(linksToDraw(markup, fix.slug)).toBe(false);
  });

  it("does not show one member's draw to another seated member", async () => {
    // Two seats, one hand: the link is per-reader, so the second member's page
    // must offer them their own undrawn draw and not the first member's hand.
    const fix = await fixture();
    const other = await makeUser(harness.db, { displayName: `Other player ${counter}` });
    const applied = await applyToEvent(fix.eventId, other, {}, harness.db);
    if (!applied.ok) throw new Error(applied.error);
    const [application] = await harness.db.query.applications.findMany({
      where: (row, { and, eq }) => and(eq(row.eventId, fix.eventId), eq(row.userId, other)),
    });
    const decided = await setApplicationStatus(application.id, "accepted", {}, harness.db);
    if (!decided.ok) throw new Error(decided.error);

    const dealt = await dealFor(fix.eventId, fix.userId, () => 0, harness.db);
    if (!dealt.ok) throw new Error(dealt.error);

    state.userId = other;
    expect(words(await render(fix.slug))).toContain("Draw your heroes");
    state.userId = fix.userId;
    expect(words(await render(fix.slug))).toContain("See your hand");
  });
});

/* ------------------------------------------------------------------ */
/* UC-39 2 vs 6a — which of the two screens is behind the link        */
/* ------------------------------------------------------------------ */

describe("the link says whether a hand has been drawn", () => {
  it("invites the draw before anything is dealt", async () => {
    const fix = await fixture();
    state.userId = fix.userId;

    const rendered = words(await render(fix.slug));
    expect(rendered).toContain("Draw your heroes");
    expect(rendered).not.toContain("See your hand");
  });

  it("points at the stored hand once there is one", async () => {
    const fix = await fixture();
    const dealt = await dealFor(fix.eventId, fix.userId, () => 0, harness.db);
    if (!dealt.ok) throw new Error(dealt.error);
    // Against the row rather than against the call: what the page reads is the
    // stored hand, so that is what the premise of this test has to be.
    expect(await handFor(fix.eventId, fix.userId, harness.db)).not.toBeNull();
    state.userId = fix.userId;

    const rendered = words(await render(fix.slug));
    expect(rendered).toContain("See your hand");
    expect(rendered).not.toContain("Draw your heroes");
  });

  it("keeps the hand itself off the event page", async () => {
    /*
     * The link says *that* they have drawn, which is a fact about the row. The
     * nine are the draw page's to reveal, and a hand printed here would be the
     * reveal spoiled by the page in front of it.
     */
    const fix = await fixture();
    const dealt = await dealFor(fix.eventId, fix.userId, () => 0, harness.db);
    if (!dealt.ok) throw new Error(dealt.error);
    const stored = await handFor(fix.eventId, fix.userId, harness.db);
    if (!stored) throw new Error("no hand stored");
    state.userId = fix.userId;

    const markup = await render(fix.slug);
    expect(linksToDraw(markup, fix.slug)).toBe(true);
    for (const role of HERO_ROLES) {
      for (const hero of stored.heroes[role]) {
        expect(markup, hero.name).not.toContain(hero.name);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* The sweep: no route is reachable only by typing its URL            */
/* ------------------------------------------------------------------ */

/**
 * Every route under `src/app`, and whether anything links to it.
 *
 * ## Why it is read off disk and not keyed to the link above
 *
 * Task 31's `Left over` note, which `alert-announcement.test.ts` also works
 * from: **a sweep keyed to the fixed form cannot report the unfixed one.** A
 * test asserting that `/events/[slug]/page.tsx` contains the draw href would
 * have passed the moment that line was typed and would have said nothing about
 * the next page somebody builds without a way in. So this enumerates the routes
 * and the hrefs independently, from the source tree, and compares the two sets.
 * Run against the tree before Task 84 it reports `/events/[slug]/draw`; that is
 * the whole of its value.
 *
 * ## What stops it passing vacuously
 *
 * Three things, because a scan that found nothing would otherwise "pass" every
 * route trivially:
 *
 *  - **Floors.** The route count and the link count are each asserted against a
 *    floor. A walk that found no `page.tsx` files, or a pattern that matched no
 *    hrefs, fails on the floor rather than reporting a clean sweep of nothing.
 *  - **Comments stripped, and self-links excluded.** Every page on this site
 *    names its own path in its docblock, so a scan of raw text would find
 *    `/admin/availability` inside `/admin/availability/page.tsx` and call the
 *    route linked. Comments go first — a `toContain` passing over a comment has
 *    happened on this project — and a link only counts from **outside the
 *    route's own directory**, so neither a page nor anything beside it can
 *    vouch for itself.
 *  - **Test files are not links.** A fixture href in `__tests__` is not
 *    something a person can click, and two already exist (`/events/spring-lan`).
 *    They are excluded, or the suite would be able to make a route reachable.
 *
 * ## The exemptions are an inventory, not a pattern
 *
 * One route is deliberately unlinked, and it is written down by name with its
 * reason rather than matched by a rule. An exemption also has to still exist:
 * the list is checked against the routes on disk, so a stale entry fails here
 * instead of quietly widening.
 */
const SRC = path.resolve(__dirname, "../../../..");
const APP = path.join(SRC, "app");

/**
 * Routes nothing links to on purpose.
 *
 * `/dev-login` is the development sign-in escape hatch, and it 404s unless
 * `NODE_ENV=development`, `DEV_LOGIN=1` and no `DATABASE_URL` are all true at
 * once — so a link to it would be a dead link in every deployment and an
 * invitation to a state change in the one place it works. Its own docblock
 * makes the second half of that argument: "even a development tool should not
 * [sign you in] because something linked to it".
 */
const UNLINKED_ON_PURPOSE: Record<string, string> = {
  "/dev-login": "development-only escape hatch, typed rather than linked",
};

/** A file's code with its comments taken out. */
function code(file: string): string {
  return fs
    .readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** `/admin/events/[id]` and friends: the route this `page.tsx` serves. */
function routeOf(pageFile: string): string {
  const rest = path.relative(APP, path.dirname(pageFile)).split(path.sep).filter(Boolean);
  return `/${rest.join("/")}`;
}

/**
 * Every `href` in the source, in both the forms this codebase writes.
 *
 * JSX (`href="/events"`, `href={\`/events/${"${slug}"}\`}`) and the object
 * literals the navs are built from (`{ href: "/admin/host", label: "Hosts" }`),
 * which is how five admin routes are linked and none of them through JSX.
 */
const HREF = /\bhref\s*[=:]\s*\{?\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;

type Link = { href: string; file: string };

function segments(route: string): string[] {
  return route.split(/[?#]/)[0].split("/").filter(Boolean);
}

/** Does this href land on this route? A `[slug]` takes any one segment. */
function lands(route: string, href: string): boolean {
  const wanted = segments(route);
  const got = segments(href);
  if (wanted.length !== got.length) return false;
  return wanted.every((segment, index) =>
    segment.startsWith("[") ? got[index].length > 0 : segment === got[index]
  );
}

describe("every route has a way in", () => {
  const files = sources(SRC);
  const pages = files.filter((file) => path.basename(file) === "page.tsx");
  const links: Link[] = [];
  for (const file of files) {
    if (file.split(path.sep).includes("__tests__")) continue;
    for (const match of code(file).matchAll(HREF)) {
      const href = match[1] ?? match[2] ?? match[3];
      if (href?.startsWith("/")) links.push({ href, file });
    }
  }

  it("found the tree it is sweeping", () => {
    // The floors. Both were measured on the tree this test was written against
    // (31 routes, 145 hrefs) and are set below it, so ordinary growth does not
    // trip them while a scan that found nothing cannot report a clean sweep.
    expect(fs.existsSync(path.join(APP, "page.tsx"))).toBe(true);
    expect(pages.length).toBeGreaterThanOrEqual(25);
    expect(links.length).toBeGreaterThanOrEqual(100);
  });

  it("links to every route except the ones written down here", () => {
    const unlinked = pages
      .map(routeOf)
      .filter(
        (route) =>
          !links.some(
            ({ href, file }) =>
              !file.startsWith(path.join(APP, ...segments(route)) + path.sep) &&
              lands(route, href)
          )
      )
      .sort();

    expect(unlinked).toEqual(Object.keys(UNLINKED_ON_PURPOSE).sort());
  });

  it("keeps the exemption list honest", () => {
    // A route that no longer exists cannot be exempt from anything, and an
    // entry left behind after a deletion is how an exemption list turns into a
    // pattern that excuses the next unreachable page.
    const routes = new Set(pages.map(routeOf));
    for (const route of Object.keys(UNLINKED_ON_PURPOSE)) {
      expect(routes.has(route), route).toBe(true);
    }
  });

  it("holds the draw page, which is the route this sweep was written for", () => {
    const route = "/events/[slug]/draw";
    expect(new Set(pages.map(routeOf)).has(route)).toBe(true);
    const inbound = links.filter(
      ({ href, file }) =>
        !file.startsWith(path.join(APP, "events", "[slug]", "draw") + path.sep) &&
        lands(route, href)
    );
    expect(inbound.length).toBeGreaterThan(0);
  });
});
