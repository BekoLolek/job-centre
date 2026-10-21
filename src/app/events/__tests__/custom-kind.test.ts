import { renderToReadableStream } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { type TestDatabase, freshDatabase } from "@/db/__tests__/helpers";
import { type EventResult, createEvent, publishEvent, updateEvent } from "@/lib/events";

/*
 * A kind that is not in the list (R-116 / UC-08 E4).
 *
 * > **E4.** At step 3, manager types a kind not in the list — System saves it
 * > and offers it as a filter **once an event of that kind is published**.
 *
 * `events.type` is free text so that "Among Us night" is a row rather than a
 * migration (§8.1), and `EVENT_TYPE_SUGGESTIONS` is only a suggestion list.
 * The half worth walking is the second clause and its qualifier: the filter is
 * built from the events actually on the page, so a kind arrives in the filter
 * strip on its own when the first event of it is published — and must *not*
 * arrive while that event is still a draft, which would advertise a filter
 * leading to an empty page.
 *
 * Mocked as `src/app/events/[slug]/__tests__/day-panel.test.ts` mocks: only
 * the session cookie and the page cache are replaced.
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

const { default: EventsPage } = await import("../page");

let harness: TestDatabase;
let db: Database;
let customId: string;

const WINDOW = {
  signupOpensAt: new Date("2000-01-01T00:00:00Z"),
  signupClosesAt: new Date("2100-01-01T00:00:00Z"),
  days: [{ startsAt: new Date("2100-01-02T18:00:00Z") }],
};

function expectOk<T>(result: EventResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got: ${result.error}`);
  return result.data;
}

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
  state.db = db;

  // One ordinary kind, published, so the filter strip has more than one entry
  // to show and is rendered at all.
  const ordinary = expectOk(
    await createEvent({ title: "Rivals night", type: "tournament", ...WINDOW }, db)
  );
  expectOk(await publishEvent(ordinary.id, db));

  // And the one-off, left as a draft to begin with.
  customId = expectOk(
    await createEvent({ title: "Among Us night", type: "among-us-night", ...WINDOW }, db)
  ).id;
});

afterAll(async () => {
  await harness.close();
});

/** `/events` as a visitor reads it: no tags, no entities. */
async function text(type?: string): Promise<string> {
  const page = await EventsPage({
    searchParams: Promise.resolve(type ? { type } : {}),
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

describe("UC-08 E4: a kind that is not in the list", () => {
  it("is saved as typed", async () => {
    // Not coerced to "custom", and not refused: a type is a label, not a code
    // branch (§8.1).
    const stored = expectOk(await updateEvent(customId, { type: "among-us-night" }, db));
    expect(stored.type).toBe("among-us-night");
  });

  it("is not offered as a filter while the event is only a draft", async () => {
    // The qualifier in E4. A filter nobody can reach anything through is worse
    // than no filter, and a draft is invisible on this page anyway.
    const rendered = await text();
    // The page is rendered and listing the kind that *is* published: a render
    // that failed would otherwise satisfy both refusals below. Not "All kinds"
    // — the strip appears only once two kinds are published, which is the next
    // test, so asserting it here would be asserting the opposite of E4.
    expect(rendered).toContain("Rivals night");
    expect(rendered).not.toContain("Among Us Night");
    expect(rendered).not.toContain("Among Us night");
  });

  it("is offered as a filter once an event of that kind is published", async () => {
    expectOk(await publishEvent(customId, db));

    const rendered = await text();
    // The label is built from the stored string by `eventTypeLabel`, which has
    // no entry for it and title-cases the words — so the filter reads as a
    // name rather than as a slug.
    expect(rendered).toContain("Among Us Night");
    expect(rendered).toContain("All kinds");
  });

  it("filters the list down to that kind", async () => {
    const rendered = await text("among-us-night");
    expect(rendered).toContain("Among Us night");
    expect(rendered).not.toContain("Rivals night");
  });

  it("still lists everything with no filter asked for", async () => {
    const rendered = await text();
    expect(rendered).toContain("Among Us night");
    expect(rendered).toContain("Rivals night");
  });
});
