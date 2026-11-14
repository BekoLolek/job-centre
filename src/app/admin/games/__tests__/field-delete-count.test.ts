import { desc } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, auditLog, games, profileFields } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";

/**
 * The delete line says how many answers went, from the number the library
 * reports — not from what the library happens to allow today (Task 132).
 *
 * A summary is stored and never rebuilt. `deleteField` refuses a question that
 * has answers, so today the count is always 0 and "nobody had answered it" is
 * always true; but a sentence that asserted it unconditionally would become a
 * permanent false statement the day that rule is relaxed, sitting beside a
 * `detail` that contradicts it.
 *
 * ## Why this file stubs a module the repo owns
 *
 * The non-zero count cannot be produced through the real library — that is the
 * rule above — so this is the one place `deleteField`'s **return value** is
 * replaced. Everything else in `@/lib/admin-games` is the real thing, the
 * question is really created, and the stub really deletes the row before it
 * reports a count. `field-actions.test.ts` covers the zero branch, and every
 * other path, against the unmodified library.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  adminId: "",
  /** What the stubbed `deleteField` reports went with the question. */
  reportedAnswers: 0,
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

vi.mock("@/lib/session-guards", () => ({
  requirePermission: async () => ({ id: state.adminId, displayName: "Beko" }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

vi.mock("@/lib/admin-games", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/admin-games")>();
  return {
    ...actual,
    deleteField: async (fieldId: string) => {
      const result = await actual.deleteField(fieldId);
      return result.ok
        ? { ok: true, data: { ...result.data, deletedAnswers: state.reportedAnswers } }
        : result;
    },
  };
});

const { createFieldAction, deleteFieldAction } = await import("../actions");

let handle: TestDatabase;
let rivalsId: string;

beforeAll(async () => {
  handle = await freshDatabase();
  state.db = handle.db;
  state.adminId = await makeUser(handle.db, { displayName: "Beko" });
  await handle.db.delete(games);
  const [rivals] = await handle.db
    .insert(games)
    .values({ key: "rivals", name: "Marvel Rivals", sort: 0 })
    .returning();
  rivalsId = rivals.id;
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.delete(profileFields);
});

/** Delete a fresh Rivals question while the library reports `answers` gone; the line it wrote. */
async function deletionLine(answers: number) {
  const created = await createFieldAction(rivalsId, { label: "Main role", type: "text" });
  if (!created.ok) throw new Error(created.error);
  await handle.db.delete(auditLog);
  state.reportedAnswers = answers;

  const result = await deleteFieldAction(created.data.id);
  if (!result.ok) throw new Error(result.error);

  const [line] = await handle.db.select().from(auditLog).orderBy(desc(auditLog.at));
  return line;
}

describe("deleteFieldAction, when the library reports answers went with the question", () => {
  it("says one answer went, and does not say nobody had answered", async () => {
    const line = await deletionLine(1);

    expect(line.summary).toBe(
      "Deleted the question “Main role” from Marvel Rivals. The 1 answer to it went with it."
    );
    expect(line.detail).toMatchObject({ deletedAnswers: 1 });
  });

  it("counts them in the plural when there were several", async () => {
    const line = await deletionLine(3);

    expect(line.summary).toBe(
      "Deleted the question “Main role” from Marvel Rivals. The 3 answers to it went with it."
    );
    expect(line.detail).toMatchObject({ deletedAnswers: 3 });
  });
});
