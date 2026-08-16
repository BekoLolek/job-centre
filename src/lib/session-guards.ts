/**
 * Session helpers for the Discord identity (docs/platform-plan.md §3.2, §11).
 *
 * These are what member and admin pages are built on:
 *
 * ```tsx
 * // a page anyone signed in may see
 * const user = await requireUser();
 * return <p>Hello {user.displayName}</p>;
 *
 * // an admin-only page
 * const admin = await requireAdmin();
 *
 * // a page that renders differently when signed out
 * const user = await getCurrentUser();
 * ```
 *
 * All three are server-only: they read the session cookie, so they belong in a
 * server component, a server action or a route handler.
 *
 * ## Not to be confused with `src/lib/session.ts`
 *
 * That module is the legacy password login the draft board runs on — its own
 * cookie, its own `Session` type with `role: admin | captain | observer`. It is
 * still live and is deliberately left alone. This module is the new,
 * database-backed Discord identity, and the two do not know about each other.
 * A person can hold both cookies at once with no interference.
 */

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { type User, db, users } from "@/db";
import { SIGN_IN_PATH, auth } from "./auth";
import { SIGN_IN_ERRORS } from "./auth-policy";

export { SIGN_IN_PATH };

/**
 * The signed-in member's `users` row, or `null` when nobody is signed in.
 *
 * The full row rather than the session's trimmed user, so callers get
 * `isAdmin`, `discordId`, `displayName`, `avatarUrl` and `lastSeenAt` without a
 * second query. Returns `null` — never throws — when Discord is not configured,
 * when the cookie is missing or stale, or when the session points at a row that
 * has since been deleted.
 */
export async function getCurrentUser(): Promise<User | null> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) return null;

  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

/**
 * The signed-in member's row, or a redirect to the sign-in page.
 *
 * Never returns `null`: on the redirect path `redirect()` throws, so everything
 * after the call runs with a real user.
 */
export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect(SIGN_IN_PATH);
  return user;
}

/**
 * As {@link requireUser}, but also requires `is_admin`.
 *
 * A signed-in non-admin is sent to the sign-in page with `?error=admin-only`
 * rather than to a 403: they are not being asked to authenticate again, they
 * are being told the page is not theirs, and the sign-in page explains that.
 */
export async function requireAdmin(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect(SIGN_IN_PATH);
  if (!user.isAdmin) redirect(`${SIGN_IN_PATH}?error=${SIGN_IN_ERRORS.adminOnly}`);
  return user;
}
