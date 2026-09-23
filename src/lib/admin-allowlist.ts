import { type SQL, and, eq } from "drizzle-orm";
import { type Database, adminAllowlist, db as defaultDb, users } from "@/db";
import { revokeRefusal } from "./admin-users-policy";
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

/** What a bar needs beyond the id: who is doing it, and why. */
export type BarInput = {
  note?: string | null;
  addedByUserId?: string | null;
  /**
   * The `users.id` of whoever is clicking. Without it the self-demotion rule
   * cannot fire, so every path a person can reach must pass it; a seed or a
   * script may leave it out, and still cannot take the last admin away.
   */
  actorId?: string | null;
};

export type BarResult = {
  /** The id now barred, or `null` for an account with no Discord id at all. */
  discordId: string | null;
  /** The account that was found, if one exists yet. */
  userId: string | null;
  /** True when this call is what actually took the flag off. */
  demotedNow: boolean;
};

/**
 * The permanent bar, decided and applied in one transaction (R-05 / UC-02 5,
 * 5a, UC-29 2a).
 *
 * ## Why the whole thing is one transaction
 *
 * The two refusals are about a number — how many admins the site has — and
 * that number is shared state. Read it, decide, then write, and two admins
 * demoting each other in the same second both read *two*, both decide the site
 * will still have one, and both write. The site ends with none, and the way
 * back is a redeploy.
 *
 * So the count is not read; it is **locked**. `select … for update` over every
 * row holding the flag is the same move `applyToEvent` makes on an event row
 * before it counts seats (`events.ts`): the second transaction blocks on the
 * lock, and when it is released Postgres re-evaluates `is_admin = true` against
 * the committed row — the demoted admin simply drops out of the result, so the
 * second caller counts one, not two, and is refused. The update is conditional
 * on the flag as well (`and is_admin = true`), which is the same
 * compare-and-set the status changes use, so nothing is double-counted if the
 * row moved anyway.
 *
 * ## Why a non-admin target is never refused
 *
 * The refusal rule is stated in terms of "how many admins there are *right
 * now, the target included*". Handing it a raw count while barring somebody
 * who is not an admin means barring a nobody gets refused as "this is the last
 * admin" on a site with exactly one — a rule firing over an action that takes
 * nothing away. So the rules only run when the target is in the locked set.
 *
 * ## Why the row stays
 *
 * `allowed: false`, never a delete. Deleting drops the decision back to "no
 * opinion" and `ADMIN_DISCORD_IDS` promotes them again on their next sign-in,
 * which is exactly the behaviour this replaced. See {@link forgetAdmin} for
 * the deliberate version of that.
 */
async function barWithin(
  tx: Database,
  target: { userId?: string | null; discordId?: string | null },
  input: BarInput
): Promise<AllowlistResult<BarResult>> {
  // Every current admin, locked for the rest of this transaction.
  const admins = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isAdmin, true))
    .for("update");

  const account = target.userId
    ? await readAccount(tx, eq(users.id, target.userId))
    : target.discordId
      ? await readAccount(tx, eq(users.discordId, target.discordId))
      : null;

  // From the locked read, not from a second query: the count and the target's
  // membership of it have to be the same observation.
  const holdsFlag = account !== null && admins.some((row) => row.id === account.id);

  if (account && holdsFlag) {
    const refusal = revokeRefusal({
      actorId: input.actorId ?? "",
      targetId: account.id,
      adminCount: admins.length,
    });
    if (refusal) return { ok: false, error: refusal };
  }

  const discordId = target.discordId ?? account?.discordId ?? null;
  const note = input.note?.trim() || null;
  const updatedAt = new Date();

  if (discordId) {
    await tx
      .insert(adminAllowlist)
      .values({
        discordId,
        allowed: false,
        note,
        addedByUserId: input.addedByUserId ?? null,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: adminAllowlist.discordId,
        set: { allowed: false, note, updatedAt },
      });
  }

  let demotedNow = false;
  if (account && holdsFlag) {
    const [updated] = await tx
      .update(users)
      .set({ isAdmin: false })
      .where(and(eq(users.id, account.id), eq(users.isAdmin, true)))
      .returning({ id: users.id });
    demotedNow = Boolean(updated);
  }

  return { ok: true, data: { discordId, userId: account?.id ?? null, demotedNow } };
}

type AccountRow = { id: string; discordId: string | null };

/**
 * The target's row, locked like the admin set above it.
 *
 * Unlocked, this read sees a `grantAdmin` that committed between the two
 * statements while the locked set does not — so `holdsFlag` is false, the bar
 * row is written, the demotion is skipped, and the target is barred on paper
 * and an admin in fact until their next sign-in. Locking the row here makes the
 * second statement wait for that grant the same way the first one does.
 */
async function readAccount(tx: Database, where: SQL): Promise<AccountRow | null> {
  const [row] = await tx
    .select({ id: users.id, discordId: users.discordId })
    .from(users)
    .where(where)
    .limit(1)
    .for("update");
  return row ?? null;
}

/**
 * Bar a Discord id for good — the allowlist panel's version, keyed on the id,
 * so somebody who has never signed in can be barred before they ever do.
 */
export async function barAdmin(
  discordId: string,
  input: BarInput = {},
  database: Database = defaultDb
): Promise<AllowlistResult<BarResult>> {
  const id = normaliseDiscordId(discordId);
  if (!id) return { ok: false, error: "That is not a Discord id." };

  return database.transaction((tx) => barWithin(tx, { discordId: id }, input));
}

/**
 * The same bar, keyed on an account — what the members screen's revoke is
 * (UC-02 4, 5).
 *
 * A member with no Discord id at all (a local developer sign-in, UC-30) loses
 * the flag and gets no allowlist row, because the row's key *is* the Discord
 * id and there is nothing to write. Nothing is lost by that: the thing a bar
 * protects against is a Discord sign-in re-granting the flag, and an account
 * with no Discord id has no Discord sign-in to protect against.
 */
export async function barAdminUser(
  userId: string,
  input: BarInput = {},
  database: Database = defaultDb
): Promise<AllowlistResult<BarResult>> {
  return database.transaction((tx) => barWithin(tx, { userId }, input));
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
