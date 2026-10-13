/**
 * The Discord provider's issuer (R-01 / UC-01).
 *
 * This file exists because of one production outage, and it guards exactly the
 * line that caused it.
 *
 * Discord returns an `iss` parameter on the OAuth callback. `@auth/core`
 * validates it against `provider.issuer ?? "https://authjs.dev"`
 * (`lib/actions/callback/oauth/callback.js:50`, carrying its own
 * `// TODO: review fallback issuer`), and the built-in Discord provider in
 * `@auth/core@0.41.3` sets no issuer. So every sign-in died in the callback
 * with `unexpected "iss" (issuer) response parameter value`, which reaches the
 * member as the catch-all `Configuration` because `CallbackRouteError` is not
 * a type Auth.js will name in public.
 *
 * Nothing in this repo caused it - Discord started sending the parameter - and
 * nothing in this repo could have prevented it. The value simply has to be
 * stated, which makes it exactly the kind of line somebody tidies away later
 * because it looks redundant beside a provider that "already knows" its own
 * issuer. It is not redundant until `@auth/core` sets it, and when that day
 * comes this test still passes, because it would be setting the same value.
 *
 * The expected value is Discord's own, from
 * https://discord.com/.well-known/openid-configuration ("issuer":
 * "https://discord.com"), not a guess.
 */

import { describe, expect, it, vi } from "vitest";
import type { AuthEnv } from "../auth-policy";

/*
 * `next-auth` reaches for `next/server`, which does not resolve in the node
 * environment this suite runs in - importing `../auth` for real fails before a
 * single assertion runs. Only the default export is needed here, and only so
 * the module finishes loading: everything asserted below is the plain object
 * `buildAuthConfig` returns.
 *
 * `next-auth/providers/discord` is NOT mocked. It is the thing under test -
 * the whole point is what the real provider factory does with the issuer we
 * hand it, so a stub would assert our own stub back at us.
 */
vi.mock("next-auth", () => ({
  default: () => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }),
}));

const { buildAuthConfig } = await import("../auth");

/** Enough environment for `hasDiscordCredentials` to include the provider. */
const ENV: AuthEnv = {
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_CLIENT_SECRET: "client-secret",
  AUTH_SECRET: "a-secret-long-enough-to-pass",
};

/**
 * The Discord provider, and separately the options we hand it.
 *
 * `Discord({...})` does not apply what it is given: it returns the library's
 * defaults with the caller's values parked under `options`, and `parseProviders`
 * merges the two at request time -
 * `const { options: userOptions, ...defaults } = provider;`
 * `const merged = merge(defaults, userOptions, {...})`
 * (`node_modules/@auth/core/lib/utils/providers.js:12-15`).
 *
 * So the top level is the library's answer and `options` is ours, and the two
 * assertions below mean different things on purpose: that the default really
 * is missing an issuer (the reason the line has to exist at all), and that we
 * really do supply one (the line still being there).
 */
function discordProvider(env: AuthEnv = ENV): Record<string, unknown> {
  const providers = buildAuthConfig(env).providers as unknown as Record<string, unknown>[];
  const discord = providers.find((provider) => provider.id === "discord");
  if (!discord) throw new Error("the Discord provider is not in the config");
  return discord;
}

function discordOptions(env: AuthEnv = ENV): Record<string, unknown> {
  return (discordProvider(env).options ?? {}) as Record<string, unknown>;
}

describe("the Discord provider", () => {
  it("states Discord's own issuer, which the library does not", () => {
    expect(discordOptions().issuer).toBe("https://discord.com");
  });

  it("is still needed: @auth/core's own Discord defaults carry no issuer", () => {
    // If this ever fails, the library has started setting it and this file's
    // reason for existing has gone - check the value agrees before deleting
    // the line, because a DIFFERENT value would break sign-in all over again.
    expect(discordProvider().issuer).toBeUndefined();
  });

  it("asks Discord for the scopes the guild gate needs", () => {
    const authorization = discordOptions().authorization as { params?: { scope?: string } };
    expect(authorization?.params?.scope).toContain("identify");
    expect(authorization?.params?.scope).toContain("guilds");
  });

  it("keeps Discord's REST userinfo endpoint, so the profile shape is unchanged", () => {
    /*
     * Setting an issuer makes `providers.js:45` derive a `wellKnown` URL, and
     * discovery would hand back Discord's OIDC userinfo
     * (`/api/oauth2/userinfo`) in place of the REST one (`/api/users/@me`)
     * that `discordIdentityFromProfile` reads. It does not happen here:
     * `callback.js:33-48` only runs discovery when the token AND userinfo URLs
     * are both absent or still pointing at the authjs.dev placeholder, and
     * this provider sets both. Pinned because the consequence - every member's
     * name and avatar arriving in a different shape - is a long way from the
     * one line that would cause it.
     */
    // Before normalisation an endpoint is still whatever the provider wrote,
    // which here is a bare string rather than the `{ url }` it becomes later.
    const userinfo = discordProvider().userinfo as string | { url?: unknown };
    const url = typeof userinfo === "string" ? userinfo : String(userinfo?.url);
    expect(url).toBe("https://discord.com/api/users/@me");
    expect(url).not.toContain("authjs.dev");
    // And we are not overriding it, so discovery could not quietly replace it.
    expect(discordOptions().userinfo).toBeUndefined();
  });

  it("is left out entirely when there are no credentials, rather than half-built", () => {
    const providers = buildAuthConfig({ AUTH_SECRET: ENV.AUTH_SECRET }).providers;
    expect(providers).toHaveLength(0);
  });
});
