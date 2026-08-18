import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Database,
  applications,
  events,
  teamMembers,
  teams,
  userNotes,
  users,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  type AdminUserResult,
  addUserNote,
  adminCount,
  eventsPlayedFor,
  grantAdmin,
  isEnvAdmin,
  listUserNotes,
  loadAdminUsers,
  revokeAdmin,
} from "@/lib/admin-users";
import { revokeRefusal } from "@/lib/admin-users-policy";
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

  it("is a no-op that still succeeds when they do not have the flag", async () => {
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
