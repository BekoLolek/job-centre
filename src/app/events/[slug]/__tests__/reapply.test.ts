import { eq } from "drizzle-orm";
import { renderToReadableStream } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Database, applications } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  type EventResult,
  applyToEvent,
  createEvent,
  publishEvent,
  setApplicationStatus,
  withdrawApplication,
} from "@/lib/events";

/*
 * Applying again, and not being able to (R-121, R-122 / UC-12 E1, E2).
 *
 * > **E1.** Precondition 2 fails because the member withdrew earlier — System
 * > lets them apply again; they go to the back of the queue.
 * >
 * > **E2.** Precondition 2 fails because the member was declined — System
 * > refuses with "You were declined for this event" and offers no form.
 *
 * R-122 is marked "Beats R-121", so the two have to be told apart by every
 * surface that acts on either: the write, which must let one through and not
 * the other, and the page, which must offer a form for one and not the other.
 * `events.test.ts` pins the two refusals at the write; what it does not pin is
 * **"the back of the queue"** — a re-application that kept its old position
 * would be a member jumping the people who queued behind them while they were
 * gone — or either page.
 *
 * Mocked as the sibling page tests mock: only the session cookie and the page
 * cache cannot run outside a Next request.
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

const { default: ApplyPage } = await import("../apply/page");

let harness: TestDatabase;
let db: Database;

/*
 * Wide enough never to be the thing under test, and wide against the *real*
 * clock: the pages below read `new Date()` themselves, so a window pinned to a
 * fixed `now` would have the apply page reporting sign-ups closed and the test
 * passing for the wrong reason.
 */
const WINDOW = {
  signupOpensAt: new Date("2000-01-01T00:00:00Z"),
  signupClosesAt: new Date("2100-01-01T00:00:00Z"),
  days: [{ startsAt: new Date("2100-01-02T18:00:00Z") }],
};

function expectOk<T>(result: EventResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got: ${result.error}`);
  return result.data;
}

function expectFail<T>(result: EventResult<T>): { error: string } {
  if (result.ok) throw new Error("Expected a refusal, got success");
  return result;
}

let counter = 0;

/** A published, open event with `capacity` seats. */
async function openEvent(capacity: number): Promise<{ id: string; slug: string }> {
  counter += 1;
  const created = expectOk(
    await createEvent({ title: `Reapply ${counter}`, capacity, ...WINDOW }, db)
  );
  expectOk(await publishEvent(created.id, db));
  return { id: created.id, slug: created.slug };
}

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
  state.db = db;
});

afterAll(async () => {
  await harness.close();
});

/** The apply page as that member reads it: no tags, no entities. */
async function text(slug: string): Promise<string> {
  const page = await ApplyPage({ params: Promise.resolve({ slug }) });
  const stream = await renderToReadableStream(page);
  await stream.allReady;

  return (await new Response(stream).text())
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* UC-12 E1 — withdrew, so applying again is fine                    */
/* ------------------------------------------------------------------ */

describe("UC-12 E1: a member who withdrew earlier", () => {
  it("may apply again", async () => {
    const event = await openEvent(4);
    const userId = await makeUser(db);

    const first = expectOk(await applyToEvent(event.id, userId, {}, db));
    expectOk(await withdrawApplication(event.id, userId, db));

    const again = expectOk(await applyToEvent(event.id, userId, {}, db));
    expect(again.status).toBe("accepted");
  });

  it("goes to the BACK of the queue, behind whoever joined meanwhile", async () => {
    // Two seats, the minimum an event may have (R-26). The returner was at the
    // front of the queue before they left, and two people queued behind them
    // while they were gone.
    const event = await openEvent(2);
    const seatedOne = await makeUser(db, { displayName: "Seated One" });
    const seatedTwo = await makeUser(db, { displayName: "Seated Two" });
    const returner = await makeUser(db, { displayName: "Returner" });
    const second = await makeUser(db, { displayName: "Second" });
    const third = await makeUser(db, { displayName: "Third" });

    expectOk(await applyToEvent(event.id, seatedOne, {}, db));
    expectOk(await applyToEvent(event.id, seatedTwo, {}, db));
    const theirs = expectOk(await applyToEvent(event.id, returner, {}, db));
    expect(theirs.waitlistPosition).toBe(1);

    expectOk(await withdrawApplication(event.id, returner, db));
    expectOk(await applyToEvent(event.id, second, {}, db));
    expectOk(await applyToEvent(event.id, third, {}, db));

    const back = expectOk(await applyToEvent(event.id, returner, {}, db));
    expect(back.status).toBe("waitlisted");
    // Third of three, not first again.
    expect(back.waitlistPosition).toBe(3);
  });

  it("is offered the form, and told what applying again costs", async () => {
    const event = await openEvent(4);
    const userId = await makeUser(db);
    const first = expectOk(await applyToEvent(event.id, userId, {}, db));
    expectOk(await withdrawApplication(event.id, userId, db));

    state.userId = userId;
    const rendered = await text(event.slug);

    expect(rendered).toContain("You withdrew from this one before");
    expect(rendered).toContain("back of whatever queue exists now");
    // The form itself, not only a sentence about it.
    expect(rendered).toContain("Which days can you make");
  });
});

/* ------------------------------------------------------------------ */
/* UC-12 E2 — declined, so there is no way back in from here         */
/* ------------------------------------------------------------------ */

describe("UC-12 E2: a member who was declined", () => {
  it("is refused by the write, saying so", async () => {
    const event = await openEvent(4);
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, {}, db));
    expectOk(await setApplicationStatus(application.id, "declined", {}, db));

    expect(expectFail(await applyToEvent(event.id, userId, {}, db)).error).toMatch(
      /declined/i
    );
  });

  it("is offered no form", async () => {
    const event = await openEvent(4);
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, {}, db));
    expectOk(await setApplicationStatus(application.id, "declined", {}, db));

    state.userId = userId;
    const rendered = await text(event.slug);

    expect(rendered).toContain("This one was declined");
    expect(rendered).not.toContain("Which days can you make");
    // Not even the "you withdrew" door: R-122 beats R-121, so a member who
    // withdrew and was then declined is declined.
    expect(rendered).not.toContain("You withdrew from this one before");
  });

  it("beats a later withdrawal, at the write and on the page", async () => {
    // The ordering R-122 settles. A decline that a withdrawal could undo would
    // make the decision a suggestion.
    const event = await openEvent(4);
    const userId = await makeUser(db);
    const application = expectOk(await applyToEvent(event.id, userId, {}, db));
    expectOk(await setApplicationStatus(application.id, "declined", {}, db));

    // Refused by the withdrawal itself, asserted on the call rather than only
    // on what comes after it: a `withdrawApplication` that returned `ok` and
    // wrote the row would be caught two lines down by the apply refusal only
    // for as long as `applyToEvent` keeps turning withdrawn members away —
    // which is exactly the thing R-121 says it must not do.
    const refused = await withdrawApplication(event.id, userId, db);
    expect(refused.ok).toBe(false);
    expect(expectFail(refused).error).toMatch(/declined/i);
    // And the row is untouched: the decision still stands in the database.
    const [row] = await db
      .select({ status: applications.status })
      .from(applications)
      .where(eq(applications.id, application.id));
    expect(row.status).toBe("declined");

    expect(expectFail(await applyToEvent(event.id, userId, {}, db)).error).toMatch(
      /declined/i
    );

    state.userId = userId;
    expect(await text(event.slug)).not.toContain("Which days can you make");
  });
});
