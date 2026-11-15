import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Database, events, games, profileFields, profileValues } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  type FieldInput,
  createField,
  createGame,
  previewRankLadder,
  retireField,
  setRankLadder,
  updateField,
} from "@/lib/admin-games";
import { saveProfileSection } from "@/lib/profile";

/**
 * The ladder warning and the ladder clear are about the same answers (Task 138).
 *
 * `previewRankLadder` is the number the admin agrees to; `setRankLadder` is
 * what then happens. Each test here states both as absolute numbers *and*
 * compares them, and names the answers left standing, so neither side can move
 * without the other.
 *
 * The answers in question are exactly these: an answer to a rank question the
 * game **still asks**, naming a rank the edit **removes**. Nothing else — not a
 * retired question's archive (UC-03 5a), not an answer some earlier edit
 * stranded (R-09), not text that happens to spell a rank.
 */

const LADDER = ["Bronze", "Silver", "Gold"];
const WITHOUT_BRONZE = ["Silver", "Gold"];

let harness: TestDatabase;
let db: Database;
let gameId: string;

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await db.delete(profileValues);
  await db.delete(profileFields);
  await db.delete(events);
  await db.delete(games);
  const game = await createGame({ name: "Marvel Rivals", rankLadder: LADDER }, db);
  if (!game.ok) throw new Error(game.error);
  gameId = game.data.id;
});

async function question(input: FieldInput): Promise<string> {
  const field = await createField(gameId, input, db);
  if (!field.ok) throw new Error(field.error);
  return field.data.id;
}

/** One member's answer, saved the way a member saves it. */
async function answer(fieldId: string, value: string): Promise<void> {
  const saved = await saveProfileSection(await makeUser(db), gameId, { [fieldId]: value }, db);
  if (!saved.ok) throw new Error(JSON.stringify(saved.errors));
}

/** Every answer still stored, as `question: value`, sorted. */
async function storedAnswers(): Promise<string[]> {
  const rows = await db
    .select({ label: profileFields.label, value: profileValues.value })
    .from(profileValues)
    .innerJoin(profileFields, eq(profileFields.id, profileValues.fieldId));
  return rows.map((row) => `${row.label}: ${String(row.value)}`).sort();
}

/** Preview the edit, then make it: the number warned of, and the number cleared. */
async function removeBronze(): Promise<{ warned: number; cleared: number }> {
  const impact = await previewRankLadder(gameId, WITHOUT_BRONZE, db);
  const result = await setRankLadder(gameId, WITHOUT_BRONZE, db);
  if (!result.ok) throw new Error(result.error);
  return { warned: impact.answers, cleared: result.data.clearedAnswers };
}

describe("a ladder edit: the answers warned of are the answers cleared", () => {
  it("counts and clears every answer naming the removed rank when no question is retired", async () => {
    const rank = await question({ label: "Rank", type: "rank" });
    const peak = await question({ label: "Peak rank", type: "rank" });
    await answer(rank, "Bronze");
    await answer(rank, "Silver");
    await answer(peak, "Bronze");
    await answer(peak, "Gold");

    const { warned, cleared } = await removeBronze();

    expect(warned).toBe(2);
    expect(cleared).toBe(warned);
    expect(await storedAnswers()).toEqual(["Peak rank: Gold", "Rank: Silver"]);
  });

  it("neither counts nor clears a retired rank question's answers", async () => {
    const rank = await question({ label: "Rank", type: "rank" });
    const peak = await question({ label: "Peak rank", type: "rank" });
    await answer(rank, "Bronze");
    await answer(peak, "Bronze");
    await answer(peak, "Bronze");
    await retireField(peak, db);

    const { warned, cleared } = await removeBronze();

    expect(warned).toBe(1);
    expect(cleared).toBe(warned);
    expect(await storedAnswers()).toEqual(["Peak rank: Bronze", "Peak rank: Bronze"]);
  });

  it("warns of nothing when only a retired question holds the removed rank", async () => {
    const peak = await question({ label: "Peak rank", type: "rank" });
    await answer(peak, "Bronze");
    await retireField(peak, db);

    const { warned, cleared } = await removeBronze();

    expect(warned).toBe(0);
    expect(cleared).toBe(warned);
    expect(await storedAnswers()).toEqual(["Peak rank: Bronze"]);
  });

  it("leaves alone every stale answer the edit did not cause", async () => {
    const rank = await question({ label: "Rank", type: "rank" });
    await answer(rank, "Bronze");
    await answer(rank, "Gold");
    // Already off the ladder before this edit: no save would accept it, so it
    // is written the way an earlier ladder left it.
    await db
      .insert(profileValues)
      .values({ userId: await makeUser(db), fieldId: rank, value: "Mythril" });
    // A pick-one answer stranded by an edit to its options, and kept (R-09).
    const role = await question({ label: "Role", type: "select", options: ["Sniper", "Medic"] });
    await answer(role, "medic");
    const narrowed = await updateField(
      role,
      { label: "Role", type: "select", options: ["Sniper"] },
      db
    );
    if (!narrowed.ok) throw new Error(narrowed.error);
    // Free text that merely spells the rank being removed.
    const notes = await question({ label: "Notes", type: "text" });
    await answer(notes, "Bronze");

    const { warned, cleared } = await removeBronze();

    expect(warned).toBe(1);
    expect(cleared).toBe(warned);
    expect(await storedAnswers()).toEqual([
      "Notes: Bronze",
      "Rank: Gold",
      "Rank: Mythril",
      "Role: medic",
    ]);
  });
});

/*
 * The window between finding the orphaned answers and deleting them.
 *
 * `setRankLadder` reads which answers name a removed rank, then deletes them.
 * A member who re-answers with a rank the ladder keeps, between those two
 * statements, must keep that answer: the delete checks the value again rather
 * than trusting the ids it read.
 *
 * What this does and does not show. PGlite is one connection, so a second
 * session cannot be run against an open transaction; the member's write is
 * instead made on the transaction's own handle, at the moment the delete is
 * about to be sent. That proves the delete spares a row whose value moved
 * after the read. It does not show a second session's committed write being
 * seen by the delete on Postgres proper — that part is READ COMMITTED doing
 * what it does for a `where` on the row being deleted, and is taken on trust.
 */

/** Runs `between` on the transaction's handle just before its first delete is sent. */
function writingBeforeTheDelete(
  database: Database,
  between: (tx: Database) => Promise<unknown>
): Database {
  const holding = <T extends object>(builder: T, tx: Database): T =>
    new Proxy(builder, {
      get(target, property) {
        const inner = Reflect.get(target, property, target);
        if (typeof inner !== "function") return inner;
        if (property === "then") {
          return (...handlers: unknown[]) =>
            between(tx).then(() =>
              (inner as (...a: unknown[]) => unknown).apply(target, handlers)
            );
        }
        return (...args: unknown[]) => {
          const next = (inner as (...a: unknown[]) => unknown).apply(target, args);
          return next && typeof next === "object" ? holding(next as object, tx) : next;
        };
      },
    });

  return new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return (run: (tx: Database) => Promise<unknown>) =>
        target.transaction((real) => {
          const tx = real as unknown as Database;
          let armed = true;
          return run(
            new Proxy(tx, {
              get(inside, name) {
                const inner = Reflect.get(inside, name, inside);
                if (name !== "delete" || !armed) {
                  return typeof inner === "function" ? inner.bind(inside) : inner;
                }
                armed = false;
                return (...args: unknown[]) =>
                  holding(
                    (inner as (...a: unknown[]) => object).apply(inside, args),
                    tx
                  );
              },
            })
          );
        });
    },
  }) as Database;
}

describe("an answer changed between the read and the delete", () => {
  it("is kept when it now names a rank the ladder keeps, and is not counted", async () => {
    const rank = await question({ label: "Rank", type: "rank" });
    await answer(rank, "Bronze");
    const mover = await makeUser(db);
    const saved = await saveProfileSection(mover, gameId, { [rank]: "Bronze" }, db);
    if (!saved.ok) throw new Error(JSON.stringify(saved.errors));

    const result = await setRankLadder(
      gameId,
      WITHOUT_BRONZE,
      writingBeforeTheDelete(db, (tx) =>
        tx.update(profileValues).set({ value: "Gold" }).where(eq(profileValues.userId, mover))
      )
    );
    if (!result.ok) throw new Error(result.error);

    expect(result.data.clearedAnswers).toBe(1);
    expect(await storedAnswers()).toEqual(["Rank: Gold"]);
  });
});
