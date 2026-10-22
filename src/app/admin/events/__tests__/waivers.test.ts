import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  type Database,
  auditLog,
  entryWaivers,
  events,
  games,
  profileFields,
  profileValues,
  users,
} from "@/db";
import { type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";
import { RIVALS_RANK_LADDER } from "@/db/seed";

/*
 * The actions run for real against an in-memory Postgres. Only what cannot run
 * outside a Next request is replaced: the session cookie and the page cache.
 * `@/db`'s `db` is pointed at this file's database the same way
 * `host-scope.test.ts` does it — a proxy that binds to the live handle on first
 * use.
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

const {
  listEntryWaiversAction,
  revokeEntryWaiverAction,
  waiveEnterRuleByHandleAction,
  waiveEntryRuleAction,
} = await import("../waiver-actions");

/**
 * Who may record an entry-rule waiver, and what it leaves behind
 * (R-59 / UC-14 3b).
 *
 * The library half — what a waiver does to the apply gate and to `setCaptains`
 * — is in `src/lib/__tests__/entry-waivers.test.ts`. This file is about the two
 * things only the action layer can answer: whether the caller may write this
 * row at all, and whether the decision is in the audit log afterwards.
 */

let harness: TestDatabase;
let db: Database;

let rivalsId: string;
let rankFieldId: string;
let counter = 0;

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
  state.db = db;

  const [game] = await db
    .insert(games)
    .values({ key: "rivals", name: "Marvel Rivals", rankLadder: [...RIVALS_RANK_LADDER] })
    .returning({ id: games.id });
  rivalsId = game.id;

  const [rank] = await db
    .insert(profileFields)
    .values({ gameId: rivalsId, key: "rank", label: "Rank", type: "rank", sort: 0 })
    .returning({ id: profileFields.id });
  rankFieldId = rank.id;
});

afterAll(async () => {
  await harness.close();
});

/** An event with both rank rules, and a member below both of them. */
async function gatedEvent(): Promise<string> {
  counter += 1;
  const [event] = await db
    .insert(events)
    .values({
      slug: `waiver-scope-${counter}`,
      title: `Waiver scope ${counter}`,
      status: "published",
      gameId: rivalsId,
      minRankToEnter: "Platinum III",
      minRankToCaptain: "Diamond II",
    })
    .returning({ id: events.id });
  return event.id;
}

async function belowTheBar(displayName: string): Promise<string> {
  const userId = await makeUser(db, { displayName });
  await db
    .insert(profileValues)
    .values({ userId, fieldId: rankFieldId, value: "Gold I" as never });
  return userId;
}

async function waiverRows(eventId: string, userId: string) {
  return db
    .select()
    .from(entryWaivers)
    .where(and(eq(entryWaivers.eventId, eventId), eq(entryWaivers.userId, userId)));
}

async function auditRowsFor(subject: string) {
  return db.select().from(auditLog).where(eq(auditLog.subject, subject));
}

/**
 * This file's database, except that the **first** insert it is asked for runs
 * `between` to completion before the statement is issued — `insertingAfter` in
 * `src/lib/__tests__/championship-events.test.ts`, and `writingAfter` in
 * `events.test.ts`, for the window between an action's reads and its write.
 *
 * Only the first: everything after it, the audit insert included, goes straight
 * through, and the nested call `between` makes re-enters this same handle with
 * nothing pending. Sequenced rather than raced — the window is one statement
 * wide, and the interleave is pinned rather than hoped for.
 *
 * ## Why the transaction is flattened
 *
 * Task 56 moved `waiveEntryRule` into a transaction holding the event's row
 * lock, and the insert this helper is aimed at went with it — issued on the
 * `tx` rather than on this handle. Without the flattening below, the first
 * insert this proxy saw became the *audit* insert, whose builder chain is
 * `.values().returning()` and not the `.values().onConflictDoNothing()
 * .returning()` spelled out here: the interception threw
 * `returning is not a function`, the audit line was swallowed by
 * `recordAudit`'s own catch, and the test failed on an empty log rather than on
 * anything about two managers. (Task 58's note on these six helpers is exactly
 * this: each hardcodes one builder chain, and the aim is the part that drifts.
 * That is why this helper stayed here when the six identical `committingAfter`s
 * were merged into `src/db/__tests__/helpers.ts`, which carries the reasoning:
 * a drifting aim is the one thing a shared helper cannot hold.)
 *
 * Flattening also has to happen for `between` to run at all. `between` is a
 * whole second grant, which opens a transaction of its own, and PGlite is a
 * single connection — a second `db.transaction` opened while one is already
 * open waits for a transaction that is waiting for it. So the write under test
 * is handed a handle where it expects a `tx`, which leaves the connection free
 * for the other manager to open, write and commit. `archive-lock.test.ts`'s
 * `completing` flattens for the same reason and says so at greater length.
 */
function insertingAfter(between: () => Promise<unknown>): Database {
  let pending: (() => Promise<unknown>) | null = between;

  const intercepting = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "insert" || pending === null) {
        return Reflect.get(target, property, receiver);
      }
      return (table: Parameters<Database["insert"]>[0]) => ({
        values: (values: unknown) => ({
          onConflictDoNothing: (config: unknown) => ({
            returning: async (columns: unknown) => {
              const run = pending;
              pending = null;
              if (run) await run();
              const builder = target.insert(table) as unknown as {
                values: (of: unknown) => {
                  onConflictDoNothing: (on: unknown) => {
                    returning: (of: unknown) => Promise<unknown[]>;
                  };
                };
              };
              return builder.values(values).onConflictDoNothing(config).returning(columns);
            },
          }),
        }),
      });
    },
  });

  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "insert") return Reflect.get(intercepting, property);
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return async (run: Parameters<Database["transaction"]>[0]) =>
        run(intercepting as never);
    },
  });
}

let admin: string;

beforeAll(async () => {
  admin = await makeUser(db, { displayName: "Admin Ada" });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin));
});

beforeEach(() => {
  state.userId = admin;
});

/* ------------------------------------------------------------------ */
/* UC-14 3b — the decision is recorded and logged                     */
/* ------------------------------------------------------------------ */

describe("a manager waiving a rule", () => {
  it("records who gave it and writes one audit line naming them both", async () => {
    const eventId = await gatedEvent();
    const member = await belowTheBar("Filler Fay");

    const result = await waiveEntryRuleAction(eventId, member, "enter");

    expect(result.ok && result.data.waivers.map((row) => [row.member, row.rule])).toEqual([
      ["Filler Fay", "enter"],
    ]);
    expect((await waiverRows(eventId, member))[0].waivedBy).toBe(admin);

    const [line] = await auditRowsFor(member);
    expect(line.action).toBe("waiver.granted");
    expect(line.eventId).toBe(eventId);
    expect(line.actorUserId).toBe(admin);
    expect(line.summary).toContain("Filler Fay");
    expect(line.summary).toContain("entry");
  });

  it("logs the captain rule as its own decision", async () => {
    const eventId = await gatedEvent();
    const member = await belowTheBar("Captain Cass");

    await waiveEntryRuleAction(eventId, member, "captain");

    const [line] = await auditRowsFor(member);
    expect(line.action).toBe("waiver.granted");
    expect(line.summary).toContain("captain");
    expect((await waiverRows(eventId, member)).map((row) => row.rule)).toEqual(["captain"]);
  });

  it("does not log a second line for the same decision twice", async () => {
    // The double-submitted button. One row, one line — a log that gained an
    // entry every time somebody clicked would make the real ones harder to find.
    const eventId = await gatedEvent();
    const member = await belowTheBar("Twice Tam");

    await waiveEntryRuleAction(eventId, member, "enter");
    await waiveEntryRuleAction(eventId, member, "enter");

    expect(await waiverRows(eventId, member)).toHaveLength(1);
    expect(await auditRowsFor(member)).toHaveLength(1);
  });

  it("logs one line when two managers grant the same waiver at once", async () => {
    /*
     * The same decision taken twice in the same moment, which is not the same
     * test as the one above: *that* one is sequential, so anything that looks
     * at the row before writing it sees the row. Here the second manager's
     * whole grant lands in the window between the first manager's reads and the
     * first manager's insert — so a "have we logged this already?" worked out
     * from a list read beforehand says no to both of them, and one decision
     * gets two "Entry rule waived" lines.
     *
     * Sequenced rather than raced (see `insertingAfter`): a test that had to
     * win a race to see this would pass by luck on the days it did not.
     */
    const eventId = await gatedEvent();
    const member = await belowTheBar("Both Bo");
    const other = await makeUser(db, { displayName: "Other Ola" });
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, other));

    const theOtherManager = async () => {
      state.userId = other;
      try {
        await waiveEntryRuleAction(eventId, member, "enter");
      } finally {
        state.userId = admin;
      }
    };

    state.db = insertingAfter(theOtherManager);
    try {
      expect((await waiveEntryRuleAction(eventId, member, "enter")).ok).toBe(true);
    } finally {
      state.db = db;
    }

    // One row — the unique constraint was never in question — and one line.
    expect(await waiverRows(eventId, member)).toHaveLength(1);
    const lines = await auditRowsFor(member);
    expect(lines.map((row) => row.action)).toEqual(["waiver.granted"]);
    // And it names the manager whose insert actually created the row, which is
    // the one the row itself names.
    expect(lines[0].actorUserId).toBe(other);
    expect((await waiverRows(eventId, member))[0].waivedBy).toBe(other);
  });

  it("logs the withdrawal in its own right", async () => {
    const eventId = await gatedEvent();
    const member = await belowTheBar("Undone Uma");

    await waiveEntryRuleAction(eventId, member, "enter");
    const result = await revokeEntryWaiverAction(eventId, member, "enter");

    expect(result.ok && result.data.waivers).toEqual([]);
    expect((await auditRowsFor(member)).map((row) => row.action)).toEqual([
      "waiver.granted",
      "waiver.revoked",
    ]);
  });

  it("logs nothing when there was nothing to withdraw", async () => {
    const eventId = await gatedEvent();
    const member = await belowTheBar("Nothing Nia");

    const result = await revokeEntryWaiverAction(eventId, member, "enter");

    expect(result.ok).toBe(true);
    expect(await auditRowsFor(member)).toEqual([]);
  });

  it("names a member by handle for the waiver they cannot be listed for", async () => {
    // UC-12 2a's member: refused before an application exists, so they are on
    // no list the screen could offer, and the manager types their handle.
    const eventId = await gatedEvent();
    const member = await belowTheBar("Handle Hal");
    await db.update(users).set({ handle: "handle-hal" }).where(eq(users.id, member));

    const result = await waiveEnterRuleByHandleAction(eventId, "@Handle-Hal");

    expect(result.ok && result.data.waivers.map((row) => row.userId)).toEqual([member]);
    expect((await auditRowsFor(member)).map((row) => row.action)).toEqual(["waiver.granted"]);
  });

  it("refuses a handle nobody holds, and writes nothing", async () => {
    const eventId = await gatedEvent();

    const result = await waiveEnterRuleByHandleAction(eventId, "not-a-member");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("not-a-member");
    expect(await db.select().from(entryWaivers).where(eq(entryWaivers.eventId, eventId))).toEqual(
      []
    );
  });
});

/* ------------------------------------------------------------------ */
/* The authorisation boundary (R-86, and `event-scope.ts`'s rule)     */
/* ------------------------------------------------------------------ */

describe("a host of one event", () => {
  it("may waive a rule on their own event", async () => {
    const mine = await gatedEvent();
    const host = await makeUser(db, { displayName: "Host Hana" });
    await makeHost(db, mine, host);
    const member = await belowTheBar("Mine Mina");
    state.userId = host;

    const result = await waiveEntryRuleAction(mine, member, "enter");

    expect(result.ok).toBe(true);
    expect((await waiverRows(mine, member))[0].waivedBy).toBe(host);
  });

  it("is refused on somebody else's event, with nothing written or logged", async () => {
    /*
     * The row this action writes *is* (event, member, rule), so the event id it
     * is authorised against is the event id it writes — there is no second,
     * unverified id to slip past the guard. What is left is the plain case: a
     * host sending an event they do not manage. `requireEventManager`
     * redirects, which throws NEXT_REDIRECT, and nothing after it runs.
     */
    const mine = await gatedEvent();
    const theirs = await gatedEvent();
    const host = await makeUser(db, { displayName: "Host Hugo" });
    await makeHost(db, mine, host);
    const member = await belowTheBar("Theirs Thea");
    state.userId = host;

    await expect(waiveEntryRuleAction(theirs, member, "enter")).rejects.toThrow(/NEXT_REDIRECT/);

    expect(await waiverRows(theirs, member)).toEqual([]);
    expect(await auditRowsFor(member)).toEqual([]);
  });

  it("cannot withdraw another event's waiver, nor read its list", async () => {
    const mine = await gatedEvent();
    const theirs = await gatedEvent();
    const host = await makeUser(db, { displayName: "Host Hex" });
    await makeHost(db, mine, host);
    const member = await belowTheBar("Kept Kai");

    // An admin grants it on the event the host does not manage.
    await waiveEntryRuleAction(theirs, member, "enter");
    state.userId = host;

    await expect(revokeEntryWaiverAction(theirs, member, "enter")).rejects.toThrow(
      /NEXT_REDIRECT/
    );
    await expect(listEntryWaiversAction(theirs)).rejects.toThrow(/NEXT_REDIRECT/);

    // Still there, and still granted by the admin who decided it.
    expect(await waiverRows(theirs, member)).toHaveLength(1);
    expect((await auditRowsFor(member)).map((row) => row.action)).toEqual(["waiver.granted"]);
  });

  it("gets nowhere when signed out", async () => {
    const eventId = await gatedEvent();
    const member = await belowTheBar("Nobody Nol");
    state.userId = null;

    await expect(waiveEntryRuleAction(eventId, member, "enter")).rejects.toThrow(
      /NEXT_REDIRECT/
    );
    expect(await waiverRows(eventId, member)).toEqual([]);
  });
});
