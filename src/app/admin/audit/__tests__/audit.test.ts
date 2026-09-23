import { eq } from "drizzle-orm";
import { type ReactElement, type ReactNode, isValidElement } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, auditLog, events, users } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { Alert } from "@/components/ui";

/*
 * `/admin/audit` — the event filter (Task 28, R-110 / UC-27 3).
 *
 * Two things the pure resolver cannot prove on its own: that the filter offers
 * **every** event rather than the twelve newest, and that an id naming no
 * event reads nothing and says so instead of quietly listing the whole log.
 * Both are properties of the page, so the page is what is rendered.
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

/*
 * `listAudit` is the real one, wrapped so the page's calls can be counted.
 *
 * "Reads nothing" is a claim about a call that does not happen, and no
 * assertion about what is rendered can make it: rewrite the page to read the
 * log and throw the rows away and every screen below still looks right. The
 * spy is the only thing that tells the two apart.
 */
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, listAudit: vi.fn(actual.listAudit) };
});

const { default: AdminAuditPage } = await import("../page");
const { listAudit, recordAudit } = await import("@/lib/audit");
const { createEvent } = await import("@/lib/events");

let handle: TestDatabase;
let db: Database;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
  const admin = await makeUser(db, { displayName: "Admin" });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin));
  state.userId = admin;
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  vi.mocked(listAudit).mockClear();
  await db.delete(auditLog);
  await db.delete(events);
});

/* ------------------------------------------------------------------ */
/* Walking the tree                                                   */
/* ------------------------------------------------------------------ */

/**
 * Is this an async server component?
 *
 * They are skipped rather than called. `AppHeader` renders `<SessionNav />`,
 * which reads the session and counts notifications; calling it here starts a
 * query nothing awaits, and it lands after the harness has closed its
 * database. Nothing this file asserts on is inside one.
 */
function isAsync(type: unknown): boolean {
  return typeof type === "function" && type.constructor?.name === "AsyncFunction";
}

/** Every element, expanding the synchronous components on the way down. */
function* walk(node: ReactNode): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!isValidElement(node)) return;
  const element = node as ReactElement<Record<string, unknown>>;
  yield element;

  if (typeof element.type === "function" && !isAsync(element.type)) {
    let rendered: ReactNode = null;
    try {
      rendered = (element.type as (props: unknown) => ReactNode)(element.props);
    } catch {
      // `next/link` is not callable outside React either.
      yield* walk(element.props.children as ReactNode);
      return;
    }
    yield* walk(rendered);
    return;
  }
  yield* walk(element.props.children as ReactNode);
}

function findAll(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>>[] {
  return [...walk(node)].filter((element) => element.type === type);
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isValidElement(node)) return "";
  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === "function" && !isAsync(element.type)) {
    try {
      return textOf((element.type as (props: unknown) => ReactNode)(element.props));
    } catch {
      return textOf(element.props.children as ReactNode);
    }
  }
  return textOf(element.props.children as ReactNode);
}

async function render(params: Record<string, string | undefined> = {}): Promise<ReactNode> {
  return AdminAuditPage({ searchParams: Promise.resolve(params) });
}

/** The values the filter offers, in the order the page lists them. */
function optionValues(page: ReactNode): string[] {
  return findAll(page, "option").map((option) => String(option.props.value ?? ""));
}

/** One line of the log, against an event or against nothing. */
async function line(summary: string, eventId: string | null): Promise<void> {
  await recordAudit({ action: "event.status", summary, eventId }, db);
}

async function anEvent(title: string): Promise<string> {
  const created = await createEvent({ ...PUBLISHABLE, title }, db);
  if (!created.ok) throw new Error(created.error);
  return created.data.id;
}

/* ------------------------------------------------------------------ */
/* The filter covers all the events                                   */
/* ------------------------------------------------------------------ */

describe("the event filter", () => {
  it("offers every event, not the first screenful of them", async () => {
    /*
     * The page listed `events.slice(0, 12)` as chips, so on a site with more
     * than twelve events the older ones could not be filtered to from this
     * page at all — and an audit log's job is questions about things that have
     * already finished, which are exactly the events that fall off the end.
     */
    const ids: string[] = [];
    for (let index = 0; index < 15; index += 1) ids.push(await anEvent(`Event ${index}`));

    const values = optionValues(await render());

    for (const id of ids) expect(values).toContain(id);
    // Plus the one that means no filter at all.
    expect(values).toContain("");
  });

  it("filters the log to the event asked for", async () => {
    const wanted = await anEvent("Summer Cup");
    const other = await anEvent("Winter Cup");
    await line("about summer", wanted);
    await line("about winter", other);

    const text = textOf(await render({ event: wanted }));

    expect(text).toContain("about summer");
    expect(text).not.toContain("about winter");
  });

  it("shows everything with no filter", async () => {
    const wanted = await anEvent("Summer Cup");
    await line("about summer", wanted);
    await line("about nothing in particular", null);

    const text = textOf(await render());

    expect(text).toContain("about summer");
    expect(text).toContain("about nothing in particular");
  });
});

/* ------------------------------------------------------------------ */
/* An unknown id says so — UC-27 3                                    */
/* ------------------------------------------------------------------ */

describe("a filter that names no event", () => {
  it("says so instead of showing the whole log", async () => {
    const real = await anEvent("Summer Cup");
    await line("about summer", real);
    await line("about nothing in particular", null);

    const page = await render({ event: "not-a-uuid" });
    const text = textOf(page);

    // Nothing was read — asserted on the call, because a page that read the
    // whole log and then rendered none of it passes every line below.
    expect(listAudit).not.toHaveBeenCalled();
    expect(text).not.toContain("about summer");
    expect(text).not.toContain("about nothing in particular");
    expect(findAll(page, Alert)).toHaveLength(1);
    expect(text).toMatch(/does not name an event/i);
  });

  it("reads the log for every filter that does name one", async () => {
    /*
     * The other half of the assertion above, and the reason it means
     * something: the spy is wired to the call the page actually makes, so
     * `not.toHaveBeenCalled()` is a fact about this page rather than about a
     * mock nothing reaches.
     */
    const real = await anEvent("Summer Cup");

    await render({ event: real });
    expect(listAudit).toHaveBeenCalledTimes(1);

    await render();
    expect(listAudit).toHaveBeenCalledTimes(2);
  });

  it("does not call the scope Everything", async () => {
    // The misreading this exists to stop: a heading saying "Everything" over
    // a list the reader asked to be one event's.
    const text = textOf(await render({ event: "not-a-uuid" }));
    expect(text).toMatch(/No such event/i);
  });

  it("treats an id for an event that has been deleted the same way", async () => {
    const gone = await anEvent("Cancelled and cleared");
    await db.delete(events).where(eq(events.id, gone));

    const text = textOf(await render({ event: gone }));

    expect(text).toMatch(/does not name an event/i);
  });

  it("still offers the way back to the whole log", async () => {
    const page = await render({ event: "not-a-uuid" });
    expect(optionValues(page)).toContain("");
  });
});
