import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  type Database,
  type ChampionshipStatusValue,
  auditLog,
  championshipEvents,
  championships,
  events,
  users,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";

/*
 * `/admin/championships`' actions, for real against an in-memory Postgres.
 * Mocked as `status.test.ts` does it: who is signed in, `@/db`'s handle and the
 * page cache. What is under test here is the half that only the action layer
 * knows — who acted, and what the log says about it.
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

const { createChampionshipAction, saveChampionshipAction, setChampionshipStatusAction } =
  await import("../actions");

let handle: TestDatabase;
let db: Database;
let adminId: string;
let counter = 0;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
  adminId = await makeUser(db, { displayName: "Reopening Rita" });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  state.userId = adminId;
});

/** A season in the given status, named so the open-name index never bites. */
async function seasonIn(status: ChampionshipStatusValue): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(championships)
    .values({ slug: `action-${counter}`, name: `Action season ${counter}`, status })
    .returning({ id: championships.id });
  return row.id;
}

function auditFor(championshipId: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.subject, championshipId), eq(auditLog.action, action)));
}

describe("creating a season", () => {
  it("saves it hidden and writes a log line naming who made it", async () => {
    // UC-31 1-2.
    counter += 1;
    const name = `Made by an admin ${counter}`;

    const result = await createChampionshipAction({ name, description: null });

    expect(result.ok).toBe(true);
    const id = result.ok ? result.data.id : "";
    expect((await db.select().from(championships).where(eq(championships.id, id)))[0].status).toBe(
      "hidden"
    );
    const lines = await auditFor(id, "championship.created");
    expect(lines).toHaveLength(1);
    expect(lines[0].actorUserId).toBe(adminId);
    expect(lines[0].summary).toContain(name);
  });

  it("refuses a nameless season and logs nothing", async () => {
    // UC-31 1a.
    const before = await db.select().from(auditLog);

    const result = await createChampionshipAction({ name: "" });

    expect(result.ok).toBe(false);
    expect(await db.select().from(auditLog)).toHaveLength(before.length);
  });
});

describe("saving the scoring rules", () => {
  it("logs nothing when the save is refused", async () => {
    // What the rules *are* is `championships.test.ts`'s; what only this layer
    // can say is that a refusal leaves no trace of a change that never happened.
    const id = await seasonIn("hidden");

    const result = await saveChampionshipAction(id, { pointsTable: [5, 9] });

    expect(result.ok).toBe(false);
    expect(await auditFor(id, "championship.updated")).toEqual([]);
  });
});

describe("ending the season", () => {
  it("names the unscored counting event and refuses until the admin confirms", async () => {
    // UC-35 1a.
    const id = await seasonIn("published");
    counter += 1;
    const [event] = await db
      .insert(events)
      .values({ slug: `action-event-${counter}`, title: "Jackbox evening" })
      .returning({ id: events.id });
    await db.insert(championshipEvents).values({ championshipId: id, eventId: event.id });

    const asked = await setChampionshipStatusAction(id, "published", "closed", {});
    const confirmed = await setChampionshipStatusAction(id, "published", "closed", {
      confirm: true,
    });

    expect(asked.ok).toBe(false);
    expect(!asked.ok && asked.unscored?.map((row) => row.title)).toEqual(["Jackbox evening"]);
    expect(confirmed.ok).toBe(true);
    expect(await auditFor(id, "championship.status")).toHaveLength(1);
  });

  it("records who reopened it", async () => {
    // UC-35 2a.
    const id = await seasonIn("closed");

    const result = await setChampionshipStatusAction(id, "closed", "published", {});

    expect(result.ok).toBe(true);
    const lines = await auditFor(id, "championship.reopened");
    expect(lines).toHaveLength(1);
    expect(lines[0].actorUserId).toBe(adminId);
    expect(lines[0].summary).toContain("Reopening Rita");
  });

  it("refuses a status that is not one, writing and logging nothing", async () => {
    // A server action is a public endpoint; the arguments are whatever was sent.
    const id = await seasonIn("published");

    const result = await setChampionshipStatusAction(
      id,
      "published",
      "archived" as unknown as ChampionshipStatusValue,
      {}
    );

    expect(result.ok).toBe(false);
    const [row] = await db.select().from(championships).where(eq(championships.id, id));
    expect(row.status).toBe("published");
    expect(await auditFor(id, "championship.status")).toEqual([]);
  });
});
