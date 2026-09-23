import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The guards' half of "return to the page they started from" (UC-01 6).
 *
 * `signin/__tests__/signin.test.ts` proves what the sign-in page does with the
 * value; this proves where the value comes from when a guard is the thing that
 * sent somebody away, and that `signInHref` cannot be talked into building a
 * link off-site either.
 *
 * `redirect` is replaced rather than caught: Next throws a digest string to
 * unwind the render, and asserting on the shape of that string would be a test
 * of Next's internals rather than of this module.
 */
const state = vi.hoisted(() => ({
  headers: {} as Record<string, string>,
  session: null as { user: { id: string } } | null,
  row: null as Record<string, unknown> | null,
}));

const redirect = vi.hoisted(() =>
  vi.fn((path: string): never => {
    throw new Error(`REDIRECT ${path}`);
  })
);

vi.mock("next/navigation", () => ({ redirect }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(state.headers),
}));

vi.mock("@/lib/auth", () => ({
  SIGN_IN_PATH: "/signin",
  auth: async () => state.session,
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  // Just enough of a handle for `getCurrentUser`'s single select.
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (state.row ? [state.row] : []) }),
      }),
    }),
  };
  return { ...actual, db };
});

const { requireAdmin, requireUser, safeReturnPath, signInHref } = await import(
  "@/lib/session-guards"
);

beforeEach(() => {
  state.headers = {};
  state.session = null;
  state.row = null;
  redirect.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

/* ------------------------------------------------------------------ */
/* The sanitiser                                                      */
/* ------------------------------------------------------------------ */

describe("safeReturnPath", () => {
  it("keeps a path on this site, query string and all", () => {
    expect(safeReturnPath("/events/summer-cup")).toBe("/events/summer-cup");
    expect(safeReturnPath("/players?sort=name")).toBe("/players?sort=name");
    expect(safeReturnPath("  /me  ")).toBe("/me");
  });

  it("keeps the path of an absolute URL and drops its origin", () => {
    expect(safeReturnPath("http://localhost:3400/me")).toBe("/me");
    expect(safeReturnPath("https://evil.test/me")).toBe("/me");
  });

  it("refuses a path that would read as an origin of its own", () => {
    expect(safeReturnPath("https://ours.test//evil.test/steal")).toBeNull();
  });

  it("refuses the sign-in page, which is a loop either way round", () => {
    expect(safeReturnPath("/signin")).toBeNull();
    expect(safeReturnPath("/signin?error=admin-only")).toBeNull();
  });

  it("refuses the sign-in page however it is spelled", () => {
    /*
     * `trailingSlash` is at its default, so `/signin/` is a 308 to `/signin`:
     * an exact-match refusal lets it through and the member who just signed in
     * is redirected back onto the sign-in page (R-01 / UC-01 6).
     */
    expect(safeReturnPath("/signin/")).toBeNull();
    expect(safeReturnPath("/signin//")).toBeNull();
    expect(safeReturnPath("/signin/?from=%2Fme")).toBeNull();
    expect(safeReturnPath("/SIGNIN")).toBeNull();
    expect(safeReturnPath("/SignIn/")).toBeNull();
    expect(safeReturnPath("/%73ignin")).toBeNull();
  });

  it("refuses an API path, which a redirect would follow as a GET", () => {
    expect(safeReturnPath("/api/auth/signout")).toBeNull();
  });

  it("refuses an API path in any case and any encoding", () => {
    /*
     * Neither of these is a live escape today — Next's router is
     * case-sensitive and does not decode before matching — but this refusal is
     * defence in depth, and a defence that a different case walks past is not
     * defending anything.
     */
    expect(safeReturnPath("/API/auth/signout")).toBeNull();
    expect(safeReturnPath("/Api/auth/signout")).toBeNull();
    expect(safeReturnPath("/%61pi/auth/signout")).toBeNull();
    expect(safeReturnPath("/api/")).toBeNull();
    expect(safeReturnPath("/api")).toBeNull();
  });

  it("survives a path that cannot be percent-decoded", () => {
    // `decodeURIComponent("%zz")` throws. A sanitiser every sign-in runs
    // through must answer, not throw — and the raw spelling is still judged.
    expect(safeReturnPath("/events/100%zz")).toBe("/events/100%zz");
    expect(safeReturnPath("/%api/auth/signout")).toBe("/%api/auth/signout");
  });

  it("keeps a page whose name merely starts the same way", () => {
    // The refusals are about `/signin` and `/api/…`, not about any path with
    // those letters at the front.
    expect(safeReturnPath("/signings")).toBe("/signings");
    expect(safeReturnPath("/apiary")).toBe("/apiary");
  });

  it("refuses nothing at all", () => {
    expect(safeReturnPath("")).toBeNull();
    expect(safeReturnPath("   ")).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
  });
});

describe("signInHref", () => {
  it("is the bare page when there is nothing to say", () => {
    expect(signInHref()).toBe("/signin");
    expect(signInHref({ from: null, error: null })).toBe("/signin");
  });

  it("carries the way back, encoded so its own query survives", () => {
    expect(signInHref({ from: "/events/summer-cup?tab=applicants" })).toBe(
      "/signin?from=%2Fevents%2Fsummer-cup%3Ftab%3Dapplicants"
    );
  });

  it("drops a `from` it would not have returned to anyway", () => {
    expect(signInHref({ from: "https://evil.test/steal" })).toBe("/signin?from=%2Fsteal");
    expect(signInHref({ from: "/signin" })).toBe("/signin");
  });

  it("carries an error code on its own", () => {
    expect(signInHref({ error: "admin-only" })).toBe("/signin?error=admin-only");
  });
});

/* ------------------------------------------------------------------ */
/* What the guards send                                               */
/* ------------------------------------------------------------------ */

async function expectRedirect(run: () => Promise<unknown>): Promise<string> {
  await expect(run()).rejects.toThrow(/^REDIRECT /);
  expect(redirect).toHaveBeenCalledOnce();
  return redirect.mock.calls[0][0];
}

describe("requireUser", () => {
  it("names the page being navigated to, so signing in lands back on it", async () => {
    state.headers = { "next-url": "/events/summer-cup" };
    expect(await expectRedirect(requireUser)).toBe("/signin?from=%2Fevents%2Fsummer-cup");
  });

  it("falls back to the page behind a full load", async () => {
    state.headers = { referer: "http://localhost:3400/suggestions" };
    expect(await expectRedirect(requireUser)).toBe("/signin?from=%2Fsuggestions");
  });

  it("sends them to the bare page when nothing says where they were", async () => {
    expect(await expectRedirect(requireUser)).toBe("/signin");
  });

  it("returns the row and redirects nowhere when somebody is signed in", async () => {
    state.session = { user: { id: "u1" } };
    state.row = { id: "u1", isAdmin: false };

    await expect(requireUser()).resolves.toMatchObject({ id: "u1" });
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("requireAdmin", () => {
  it("asks a signed-out visitor to sign in, remembering the page", async () => {
    state.headers = { "next-url": "/admin/audit" };
    expect(await expectRedirect(requireAdmin)).toBe("/signin?from=%2Fadmin%2Faudit");
  });

  it("tells a signed-in non-admin the page is not theirs, with no way back", async () => {
    // Signing in again lands them on the same refusal, so there is nothing to
    // return to — the explanation is the destination.
    state.session = { user: { id: "u1" } };
    state.row = { id: "u1", isAdmin: false };
    state.headers = { "next-url": "/admin/audit" };

    const to = await expectRedirect(requireAdmin);
    expect(to).toBe("/signin?error=admin-only");
    expect(to).not.toContain("from=");
  });

  it("lets an admin through", async () => {
    state.session = { user: { id: "u1" } };
    state.row = { id: "u1", isAdmin: true };

    await expect(requireAdmin()).resolves.toMatchObject({ id: "u1", isAdmin: true });
    expect(redirect).not.toHaveBeenCalled();
  });
});
