import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, auditLog, games, profileFields, profileValues } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";

/**
 * The profile-question server actions, and the audit line each one writes
 * (Task 132).
 *
 * Every other admin area records what it did; these recorded nothing, so a
 * question that vanished from the profile form had no history at all. The line
 * is written by the action and not by `src/lib/admin-games.ts`, for the reason
 * `src/lib/audit.ts` gives: this is the only layer that has run
 * `requireAdmin()` and so the only one that knows who is acting.
 *
 * Two games are seeded, and the questions under test go on the **second**, so a
 * line that named whichever game came first would not pass by luck.
 *
 * Only what cannot run outside a Next request is replaced, the way
 * `hero-actions.test.ts` does it: who is signed in, and the page cache.
 */
const state = vi.hoisted(() => ({ db: undefined as unknown as Database, adminId: "" }));

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
  // A real row, so the line the action writes can name its actor.
  requireAdmin: async () => ({ id: state.adminId, displayName: "Beko" }),
}));

const revalidated: string[] = [];
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path);
  },
}));

const { createFieldAction, deleteFieldAction, retireFieldAction, updateFieldAction } =
  await import("../actions");
const { actionTone } = await import("@/lib/audit");

let handle: TestDatabase;
let memberId: string;
let secondMemberId: string;
let rivalsId: string;

beforeAll(async () => {
  handle = await freshDatabase();
  state.db = handle.db;
  state.adminId = await makeUser(handle.db, { displayName: "Beko" });
  memberId = await makeUser(handle.db, { displayName: "Member" });
  secondMemberId = await makeUser(handle.db, { displayName: "Second member" });
  await handle.db.delete(games);
  // Overwatch sorts first; the questions under test belong to Rivals.
  const [, rivals] = await handle.db
    .insert(games)
    .values([
      { key: "overwatch", name: "Overwatch", sort: 0 },
      { key: "rivals", name: "Marvel Rivals", sort: 1 },
    ])
    .returning();
  rivalsId = rivals.id;
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.delete(auditLog);
  await handle.db.delete(profileFields);
  revalidated.length = 0;
});

/** Every audit line, newest first. */
async function lines() {
  return handle.db.select().from(auditLog).orderBy(desc(auditLog.at));
}

async function fieldRow(id: string) {
  const [row] = await handle.db.select().from(profileFields).where(eq(profileFields.id, id));
  return row;
}

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

const MAIN_ROLE = { label: "Main role", type: "select", options: ["Tank", "Support"] };

/** A Rivals question, with the line its creation wrote cleared away. */
async function addMainRole(): Promise<string> {
  const { id } = unwrap(await createFieldAction(rivalsId, MAIN_ROLE));
  await handle.db.delete(auditLog);
  revalidated.length = 0;
  return id;
}

/** One stored answer to a question, from the first seeded member unless told otherwise. */
async function answer(fieldId: string, value: string, userId = memberId): Promise<void> {
  await handle.db.insert(profileValues).values({ userId, fieldId, value });
}

/* ------------------------------------------------------------------ */
/* Add                                                                */
/* ------------------------------------------------------------------ */

describe("createFieldAction", () => {
  it("writes one line naming who added which question to which game", async () => {
    const { id } = unwrap(await createFieldAction(rivalsId, MAIN_ROLE));

    const written = await lines();
    expect(written).toHaveLength(1);
    const [line] = written;
    expect(line.action).toBe("field.added");
    expect(line.actorUserId).toBe(state.adminId);
    expect(line.actorName).toBe("Beko");
    expect(line.subject).toBe(id);
    expect(line.summary).toBe("Added the question “Main role” to Marvel Rivals.");
    expect(line.detail).toEqual({ game: rivalsId, label: "Main role", type: "select" });
  });

  it("says so when the question belongs to no game", async () => {
    const { id } = unwrap(await createFieldAction(null, { label: "Voice chat", type: "bool" }));

    const [line] = await lines();
    expect(line.subject).toBe(id);
    expect(line.summary).toBe(
      "Added the question “Voice chat” to the questions asked of everyone."
    );
    expect(line.detail).toEqual({ game: null, label: "Voice chat", type: "bool" });
  });

  it("logs nothing when the add is refused", async () => {
    const result = await createFieldAction(rivalsId, { label: "  ", type: "select" });

    expect(result.ok).toBe(false);
    expect(await handle.db.select().from(profileFields)).toHaveLength(0);
    expect(await lines()).toHaveLength(0);
  });

  it("refreshes the log as well as the two pages a question shows on", async () => {
    unwrap(await createFieldAction(rivalsId, MAIN_ROLE));
    expect([...new Set(revalidated)].sort()).toEqual([
      "/admin/audit",
      "/admin/games",
      "/me/profile",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* Edit                                                               */
/* ------------------------------------------------------------------ */

describe("updateFieldAction", () => {
  it("writes one line naming the question and its game", async () => {
    const id = await addMainRole();

    unwrap(await updateFieldAction(id, { ...MAIN_ROLE, required: true }));

    const written = await lines();
    expect(written).toHaveLength(1);
    const [line] = written;
    expect(line.action).toBe("field.updated");
    expect(line.actorName).toBe("Beko");
    expect(line.subject).toBe(id);
    expect(line.summary).toBe("Changed the question “Main role” in Marvel Rivals.");
    expect(line.detail).toEqual({
      game: rivalsId,
      label: "Main role",
      previousLabel: "Main role",
      type: "select",
      strandedAnswers: 0,
    });
  });

  it("records the old label as well as the new one when it was reworded", async () => {
    // After the write the row has no memory of what it was called, and the
    // person reading the log is looking for the name they remember.
    const id = await addMainRole();

    unwrap(await updateFieldAction(id, { ...MAIN_ROLE, label: "Preferred role" }));

    const [line] = await lines();
    expect(line.summary).toBe(
      "Changed the question “Main role” in Marvel Rivals. It now reads “Preferred role”."
    );
    expect(line.detail).toEqual({
      game: rivalsId,
      label: "Preferred role",
      previousLabel: "Main role",
      type: "select",
      strandedAnswers: 0,
    });
  });

  it("says how many stored answers the new definition cannot read", async () => {
    const id = await addMainRole();
    const [, support] = (await fieldRow(id)).options;
    await answer(id, support.value);

    const data = unwrap(await updateFieldAction(id, { ...MAIN_ROLE, options: ["Tank"] }));
    expect(data.strandedAnswers).toBe(1);

    const [line] = await lines();
    expect(line.summary).toBe(
      "Changed the question “Main role” in Marvel Rivals. 1 stored answer no longer fits it."
    );
    expect(line.detail).toMatchObject({ strandedAnswers: 1 });
  });

  it("counts them in the plural when there are several", async () => {
    const id = await addMainRole();
    const [, support] = (await fieldRow(id)).options;
    await answer(id, support.value);
    await answer(id, support.value, secondMemberId);

    unwrap(await updateFieldAction(id, { ...MAIN_ROLE, options: ["Tank"] }));

    expect((await lines())[0].summary).toBe(
      "Changed the question “Main role” in Marvel Rivals. 2 stored answers no longer fit it."
    );
  });

  it("logs nothing when the edit is refused", async () => {
    const id = await addMainRole();

    const result = await updateFieldAction(id, { ...MAIN_ROLE, label: "" });

    expect(result.ok).toBe(false);
    expect((await fieldRow(id)).label).toBe("Main role");
    expect(await lines()).toHaveLength(0);
  });

  it("refreshes the log", async () => {
    const id = await addMainRole();
    unwrap(await updateFieldAction(id, { ...MAIN_ROLE, required: true }));
    expect(revalidated).toContain("/admin/audit");
  });
});

/* ------------------------------------------------------------------ */
/* Retire                                                             */
/* ------------------------------------------------------------------ */

describe("retireFieldAction", () => {
  it("writes one line naming the question and its game, and what was kept", async () => {
    // "Retired" on its own invites the reading that the answers went with it.
    const id = await addMainRole();
    await answer(id, "tank");

    unwrap(await retireFieldAction(id));

    const written = await lines();
    expect(written).toHaveLength(1);
    const [line] = written;
    expect(line.action).toBe("field.retired");
    expect(line.actorName).toBe("Beko");
    expect(line.subject).toBe(id);
    expect(line.summary).toBe(
      "Retired the question “Main role” in Marvel Rivals. It is no longer asked, and the 1 answer to it is kept."
    );
    expect(line.detail).toEqual({ game: rivalsId, label: "Main role", keptAnswers: 1 });
  });

  it("counts the kept answers in the plural when there are several", async () => {
    const id = await addMainRole();
    await answer(id, "tank");
    await answer(id, "tank", secondMemberId);

    unwrap(await retireFieldAction(id));

    expect((await lines())[0].summary).toBe(
      "Retired the question “Main role” in Marvel Rivals. It is no longer asked, and the 2 answers to it are kept."
    );
  });

  it("does not claim answers were kept when there were none", async () => {
    const id = await addMainRole();

    unwrap(await retireFieldAction(id));

    expect((await lines())[0].summary).toBe(
      "Retired the question “Main role” in Marvel Rivals. It is no longer asked; nobody had answered it."
    );
  });

  it("logs nothing when there is no such question", async () => {
    const result = await retireFieldAction("00000000-0000-4000-8000-000000000000");

    expect(result.ok).toBe(false);
    expect(await lines()).toHaveLength(0);
  });

  it("refreshes the log", async () => {
    const id = await addMainRole();
    unwrap(await retireFieldAction(id));
    expect(revalidated).toContain("/admin/audit");
  });
});

/* ------------------------------------------------------------------ */
/* Delete                                                             */
/* ------------------------------------------------------------------ */

describe("deleteFieldAction", () => {
  it("writes one line naming the question that went, its game, and what went with it", async () => {
    /*
     * The row is gone after this, so the label and the game have to be on the
     * line: there is nothing left to look either of them up from.
     */
    const id = await addMainRole();

    unwrap(await deleteFieldAction(id));

    expect(await fieldRow(id)).toBeUndefined();
    const written = await lines();
    expect(written).toHaveLength(1);
    const [line] = written;
    expect(line.action).toBe("field.deleted");
    expect(line.actorUserId).toBe(state.adminId);
    expect(line.actorName).toBe("Beko");
    expect(line.subject).toBe(id);
    expect(line.summary).toBe(
      "Deleted the question “Main role” from Marvel Rivals. Nobody had answered it, so no answers went with it."
    );
    expect(line.detail).toEqual({ game: rivalsId, label: "Main role", deletedAnswers: 0 });
  });

  it("is recorded under an action the log marks as destructive", async () => {
    const id = await addMainRole();

    unwrap(await deleteFieldAction(id));

    expect(actionTone((await lines())[0].action)).toBe("flare");
  });

  it("still names a question that had been retired before it was deleted", async () => {
    // A retired question is off the live list, and it is the likeliest one to
    // be deleted: the line must not fall back to "a question" for it.
    const id = await addMainRole();
    unwrap(await retireFieldAction(id));
    await handle.db.delete(auditLog);

    unwrap(await deleteFieldAction(id));

    expect((await lines())[0].summary).toBe(
      "Deleted the question “Main role” from Marvel Rivals. Nobody had answered it, so no answers went with it."
    );
  });

  it("logs nothing when the delete is refused because somebody answered", async () => {
    const id = await addMainRole();
    await answer(id, "tank");

    const result = await deleteFieldAction(id);

    expect(result.ok).toBe(false);
    expect(await fieldRow(id)).toBeDefined();
    expect(await handle.db.select().from(profileValues)).toHaveLength(1);
    expect(await lines()).toHaveLength(0);
  });

  it("logs nothing when there is no such question", async () => {
    const result = await deleteFieldAction("00000000-0000-4000-8000-000000000000");

    expect(result.ok).toBe(false);
    expect(await lines()).toHaveLength(0);
  });

  it("refreshes the log", async () => {
    const id = await addMainRole();
    unwrap(await deleteFieldAction(id));
    expect(revalidated).toContain("/admin/audit");
  });
});
