/**
 * The server's own list of roles (R-203 / UC-37 4a, 4b).
 *
 * ## One read, and still no bot
 *
 * `GET /guilds/{id}/roles` with the same bot token `./discord-dm` already
 * holds — one outbound REST call, made while an admin is looking at the
 * settings screen. That is deliberately the whole of it: Out of scope rules out
 * "a hosted Discord bot process (slash commands, reading channels)", and names
 * this read as the exception it is. Nothing here opens a gateway connection,
 * nothing listens, and no process outlives the request.
 *
 * ## Inert without a token, exactly as DMs are
 *
 * `./discord-dm` is the precedent and this module copies its shape: the whole
 * feature is switched off when `DISCORD_BOT_TOKEN` is absent, nothing throws,
 * nothing warns on every request, and no caller has to branch on an error. What
 * is different is that the screen has to *say* so — a dropdown that silently
 * is not there looks like a bug, where "we cannot read your roles because no
 * bot token is set, so paste the id instead" is UC-37 4a.
 *
 * That is why {@link RoleListing} carries a `problem` rather than only an empty
 * list. An empty list is a real and different answer — a server whose only role
 * is `@everyone` — and a screen that rendered the two the same way would tell
 * an admin with no token that their server has no roles.
 *
 * ## Why the guild id is not an environment variable
 *
 * It is read through `getGateConfig()` by the caller and handed in. The guild
 * id is already stored and already admin-editable, because the sign-in gate
 * needs it (R-03), and `DISCORD_GUILD_ID` already exists as its *fallback*:
 * `loadGateConfig` resolves the stored setting first and the variable second. A
 * third source would be a third place to look, and reading the settings row
 * directly would be worse — a deployment configured purely by `DISCORD_GUILD_ID`
 * would look to this feature like no server had been set at all. So this module
 * takes the *resolved* value as an argument and reads no configuration of its
 * own beyond the token.
 *
 * ## The token
 *
 * It never leaves this module. It is read here, it goes into one
 * `authorization` header, and nothing it is used to fetch is returned
 * unfiltered: {@link RoleListing} is three scalar fields per role, built field
 * by field in {@link roleFrom}, so there is no path by which a response — or a
 * credential — reaches a prop. Nothing here writes to the audit log either,
 * because reading a list is not a change worth a row. Both halves are the
 * Constraint in `docs/requirements.md`: secrets "never reach the browser, the
 * settings screen or the audit log".
 */

import { type DmEnv, botToken } from "./discord-dm";

const API = "https://discord.com/api/v10";
const TIMEOUT_MS = 5_000;

/**
 * How long a fetched list is reused for.
 *
 * "Cache the list; a role list is not worth a request per page view." Five
 * minutes is picked against what the list is *for*: an admin who has just made
 * a role and come here to mention it is the one person who notices staleness,
 * and five minutes is shorter than that round trip. It is also why the paste
 * field matters past the dropdown — a role made ten seconds ago can always be
 * added by id.
 */
export const ROLE_CACHE_MS = 5 * 60_000;

/** A role, reduced to what a mention picker needs and nothing else. */
export type DiscordRole = {
  /** The snowflake. This is the only part a mention is built from. */
  id: string;
  /** For the admin to recognise. `@RoleName` is inert on Discord; the id pings. */
  name: string;
  /** Discord's own ordering — a higher number sits higher in the server's list. */
  position: number;
};

/**
 * Why there is no list to pick from.
 *
 * Four cases rather than one flag, because the screen's job in UC-37 4a is to
 * say *what is missing*, and "set a bot token" is a different instruction from
 * "point sign-in at your server first". `neither` is its own case rather than
 * two sentences stacked up, for the commonest install of all: one that has
 * never configured either.
 */
export type RoleListingProblem = "no_token" | "no_guild" | "neither" | "unreachable";

/**
 * The answer, whether or not it is a list.
 *
 * Exactly one of the two fields is null. Serialisable by construction — plain
 * strings and numbers — because it crosses to a client component as a prop.
 */
export type RoleListing = {
  /** The server's roles, or `null` when they could not be read. */
  roles: readonly DiscordRole[] | null;
  /** Why not, or `null` when `roles` is a list. */
  problem: RoleListingProblem | null;
};

/**
 * Which of the two things this feature needs is absent, or `null` for neither.
 *
 * Pure and exported because it is the guard R-203 rests on, and a guard inside
 * an async function that also does a network call is a guard that can only be
 * tested by stubbing a network call.
 */
export function whyNoList(hasToken: boolean, hasGuild: boolean): RoleListingProblem | null {
  if (!hasToken && !hasGuild) return "neither";
  if (!hasToken) return "no_token";
  if (!hasGuild) return "no_guild";
  return null;
}

/**
 * One role out of Discord's JSON, or `null` if it is not one.
 *
 * Built field by field rather than spread, which is the thing that makes the
 * Constraint structural instead of a promise: whatever else the response
 * carries — and it carries permissions, tags and integration ids — three
 * fields are what exist downstream, so there is no field anybody could add to
 * this type by accident.
 */
function roleFrom(raw: unknown): DiscordRole | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { id, name, position } = raw as Record<string, unknown>;
  if (typeof id !== "string" || id === "") return null;
  if (typeof name !== "string") return null;
  return { id, name, position: typeof position === "number" ? position : 0 };
}

/**
 * The roles an admin may pick, in the order the server shows them.
 *
 * Highest first, which is the order Discord's own role list is read in, so the
 * dropdown matches the screen the admin copied ids off before this existed.
 *
 * **`@everyone` is dropped.** Discord returns it as an ordinary row whose id is
 * the guild's own id, and it is not a role this picker should offer: pinging
 * the whole server is the checkbox above the dropdown, which needs no id and
 * works on an install with no token at all. Nothing rests on the id-equals-guild
 * rule being exactly right — the worst a wrong filter could do is leave one
 * option out of a dropdown whose paste field still takes any id by hand.
 */
export function pickableRoles(
  roles: readonly DiscordRole[],
  guildId: string
): readonly DiscordRole[] {
  return roles
    .filter((role) => role.id !== guildId)
    .slice()
    .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));
}

/**
 * Roles a template mentions that the server no longer has (UC-37 4b).
 *
 * **Flagged, never repaired.** The announcement still posts and Discord renders
 * a dead `<@&id>` as plain text, which is better than this site editing an
 * admin's words behind their back — so this returns the ids to say something
 * about and changes nothing.
 *
 * Returns nothing when there is no list, and that is the important half: with
 * no token we do not know whether a role still exists, and a screen that
 * flagged every mention as dead because it could not check would be worse than
 * one that flagged none. Not knowing is not the same as knowing it is gone.
 */
export function deadRoles(
  roleIds: readonly string[],
  listing: RoleListing
): readonly string[] {
  if (listing.roles === null) return [];
  const alive = new Set(listing.roles.map((role) => role.id));
  return roleIds.filter((id) => !alive.has(id));
}

/* ------------------------------------------------------------------ */
/* The one request                                                    */
/* ------------------------------------------------------------------ */

/**
 * Ask Discord, once, with no cache in front of it.
 *
 * Never throws, for `./discord-dm`'s reason: an admin is editing some wording
 * and a Discord outage is not a reason for the settings page to fail. A refusal
 * and an outage are the same answer here — `unreachable`, and the paste field
 * below it still works.
 */
export async function fetchGuildRoles(
  guildId: string,
  env: DmEnv = process.env as DmEnv
): Promise<RoleListing> {
  const token = botToken(env);
  const problem = whyNoList(token !== null, guildId.trim() !== "");
  if (problem) return { roles: null, problem };

  try {
    const response = await fetch(`${API}/guilds/${guildId}/roles`, {
      headers: { authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });

    if (!response.ok) {
      // The status, not the body: a 401 body from Discord is about our
      // credential, and this line goes to a server log an admin can read.
      console.error(`[discord-roles] ${response.status} reading the role list`);
      return { roles: null, problem: "unreachable" };
    }

    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) return { roles: null, problem: "unreachable" };

    const roles = body
      .map(roleFrom)
      .filter((role): role is DiscordRole => role !== null);

    return { roles: pickableRoles(roles, guildId), problem: null };
  } catch (error) {
    console.error("[discord-roles] could not reach Discord", error);
    return { roles: null, problem: "unreachable" };
  }
}

/* ------------------------------------------------------------------ */
/* The cache                                                          */
/* ------------------------------------------------------------------ */

/**
 * The list, cached in the process for {@link ROLE_CACHE_MS}.
 *
 * **Why not Next's cache.** `unstable_cache` is deprecated in this version —
 * `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/unstable_cache.md`
 * says it "has been replaced by `use cache` in Next.js 16" — and `use cache` is
 * a Cache Components feature that needs `cacheComponents: true` in
 * `next.config.mjs`, which this app does not set and which is not Task 61's to
 * turn on for every route in the site. The settings page is `force-dynamic`
 * besides. A module-scope memo needs none of that, is the whole of what "not a
 * request per page view" asks for, and can be proven by a test rather than by
 * trusting a framework flag.
 *
 * Keyed on the guild id, because the id is a setting an admin can change: a
 * cache that ignored it would answer with the old server's roles for five
 * minutes after somebody pointed the site at a new one.
 *
 * **Only successes are cached.** An admin who has just set the token is the
 * person most likely to be reloading this page, and caching `unreachable` would
 * make a fixed install look broken for another five minutes. A failure costs
 * one request per page view on an install nobody has configured yet, which is
 * bounded by how often an admin reloads a screen they are in the middle of
 * fixing.
 *
 * **What this cache is not**, said plainly rather than left to be discovered:
 * it lives in one server instance's memory, so on Vercel a cold start or a
 * second concurrent instance reads the list again, and nothing here is shared
 * between them. That is the right trade for what this is — the list is only
 * ever read while an admin is looking at one settings screen, so the worst case
 * is a handful of requests rather than one per page view, and the alternative
 * is a cache handler or a database row for data Discord already owns.
 */
let cached: { guildId: string; at: number; listing: RoleListing } | null = null;

/**
 * Forget the cached list.
 *
 * For tests. There is deliberately **no call to this from
 * `/admin/settings/actions.ts`** when an admin changes the guild id: the cache
 * is keyed on that id, so pointing the site at a different server misses the
 * entry rather than needing it swept, and an invalidation call that the key
 * already makes unnecessary is a second mechanism to keep in step.
 */
export function clearRoleCache(): void {
  cached = null;
}

export async function getGuildRoles(
  guildId: string,
  env: DmEnv = process.env as DmEnv,
  now: number = Date.now()
): Promise<RoleListing> {
  if (cached && cached.guildId === guildId && now - cached.at < ROLE_CACHE_MS) {
    return cached.listing;
  }

  const listing = await fetchGuildRoles(guildId, env);
  if (listing.roles !== null) cached = { guildId, at: now, listing };
  return listing;
}
