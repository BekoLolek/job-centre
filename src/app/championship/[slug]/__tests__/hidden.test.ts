import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, championships, users } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { createChampionship, getChampionship } from "@/lib/championships";

/*
 * `/championship/[slug]` for a season nobody has published (R-189, UC-31 5a),
 * against an in-memory Postgres.
 *
 * `publicSeason` is pinned at the library boundary in
 * `src/lib/__tests__/championship-season.test.ts`, and that is a different
 * question from this one: the route has to *ask* it, with the right viewer,
 * and then turn the null into a 404. Nothing was exercising either half. The
 * one that most deserved a test is `generateMetadata`, which asks as a visitor
 * on purpose — page metadata is cached and shared, so an admin's answer would
 * be served to everybody — and "as a visitor" is a single literal that a
 * refactor to `user?.isAdmin` would make look like a tidy-up while putting a
 * hidden season's name in a `<title>` the whole internet can read.
 *
 * Only the session cookie is replaced, as in
 * `src/app/events/[slug]/__tests__/unpublished.test.ts`; the page is the real
 * one, so "not found" is its own `notFound()` and not a stand-in.
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

const { default: ChampionshipPage, generateMetadata } = await import("../page");

/** The 404 `notFound()` throws, as it reaches a caller. */
const NOT_FOUND = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };

let handle: TestDatabase;
let hidden: string;
let published: string;
let publishedName: string;
let admin: string;
let member: string;

/** Create a season and hand back its slug, published or left as a draft. */
async function season(name: string, publish: boolean): Promise<string> {
  const made = await createChampionship({ name }, handle.db);
  if (!made.ok) throw new Error(made.error);
  if (publish) {
    await handle.db
      .update(championships)
      .set({ status: "published" })
      .where(eq(championships.id, made.data.id));
  }
  const row = await getChampionship(made.data.id, handle.db);
  if (!row) throw new Error("no such season");
  return row.slug;
}

beforeAll(async () => {
  handle = await freshDatabase();
  state.db = handle.db;

  hidden = await season("Still being argued about", false);
  publishedName = "Autumn 2026";
  published = await season(publishedName, true);

  admin = await makeUser(handle.db, { displayName: "An admin" });
  await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, admin));
  member = await makeUser(handle.db, { displayName: "A member" });
});

afterAll(async () => {
  await handle.close();
});

function open(slug: string) {
  return ChampionshipPage({ params: Promise.resolve({ slug }) });
}

describe("a hidden season's page", () => {
  it("is not found for a visitor who guesses the slug", async () => {
    state.userId = null;

    await expect(open(hidden)).rejects.toMatchObject(NOT_FOUND);
  });

  it("is not found for a signed-in member who is not an admin", async () => {
    // The difference between this and the one above is the whole reason the
    // page asks `getCurrentUser()` rather than "is anybody signed in".
    state.userId = member;

    await expect(open(hidden)).rejects.toMatchObject(NOT_FOUND);
  });

  it("opens for an admin, who is the person still writing it", async () => {
    state.userId = admin;

    await expect(open(hidden)).resolves.toBeTruthy();
  });

  it("opens for anybody once the season is published", async () => {
    state.userId = null;

    await expect(open(published)).resolves.toBeTruthy();
  });
});

describe("the page title for a hidden season", () => {
  /** What `generateMetadata` answers for this slug. */
  function titleFor(slug: string) {
    return generateMetadata({ params: Promise.resolve({ slug }) });
  }

  it("names a published season, so the generic title means something", async () => {
    state.userId = null;

    await expect(titleFor(published)).resolves.toMatchObject({
      title: `${publishedName} · Job Centre Events`,
    });
  });

  it("stays generic for a hidden season", async () => {
    state.userId = null;

    await expect(titleFor(hidden)).resolves.toEqual({
      title: "Championship · Job Centre Events",
    });
  });

  it("stays generic for an admin the page itself opens for", async () => {
    /*
     * The invariant, rather than a second signed-out case wearing an admin's
     * session. `generateMetadata` never calls `getCurrentUser`, so setting one
     * proves nothing on its own — the earlier version of this test asserted
     * exactly what the visitor case above asserts, and both failed with the
     * same diff under the same mutation.
     *
     * What is actually true is that the two halves of one route *disagree*, on
     * purpose and for the same slug and the same reader: metadata is cached and
     * served to everybody, so it answers as a visitor would be answered
     * (`{ isAdmin: false }`) and stays nameless, while the page in front of that
     * same admin opens and shows them their draft. A refactor to
     * `user?.isAdmin` in `generateMetadata` reads like a tidy-up and puts a
     * hidden season's name in a `<title>` the whole internet can read; it is
     * this disagreement that catches it.
     */
    state.userId = admin;

    await expect(open(hidden)).resolves.toBeTruthy();
    await expect(titleFor(hidden)).resolves.toEqual({
      title: "Championship · Job Centre Events",
    });
  });
});
