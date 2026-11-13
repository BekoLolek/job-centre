import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, championships, users } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";

/*
 * The tab title of `/admin/championships/[id]`, and who it is read for
 * (Task 133).
 *
 * The same defect as `src/app/admin/events/[id]/__tests__/metadata.test.ts`,
 * which says at length why a redirect is not enough: `generateMetadata` read
 * the season by id with no guard, and Next puts the resolved title in the body
 * of the 307 the page component answers a stranger with. Here that was the
 * name of any season, hidden ones included.
 *
 * What is asserted is that **the read does not happen** for somebody the page
 * turns away. `getChampionship` is wrapped rather than replaced, so it still
 * reads for real and the test can ask whether it was called.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
}));

const read = vi.hoisted(() => ({ season: vi.fn() }));

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

vi.mock("@/lib/championships", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/championships")>();
  read.season.mockImplementation(actual.getChampionship);
  return { ...actual, getChampionship: read.season };
});

const { generateMetadata } = await import("../page");

const TO_SIGN_IN = { digest: expect.stringMatching(/^NEXT_REDIRECT;[a-z]+;\/signin/) };
const ADMIN_ONLY = { digest: expect.stringMatching(/^NEXT_REDIRECT;[a-z]+;\/signin\?error=/) };

let handle: TestDatabase;
let seasonId: string;
let admin: string;
let member: string;

beforeAll(async () => {
  handle = await freshDatabase();
  state.db = handle.db;

  // Left as a draft: a hidden season is the one whose name must not get out.
  const [season] = await handle.db
    .insert(championships)
    .values({ slug: "still-argued-about", name: "Still being argued about" })
    .returning({ id: championships.id });
  seasonId = season.id;

  admin = await makeUser(handle.db, { displayName: "An admin" });
  await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, admin));
  member = await makeUser(handle.db, { displayName: "A member" });
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  read.season.mockClear();
});

function titleFor(id: string) {
  return generateMetadata({ params: Promise.resolve({ id }) });
}

describe("the tab title of a championship's admin page", () => {
  it("is not read for a visitor who is signed out", async () => {
    state.userId = null;

    await expect(titleFor(seasonId)).rejects.toMatchObject(TO_SIGN_IN);
    expect(read.season).not.toHaveBeenCalled();
  });

  it("is not read for a member who is not an admin", async () => {
    state.userId = member;

    await expect(titleFor(seasonId)).rejects.toMatchObject(ADMIN_ONLY);
    expect(read.season).not.toHaveBeenCalled();
  });

  it("names the season for an admin", async () => {
    state.userId = admin;

    await expect(titleFor(seasonId)).resolves.toEqual({ title: "Still being argued about · Admin" });
  });

  it("falls back to a plain title when an admin opens an id that is not a season", async () => {
    state.userId = admin;

    await expect(titleFor("00000000-0000-4000-8000-000000000000")).resolves.toEqual({
      title: "Championship · Admin",
    });
  });
});
