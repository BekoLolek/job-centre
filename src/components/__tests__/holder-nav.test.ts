import { type ReactElement, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, users } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { type Holder, POWERS, type Power } from "@/lib/permissions-policy";

/*
 * The links a member is shown into the admin area (Task 130, R-265 / UC-56 2).
 *
 * **The nav, not the pages.** This file never opens a page. Whether a page
 * turns somebody away is `src/app/admin/__tests__/holder-pages.test.ts`, with
 * a table of its own: a link that is hidden says nothing about the page behind
 * it, and the two are pinned apart so neither can stand in for the other.
 *
 * Three things, in the order the data travels:
 *
 *  1. the rule - which sections a holder's powers reach (`sectionsFor`);
 *  2. the account menu - the same sections, because below `lg` the bar is
 *     hidden and the menu is the only way in on a phone (`adminMenuFor`);
 *  3. the wiring - that the two server components really read the signed-in
 *     member's powers and hand them on, since a rule nothing consults shows
 *     everybody everything.
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
  signOut: async () => {},
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => "/admin",
}));

const { ADMIN_SECTIONS, AREA_POWERS, reachesAdminArea, sectionsFor } = await import(
  "../admin/sections"
);
const { ADMIN_MENU, AccountMenuPanel, adminMenuFor, default: NavMenu } = await import("../NavMenu");
const { default: AdminNav } = await import("../admin/AdminNav");
const { default: AdminNavLinks } = await import("../admin/AdminNavLinks");
const { default: SessionNav } = await import("../SessionNav");
const { grantPower } = await import("@/lib/permissions");

/**
 * What each power reaches. Written out, not derived: it is the product's
 * answer, and the code is what is being checked against it.
 *
 * Every area power reaches Tonight, the area's front door. Three reach
 * nothing else under `/admin`: polls and suggestions live outside it, and an
 * announcement is posted from an event's editor.
 *
 * **`destructive` reaches nothing at all, Tonight included.** It is the
 * modifier - required in addition to an area's power - and not a way in.
 */
const REACHES: Record<Power, readonly string[]> = {
  "events.create": ["/admin", "/admin/events"],
  "events.manage": ["/admin", "/admin/events"],
  "announce.post": ["/admin"],
  "settings.announcements": ["/admin", "/admin/settings"],
  "settings.integrations": ["/admin", "/admin/settings"],
  "games.manage": ["/admin", "/admin/games"],
  "templates.manage": ["/admin", "/admin/templates"],
  "championships.manage": ["/admin", "/admin/championships"],
  "polls.manage": ["/admin"],
  "suggestions.moderate": ["/admin"],
  "hosts.approve": ["/admin", "/admin/host"],
  "members.read": ["/admin", "/admin/availability", "/admin/hands"],
  "audit.read": ["/admin", "/admin/audit"],
  destructive: [],
};

const EVERYTHING = [
  "/admin",
  "/admin/events",
  "/admin/championships",
  "/admin/availability",
  "/admin/host",
  "/admin/templates",
  "/admin/games",
  "/admin/users",
  "/admin/hands",
  "/admin/audit",
  "/admin/settings",
];

const holding = (...powers: Power[]): Holder => ({ isAdmin: false, powers: new Set(powers) });
const ADMIN: Holder = { isAdmin: true, powers: new Set() };
const hrefs = (items: readonly { href: string }[]) => items.map((item) => item.href);

/* ------------------------------------------------------------------ */
/* 1. The rule                                                        */
/* ------------------------------------------------------------------ */

describe("the admin sections a member is shown", () => {
  it.each(POWERS)("are exactly what %s reaches, for its holder", (power) => {
    expect(hrefs(sectionsFor(holding(power))).sort()).toEqual([...REACHES[power]].sort());
  });

  it("are unchanged by destructive, held beside an area power", () => {
    expect(hrefs(sectionsFor(holding("games.manage", "destructive")))).toEqual(
      hrefs(sectionsFor(holding("games.manage")))
    );
  });

  it("are all eleven for an admin holding no power, in the bar's order", () => {
    expect(hrefs(sectionsFor(ADMIN))).toEqual(EVERYTHING);
  });

  it("are none at all for a member holding no power", () => {
    expect(sectionsFor(holding())).toEqual([]);
  });

  it("add up, for a holder of two powers, to both powers' sections", () => {
    expect(hrefs(sectionsFor(holding("games.manage", "audit.read")))).toEqual([
      "/admin",
      "/admin/games",
      "/admin/audit",
    ]);
  });

  it("never include Members for a holder of every power there is", () => {
    // R-264: the screen that gives and takes the admin flag is the flag's alone.
    expect(hrefs(sectionsFor(holding(...POWERS)))).toEqual(
      EVERYTHING.filter((href) => href !== "/admin/users")
    );
  });

  it("let into the area an admin and a holder of any area power, and nobody else", () => {
    expect(POWERS.filter((power) => !reachesAdminArea(holding(power)))).toEqual(["destructive"]);
    expect(reachesAdminArea(ADMIN)).toBe(true);
    expect(reachesAdminArea(holding())).toBe(false);
  });

  it("name every power but the modifier as an area power", () => {
    expect(AREA_POWERS).toEqual(POWERS.filter((power) => power !== "destructive"));
    expect(AREA_POWERS).toHaveLength(13);
  });
});

/* ------------------------------------------------------------------ */
/* 2. The account menu                                                */
/* ------------------------------------------------------------------ */

/*
 * `AdminNav`'s docblock promises that every entry also lives in the account
 * menu. The bar is `hidden lg:flex`, so on a phone the menu is the admin
 * area's only door - an entry missing from it is a page nobody on a phone can
 * reach, which this repo has shipped once already.
 */
describe("the account menu's admin entries", () => {
  it("are the bar's sections, every one and no other", () => {
    expect(hrefs(ADMIN_MENU).sort()).toEqual(hrefs(ADMIN_SECTIONS).sort());
    expect(hrefs(ADMIN_MENU)).toHaveLength(11);
  });

  it.each(POWERS)("are exactly the bar's, for the holder of %s", (power) => {
    const holder = holding(power);

    expect(hrefs(adminMenuFor(holder)).sort()).toEqual(hrefs(sectionsFor(holder)).sort());
    expect(hrefs(adminMenuFor(holder)).sort()).toEqual([...REACHES[power]].sort());
  });

  it("are all eleven for an admin", () => {
    expect(hrefs(adminMenuFor(ADMIN)).sort()).toEqual([...EVERYTHING].sort());
  });

  it("are none for a member holding no power", () => {
    expect(adminMenuFor(holding())).toEqual([]);
  });
});

/*
 * The panel itself, rendered. `adminMenuFor` being right is not the same as
 * the panel drawing its answer: a panel that drew the Admin group on the flag
 * alone would leave every holder with a bar they cannot see below `lg` and a
 * menu with no way in - and every test above would still pass.
 *
 * `AccountMenuPanel` is what `NavMenu` renders once its button is pressed. It
 * is rendered here on its own because the button cannot be pressed without a
 * DOM. **What this does not prove** is that pressing the button shows the
 * panel: that is `{open && <AccountMenuPanel … />}` in `NavMenu`, one line,
 * and only a browser can show it.
 */
describe("the open account menu, as it is drawn", () => {
  const drawn = (holder: Holder): string[] => {
    const markup = renderToStaticMarkup(
      createElement(AccountMenuPanel, {
        user: {
          displayName: "A member",
          name: null,
          handle: null,
          avatarUrl: null,
          isAdmin: holder.isAdmin,
          powers: [...holder.powers],
        },
        name: "A member",
        pathname: "/me",
        signOut: async () => {},
      })
    );
    return [...markup.matchAll(/href="(\/admin[^"]*)"/g)].map((match) => match[1]);
  };

  it.each(POWERS)("links the holder of %s to exactly what that power reaches", (power) => {
    expect(drawn(holding(power)).sort()).toEqual([...REACHES[power]].sort());
  });

  it("links an admin to all eleven", () => {
    expect(drawn(ADMIN).sort()).toEqual([...EVERYTHING].sort());
  });

  it("draws no admin link, and no Admin heading, for a member holding nothing", () => {
    const markup = renderToStaticMarkup(
      createElement(AccountMenuPanel, {
        user: { displayName: "A member", name: null, handle: null, avatarUrl: null, isAdmin: false, powers: [] },
        name: "A member",
        pathname: "/me",
        signOut: async () => {},
      })
    );

    expect(markup).not.toContain("/admin");
    expect(markup).not.toContain(">Admin<");
    // The member's own entries are untouched by any of this.
    expect(markup).toContain('href="/me/profile"');
  });

  it("draws the Admin heading for a holder of one power", () => {
    expect(
      renderToStaticMarkup(
        createElement(AccountMenuPanel, {
          user: {
            displayName: "A curator",
            name: null,
            handle: null,
            avatarUrl: null,
            isAdmin: false,
            powers: ["games.manage"],
          },
          name: "A curator",
          pathname: "/me",
          signOut: async () => {},
        })
      )
    ).toContain(">Admin<");
  });
});

/* ------------------------------------------------------------------ */
/* 3. The wiring                                                      */
/* ------------------------------------------------------------------ */

let handle: TestDatabase;
const ids = {} as Record<Power | "admin" | "nothing", string>;

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
});

afterAll(async () => {
  await handle.close();
});

type Sections = { sections: readonly { href: string }[] };
type MenuProps = Parameters<typeof NavMenu>[0];

/** The bar as the signed-in member's page renders it: the hrefs handed to the client row. */
async function bar(): Promise<string[]> {
  const element = (await AdminNav({})) as ReactElement<Sections>;
  expect(element.type).toBe(AdminNavLinks);
  return hrefs(element.props.sections);
}

/** The account menu's admin entries, worked out from what the header hands the menu. */
async function menu(): Promise<string[]> {
  const element = (await SessionNav()) as ReactElement<MenuProps>;
  expect(element.type).toBe(NavMenu);
  const { isAdmin, powers } = element.props.user;
  return hrefs(adminMenuFor({ isAdmin, powers: new Set(powers) }));
}

describe("the bar and the menu, for whoever is signed in", () => {
  it.each(POWERS)("show the holder of %s exactly what that power reaches", async (power) => {
    state.userId = ids[power];
    const expected = [...REACHES[power]].sort();

    expect((await bar()).sort()).toEqual(expected);
    expect((await menu()).sort()).toEqual(expected);
  });

  it("show an admin everything", async () => {
    state.userId = ids.admin;

    expect(await bar()).toEqual(EVERYTHING);
    expect((await menu()).sort()).toEqual([...EVERYTHING].sort());
  });

  it("show a member holding no power nothing", async () => {
    state.userId = ids.nothing;

    expect(await bar()).toEqual([]);
    expect(await menu()).toEqual([]);
  });

  it("stop showing a section the moment its power is taken away", async () => {
    // UC-56 3b: read on this request, never carried in the session.
    const { userPermissions } = await import("@/db");
    const id = await makeUser(handle.db, { displayName: "Briefly a curator" });
    await grantPower({ userId: id, power: "games.manage", grantedByUserId: ids.admin }, handle.db);
    state.userId = id;
    const before = await bar();

    await handle.db.delete(userPermissions).where(eq(userPermissions.userId, id));

    expect(before).toEqual(["/admin", "/admin/games"]);
    expect(await bar()).toEqual([]);
    expect(await menu()).toEqual([]);
  });
});
