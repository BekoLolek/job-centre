import { eq } from "drizzle-orm";
import { type ReactElement, type ReactNode, isValidElement } from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, users } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { Alert, Button } from "@/components/ui";

/*
 * `/signin` — the two messages and the way back (Task 15, UC-01).
 *
 * Rendered rather than clicked: the page is a server component, so calling it
 * returns the element tree, and the server actions it closes over are ordinary
 * async functions in this environment. That is enough to prove the things the
 * use case actually asks for — which sentence a member is shown, and where
 * `signIn` and `signOut` are told to send them back to — without a browser.
 *
 * The `from` cases are half of this file because that value is browser-supplied
 * twice over: a `?from=` anybody can put in a link, and a `Referer` any site
 * can set by linking here. An open redirect on a sign-in page is the classic
 * phishing primitive, so each shape gets its own line.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
  headers: {} as Record<string, string>,
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  const db = new Proxy({} as Database, {
    get(_target, property) {
      const real = state.db as unknown as Record<string | symbol, unknown>;
      const value = Reflect.get(real, property, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
  return { ...actual, db };
});

type RedirectOptions = { redirectTo?: string };
const signIn = vi.hoisted(() =>
  vi.fn(async (_provider: string, _options: { redirectTo?: string }) => {})
);
const signOut = vi.hoisted(() => vi.fn(async (_options: { redirectTo?: string }) => {}));

vi.mock("@/lib/auth", () => ({
  SIGN_IN_PATH: "/signin",
  auth: async () => (state.userId ? { user: { id: state.userId } } : null),
  signIn,
  signOut,
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(state.headers),
}));

const { default: SignInPage } = await import("../page");

let handle: TestDatabase;

beforeAll(async () => {
  handle = await freshDatabase();
  state.db = handle.db;
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  state.userId = null;
  state.headers = {};
  signIn.mockClear();
  signOut.mockClear();
  // Otherwise the page renders the "no Discord app yet" state and offers no
  // button at all.
  vi.stubEnv("DISCORD_CLIENT_ID", "client");
  vi.stubEnv("DISCORD_CLIENT_SECRET", "secret");
  vi.stubEnv("AUTH_SECRET", "secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------ */
/* Walking the tree                                                   */
/* ------------------------------------------------------------------ */

/**
 * Every element in the tree, expanding the function components on the way.
 *
 * The page's states (`Ready`, `SignedIn`, `NotConfigured`) are components, so
 * the returned tree holds an element for each rather than its contents, and the
 * `<form>` this file needs is inside one of them. Anything that throws when
 * called outside React — `next/link` is the one that does — is skipped rather
 * than failing the walk.
 */
function* walk(node: ReactNode): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (!isValidElement(node)) return;
  const element = node as ReactElement<Record<string, unknown>>;
  yield element;

  if (typeof element.type === "function") {
    let rendered: ReactNode = null;
    try {
      rendered = (element.type as (props: unknown) => ReactNode)(element.props);
    } catch {
      return;
    }
    yield* walk(rendered);
    return;
  }
  yield* walk(element.props.children as ReactNode);
}

function find(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  for (const element of walk(node)) if (element.type === type) return element;
  return null;
}

/** Every string in a subtree, joined — what the member reads. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isValidElement(node)) return "";
  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === "function") {
    try {
      return textOf((element.type as (props: unknown) => ReactNode)(element.props));
    } catch {
      return "";
    }
  }
  return textOf(element.props.children as ReactNode);
}

type Params = Record<string, string | string[] | undefined>;

async function render(params: Params = {}): Promise<ReactNode> {
  return SignInPage({ searchParams: Promise.resolve(params) });
}

/** The sentence the page shows for a given `?error=`. */
async function messageFor(error: string): Promise<string> {
  const alert = find(await render({ error }), Alert);
  if (!alert) throw new Error(`No message rendered for ?error=${error}`);
  return textOf(alert.props.children as ReactNode);
}

/** Where the "Continue with Discord" button would send them back to. */
async function redirectToFor(params: Params): Promise<string | undefined> {
  const page = await render(params);
  const form = find(page, "form");
  if (!form) throw new Error("No sign-in form rendered.");
  await (form.props.action as () => Promise<void>)();
  expect(signIn).toHaveBeenCalledOnce();
  const [, options] = signIn.mock.calls[0] as [string, RedirectOptions];
  return options.redirectTo;
}

/* ------------------------------------------------------------------ */
/* UC-01 3a and 4c — two outcomes, two sentences                      */
/* ------------------------------------------------------------------ */

describe("what a refused sign-in says", () => {
  it("says a cancelled sign-in was cancelled, and that nothing was stored", async () => {
    // UC-01 3a. Auth.js reports Discord's `access_denied` as this.
    const message = await messageFor("OAuthCallbackError");
    expect(message).toMatch(/cancelled/i);
    expect(message).toMatch(/nothing was stored/i);
  });

  it("says Discord did not answer when the membership check could not be made", async () => {
    // UC-01 4c, our own code out of `evaluateGuildGate`.
    const message = await messageFor("guild-lookup-failed");
    expect(message).toMatch(/did not answer/i);
    expect(message).toMatch(/try again/i);
  });

  it("does not give the two the same words", async () => {
    // They used to share one: every code that was not ours fell through to
    // "Discord sent back an unexpected result (X)". Somebody who pressed
    // Cancel was told the site was broken.
    const cancelled = await messageFor("OAuthCallbackError");
    const unreachable = await messageFor("guild-lookup-failed");
    expect(cancelled).not.toBe(unreachable);
    expect(cancelled).not.toMatch(/did not answer/i);
    expect(unreachable).not.toMatch(/cancelled/i);
  });

  it("still separates not-in-the-server from both of them", async () => {
    // UC-01 4b is a correctly working gate, not an error, and reads as one.
    const message = await messageFor("not-in-guild");
    expect(message).toMatch(/Job Centre Discord server/i);
    expect(message).not.toMatch(/cancelled|did not answer/i);
  });
});

/* ------------------------------------------------------------------ */
/* UC-01 6 and 8 — back to the page they started from                 */
/* ------------------------------------------------------------------ */

describe("where signing in returns to", () => {
  it("returns to the page the guard sent them away from", async () => {
    expect(await redirectToFor({ from: "/events/summer-cup" })).toBe("/events/summer-cup");
  });

  it("falls back to the page they pressed Sign in on", async () => {
    // No `?from=`: the header's link carries no state, so the Referer is what
    // says where they were.
    state.headers = { referer: "http://localhost:3400/players/beko" };
    expect(await redirectToFor({})).toBe("/players/beko");
  });

  it("prefers a client-side navigation's own target over the page behind it", async () => {
    state.headers = {
      "next-url": "/suggestions",
      referer: "http://localhost:3400/somewhere-else",
    };
    expect(await redirectToFor({})).toBe("/suggestions");
  });

  it("goes to the hub when nothing says otherwise", async () => {
    expect(await redirectToFor({})).toBe("/");
  });

  it("keeps the path and throws the origin away", async () => {
    // The open redirect. An absolute URL is not refused outright, because a
    // legitimate `from` often arrives as one; what is refused is the origin.
    expect(await redirectToFor({ from: "https://evil.test/steal" })).toBe("/steal");
  });

  it("defuses a protocol-relative URL rather than following it", async () => {
    // `//evil.test/steal` is an absolute URL to a browser. Parsing it puts
    // `evil.test` in the origin, which is thrown away with every other origin,
    // and what is left is a path on this site. A backslash is a slash to both
    // the browser and the parser, so the usual dodge lands in the same place.
    expect(await redirectToFor({ from: "//evil.test/steal" })).toBe("/steal");
    signIn.mockClear();
    expect(await redirectToFor({ from: "/\\evil.test/steal" })).toBe("/steal");
  });

  it("refuses a path that would itself read as protocol-relative", async () => {
    // The one shape the origin rule does not cover: a double slash *inside*
    // the path survives parsing, and `//evil.test/x` in a `Location:` header
    // or an `href` is read as an origin all over again.
    expect(await redirectToFor({ from: "https://ours.test//evil.test/steal" })).toBe("/");
  });

  it("refuses to come back to the sign-in page", async () => {
    expect(await redirectToFor({ from: "/signin" })).toBe("/");
    signIn.mockClear();
    expect(await redirectToFor({ from: "/signin?error=not-in-guild" })).toBe("/");
  });

  it("refuses an API path, which a redirect would follow as a GET", async () => {
    expect(await redirectToFor({ from: "/api/auth/signout" })).toBe("/");
  });

  it("ignores a Referer from another site entirely", async () => {
    // Anybody can make one by linking here. Only the path survives, and a
    // path on this site is harmless.
    state.headers = { referer: "https://evil.test/steal" };
    expect(await redirectToFor({})).toBe("/steal");
  });
});

describe("where signing out returns to", () => {
  it("offers the way on and the way out, both to the page they started from", async () => {
    // UC-01 8. Already signed in, looking at /signin with a `from` on it.
    const member = await makeUser(handle.db, { displayName: "Member" });
    await handle.db.update(users).set({ displayName: "Member" }).where(eq(users.id, member));
    state.userId = member;

    const page = await render({ from: "/events/summer-cup" });

    expect(find(page, Button)?.props.href).toBe("/events/summer-cup");

    const form = find(page, "form");
    await (form?.props.action as () => Promise<void>)();
    expect(signOut).toHaveBeenCalledWith({ redirectTo: "/events/summer-cup" });
  });
});
