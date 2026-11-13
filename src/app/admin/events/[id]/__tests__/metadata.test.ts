import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, events, users } from "@/db";
import { type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";

/*
 * The tab title of `/admin/events/[id]`, and who it is read for (Task 133).
 *
 * `generateMetadata` runs for the same request as the page, and before this
 * test it read the event by id with no guard. The page component redirects a
 * stranger - but on a `redirect()` Next sends the 307 *and* an error-document
 * body whose head is built from the page's resolved metadata, so
 * `<title>{title} · Admin</title>` went out to anybody holding an id: the
 * title of an event in any status, unpublished included, and an answer to
 * "is this id real". Invisible in a browser, plain to `curl`.
 *
 * So the question asked here is not what the title says. It is **whether the
 * read happens at all** for somebody the page would turn away - a redirect
 * thrown after the read would look the same from outside this function and
 * would still have touched the row.
 *
 * Mocked as `status.test.ts` does it: who is signed in, and `@/db`'s handle.
 * `getEventById` is wrapped rather than replaced, so it still reads for real
 * and the test can ask whether it was called.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
}));

const read = vi.hoisted(() => ({ event: vi.fn() }));

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

vi.mock("@/lib/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/events")>();
  read.event.mockImplementation(actual.getEventById);
  return { ...actual, getEventById: read.event };
});

const { generateMetadata } = await import("../page");

const TO_SIGN_IN = { digest: expect.stringMatching(/^NEXT_REDIRECT;[a-z]+;\/signin/) };
const TO_THE_HUB = { digest: expect.stringMatching(/^NEXT_REDIRECT;[a-z]+;\/me;/) };

let handle: TestDatabase;
let eventId: string;
let host: string;
let admin: string;
let member: string;

beforeAll(async () => {
  handle = await freshDatabase();
  state.db = handle.db;

  // A draft: the status in which the title is nobody's business but its managers'.
  const [event] = await handle.db
    .insert(events)
    .values({ slug: "unannounced", title: "Not announced yet", status: "draft" })
    .returning({ id: events.id });
  eventId = event.id;

  host = await makeUser(handle.db, { displayName: "Its host" });
  await makeHost(handle.db, eventId, host);
  admin = await makeUser(handle.db, { displayName: "An admin" });
  await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, admin));
  member = await makeUser(handle.db, { displayName: "A member" });
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  read.event.mockClear();
});

function titleFor(id: string) {
  return generateMetadata({ params: Promise.resolve({ id }) });
}

describe("the tab title of an event's admin page", () => {
  it("is not read for a visitor who is signed out", async () => {
    state.userId = null;

    await expect(titleFor(eventId)).rejects.toMatchObject(TO_SIGN_IN);
    expect(read.event).not.toHaveBeenCalled();
  });

  it("is not read for a member who does not manage the event", async () => {
    state.userId = member;

    await expect(titleFor(eventId)).rejects.toMatchObject(TO_THE_HUB);
    expect(read.event).not.toHaveBeenCalled();
  });

  it("is not read for somebody who hosts a different event", async () => {
    // Holding a host row is not the question; holding this event's is. The
    // case a change to `canManageEvent` would be most likely to get wrong.
    const [other] = await handle.db
      .insert(events)
      .values({ slug: "somebody-elses", title: "Somebody else's night", status: "draft" })
      .returning({ id: events.id });
    const otherHost = await makeUser(handle.db, { displayName: "Another event's host" });
    await makeHost(handle.db, other.id, otherHost);
    state.userId = otherHost;

    await expect(titleFor(eventId)).rejects.toMatchObject(TO_THE_HUB);
    expect(read.event).not.toHaveBeenCalled();
  });

  it("names the event for its host", async () => {
    state.userId = host;

    await expect(titleFor(eventId)).resolves.toEqual({ title: "Not announced yet · Admin" });
  });

  it("names the event for an admin", async () => {
    state.userId = admin;

    await expect(titleFor(eventId)).resolves.toEqual({ title: "Not announced yet · Admin" });
  });

  it("falls back to a plain title when an admin opens an id that is not an event", async () => {
    state.userId = admin;

    await expect(titleFor("00000000-0000-4000-8000-000000000000")).resolves.toEqual({
      title: "Event · Admin",
    });
  });
});
