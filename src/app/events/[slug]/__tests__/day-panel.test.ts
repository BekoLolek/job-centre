import { renderToReadableStream } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Database, eventDays } from "@/db";
import { type TestDatabase, freshDatabase } from "@/db/__tests__/helpers";
import { createEvent, publishEvent } from "@/lib/events";

/*
 * "When it runs" on the public event page: the fourth day-naming surface, and
 * the only one `src/components/__tests__/day-names.test.ts` cannot reach,
 * because the panel is inline JSX in an async server page rather than a
 * component anything can hand props to.
 *
 * It is here for the reason the other four are there: the panel names each day
 * from the day's **stored `dayIndex`**, not from its position in the list it
 * was handed. Those are the same number only while the list is whole and in
 * order — and `moveDaysInto` parks a row on a scratch index to break a rotation
 * cycle, so a failure part-way through a re-order leaves a gap. With the gap
 * there, a panel numbering by position renames every day after it, and this
 * panel would then disagree with the apply form, the schedule, a member's own
 * event card and the refusal a manager gets when the days are out of order.
 *
 * Mocked exactly as `unpublished.test.ts` mocks them, and for the same reason:
 * the session cookie and the page cache are the only things that cannot run
 * outside a Next request. The page itself is the real one.
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

/*
 * The page is rendered here, not just called, so the client components in it
 * run too — and `useRouter` throws outside a mounted router. Only that hook is
 * replaced: `notFound()` comes from this same module and is the page's own
 * answer to an event nobody may see (`unpublished.test.ts`), so the rest of it
 * has to stay real.
 */
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  };
});

const { default: EventPage } = await import("../page");

let handle: TestDatabase;
let slug: string;

beforeAll(async () => {
  handle = await freshDatabase();
  state.db = handle.db;

  const created = await createEvent(
    {
      title: "Day gap",
      signupOpensAt: new Date("2026-04-01T17:00:00Z"),
      signupClosesAt: new Date("2026-05-19T17:00:00Z"),
    },
    handle.db
  );
  if (!created.ok) throw new Error(created.error);
  slug = created.data.slug;

  /*
   * Two days, stored on indexes 1 and 3 — the gap a part-applied re-order
   * leaves behind. Written straight in rather than through `setEventDays`,
   * which renumbers every day from its position and so could not produce one.
   */
  await handle.db.insert(eventDays).values([
    { eventId: created.data.id, dayIndex: 1, startsAt: new Date("2026-05-21T17:00:00Z") },
    { eventId: created.data.id, dayIndex: 3, startsAt: new Date("2026-05-23T17:00:00Z") },
  ]);

  const published = await publishEvent(created.data.id, handle.db);
  if (!published.ok) throw new Error(published.error);
});

afterAll(async () => {
  await handle.close();
});

/**
 * The page as a visitor reads it: no tags, no entities.
 *
 * Streamed rather than `renderToStaticMarkup`'d, because the page's header is
 * itself an async server component and the synchronous renderer refuses a tree
 * that suspends. `onAllReady` — awaiting the stream to its end — is the
 * finished page.
 */
async function text(): Promise<string> {
  const page = await EventPage({
    params: Promise.resolve({ slug }),
    searchParams: Promise.resolve({}),
  });
  const stream = await renderToReadableStream(page);
  await stream.allReady;

  return (await new Response(stream).text())
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

describe("the public event page's day list", () => {
  it("names each day from its stored index, gap and all", async () => {
    const rendered = await text();

    expect(rendered).toContain("Day 2");
    expect(rendered).toContain("Day 4");
    // What numbering by position would have called them.
    expect(rendered).not.toContain("Day 1");
    expect(rendered).not.toContain("Day 3");
  });
});
