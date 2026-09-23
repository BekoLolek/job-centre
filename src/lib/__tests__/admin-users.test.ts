import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Database,
  adminAllowlist,
  applications,
  events,
  sessions,
  teamMembers,
  teams,
  userNotes,
  users,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { getAllowlistEntries } from "@/lib/admin-allowlist";
import {
  type AdminUserResult,
  addUserNote,
  adminCount,
  endSessions,
  eventsPlayedFor,
  grantAdmin,
  isEnvAdmin,
  listUserNotes,
  loadAdminUsers,
  revokeAdmin,
} from "@/lib/admin-users";
import { revokeRefusal } from "@/lib/admin-users-policy";
import { resolveAdminFlag } from "@/lib/auth-policy";
import { getPlayerProfile } from "@/lib/players";

/**
 * `/admin/users` — the members list, the admin flag and the notes.
 *
 * The thing worth testing hardest is not that a boolean can be flipped. It is
 * the two refusals: an admin cannot demote themselves, and the site cannot be
 * left with nobody who can reach `/admin`. Both are checked as pure functions
 * *and* through the database path, because the pure one is what greys the
 * button out and the database one is what actually decides — and a rule that
 * only holds in one of those places is not a rule.
 *
 * The other thing under test is what `user_notes` must never do: appear on a
 * public profile. That is asserted against `getPlayerProfile` directly rather
 * than by reading the source, so it stays true if somebody adds a join later.
 */

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await db.delete(userNotes);
  await db.delete(sessions);
  await db.delete(adminAllowlist);
  await db.delete(teamMembers);
  await db.delete(teams);
  await db.delete(applications);
  await db.delete(events);
  await db.delete(users);
});

function expectOk<T>(result: AdminUserResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got: ${result.error}`);
  return result.data;
}

async function expectFail<T>(
  pending: AdminUserResult<T> | Promise<AdminUserResult<T>>
): Promise<string> {
  const result = await pending;
  if (result.ok) throw new Error("Expected a failure, got success.");
  return result.error;
}

/** A member who already holds the flag. */
async function makeAdmin(displayName: string, discordId?: string): Promise<string> {
  const id = await makeUser(db, { displayName, discordId });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, id));
  return id;
}

/* ------------------------------------------------------------------ */
/* The rules, with no database at all                                 */
/* ------------------------------------------------------------------ */

describe("revokeRefusal", () => {
  it("lets one admin demote another when there are several", () => {
    expect(revokeRefusal({ actorId: "a", targetId: "b", adminCount: 2 })).toBeNull();
  });

  it("refuses an admin demoting themselves", () => {
    const refusal = revokeRefusal({ actorId: "a", targetId: "a", adminCount: 5 });
    expect(refusal).toMatch(/your own admin flag/i);
  });

  it("refuses the last admin", () => {
    const refusal = revokeRefusal({ actorId: "a", targetId: "b", adminCount: 1 });
    expect(refusal).toMatch(/last admin/i);
  });

  it("tells somebody who is both about the self-demotion first", () => {
    // It is the one they can do something about — ask another admin. Being told
    // "you are the last admin" would suggest promoting somebody else, which
    // does not actually unlock the button for them.
    const refusal = revokeRefusal({ actorId: "a", targetId: "a", adminCount: 1 });
    expect(refusal).toMatch(/your own admin flag/i);
  });

  it("treats zero admins as a state to refuse from, not to fall through", () => {
    expect(revokeRefusal({ actorId: "a", targetId: "b", adminCount: 0 })).toMatch(/last admin/i);
  });
});

describe("isEnvAdmin", () => {
  it("matches an id on the allowlist", () => {
    expect(isEnvAdmin("123", "123,456")).toBe(true);
  });

  it("tolerates the spacing and the trailing commas a hand-typed variable has", () => {
    expect(isEnvAdmin("456", " 123 , ,456,")).toBe(true);
  });

  it("says no for a blank id and for a blank variable", () => {
    expect(isEnvAdmin("", "123")).toBe(false);
    expect(isEnvAdmin("123", "")).toBe(false);
    expect(isEnvAdmin("123", undefined)).toBe(false);
  });

  it("does not match a different id", () => {
    expect(isEnvAdmin("999", "123,456")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Granting                                                           */
/* ------------------------------------------------------------------ */

describe("grantAdmin", () => {
  it("gives a member the flag", async () => {
    const id = await makeUser(db, { displayName: "Newcomer" });
    const result = expectOk(await grantAdmin(id, db));
    expect(result.user.isAdmin).toBe(true);
    expect(result.admins).toBe(1);
  });

  it("is a no-op that still succeeds when they already have it", async () => {
    const id = await makeAdmin("Already");
    const result = expectOk(await grantAdmin(id, db));
    expect(result.user.isAdmin).toBe(true);
    expect(await adminCount(db)).toBe(1);
  });

  it("refuses a member who no longer exists", async () => {
    expect(await expectFail(grantAdmin("00000000-0000-0000-0000-000000000000", db))).toMatch(
      /no longer exists/i
    );
  });
});

/* ------------------------------------------------------------------ */
/* Revoking — the two rules, through the database                     */
/* ------------------------------------------------------------------ */

describe("revokeAdmin", () => {
  it("lets one admin demote another", async () => {
    const actor = await makeAdmin("Actor");
    const target = await makeAdmin("Target");

    const result = expectOk(await revokeAdmin(target, actor, db));
    expect(result.user.isAdmin).toBe(false);
    expect(result.admins).toBe(1);
  });

  it("refuses an admin revoking their own flag, and leaves it set", async () => {
    const actor = await makeAdmin("Actor");
    await makeAdmin("Somebody else");

    expect(await expectFail(revokeAdmin(actor, actor, db))).toMatch(/your own admin flag/i);

    const [row] = await db.select().from(users).where(eq(users.id, actor));
    expect(row.isAdmin).toBe(true);
    expect(await adminCount(db)).toBe(2);
  });

  it("refuses the last admin, and leaves the site with one", async () => {
    const actor = await makeAdmin("Actor");
    const target = await makeAdmin("Target");
    expectOk(await revokeAdmin(target, actor, db));

    // `actor` is now the only admin. Somebody else — say a second actor who has
    // just been promoted and demoted again — cannot take the last one away.
    const refusal = await expectFail(revokeAdmin(actor, target, db));
    expect(refusal).toMatch(/last admin/i);
    expect(refusal).toMatch(/ADMIN_DISCORD_IDS/);
    expect(await adminCount(db)).toBe(1);
  });

  it("never reaches zero however the order goes", async () => {
    const a = await makeAdmin("A");
    const b = await makeAdmin("B");
    const c = await makeAdmin("C");

    expectOk(await revokeAdmin(c, a, db));
    expectOk(await revokeAdmin(b, a, db));
    await expectFail(revokeAdmin(a, b, db));
    await expectFail(revokeAdmin(a, a, db));

    expect(await adminCount(db)).toBe(1);
  });

  it("succeeds when they do not have the flag — and still records the bar", async () => {
    // Not a no-op: see "writes the bar even when the flag is already off"
    // below. Nothing is taken away, and the decision is written down anyway.
    const actor = await makeAdmin("Actor");
    const plain = await makeUser(db, { displayName: "Plain" });
    const result = expectOk(await revokeAdmin(plain, actor, db));
    expect(result.user.isAdmin).toBe(false);
  });

  it("decides on a fresh count rather than a stale one", async () => {
    // Two admins; one is demoted by a third party first. The second revoke has
    // to see one admin left, not the two the caller last looked at.
    const a = await makeAdmin("A");
    const b = await makeAdmin("B");
    const c = await makeAdmin("C");

    expectOk(await revokeAdmin(a, c, db));
    expectOk(await revokeAdmin(b, c, db));
    expect(await expectFail(revokeAdmin(c, a, db))).toMatch(/last admin/i);
  });
});

/* ------------------------------------------------------------------ */
/* The list                                                           */
/* ------------------------------------------------------------------ */

describe("loadAdminUsers", () => {
  it("puts admins first and counts them", async () => {
    await makeUser(db, { displayName: "Zed" });
    await makeAdmin("Boss");

    const view = await loadAdminUsers({ adminIdsEnv: "" }, db);
    expect(view.users[0].displayName).toBe("Boss");
    expect(view.admins).toBe(1);
    expect(view.total).toBe(2);
  });

  it("flags whoever the allowlist would re-promote on sign-in", async () => {
    await makeUser(db, { displayName: "Listed", discordId: "111" });
    await makeUser(db, { displayName: "Not listed", discordId: "222" });

    const view = await loadAdminUsers({ adminIdsEnv: "111" }, db);
    const listed = view.users.find((row) => row.displayName === "Listed");
    const other = view.users.find((row) => row.displayName === "Not listed");
    expect(listed?.fromAllowlist).toBe(true);
    expect(other?.fromAllowlist).toBe(false);
  });

  it("reports allowlisted ids that have never signed in", async () => {
    await makeUser(db, { displayName: "Here", discordId: "111" });
    const view = await loadAdminUsers({ adminIdsEnv: "111,999" }, db);
    expect(view.pendingAllowlist).toEqual(["999"]);
  });

  it("searches by name and by handle", async () => {
    const id = await makeUser(db, { displayName: "Beko Lolek" });
    await db.update(users).set({ handle: "beko" }).where(eq(users.id, id));
    await makeUser(db, { displayName: "Somebody Else" });

    expect((await loadAdminUsers({ search: "lolek", adminIdsEnv: "" }, db)).users).toHaveLength(1);
    expect((await loadAdminUsers({ search: "BEKO", adminIdsEnv: "" }, db)).users).toHaveLength(1);
    expect((await loadAdminUsers({ search: "nobody", adminIdsEnv: "" }, db)).users).toHaveLength(0);
  });

  it("filters to admins without changing the totals the rule reads", async () => {
    await makeAdmin("Boss");
    await makeUser(db, { displayName: "Member" });

    const view = await loadAdminUsers({ filter: "admins", adminIdsEnv: "" }, db);
    expect(view.users).toHaveLength(1);
    // The counts are of everybody, because the last-admin rule is about the
    // site rather than about what is currently on screen.
    expect(view.total).toBe(2);
    expect(view.admins).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Events played                                                      */
/* ------------------------------------------------------------------ */

describe("eventsPlayedFor", () => {
  async function makeEvent(status: "draft" | "published" | "complete", slug: string) {
    const [row] = await db
      .insert(events)
      .values({ slug, title: slug, status })
      .returning({ id: events.id });
    return row.id;
  }

  it("counts an accepted application to an event that exists publicly", async () => {
    const user = await makeUser(db);
    const eventId = await makeEvent("complete", "played-one");
    await db.insert(applications).values({ eventId, userId: user, status: "accepted" });

    expect((await eventsPlayedFor([user], db)).get(user)).toBe(1);
  });

  it("does not count a draft event, a decline or a withdrawal", async () => {
    const user = await makeUser(db);
    const hidden = await makeEvent("draft", "hidden");
    const open = await makeEvent("published", "open");
    await db.insert(applications).values({ eventId: hidden, userId: user, status: "accepted" });
    await db.insert(applications).values({ eventId: open, userId: user, status: "declined" });

    expect((await eventsPlayedFor([user], db)).get(user) ?? 0).toBe(0);
  });

  it("counts an event once even when they applied and were also on a roster", async () => {
    const user = await makeUser(db);
    const eventId = await makeEvent("complete", "both-halves");
    await db.insert(applications).values({ eventId, userId: user, status: "accepted" });
    const [team] = await db
      .insert(teams)
      .values({ eventId, name: "Team", sort: 0 })
      .returning({ id: teams.id });
    await db.insert(teamMembers).values({ teamId: team.id, eventId, userId: user, price: 0 });

    expect((await eventsPlayedFor([user], db)).get(user)).toBe(1);
  });

  it("agrees with the number the public profile prints", async () => {
    const user = await makeUser(db, { displayName: "Counted" });
    for (const slug of ["a", "b", "c"]) {
      const eventId = await makeEvent("complete", slug);
      await db.insert(applications).values({ eventId, userId: user, status: "accepted" });
    }

    const [row] = await db.select().from(users).where(eq(users.id, user));
    const profile = await getPlayerProfile(row, db);
    expect((await eventsPlayedFor([user], db)).get(user)).toBe(profile.totals.events);
  });
});

/* ------------------------------------------------------------------ */
/* Notes                                                              */
/* ------------------------------------------------------------------ */

describe("user notes", () => {
  it("records who wrote it and when, newest first", async () => {
    const author = await makeAdmin("Writer");
    const subject = await makeUser(db, { displayName: "Subject" });
    const [row] = await db.select().from(users).where(eq(users.id, author));

    expectOk(
      await addUserNote(
        subject,
        { body: "Turned up on time.", author: row, now: new Date("2026-01-01T10:00:00Z") },
        db
      )
    );
    expectOk(
      await addUserNote(
        subject,
        { body: "Captained well.", author: row, now: new Date("2026-02-01T10:00:00Z") },
        db
      )
    );

    const notes = await listUserNotes(subject, db);
    expect(notes.map((note) => note.body)).toEqual(["Captained well.", "Turned up on time."]);
    expect(notes[0].authorName).toBe("Writer");
    expect(notes[0].authorUserId).toBe(author);
  });

  it("holds several notes per member and counts them on the list", async () => {
    const subject = await makeUser(db, { displayName: "Subject" });
    for (const body of ["one", "two", "three"]) {
      expectOk(await addUserNote(subject, { body }, db));
    }

    const view = await loadAdminUsers({ adminIdsEnv: "" }, db);
    expect(view.users.find((row) => row.id === subject)?.notes).toBe(3);
  });

  it("refuses an empty note and one that is too long", async () => {
    const subject = await makeUser(db);
    expect(await expectFail(addUserNote(subject, { body: "   " }, db))).toMatch(/empty note/i);
    expect(
      await expectFail(addUserNote(subject, { body: "x".repeat(2001) }, db))
    ).toMatch(/at most 2000/i);
  });

  it("refuses a note about somebody who no longer exists", async () => {
    expect(
      await expectFail(
        addUserNote("00000000-0000-0000-0000-000000000000", { body: "hello" }, db)
      )
    ).toMatch(/no longer exists/i);
  });

  it("goes with the member when their row does", async () => {
    const subject = await makeUser(db);
    expectOk(await addUserNote(subject, { body: "about them" }, db));
    await db.delete(users).where(eq(users.id, subject));
    expect(await db.select().from(userNotes)).toHaveLength(0);
  });

  it("survives the author's row going, keeping the name it was written under", async () => {
    const author = await makeAdmin("Departed");
    const subject = await makeUser(db);
    const [row] = await db.select().from(users).where(eq(users.id, author));
    expectOk(await addUserNote(subject, { body: "still readable", author: row }, db));

    await db.delete(users).where(eq(users.id, author));

    const notes = await listUserNotes(subject, db);
    expect(notes).toHaveLength(1);
    expect(notes[0].authorUserId).toBeNull();
    expect(notes[0].authorName).toBe("Departed");
  });

  it("never appears on the public profile", async () => {
    const subject = await makeUser(db, { displayName: "Watched" });
    expectOk(await addUserNote(subject, { body: "SECRET-ADMIN-REMARK" }, db));

    const [row] = await db.select().from(users).where(eq(users.id, subject));
    const profile = await getPlayerProfile(row, db);

    expect(JSON.stringify(profile)).not.toContain("SECRET-ADMIN-REMARK");
    expect(Object.keys(profile)).not.toContain("notes");
  });
});

/* ------------------------------------------------------------------ */
/* Revoking is the permanent bar — UC-02 5, UC-29 2a                  */
/* ------------------------------------------------------------------ */

/** The allowlist's opinion about an id, as the sign-in path would read it. */
async function signInWouldMakeAdmin(
  discordId: string,
  adminIdsEnv: string | undefined
): Promise<boolean | undefined> {
  return resolveAdminFlag(discordId, await getAllowlistEntries(db), adminIdsEnv);
}

describe("revoking records the bar", () => {
  it("keeps a revoked admin non-admin with ADMIN_DISCORD_IDS still naming them", async () => {
    // UC-29 2a, and the acceptance criterion of the whole task. This used to
    // be `update users set is_admin = false` and nothing more, so the next
    // sign-in read the environment, found the id and handed the flag straight
    // back — with nothing in the audit log to account for it.
    const actor = await makeAdmin("Actor");
    const target = await makeAdmin("Target", "123456789012345678");

    expectOk(await revokeAdmin(target, actor, db));

    expect(await signInWouldMakeAdmin("123456789012345678", "123456789012345678")).toBe(false);
  });

  it("writes nothing when the revoke is refused", async () => {
    // A refusal is not a partial success: no bar row, no demotion.
    const actor = await makeAdmin("Actor", "111111111111111111");
    await makeAdmin("Someone else");

    await expectFail(revokeAdmin(actor, actor, db));

    expect(await db.select().from(adminAllowlist)).toEqual([]);
    expect(await signInWouldMakeAdmin("111111111111111111", undefined)).toBeUndefined();
  });

  it("writes the bar even when the flag is already off", async () => {
    /*
     * Two admins clicking revoke on the same person. The second one's read
     * finds a member who no longer holds the flag, and revoking used to return
     * success on that read without opening the bar's transaction at all — no
     * allowlist row, so the next sign-in with their id still in
     * ADMIN_DISCORD_IDS handed it straight back. "Permanently revoked" that
     * depends on which of two clicks got there first is not permanent
     * (R-05 / UC-02 5, UC-29 2a).
     */
    const actor = await makeAdmin("Actor");
    const target = await makeAdmin("Target", "222222222222222222");

    expectOk(await revokeAdmin(target, actor, db));
    // Whatever took the flag off left no bar behind — the losing half of two
    // simultaneous clicks, an older demotion, another admin's `forgetAdmin`.
    // The second revoke is the one under test, and it has to write the row.
    await db.delete(adminAllowlist);

    expectOk(await revokeAdmin(target, actor, db));

    expect(await signInWouldMakeAdmin("222222222222222222", "222222222222222222")).toBe(false);
  });

  it("bars a member who never held the flag rather than reporting a no-op", async () => {
    // The same path with no first revoke at all: the decision is the bar, and
    // it is written whether or not the flag happened to be on.
    const actor = await makeAdmin("Actor");
    const target = await makeUser(db, {
      displayName: "Never an admin",
      discordId: "333333333333333333",
    });

    const result = expectOk(await revokeAdmin(target, actor, db));

    expect(result.user.isAdmin).toBe(false);
    expect(await signInWouldMakeAdmin("333333333333333333", "333333333333333333")).toBe(false);
  });

  it("leaves a member with no Discord id demoted, with nothing to bar", async () => {
    // UC-30's local sign-in has no Discord id, so there is no row to key a bar
    // on — and nothing a bar would protect against either.
    const actor = await makeAdmin("Actor");
    const local = await makeUser(db, { displayName: "Local" });
    await db.update(users).set({ isAdmin: true, discordId: null }).where(eq(users.id, local));

    expectOk(await revokeAdmin(local, actor, db));

    const [row] = await db.select().from(users).where(eq(users.id, local));
    expect(row.isAdmin).toBe(false);
    expect(await db.select().from(adminAllowlist)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Two admins demoting each other — UC-02 5a under concurrency        */
/* ------------------------------------------------------------------ */

/**
 * The version everybody writes first: count, decide, then write, with the two
 * halves in different statements. Kept as the control — if the harness below
 * were quietly running the two calls in sequence, this would leave one admin
 * and the tests after it would prove nothing.
 */
async function naiveRevoke(userId: string, actorId: string): Promise<void> {
  const total = await adminCount(db);
  const refusal = revokeRefusal({ actorId, targetId: userId, adminCount: total });
  if (refusal) return;
  await db.update(users).set({ isAdmin: false }).where(eq(users.id, userId));
}

/**
 * A handle whose `transaction` runs `between` to completion first — the same
 * shape as `committingAfter` in `championship-results.test.ts`.
 *
 * Sequenced rather than raced. The window it pins is the one that matters: a
 * revoke reads the member *before* it opens its transaction, so everything
 * that read knows is stale by the time the decision is made. A test that had
 * to win a race to see that would pass by luck.
 */
function committingAfter(between: () => Promise<unknown>): Database {
  let pending: (() => Promise<unknown>) | null = between;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return async (run: Parameters<Database["transaction"]>[0]) => {
        const first = pending;
        pending = null;
        if (first) await first();
        return target.transaction(run);
      };
    },
  });
}

describe("two admins demoting each other", () => {
  it("control: a read-then-write outside a transaction leaves the site with none", async () => {
    const a = await makeAdmin("A");
    const b = await makeAdmin("B");

    await Promise.all([naiveRevoke(b, a), naiveRevoke(a, b)]);

    // Both counted two before either wrote. This is the bug, reproduced on
    // demand, and it is what makes the two assertions below mean something.
    expect(await adminCount(db)).toBe(0);
  });

  it("refuses the second one, deciding inside the transaction rather than on its own read", async () => {
    const a = await makeAdmin("A");
    const b = await makeAdmin("B");

    // A's revoke of B reads the world, and *then* B's revoke of A commits.
    // Everything the first read knew is now wrong; the refusal has to come
    // from inside the transaction or not at all.
    const refusal = await expectFail(
      revokeAdmin(b, a, committingAfter(() => revokeAdmin(a, b, db)))
    );

    expect(refusal).toMatch(/last admin/i);
    expect(await adminCount(db)).toBe(1);
  });

  it("lets exactly one of two simultaneous revokes through", async () => {
    const a = await makeAdmin("A");
    const b = await makeAdmin("B");

    const results = await Promise.all([revokeAdmin(b, a, db), revokeAdmin(a, b, db)]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(await adminCount(db)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Ending sessions — UC-02 4a                                         */
/* ------------------------------------------------------------------ */

async function openSession(userId: string, token: string): Promise<void> {
  await db.insert(sessions).values({
    sessionToken: token,
    userId,
    expires: new Date("2099-01-01T00:00:00Z"),
  });
}

describe("endSessions", () => {
  it("deletes every session that member has open, and nobody else's", async () => {
    const member = await makeUser(db, { displayName: "Removed" });
    const other = await makeUser(db, { displayName: "Untouched" });
    await openSession(member, "phone");
    await openSession(member, "laptop");
    await openSession(other, "theirs");

    expect(expectOk(await endSessions(member, db))).toEqual({ ended: 2 });

    const left = await db.select().from(sessions);
    expect(left.map((row) => row.sessionToken)).toEqual(["theirs"]);
  });

  it("succeeds with nothing to end when they have no session open", async () => {
    const member = await makeUser(db, { displayName: "Never here" });
    expect(expectOk(await endSessions(member, db))).toEqual({ ended: 0 });
  });

  it("refuses a member who no longer exists", async () => {
    expect(
      await expectFail(endSessions("00000000-0000-0000-0000-000000000000", db))
    ).toMatch(/no longer exists/i);
  });

  it("does not touch the admin flag — it is a sign-out, not a demotion", async () => {
    const admin = await makeAdmin("Still an admin");
    await openSession(admin, "somewhere");

    expectOk(await endSessions(admin, db));

    const [row] = await db.select().from(users).where(eq(users.id, admin));
    expect(row.isAdmin).toBe(true);
  });
});
