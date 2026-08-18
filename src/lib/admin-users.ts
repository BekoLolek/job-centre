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
 * ## `ADMIN_DISCORD_IDS` still wins on sign-in
 *
 * `shouldBeAdmin` in `auth-policy.ts` grants the flag on **every** sign-in for
 * anybody named in that variable, and only ever grants. So revoking somebody
 * who is on the allowlist works — and then comes straight back the next time
 * they sign in. That is not a bug to fix here: the allowlist is the bootstrap
 * that gets the first admin in, and making a database row able to override it
 * would mean a locked-out deployment could not be rescued. It is instead
 * something the screen has to *say*, which is what {@link isEnvAdmin} and the
 * `fromAllowlist` flag on each row are for.
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
  teamMembers,
  userNotes,
  users,
} from "@/db";
import { NOTE_MAX, revokeRefusal } from "./admin-users-policy";
import { parseAdminIds } from "./auth-policy";

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

export type ListUsersOptions = {
  /** Matched against display name, name and handle, case-insensitively. */
  search?: string;
  /** `admins` shows only the flagged ones. */
  filter?: "all" | "admins";
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
  const [played, noteCounts] = await Promise.all([
    eventsPlayedFor(ids, database),
    noteCountsFor(ids, database),
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

/**
 * Grant the admin flag.
 *
 * No rules: going from one admin to two takes nothing away from anybody, and
 * there is no maximum. Granting to somebody who already has it is a no-op that
 * still reports success, so a double click is not an error message.
 */
export async function grantAdmin(
  userId: string,
  database: Database = defaultDb
): Promise<AdminUserResult<AdminFlagChange>> {
  const member = await getMember(userId, database);
  if (!member) return fail("That member no longer exists.");

  if (!member.isAdmin) {
    await database.update(users).set({ isAdmin: true }).where(eq(users.id, userId));
  }

  const after = await getMember(userId, database);
  return withData({ user: after ?? member, admins: await adminCount(database) });
}

/**
 * Revoke the admin flag, subject to {@link revokeRefusal}.
 *
 * The count is read *inside* this function rather than taken from the caller,
 * because the screen's copy of it is as old as the last page load and the rule
 * it feeds is the one thing here that must not be decided on stale data. Two
 * admins demoting each other at the same instant is exactly the case the
 * count-then-check would get wrong, so the check runs against a fresh read and
 * the update is conditional on the flag still being set.
 */
export async function revokeAdmin(
  userId: string,
  actorId: string,
  database: Database = defaultDb
): Promise<AdminUserResult<AdminFlagChange>> {
  const member = await getMember(userId, database);
  if (!member) return fail("That member no longer exists.");
  if (!member.isAdmin) {
    return withData({ user: member, admins: await adminCount(database) });
  }

  const refusal = revokeRefusal({
    actorId,
    targetId: userId,
    adminCount: await adminCount(database),
  });
  if (refusal) return fail(refusal);

  // `is_admin = true` in the predicate makes this a compare-and-set: if another
  // admin demoted them between the read and the write, this simply matches
  // nothing rather than racing the count back down through zero.
  const [updated] = await database
    .update(users)
    .set({ isAdmin: false })
    .where(and(eq(users.id, userId), eq(users.isAdmin, true)))
    .returning();

  return withData({
    user: updated ?? { ...member, isAdmin: false },
    admins: await adminCount(database),
  });
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
