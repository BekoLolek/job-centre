import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  ANNOUNCEMENTS,
  type AnnouncementKind,
  type AnnouncementSettings as Settings,
  defaultAnnouncementSettings,
} from "@/lib/announce";
import type { StoredAnnouncementTemplate } from "@/lib/discord";
import type { DiscordRole, RoleListing, RoleListingProblem } from "@/lib/discord-roles";

/*
 * Picking a role instead of pasting an id, on the screen (R-203 / UC-37 4a, 4b).
 *
 * ## The two criteria this file exists for, and how each is kept honest
 *
 * **"With neither, the screen says what is missing and takes a pasted id
 * instead."** The vacuous version of that test asserts no `<select>` appears —
 * which passes just as well when the component is broken, when the editor fails
 * to render at all, or when somebody deletes the mention picker. So every test
 * below about a missing token asserts three things together: the *explanatory
 * sentence*, naming what is absent; that the paste field, its button and its
 * `Copy Role ID` instructions are all still on screen; and only then that there
 * is no dropdown. The first two cannot pass against a screen that is not there.
 *
 * **"A deleted role is flagged on the screen and still posts as plain text."**
 * Flagged, not repaired: the tests assert the id is *still in the mention* and
 * still rendered as `<@&id>` while being flagged, because a component that
 * dropped a dead role would satisfy any assertion about a warning appearing
 * while quietly editing an admin's announcement.
 *
 * ## No real token
 *
 * {@link TOKEN} is not a credential. It is put in the *environment* of the
 * render — not in a prop, because the point of the assertion is that no prop
 * could carry it — and the markup is then searched for it.
 */

vi.mock("@/app/admin/settings/actions", () => ({
  saveAnnouncementSettingsAction: vi.fn(async () => ({
    ok: true as const,
    data: { settings: defaultAnnouncementSettings() },
  })),
  saveAnnouncementTemplateAction: vi.fn(async () => ({
    ok: false as const,
    error: "not used in a static render",
  })),
}));

const {
  default: AnnouncementSettings,
  NO_ROLE_LIST,
  NOT_POSTED_YET,
  RoleMention,
  noListReason,
  withRole,
} = await import("../AnnouncementSettings");

const ROOT = path.resolve(__dirname, "../../../..");
const COMPONENT = path.join(ROOT, "src/components/admin/AnnouncementSettings.tsx");
const PAGE = path.join(ROOT, "src/app/admin/settings/page.tsx");

const ORIGIN = "https://jobcentre.example.test";
const KIND: AnnouncementKind = "event_published";

/** Not a credential. Shaped like one so a leak into markup would be obvious. */
const TOKEN = "NOT-A-REAL-TOKEN.aaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const DRIVERS: DiscordRole = { id: "222222222222222222", name: "Drivers", position: 5 };
const STEWARDS: DiscordRole = { id: "333333333333333333", name: "Stewards", position: 3 };
const GONE = "444444444444444444";

const LIST: RoleListing = { roles: [DRIVERS, STEWARDS], problem: null };

function unedited(): StoredAnnouncementTemplate {
  return {
    body: null,
    mention: { everyone: false, roleIds: [] },
    version: 0,
    updatedAt: null,
    updatedBy: null,
  };
}

function storedFor(
  over: Partial<Record<AnnouncementKind, Partial<StoredAnnouncementTemplate>>> = {}
) {
  const out = {} as Record<AnnouncementKind, StoredAnnouncementTemplate>;
  for (const spec of ANNOUNCEMENTS) out[spec.kind] = { ...unedited(), ...over[spec.kind] };
  return out;
}

/** The whole screen, with one row open. */
function render(
  options: {
    openKind?: AnnouncementKind | null;
    templates?: Record<AnnouncementKind, StoredAnnouncementTemplate>;
    saved?: Settings;
    roles?: RoleListing;
  } = {}
): string {
  return renderToStaticMarkup(
    createElement(AnnouncementSettings, {
      specs: ANNOUNCEMENTS,
      saved: options.saved ?? defaultAnnouncementSettings(),
      configured: true,
      templates: options.templates ?? storedFor(),
      origin: ORIGIN,
      openKind: options.openKind ?? KIND,
      notPosted: NOT_POSTED_YET,
      ...(options.roles === undefined ? {} : { roles: options.roles }),
    })
  );
}

/** Just the mention picker, for the cases the whole screen does not vary. */
function picker(roles: RoleListing, roleIds: readonly string[] = []): string {
  return renderToStaticMarkup(
    createElement(RoleMention, {
      kind: KIND,
      mention: { everyone: false, roleIds: [...roleIds] },
      onChange: () => {},
      roles,
    })
  );
}

function decode(markup: string): string {
  return markup
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * A source file with its comments taken out.
 *
 * Every "this file does not mention X" assertion below runs against this rather
 * than the raw text, for the reason Task 63's workflow assertions do: these
 * modules *explain themselves*, so their own prose names `fetchGuildRoles` and
 * `DISCORD_GUILD_ID` while saying why neither is reached for. A `not.toContain`
 * over the raw source is satisfied — or in this case defeated — by a comment,
 * which is the near-miss that has already cost this project once.
 *
 * Block comments go first so `/** … *\/` and `{/* … *\/}` are both covered;
 * then whole lines that are nothing but a `//` comment, which is narrow on
 * purpose — a trailing `//` rule would eat the `https://` in a URL.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

it("has a comment stripper that takes out exactly what it claims to", () => {
  // Tested against a fixture rather than assumed. A stripper that returned its
  // input would make every source assertion below fail for the wrong reason; one
  // that stripped too much would make them pass against nothing at all.
  const sample = [
    "const a = 1; /* fetchGuildRoles in a block */",
    "// fetchGuildRoles on a line of its own",
    "/**",
    " * fetchGuildRoles in a docblock",
    " */",
    'const url = "https://example.test/x";',
    "const keep = fetchGuildRoles;",
  ].join("\n");

  const stripped = stripComments(sample);

  expect(stripped.match(/fetchGuildRoles/g)).toHaveLength(1);
  expect(stripped).toContain("const keep = fetchGuildRoles;");
  // The thing a greedier rule would have eaten.
  expect(stripped).toContain('"https://example.test/x"');
  expect(stripped).toContain("const a = 1;");
});

/** The `<li>` rows of the mentioned-roles list, and nothing above them. */
function mentionRows(markup: string): string[] {
  const list = /<ul class="divide-y divide-hair\/60">([\s\S]*?)<\/ul>/.exec(markup);
  expect(list, "no list of mentioned roles on this screen").not.toBeNull();
  return list![1].split("<li").filter((row) => row.trim() !== "");
}

/**
 * The paste field and its button, which must survive every case below.
 *
 * The label is asserted as a complete text node — `>Add a role by id<` — not as
 * a substring. A bare `toContain("Add a role by id")` is satisfied by any label
 * that merely *starts* with those words, which is how a mutation that renamed
 * the field survived the first run of the harness. Matching the closing angle
 * bracket pins the whole node without pinning the tag or its classes, which
 * another session is currently sweeping.
 */
function expectPasteFieldWorks(markup: string): void {
  expect(markup, "the paste field's label is gone or renamed").toContain(
    ">Add a role by id<"
  );
  expect(markup, "the Add button is gone").toContain(">Add role</button>");
  expect(markup, "the placeholder an id is typed over is gone").toContain(
    '"000000000000000000"'
  );
}

/* ------------------------------------------------------------------ */
/* With a token and a guild id (R-203, the first criterion)           */
/* ------------------------------------------------------------------ */

describe("with the server's roles read", () => {
  it("offers each role by name, valued by the id Discord pings", () => {
    const markup = decode(render({ roles: LIST }));

    expect(markup).toContain("Pick a role");
    expect(markup).toContain(`<option value="${DRIVERS.id}">Drivers</option>`);
    expect(markup).toContain(`<option value="${STEWARDS.id}">Stewards</option>`);
    // The id is the value, because `@RoleName` is inert on Discord and the
    // stored mention is a snowflake. A dropdown whose option values were names
    // would store a mention that silently pings nobody.
    expect(markup).not.toContain('<option value="Drivers"');
  });

  it("keeps the paste field, because the token buys a dropdown not a capability", () => {
    const markup = decode(render({ roles: LIST }));

    // R-203 is a "Could" precisely because this field is the capability. A
    // dropdown that replaced it would make a role created a minute ago
    // unmentionable until the cache expired.
    expectPasteFieldWorks(markup);
    expect(markup).toContain("a role made in Discord a moment ago may not be in the list");
  });

  it("hands a picked role to the field the Add button reads", () => {
    /*
     * A **source** check, and said so rather than dressed up as a behaviour
     * one — the same shape as `announcement-wording.test.ts`'s assertion about
     * `const add`, and for the same reason: there is no pointer in this
     * environment, so choosing from a `<select>` cannot be performed here.
     *
     * What it demands is that `pick` wires the dropdown to the *one* place the
     * mention is actually built from. A handler that set only its own dropdown
     * state would leave every assertion about the options above green while a
     * picked role could not be added at all — which is exactly the mutation
     * that escaped the first run of this task's harness.
     */
    const source = fs.readFileSync(COMPONENT, "utf8");
    const handler = /\n {2}const pick = \(id: string\) => \{\n([\s\S]*?)\n {2}\};\n/.exec(
      source
    );

    expect(handler, "RoleMention no longer builds its handler as `const pick`").not.toBeNull();
    // The picked id reaches the paste field, which is what `add` runs `withRole`
    // on — so the dropdown and the field cannot disagree about what was chosen.
    expect(handler![1]).toContain("setPasted(id)");
    expect(handler![1]).toContain("setPicked(id)");
    // And no rules of its own: the refusal and the snowflake check are
    // `withRole`'s, reached through the single Add button.
    expect(handler![1]).not.toMatch(
      /ROLE_ID|\[0-9\]\{17|announcementTemplateProblem|roleIds|onChange/
    );
    // The `<select>` calls it rather than carrying a second body inline.
    expect(source).toContain("onChange={(event) => pick(event.target.value)}");
  });

  it("does not claim there is no list when there is one", () => {
    const markup = decode(render({ roles: LIST }));

    expect(markup).not.toContain("There is no list of your server’s roles to pick from");
  });

  it("names a mentioned role, so an admin can read what an id is", () => {
    const markup = decode(
      render({
        roles: LIST,
        templates: storedFor({
          [KIND]: { mention: { everyone: false, roleIds: [DRIVERS.id] }, version: 1 },
        }),
      })
    );

    expect(markup).toContain(`<@&${DRIVERS.id}>`);
    expect(markup).toContain("Drivers");
  });

  it("says so, rather than showing an empty dropdown, when there are no roles", () => {
    const markup = decode(picker({ roles: [], problem: null }));

    // The distinction `RoleListing` exists for: read-and-empty is not the same
    // answer as could-not-read, and this is the sentence that proves the screen
    // keeps them apart.
    expect(markup).toContain("role list was read and it has no roles in it beyond");
    expect(markup).not.toContain("<select");
    expect(markup).not.toContain("There is no list of your server’s roles to pick from");
    expectPasteFieldWorks(markup);
  });
});

/* ------------------------------------------------------------------ */
/* Inert without a token (UC-37 4a, the second criterion)             */
/* ------------------------------------------------------------------ */

describe("with no role list", () => {
  it("says what is missing and still takes a pasted id", () => {
    const markup = decode(render({ roles: NO_ROLE_LIST }));

    /*
     * The explanatory sentence first. "No dropdown appears" is satisfied by a
     * component that is broken, by one whose editor never opened, and by one
     * somebody deleted the picker from — so what is asserted is the words an
     * admin reads, and then that the control they are told to use is there.
     */
    expect(markup).toContain("There is no list of your server’s roles to pick from");
    expect(markup).toContain(
      "reading the list needs a bot token and a server id, which this install does not have"
    );
    expect(markup).toContain("Copy Role ID");
    expect(markup).toContain("A role <em>name</em> does nothing on Discord");
    expectPasteFieldWorks(markup);
    expect(markup).not.toContain("<select");
  });

  it("is the screen's default, so an unconfigured install is the ordinary case", () => {
    // Rendered with no `roles` prop at all.
    const markup = decode(render({}));

    expect(markup).toContain("There is no list of your server’s roles to pick from");
    expectPasteFieldWorks(markup);
    expect(markup).not.toContain("<select");
  });

  it("names the token when that is the only thing absent", () => {
    const markup = decode(picker({ roles: null, problem: "no_token" }));

    expect(markup).toContain(
      "reading the list needs a bot token, and DISCORD_BOT_TOKEN is not set on this deployment"
    );
    expectPasteFieldWorks(markup);
  });

  it("sends an admin to the right screen when the server id is the gap", () => {
    const markup = decode(picker({ roles: null, problem: "no_guild" }));

    // A different job from setting a token, and the sentence says which: the
    // guild id is an admin setting on this very page, not a deploy variable.
    expect(markup).toContain(
      "a bot token is set, but nothing says which server to read — set the server id under Who may sign in below"
    );
    expect(markup).not.toContain("DISCORD_BOT_TOKEN is not set");
    expectPasteFieldWorks(markup);
  });

  it("explains a refusal from Discord rather than calling it a missing setting", () => {
    const markup = decode(picker({ roles: null, problem: "unreachable" }));

    expect(markup).toContain(
      "Discord would not answer when the list was last asked for, which usually means the token has been revoked or the bot is not in the server"
    );
    expectPasteFieldWorks(markup);
  });

  it("has a different sentence for every reason there is", () => {
    const problems: RoleListingProblem[] = [
      "no_token",
      "no_guild",
      "neither",
      "unreachable",
    ];
    const said = problems.map((problem) => noListReason(problem));

    // Without this, three of the four cases could return the same string and
    // every test above would still pass — each only asserts its own sentence is
    // present, and a single generic sentence is present in all four.
    expect(new Set(said).size).toBe(problems.length);
    for (const sentence of said) expect(sentence.length).toBeGreaterThan(20);
  });

  it("still lets a pasted id through, which is the capability itself", () => {
    // The field's decision, not its pixels. `withRole` is what the Add button
    // runs, and it knows nothing about whether a list was readable — so a role
    // id works identically on an install with no token, which is what makes
    // R-203 a convenience rather than a requirement.
    expect(withRole(KIND, { everyone: false, roleIds: [] }, DRIVERS.id)).toEqual({
      mention: { everyone: false, roleIds: [DRIVERS.id] },
      refused: null,
    });
  });
});

/* ------------------------------------------------------------------ */
/* A role that is no longer in the server (UC-37 4b)                  */
/* ------------------------------------------------------------------ */

describe("a deleted role", () => {
  const withDead = () =>
    decode(
      render({
        roles: LIST,
        templates: storedFor({
          [KIND]: {
            mention: { everyone: false, roleIds: [DRIVERS.id, GONE] },
            version: 1,
          },
        }),
      })
    );

  it("is flagged on the row and explained once below it", () => {
    const markup = withDead();

    expect(markup).toContain("No longer in the server");
    expect(markup).toContain(
      "This announcement mentions a role your server no longer has"
    );
    expect(markup).toContain(
      "Discord renders a mention of a deleted role as plain text rather than pinging anybody"
    );
  });

  it("is flagged, not repaired — the mention still carries it", () => {
    const markup = withDead();

    /*
     * The half that matters. "The announcement still posts and the dead
     * mention renders as plain text, which is Discord's own behaviour and
     * better than the site rewriting an admin's words." A component that
     * dropped the id would show no warning to contradict, so this asserts the
     * id is *still there*, still as the `<@&…>` the payload will carry, and
     * still removable by the admin rather than by the site.
     */
    expect(markup).toContain(`<@&${GONE}>`);
    expect(markup).toContain("Nothing has been changed for you.");
    expect(markup).toContain(">Remove</button>");
    // And the mention line below still begins with both, because that is what
    // will actually be posted.
    expect(markup).toContain(`The message will begin with <@&${DRIVERS.id}> <@&${GONE}>`);
  });

  it("does not flag the roles that are still there", () => {
    const markup = withDead();

    // The flag has to discriminate. A screen that badged every row would pass
    // the first test in this block and be useless.
    const rows = mentionRows(markup);
    const live = rows.find((row) => row.includes(DRIVERS.id));
    const dead = rows.find((row) => row.includes(GONE));

    expect(rows).toHaveLength(2);
    expect(live, "no row for the live role").toBeDefined();
    expect(dead, "no row for the dead role").toBeDefined();
    expect(live).not.toContain("No longer in the server");
    expect(dead).toContain("No longer in the server");
  });

  it("counts them when there is more than one", () => {
    const markup = decode(
      picker(LIST, [GONE, "555555555555555555", DRIVERS.id])
    );

    expect(markup).toContain("This announcement mentions 2 roles your server no longer has");
  });

  it("flags nothing when the list could not be read", () => {
    /*
     * **The mutation this test exists for**, and the commonest install in the
     * world: no bot token. With no list there is no way to know whether a role
     * still exists, so a screen that flagged on "not in the list" would tell
     * every admin without a token that all their mentions were dead.
     */
    for (const problem of ["no_token", "no_guild", "neither", "unreachable"] as const) {
      const markup = decode(picker({ roles: null, problem }, [DRIVERS.id, GONE]));

      expect(markup).not.toContain("No longer in the server");
      expect(markup).not.toContain("your server no longer has");
      // Both mentions are still shown, and still as pings.
      expect(markup).toContain(`<@&${DRIVERS.id}>`);
      expect(markup).toContain(`<@&${GONE}>`);
    }
  });

  it("flags nothing when every mentioned role is alive", () => {
    const markup = decode(picker(LIST, [DRIVERS.id, STEWARDS.id]));

    expect(markup).not.toContain("No longer in the server");
    expect(markup).not.toContain("your server no longer has");
  });
});

/* ------------------------------------------------------------------ */
/* The token (Constraints)                                            */
/* ------------------------------------------------------------------ */

describe("the bot token", () => {
  it("is in no part of the rendered screen, even with one in the environment", () => {
    const before = process.env.DISCORD_BOT_TOKEN;
    process.env.DISCORD_BOT_TOKEN = TOKEN;
    try {
      const markup = render({ roles: LIST });

      // The whole screen, including the printed payload and every prop React
      // serialises into it.
      expect(markup).not.toContain(TOKEN);
      expect(markup).not.toContain("NOT-A-REAL-TOKEN");
      expect(markup).not.toContain("DISCORD_BOT_TOKEN=");
    } finally {
      if (before === undefined) delete process.env.DISCORD_BOT_TOKEN;
      else process.env.DISCORD_BOT_TOKEN = before;
    }
  });

  it("is unreachable from this screen, which never imports the fetcher", () => {
    /*
     * A source check, said so. The screen is a `"use client"` component, so
     * what it imports is what a browser downloads. `deadRoles` is pure and
     * reads no environment; `fetchGuildRoles` and `getGuildRoles` are where the
     * token is read, and importing either here would put the module that reads
     * a credential into a client bundle.
     */
    const source = stripComments(fs.readFileSync(COMPONENT, "utf8"));

    expect(source).toContain('"use client"');
    expect(source).not.toContain("fetchGuildRoles");
    expect(source).not.toContain("getGuildRoles");
    expect(source).not.toContain("botToken");
    // No environment read of any kind. This is the assertion that matters: a
    // client component that reached for `process.env` would either bundle a
    // value or silently read `undefined`, and both are worse than being handed
    // a listing.
    expect(source).not.toContain("process.env");

    /*
     * `DISCORD_BOT_TOKEN` *is* named here, in a sentence shown to an admin, and
     * that is right: UC-37 4a is the screen saying what is missing, and the
     * actionable version of "no bot token" is the name of the variable to set.
     * What is forbidden is reading it, which the line above covers — so this
     * asserts the name only ever appears inside a quoted string.
     */
    for (const line of source.split("\n")) {
      if (!line.includes("DISCORD_BOT_TOKEN")) continue;
      expect(line, "DISCORD_BOT_TOKEN outside a displayed sentence").toMatch(
        /^\s*return "[^"]*DISCORD_BOT_TOKEN[^"]*";$/
      );
    }

    // The only value taken from the roles module, and it is the pure one.
    const value = /^import \{([^}]*)\} from "@\/lib\/discord-roles";$/m.exec(source);
    expect(value, "the roles module is no longer imported as a value here").not.toBeNull();
    expect(value![1].trim()).toBe("deadRoles");
  });

  it("is kept on the server by the page, which passes a listing and not a secret", () => {
    const source = stripComments(fs.readFileSync(PAGE, "utf8"));

    // The guild id comes from the resolved gate config — not a new environment
    // variable, and not the settings row, either of which would be wrong for
    // one of the two kinds of deployment.
    expect(source).toContain("getGuildRoles(gate.guildId)");
    /*
     * And the answer actually reaches the screen. Without this, deleting the
     * prop leaves every test in this file green — they render the component
     * directly — while the real page falls back to the "nothing configured"
     * default and no admin ever sees a dropdown. That mutation escaped the
     * first run of this task's harness.
     */
    expect(source).toContain("roles={roles}");
    expect(source).not.toContain("DISCORD_GUILD_ID");
    expect(source).not.toContain("SETTING_KEYS.guildId");
    // The token is never read here at all, so there is nothing to pass down.
    expect(source).not.toContain("DISCORD_BOT_TOKEN");
    expect(source).not.toContain("botToken");
  });
});
