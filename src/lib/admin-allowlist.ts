import { eq } from "drizzle-orm";
import { type Database, adminAllowlist, db as defaultDb, users } from "@/db";
import { normaliseDiscordId } from "./auth-policy";

/**
 * The admin allowlist: Discord ids that become admins on sign-in, and ids that
 * never do.
 *
 * The decision itself is `resolveAdminFlag` in `auth-policy.ts`, which is pure
 * and shared with the sign-in path. What lives here is the reading and writing,
 * plus the one thing a screen needs that the decision does not: whether the id
 * belongs to somebody who has actually turned up yet.
 */

export type AllowlistRow = {
  discordId: string;
  allowed: boolean;
  note: string | null;
  updatedAt: Date;
  /** The account, once they have signed in at least once. */
  account: { id: string; name: string; handle: string | null; isAdmin: boolean } | null;
};

export type AllowlistResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Every row, with whoever it turned out to be. */
export async function getAllowlist(database: Database = defaultDb): Promise<AllowlistRow[]> {
  const rows = await database
    .select({
      discordId: adminAllowlist.discordId,
      allowed: adminAllowlist.allowed,
      note: adminAllowlist.note,
      updatedAt: adminAllowlist.updatedAt,
      userId: users.id,
      displayName: users.displayName,
      name: users.name,
      handle: users.handle,
      isAdmin: users.isAdmin,
    })
    .from(adminAllowlist)
    .leftJoin(users, eq(users.discordId, adminAllowlist.discordId));

  return rows
    .map((row) => ({
      discordId: row.discordId,
      allowed: row.allowed,
      note: row.note,
      updatedAt: row.updatedAt,
      account: row.userId
        ? {
            id: row.userId,
            name: row.displayName ?? row.name ?? row.handle ?? "Member",
            handle: row.handle,
            isAdmin: Boolean(row.isAdmin),
          }
        : null,
    }))
    // Barred rows last: the list is mostly read to answer "who can get in".
    .sort(
      (a, b) =>
        Number(b.allowed) - Number(a.allowed) ||
        (a.account?.name ?? a.discordId).localeCompare(b.account?.name ?? b.discordId)
    );
}

/** Just the decision-relevant columns, for the sign-in path. */
export async function getAllowlistEntries(
  database: Database = defaultDb
): Promise<Array<{ discordId: string; allowed: boolean }>> {
  return database
    .select({ discordId: adminAllowlist.discordId, allowed: adminAllowlist.allowed })
    .from(adminAllowlist);
}

/**
 * Pre-authorise a Discord id.
 *
 * If they already have an account the flag is set now rather than waiting for
 * their next sign-in — an admin who adds somebody and then watches nothing
 * happen for a week reasonably concludes the feature is broken.
 */
export async function allowAdmin(
  discordId: string,
  input: { note?: string | null; addedByUserId?: string | null } = {},
  database: Database = defaultDb
): Promise<AllowlistResult<{ discordId: string; promotedNow: boolean }>> {
  const id = normaliseDiscordId(discordId);
  if (!id) {
    return {
      ok: false,
      error:
        "A Discord id is 17 to 20 digits. Turn on Developer Mode in Discord, right-click the person and choose Copy User ID.",
    };
  }

  return database.transaction(async (tx) => {
    const value = {
      discordId: id,
      allowed: true,
      note: input.note?.trim() || null,
      addedByUserId: input.addedByUserId ?? null,
      updatedAt: new Date(),
    };
    await tx
      .insert(adminAllowlist)
      .values(value)
      .onConflictDoUpdate({
        target: adminAllowlist.discordId,
        set: { allowed: true, note: value.note, updatedAt: value.updatedAt },
      });

    const [existing] = await tx
      .select({ id: users.id, isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.discordId, id));

    if (existing && !existing.isAdmin) {
      await tx.update(users).set({ isAdmin: true }).where(eq(users.id, existing.id));
    }

    return { ok: true as const, data: { discordId: id, promotedNow: Boolean(existing) } };
  });
}

/**
 * Bar a Discord id for good.
 *
 * The row stays, with `allowed: false`. Deleting it instead would drop the
 * decision back to "no opinion", and the environment would promote them again
 * on their next sign-in — which is exactly the behaviour this replaced.
 *
 * The account, if there is one, is demoted in the same transaction. Leaving
 * somebody barred-but-still-admin until they happen to sign in again is not
 * what anybody means by remove.
 */
export async function barAdmin(
  discordId: string,
  input: { note?: string | null; addedByUserId?: string | null } = {},
  database: Database = defaultDb
): Promise<AllowlistResult<{ discordId: string; demotedNow: boolean }>> {
  const id = normaliseDiscordId(discordId);
  if (!id) return { ok: false, error: "That is not a Discord id." };

  return database.transaction(async (tx) => {
    const value = {
      discordId: id,
      allowed: false,
      note: input.note?.trim() || null,
      addedByUserId: input.addedByUserId ?? null,
      updatedAt: new Date(),
    };
    await tx
      .insert(adminAllowlist)
      .values(value)
      .onConflictDoUpdate({
        target: adminAllowlist.discordId,
        set: { allowed: false, note: value.note, updatedAt: value.updatedAt },
      });

    const [existing] = await tx
      .select({ id: users.id, isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.discordId, id));

    if (existing?.isAdmin) {
      await tx.update(users).set({ isAdmin: false }).where(eq(users.id, existing.id));
    }

    return { ok: true as const, data: { discordId: id, demotedNow: Boolean(existing?.isAdmin) } };
  });
}

/**
 * Drop the row entirely, returning the id to "no opinion".
 *
 * Different from barring, and the screen says so: this hands the decision back
 * to `ADMIN_DISCORD_IDS`, so an id still named there becomes an admin again on
 * the next sign-in. It is for undoing a mistake, not for removing somebody.
 */
export async function forgetAdmin(
  discordId: string,
  database: Database = defaultDb
): Promise<void> {
  const id = normaliseDiscordId(discordId);
  if (!id) return;
  await database.delete(adminAllowlist).where(eq(adminAllowlist.discordId, id));
}

/** How many accounts currently hold the flag — the last-admin guard reads it. */
export async function countAdmins(database: Database = defaultDb): Promise<number> {
  const rows = await database.select({ id: users.id }).from(users).where(eq(users.isAdmin, true));
  return rows.length;
}
