import { asc, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, auditLog, games, profileFields, profileValues } from "@/db";
import {
  type TestDatabase,
  committingAfter,
  freshDatabase,
  makeUser,
} from "@/db/__tests__/helpers";

/**
 * What the question actions do when something else happens in the middle of
 * them (Task 137).
 *
 * Three windows, each of which used to be open. Task 147 found the second
 * still open on the two moves, which renumber and do nothing else, and the
 * third still open one layer down, inside `updateField` itself:
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
  // An admin, as the name says: the `destructive` modifier (Task 129) reads the flag from here.
  requirePermission: async () => ({ id: state.adminId, displayName: "Beko", isAdmin: true }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const {
  createFieldAction,
  deleteFieldAction,
  moveFieldAction,
  moveGameAction,
  restoreFieldAction,
  retireFieldAction,
  updateFieldAction,
} = await import("../actions");
const { deleteField, updateField } = await import("@/lib/admin-games");

let handle: TestDatabase;
let memberId: string;
let rivalsId: string;

beforeAll(async () => {
  handle = await freshDatabase();
  state.adminId = await makeUser(handle.db, { displayName: "Beko" });
  memberId = await makeUser(handle.db, { displayName: "Member" });
  await handle.db.delete(games);
  // Overwatch sorts first, so Rivals has somewhere to move to.
  const [, rivals] = await handle.db
    .insert(games)
    .values([
      { key: "overwatch", name: "Overwatch", sort: 0 },
      { key: "rivals", name: "Marvel Rivals", sort: 1 },
    ])
    .returning();
  rivalsId = rivals.id;
  // Every label an update replaces, beside the one it wrote: the database's
  // own account of what each edit to a question overwrote.
  await handle.client.exec(`
    create table task147_overwrites (was text not null, became text not null);
    create function task147_note() returns trigger language plpgsql as
      $$ begin insert into task147_overwrites values (old.label, new.label); return new; end $$;
    create trigger task147_overwrite_noted before update of label on profile_fields
      for each row execute function task147_note();
  `);
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  state.db = handle.db;
  await handle.client.exec(`
    drop trigger if exists task137_sort_jammed on profile_fields;
    drop trigger if exists task147_one_sort_jammed on profile_fields;
    drop trigger if exists task147_one_sort_jammed on games;
    delete from task147_overwrites;
  `);
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

/**
 * Make Postgres refuse to renumber **one** row and let the others through.
 *
 * A move renumbers two rows, one statement each. Refusing the second is a
 * throw midway: the first has already been written when it comes.
 */
async function jamTheSortOf(table: "games" | "profile_fields", row: string): Promise<void> {
  const named = table === "games" ? "key" : "label";
  await handle.client.exec(`
    create or replace function task147_refuse() returns trigger language plpgsql as
      $$ begin raise exception 'sort is jammed'; end $$;
    create trigger task147_one_sort_jammed before update of sort on ${table}
      for each row when (new.${named} = '${row}') execute function task147_refuse();
  `);
}

/** Every game's place in the list, as `key place`, in key order. */
async function gamePlaces(): Promise<string[]> {
  const rows = await handle.db.select().from(games).orderBy(asc(games.key));
  return rows.map((row) => `${row.key} ${row.sort}`);
}

/** The same for the questions, by label. */
async function questionPlaces(): Promise<string[]> {
  const rows = await handle.db.select().from(profileFields).orderBy(asc(profileFields.label));
  return rows.map((row) => `${row.label} ${row.sort}`);
}

describe("a move whose renumbering fails partway", () => {
  it("leaves the games in the places they had", async () => {
    // Moving Rivals up writes the new place of Rivals, then of Overwatch. The
    // second is refused, with the first already written.
    await jamTheSortOf("games", "overwatch");

    await expect(moveGameAction(rivalsId, "up")).rejects.toThrow();

    expect(await gamePlaces()).toEqual(["overwatch 0", "rivals 1"]);
    expect(await lines()).toHaveLength(0);
  });

  it("leaves the questions in the places they had", async () => {
    // Moving the first of two down writes the second's new place, then its own.
    const first = await addQuestion("Main role");
    await addQuestion("Notes");
    await jamTheSortOf("profile_fields", "Main role");

    await expect(moveFieldAction(first, "down")).rejects.toThrow();

    expect(await questionPlaces()).toEqual(["Main role 0", "Notes 1"]);
    expect(await lines()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 3. The action's read and the library's write                       */
/* ------------------------------------------------------------------ */

/*
 * The interruption is `committingAfter`: the relabel is committed just before
 * the library opens its transaction. `updateField` reads the question inside
 * that transaction (Task 147) and the action reads nothing at all, so anything
 * the action had read by then is stale, and the library's own read is not.
 *
 * It used to be a local proxy aimed at the library's first
 * `.where().limit()` read on the bare handle. That read is now a
 * `for update` on the transaction, which the proxy no longer met, and a
 * second writer cannot be waited for from inside a PGlite transaction anyway.
 */

describe("updateFieldAction, when somebody else rewords the question first", () => {
  it("records the label this edit actually replaced, not one it read beforehand", async () => {
    const id = await addQuestion("Main role");
    state.db = committingAfter(handle.db, () =>
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

/*
 * The same window one layer down: between `updateField`'s own read of the
 * question and its write (Task 147).
 *
 * The test above closed the gap between the action and the library. The
 * library still read the row and wrote it as two statements, so a relabel
 * landing between them was overwritten while the line named the label that
 * had been *read*.
 *
 * What is and is not shown, as for `deleteField` above. The relabel is issued
 * the moment the library's read comes back. On the bare handle it lands there
 * and then, which is the defect. Inside a transaction PGlite's one connection
 * makes it queue behind the commit, so the first test proves the read and the
 * write are one transaction and nothing more. On Neon a transaction alone
 * would not hold a second session back; the `for update` on the read is what
 * does, and that is pinned by statement in the second test, not seen working.
 */

/**
 * `db`, except that a second writer acts the moment the first read of
 * `profile_fields` comes back. Awaited on the bare handle, left to queue
 * inside a transaction, for the reason `writingAfterTheCount` gives.
 */
function writingAfterTheQuestionIsRead(db: Database, write: () => Promise<unknown>) {
  let pending: (() => Promise<unknown>) | null = write;
  let outcome: Promise<unknown> = Promise.resolve("never issued");

  const holding = <T extends object>(builder: T, inTransaction: boolean): T =>
    new Proxy(builder, {
      get(target, property) {
        const inner = Reflect.get(target, property, target);
        if (typeof inner !== "function") return inner;
        if (property === "then") {
          return (resolve: (rows: unknown) => void, reject: (error: unknown) => void) => {
            const read = (async () => {
              const rows = await (target as unknown as PromiseLike<unknown>);
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
            return read.then(resolve, reject);
          };
        }
        return (...args: unknown[]) => {
          const next = (inner as (...a: unknown[]) => unknown).apply(target, args);
          return next && typeof next === "object" ? holding(next as object, inTransaction) : next;
        };
      },
    });

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
                return table === profileFields && pending ? holding(from, inTransaction) : from;
              };
            },
          });
        };
      },
    }) as Database;

  return { db: aim(db, false), outcome: () => outcome };
}

/** The label the database says was replaced by the edit that wrote `became`. */
async function labelsReplacedBy(became: string): Promise<string[]> {
  const { rows } = await handle.client.query<{ was: string }>(
    "select was from task147_overwrites where became = $1",
    [became]
  );
  return rows.map((row) => row.was);
}

describe("updateFieldAction, when a relabel is issued between its read and its write", () => {
  it("records the label its write replaced, as the database saw it", async () => {
    const id = await addQuestion("Main role");
    const second = writingAfterTheQuestionIsRead(handle.db, () =>
      handle.db.update(profileFields).set({ label: "Role" }).where(eq(profileFields.id, id))
    );
    state.db = second.db;

    unwrap(await updateFieldAction(id, { label: "Preferred role", type: "text" }));

    // The relabel was really made, so this is not a quiet run with no rival.
    expect(await second.outcome()).toBe("saved");
    const [line] = await lines();
    expect(await labelsReplacedBy("Preferred role")).toEqual([
      (line.detail as { previousLabel: string }).previousLabel,
    ]);
  });
});

describe("updateField's lock on the question it is about to rewrite", () => {
  it("asks for the row lock on its first read, before it writes", async () => {
    const id = await addQuestion("Main role");
    const statements: string[] = [];

    unwrap(
      await updateField(
        id,
        { label: "Preferred role", type: "text" },
        recordingDatabase(handle.db, statements)
      )
    );

    const lock = statements.findIndex(
      (sql) => /from "profile_fields"/i.test(sql) && /for update/i.test(sql)
    );
    const write = statements.findIndex((sql) => /^\s*update "profile_fields"/i.test(sql));
    expect(lock).toBe(0);
    expect(write).toBeGreaterThan(lock);
  });
});
