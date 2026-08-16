import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTING_KEYS } from "@/db/schema";
import {
  type AuthEnv,
  REQUIRED_DISCORD_VARS,
  SIGN_IN_ERRORS,
  UNCONFIGURED_AUTH_SECRET,
  discordAvatarUrl,
  discordConfigStatus,
  discordIdentityFromProfile,
  evaluateGuildGate,
  hasDiscordCredentials,
  isGuildMember,
  parseAdminIds,
  resolveAuthSecret,
  resolveGateConfig,
  shouldBeAdmin,
} from "@/lib/auth-policy";

/**
 * The whole sign-in policy, tested without a network, a database or a Discord
 * app. That separation is the point of `auth-policy.ts`: `auth.ts` fetches and
 * writes, this decides.
 */

const GUILD = "123456789012345678";
const OTHER_GUILD = "987654321098765432";

/** The shape `GET /users/@me/guilds` actually returns, trimmed to what we read. */
function guild(id: string, name = "A server") {
  return { id, name, icon: null, owner: false, permissions: "0", features: [] };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------ */

describe("isGuildMember", () => {
  it("matches the gated guild anywhere in the list", () => {
    const guilds = [guild(OTHER_GUILD), guild(GUILD), guild("555")];
    expect(isGuildMember(guilds, GUILD)).toBe(true);
  });

  it("rejects someone who is only in other servers", () => {
    expect(isGuildMember([guild(OTHER_GUILD)], GUILD)).toBe(false);
  });

  it("treats an empty guild list as not a member", () => {
    expect(isGuildMember([], GUILD)).toBe(false);
  });

  it("treats a missing guild list as not a member", () => {
    expect(isGuildMember(null, GUILD)).toBe(false);
    expect(isGuildMember(undefined, GUILD)).toBe(false);
  });

  it("never matches when the gate has no guild id", () => {
    expect(isGuildMember([guild(GUILD)], "")).toBe(false);
    expect(isGuildMember([guild(GUILD)], "   ")).toBe(false);
  });

  it("ignores anything that is not an array of guilds", () => {
    expect(isGuildMember({ id: GUILD }, GUILD)).toBe(false);
    expect(isGuildMember(`[{"id":"${GUILD}"}]`, GUILD)).toBe(false);
    expect(isGuildMember(42, GUILD)).toBe(false);
  });

  it("survives junk entries in the list", () => {
    expect(isGuildMember([null, undefined, 7, "x", {}, guild(GUILD)], GUILD)).toBe(true);
    expect(isGuildMember([null, {}, { id: null }], GUILD)).toBe(false);
  });

  it("tolerates whitespace on either side of the id", () => {
    expect(isGuildMember([{ id: ` ${GUILD} ` }], GUILD)).toBe(true);
    expect(isGuildMember([guild(GUILD)], ` ${GUILD} `)).toBe(true);
  });

  it("refuses a numeric id rather than coercing a corrupted snowflake", () => {
    // 123456789012345678 cannot survive as a JS number; matching it would be a lie.
    expect(isGuildMember([{ id: Number(GUILD) }], GUILD)).toBe(false);
  });

  it("does not partially match a longer or shorter id", () => {
    expect(isGuildMember([guild(`${GUILD}0`)], GUILD)).toBe(false);
    expect(isGuildMember([guild(GUILD.slice(0, -1))], GUILD)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("resolveGateConfig", () => {
  const env: AuthEnv = { DISCORD_GUILD_ID: GUILD };

  it("defaults to enabled when nothing has been stored", () => {
    const gate = resolveGateConfig(null, env);
    expect(gate.enabled).toBe(true);
    expect(gate.source.enabled).toBe("default");
  });

  it("falls back to the environment for the guild id", () => {
    const gate = resolveGateConfig([], env);
    expect(gate).toMatchObject({ guildId: GUILD, configured: true });
    expect(gate.source.guildId).toBe("env");
  });

  it("lets the settings table override the environment", () => {
    const gate = resolveGateConfig([{ key: SETTING_KEYS.guildId, value: OTHER_GUILD }], env);
    expect(gate.guildId).toBe(OTHER_GUILD);
    expect(gate.source.guildId).toBe("settings");
  });

  it("accepts settings as a keyed map as well as rows", () => {
    const gate = resolveGateConfig(
      { [SETTING_KEYS.guildId]: OTHER_GUILD, [SETTING_KEYS.guildGateEnabled]: false },
      env
    );
    expect(gate).toMatchObject({ guildId: OTHER_GUILD, enabled: false });
  });

  it("turns the gate off when the setting says so", () => {
    const gate = resolveGateConfig([{ key: SETTING_KEYS.guildGateEnabled, value: false }], env);
    expect(gate.enabled).toBe(false);
    expect(gate.source.enabled).toBe("settings");
  });

  it("keeps the gate on when the setting says so explicitly", () => {
    const gate = resolveGateConfig([{ key: SETTING_KEYS.guildGateEnabled, value: true }], env);
    expect(gate).toMatchObject({ enabled: true, source: { enabled: "settings" } });
  });

  it("reads the spellings an admin form might post instead of a JSON boolean", () => {
    const read = (value: unknown) =>
      resolveGateConfig([{ key: SETTING_KEYS.guildGateEnabled, value: value as never }], env)
        .enabled;
    expect(read("false")).toBe(false);
    expect(read("off")).toBe(false);
    expect(read(0)).toBe(false);
    expect(read("TRUE")).toBe(true);
    expect(read(1)).toBe(true);
  });

  it("ignores a setting it cannot read as a boolean and stays on", () => {
    const gate = resolveGateConfig(
      [{ key: SETTING_KEYS.guildGateEnabled, value: "perhaps" }],
      env
    );
    expect(gate).toMatchObject({ enabled: true, source: { enabled: "default" } });
  });

  it("is not configured when both layers are blank", () => {
    const gate = resolveGateConfig(null, {});
    expect(gate).toMatchObject({ guildId: "", configured: false });
    expect(gate.source.guildId).toBe("none");
  });

  it("treats a blank settings row as absent so the environment can take over", () => {
    // Exactly what `npm run db:seed` writes before DISCORD_GUILD_ID is filled in.
    const gate = resolveGateConfig([{ key: SETTING_KEYS.guildId, value: "" }], env);
    expect(gate).toMatchObject({ guildId: GUILD, configured: true });
    expect(gate.source.guildId).toBe("env");
  });

  it("treats a blank environment value as absent too", () => {
    expect(resolveGateConfig(null, { DISCORD_GUILD_ID: "   " })).toMatchObject({
      guildId: "",
      configured: false,
    });
  });

  it("trims a stored guild id", () => {
    const gate = resolveGateConfig([{ key: SETTING_KEYS.guildId, value: `  ${OTHER_GUILD} ` }], {});
    expect(gate.guildId).toBe(OTHER_GUILD);
  });

  it("ignores a non-string guild id setting", () => {
    const gate = resolveGateConfig([{ key: SETTING_KEYS.guildId, value: 12345 }], env);
    expect(gate).toMatchObject({ guildId: GUILD, source: { guildId: "env" } });
  });

  it("ignores settings rows it does not know about", () => {
    const gate = resolveGateConfig([{ key: "something.else", value: "nonsense" }], env);
    expect(gate).toMatchObject({ enabled: true, guildId: GUILD });
  });

  it("reads process.env when no environment is passed", () => {
    vi.stubEnv("DISCORD_GUILD_ID", OTHER_GUILD);
    expect(resolveGateConfig(null).guildId).toBe(OTHER_GUILD);
  });
});

/* ------------------------------------------------------------------ */

describe("evaluateGuildGate", () => {
  const gate = (over: Partial<ReturnType<typeof resolveGateConfig>> = {}) => ({
    ...resolveGateConfig(null, { DISCORD_GUILD_ID: GUILD }),
    ...over,
  });

  it("lets a member through", () => {
    expect(evaluateGuildGate(gate(), [guild(GUILD)])).toEqual({ allowed: true });
  });

  it("rejects a non-member with a distinguishable code", () => {
    expect(evaluateGuildGate(gate(), [guild(OTHER_GUILD)])).toEqual({
      allowed: false,
      error: SIGN_IN_ERRORS.notInGuild,
    });
  });

  it("lets anyone through when the gate is switched off", () => {
    expect(evaluateGuildGate(gate({ enabled: false }), null)).toEqual({ allowed: true });
    expect(evaluateGuildGate(gate({ enabled: false }), [])).toEqual({ allowed: true });
  });

  it("fails closed when the gate is on but points nowhere", () => {
    const misconfigured = gate({ guildId: "", configured: false });
    expect(evaluateGuildGate(misconfigured, [guild(GUILD)])).toEqual({
      allowed: false,
      error: SIGN_IN_ERRORS.gateMisconfigured,
    });
  });

  it("tells a failed lookup apart from an empty membership list", () => {
    expect(evaluateGuildGate(gate(), null)).toEqual({
      allowed: false,
      error: SIGN_IN_ERRORS.guildLookupFailed,
    });
    expect(evaluateGuildGate(gate(), [])).toEqual({
      allowed: false,
      error: SIGN_IN_ERRORS.notInGuild,
    });
  });
});

/* ------------------------------------------------------------------ */

describe("parseAdminIds", () => {
  it("splits on commas and trims", () => {
    expect(parseAdminIds("111, 222 ,333")).toEqual(["111", "222", "333"]);
  });

  it("drops empty entries, including trailing and doubled commas", () => {
    expect(parseAdminIds("111,,222, ,333,")).toEqual(["111", "222", "333"]);
  });

  it("returns nothing for a missing or blank value", () => {
    expect(parseAdminIds(undefined)).toEqual([]);
    expect(parseAdminIds(null)).toEqual([]);
    expect(parseAdminIds("")).toEqual([]);
    expect(parseAdminIds("  ,  ,")).toEqual([]);
  });

  it("collapses duplicates but keeps the first spelling and the order", () => {
    expect(parseAdminIds("222, 111, 222")).toEqual(["222", "111"]);
    expect(parseAdminIds("AbC, abc")).toEqual(["AbC"]);
  });
});

describe("shouldBeAdmin", () => {
  const list = " 111 ,,222,";

  it("promotes an id on the list", () => {
    expect(shouldBeAdmin("111", list)).toBe(true);
    expect(shouldBeAdmin("222", list)).toBe(true);
  });

  it("leaves everyone else alone", () => {
    expect(shouldBeAdmin("333", list)).toBe(false);
  });

  it("promotes nobody when the allowlist is empty or missing", () => {
    expect(shouldBeAdmin("111", "")).toBe(false);
    expect(shouldBeAdmin("111", undefined)).toBe(false);
    expect(shouldBeAdmin("111", null)).toBe(false);
    expect(shouldBeAdmin("111", " , , ")).toBe(false);
  });

  it("never promotes a missing discord id, even against a blank entry", () => {
    expect(shouldBeAdmin(null, list)).toBe(false);
    expect(shouldBeAdmin(undefined, list)).toBe(false);
    expect(shouldBeAdmin("", list)).toBe(false);
    expect(shouldBeAdmin("   ", list)).toBe(false);
    expect(shouldBeAdmin("", "111,,222")).toBe(false);
  });

  it("tolerates whitespace around the id being checked", () => {
    expect(shouldBeAdmin("  222  ", list)).toBe(true);
  });

  it("ignores casing on both sides", () => {
    expect(shouldBeAdmin("abc", "ABC")).toBe(true);
    expect(shouldBeAdmin("ABC", " abc , 111 ")).toBe(true);
  });

  it("does not match a partial id", () => {
    expect(shouldBeAdmin("11", list)).toBe(false);
    expect(shouldBeAdmin("1111", list)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("configuration detection", () => {
  const full: AuthEnv = {
    DISCORD_CLIENT_ID: "id",
    DISCORD_CLIENT_SECRET: "secret",
    AUTH_SECRET: "signing-key",
  };

  it("reports everything missing on a blank environment", () => {
    const status = discordConfigStatus({});
    expect(status.configured).toBe(false);
    expect(status.missing).toEqual([...REQUIRED_DISCORD_VARS]);
  });

  it("is configured once all three are filled in", () => {
    expect(discordConfigStatus(full)).toEqual({ configured: true, missing: [] });
  });

  it("names only what is still blank", () => {
    expect(discordConfigStatus({ ...full, DISCORD_CLIENT_SECRET: "" }).missing).toEqual([
      "DISCORD_CLIENT_SECRET",
    ]);
  });

  it("treats a whitespace-only value as blank", () => {
    expect(discordConfigStatus({ ...full, DISCORD_CLIENT_ID: "   " }).configured).toBe(false);
  });

  it("registers the provider on the client credentials alone", () => {
    expect(hasDiscordCredentials(full)).toBe(true);
    expect(hasDiscordCredentials({ ...full, AUTH_SECRET: "" })).toBe(true);
    expect(hasDiscordCredentials({ DISCORD_CLIENT_ID: "id" })).toBe(false);
    expect(hasDiscordCredentials({})).toBe(false);
  });

  it("reads process.env when no environment is passed", () => {
    vi.stubEnv("DISCORD_CLIENT_ID", "");
    vi.stubEnv("DISCORD_CLIENT_SECRET", "");
    expect(hasDiscordCredentials()).toBe(false);
    expect(discordConfigStatus().configured).toBe(false);
  });
});

describe("resolveAuthSecret", () => {
  it("uses AUTH_SECRET when it is set", () => {
    expect(resolveAuthSecret({ AUTH_SECRET: " signing-key " })).toBe("signing-key");
  });

  it("falls back to a placeholder while no Discord app exists, so the app boots", () => {
    expect(resolveAuthSecret({})).toBe(UNCONFIGURED_AUTH_SECRET);
  });

  it("refuses to invent a secret once real credentials are present", () => {
    // "" makes Auth.js throw MissingSecret, which is the right kind of loud.
    expect(
      resolveAuthSecret({ DISCORD_CLIENT_ID: "id", DISCORD_CLIENT_SECRET: "secret" })
    ).toBe("");
  });
});

/* ------------------------------------------------------------------ */

describe("discordAvatarUrl", () => {
  it("builds a custom avatar url", () => {
    expect(discordAvatarUrl(GUILD, "abc123")).toBe(
      `https://cdn.discordapp.com/avatars/${GUILD}/abc123.png?size=128`
    );
  });

  it("serves an animated avatar as a gif", () => {
    expect(discordAvatarUrl(GUILD, "a_abc123")).toContain(".gif");
  });

  it("falls back to the modern default avatar, indexed by the snowflake", () => {
    // (123456789012345678 >> 22) % 6 — BigInt maths, not float maths.
    const index = (BigInt(GUILD) >> 22n) % 6n;
    expect(discordAvatarUrl(GUILD, null)).toBe(
      `https://cdn.discordapp.com/embed/avatars/${index}.png`
    );
  });

  it("uses the legacy discriminator when the account still has one", () => {
    expect(discordAvatarUrl(GUILD, null, "0007")).toBe(
      "https://cdn.discordapp.com/embed/avatars/2.png"
    );
  });

  it("ignores the placeholder discriminator of a migrated account", () => {
    expect(discordAvatarUrl(GUILD, null, "0")).toContain("embed/avatars/");
    expect(discordAvatarUrl(GUILD, null, "0")).toBe(discordAvatarUrl(GUILD, null));
  });

  it("gives up rather than guessing when the id is unusable", () => {
    expect(discordAvatarUrl("", "hash")).toBeNull();
    expect(discordAvatarUrl("not-a-snowflake", null)).toBeNull();
  });
});

describe("discordIdentityFromProfile", () => {
  const profile = {
    id: GUILD,
    username: "handle",
    global_name: "Display Name",
    discriminator: "0",
    avatar: "abc123",
    email: "member@example.test",
  };

  it("pulls out the columns the users row needs", () => {
    expect(discordIdentityFromProfile(profile)).toEqual({
      discordId: GUILD,
      displayName: "Display Name",
      avatarUrl: `https://cdn.discordapp.com/avatars/${GUILD}/abc123.png?size=128`,
      email: "member@example.test",
    });
  });

  it("prefers the display name over the handle", () => {
    expect(discordIdentityFromProfile({ ...profile, global_name: null })?.displayName).toBe(
      "handle"
    );
  });

  it("falls back to the id when there is no name at all", () => {
    expect(discordIdentityFromProfile({ id: GUILD })?.displayName).toBe(GUILD);
  });

  it("reports no email, which is what the identify scope alone returns", () => {
    expect(discordIdentityFromProfile({ ...profile, email: null })?.email).toBeNull();
    expect(discordIdentityFromProfile({ id: GUILD })?.email).toBeNull();
  });

  it("returns null for anything without a usable id", () => {
    expect(discordIdentityFromProfile(null)).toBeNull();
    expect(discordIdentityFromProfile(undefined)).toBeNull();
    expect(discordIdentityFromProfile({})).toBeNull();
    expect(discordIdentityFromProfile({ id: "" })).toBeNull();
    expect(discordIdentityFromProfile({ id: 12345 })).toBeNull();
    expect(discordIdentityFromProfile("a string")).toBeNull();
  });

  it("hands the admin allowlist an id it can match", () => {
    const identity = discordIdentityFromProfile(profile);
    expect(shouldBeAdmin(identity?.discordId, ` ${GUILD} , 999`)).toBe(true);
  });
});
