import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSession, serializeSession } from "@/lib/session";
import type { Session } from "@/lib/types";
import { makeSession } from "./helpers";

// The module reaches for next/headers for its cookie helpers, which need a request
// context this suite does not have. Only the pure token functions are under test.
vi.mock("next/headers", () => ({
  cookies: () => {
    throw new Error("not available in tests");
  },
}));

const SECRET = "test-secret";

/** Rebuilds a token the same way session.ts does, so payloads can be forged on purpose. */
function tokenFor(payloadObject: unknown, secret = SECRET): string {
  const payload = Buffer.from(JSON.stringify(payloadObject)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("serializeSession / parseSession", () => {
  const sessions: Session[] = [
    { role: "admin", username: "boss", captainId: null },
    { role: "captain", username: "nova", captainId: "c3" },
    { role: "observer", username: "guest", captainId: null },
  ];

  it.each(sessions)("round-trips a $role session", (session) => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    expect(parseSession(serializeSession(session))).toEqual(session);
  });

  it("produces a payload.signature pair", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const token = serializeSession(makeSession());
    const parts = token.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0].length).toBeGreaterThan(0);
    expect(parts[1].length).toBeGreaterThan(0);
  });

  it("survives unicode and punctuation in the username", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const session = makeSession({ role: "captain", username: "Zoltán O'Neil", captainId: "c2" });
    expect(parseSession(serializeSession(session))).toEqual(session);
  });

  it("works on the built-in development secret too", () => {
    vi.stubEnv("SESSION_SECRET", undefined as unknown as string);
    const session = makeSession();
    expect(parseSession(serializeSession(session))).toEqual(session);
  });
});

describe("parseSession rejects", () => {
  it("a missing or empty token", () => {
    expect(parseSession(undefined)).toBeNull();
    expect(parseSession("")).toBeNull();
  });

  it("a token with no signature", () => {
    expect(parseSession("justapayload")).toBeNull();
    expect(parseSession("payload.")).toBeNull();
    expect(parseSession(".signature")).toBeNull();
  });

  it("a tampered payload", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const token = serializeSession(makeSession({ role: "observer", username: "guest" }));
    const [, sig] = token.split(".");
    // Same signature, a payload that claims the admin role.
    const forged = Buffer.from(
      JSON.stringify({ role: "admin", username: "guest", captainId: null })
    ).toString("base64url");
    expect(parseSession(`${forged}.${sig}`)).toBeNull();
  });

  it("a payload edited in place, keeping its length", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const token = serializeSession(makeSession({ role: "captain", captainId: "c1" }));
    const [payload, sig] = token.split(".");
    const swapped = (payload[0] === "A" ? "B" : "A") + payload.slice(1);
    expect(parseSession(`${swapped}.${sig}`)).toBeNull();
  });

  it("a tampered signature", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const [payload, sig] = serializeSession(makeSession()).split(".");
    const swapped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(parseSession(`${payload}.${swapped}`)).toBeNull();
  });

  it("a signature of the wrong length", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const [payload, sig] = serializeSession(makeSession()).split(".");
    expect(parseSession(`${payload}.${sig.slice(0, -1)}`)).toBeNull();
    expect(parseSession(`${payload}.${sig}extra`)).toBeNull();
  });

  it("a token signed with a different secret", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const token = serializeSession(makeSession());
    vi.stubEnv("SESSION_SECRET", "rotated-secret");
    expect(parseSession(token)).toBeNull();
  });

  it("a validly signed but unknown role", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const token = tokenFor({ role: "superadmin", username: "boss", captainId: null });
    expect(parseSession(token)).toBeNull();
  });

  it("a validly signed session with no role at all", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    expect(parseSession(tokenFor({ username: "boss", captainId: null }))).toBeNull();
  });

  it("a validly signed payload that is not an object", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    expect(parseSession(tokenFor(null))).toBeNull();
    expect(parseSession(tokenFor("admin"))).toBeNull();
  });

  it("a validly signed payload that is not JSON", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const payload = Buffer.from("not json at all").toString("base64url");
    const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
    expect(parseSession(`${payload}.${sig}`)).toBeNull();
  });

  it("without throwing on any of the above", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const junk = ["a.b", "....", "%%%.%%%", "a".repeat(500) + ".b"];
    for (const token of junk) expect(() => parseSession(token)).not.toThrow();
  });
});

describe("parseSession keeps the fields it is given", () => {
  it("preserves the captain id", () => {
    vi.stubEnv("SESSION_SECRET", SECRET);
    const token = tokenFor({ role: "captain", username: "nova", captainId: "c4" });
    expect(parseSession(token)).toEqual({
      role: "captain",
      username: "nova",
      captainId: "c4",
    });
  });
});
