import { renderToReadableStream } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  createEvent,
  publishEvent,
  setApplicationStatus,
  updateEvent,
} from "@/lib/events";

/*
 * The public event page's "Who's in" tab and its banner (R-118, R-113).
 *
 * > **UC-11 E1.** Visitor views who is in — System lists members holding a
 * > seat (accepted), not the waitlist.
 * >
 * > **UC-08 E1.** At step 3, manager adds a banner image — System shows it on
 * > the event page and its front-page card.
 *
 * Both are flows nobody had walked. E1 is the one with teeth: the list is a
 * visitor-readable roll of real names, so "not the waitlist" is a privacy
 * promise and not a layout preference — somebody queueing for an event has not
 * agreed to be announced as attending it, and a manager reading the page has
 * to be able to trust the number against the seats.
 *
 * Driven through `setApplicationStatus` rather than by writing statuses in, so
 * the seat counts the page shows are the ones the real writes produce.
 *
 * Mocked exactly as `day-panel.test.ts` mocks, and for the same reasons: only
 * the session cookie and the page cache cannot run outside a Next request, and
 * `useRouter` throws outside a mounted router. `notFound()` stays real.
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

let harness: TestDatabase;
let slug: string;
let eventId: string;

const SEATED = ["Seated Sam", "Seated Sal"];
const QUEUED = ["Queued Quinn", "Queued Qasim"];

beforeAll(async () => {
  harness = await freshDatabase();
  state.db = harness.db;

  const created = await createEvent(
    {
      title: "Who is in",
      // Two seats, so the third and fourth application queues itself rather
      // than being put there by hand.
      capacity: 2,
      signupOpensAt: new Date("2000-01-01T00:00:00Z"),
      signupClosesAt: new Date("2100-01-01T00:00:00Z"),
      days: [{ startsAt: new Date("2100-01-02T18:00:00Z") }],
    },
    harness.db
  );
  if (!created.ok) throw new Error(created.error);
  eventId = created.data.id;
  slug = created.data.slug;

  const published = await publishEvent(eventId, harness.db);
  if (!published.ok) throw new Error(published.error);

  // Accepted first so they take the two seats, then the queue behind them.
  for (const displayName of [...SEATED, ...QUEUED]) {
    const userId = await makeUser(harness.db, { displayName });
    const { applyToEvent } = await import("@/lib/events");
    const applied = await applyToEvent(eventId, userId, {}, harness.db);
    if (!applied.ok) throw new Error(`${displayName}: ${applied.error}`);
  }
});

afterAll(async () => {
  await harness.close();
});

/** The page as a signed-out visitor reads it: no tags, no entities. */
async function text(tab?: string): Promise<string> {
  const page = await EventPage({
    params: Promise.resolve({ slug }),
    searchParams: Promise.resolve(tab ? { tab } : {}),
  });
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

/** The raw markup, for assertions about an attribute rather than a word. */
async function markup(): Promise<string> {
  const page = await EventPage({
    params: Promise.resolve({ slug }),
    searchParams: Promise.resolve({}),
  });
  const stream = await renderToReadableStream(page);
  await stream.allReady;
  return await new Response(stream).text();
}

/* ------------------------------------------------------------------ */
/* UC-11 E1                                                           */
/* ------------------------------------------------------------------ */

describe("UC-11 E1: who is in", () => {
  it("is offered as a tab once anybody has applied", async () => {
    expect(await text()).toContain("Who's in");
  });

  it("names the members holding a seat", async () => {
    const rendered = await text("who");
    for (const name of SEATED) expect(rendered).toContain(name);
  });

  it("names nobody on the waitlist", async () => {
    // The promise. A queue place is not an attendance announcement.
    const rendered = await text("who");
    // The seated names first: a tab that failed to render, or a list that came
    // back empty, would satisfy every refusal below and say nothing at all.
    for (const name of SEATED) expect(rendered).toContain(name);
    for (const name of QUEUED) expect(rendered).not.toContain(name);
  });

  it("says how many are waiting without saying who", async () => {
    const rendered = await text("who");
    expect(rendered).toContain("2 people waiting in the queue");
  });

  it("counts the tab from the seats, not from the applications", async () => {
    // Four applications, two seats. A count taken off the list length would
    // read 4 here and disagree with both the seat count and the names below.
    expect(await text()).toContain("Who's in 2");
  });

  it("moves a name out of the list when the seat goes", async () => {
    // So the assertions above are about status and not about insertion order.
    const { getApplicationsForEvent } = await import("@/lib/events");
    const applicants = await getApplicationsForEvent(eventId, harness.db);
    const sam = applicants.find((row) => row.member.displayName === "Seated Sam");
    if (!sam) throw new Error("fixture lost Sam");

    const declined = await setApplicationStatus(sam.id, "declined", {}, harness.db);
    if (!declined.ok) throw new Error(declined.error);

    const rendered = await text("who");
    expect(rendered).not.toContain("Seated Sam");
    // And his seat promoted the front of the queue, who is now named (R-55).
    expect(rendered).toContain("Queued Quinn");
    expect(rendered).not.toContain("Queued Qasim");
  });
});

/* ------------------------------------------------------------------ */
/* UC-08 E1                                                           */
/* ------------------------------------------------------------------ */

describe("UC-08 E1: the banner", () => {
  it("shows nothing where no banner is set", async () => {
    const rendered = await markup();
    // The page itself, so "no banner" is a fact about the banner and not about
    // a render that never happened.
    expect(rendered).toContain("Who is in");
    expect(rendered).not.toContain("background-image");
  });

  it("shows it on the event page once there is one", async () => {
    const updated = await updateEvent(
      eventId,
      { bannerUrl: "https://cdn.example.test/spring.png" },
      harness.db
    );
    if (!updated.ok) throw new Error(updated.error);

    const rendered = await markup();
    expect(rendered).toContain("background-image");
    expect(rendered).toContain("https://cdn.example.test/spring.png");
  });
});
