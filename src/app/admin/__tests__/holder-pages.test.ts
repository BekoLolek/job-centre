import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, championships, users } from "@/db";
import { type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";
import { POWERS, type Power } from "@/lib/permissions-policy";

/*
 * Who each admin page lets in, asked of the page (Task 130, R-265 / UC-56 3a).
 *
 * **The page, not the nav.** Every row calls the page's own default export -
 * and, where it has one, its `generateMetadata` - as a signed-in member and
 * reads where they end up. Nothing here looks at a link: a page that is
 * unlinked and still renders is exactly what this file is for, and
 * `src/components/__tests__/holder-nav.test.ts` holds the links separately.
 *
 * `ADMITS` is written out by hand and is not derived from the nav's own list
 * in `components/admin/sections.ts`, so the two cannot agree by sharing a
 * mistake. `session-guards` is the real one; only the session cookie, the
 * database handle and what will not load outside a Next request are replaced.
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
  getGateConfig: async () => ({ enabled: false, guildId: "", source: { guildId: "none" } }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: () => {} }));

const { grantPower } = await import("@/lib/permissions");
const { createEvent } = await import("@/lib/events");

const pages = {
  admin: (await import("../page")).default,
  audit: (await import("../audit/page")).default,
  availability: (await import("../availability/page")).default,
  championships: (await import("../championships/page")).default,
  championship: await import("../championships/[id]/page"),
  events: (await import("../events/page")).default,
  event: await import("../events/[id]/page"),
  games: (await import("../games/page")).default,
  hands: (await import("../hands/page")).default,
  host: (await import("../host/page")).default,
  settings: (await import("../settings/page")).default,
  templates: (await import("../templates/page")).default,
  users: (await import("../users/page")).default,
};

let handle: TestDatabase;
let seasonId: string;
let eventId: string;

/** One member per power, holding exactly that one; an admin holding none; a member holding none. */
const ids = {} as Record<Power | "admin" | "nothing" | "host", string>;

beforeAll(async () => {
  handle = await freshDatabase();
  const db = handle.db;
  state.db = db;

  ids.admin = await makeUser(db, { displayName: "An admin holding nothing" });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, ids.admin));
  ids.nothing = await makeUser(db, { displayName: "A member holding nothing" });
  for (const power of POWERS) {
    ids[power] = await makeUser(db, { displayName: `Holder of ${power}` });
    await grantPower({ userId: ids[power], power, grantedByUserId: ids.admin }, db);
  }

  const [season] = await db
    .insert(championships)
    .values({ slug: "a-season", name: "A season" })
    .returning({ id: championships.id });
  seasonId = season.id;
  const created = await createEvent({ title: "An event" }, db);
  if (!created.ok) throw new Error(created.error);
  eventId = created.data.id;
  ids.host = await makeUser(db, { displayName: "The event's host, holding nothing" });
  await makeHost(db, eventId, ids.host);
});

afterAll(async () => {
  await handle.close();
});

const none = Promise.resolve({});

/** Every entry point under `/admin` that is on a power, as a call. */
const OPEN: Record<string, () => Promise<unknown>> = {
  "/admin": () => pages.admin(),
  "/admin/audit": () => pages.audit({ searchParams: none }),
  "/admin/availability": () => pages.availability({ searchParams: none }),
  "/admin/championships": () => pages.championships(),
  "/admin/championships/[id]": () =>
    pages.championship.default({ params: Promise.resolve({ id: seasonId }) }),
  "/admin/championships/[id] (its tab title)": () =>
    pages.championship.generateMetadata({ params: Promise.resolve({ id: seasonId }) }),
  "/admin/events": () => pages.events(),
  "/admin/games": () => pages.games(),
  "/admin/hands": () => pages.hands({ searchParams: none }),
  "/admin/host": () => pages.host(),
  "/admin/settings": () => pages.settings(),
  "/admin/templates": () => pages.templates(),
  "/admin/users": () => pages.users(),
};

/**
 * The powers each page is for. An admin is admitted to all of them and is not
 * listed; a page with an empty list is the admin's alone.
 */
const ADMITS: Record<string, readonly Power[]> = {
  // A holder of any area power. `destructive` is the modifier - required in
  // addition to an area's power, and a way into nothing by itself.
  "/admin": POWERS.filter((power) => power !== "destructive"),
  "/admin/audit": ["audit.read"],
  "/admin/availability": ["members.read"],
  "/admin/championships": ["championships.manage"],
  "/admin/championships/[id]": ["championships.manage"],
  "/admin/championships/[id] (its tab title)": ["championships.manage"],
  // The list is where an event is made as well as where one is found.
  "/admin/events": ["events.create", "events.manage"],
  "/admin/games": ["games.manage"],
  "/admin/hands": ["members.read"],
  "/admin/host": ["hosts.approve"],
  // One screen, two powers: each holder is shown their own half.
  "/admin/settings": ["settings.announcements", "settings.integrations"],
  "/admin/templates": ["templates.manage"],
  // Where the admin flag is given and taken, so no power reaches it (R-264).
  "/admin/users": [],
};

const ROUTES = Object.keys(OPEN);
const ROWS = ROUTES.flatMap((route) => POWERS.map((power) => [power, route] as const));
const ADMITTED = ROWS.filter(([power, route]) => ADMITS[route].includes(power));
const REFUSED = ROWS.filter(([power, route]) => !ADMITS[route].includes(power));

/** What a signed-in member is told when a page is not theirs: no way back, because signing in again changes nothing. */
const NOT_YOURS = { digest: expect.stringMatching(/^NEXT_REDIRECT;[a-z]+;\/signin\?error=admin-only;/) };
/** What a visitor is told: sign in. */
const SIGN_IN = { digest: expect.stringMatching(/^NEXT_REDIRECT;[a-z]+;\/signin;/) };

describe("an admin page, opened by somebody holding one power", () => {
  it("is asked about here for every page there is under /admin but the event editor", () => {
    // The editor is on the event's own guard and has its own describe below.
    expect(Object.keys(ADMITS)).toEqual(ROUTES);
    expect(ROUTES).toHaveLength(13);
    expect(ADMITTED.length + REFUSED.length).toBe(13 * POWERS.length);
  });

  it.each(ADMITTED)("lets the holder of %s into %s", async (power, route) => {
    state.userId = ids[power];

    await expect(OPEN[route]()).resolves.toBeDefined();
  });

  it.each(REFUSED)("turns the holder of %s away from %s", async (power, route) => {
    state.userId = ids[power];

    await expect(OPEN[route]()).rejects.toMatchObject(NOT_YOURS);
  });
});

describe("a member holding destructive and nothing else", () => {
  /*
   * Already a row of the table above, for every page. Said again by name
   * because it is the one power that could be mistaken for a grant of access:
   * it is "required in addition to the area's power", so by itself it opens no
   * screen at all - the admin area's front door included.
   */
  it.each(ROUTES)("is turned away from %s", async (route) => {
    state.userId = ids.destructive;

    await expect(OPEN[route]()).rejects.toMatchObject(NOT_YOURS);
  });

  it("is let into a page once they also hold that page's power", async () => {
    const both = await makeUser(handle.db, { displayName: "Curator, with destructive" });
    for (const power of ["destructive", "games.manage"] as const) {
      await grantPower({ userId: both, power, grantedByUserId: ids.admin }, handle.db);
    }
    state.userId = both;

    await expect(OPEN["/admin/games"]()).resolves.toBeDefined();
    await expect(OPEN["/admin"]()).resolves.toBeDefined();
  });
});

describe("an admin page, opened by somebody else", () => {
  it.each(ROUTES)("lets an admin holding no power into %s", async (route) => {
    state.userId = ids.admin;

    await expect(OPEN[route]()).resolves.toBeDefined();
  });

  it.each(ROUTES)("refuses a member holding no power at %s, as it always has", async (route) => {
    state.userId = ids.nothing;

    await expect(OPEN[route]()).rejects.toMatchObject(NOT_YOURS);
  });

  it.each(ROUTES)("sends a visitor at %s to sign in", async (route) => {
    state.userId = null;

    await expect(OPEN[route]()).rejects.toMatchObject(SIGN_IN);
  });
});

/*
 * The one page under `/admin` that is not on a power of its own. It was on
 * `requireEventManager` before this task and still is: an event's host gets
 * in holding nothing, and the only power that opens it is the one that
 * manages every event. Nobody else is let in by this task - that is the
 * "without widening any guard" half of the two dead ends.
 */
describe("the event editor", () => {
  const open = () =>
    pages.event.default({ params: Promise.resolve({ id: eventId }), searchParams: none });
  const TO_THE_HUB = { digest: expect.stringMatching(/^NEXT_REDIRECT;[a-z]+;\/me;/) };

  it.each(["admin", "host", "events.manage"] as const)("opens for %s", async (who) => {
    state.userId = ids[who];

    await expect(open()).resolves.toBeDefined();
  });

  it.each(POWERS.filter((power) => power !== "events.manage"))(
    "sends the holder of %s to their own hub",
    async (power) => {
      state.userId = ids[power];

      await expect(open()).rejects.toMatchObject(TO_THE_HUB);
    }
  );
});
