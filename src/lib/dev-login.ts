/**
 * The development sign-in escape hatch.
 *
 * ## Why this exists
 *
 * Phase 1's member and admin pages are all behind `requireUser()` /
 * `requireAdmin()`, and the only way to get a session is Discord — which needs
 * a client id, a secret and a guild id that do not exist yet (checklist.md,
 * "Blocked on you"). Without something like this, `/me/profile` and
 * `/admin/games` could be written but never *opened*, and code nobody has run
 * in a browser is code nobody has finished.
 *
 * So: a page that mints a real Auth.js **database session** for a local user.
 * Not a fake session object, not a guard bypass — an actual row in `sessions`
 * whose token is handed back in the cookie Auth.js reads. Every guard, every
 * `auth()` call and every `session.user.isAdmin` check downstream behaves
 * exactly as it will in production, because as far as the rest of the app is
 * concerned it *is* production behaviour. The only thing that skipped is the
 * OAuth handshake.
 *
 * ## Why it cannot leak into a deployment
 *
 * {@link devLoginEnabled} requires **both**:
 *
 *   1. `process.env.NODE_ENV === "development"`, and
 *   2. `DEV_LOGIN` switched on.
 *
 * `next build` — which is what Vercel runs, and what `npm run build` runs
 * locally — sets `NODE_ENV=production` and bakes it in; `next start` serves with
 * `NODE_ENV=production` too. There is no Vercel setting that makes a deployed
 * app report `development`, and `NODE_ENV` is not something an attacker can set
 * from a request. So on any deployment condition 1 is false and the page
 * answers 404 before it looks at anything else — even if someone copies
 * `DEV_LOGIN=1` into the Vercel dashboard by mistake, which is the realistic
 * accident this guards against. The two conditions are `&&` for exactly that
 * reason: either one alone would be a weaker promise.
 *
 * The check is re-run on every request (not captured at module load), and every
 * exported function that touches the database re-checks it rather than trusting
 * its caller.
 */

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { type Database, type User, db as defaultDb, sessions, users } from "@/db";
import { ensureHandles } from "./players";

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

/** The variables this module reads. `NODE_ENV` is included because it is a gate. */
export type DevLoginEnv = {
  NODE_ENV?: string;
  DEV_LOGIN?: string;
  DEV_LOGIN_DISCORD_ID?: string;
  DEV_LOGIN_ADMIN?: string;
};

/**
 * Where the browser goes to get a session.
 *
 * A page with a server action rather than an API route, and not for style: see
 * the note in `src/app/dev-login/actions.ts`. `next dev` runs route handlers in
 * a different process from page renders, and PGlite lives inside whichever
 * process opened it — so a session written by a route handler is invisible to
 * the pages it was meant to unlock.
 */
export const DEV_LOGIN_PATH = "/dev-login";

/**
 * Obviously not a Discord snowflake — snowflakes are digits — so a row created
 * by this can never be mistaken for, or collide with, a real member.
 */
export const DEV_LOGIN_DISCORD_ID = "dev-login-not-a-real-discord-id";

/** The name rendered everywhere the display name is. Says what it is. */
export const DEV_LOGIN_DISPLAY_NAME = "Dev Login (not a real member)";

/** Matches Auth.js's own database session lifetime in `src/lib/auth.ts`. */
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** The generous spellings of "on". `DEV_LOGIN=1` is the documented one. */
function isOn(raw: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((raw ?? "").trim().toLowerCase());
}

/**
 * Is the escape hatch live?
 *
 * Both conditions, never either. See the module comment for why that is the
 * whole safety argument.
 */
export function devLoginEnabled(env: DevLoginEnv = process.env as DevLoginEnv): boolean {
  return env.NODE_ENV === "development" && isOn(env.DEV_LOGIN);
}

export type DevLoginConfig = {
  discordId: string;
  displayName: string;
  isAdmin: boolean;
};

/** Who the escape hatch signs you in as. */
export function devLoginConfig(env: DevLoginEnv = process.env as DevLoginEnv): DevLoginConfig {
  const discordId = (env.DEV_LOGIN_DISCORD_ID ?? "").trim() || DEV_LOGIN_DISCORD_ID;
  return {
    discordId,
    displayName:
      discordId === DEV_LOGIN_DISCORD_ID ? DEV_LOGIN_DISPLAY_NAME : `Dev Login · ${discordId}`,
    isAdmin: isOn(env.DEV_LOGIN_ADMIN),
  };
}

/* ------------------------------------------------------------------ */
/* Cookies                                                            */
/* ------------------------------------------------------------------ */

/**
 * The cookie Auth.js reads the session token out of.
 *
 * Taken from `@auth/core`'s `defaultCookies()`: with the database strategy the
 * cookie value *is* the `sessions.session_token`, unwrapped, so writing this
 * cookie and inserting the matching row is the entire job. The `__Secure-`
 * prefix appears only over https, which local development is not — the argument
 * exists so the helper stays honest rather than because it will be used.
 */
export function devSessionCookieName(secure = false): string {
  return secure ? "__Secure-authjs.session-token" : "authjs.session-token";
}

/* ------------------------------------------------------------------ */
/* The session                                                        */
/* ------------------------------------------------------------------ */

export type DevSession = {
  /** The cookie value, and the primary key of the new `sessions` row. */
  sessionToken: string;
  expires: Date;
  user: User;
};

/** Thrown rather than returned: a disabled hatch is a bug at the call site. */
export class DevLoginDisabledError extends Error {
  constructor() {
    super(
      "The development sign-in is disabled. It requires NODE_ENV=development and DEV_LOGIN=1."
    );
    this.name = "DevLoginDisabledError";
  }
}

/**
 * Create or reuse the development user, then open a real database session for
 * them.
 *
 * Reuse matters: the point is that the profile you filled in yesterday is still
 * there today, so the row is keyed on `discord_id` and only ever updated. The
 * admin flag is *synced* rather than only granted — unlike the production
 * allowlist in `auth-policy.ts`, which must never demote a hand-promoted admin —
 * because flipping `DEV_LOGIN_ADMIN` off and getting an admin session anyway
 * would make the toggle useless for testing `requireAdmin()`.
 *
 * @throws DevLoginDisabledError when the hatch is not enabled.
 */
export async function establishDevSession(
  database: Database = defaultDb,
  env: DevLoginEnv = process.env as DevLoginEnv
): Promise<DevSession> {
  if (!devLoginEnabled(env)) throw new DevLoginDisabledError();

  const config = devLoginConfig(env);
  const now = new Date();

  const [existing] = await database
    .select()
    .from(users)
    .where(eq(users.discordId, config.discordId))
    .limit(1);

  let user: User;
  if (existing) {
    const [updated] = await database
      .update(users)
      .set({ isAdmin: config.isAdmin, lastSeenAt: now })
      .where(eq(users.id, existing.id))
      .returning();
    user = updated ?? existing;
  } else {
    const [created] = await database
      .insert(users)
      .values({
        discordId: config.discordId,
        displayName: config.displayName,
        name: config.displayName,
        isAdmin: config.isAdmin,
        lastSeenAt: now,
        // No email: `users.email` is unique, and a placeholder address would
        // collide the moment a second dev id was used.
      })
      .returning();
    user = created;
  }

  // A handle, so the member has a public profile from their first session —
  // the same thing `events.signIn` does for a real Discord sign-in. Idempotent,
  // so signing in twice does not renumber anybody.
  const handles = await ensureHandles([user.id], database);
  const handle = handles.get(user.id) ?? user.handle ?? null;

  const sessionToken = randomBytes(32).toString("base64url");
  const expires = new Date(now.getTime() + SESSION_MAX_AGE_MS);
  await database.insert(sessions).values({ sessionToken, userId: user.id, expires });

  return { sessionToken, expires, user: { ...user, handle } };
}

/**
 * Close a development session — the "sign out" behind the banner.
 *
 * Deletes the row, so the cookie that is cleared alongside it is dead even if a
 * copy of it exists somewhere. Unknown tokens are a no-op.
 *
 * @throws DevLoginDisabledError when the hatch is not enabled.
 */
export async function endDevSession(
  sessionToken: string | undefined,
  database: Database = defaultDb,
  env: DevLoginEnv = process.env as DevLoginEnv
): Promise<void> {
  if (!devLoginEnabled(env)) throw new DevLoginDisabledError();
  if (!sessionToken) return;
  await database.delete(sessions).where(eq(sessions.sessionToken, sessionToken));
}

/* ------------------------------------------------------------------ */
/* Redirects                                                          */
/* ------------------------------------------------------------------ */

/**
 * Where to land after signing in. Only same-origin paths are honoured, so
 * `?to=https://elsewhere` or `?to=//elsewhere` cannot turn the route into an
 * open redirect — a habit worth keeping even in a development-only handler.
 */
export function safeRedirectPath(raw: string | null | undefined, fallback = "/me/profile"): string {
  const value = (raw ?? "").trim();
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//")) return fallback;
  return value;
}
