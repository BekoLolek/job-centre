import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, auditLog, games, profileFields, profileValues } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";

/**
 * What the question actions do when something else happens in the middle of
 * them (Task 137).
 *
 * Three windows, each of which used to be open:
 *
 *  1. **Between the answer count and the delete.** Two statements on the bare
 *     handle, so an answer saved between them was cascaded away while the
 *     action reported, and logged, that nobody had answered.
 *  2. **Between the write and the renumbering.** `resequenceSection` ran after
 *     the retire or the delete had been stored; if it threw, the write was
 *     durable, the action threw, and no line was ever written about it.
 *  3. **Between the action's own read and the library's write.** The summary
 *     was built from a catalogue read taken before the write, so it could name
 *     a label the write never replaced.
 *
 * The library and the database are the real ones throughout. The interruptions
 * are a second writer on the same Postgres and a trigger that refuses a
 * statement; nothing of `admin-games.ts` is stood in for.
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

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const {
  createFieldAction,
  deleteFieldAction,
  restoreFieldAction,
  retireFieldAction,
  updateFieldAction,
} = await import("../actions");
const { deleteField } = await import("@/lib/admin-games");

let handle: TestDatabase;
let memberId: string;
let rivalsId: string;

beforeAll(async () => {
  handle = await freshDatabase();
  state.adminId = await makeUser(handle.db, { displayName: "Beko" });
  memberId = await makeUser(handle.db, { displayName: "Member" });
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
  state.db = handle.db;
  await handle.client.exec("drop trigger if exists task137_sort_jammed on profile_fields");
  await handle.db.delete(profileFields);
  await handle.db.delete(auditLog);
});

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

/** A Rivals question, with the line its creation wrote cleared away. */
async function addQuestion(label: string): Promise<string> {
  const { id } = unwrap(await createFieldAction(rivalsId, { label, type: "text" }));
  await handle.db.delete(auditLog);
  return id;
}

/** Every method of `value`, bound to it, so a proxy can hand them on untouched. */
function passThrough<T extends object>(value: T, property: string | symbol): unknown {
  const inner = Reflect.get(value, property, value);
  return typeof inner === "function" ? inner.bind(value) : inner;
}

/* ------------------------------------------------------------------ */
/* 1. The count and the delete                                        */
/* ------------------------------------------------------------------ */

/**
 * `db`, except that a second writer acts the moment the first count of
 * `profile_values` comes back — after the count, before whatever follows it.
 *
 * The second writer goes through the outer handle, as another member's request
 * would, and it is **issued** at that instant either way. What differs is what
 * the database then does with it, and that is the thing under test:
 *
 *  - counted on the bare handle, nothing holds the connection, so the write is
 *    waited for and lands before the next statement — which is what a second
 *    session does to a count that is not inside a transaction;
 *  - counted inside a transaction, it cannot be waited for: PGlite is one
 *    connection and the transaction holds it, so the write queues behind the
 *    commit. Waiting here would deadlock, so it is left to settle afterwards.
 *
 * `outcome()` is what became of the write: `"saved"`, or the error it was
 * refused with.
 */
function writingAfterTheCount(db: Database, write: () => Promise<unknown>) {
  let pending: (() => Promise<unknown>) | null = write;
  let outcome: Promise<unknown> = Promise.resolve("never issued");

  const aim = (target: Database, inTransaction: boolean): Database =>
    new Proxy(target, {
      get(_target, property) {
        if (property === "transaction") {
          return (run: (tx: Database) => Promise<unknown>) =>
            target.transaction((tx) => run(aim(tx as unknown as Database, true)));
        }
        if (property !== "select") return passThrough(target, property);

        return (...args: unknown[]) => {
          const selecting = (target.select as (...a: unknown[]) => object)(...args);
          return new Proxy(selecting, {
            get(_selecting, fromProperty) {
              if (fromProperty !== "from") return passThrough(selecting, fromProperty);
              return (table: unknown) => {
                const from = (selecting as { from: (t: unknown) => object }).from(table);
                if (table !== profileValues) return from;
                return new Proxy(from, {
                  get(_from, whereProperty) {
                    if (whereProperty !== "where") return passThrough(from, whereProperty);
                    return (condition: unknown) => ({
                      then(resolve: (rows: unknown) => void, reject: (error: unknown) => void) {
                        const counted = (async () => {
                          const rows = await (
                            from as { where: (c: unknown) => Promise<unknown> }
                          ).where(condition);
                          const fire = pending;
                          pending = null;
                          if (fire) {
                            outcome = fire().then(
                              () => "saved",
                              (error: unknown) => error
                            );
                            if (!inTransaction) await outcome;
                          }
                          return rows;
                        })();
                        return counted.then(resolve, reject);
                      },
                    });
                  },
                });
              };
            },
          });
        };
      },
    }) as Database;

  return { db: aim(db, false), outcome: () => outcome };
}

describe("deleteFieldAction, when an answer arrives between its count and its delete", () => {
  it("turns the answer away rather than accepting it and deleting it uncounted", async () => {
    const id = await addQuestion("Main role");
    const second = writingAfterTheCount(handle.db, () =>
      handle.db.insert(profileValues).values({ userId: memberId, fieldId: id, value: "Tank" })
    );
    state.db = second.db;

    const data = unwrap(await deleteFieldAction(id));
    const outcome = await second.outcome();

    // The answer was never accepted, so the 0 the action reports and logs is
    // the truth, and not the number of answers it failed to notice destroying.
    expect(outcome).toBeInstanceOf(Error);
    expect(data.deletedAnswers).toBe(0);
    expect(await fieldRow(id)).toBeUndefined();
    expect(await handle.db.select().from(profileValues)).toHaveLength(0);
    expect((await lines())[0].detail).toMatchObject({ deletedAnswers: 0 });
  });
});

/*
 * The lock, which no behaviour here can see.
 *
 * The test above proves the transaction, and on this harness that is all a
 * behavioural test can prove: PGlite is a single connection, so the second
 * writer queues behind a transaction whether or not a row is locked. On Neon it
 * would not queue. Under READ COMMITTED a second session's insert commits
 * between the count and the delete of an *unlocked* row, and the cascade takes
 * it. What stops that is the `for update` on the question's row, which the
 * insert's foreign-key check has to wait for.
 *
 * So the statement is pinned, the way `admin-allowlist.test.ts` pins the bar's
 * locks and for the reason given there. It says the lock is asked for, and asked
 * for before the count. It does not, and cannot here, show a second session
 * waiting on it.
 */

/** The SQL of every statement a transaction runs, in order. */
function recordingDatabase(db: Database, sink: string[]): Database {
  const watch = <T extends object>(value: T): T => {
    if (Array.isArray(value) || value instanceof Promise) return value;
    return new Proxy(value, {
      get(target, property) {
        const inner = Reflect.get(target, property, target);
        if (typeof inner !== "function") return inner;
        if (property === "then") {
          const toSQL = (target as { toSQL?: () => { sql: string } }).toSQL;
          if (typeof toSQL === "function") sink.push(toSQL.call(target).sql);
          return inner.bind(target);
        }
        return (...args: unknown[]) => {
          const next = (inner as (...a: unknown[]) => unknown).apply(target, args);
          return next && typeof next === "object" ? watch(next as object) : next;
        };
      },
    });
  };

  const watchAll = (tx: Database): Database =>
    new Proxy(tx, {
      get(target, property) {
        const inner = Reflect.get(target, property, target);
        if (typeof inner !== "function") return inner;
        return (...args: unknown[]) => {
          const next = (inner as (...a: unknown[]) => unknown).apply(target, args);
          return next && typeof next === "object" ? watch(next as object) : next;
        };
      },
    }) as Database;

  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return (run: (tx: Database) => Promise<unknown>) =>
        target.transaction((tx) => run(watchAll(tx as unknown as Database)));
    },
  }) as Database;
}

describe("deleteField's lock on the question it is about to delete", () => {
  it("asks for the row lock before it counts the answers", async () => {
    const id = await addQuestion("Main role");
    const statements: string[] = [];

    unwrap(await deleteField(id, recordingDatabase(handle.db, statements)));

    const lock = statements.findIndex(
      (sql) => /from "profile_fields"/i.test(sql) && /for update/i.test(sql)
    );
    const count = statements.findIndex((sql) => /from "profile_values"/i.test(sql));
    const removal = statements.findIndex((sql) => /^\s*delete from "profile_fields"/i.test(sql));
    expect(lock).toBe(0);
    expect(count).toBeGreaterThan(lock);
    expect(removal).toBeGreaterThan(count);
  });
});

/* ------------------------------------------------------------------ */
/* 2. The write and the renumbering                                   */
/* ------------------------------------------------------------------ */

/**
 * Make Postgres refuse every write to `profile_fields.sort`.
 *
 * `resequenceSection` is the only thing in these three actions that writes
 * `sort`, so this fails it and nothing else, and the failure is the database's
 * own. The retire, the restore and the delete do not name the column and go
 * through.
 */
async function jamTheRenumbering(): Promise<void> {
  await handle.client.exec(`
    create or replace function task137_refuse() returns trigger language plpgsql as
      $$ begin raise exception 'sort is jammed'; end $$;
    create trigger task137_sort_jammed before update of sort on profile_fields
      for each row execute function task137_refuse();
  `);
}

describe("a renumbering that fails after the write", () => {
  it("leaves a question unretired, so there is nothing unlogged to find", async () => {
    // Retiring the first of two parks it behind the second, which renumbers both.
    const first = await addQuestion("Main role");
    await addQuestion("Notes");
    await jamTheRenumbering();

    await expect(retireFieldAction(first)).rejects.toThrow();

    expect((await fieldRow(first)).retiredAt).toBeNull();
    expect(await lines()).toHaveLength(0);
  });

  it("leaves a question undeleted", async () => {
    // Deleting the first of two leaves a gap the second is renumbered into.
    const first = await addQuestion("Main role");
    await addQuestion("Notes");
    await jamTheRenumbering();

    await expect(deleteFieldAction(first)).rejects.toThrow();

    expect(await fieldRow(first)).toBeDefined();
    expect(await lines()).toHaveLength(0);
  });

  it("leaves a question unrestored", async () => {
    // Two retired behind one live. The first to be retired is parked last, so
    // bringing it back moves it ahead of the other, which renumbers both.
    await addQuestion("Main role");
    const parked = await addQuestion("Notes");
    const other = await addQuestion("Region");
    unwrap(await retireFieldAction(parked));
    unwrap(await retireFieldAction(other));
    await handle.db.delete(auditLog);
    await jamTheRenumbering();

    await expect(restoreFieldAction(parked)).rejects.toThrow();

    expect((await fieldRow(parked)).retiredAt).not.toBeNull();
    expect(await lines()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 3. The action's read and the library's write                       */
/* ------------------------------------------------------------------ */

/**
 * `db`, except that `between` runs to completion just before the first read of
 * one question by its id — the read the library decides the edit on.
 *
 * Whatever the action itself read before that point is now stale.
 */
function changingBeforeTheLibraryReads(db: Database, between: () => Promise<unknown>): Database {
  let pending: (() => Promise<unknown>) | null = between;
  return new Proxy(db, {
    get(target, property) {
      if (property !== "select") return passThrough(target, property);
      return (...args: unknown[]) => {
        const selecting = (target.select as (...a: unknown[]) => object)(...args);
        return new Proxy(selecting, {
          get(_selecting, fromProperty) {
            if (fromProperty !== "from") return passThrough(selecting, fromProperty);
            return (table: unknown) => {
              const from = (selecting as { from: (t: unknown) => object }).from(table);
              if (table !== profileFields) return from;
              return new Proxy(from, {
                get(_from, whereProperty) {
                  if (whereProperty !== "where") return passThrough(from, whereProperty);
                  return (condition: unknown) => {
                    const where = (from as { where: (c: unknown) => object }).where(condition);
                    return new Proxy(where, {
                      get(_where, limitProperty) {
                        if (limitProperty !== "limit") return passThrough(where, limitProperty);
                        return (rows: number) => ({
                          then(resolve: (found: unknown) => void, reject: (error: unknown) => void) {
                            const read = (async () => {
                              const first = pending;
                              pending = null;
                              if (first) await first();
                              return (where as { limit: (n: number) => Promise<unknown> }).limit(
                                rows
                              );
                            })();
                            return read.then(resolve, reject);
                          },
                        });
                      },
                    });
                  };
                },
              });
            };
          },
        });
      };
    },
  }) as Database;
}

describe("updateFieldAction, when somebody else rewords the question first", () => {
  it("records the label this edit actually replaced, not one it read beforehand", async () => {
    const id = await addQuestion("Main role");
    state.db = changingBeforeTheLibraryReads(handle.db, () =>
      handle.db.update(profileFields).set({ label: "Role" }).where(eq(profileFields.id, id))
    );

    unwrap(await updateFieldAction(id, { label: "Preferred role", type: "text" }));

    const [line] = await lines();
    expect(line.summary).toBe(
      "Changed the question “Role” in Marvel Rivals. It now reads “Preferred role”."
    );
    expect(line.detail).toMatchObject({ previousLabel: "Role", label: "Preferred role" });
  });
});
