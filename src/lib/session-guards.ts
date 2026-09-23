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
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { type User, db, users } from "@/db";
import { SIGN_IN_PATH, auth } from "./auth";
import { SIGN_IN_ERRORS } from "./auth-policy";
import { canManageEvent } from "./hosting";

export { SIGN_IN_PATH };

/* ------------------------------------------------------------------ */
/* Where to go back to                                                */
/* ------------------------------------------------------------------ */

/**
 * Where sign-in and sign-out return to (R-01, R-06 / UC-01 6, UC-01 8).
 *
 * "System returns them to the page they started from" is one sentence in the
 * use case and an open redirect in most implementations of it, because the
 * candidate is always something the browser supplied: a `?from=` an attacker
 * put in a link, or a `Referer` that any site can set by linking to us. So the
 * value never reaches `signIn()` or `signOut()` as it arrived.
 *
 * The rule is: **keep the path, throw the origin away.** `https://evil.test/x`
 * and `//evil.test/x` both come back as `/x`, which is a page on this site, so
 * there is nothing left to redirect off-site with. `new URL(value, base)` also
 * does the normalising a hand-rolled `startsWith("/")` check keeps missing —
 * `/\evil.test` is a protocol-relative URL to every browser, and after parsing
 * it is a pathname of `//evil.test`, which the second check below refuses.
 *
 * Two paths are refused even though they are ours:
 *
 *  - `/signin`, because returning to the sign-in page after signing in is a
 *    loop, and after signing out it is the one page that says nothing happened.
 *  - `/api/…`, because a redirect is a GET a browser follows and renders, and
 *    `/api/auth/signout` is reachable that way.
 *
 * Both refusals compare a **normalised** copy of the path, never the one that
 * arrived — see {@link refusalForms}. An exact-match refusal is one spelling
 * of the page, and the browser has several: `trailingSlash` is left at its
 * default of `false`, so `/signin/` is a 308 to `/signin` and returning to it
 * lands a member who has just signed in straight back on the sign-in page
 * (R-01, R-06 / UC-01 6).
 *
 * @param raw a `?from=`, a `Referer`, or anything else off the wire.
 * @returns a same-site path beginning with a single `/`, or `null`.
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return null;

  let parsed: URL;
  try {
    // The base is never used for anything but parsing — only the path survives.
    parsed = new URL(value, "http://return.invalid");
  } catch {
    return null;
  }

  const path = `${parsed.pathname}${parsed.search}`;
  if (!path.startsWith("/") || path.startsWith("//")) return null;

  const signIn = SIGN_IN_PATH.toLowerCase();
  for (const route of refusalForms(parsed.pathname)) {
    if (route === signIn) return null;
    if (route === "/api" || route.startsWith("/api/")) return null;
  }

  // The path itself is returned as it arrived: the normalising above is for
  // deciding, not for rewriting somebody's destination.
  return path;
}

/**
 * The spellings of a pathname the two refusals above have to be checked against.
 *
 * Three normalisations, because each one is a different spelling of the same
 * page that an exact `===` would wave through:
 *
 *  - **Trailing slashes off.** With `trailingSlash` at its default, `/signin/`
 *    is a 308 to `/signin`, so the loop the refusal exists to stop reopens
 *    through it.
 *  - **Lower case.** Next's router is case-sensitive, so `/API/auth/signout` is
 *    a 404 today and not an escape. That is a fact about the router, though,
 *    and this check is defence in depth — a defence a different case defeats is
 *    not one.
 *  - **Percent-decoded**, for the same reason: `/%61pi/…` is `/api/…` to
 *    anything that decodes before it routes. The decode is a *second* form
 *    rather than a replacement, so a path that is only dangerous in its raw
 *    spelling is still checked, and a malformed sequence — `decodeURIComponent`
 *    throws on a lone `%` — refuses nothing rather than throwing out of a
 *    sanitiser every sign-in runs through.
 */
function refusalForms(pathname: string): string[] {
  const route = pathname.replace(/\/+$/, "").toLowerCase();
  const forms = [route];
  try {
    const decoded = decodeURIComponent(route);
    if (decoded !== route) forms.push(decoded);
  } catch {
    // Not a valid encoding, so there is no second spelling to check.
  }
  return forms;
}

/**
 * The page this request came from, as a path we are willing to return to.
 *
 * Two headers, because neither one covers both kinds of navigation:
 *
 *  - `next-url` is set by the App Router on a client-side transition and holds
 *    the page being navigated *to*, which is what a guard's redirect wants.
 *  - `Referer` is what a full document load and a server action POST carry. For
 *    an action it is exactly right: the form was submitted from the page the
 *    member is looking at, so signing out returns them to it.
 *
 * Returns `null` rather than throwing when there is no request to read — a
 * static render, a unit test, a background job. Somewhere to go back to is a
 * convenience, and it must never be the reason a page fails to render.
 */
export async function returnPathFromRequest(): Promise<string | null> {
  try {
    const list = await headers();
    return safeReturnPath(list.get("next-url")) ?? safeReturnPath(list.get("referer"));
  } catch {
    return null;
  }
}

/** `/signin`, carrying whichever of the two things the page needs to know. */
export function signInHref(
  options: { from?: string | null; error?: string | null } = {}
): string {
  const params = new URLSearchParams();
  if (options.error) params.set("error", options.error);
  const from = safeReturnPath(options.from);
  if (from) params.set("from", from);
  const query = params.toString();
  return query ? `${SIGN_IN_PATH}?${query}` : SIGN_IN_PATH;
}

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
  if (user) return user;

  // UC-01 6: they are being sent away from a page they asked for, so the page
  // they asked for is what sign-in returns them to.
  const from = await returnPathFromRequest();
  redirect(signInHref({ from }));
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
  if (!user) redirect(signInHref({ from: await returnPathFromRequest() }));
  // No `from` for this one: signing in again lands them on the same refusal,
  // because it is not authentication they are missing.
  if (!user.isAdmin) redirect(signInHref({ error: SIGN_IN_ERRORS.adminOnly }));
  return user;
}

/**
 * The signed-in person's row, if they may manage this event — otherwise a
 * redirect.
 *
 * Admins pass for every event; a host passes for the one they were given. This
 * is the only door into an event's admin screens, so a host who wanders to
 * somebody else's event id lands on the members' hub rather than on an editor
 * they can half use.
 *
 * The redirect goes to `/me` rather than to the sign-in page when somebody is
 * signed in but not allowed: sending a logged-in member to a login screen is
 * the most confusing possible answer to "you cannot see this".
 */
export async function requireEventManager(eventId: string): Promise<User> {
  const user = await requireUser();
  if (await canManageEvent(user, eventId)) return user;
  redirect("/me");
}

/**
 * As {@link requireEventManager}, but the event is resolved from a child row.
 *
 * For an action keyed on an application, a match or a stage. Passing the
 * child's own event id in from the browser would be authorising on an id
 * beside the write rather than on the write itself — see `event-scope.ts` for
 * the hole that opens.
 *
 * A child that does not exist redirects rather than 404s: telling somebody
 * which ids are real is a small leak, and the screen they came from is stale
 * either way.
 */
export async function requireManagerOfChild(
  resolve: () => Promise<string | null>
): Promise<{ user: User; eventId: string }> {
  const user = await requireUser();
  const eventId = await resolve();
  if (!eventId) redirect("/me");
  if (await canManageEvent(user, eventId)) return { user, eventId };
  redirect("/me");
}
