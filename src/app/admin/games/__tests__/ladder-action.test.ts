import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, auditLog, games, profileFields, profileValues } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";

/**
 * `setRankLadderAction`, and the line it writes (Task 137).
 *
 * The one action on `/admin/games` that deletes what members stored: an answer
 * the new ladder no longer recognises is cleared. It wrote nothing, so a ladder
 * edit that wiped a rank off every profile left no history at all.
 *
 * The library is the real one against a real Postgres. Only what cannot run
 * outside a Next request is replaced, as in `field-actions.test.ts`.
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

const { setRankLadderAction } = await import("../actions");
const { createField } = await import("@/lib/admin-games");
const { actionTone } = await import("@/lib/audit");

const LADDER = ["Bronze", "Silver", "Gold"];

let handle: TestDatabase;
let memberId: string;
let secondMemberId: string;
let rivalsId: string;
let rankFieldId: string;

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
  await handle.client.exec("drop trigger if exists task137_answers_jammed on profile_values");
  await handle.db.delete(auditLog);
  await handle.db.delete(games);
  // Overwatch sorts first; the ladder under test is Rivals'.
  const [, rivals] = await handle.db
    .insert(games)
    .values([
      { key: "overwatch", name: "Overwatch", sort: 0, rankLadder: LADDER },
      { key: "rivals", name: "Marvel Rivals", sort: 1, rankLadder: LADDER },
    ])
    .returning();
  rivalsId = rivals.id;
  const field = await createField(rivalsId, { label: "Rank", type: "rank" }, handle.db);
  if (!field.ok) throw new Error(field.error);
  rankFieldId = field.data.id;
  revalidated.length = 0;
});

async function lines() {
  return handle.db.select().from(auditLog).orderBy(desc(auditLog.at));
}

async function storedLadder(): Promise<string[]> {
  const [row] = await handle.db.select().from(games).where(eq(games.id, rivalsId));
  return row.rankLadder;
}

async function storedAnswers() {
  return handle.db.select().from(profileValues);
}

async function ranked(rank: string, userId = memberId): Promise<void> {
  await handle.db.insert(profileValues).values({ userId, fieldId: rankFieldId, value: rank });
}

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

describe("setRankLadderAction", () => {
  it("writes one line naming the game and how many stored answers it cleared", async () => {
    await ranked("Bronze");
    await ranked("Gold", secondMemberId);

    const data = unwrap(await setRankLadderAction(rivalsId, ["Silver", "Gold"]));

    expect(data.clearedAnswers).toBe(1);
    expect(await storedAnswers()).toHaveLength(1);
    const written = await lines();
    expect(written).toHaveLength(1);
    const [line] = written;
    expect(line.action).toBe("game.ladder");
    expect(line.actorUserId).toBe(state.adminId);
    expect(line.actorName).toBe("Beko");
    expect(line.subject).toBe(rivalsId);
    expect(line.summary).toBe(
      "Set the rank ladder of Marvel Rivals. 1 stored answer was cleared."
    );
    expect(line.detail).toEqual({
      game: rivalsId,
      from: ["Bronze", "Silver", "Gold"],
      to: ["Silver", "Gold"],
      clearedAnswers: 1,
    });
  });

  it("counts the cleared answers in the plural when there are several", async () => {
    await ranked("Bronze");
    await ranked("Bronze", secondMemberId);

    unwrap(await setRankLadderAction(rivalsId, ["Silver", "Gold"]));

    const [line] = await lines();
    expect(line.summary).toBe(
      "Set the rank ladder of Marvel Rivals. 2 stored answers were cleared."
    );
    expect(line.detail).toMatchObject({ clearedAnswers: 2 });
  });

  it("says so when nothing was cleared, rather than leaving the reader to guess", async () => {
    await ranked("Bronze");

    unwrap(await setRankLadderAction(rivalsId, ["Gold", "Silver", "Bronze"]));

    expect(await storedAnswers()).toHaveLength(1);
    const [line] = await lines();
    expect(line.summary).toBe(
      "Set the rank ladder of Marvel Rivals. No stored answers were cleared."
    );
    expect(line.detail).toMatchObject({ clearedAnswers: 0 });
  });

  it("is recorded under an action the log marks as destructive", async () => {
    unwrap(await setRankLadderAction(rivalsId, ["Silver", "Gold"]));

    expect(actionTone((await lines())[0].action)).toBe("flare");
  });

  it("logs nothing when the ladder is refused", async () => {
    const result = await setRankLadderAction("00000000-0000-4000-8000-000000000000", ["Gold"]);

    expect(result.ok).toBe(false);
    expect(await lines()).toHaveLength(0);
  });

  it("refreshes the log as well as the two pages a ladder shows on", async () => {
    unwrap(await setRankLadderAction(rivalsId, ["Silver", "Gold"]));

    expect([...new Set(revalidated)].sort()).toEqual([
      "/admin/audit",
      "/admin/games",
      "/me/profile",
    ]);
  });

  it("leaves the ladder as it was when clearing the answers fails", async () => {
    /*
     * The ladder write and the clear were two statements on the bare handle:
     * a clear that threw left the new ladder stored, the answers it orphans
     * still there, and no line, because the action never got as far as one.
     * The failure here is the database's own — a trigger that refuses the
     * delete — so nothing of the library is stood in for.
     */
    await ranked("Bronze");
    await handle.client.exec(`
      create or replace function task137_refuse() returns trigger language plpgsql as
        $$ begin raise exception 'answers are jammed'; end $$;
      create trigger task137_answers_jammed before delete on profile_values
        for each row execute function task137_refuse();
    `);

    await expect(setRankLadderAction(rivalsId, ["Silver", "Gold"])).rejects.toThrow();

    expect(await storedLadder()).toEqual(["Bronze", "Silver", "Gold"]);
    expect(await storedAnswers()).toHaveLength(1);
    expect(await lines()).toHaveLength(0);
  });
});
