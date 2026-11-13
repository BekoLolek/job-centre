import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The development sign-in's two actions, when the escape hatch is shut.
 *
 * `src/lib/__tests__/dev-login.test.ts` proves `devLoginEnabled()` answers
 * rightly. Nothing proved that the actions **ask it** - and they are server
 * actions, so each is a POST endpoint on the deployed site whatever the page
 * in front of it does. `devSignInAction` mints a session. If its first line
 * were weakened, production would have an endpoint that signs anybody in, and
 * the helper's tests would all still pass.
 *
 * The sweep in `src/app/__tests__/every-action-is-gated.test.ts` excuses these
 * two from having a session guard and pins that they *open with*
 * `devLoginEnabled()` then `notFound()`. That is a fact about the text. This
 * file is the behaviour under it: shut means a 404, and nothing minted or
 * ended on the way there.
 *
 * Only the two functions that touch the database are replaced, so that "was a
 * session minted" is a question the test can ask. The gate itself is the real
 * one, reading the real environment.
 */
const session = vi.hoisted(() => ({ establish: vi.fn(), end: vi.fn() }));

vi.mock("@/lib/dev-login", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dev-login")>()),
  establishDevSession: session.establish,
  endDevSession: session.end,
}));

const { devSignInAction, devSignOutAction } = await import("../actions");

/** The 404 `notFound()` throws, as it reaches a caller. */
const NOT_FOUND = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };

/** Each is one condition short of the three `devLoginEnabled` needs. */
const SHUT = [
  ["a production deployment with the switch left on", { NODE_ENV: "production", DEV_LOGIN: "1", DATABASE_URL: "" }],
  ["development with the switch off", { NODE_ENV: "development", DEV_LOGIN: "", DATABASE_URL: "" }],
  [
    "development pointed at a remote database",
    { NODE_ENV: "development", DEV_LOGIN: "1", DATABASE_URL: "postgres://user:pass@db.example.test/site" },
  ],
] as const;

function stub(env: Record<string, string>) {
  Object.entries(env).forEach(([name, value]) => vi.stubEnv(name, value));
}

beforeEach(() => {
  session.establish.mockReset();
  session.end.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the development sign-in, with the escape hatch shut", () => {
  it.each(SHUT)("is not found on %s, and mints no session", async (_label, env) => {
    stub(env);

    await expect(devSignInAction(new FormData())).rejects.toMatchObject(NOT_FOUND);
    expect(session.establish).not.toHaveBeenCalled();
  });

  it.each(SHUT)("has no sign-out to find on %s, and ends no session", async (_label, env) => {
    stub(env);

    await expect(devSignOutAction()).rejects.toMatchObject(NOT_FOUND);
    expect(session.end).not.toHaveBeenCalled();
  });
});

/*
 * The other half, so the tests above cannot pass for the wrong reason: with all
 * three conditions met the same call gets past the gate. It then fails for want
 * of a request to set a cookie on - which is not this file's subject - but not
 * before it has asked for a session.
 */
describe("the development sign-in, with the escape hatch open", () => {
  it("gets past the gate and asks for a session", async () => {
    stub({ NODE_ENV: "development", DEV_LOGIN: "1", DATABASE_URL: "" });

    await expect(devSignInAction(new FormData())).rejects.not.toMatchObject(NOT_FOUND);
    expect(session.establish).toHaveBeenCalledOnce();
  });
});
