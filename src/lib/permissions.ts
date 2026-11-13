import { eq } from "drizzle-orm";
import { type Database, db as defaultDb, userPermissions } from "@/db";
import { type Power, assertPower, isPower } from "./permissions-policy";

/**
 * The stored side of permissions: one row in `user_permissions` per grant
 * (R-261 / UC-55, decision 007).
 *
 * The vocabulary, the presets and the question "may they" are in
 * `permissions-policy.ts`, which has no database and can be imported by a
 * client component. This module is the half that talks to Postgres.
 *
 * Nothing calls it yet. No guard reads `powersOf` and no screen calls
 * `grantPower`; until they do, a row here changes what nobody may do.
 */

/**
 * The powers stored for this member.
 *
 * Only the rows. The admin flag is not in this table and is not consulted
 * here: pass the result to `holds` with the flag beside it.
 *
 * A row whose power is not in the vocabulary — one retired in a later
 * release, or written by hand — is dropped here, at the read. So the set holds
 * powers and nothing else, and its size and its members can be trusted by a
 * caller that never goes through `holds`.
 */
export async function powersOf(
  userId: string,
  database: Database = defaultDb
): Promise<ReadonlySet<Power>> {
  const rows = await database
    .select({ power: userPermissions.power })
    .from(userPermissions)
    .where(eq(userPermissions.userId, userId));
  return new Set(rows.map((row) => row.power).filter(isPower));
}

/**
 * Give a member a power.
 *
 * A power outside the vocabulary is refused before anything is written, with
 * an error that names it — the column is plain text, so this is the only
 * thing between a typo and a stored row.
 *
 * Granting what the member already holds changes nothing: the first grant's
 * time and granter stand. The primary key refuses the second row, and the
 * conflict clause — targeted at that key, as `makeHost` and
 * `approveHostApplication` target theirs — turns that one refusal into a
 * no-op.
 *
 * `created` says which happened, and it is Postgres' answer rather than a
 * read beforehand: `onConflictDoNothing().returning()` hands back the inserted
 * row or nothing, inside the one statement. It is the shape `waiveEntryRule`
 * in `events.ts` reports, for the same use — a caller that logs on `created`
 * writes one audit line per grant however many times the form is sent.
 *
 * Two things it deliberately does not do, both left to the action that calls
 * it: it does not ask who is granting, which only an admin may (R-264), and
 * it writes no audit line, which every grant must have (R-266).
 */
export async function grantPower(
  grant: { userId: string; power: string; grantedByUserId: string },
  database: Database = defaultDb
): Promise<{ created: boolean }> {
  assertPower(grant.power);
  const inserted = await database
    .insert(userPermissions)
    .values(grant)
    .onConflictDoNothing({ target: [userPermissions.userId, userPermissions.power] })
    .returning({ power: userPermissions.power });
  return { created: inserted.length > 0 };
}
