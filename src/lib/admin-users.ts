/**
 * `/admin/users` — the members list, the admin flag, and admin-only notes
 * (docs/platform-plan.md §4, §7, §11).
 *
 * This is the module that makes an admin a *row* rather than a deploy. Until it
 * existed the only way to promote somebody was to edit `ADMIN_DISCORD_IDS` and
 * redeploy, which meant the site's permission model lived in an environment
 * variable that nobody could read from inside the site.
 *
 * ## The two rules that must hold
 *
 * Both are pure functions — {@link revokeRefusal} — so they are testable without
 * a database and so the screen can grey a button out for the same reason the
 * server refuses it:
 *
 *  1. **An admin cannot revoke their own flag.** Locking yourself out of your
 *     own site is not an action anyone means to take, and the recovery is a
 *     redeploy. Somebody else can demote you; you cannot.
 *  2. **The site can never reach zero admins.** With no admins nothing in
 *     `/admin` is reachable by anybody and the only way back is the environment
 *     variable again. The last one is refused with a sentence saying why.
 *
 * Granting has no rules. Going from one admin to two takes nothing away.
 *
 * ## `ADMIN_DISCORD_IDS` no longer wins on sign-in
 *
 * It used to. `shouldBeAdmin` granted the flag on **every** sign-in for anybody
 * named in the variable, so revoking one of them worked and then came straight
 * back the next morning, with nothing in the audit log to account for it. The
 * variable is now the *bootstrap only*: it decides for an id the allowlist has
 * no row for, and {@link revokeAdmin} writes a row saying `allowed: false`, so
 * the decision on this screen outranks it (R-05, R-141 / UC-29 2a).
 *
 * A locked-out deployment is still rescuable, and deliberately so: `forgetAdmin`
 * in `admin-allowlist.ts` drops the row and hands the id back to the variable.
 * That is an undo, spelled differently from a removal so the two cannot be
 * confused. {@link isEnvAdmin} and the `fromAllowlist` flag stay, because the
 * screen still has to say which ids the variable would speak for.
 *
 * ## Notes
 *
 * Admin-only free text about a member, several per member (§7). Append-only,
 * like the audit log: there is no edit and no delete in this module, because a
 * note is a record of what somebody thought at the time. Nothing public reads
 * them — `src/lib/players.ts` builds the public profile and does not import
 * this module or the `user_notes` table.
 */

import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import {
  type Database,
  type EventStatus,
  type User,
  type UserNote,
  applications,
  db as defaultDb,
  events,
  sessions,
  teamMembers,
  userNotes,
  userPermissions,
  users,
} from "@/db";
import { barAdminUser } from "./admin-allowlist";
import { NOTE_MAX, revokeRefusal } from "./admin-users-policy";
import { parseAdminIds } from "./auth-policy";
import { clearPowers, setPowers } from "./permissions";
import { type Power, isPower } from "./permissions-policy";

/* ------------------------------------------------------------------ */
/* Results                                                            */
/* ------------------------------------------------------------------ */

/**
 * Every mutation returns this rather than throwing, exactly as
 * `admin-games.ts` and `events.ts` do: the caller is a form, and a form wants a
 * message next to the control.
 */
export type AdminUserResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function withData<T>(data: T): AdminUserResult<T> {
  return { ok: true, data };
}

/* ------------------------------------------------------------------ */
/* The rules                                                          */
/* ------------------------------------------------------------------ */

/**
 * The two refusals live in `admin-users-policy.ts` and are re-exported here so
 * server callers have one import. The split exists so `/admin/users`'s client
 * component can run the same function without pulling Drizzle into the browser.
 */
export { NOTE_MAX, revokeRefusal } from "./admin-users-policy";
export type { RevokeContext } from "./admin-users-policy";

/**
 * Is this Discord id named in `ADMIN_DISCORD_IDS`?
 *
 * A thin wrapper over `parseAdminIds` so this module has one place that knows
 * the allowlist's shape, and so the screen and the rules read it the same way.
 */
export function isEnvAdmin(
  discordId: string | null | undefined,
  adminIdsEnv: string | undefined | null
): boolean {
  const id = (discordId ?? "").trim().toLowerCase();
  if (!id) return false;
  return parseAdminIds(adminIdsEnv).some((allowed) => allowed.toLowerCase() === id);
}

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

/** One row of the members list. */
export type AdminUserView = {
  id: string;
  discordId: string | null;
  displayName: string;
  /** `/players/[handle]`. Null only for a member nothing has ever linked to. */
  handle: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  /**
   * True when their Discord id is in `ADMIN_DISCORD_IDS`, which re-grants the
   * flag on every sign-in. The screen says so next to the revoke button.
   */
  fromAllowlist: boolean;
  createdAt: Date;
  lastSeenAt: Date | null;
  /** Events they have played — the same figure `/players/[handle]` shows. */
  eventsPlayed: number;
  /** How many admin notes they have. The body is fetched only when opened. */
  notes: number;
  /**
   * The powers stored for them (R-262). Their own list and nothing derived.
   *
   * For an admin it is empty: everything that sets the flag deletes the list.
   * Rows can still be here if they were stored before that was so, or written
   * by hand. They are in force for nobody while the flag is on and would be
   * again without it, so the screen names them and offers to clear them
   * rather than hiding them.
   */
  powers: Power[];
};

export type AdminUsersView = {
  users: AdminUserView[];
  /** Every member, before the search and the filter. */
  total: number;
  /** How many hold the flag right now. What the last-admin rule is about. */
  admins: number;
  /**
   * Ids named in `ADMIN_DISCORD_IDS` with no `users` row yet — they have never
   * signed in, and pick the flag up when they do.
   */
  pendingAllowlist: string[];
};

/**
 * Which half of the list to show (UC-02 E1, "filters by admin / not admin").
 *
 * Both directions, not just one. There used to be only `all` and `admins`, so
 * "who is *not* an admin" — the question an admin asks before granting, and
 * the one the facet is named after — was the one view the screen could not
 * produce.
 */
export type UserFilter = "all" | "admins" | "members";

export type ListUsersOptions = {
  /** Matched against display name, name and handle, case-insensitively. */
  search?: string;
  /** `admins` shows only the flagged ones, `members` only the unflagged. */
  filter?: UserFilter;
  /** Read from the environment when absent, so tests can supply their own. */
  adminIdsEnv?: string | null;
};

/**
 * An event counts as *played* the same way `/players/[handle]` counts it (§4):
 * an accepted application, or a roster row, on an event that exists publicly.
 * Two screens disagreeing about how many events somebody has played is worse
 * than either number being arguable.
 */
const PLAYED_STATUSES: readonly EventStatus[] = ["published", "live", "complete", "cancelled"];

/**
 * The whole screen in four queries.
 *
 * Counts are grouped in Postgres rather than fetched per member: two hundred
 * members would otherwise be four hundred round trips, and on Neon that is
 * four hundred HTTP requests.
 */
export async function loadAdminUsers(
  options: ListUsersOptions = {},
  database: Database = defaultDb
): Promise<AdminUsersView> {
  const adminIdsEnv =
    options.adminIdsEnv !== undefined ? options.adminIdsEnv : process.env.ADMIN_DISCORD_IDS;

  const rows = await database
    .select()
    .from(users)
    .orderBy(desc(users.isAdmin), asc(users.displayName), asc(users.createdAt));

  const ids = rows.map((row) => row.id);
  const [played, noteCounts, powers] = await Promise.all([
    eventsPlayedFor(ids, database),
    noteCountsFor(ids, database),
    powersFor(ids, database),
  ]);

  const decorated: AdminUserView[] = rows.map((row) => ({
    id: row.id,
    discordId: row.discordId,
    displayName: displayNameOf(row),
    handle: row.handle,
    avatarUrl: row.avatarUrl ?? row.image ?? null,
    isAdmin: row.isAdmin,
    fromAllowlist: isEnvAdmin(row.discordId, adminIdsEnv),
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    eventsPlayed: played.get(row.id) ?? 0,
    notes: noteCounts.get(row.id) ?? 0,
    powers: powers.get(row.id) ?? [],
  }));

  const known = new Set(
    rows.map((row) => (row.discordId ?? "").trim().toLowerCase()).filter(Boolean)
  );
  const pendingAllowlist = parseAdminIds(adminIdsEnv).filter(
    (id) => !known.has(id.toLowerCase())
  );

  return {
    users: filterUsers(decorated, options),
    total: decorated.length,
    admins: decorated.filter((row) => row.isAdmin).length,
    pendingAllowlist,
  };
}

/** What the site calls somebody, in the order the rest of the app prefers. */
function displayNameOf(row: {
  displayName: string | null;
  name: string | null;
}): string {
  return row.displayName ?? row.name ?? "Unknown member";
}

/**
 * Search and filter, in memory.
 *
 * The list is already read in full to count the admins — the last-admin rule
 * needs the total, not the filtered total — so pushing the search into SQL
 * would be a second query to save nothing. It is also what lets the filter be
 * instant on the client.
 */
function filterUsers(
  rows: readonly AdminUserView[],
  options: ListUsersOptions
): AdminUserView[] {
  const search = (options.search ?? "").trim().toLowerCase();
  const filter = options.filter ?? "all";

  return rows.filter((row) => {
    if (filter === "admins" && !row.isAdmin) return false;
    if (filter === "members" && row.isAdmin) return false;
    if (!search) return true;
    return (
      row.displayName.toLowerCase().includes(search) ||
      (row.handle ?? "").toLowerCase().includes(search)
    );
  });
}

/**
 * How many events each of these members has played.
 *
 * Two queries unioned in memory rather than a `union` in SQL, because an event
 * can produce a row in both halves — somebody with an accepted application who
 * also ended up on a roster is one event, not two — and deduplicating a pair of
 * id sets is clearer than a `distinct` over a union with a group by on top.
 */
export async function eventsPlayedFor(
  userIds: readonly string[],
  database: Database = defaultDb
): Promise<Map<string, number>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  const out = new Map<string, number>();
  if (ids.length === 0) return out;

  const [accepted, rosters] = await Promise.all([
    database
      .select({ userId: applications.userId, eventId: applications.eventId })
      .from(applications)
      .innerJoin(events, eq(applications.eventId, events.id))
      .where(
        and(
          inArray(applications.userId, ids),
          eq(applications.status, "accepted"),
          inArray(events.status, PLAYED_STATUSES)
        )
      ),
    database
      .select({ userId: teamMembers.userId, eventId: teamMembers.eventId })
      .from(teamMembers)
      .innerJoin(events, eq(teamMembers.eventId, events.id))
      .where(and(inArray(teamMembers.userId, ids), inArray(events.status, PLAYED_STATUSES))),
  ]);

  const seen = new Map<string, Set<string>>();
  for (const row of [...accepted, ...rosters]) {
    const set = seen.get(row.userId) ?? new Set<string>();
    set.add(row.eventId);
    seen.set(row.userId, set);
  }
  for (const [userId, set] of seen) out.set(userId, set.size);
  return out;
}

/** How many notes each of these members has. */
async function noteCountsFor(
  userIds: readonly string[],
  database: Database = defaultDb
): Promise<Map<string, number>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const rows = await database
    .select({ userId: userNotes.userId, total: count() })
    .from(userNotes)
    .where(inArray(userNotes.userId, ids))
    .groupBy(userNotes.userId);

  return new Map(rows.map((row) => [row.userId, Number(row.total)]));
}

/**
 * The powers each of these members holds, in one query.
 *
 * `powersOf` in `permissions.ts` is the read for one member; two hundred
 * members would be two hundred of it. A row outside the vocabulary is dropped
 * here as it is there, so the screen never offers a name that is not a power.
 */
async function powersFor(
  userIds: readonly string[],
  database: Database = defaultDb
): Promise<Map<string, Power[]>> {
  const out = new Map<string, Power[]>();
  if (userIds.length === 0) return out;

  const rows = await database
    .select({ userId: userPermissions.userId, power: userPermissions.power })
    .from(userPermissions)
    .where(inArray(userPermissions.userId, [...userIds]));

  for (const row of rows) {
    if (!isPower(row.power)) continue;
    out.set(row.userId, [...(out.get(row.userId) ?? []), row.power]);
  }
  return out;
}

/** How many members hold the flag. The number the last-admin rule reads. */
export async function adminCount(database: Database = defaultDb): Promise<number> {
  const [row] = await database
    .select({ total: count() })
    .from(users)
    .where(eq(users.isAdmin, true));
  return Number(row?.total ?? 0);
}

/** One member's row, or null. */
export async function getMember(
  userId: string,
  database: Database = defaultDb
): Promise<User | null> {
  const [row] = await database.select().from(users).where(eq(users.id, userId)).limit(1);
  return row ?? null;
}

/* ------------------------------------------------------------------ */
/* The admin flag                                                     */
/* ------------------------------------------------------------------ */

export type AdminFlagChange = {
  /** The member as they are now. */
  user: User;
  /** How many admins there are after the change. */
  admins: number;
};

export type AdminGrant = AdminFlagChange & {
  /** The list the flag replaced: what this grant deleted, often nothing. */
  clearedPowers: Power[];
};

/** One member's row, locked until the transaction ends. */
async function lockMember(tx: Database, userId: string): Promise<User | null> {
  const [row] = await tx.select().from(users).where(eq(users.id, userId)).limit(1).for("update");
  return row ?? null;
}

/**
 * Grant the admin flag.
 *
 * No rules: going from one admin to two takes nothing away from anybody, and
 * there is no maximum. Granting to somebody who already has it is a no-op that
 * still reports success, so a double click is not an error message.
 *
 * **The flag replaces their list of powers** (Task 151, R-266). Whatever was
 * stored for them is deleted in the same transaction and handed back as
 * `clearedPowers`, so the action can say so in the audit log. Left in the
 * table the rows were invisible — an admin has no list on the screen — and
 * came back into force the moment the flag was revoked. Now a demoted admin
 * holds nothing until somebody grants it.
 *
 * The row is locked first and the list deleted after the flag is set, in one
 * transaction: `saveMemberPowers` takes the same lock, so a save cannot slip a
 * row in between this deciding and this writing. It also clears somebody who
 * already holds the flag.
 *
 * The other two things that set the flag do the same in their own
 * transactions: `allowAdmin` in `admin-allowlist.ts`, and the sign-in in
 * `auth.ts`, which has no admin behind it and writes its own line.
 */
export async function grantAdmin(
  userId: string,
  database: Database = defaultDb
): Promise<AdminUserResult<AdminGrant>> {
  const granted = await database.transaction(async (tx) => {
    const member = await lockMember(tx, userId);
    if (!member) return null;

    if (!member.isAdmin) {
      await tx.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
    }
    return { user: { ...member, isAdmin: true }, clearedPowers: await clearPowers(userId, tx) };
  });
  if (!granted) return fail("That member no longer exists.");

  return withData({ ...granted, admins: await adminCount(database) });
}

/**
 * Revoke the admin flag — which is the **permanent bar** (R-05 / UC-02 4, 5).
 *
 * This used to be an `update users set is_admin = false` and nothing else, and
 * the screen had a paragraph explaining that it did not really work: anybody
 * named in `ADMIN_DISCORD_IDS` was promoted again by their next sign-in, with
 * nothing in the audit log to account for it. "Removed, comes back tomorrow"
 * is not a thing to explain, it is a thing to fix, so revoking now records the
 * decision on the allowlist as well. `resolveAdminFlag` reads that row and
 * returns `false` for it whatever the environment says — which is UC-29 2a,
 * and the one acceptance criterion this task turns on.
 *
 * Both refusals and both writes happen inside {@link barAdminUser}'s single
 * transaction, over a locked read of the admin set. The count is never carried
 * across a statement boundary: see that function for why two admins demoting
 * each other is the case a read-then-write gets wrong.
 *
 * Nothing is decided here on the member that was read above, not even "they do
 * not hold the flag, so there is nothing to do". That early return was the last
 * read-then-decide on this path, and it had the same shape as the bug the
 * transaction exists to fix: two admins clicking revoke on the same person, and
 * the second one returning success having written no allowlist row at all — a
 * permanent bar that is not permanent and not a bar, reported as done.
 * {@link barWithin} already handles a target who holds no flag: it skips the
 * refusals, because barring somebody who is not an admin takes nothing away,
 * and still writes the row that stops the next sign-in re-granting it.
 *
 * `admins` in the result is read after the transaction and is a display figure
 * for the screen — nothing decides on it.
 */
export async function revokeAdmin(
  userId: string,
  actorId: string,
  database: Database = defaultDb
): Promise<AdminUserResult<AdminFlagChange>> {
  const member = await getMember(userId, database);
  if (!member) return fail("That member no longer exists.");

  const barred = await barAdminUser(
    userId,
    { actorId, addedByUserId: actorId },
    database
  );
  if (!barred.ok) return fail(barred.error);

  const after = await getMember(userId, database);
  return withData({
    user: after ?? { ...member, isAdmin: false },
    admins: await adminCount(database),
  });
}

/* ------------------------------------------------------------------ */
/* Powers                                                             */
/* ------------------------------------------------------------------ */

export type PowersChange = {
  /** The member whose list it is. */
  user: User;
  /** What this save gave them that they did not hold. */
  added: Power[];
  /** What this save took away. */
  removed: Power[];
};

/**
 * Store a member's list of powers as exactly this (R-262 / UC-55).
 *
 * The list is the whole of what they hold afterwards, not a change to it: a
 * power on it that they lacked is granted, one they held that is not on it is
 * taken away. `setPowers` does both in one transaction and reports each, and
 * two empty answers mean the save changed nothing — which is how the action
 * knows to write no audit line (R-266).
 *
 * Three refusals, all before anything is written:
 *
 *  - **A member who holds the admin flag has no list to save.** They can do
 *    everything already; rows for them would change nothing today and would
 *    quietly become their powers the day the flag is revoked. The one list
 *    that is accepted for them is the empty one, which is how rows found on
 *    an admin are cleared (Task 151). The flag is read on a
 *    locked row inside the transaction that writes, the lock `grantAdmin`
 *    takes: read beforehand, a promotion committing in the gap would leave
 *    exactly the rows this refusal exists to prevent.
 *  - **A name that is not in the vocabulary.** The admin flag is not a power
 *    and nothing here can set it (R-264): `admin`, or any other name the
 *    screen did not offer, is refused with the name in the message.
 *    `setPowers` would throw for it; this is a form, so it gets a sentence.
 *  - **Something that is not a list of names.** A server action's arguments
 *    are whatever was posted, not what the type says.
 *
 * It does not ask who is saving — the action does, and only an admin may.
 */
export async function saveMemberPowers(
  userId: string,
  powers: readonly string[],
  actorId: string,
  database: Database = defaultDb
): Promise<AdminUserResult<PowersChange>> {
  if (!Array.isArray(powers) || powers.some((power) => typeof power !== "string")) {
    return fail("That is not a list of powers, so nothing was saved.");
  }
  const unknown = powers.find((power) => !isPower(power));
  if (unknown !== undefined) {
    return fail(`"${unknown}" is not a power, so nothing was saved.`);
  }

  return database.transaction(async (tx) => {
    const member = await lockMember(tx, userId);
    if (!member) return fail("That member no longer exists.");
    if (member.isAdmin && powers.length > 0) {
      return fail(
        `${displayNameOf(member)} is an admin and can already do everything, so there is no list of powers to save.`
      );
    }

    const change = await setPowers({ userId, powers, grantedByUserId: actorId }, tx);
    return withData({ user: member, ...change });
  });
}

/* ------------------------------------------------------------------ */
/* Sessions                                                           */
/* ------------------------------------------------------------------ */

/**
 * End every session a member has open (R-07 / UC-02 4a).
 *
 * The point of database sessions rather than a signed cookie (§3.2) is exactly
 * this: somebody removed from the community keeps an open tab until the cookie
 * expires a month later unless there is a row to delete. Deleting it makes
 * their next request a signed-out one.
 *
 * Not a demotion and not a bar — they may sign in again immediately, and for
 * "gone for good" the caller wants {@link revokeAdmin} or the gate. That is
 * why there is no refusal here, not even for yourself: signing yourself out
 * everywhere is a reasonable thing to do from a machine you no longer trust.
 */
export async function endSessions(
  userId: string,
  database: Database = defaultDb
): Promise<AdminUserResult<{ ended: number }>> {
  const member = await getMember(userId, database);
  if (!member) return fail("That member no longer exists.");

  const removed = await database
    .delete(sessions)
    .where(eq(sessions.userId, userId))
    .returning({ token: sessions.sessionToken });

  return withData({ ended: removed.length });
}

/* ------------------------------------------------------------------ */
/* Notes                                                              */
/* ------------------------------------------------------------------ */

export type UserNoteView = UserNote & {
  /** The live handle of the author, when they still have a row. */
  authorHandle: string | null;
};

/**
 * One member's notes, newest first.
 *
 * The author's *stored* name wins over their live one, for the same reason the
 * audit log's does: it is what they were called when they wrote it. The live
 * handle comes along beside it so the line can still link somewhere.
 */
export async function listUserNotes(
  userId: string,
  database: Database = defaultDb
): Promise<UserNoteView[]> {
  const rows = await database
    .select()
    .from(userNotes)
    .where(eq(userNotes.userId, userId))
    .orderBy(desc(userNotes.createdAt), desc(userNotes.id));
  if (rows.length === 0) return [];

  const authorIds = [...new Set(rows.map((row) => row.authorUserId).filter(Boolean))] as string[];
  const authors =
    authorIds.length > 0
      ? await database
          .select({ id: users.id, handle: users.handle, displayName: users.displayName })
          .from(users)
          .where(inArray(users.id, authorIds))
      : [];
  const byId = new Map(authors.map((row) => [row.id, row]));

  return rows.map((row) => ({
    ...row,
    authorName: row.authorName ?? byId.get(row.authorUserId ?? "")?.displayName ?? null,
    authorHandle: byId.get(row.authorUserId ?? "")?.handle ?? null,
  }));
}

export type AddNoteInput = {
  body: string;
  /** Who is writing it. The name is snapshotted onto the row. */
  author?: { id: string; displayName?: string | null; name?: string | null } | null;
  now?: Date;
};

/**
 * Write a note about a member.
 *
 * Never public. Nothing in `src/lib/players.ts` reads this table, and nothing
 * should — the public profile is events, teams, prices and honours, and a
 * member has no reason to expect an admin's private remark to appear on it.
 */
export async function addUserNote(
  userId: string,
  input: AddNoteInput,
  database: Database = defaultDb
): Promise<AdminUserResult<UserNote>> {
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body) return fail("Write something first — an empty note records nothing.");
  if (body.length > NOTE_MAX) {
    return fail(`A note is at most ${NOTE_MAX} characters; that one is ${body.length}.`);
  }

  const member = await getMember(userId, database);
  if (!member) return fail("That member no longer exists.");

  const [created] = await database
    .insert(userNotes)
    .values({
      userId,
      authorUserId: input.author?.id ?? null,
      authorName: input.author
        ? (input.author.displayName ?? input.author.name ?? null)
        : null,
      body,
      createdAt: input.now ?? new Date(),
    })
    .returning();

  return withData(created);
}
