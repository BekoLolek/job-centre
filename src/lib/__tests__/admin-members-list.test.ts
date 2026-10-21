import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Database,
  adminAllowlist,
  applications,
  events,
  teamMembers,
  teams,
  userNotes,
  users,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { allowAdmin, barAdmin, getAllowlist } from "@/lib/admin-allowlist";
import { loadAdminUsers } from "@/lib/admin-users";

/**
 * UC-02's two extension flows (R-135 to R-139).
 *
 * > **E1.** Admin searches members by name and filters by admin / not admin —
 * > System lists matches, each with when they were last on the site and how
 * > many events they have played.
 * >
 * > **E2.** At step 1, admin adds a note to the grant — System stores it with
 * > the granting admin; the admin list shows both.
 *
 * Both were half-built, and in the same way: the data was there and the read
 * did not ask for it.
 *
 *  - **E1.** `ListUsersOptions.filter` was `"all" | "admins"`. "Not admin" —
 *    the other half of the facet the flow names, and the view an admin wants
 *    *before* granting — was the one list the screen could not produce.
 *  - **E2.** `admin_allowlist.added_by_user_id` was written on every grant and
 *    read by nothing, so "the admin list shows both" showed one. R-139 is
 *    "so that grants are accountable", and a record nobody can see is not one.
 *    The `on conflict` set left the column out as well, so re-allowing an id
 *    somebody else had barred left the row crediting them with the grant.
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
  await db.delete(adminAllowlist);
  await db.delete(teamMembers);
  await db.delete(teams);
  await db.delete(applications);
  await db.delete(events);
  await db.delete(users);
});

/** A member who already holds the flag. */
async function makeAdmin(displayName: string, discordId?: string): Promise<string> {
  const id = await makeUser(db, { displayName, discordId });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, id));
  return id;
}

const names = (view: Awaited<ReturnType<typeof loadAdminUsers>>) =>
  view.users.map((row) => row.displayName).sort();

/* ------------------------------------------------------------------ */
/* UC-02 E1 — search, both filters, and the two columns              */
/* ------------------------------------------------------------------ */

describe("UC-02 E1: searching and filtering members", () => {
  beforeEach(async () => {
    await makeAdmin("Ada Admin", "100000000000000001");
    await makeUser(db, { displayName: "Bo Member", discordId: "100000000000000002" });
    await makeUser(db, { displayName: "Cass Member", discordId: "100000000000000003" });
  });

  it("matches a name, case-insensitively", async () => {
    const view = await loadAdminUsers({ search: "cass", adminIdsEnv: null }, db);
    expect(names(view)).toEqual(["Cass Member"]);
  });

  it("matches a handle as well as a name", async () => {
    const [bo] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.displayName, "Bo Member"));
    await db.update(users).set({ handle: "bo-the-handle" }).where(eq(users.id, bo.id));

    const view = await loadAdminUsers({ search: "the-handle", adminIdsEnv: null }, db);
    expect(names(view)).toEqual(["Bo Member"]);
  });

  it("filters to the admins", async () => {
    const view = await loadAdminUsers({ filter: "admins", adminIdsEnv: null }, db);
    expect(names(view)).toEqual(["Ada Admin"]);
  });

  it("filters to everybody who is NOT an admin", async () => {
    // The half of E1's facet the screen had no way to reach.
    const view = await loadAdminUsers({ filter: "members", adminIdsEnv: null }, db);
    expect(names(view)).toEqual(["Bo Member", "Cass Member"]);
  });

  it("lists everybody when no filter is asked for", async () => {
    const view = await loadAdminUsers({ adminIdsEnv: null }, db);
    expect(names(view)).toEqual(["Ada Admin", "Bo Member", "Cass Member"]);
  });

  it("combines the search with the filter", async () => {
    expect(names(await loadAdminUsers({ search: "member", filter: "members", adminIdsEnv: null }, db))).toEqual([
      "Bo Member",
      "Cass Member",
    ]);
    // "Member" is in Ada's row only as the word in the others' names, so an
    // `admins` filter over the same search finds nobody rather than finding her.
    expect(names(await loadAdminUsers({ search: "member", filter: "admins", adminIdsEnv: null }, db))).toEqual([]);
  });

  it("counts the admins and the total against the WHOLE list, not the filtered one", async () => {
    // The last-admin rule reads `admins`, and a filtered count would make it
    // refuse or allow on the strength of what somebody typed in a search box.
    const view = await loadAdminUsers({ filter: "members", adminIdsEnv: null }, db);
    expect(view.users).toHaveLength(2);
    expect(view.total).toBe(3);
    expect(view.admins).toBe(1);
  });

  it("carries when each member was last on the site", async () => {
    const seen = new Date("2026-03-04T12:00:00Z");
    await db.update(users).set({ lastSeenAt: seen }).where(eq(users.displayName, "Bo Member"));

    const view = await loadAdminUsers({ adminIdsEnv: null }, db);
    const bo = view.users.find((row) => row.displayName === "Bo Member");
    const cass = view.users.find((row) => row.displayName === "Cass Member");

    expect(bo?.lastSeenAt?.getTime()).toBe(seen.getTime());
    // Null, not a date standing in for "never" — the screen says "never signed in".
    expect(cass?.lastSeenAt).toBeNull();
  });

  it("carries how many events each member has played", async () => {
    const [bo] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.displayName, "Bo Member"));

    const [one] = await db
      .insert(events)
      .values({ slug: "played-one", title: "One", type: "casual", status: "complete" })
      .returning({ id: events.id });
    const [two] = await db
      .insert(events)
      .values({ slug: "played-two", title: "Two", type: "casual", status: "live" })
      .returning({ id: events.id });
    // A draft never counts: it may never happen.
    const [draft] = await db
      .insert(events)
      .values({ slug: "played-draft", title: "Draft", type: "casual", status: "draft" })
      .returning({ id: events.id });

    await db.insert(applications).values([
      { eventId: one.id, userId: bo.id, status: "accepted" },
      { eventId: two.id, userId: bo.id, status: "accepted" },
      { eventId: draft.id, userId: bo.id, status: "accepted" },
    ]);

    const view = await loadAdminUsers({ adminIdsEnv: null }, db);
    expect(view.users.find((row) => row.displayName === "Bo Member")?.eventsPlayed).toBe(2);
    expect(view.users.find((row) => row.displayName === "Cass Member")?.eventsPlayed).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* UC-02 E2 — the note, and who granted it                            */
/* ------------------------------------------------------------------ */

describe("UC-02 E2: a note on the grant, with the granting admin", () => {
  it("shows both on the admin list", async () => {
    const ada = await makeAdmin("Ada Admin", "100000000000000001");

    const added = await allowAdmin(
      "100000000000000009",
      { note: "Runs the Tuesday nights", addedByUserId: ada },
      db
    );
    expect(added.ok).toBe(true);

    const [row] = await getAllowlist(db);
    expect(row.note).toBe("Runs the Tuesday nights");
    expect(row.addedBy?.id).toBe(ada);
    expect(row.addedBy?.name).toBe("Ada Admin");
  });

  it("keeps the note empty rather than blank when nothing was written", async () => {
    const ada = await makeAdmin("Ada Admin", "100000000000000001");
    await allowAdmin("100000000000000009", { note: "   ", addedByUserId: ada }, db);

    const [row] = await getAllowlist(db);
    expect(row.note).toBeNull();
    // The granting admin is still recorded: R-139 does not depend on R-138.
    expect(row.addedBy?.name).toBe("Ada Admin");
  });

  it("says nobody when a seed or a script wrote the row", async () => {
    await allowAdmin("100000000000000009", { note: "from a script" }, db);

    const [row] = await getAllowlist(db);
    expect(row.addedBy).toBeNull();
    expect(row.note).toBe("from a script");
  });

  it("credits whoever decided the row LAST, not whoever created it", async () => {
    // Bar then allow again: the row ends up crediting the grant to the admin
    // who gave it. The `on conflict` set used to leave the column alone, so it
    // credited the person who had barred the id — the opposite decision.
    const ada = await makeAdmin("Ada Admin", "100000000000000001");
    const bea = await makeAdmin("Bea Admin", "100000000000000002");

    await allowAdmin("100000000000000009", { note: "first", addedByUserId: ada }, db);
    await barAdmin("100000000000000009", { note: "fell out", addedByUserId: bea, actorId: bea }, db);

    const [barred] = await getAllowlist(db);
    expect(barred.allowed).toBe(false);
    expect(barred.addedBy?.name).toBe("Bea Admin");
    expect(barred.note).toBe("fell out");

    await allowAdmin("100000000000000009", { note: "back in", addedByUserId: ada }, db);

    const [again] = await getAllowlist(db);
    expect(again.allowed).toBe(true);
    expect(again.addedBy?.name).toBe("Ada Admin");
    expect(again.note).toBe("back in");
  });

  it("leaves the previous admin in place when the caller names nobody", async () => {
    // A script re-allowing an id must not erase a real name: an unknown
    // granter is a worse answer than a stale one, and nulling it is not an undo.
    const ada = await makeAdmin("Ada Admin", "100000000000000001");
    await allowAdmin("100000000000000009", { note: "by Ada", addedByUserId: ada }, db);

    await allowAdmin("100000000000000009", { note: "by nobody" }, db);

    const [row] = await getAllowlist(db);
    expect(row.addedBy?.name).toBe("Ada Admin");
  });

  it("names the account the row turned out to be, alongside the granter", async () => {
    // Two different people on one row — the granter and the grantee — so the
    // list cannot be reading one where it means the other.
    const ada = await makeAdmin("Ada Admin", "100000000000000001");
    await makeUser(db, { displayName: "New Admin", discordId: "100000000000000009" });

    await allowAdmin("100000000000000009", { note: "welcome", addedByUserId: ada }, db);

    const [row] = await getAllowlist(db);
    expect(row.account?.name).toBe("New Admin");
    expect(row.addedBy?.name).toBe("Ada Admin");
  });
});
