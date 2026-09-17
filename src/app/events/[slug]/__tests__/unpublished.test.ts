import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { createEvent } from "@/lib/events";
import { addHost } from "@/lib/hosting";

/*
 * `/events/[slug]` and `/events/[slug]/apply` for an event nobody has published
 * yet, against an in-memory Postgres.
 *
 * Only the session cookie and the page cache are replaced, as in
 * `src/app/admin/events/__tests__/host-scope.test.ts`; the pages are the real ones,
 * so "not found" is the page's own `notFound()` and not a stand-in.
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

const { default: EventPage } = await import("../page");
const { default: ApplyPage } = await import("../apply/page");

let handle: TestDatabase;
let slug: string;
let host: string;

beforeAll(async () => {
  handle = await freshDatabase();
  state.db = handle.db;

  const created = await createEvent({ title: "Half written" }, handle.db);
  if (!created.ok) throw new Error(created.error);
  slug = created.data.slug;
  host = await makeUser(handle.db);
  await addHost(created.data.id, host, null, handle.db);
});

afterAll(async () => {
  await handle.close();
});

function open() {
  return EventPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({}) });
}

describe("an unpublished event's page", () => {
  it("opens for the host of that event", async () => {
    state.userId = host;

    await expect(open()).resolves.toBeTruthy();
  });

  it("is not found for another member", async () => {
    state.userId = await makeUser(handle.db);

    await expect(open()).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });

  it("is not found signed out", async () => {
    state.userId = null;

    await expect(open()).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });
});

describe("an unpublished event's apply page", () => {
  function openApply() {
    return ApplyPage({ params: Promise.resolve({ slug }) });
  }

  it("opens for the host of that event", async () => {
    state.userId = host;

    await expect(openApply()).resolves.toBeTruthy();
  });

  it("is not found for another member", async () => {
    state.userId = await makeUser(handle.db);

    await expect(openApply()).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });
});
