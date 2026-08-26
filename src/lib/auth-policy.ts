/**
 * The sign-in policy — who is allowed in, and who is an admin.
 *
 * Everything here is a pure function over plain data: no database handle, no
 * `fetch`, no Auth.js imports. That is deliberate. The guild gate is the one
 * piece of Phase 1 that decides whether a person gets into the site at all, so
 * it has to be testable without a network, a Discord app or a session. The
 * wiring that feeds these functions — reading `settings`, calling Discord's
 * `/users/@me/guilds` — lives in `src/lib/auth.ts`.
 *
 * The gate's configuration follows docs/platform-plan.md §14: the guild id and
 * the on/off switch are *admin settings*, not constants. They are read from the
 * `settings` table with the environment as a fallback, so the gate can be
 * relaxed or pointed at a different server without a deploy.
 */

import { SETTING_KEYS, type SettingValue } from "@/db/schema";

/* ------------------------------------------------------------------ */
/* Shapes                                                             */
/* ------------------------------------------------------------------ */

/**
 * One entry of Discord's `GET /users/@me/guilds` response. The endpoint returns
 * more (`name`, `icon`, `owner`, `permissions`, `features`); only `id` matters
 * to the gate, and everything here tolerates the rest being absent.
 */
export type DiscordGuildSummary = {
  id: string;
  name?: string;
  [key: string]: unknown;
};

/** The environment variables the auth stack reads. */
export type AuthEnv = {
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_GUILD_ID?: string;
  ADMIN_DISCORD_IDS?: string;
  AUTH_SECRET?: string;
};

/**
 * `settings` rows, in whichever shape the caller happens to have them: the rows
 * straight out of a `select()`, an already-keyed map, or nothing at all (an
 * unmigrated or unreachable database, in which case the environment decides).
 */
export type SettingsSource =
  | ReadonlyArray<{ key: string; value: SettingValue }>
  | Readonly<Record<string, SettingValue>>
  | null
  | undefined;

/** Where the gate is pointed, and whether it is being enforced. */
export type GateConfig = {
  /** Is sign-in restricted to members of `guildId`? Defaults to on. */
  enabled: boolean;
  /** The Discord guild id membership is checked against. `""` when unset. */
  guildId: string;
  /** True when there is a guild id to check against — a blank id is "not configured". */
  configured: boolean;
  /** Which layer supplied each value. For the admin screen, and for diagnostics. */
  source: {
    enabled: "settings" | "default";
    guildId: "settings" | "env" | "none";
  };
};

/** Error codes the sign-in page renders, and the gate hands back. */
export const SIGN_IN_ERRORS = {
  /** Signed in with Discord, but not a member of the gated guild. */
  notInGuild: "not-in-guild",
  /** The gate is on but has no guild id, so it cannot be enforced. Fails closed. */
  gateMisconfigured: "gate-misconfigured",
  /** Discord would not tell us which guilds the user is in. */
  guildLookupFailed: "guild-lookup-failed",
  /** Signed in, but not an admin. Set by `requireAdmin()`. */
  adminOnly: "admin-only",
} as const;

export type SignInErrorCode = (typeof SIGN_IN_ERRORS)[keyof typeof SIGN_IN_ERRORS];

export type GateDecision = { allowed: true } | { allowed: false; error: SignInErrorCode };

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

/** Trim, and treat "missing" and "blank" as the same thing throughout. */
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Read one key out of whichever settings shape was handed over. */
function settingValue(source: SettingsSource, key: string): SettingValue | undefined {
  if (!source) return undefined;
  if (Array.isArray(source)) {
    // Last write wins, matching what a `select()` ordered by update would imply.
    let found: SettingValue | undefined;
    for (const row of source) {
      if (row && row.key === key) found = row.value;
    }
    return found;
  }
  return (source as Record<string, SettingValue>)[key];
}

/**
 * Coerce a stored setting to a boolean. The seed writes a real JSON boolean, but
 * an admin form posting `"true"` or a checkbox posting `1` should not silently
 * disable the gate, so the obvious spellings are accepted.
 */
function asBoolean(value: SettingValue | undefined): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalised = value.trim().toLowerCase();
    if (["true", "1", "on", "yes"].includes(normalised)) return true;
    if (["false", "0", "off", "no"].includes(normalised)) return false;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* The gate                                                           */
/* ------------------------------------------------------------------ */

/**
 * Is the user a member of the gated guild?
 *
 * `guilds` is whatever came back from `GET /users/@me/guilds`, typed as
 * `unknown` because it is network data: anything that is not an array of
 * objects with a **string** `id` is simply not a match. Numeric ids are
 * rejected rather than coerced — a Discord snowflake does not survive a
 * round trip through a JavaScript number, so a numeric `id` means the data
 * is already corrupt and matching it would be worse than failing.
 *
 * A blank `guildId` never matches: "gate against nothing" is a misconfiguration,
 * not an open door. See `evaluateGuildGate` for how that is reported.
 */
export function isGuildMember(guilds: unknown, guildId: string): boolean {
  const wanted = text(guildId);
  if (!wanted) return false;
  if (!Array.isArray(guilds)) return false;

  return guilds.some((guild) => {
    if (!guild || typeof guild !== "object") return false;
    const id = (guild as { id?: unknown }).id;
    return typeof id === "string" && id.trim() === wanted;
  });
}

/**
 * Where the gate points and whether it is on.
 *
 * Precedence, per §14: the `settings` table wins, the environment is the
 * fallback, and a blank value at either layer counts as absent. That last part
 * matters in practice — `npm run db:seed` writes an `auth.guild_id` row from
 * `DISCORD_GUILD_ID`, so a database seeded before the Discord app existed holds
 * an empty string. The environment has to be able to take over once it is
 * filled in, without anyone having to go and delete a settings row.
 *
 * The toggle has no environment fallback by design — there is no
 * `DISCORD_GUILD_GATE` variable — because §13 Q1 settled on gated-by-default.
 * Turning it off is an admin action, and the default when nothing says
 * otherwise is `true`.
 *
 * @param settingsRows rows from the `settings` table, a keyed map, or nothing.
 * @param env process.env, or a stub in tests.
 */
export function resolveGateConfig(
  settingsRows: SettingsSource,
  env: AuthEnv = process.env as AuthEnv
): GateConfig {
  const storedEnabled = asBoolean(settingValue(settingsRows, SETTING_KEYS.guildGateEnabled));
  const enabled = storedEnabled ?? true;

  const storedGuildId = text(settingValue(settingsRows, SETTING_KEYS.guildId));
  const envGuildId = text(env.DISCORD_GUILD_ID);
  const guildId = storedGuildId || envGuildId;

  return {
    enabled,
    guildId,
    configured: guildId.length > 0,
    source: {
      enabled: storedEnabled === undefined ? "default" : "settings",
      guildId: storedGuildId ? "settings" : envGuildId ? "env" : "none",
    },
  };
}

/**
 * The whole gate decision in one place, so `src/lib/auth.ts` never re-implements
 * any of it.
 *
 * Fails **closed**: a gate that is switched on but has no guild id rejects
 * everyone rather than letting everyone in. A misconfiguration that silently
 * opens the site is the one failure mode worth being noisy about.
 *
 * @param guilds the guild list, or anything else (`null` when the lookup failed).
 */
export function evaluateGuildGate(gate: GateConfig, guilds: unknown): GateDecision {
  if (!gate.enabled) return { allowed: true };
  if (!gate.configured) return { allowed: false, error: SIGN_IN_ERRORS.gateMisconfigured };
  if (!Array.isArray(guilds)) return { allowed: false, error: SIGN_IN_ERRORS.guildLookupFailed };
  if (!isGuildMember(guilds, gate.guildId)) {
    return { allowed: false, error: SIGN_IN_ERRORS.notInGuild };
  }
  return { allowed: true };
}

/* ------------------------------------------------------------------ */
/* The admin allowlist                                                */
/* ------------------------------------------------------------------ */

/**
 * `ADMIN_DISCORD_IDS` as a list. Comma separated, spaces and empty entries
 * tolerated (`"1, ,2,"` is two ids), duplicates collapsed, order preserved.
 *
 * Mirrors `parseAdminDiscordIds` in `src/db/seed.ts` — the seed promotes
 * existing rows, this promotes people as they sign in, and both have to read
 * the variable the same way.
 */
export function parseAdminIds(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }
  return ids;
}

/**
 * Is this Discord id on the `ADMIN_DISCORD_IDS` allowlist?
 *
 * Comparison is case-insensitive and whitespace-tolerant. Snowflakes are digits,
 * so casing should never come up — but the allowlist is hand-typed into an env
 * file, and a rule that only works when the typing is perfect is not much of a
 * rule.
 *
 * This only ever *grants* the flag. `is_admin` is also grantable in the admin UI
 * later (see `users.isAdmin` in the schema), so removing an id from the variable
 * must not silently demote someone an admin promoted by hand.
 */
export function shouldBeAdmin(
  discordId: string | null | undefined,
  adminIdsEnv: string | undefined | null
): boolean {
  const id = text(discordId).toLowerCase();
  if (!id) return false;
  return parseAdminIds(adminIdsEnv).some((allowed) => allowed.toLowerCase() === id);
}

/** One row of the allowlist, as much of it as the decision needs. */
export type AllowlistEntry = { discordId: string; allowed: boolean };

/**
 * Whether this Discord id should hold the admin flag after signing in.
 *
 * Three answers, and the third is the one that matters:
 *
 *  - A row saying `allowed` — yes. This is how somebody who has never signed
 *    in gets to be an admin the first time they do; there is no account to
 *    promote yet, so promoting the account cannot be the mechanism.
 *  - A row saying not allowed — no, and it outranks everything. It beats
 *    `ADMIN_DISCORD_IDS`, which is the whole point: an id left in the
 *    environment used to resurrect itself on every sign-in.
 *  - No row — no opinion, so the environment decides, which is what lets a
 *    fresh deployment bootstrap its first admin before this table has anything
 *    in it.
 *
 * `undefined` is returned for "no opinion either way", distinct from `false`.
 * The caller needs the difference: `false` demotes, `undefined` leaves a
 * promotion made on the members screen exactly where it is.
 */
export function resolveAdminFlag(
  discordId: string | null | undefined,
  allowlist: readonly AllowlistEntry[] | null,
  adminIdsEnv: string | undefined | null
): boolean | undefined {
  const id = text(discordId).toLowerCase();
  if (!id) return undefined;

  const row = allowlist?.find((entry) => text(entry.discordId).toLowerCase() === id);
  if (row) return row.allowed;

  return shouldBeAdmin(discordId, adminIdsEnv) ? true : undefined;
}

/**
 * A Discord id, or `null` when it is not one.
 *
 * Snowflakes are 17 to 20 digits. Anything else is a username, a mention with
 * the punctuation left on, or a mis-paste — and storing one would make an
 * allowlist row that can never match anybody, which looks identical on screen
 * to one that works.
 */
export function normaliseDiscordId(raw: string | null | undefined): string | null {
  const trimmed = text(raw).replace(/[<@!>\s]/g, "");
  return /^\d{17,20}$/.test(trimmed) ? trimmed : null;
}

/* ------------------------------------------------------------------ */
/* "Is Discord wired up at all?"                                      */
/* ------------------------------------------------------------------ */

/** The variables that must be filled in before anyone can sign in with Discord. */
export const REQUIRED_DISCORD_VARS = [
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "AUTH_SECRET",
] as const;

export type DiscordConfigStatus = {
  /** True when sign-in can actually be attempted. */
  configured: boolean;
  /** Names of the blank variables, in the order above. Empty when configured. */
  missing: string[];
};

/**
 * Are the Discord client credentials present?
 *
 * Kept separate from {@link discordConfigStatus} because it answers a different
 * question: whether to *register the provider at all*. Registering a provider
 * with a blank client id would let Auth.js accept a request it can only fail,
 * so with no credentials the provider list stays empty and `/api/auth/*` is
 * inert rather than broken.
 */
export function hasDiscordCredentials(env: AuthEnv = process.env as AuthEnv): boolean {
  return Boolean(text(env.DISCORD_CLIENT_ID) && text(env.DISCORD_CLIENT_SECRET));
}

/**
 * What is still missing before sign-in works. This is what the sign-in page
 * renders as "Discord sign-in is not configured yet".
 */
export function discordConfigStatus(env: AuthEnv = process.env as AuthEnv): DiscordConfigStatus {
  const missing = REQUIRED_DISCORD_VARS.filter((name) => !text(env[name]));
  return { configured: missing.length === 0, missing: [...missing] };
}

/**
 * Placeholder used only while there is no Discord app.
 *
 * Auth.js refuses to run without a `secret` — it is what signs the CSRF and
 * OAuth `state` cookies. With no client credentials nobody can start a sign-in,
 * so nothing is protected by this value and its only job is to let the app
 * build, boot and serve `/signin`. Same idea as the dev fallback in
 * `src/lib/session.ts`.
 */
export const UNCONFIGURED_AUTH_SECRET = "job-centre-unconfigured-dev-only-auth-secret";

/**
 * The secret Auth.js should sign with.
 *
 * Returns `""` — which makes Auth.js throw `MissingSecret` loudly — when Discord
 * *is* configured but `AUTH_SECRET` is not. That combination is a real
 * deployment mistake and must not be papered over with a public constant.
 */
export function resolveAuthSecret(env: AuthEnv = process.env as AuthEnv): string {
  const secret = text(env.AUTH_SECRET);
  if (secret) return secret;
  return hasDiscordCredentials(env) ? "" : UNCONFIGURED_AUTH_SECRET;
}

/* ------------------------------------------------------------------ */
/* Discord identity                                                   */
/* ------------------------------------------------------------------ */

/** The columns of `users` we fill in from Discord. */
export type DiscordIdentity = {
  discordId: string;
  displayName: string;
  avatarUrl: string | null;
  email: string | null;
};

const CDN = "https://cdn.discordapp.com";

/**
 * The avatar Discord shows for this user.
 *
 * Custom avatars are `/avatars/<id>/<hash>`, animated when the hash starts with
 * `a_`. Without one Discord falls back to a numbered default: indexed by
 * `(id >> 22) % 6` for the new username system, and by `discriminator % 5` for
 * legacy accounts that still have one.
 */
export function discordAvatarUrl(
  id: string,
  avatarHash: string | null | undefined,
  discriminator?: string | null
): string | null {
  const userId = text(id);
  if (!userId) return null;

  const hash = text(avatarHash);
  if (hash) {
    const extension = hash.startsWith("a_") ? "gif" : "png";
    return `${CDN}/avatars/${userId}/${hash}.${extension}?size=128`;
  }

  const tag = text(discriminator);
  if (tag && tag !== "0") {
    const legacy = Number.parseInt(tag, 10);
    if (Number.isFinite(legacy)) return `${CDN}/embed/avatars/${legacy % 5}.png`;
  }

  try {
    // BigInt, not Number: a snowflake is 64-bit and `>> 22` on a float is wrong.
    return `${CDN}/embed/avatars/${(BigInt(userId) >> 22n) % 6n}.png`;
  } catch {
    return null;
  }
}

/**
 * Pull the identity columns out of a Discord OAuth profile.
 *
 * Returns `null` for anything without a usable `id`, so callers have one thing
 * to check. `displayName` prefers the account's display name (`global_name`)
 * over the handle, because that is the name people recognise in the server.
 *
 * With only the `identify` scope Discord does not return an email, so `email`
 * is usually `null` — the account is keyed by `discordId`, not by address.
 */
export function discordIdentityFromProfile(profile: unknown): DiscordIdentity | null {
  if (!profile || typeof profile !== "object") return null;
  const raw = profile as Record<string, unknown>;

  const discordId = text(raw.id);
  if (!discordId) return null;

  const displayName = text(raw.global_name) || text(raw.username) || discordId;
  const avatarUrl = discordAvatarUrl(
    discordId,
    typeof raw.avatar === "string" ? raw.avatar : null,
    typeof raw.discriminator === "string" ? raw.discriminator : null
  );

  return {
    discordId,
    displayName,
    avatarUrl,
    email: text(raw.email) || null,
  };
}
