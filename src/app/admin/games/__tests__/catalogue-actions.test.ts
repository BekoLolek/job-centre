import { asc, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, auditLog, games, profileFields, profileValues } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";

/**
 * The rest of `/admin/games`, and the line each action writes (Task 137).
 *
 * Task 132 recorded adding, editing, retiring and deleting a question. The
 * games themselves, and bringing a question back or moving it, still wrote
 * nothing. Each summary below is built from what the library returned, so the
 * names in it are the ones the write was actually made against.
 *
 * Mocked as `field-actions.test.ts` mocks: who is signed in, the database
 * handle, and the page cache. The library is the real one.
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
  requirePermission: async () => ({ id: state.adminId, displayName: "Beko" }),
}));

const revalidated: string[] = [];
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path);
  },
}));

const {
  createFieldAction,
  createGameAction,
  moveFieldAction,
  moveGameAction,
  renameGameAction,
  restoreFieldAction,
  retireFieldAction,
  setGameActiveAction,
} = await import("../actions");
const { actionTone } = await import("@/lib/audit");

const NOBODY = "00000000-0000-4000-8000-000000000000";

let handle: TestDatabase;
let memberId: string;
let secondMemberId: string;
let overwatchId: string;
let rivalsId: string;

beforeAll(async () => {
  handle = await freshDatabase();
  state.db = handle.db;
  state.adminId = await makeUser(handle.db, { displayName: "Beko" });
  memberId = await makeUser(handle.db, { displayName: "Member" });
  secondMemberId = await makeUser(handle.db, { displayName: "Second member" });
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.delete(profileFields);
  await handle.db.delete(games);
  // Overwatch sorts first; whatever is under test is aimed at Rivals.
  const [overwatch, rivals] = await handle.db
    .insert(games)
    .values([
      { key: "overwatch", name: "Overwatch", sort: 0 },
      { key: "rivals", name: "Marvel Rivals", sort: 1 },
    ])
    .returning();
  overwatchId = overwatch.id;
  rivalsId = rivals.id;
  await handle.db.delete(auditLog);
  revalidated.length = 0;
});

async function lines() {
  return handle.db.select().from(auditLog).orderBy(desc(auditLog.at));
}

async function gameRow(id: string) {
  const [row] = await handle.db.select().from(games).where(eq(games.id, id));
  return row;
}

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/** A Rivals question, with the line its creation wrote cleared away. */
async function addQuestion(label: string): Promise<string> {
  const { id } = unwrap(await createFieldAction(rivalsId, { label, type: "text" }));
  await handle.db.delete(auditLog);
  revalidated.length = 0;
  return id;
}

/** The same, already retired. */
async function addRetiredQuestion(label: string): Promise<string> {
  const id = await addQuestion(label);
  unwrap(await retireFieldAction(id));
  await handle.db.delete(auditLog);
  revalidated.length = 0;
  return id;
}

async function answer(fieldId: string, userId = memberId): Promise<void> {
  await handle.db.insert(profileValues).values({ userId, fieldId, value: "anything" });
}

/** Rivals' question labels, in the order the profile form asks them. */
async function order(): Promise<string[]> {
  const rows = await handle.db
    .select()
    .from(profileFields)
    .where(eq(profileFields.gameId, rivalsId))
    .orderBy(asc(profileFields.sort));
  return rows.map((row) => row.label);
}

/* ------------------------------------------------------------------ */
/* Games                                                              */
/* ------------------------------------------------------------------ */

describe("createGameAction", () => {
  it("writes one line naming who added which game", async () => {
    const { id } = unwrap(await createGameAction("  REPO "));

    const written = await lines();
    expect(written).toHaveLength(1);
    const [line] = written;
    expect(line.action).toBe("game.added");
    expect(line.actorUserId).toBe(state.adminId);
    expect(line.actorName).toBe("Beko");
    expect(line.subject).toBe(id);
    expect(line.summary).toBe("Added the game REPO.");
    expect(line.detail).toEqual({ name: "REPO", key: "repo" });
  });

  it("logs nothing when the game is refused", async () => {
    const result = await createGameAction("Overwatch");

    expect(result.ok).toBe(false);
    expect(await lines()).toHaveLength(0);
  });

  it("refreshes the log", async () => {
    unwrap(await createGameAction("REPO"));
    expect(revalidated).toContain("/admin/audit");
  });
});

describe("renameGameAction", () => {
  it("writes one line carrying both names", async () => {
    // After the write the row has no memory of what the game was called.
    unwrap(await renameGameAction(rivalsId, "Rivals"));

    const written = await lines();
    expect(written).toHaveLength(1);
    const [line] = written;
    expect(line.action).toBe("game.renamed");
    expect(line.actorName).toBe("Beko");
    expect(line.subject).toBe(rivalsId);
    expect(line.summary).toBe("Renamed the game Marvel Rivals to Rivals.");
    expect(line.detail).toEqual({ from: "Marvel Rivals", to: "Rivals" });
  });

  it("logs nothing when the name is taken", async () => {
    const result = await renameGameAction(rivalsId, "Overwatch");

    expect(result.ok).toBe(false);
    expect((await gameRow(rivalsId)).name).toBe("Marvel Rivals");
    expect(await lines()).toHaveLength(0);
  });

  it("logs nothing when there is no such game", async () => {
    const result = await renameGameAction(NOBODY, "Rivals");

    expect(result.ok).toBe(false);
    expect(await lines()).toHaveLength(0);
  });

  it("refreshes the log", async () => {
    unwrap(await renameGameAction(rivalsId, "Rivals"));
    expect(revalidated).toContain("/admin/audit");
  });
});

describe("setGameActiveAction", () => {
  it("writes a line saying the game was deactivated and that its answers are kept", async () => {
    // "Deactivated" on its own invites the reading that the answers went too.
    unwrap(await setGameActiveAction(rivalsId, false));

    expect((await gameRow(rivalsId)).isActive).toBe(false);
    const written = await lines();
    expect(written).toHaveLength(1);
    const [line] = written;
    expect(line.action).toBe("game.deactivated");
    expect(line.actorName).toBe("Beko");
    expect(line.subject).toBe(rivalsId);
    expect(line.summary).toBe(
      "Deactivated the game Marvel Rivals. Every stored answer is kept."
    );
    expect(line.detail).toEqual({ name: "Marvel Rivals" });
  });

  it("writes a different line when the game is switched back on", async () => {
    await handle.db.update(games).set({ isActive: false }).where(eq(games.id, rivalsId));

    unwrap(await setGameActiveAction(rivalsId, true));

    const [line] = await lines();
    expect(line.action).toBe("game.activated");
    expect(line.subject).toBe(rivalsId);
    expect(line.summary).toBe("Activated the game Marvel Rivals.");
    expect(line.detail).toEqual({ name: "Marvel Rivals" });
  });

  it("marks neither as something taken away, because every answer survives both", async () => {
    expect(actionTone("game.deactivated")).toBe("muted");
    expect(actionTone("game.activated")).toBe("muted");
  });

  it("logs nothing when there is no such game", async () => {
    const result = await setGameActiveAction(NOBODY, false);

    expect(result.ok).toBe(false);
    expect(await lines()).toHaveLength(0);
  });

  it("refreshes the log", async () => {
    unwrap(await setGameActiveAction(rivalsId, false));
    expect(revalidated).toContain("/admin/audit");
  });
});

describe("moveGameAction", () => {
  it("writes one line naming the game and which way it went", async () => {
    unwrap(await moveGameAction(rivalsId, "up"));

    expect((await gameRow(rivalsId)).sort).toBe(0);
    const written = await lines();
    expect(written).toHaveLength(1);
    const [line] = written;
    expect(line.action).toBe("game.moved");
    expect(line.actorName).toBe("Beko");
    expect(line.subject).toBe(rivalsId);
    expect(line.summary).toBe("Moved the game Marvel Rivals up the list.");
    expect(line.detail).toEqual({ name: "Marvel Rivals", direction: "up" });
  });

  it("says down when it went down", async () => {
    unwrap(await moveGameAction(overwatchId, "down"));

    expect((await lines())[0].summary).toBe("Moved the game Overwatch down the list.");
  });

  it("writes no line when the game was already at the end and nothing moved", async () => {
    // The library answers ok, since a press on a button that had nowhere to go
    // is not an error, but a line saying it moved would be a false one.
    unwrap(await moveGameAction(overwatchId, "up"));

    expect((await gameRow(overwatchId)).sort).toBe(0);
    expect(await lines()).toHaveLength(0);
  });

  it("logs nothing when there is no such game", async () => {
    const result = await moveGameAction(NOBODY, "up");

    expect(result.ok).toBe(false);
    expect(await lines()).toHaveLength(0);
  });

  it("refreshes the log", async () => {
    unwrap(await moveGameAction(rivalsId, "up"));
    expect(revalidated).toContain("/admin/audit");
  });
});

/* ------------------------------------------------------------------ */
/* Questions                                                          */
/* ------------------------------------------------------------------ */

describe("restoreFieldAction", () => {
  it("writes one line naming the question and its game, and what came back", async () => {
    const id = await addRetiredQuestion("Main role");
    await answer(id);

    unwrap(await restoreFieldAction(id));

    const written = await lines();
    expect(written).toHaveLength(1);
    const [line] = written;
    expect(line.action).toBe("field.restored");
    expect(line.actorUserId).toBe(state.adminId);
    expect(line.actorName).toBe("Beko");
    expect(line.subject).toBe(id);
    expect(line.summary).toBe(
      "Brought back the question “Main role” in Marvel Rivals. It is asked again, and the 1 answer to it is back with it."
    );
    expect(line.detail).toEqual({ game: rivalsId, label: "Main role", restoredAnswers: 1 });
  });

  it("counts the answers in the plural when there are several", async () => {
    const id = await addRetiredQuestion("Main role");
    await answer(id);
    await answer(id, secondMemberId);

    unwrap(await restoreFieldAction(id));

    expect((await lines())[0].summary).toBe(
      "Brought back the question “Main role” in Marvel Rivals. It is asked again, and the 2 answers to it are back with it."
    );
  });

  it("does not claim answers came back when there were none", async () => {
    const id = await addRetiredQuestion("Main role");

    unwrap(await restoreFieldAction(id));

    expect((await lines())[0].summary).toBe(
      "Brought back the question “Main role” in Marvel Rivals. It is asked again; nobody had answered it."
    );
  });

  it("logs nothing when there is no such question", async () => {
    const result = await restoreFieldAction(NOBODY);

    expect(result.ok).toBe(false);
    expect(await lines()).toHaveLength(0);
  });

  it("refreshes the log", async () => {
    const id = await addRetiredQuestion("Main role");
    unwrap(await restoreFieldAction(id));
    expect(revalidated).toContain("/admin/audit");
  });
});

describe("moveFieldAction", () => {
  it("writes one line naming the question, its game and which way it went", async () => {
    const first = await addQuestion("Main role");
    await addQuestion("Notes");

    unwrap(await moveFieldAction(first, "down"));

    expect(await order()).toEqual(["Notes", "Main role"]);
    const written = await lines();
    expect(written).toHaveLength(1);
    const [line] = written;
    expect(line.action).toBe("field.moved");
    expect(line.actorName).toBe("Beko");
    expect(line.subject).toBe(first);
    expect(line.summary).toBe("Moved the question “Main role” down in Marvel Rivals.");
    expect(line.detail).toEqual({ game: rivalsId, label: "Main role", direction: "down" });
  });

  it("says up when it went up", async () => {
    await addQuestion("Main role");
    const second = await addQuestion("Notes");

    unwrap(await moveFieldAction(second, "up"));

    expect((await lines())[0].summary).toBe("Moved the question “Notes” up in Marvel Rivals.");
  });

  it("writes no line when the question was already at the end and nothing moved", async () => {
    const first = await addQuestion("Main role");
    await addQuestion("Notes");

    unwrap(await moveFieldAction(first, "up"));

    expect(await order()).toEqual(["Main role", "Notes"]);
    expect(await lines()).toHaveLength(0);
  });

  it("logs nothing when there is no such question", async () => {
    const result = await moveFieldAction(NOBODY, "up");

    expect(result.ok).toBe(false);
    expect(await lines()).toHaveLength(0);
  });

  it("refreshes the log", async () => {
    const first = await addQuestion("Main role");
    await addQuestion("Notes");
    unwrap(await moveFieldAction(first, "down"));
    expect(revalidated).toContain("/admin/audit");
  });
});
