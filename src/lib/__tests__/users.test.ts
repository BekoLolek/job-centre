import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPTAIN_IDS,
  adminAccount,
  authenticate,
  captainAccounts,
  observerAccount,
  teamName,
} from "@/lib/users";

const CREDENTIAL_VARS = [
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD",
  "OBSERVER_USERNAME",
  "OBSERVER_PASSWORD",
  ...[1, 2, 3, 4].flatMap((n) => [`CAPTAIN${n}_USERNAME`, `CAPTAIN${n}_PASSWORD`]),
];

/** Start every test from a known environment rather than whatever the shell holds. */
function clearCredentials() {
  for (const name of CREDENTIAL_VARS) vi.stubEnv(name, undefined as unknown as string);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("teamName", () => {
  it("is always 'Team <username>'", () => {
    expect(teamName("captain1")).toBe("Team captain1");
    expect(teamName("Nova")).toBe("Team Nova");
  });

  it("does not normalise the username it is handed", () => {
    expect(teamName("  spaced  ")).toBe("Team   spaced  ");
    expect(teamName("")).toBe("Team ");
  });
});

describe("account configuration", () => {
  it("falls back to the built-in accounts when nothing is configured", () => {
    clearCredentials();
    expect(adminAccount()).toEqual({ username: "admin", password: "admin" });
    expect(observerAccount()).toEqual({ username: "observer", password: "watch" });
    expect(captainAccounts().map((c) => [c.id, c.username, c.password])).toEqual([
      ["c1", "captain1", "draft1"],
      ["c2", "captain2", "draft2"],
      ["c3", "captain3", "draft3"],
      ["c4", "captain4", "draft4"],
    ]);
  });

  it("reads whatever the environment provides", () => {
    clearCredentials();
    vi.stubEnv("ADMIN_USERNAME", "boss");
    vi.stubEnv("ADMIN_PASSWORD", "s3cret");
    vi.stubEnv("OBSERVER_USERNAME", "guest");
    vi.stubEnv("OBSERVER_PASSWORD", "peek");
    vi.stubEnv("CAPTAIN2_USERNAME", "nova");
    vi.stubEnv("CAPTAIN2_PASSWORD", "pw2");
    expect(adminAccount()).toEqual({ username: "boss", password: "s3cret" });
    expect(observerAccount()).toEqual({ username: "guest", password: "peek" });
    expect(captainAccounts()[1]).toEqual({
      id: "c2",
      username: "nova",
      password: "pw2",
      name: "Team nova",
    });
  });

  it("treats an empty environment value as unset", () => {
    clearCredentials();
    vi.stubEnv("ADMIN_USERNAME", "");
    expect(adminAccount().username).toBe("admin");
  });

  it("derives every captain's team name from their login name", () => {
    clearCredentials();
    vi.stubEnv("CAPTAIN1_USERNAME", "nova");
    const accounts = captainAccounts();
    expect(accounts.map((c) => c.id)).toEqual([...CAPTAIN_IDS]);
    expect(accounts.every((c) => c.name === teamName(c.username))).toBe(true);
    expect(accounts[0].name).toBe("Team nova");
  });
});

describe("authenticate", () => {
  function configure() {
    clearCredentials();
    vi.stubEnv("ADMIN_USERNAME", "boss");
    vi.stubEnv("ADMIN_PASSWORD", "s3cret");
    vi.stubEnv("OBSERVER_USERNAME", "guest");
    vi.stubEnv("OBSERVER_PASSWORD", "peek");
    vi.stubEnv("CAPTAIN1_USERNAME", "nova");
    vi.stubEnv("CAPTAIN1_PASSWORD", "pw1");
  }

  it("signs the admin in", () => {
    configure();
    expect(authenticate("boss", "s3cret")).toEqual({
      role: "admin",
      username: "boss",
      captainId: null,
    });
  });

  it("signs the observer in without a captain id", () => {
    configure();
    expect(authenticate("guest", "peek")).toEqual({
      role: "observer",
      username: "guest",
      captainId: null,
    });
  });

  it("signs a captain in and hands back their id", () => {
    configure();
    expect(authenticate("nova", "pw1")).toEqual({
      role: "captain",
      username: "nova",
      captainId: "c1",
    });
  });

  it("finds captains further down the list", () => {
    clearCredentials();
    expect(authenticate("captain4", "draft4")).toMatchObject({ captainId: "c4" });
  });

  it("ignores the case of the username", () => {
    configure();
    expect(authenticate("BOSS", "s3cret")).toMatchObject({ role: "admin" });
    expect(authenticate("NoVa", "pw1")).toMatchObject({ role: "captain", captainId: "c1" });
  });

  it("trims surrounding whitespace from the username", () => {
    configure();
    expect(authenticate("  boss  ", "s3cret")).toMatchObject({ role: "admin" });
  });

  it("returns the configured username, not what was typed", () => {
    configure();
    expect(authenticate(" BOSS ", "s3cret")?.username).toBe("boss");
  });

  it("rejects a wrong password", () => {
    configure();
    expect(authenticate("boss", "wrong")).toBeNull();
    expect(authenticate("nova", "pw2")).toBeNull();
  });

  it("treats the password as case sensitive", () => {
    configure();
    expect(authenticate("boss", "S3CRET")).toBeNull();
  });

  it("does not trim the password", () => {
    configure();
    expect(authenticate("boss", " s3cret ")).toBeNull();
  });

  it("rejects a password that is a prefix of the real one", () => {
    configure();
    expect(authenticate("boss", "s3cre")).toBeNull();
  });

  it("rejects an unknown user", () => {
    configure();
    expect(authenticate("nobody", "s3cret")).toBeNull();
  });

  it("rejects empty credentials", () => {
    configure();
    expect(authenticate("", "")).toBeNull();
    expect(authenticate("boss", "")).toBeNull();
  });

  it("keeps looking past the admin when only the username collides", () => {
    clearCredentials();
    vi.stubEnv("ADMIN_USERNAME", "shared");
    vi.stubEnv("ADMIN_PASSWORD", "adminpw");
    vi.stubEnv("CAPTAIN3_USERNAME", "shared");
    vi.stubEnv("CAPTAIN3_PASSWORD", "capnpw");
    expect(authenticate("shared", "adminpw")).toMatchObject({ role: "admin" });
    expect(authenticate("shared", "capnpw")).toMatchObject({
      role: "captain",
      captainId: "c3",
    });
  });

  it("matches the first captain when two share a login", () => {
    clearCredentials();
    vi.stubEnv("CAPTAIN1_USERNAME", "twin");
    vi.stubEnv("CAPTAIN1_PASSWORD", "pw");
    vi.stubEnv("CAPTAIN2_USERNAME", "twin");
    vi.stubEnv("CAPTAIN2_PASSWORD", "pw");
    expect(authenticate("twin", "pw")).toMatchObject({ captainId: "c1" });
  });
});
