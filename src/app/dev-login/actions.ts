"use server";

/**
 * The development sign-in, as server actions.
 *
 * ## Why this is not an API route
 *
 * It was one, and it did not work. `next dev` runs route handlers and page
 * renders in **separate Node processes**, and with no `DATABASE_URL` the app
 * runs on PGlite — an embedded Postgres that lives *inside* the process that
 * opened it. Two processes opening `./data/pg` get two independent instances,
 * so a `sessions` row inserted by a route handler is invisible to the process
 * that renders `/me/profile` until the server restarts. The symptom was
 * memorable: sign in, get redirected straight back to `/signin`, and find the
 * session sitting in the database exactly as expected.
 *
 * Server actions run in the same process as the page render, so writing from
 * here puts the session where the guards will look for it. None of this applies
 * once `DATABASE_URL` points at Neon — one real database, visible to every
 * process — but the escape hatch only ever runs in development, which is
 * precisely where PGlite is the default.
 *
 * Both actions re-check {@link devLoginEnabled} themselves. A server action is
 * a public endpoint, and the page's guard says nothing about who calls this
 * later.
 */

import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import {
  devLoginEnabled,
  devSessionCookieName,
  endDevSession,
  establishDevSession,
  safeRedirectPath,
} from "@/lib/dev-login";

/** Only true behind a TLS-terminating proxy. Local development never is. */
async function isSecureRequest(): Promise<boolean> {
  const forwarded = (await headers()).get("x-forwarded-proto") ?? "";
  return forwarded.split(",")[0].trim() === "https";
}

export async function devSignInAction(formData: FormData): Promise<void> {
  // The gate, re-read per request rather than captured at module load.
  if (!devLoginEnabled()) notFound();

  const { sessionToken, expires, user } = await establishDevSession();
  const secure = await isSecureRequest();

  (await cookies()).set(devSessionCookieName(secure), sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure,
    expires,
  });

  console.warn(
    `[dev-login] issued a development session for ${user.displayName ?? user.id}` +
      `${user.isAdmin ? " (admin)" : ""} — this is not a real sign-in.`
  );

  // `redirect` throws, so nothing runs after it.
  redirect(safeRedirectPath(formData.get("to")?.toString()));
}

export async function devSignOutAction(): Promise<void> {
  if (!devLoginEnabled()) notFound();

  const store = await cookies();
  const secure = await isSecureRequest();
  const name = devSessionCookieName(secure);

  // Delete the row as well as the cookie, so a copy of the token is dead too.
  await endDevSession(store.get(name)?.value);
  store.delete(name);

  redirect("/dev-login");
}
