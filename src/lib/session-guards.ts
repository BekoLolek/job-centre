/**
 * Session helpers for the Discord identity (R-01, R-02, R-06 / UC-01).
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
 * // a page for whoever holds a power, and for every admin
 * const actor = await requirePermission("games.manage");
 *
 * // a page that is more than one power's
 * const reader = await requireAnyPermission(["events.create", "events.manage"]);
 *
 * // a page that renders differently when signed out
 * const user = await getCurrentUser();
 * ```
 *
 * All of them are server-only: they read the session cookie, so they belong in a
 * server component, a server action or a route handler.
 *
 * ## The one other way to get a session
 *
 * There used to be a second identity here: `src/lib/session.ts`, the legacy
 * captain-password login the old draft board ran on, with its own cookie and
 * its own `role: admin | captain | observer`. It was retired with the rest of
 * the single-purpose board and **no longer exists**, so nothing below has a
 * second cookie to be confused with.
 *
 * What remains beside Discord is the developer sign-in (R-142 / UC-30) in
 * `src/lib/dev-login.ts`. That is not a parallel identity: it mints a real
 * Auth.js database session, so these helpers read it exactly as they read
 * a Discord one. The draft room's `role` is a different thing again — a per-
 * event view computed by `viewerFor` in `src/lib/draft.ts`, which is why a
 * signed-out visitor can still watch a draft (R-70 / UC-16). It is not a login.
 */

import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { type User, db, users } from "@/db";
import { SIGN_IN_PATH, auth } from "./auth";
import { SIGN_IN_ERRORS } from "./auth-policy";
import { canManageEvent } from "./hosting";
import { powersOf } from "./permissions";
import { type Power, assertPower, holds } from "./permissions-policy";

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
 * The signed-in member's row, if they hold this power - otherwise the redirect
 * {@link requireAdmin} gives (R-261 / UC-56).
 *
 * An admin passes whatever they hold: the flag answers before the grants are
 * read, as it does in `canManageEvent`, so an admin never depends on a row in
 * `user_permissions`. Anybody else passes when the power is on their own list.
 *
 * **Refused exactly as a non-admin is.** Signed out goes to sign in and comes
 * back; signed in without the power goes to `?error=admin-only` with no way
 * back. A member who cannot do a thing is told the page is not theirs, the
 * sentence they would have been told before powers existed - not a second
 * vocabulary of refusals to learn. Like every guard here it refuses by
 * throwing (`redirect()` throws), never by returning something a caller can
 * ignore.
 *
 * **Read on every request, never from the session.** The row comes from
 * {@link requireUser} and the grants from `powersOf`, both asked of the database
 * on this call. Nothing is cached and nothing is carried in the cookie, so a
 * power revoked a moment ago is refused on the holder's next click without
 * anybody signing out (UC-56 3b) - the reason `is_admin` is read that way.
 *
 * **It returns the actor, not the answer.** The audit line an action writes
 * names the person who did the thing; which power let them is not who did it.
 *
 * ## Granting is not a power, and this guard must never gate it
 *
 * There is no `permissions.grant` to pass here, and that is R-264, not a gap.
 * The screen that gives and takes powers, and the one that gives and takes the
 * admin flag, keep `requireAdmin`. If either could be reached through a power,
 * a holder of that power could hand themselves every other one. Do not add
 * such a power "for consistency" with the screens around it: its absence is
 * the requirement. `permissions-policy.test.ts` pins the vocabulary name by
 * name, so any addition fails there; `require-permission.test.ts` shows that
 * holding all of it still does not pass `requireAdmin`.
 */
export async function requirePermission(power: Power): Promise<User> {
  const user = await requireUser();
  const powers = user.isAdmin ? new Set<Power>() : await powersOf(user.id);
  if (!holds({ isAdmin: user.isAdmin, powers }, power)) {
    redirect(signInHref({ error: SIGN_IN_ERRORS.adminOnly }));
  }
  return user;
}

/**
 * As {@link requirePermission}, for a screen that is more than one power's:
 * the member's row if they hold **any one** of these, otherwise the same
 * redirect (R-265 / UC-56 1, 3a).
 *
 * `/admin/events` is where an event is made and where one is found, which are
 * two powers; `/admin/settings` is two halves; `/admin` is the front door for
 * every area. None of them has one power to name, and each used to be written
 * as `requireUser` with the refusal on the line after it. That shape is a
 * guard the sweep cannot see: `every-action-is-gated.test.ts` reads the first
 * line, so a page whose second line was forgotten would admit any signed-in
 * member to an admin screen and still read as gated. This is that second line
 * moved into the guard, so the page's whole answer is one expression on its
 * first line.
 *
 * Everything else is `requirePermission`'s, deliberately, and
 * `require-permission.test.ts` asks the same questions of both:
 *
 *  - an admin passes without their grants being read;
 *  - the row and the grants are read on this call, never from the session;
 *  - signed out goes to sign in and comes back, signed in without any of
 *    these goes to `?error=admin-only` with no way back;
 *  - a name outside the vocabulary throws, for an admin as well.
 *
 * **An empty list admits an admin and nobody else.** There is nothing on it
 * to hold, so it is not "anybody".
 *
 * It must never gate the granting of powers or of the admin flag, for the
 * reason given on {@link requirePermission}: no list of powers reaches those.
 */
export async function requireAnyPermission(powers: readonly Power[]): Promise<User> {
  const user = await requireUser();
  // Every name, before anybody is answered: `some` below stops at the first
  // power held, and an admin is never asked about any of them.
  for (const power of powers) assertPower(power);
  if (user.isAdmin) return user;

  const holder = { isAdmin: false, powers: await powersOf(user.id) };
  if (!powers.some((power) => holds(holder, power))) {
    redirect(signInHref({ error: SIGN_IN_ERRORS.adminOnly }));
  }
  return user;
}

/**
 * The signed-in person's row, if they may manage this event — otherwise a
 * redirect.
 *
 * Admins pass for every event; a host passes for the one they were given; a
 * holder of `events.manage` passes for every event, as an admin does (R-261 /
 * UC-56). All three are `canManageEvent`'s answers and are decided there. This
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
