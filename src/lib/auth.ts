/**
 * Auth.js (NextAuth v5) — Discord sign-in, gated on guild membership.
 *
 * docs/platform-plan.md §3.2: database sessions so an admin can revoke access,
 * `is_admin` seeded from an env allowlist, and sign-in restricted to members of
 * a configured Discord guild.
 *
 * ## Where the decisions live
 *
 * Nothing here decides anything. Every rule — who is a member, where the gate
 * points, who is an admin, whether Discord is configured at all — is a pure
 * function in `./auth-policy`, unit-tested without a network. This module only
 * does the parts that need the outside world: read `settings`, call Discord,
 * write to `users`.
 *
 * ## The config is a function, not an object
 *
 * `NextAuth(() => …)` builds the config per request. That keeps module import
 * free of side effects — importing this file must not construct the Drizzle
 * adapter, because doing so touches the `db` proxy and would spin up a WASM
 * Postgres during `next build`. It also means the environment is read at
 * request time, which is what makes "fill in the variables and restart" the
 * whole go-live procedure.
 *
 * ## With no Discord app configured
 *
 * The provider list is empty, `/api/auth/*` stays inert instead of failing
 * mid-handshake, and `auth()` simply returns `null`. `/signin` renders the
 * not-configured state. Nothing throws.
 *
 * ## The legacy login is untouched
 *
 * `src/app/api/auth/login` and `logout` still sign the draft board in with
 * their own cookie (`src/lib/session.ts`). Auth.js owns `/api/auth/signin`,
 * `/callback/*`, `/session`, `/csrf` and `/signout`; the two never collide.
 */

import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq, inArray } from "drizzle-orm";
import NextAuth, { type DefaultSession, type NextAuthConfig } from "next-auth";
import Discord from "next-auth/providers/discord";
import {
  SETTING_KEYS,
  accounts,
  db,
  sessions,
  settings,
  users,
  verificationTokens,
} from "@/db";
import {
  type AuthEnv,
  type GateConfig,
  SIGN_IN_ERRORS,
  discordIdentityFromProfile,
  evaluateGuildGate,
  hasDiscordCredentials,
  resolveAuthSecret,
  resolveGateConfig,
  shouldBeAdmin,
} from "./auth-policy";

/* ------------------------------------------------------------------ */
/* Type augmentation                                                  */
/* ------------------------------------------------------------------ */

/**
 * The extra columns `users` carries beyond Auth.js's four. Declaring them here
 * is what lets the Discord `profile()` return them (the adapter inserts the
 * whole object) and lets the `session` callback expose them.
 */
declare module "next-auth" {
  interface User {
    discordId?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    isAdmin?: boolean;
    lastSeenAt?: Date | null;
  }

  interface Session {
    user: {
      /** The `users.id` uuid. Pass this to `getCurrentUser`-style lookups. */
      id: string;
      isAdmin: boolean;
      discordId: string | null;
      displayName: string | null;
    } & DefaultSession["user"];
  }
}

declare module "@auth/core/adapters" {
  interface AdapterUser {
    discordId?: string | null;
    displayName?: string | null;
    avatarUrl?: string | null;
    isAdmin?: boolean;
    lastSeenAt?: Date | null;
  }
}

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

/** Our own sign-in page. Auth.js's built-in one is never rendered. */
export const SIGN_IN_PATH = "/signin";

/** Identity plus the guild list. Nothing else is asked for (§3.2). */
export const DISCORD_SCOPES = "identify guilds";

const DISCORD_GUILDS_ENDPOINT = "https://discord.com/api/users/@me/guilds";

/** A month. Database-backed, so revoking is a `delete from sessions`. */
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

/* ------------------------------------------------------------------ */
/* The outside world                                                  */
/* ------------------------------------------------------------------ */

/**
 * The guilds this access token can see, or `null` if Discord would not say.
 *
 * `null` and `[]` are deliberately different: an empty array is "member of
 * nothing", a `null` is "we do not know", and `evaluateGuildGate` rejects both
 * but reports them differently so a Discord outage is not mistaken for someone
 * having left the server.
 */
async function fetchDiscordGuilds(
  accessToken: string | undefined | null
): Promise<unknown[] | null> {
  if (!accessToken) return null;
  try {
    const response = await fetch(DISCORD_GUILDS_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!response.ok) {
      console.error(`[auth] guild lookup failed: ${response.status} ${response.statusText}`);
      return null;
    }
    const body: unknown = await response.json();
    return Array.isArray(body) ? body : null;
  } catch (error) {
    console.error("[auth] guild lookup threw", error);
    return null;
  }
}

/**
 * The gate's configuration: `settings` first, environment second (§14).
 *
 * A database that has not been migrated yet, or is simply unreachable, must not
 * take the site down — it falls back to the environment, which still leaves the
 * gate enabled and therefore still fails closed.
 */
async function loadGateConfig(env: AuthEnv = process.env as AuthEnv): Promise<GateConfig> {
  try {
    const rows = await db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(inArray(settings.key, [SETTING_KEYS.guildGateEnabled, SETTING_KEYS.guildId]));
    return resolveGateConfig(rows, env);
  } catch (error) {
    console.error("[auth] could not read the guild gate settings; falling back to env", error);
    return resolveGateConfig(null, env);
  }
}

/**
 * Copy the current Discord identity onto the user row and stamp `last_seen_at`.
 *
 * Runs in the `signIn` *event*, which fires after the adapter has created or
 * found the row — the `signIn` *callback* runs before it exists, so it is the
 * wrong place to write.
 *
 * `isAdmin` is only ever set to `true`. The allowlist seeds the first admins;
 * dropping an id from it later must not demote someone who was promoted in the
 * admin UI (§3.2).
 *
 * NOTE: `displayName` and `avatarUrl` are refreshed from Discord on every
 * sign-in, so a rename in the server shows up on the site. When a "change your
 * display name" screen lands, this needs a flag to stop it overwriting a name
 * the member chose.
 */
async function syncUserFromDiscord(
  userId: string,
  profile: unknown,
  env: AuthEnv = process.env as AuthEnv
): Promise<void> {
  const identity = discordIdentityFromProfile(profile);
  const patch: Partial<typeof users.$inferInsert> = { lastSeenAt: new Date() };

  if (identity) {
    patch.discordId = identity.discordId;
    patch.displayName = identity.displayName;
    patch.avatarUrl = identity.avatarUrl;
    patch.image = identity.avatarUrl;
    if (shouldBeAdmin(identity.discordId, env.ADMIN_DISCORD_IDS)) patch.isAdmin = true;
  }

  try {
    await db.update(users).set(patch).where(eq(users.id, userId));
  } catch (error) {
    // A failed profile refresh must not fail an otherwise valid sign-in.
    console.error("[auth] could not sync the Discord profile onto the user row", error);
  }
}

/* ------------------------------------------------------------------ */
/* Config                                                             */
/* ------------------------------------------------------------------ */

/** Rejections come back as our own page with a code the page can explain. */
function rejectTo(error: string): string {
  return `${SIGN_IN_PATH}?error=${error}`;
}

function discordProvider(env: AuthEnv) {
  return Discord({
    clientId: env.DISCORD_CLIENT_ID,
    clientSecret: env.DISCORD_CLIENT_SECRET,
    authorization: { params: { scope: DISCORD_SCOPES } },
    /**
     * The row a brand-new member is created with. The adapter drops `id` (the
     * database mints the uuid) and ignores keys that are not columns, so the
     * Job Centre columns from §7 are populated at creation rather than by a
     * follow-up write.
     */
    profile(profile) {
      const identity = discordIdentityFromProfile(profile);
      const discordId = identity?.discordId ?? profile.id;
      const displayName = identity?.displayName ?? profile.username;
      const avatarUrl = identity?.avatarUrl ?? null;

      return {
        id: discordId,
        name: displayName,
        email: identity?.email ?? null,
        image: avatarUrl,
        discordId,
        displayName,
        avatarUrl,
        isAdmin: shouldBeAdmin(discordId, env.ADMIN_DISCORD_IDS),
        lastSeenAt: new Date(),
      };
    },
  });
}

/**
 * Build the Auth.js config for one request.
 *
 * Exported so a future test or script can inspect it without going through
 * `NextAuth()`.
 */
export function buildAuthConfig(env: AuthEnv = process.env as AuthEnv): NextAuthConfig {
  return {
    // No credentials, no provider. See the module comment.
    providers: hasDiscordCredentials(env) ? [discordProvider(env)] : [],

    adapter: DrizzleAdapter(db, {
      usersTable: users,
      accountsTable: accounts,
      sessionsTable: sessions,
      verificationTokensTable: verificationTokens,
    }),

    // §3.2 — an opaque token in Postgres, so access can be revoked.
    session: { strategy: "database", maxAge: SESSION_MAX_AGE },

    secret: resolveAuthSecret(env),

    // Auth.js's own pages are never shown; ours explains the guild gate.
    pages: { signIn: SIGN_IN_PATH, error: SIGN_IN_PATH },

    callbacks: {
      /**
       * The gate. Runs before the user or account row is created, so a
       * rejected outsider leaves nothing behind in the database.
       */
      async signIn({ account }) {
        if (account?.provider !== "discord") return true;

        const gate = await loadGateConfig(env);
        // Only ask Discord for the guild list when the answer can matter.
        const guilds =
          gate.enabled && gate.configured
            ? await fetchDiscordGuilds(account.access_token)
            : null;

        const decision = evaluateGuildGate(gate, guilds);
        if (decision.allowed) return true;

        if (decision.error === SIGN_IN_ERRORS.gateMisconfigured) {
          console.error(
            "[auth] the guild gate is enabled but no guild id is set — rejecting everyone. " +
              `Set DISCORD_GUILD_ID or the "${SETTING_KEYS.guildId}" setting.`
          );
        }
        return rejectTo(decision.error);
      },

      /**
       * Put the Job Centre columns on the session so a page can check
       * `session.user.isAdmin` without a second query. `user` here is the full
       * row the adapter loaded alongside the session.
       */
      session({ session, user }) {
        session.user.id = user.id;
        session.user.isAdmin = user.isAdmin ?? false;
        session.user.discordId = user.discordId ?? null;
        session.user.displayName = user.displayName ?? user.name ?? null;
        return session;
      },
    },

    events: {
      async signIn({ user, profile }) {
        if (!user?.id) return;
        await syncUserFromDiscord(user.id, profile, env);
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Exports                                                            */
/* ------------------------------------------------------------------ */

export const { handlers, auth, signIn, signOut } = NextAuth(() => buildAuthConfig());
