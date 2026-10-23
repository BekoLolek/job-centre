import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DiscordRole,
  ROLE_CACHE_MS,
  type RoleListing,
  clearRoleCache,
  deadRoles,
  fetchGuildRoles,
  getGuildRoles,
  pickableRoles,
  whyNoList,
} from "@/lib/discord-roles";

/*
 * Reading the server's role list (R-203 / UC-37 4a, 4b).
 *
 * ## No real token, anywhere
 *
 * {@link TOKEN} below is a string chosen to be obviously not a credential, and
 * `fetch` is stubbed in every test that gets as far as one — nothing in this
 * file can reach Discord even if somebody runs it with a populated
 * `.env.local`, because the environment is passed in as an argument rather than
 * read from the process. The Constraint in `docs/requirements.md` is that
 * secrets "never reach the browser, the settings screen or the audit log", and
 * the tests for it are in `the token` below: it must arrive in the
 * `authorization` header, which is the whole point of having it, and it must
 * not be anywhere in the value that comes back out.
 *
 * ## What is a guard here and what is arithmetic
 *
 * Three of the four "no list" answers are states this repo's test suite cannot
 * put a deployment into, so the decision is `whyNoList`, a pure function, and
 * the async wrapper is asserted to *ask* it rather than to re-derive it — the
 * assertions on `fetchGuildRoles` with a missing token demand that no request
 * was made at all, which is the difference between inert and merely quiet.
 */

/** Not a credential. Shaped like one so an accidental leak would be obvious. */
const TOKEN = "NOT-A-REAL-TOKEN.aaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const GUILD = "111111111111111111";

const WITH_TOKEN = { DISCORD_BOT_TOKEN: TOKEN };
const NO_TOKEN = {};

/** Discord's own shape, with the fields it really sends that we do not want. */
function apiRole(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "222222222222222222",
    name: "Drivers",
    position: 1,
    // Everything below is in a real response and must not survive into a prop.
    permissions: "137411140374081",
    managed: false,
    mentionable: false,
    color: 3447003,
    hoist: false,
    tags: { bot_id: "999999999999999999" },
    ...over,
  };
}

function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function notOk(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({ message: "401: Unauthorized", code: 0 }),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearRoleCache();
  fetchMock = vi.fn(async () => ok([]));
  vi.stubGlobal("fetch", fetchMock);
  // The module logs a line on every failure; the suite should not print them.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearRoleCache();
});

/* ------------------------------------------------------------------ */
/* Which half is missing                                              */
/* ------------------------------------------------------------------ */

describe("whyNoList", () => {
  it("names the one that is missing, and neither when both are", () => {
    expect(whyNoList(false, false)).toBe("neither");
    expect(whyNoList(false, true)).toBe("no_token");
    expect(whyNoList(true, false)).toBe("no_guild");
  });

  it("is null when there is nothing to report", () => {
    expect(whyNoList(true, true)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Inert without a token (UC-37 4a)                                   */
/* ------------------------------------------------------------------ */

describe("with nothing configured", () => {
  it("makes no request at all without a token", async () => {
    const listing = await fetchGuildRoles(GUILD, NO_TOKEN);

    // Both halves matter. The answer says which thing is missing, and the
    // absence of a request is what "inert" means — a module that asked Discord
    // with an undefined token and read the 401 would answer `unreachable` and
    // send a credential-shaped header on every page view.
    expect(listing).toEqual({ roles: null, problem: "no_token" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes no request without a guild id, and treats blank as missing", async () => {
    expect(await fetchGuildRoles("", WITH_TOKEN)).toEqual({
      roles: null,
      problem: "no_guild",
    });
    // A settings row holding spaces is the same as no server, not a URL of
    // `/guilds/%20%20/roles`.
    expect(await fetchGuildRoles("   ", WITH_TOKEN)).toEqual({
      roles: null,
      problem: "no_guild",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says neither when neither is set, which is most installs", async () => {
    expect(await fetchGuildRoles("", NO_TOKEN)).toEqual({
      roles: null,
      problem: "neither",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only token as no token", async () => {
    expect(await fetchGuildRoles(GUILD, { DISCORD_BOT_TOKEN: "   " })).toEqual({
      roles: null,
      problem: "no_token",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* The one request                                                    */
/* ------------------------------------------------------------------ */

describe("the request", () => {
  it("is one GET of the guild's roles", async () => {
    await fetchGuildRoles(GUILD, WITH_TOKEN);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/roles`);
    // No `method`, so it is a GET: nothing here creates, edits or deletes
    // anything on Discord, which is what keeps it inside Out of scope.
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it("asks for the guild the caller resolved, not one of its own", async () => {
    const other = "333333333333333333";
    await fetchGuildRoles(other, WITH_TOKEN);

    expect(fetchMock.mock.calls[0]?.[0]).toContain(`/guilds/${other}/roles`);
  });
});

/* ------------------------------------------------------------------ */
/* The token (Constraints)                                            */
/* ------------------------------------------------------------------ */

describe("the token", () => {
  it("reaches the authorization header as a bot credential", async () => {
    await fetchGuildRoles(GUILD, WITH_TOKEN);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual({ authorization: `Bot ${TOKEN}` });
  });

  it("is in nothing that comes back, on success or on failure", async () => {
    fetchMock.mockResolvedValueOnce(ok([apiRole({})]));
    const good = await fetchGuildRoles(GUILD, WITH_TOKEN);

    fetchMock.mockResolvedValueOnce(notOk(401));
    const bad = await fetchGuildRoles(GUILD, WITH_TOKEN);

    /*
     * Asserted over the serialised listing rather than over named fields,
     * because the failure this is guarding against is a field nobody thought
     * of: a `token`, a `headers` echo or a whole response object spread into
     * the answer. The listing is what crosses to the browser as a prop, so
     * `JSON.stringify` of it is exactly what a credential would have to travel
     * in to get there.
     */
    expect(JSON.stringify(good)).not.toContain(TOKEN);
    expect(JSON.stringify(bad)).not.toContain(TOKEN);
    // And not a piece of it either — a prefix would leak just as well.
    expect(JSON.stringify(good)).not.toContain("NOT-A-REAL-TOKEN");
    expect(JSON.stringify(good)).not.toMatch(/authorization|^Bot |[Bb]earer/);
  });

  it("is not written to the audit log, because nothing here writes one", () => {
    /*
     * A source check, said so rather than dressed up. The Constraint names the
     * audit log, and the honest way to hold "the token is not in it" for a
     * module that records nothing is to assert the module records nothing —
     * `recordAudit` takes a free-form string, so a line added here later would
     * compile and this is what would stop it going in unexamined.
     */
    const raw = fs.readFileSync(
      path.join(path.resolve(__dirname, "../../.."), "src/lib/discord-roles.ts"),
      "utf8"
    );
    /*
     * Comments stripped, for the near-miss this project has already paid for:
     * the module explains at length what it does *not* do with the audit log,
     * and a `not.toContain` over its own prose would be answered by the
     * explanation rather than by the code.
     */
    const source = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    // The stripper has to have done something, or everything below is vacuous.
    expect(raw.length).toBeGreaterThan(source.length * 1.5);
    expect(source).toContain("export async function fetchGuildRoles");

    expect(source).not.toContain("recordAudit");
    expect(source).not.toContain("@/lib/audit");
    expect(source).not.toContain("./audit");
    // The token is read in exactly one place and used in exactly one more.
    expect(source.match(/botToken\(/g)).toHaveLength(1);
    expect(source.match(/\$\{token\}/g)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* What comes back                                                    */
/* ------------------------------------------------------------------ */

describe("the list", () => {
  it("carries three fields per role and drops everything else", async () => {
    fetchMock.mockResolvedValueOnce(ok([apiRole({})]));

    const listing = await fetchGuildRoles(GUILD, WITH_TOKEN);

    expect(listing.roles).toEqual([
      { id: "222222222222222222", name: "Drivers", position: 1 },
    ]);
    // Structural rather than by eye: a spread would pass the assertion above
    // only if `toEqual` were `toMatchObject`, and this is the line that says
    // the response's permissions and bot tags are not in a prop.
    expect(Object.keys(listing.roles![0]).sort()).toEqual(["id", "name", "position"]);
  });

  it("leaves out @everyone, whose id is the server's own", async () => {
    fetchMock.mockResolvedValueOnce(
      ok([
        apiRole({ id: GUILD, name: "@everyone", position: 0 }),
        apiRole({ id: "444444444444444444", name: "Stewards", position: 2 }),
      ])
    );

    const listing = await fetchGuildRoles(GUILD, WITH_TOKEN);

    // Pinging the whole server is the checkbox, which needs no id and works on
    // an install with no token at all. Offering it twice, once as a role whose
    // mention does not even work that way, is how an admin ends up picking the
    // one that does nothing.
    expect(listing.roles?.map((role) => role.name)).toEqual(["Stewards"]);
  });

  it("is highest-first, the order the server's own role list reads in", async () => {
    fetchMock.mockResolvedValueOnce(
      ok([
        apiRole({ id: "555555555555555555", name: "Rookies", position: 1 }),
        apiRole({ id: "666666666666666666", name: "Admins", position: 9 }),
        apiRole({ id: "777777777777777777", name: "Marshals", position: 5 }),
      ])
    );

    const listing = await fetchGuildRoles(GUILD, WITH_TOKEN);

    expect(listing.roles?.map((role) => role.name)).toEqual([
      "Admins",
      "Marshals",
      "Rookies",
    ]);
  });

  it("breaks a tie on name so the order is stable between page views", () => {
    const tied: DiscordRole[] = [
      { id: "1", name: "Zebra", position: 3 },
      { id: "2", name: "Alpha", position: 3 },
    ];

    expect(pickableRoles(tied, GUILD).map((role) => role.name)).toEqual([
      "Alpha",
      "Zebra",
    ]);
  });

  it("skips a row that is not a role rather than failing the screen", async () => {
    fetchMock.mockResolvedValueOnce(
      ok([null, "nonsense", { name: "no id" }, apiRole({ id: "888888888888888888" })])
    );

    const listing = await fetchGuildRoles(GUILD, WITH_TOKEN);

    expect(listing.problem).toBeNull();
    expect(listing.roles).toEqual([
      { id: "888888888888888888", name: "Drivers", position: 1 },
    ]);
  });

  it("is an empty list, not a problem, for a server with only @everyone", async () => {
    fetchMock.mockResolvedValueOnce(ok([apiRole({ id: GUILD, name: "@everyone" })]));

    const listing = await fetchGuildRoles(GUILD, WITH_TOKEN);

    /*
     * The distinction the whole type exists for. "We read your roles and there
     * are none to pick" and "we could not read your roles" are different
     * sentences on the screen, and collapsing them would tell an admin with no
     * bot token that their server has no roles.
     */
    expect(listing).toEqual({ roles: [], problem: null });
  });
});

/* ------------------------------------------------------------------ */
/* When Discord will not answer                                       */
/* ------------------------------------------------------------------ */

describe("when Discord refuses", () => {
  it("says unreachable on a bad status and carries no list", async () => {
    fetchMock.mockResolvedValueOnce(notOk(401));

    expect(await fetchGuildRoles(GUILD, WITH_TOKEN)).toEqual({
      roles: null,
      problem: "unreachable",
    });
  });

  it("says unreachable when the body is not a list, without throwing on the way", async () => {
    fetchMock.mockResolvedValueOnce(ok({ message: "Missing Access", code: 50001 }));

    expect(await fetchGuildRoles(GUILD, WITH_TOKEN)).toEqual({
      roles: null,
      problem: "unreachable",
    });

    /*
     * The second assertion is what makes the first one about the *guard*.
     * Deleting `if (!Array.isArray(body))` still produces `unreachable`,
     * because `.map` on an object throws straight into the catch — so the
     * answer alone cannot tell the guard from the safety net. The log line can:
     * the guard returns quietly, the catch announces that Discord could not be
     * reached, which is a different and untrue thing to put in a server log
     * when Discord answered perfectly well with a 200.
     */
    expect(vi.mocked(console.error)).not.toHaveBeenCalledWith(
      "[discord-roles] could not reach Discord",
      expect.anything()
    );
  });

  it("never throws, whatever the network does", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket hang up"));

    // An admin editing some wording should not meet an error page because
    // Discord was down — `./discord-dm`'s rule, for the same reason.
    expect(await fetchGuildRoles(GUILD, WITH_TOKEN)).toEqual({
      roles: null,
      problem: "unreachable",
    });
  });

  it("logs the status without the body, which is about our credential", async () => {
    const logged = vi.mocked(console.error);
    fetchMock.mockResolvedValueOnce(notOk(403));

    await fetchGuildRoles(GUILD, WITH_TOKEN);

    expect(logged).toHaveBeenCalledWith("[discord-roles] 403 reading the role list");
    expect(JSON.stringify(logged.mock.calls)).not.toContain(TOKEN);
  });
});

/* ------------------------------------------------------------------ */
/* The cache                                                          */
/* ------------------------------------------------------------------ */

describe("the cache", () => {
  const roles = [apiRole({ id: "222222222222222222", name: "Drivers" })];

  it("is one request for many page views", async () => {
    fetchMock.mockResolvedValue(ok(roles));

    const first = await getGuildRoles(GUILD, WITH_TOKEN, 1_000);
    const second = await getGuildRoles(GUILD, WITH_TOKEN, 2_000);
    const third = await getGuildRoles(GUILD, WITH_TOKEN, 3_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(second.roles).toEqual([
      { id: "222222222222222222", name: "Drivers", position: 1 },
    ]);
  });

  it("holds for the whole window and no longer", async () => {
    fetchMock.mockResolvedValue(ok(roles));

    await getGuildRoles(GUILD, WITH_TOKEN, 0);
    // One millisecond inside the window is still the cached answer.
    await getGuildRoles(GUILD, WITH_TOKEN, ROLE_CACHE_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // At the window's end it is asked again.
    await getGuildRoles(GUILD, WITH_TOKEN, ROLE_CACHE_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is keyed on the server, so changing it does not serve the old one's roles", async () => {
    fetchMock.mockResolvedValue(ok(roles));

    await getGuildRoles(GUILD, WITH_TOKEN, 0);
    await getGuildRoles("999999999999999999", WITH_TOKEN, 1_000);

    // The guild id is an admin-editable setting. A cache that ignored it would
    // answer with the previous server's roles for five minutes after somebody
    // pointed the site at a new one.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/guilds/999999999999999999/roles");
  });

  it("does not cache a failure, so fixing the token works at once", async () => {
    fetchMock.mockResolvedValueOnce(notOk(401));
    expect((await getGuildRoles(GUILD, WITH_TOKEN, 0)).problem).toBe("unreachable");

    fetchMock.mockResolvedValueOnce(ok(roles));
    const second = await getGuildRoles(GUILD, WITH_TOKEN, 1_000);

    // An admin who has just set the token is the person most likely to be
    // reloading this page; a cached refusal would make a fixed install look
    // broken for another five minutes.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.problem).toBeNull();
    expect(second.roles).toHaveLength(1);
  });

  it("caches nothing when there is no token, and asks nothing either", async () => {
    await getGuildRoles(GUILD, NO_TOKEN, 0);
    await getGuildRoles(GUILD, NO_TOKEN, 1_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* A role that has been deleted (UC-37 4b)                            */
/* ------------------------------------------------------------------ */

describe("deadRoles", () => {
  const listing: RoleListing = {
    roles: [
      { id: "111", name: "Drivers", position: 2 },
      { id: "222", name: "Stewards", position: 1 },
    ],
    problem: null,
  };

  it("names the mentioned roles the server no longer has", () => {
    expect(deadRoles(["111", "333", "222", "444"], listing)).toEqual(["333", "444"]);
  });

  it("names none when every mention is still a role", () => {
    expect(deadRoles(["111", "222"], listing)).toEqual([]);
  });

  it("names none when there is no list, because we do not know", () => {
    /*
     * **The mutation this test exists for.** `deadRoles` reaching for
     * `listing.roles` without the null guard would flag *every* mention on
     * every install with no bot token — which is most of them — telling an
     * admin that roles pinging perfectly well had been deleted. Not knowing
     * whether a role exists is not the same as knowing it is gone, and an
     * empty answer is the only honest one here.
     */
    for (const problem of ["no_token", "no_guild", "neither", "unreachable"] as const) {
      expect(deadRoles(["111", "999"], { roles: null, problem })).toEqual([]);
    }
  });

  it("names none for an announcement that mentions nobody", () => {
    expect(deadRoles([], listing)).toEqual([]);
    expect(deadRoles([], { roles: null, problem: "neither" })).toEqual([]);
  });

  it("keeps the admin's own order rather than sorting their wording", () => {
    expect(deadRoles(["999", "111", "888"], listing)).toEqual(["999", "888"]);
  });

  it("repairs nothing — the mention it was given is untouched", () => {
    const mentioned = ["111", "999"];
    const before = [...mentioned];

    deadRoles(mentioned, listing);

    // UC-37 4b is "flagged on the screen, not repaired". A function that
    // filtered the dead one out would satisfy every assertion above about
    // *which* ids are dead while quietly editing an admin's announcement.
    expect(mentioned).toEqual(before);
  });
});
