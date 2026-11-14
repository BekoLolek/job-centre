import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  type Database,
  SETTING_KEYS,
  announcementTemplates,
  auditLog,
  eventSuggestions,
  polls,
  settings,
  users,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import type { Power } from "@/lib/permissions-policy";

/*
 * Polls, suggestions and `/admin/settings`, asked by members who hold powers
 * (Task 128, R-261 / UC-56).
 *
 * Built the way `admin/events/__tests__/powers.test.ts` is: the actions run for
 * real against an in-memory Postgres, with only the session cookie, the page
 * cache, `after()` and the sign-in gate replaced. The gate lives beside
 * NextAuth, which will not load here, so it is a two-field stand-in that
 * remembers what it was told - enough to see whether a refused call moved it.
 *
 * Three modules in one table, because the claim is about all three at once:
 * each power reaches its own actions and none of the others'. Every export of
 * every one is filed under a power or under "any member", and the first test
 * fails the day one of them exports something that is filed under neither.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
  gate: { enabled: false, guildId: "" },
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

vi.mock("@/lib/auth", () => {
  const read = () => ({ ...state.gate, source: { guildId: "settings" } });
  return {
    SIGN_IN_PATH: "/signin",
    auth: async () => (state.userId ? { user: { id: state.userId } } : null),
    getGateConfig: async () => read(),
    setGateConfig: async (next: { enabled: boolean; guildId: string | null }) => {
      state.gate = { enabled: next.enabled, guildId: next.guildId ?? "" };
      return read();
    },
  };
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: () => {} }));

const MODULES = {
  polls: await import("../polls/actions"),
  suggestions: await import("../suggestions/actions"),
  settings: await import("../admin/settings/actions"),
};
const { grantPower } = await import("@/lib/permissions");
const {
  getAnnouncementSettings,
  getAnnouncementTemplate,
  getIntegrationConfig,
  setIntegrationSetting,
} = await import("@/lib/discord");
const { defaultAnnouncementSettings } = await import("@/lib/announce");
const { addSuggestion } = await import("@/lib/suggestions");
const { createPoll } = await import("@/lib/polls");

let handle: TestDatabase;
let db: Database;

/** Who is asking. Each holds exactly the power the name says. */
const HOLDERS = [
  "polls.manage",
  "suggestions.moderate",
  "settings.announcements",
  "settings.integrations",
] as const satisfies readonly Power[];
type HolderName = (typeof HOLDERS)[number];

const ids = {} as Record<HolderName, string>;
/** Somebody with no power, whose suggestion and poll the calls below aim at. */
let member: string;
/** The flag and not one row in `user_permissions`. */
let admin: string;
let target: { suggestionId: string; pollId: string };

const WEBHOOK = "https://discord.test/api/webhooks/1399/AbCdEfGhIjKlMnOpQrStUvWxYz";
const SECOND_WEBHOOK = "https://discord.test/api/webhooks/2500/ZyXwVuTsRqPoNmLkJiHgFeDcBa";
const ORIGIN = "https://jobcentre.example.test";
const SECOND_ORIGIN = "https://elsewhere.example.test";
const GUILD = "123456789012345678";
const CLOSES = "2100-01-01T00:00:00.000Z";

function draft(question: string) {
  return {
    question,
    multiple: false,
    closesAt: CLOSES,
    options: [{ label: "Friday" }, { label: "Saturday" }],
  };
}

async function aSuggestion(by: string, title: string): Promise<string> {
  const result = await addSuggestion(by, { title, detail: "Somebody ought to run this." }, db);
  if (!result.ok) throw new Error(result.error);
  return result.data.id;
}

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;

  const granter = await makeUser(db, { displayName: "The admin who granted" });
  for (const power of HOLDERS) {
    ids[power] = await makeUser(db, { displayName: `Holder of ${power}` });
    await grantPower({ userId: ids[power], power, grantedByUserId: granter }, db);
  }

  member = await makeUser(db, { displayName: "A member with no powers" });
  admin = await makeUser(db, { displayName: "An admin who holds nothing" });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin));
  const poll = await createPoll(
    member,
    {
      question: "Which evening?",
      multiple: false,
      closesAt: new Date(CLOSES),
      options: [{ label: "Friday" }, { label: "Saturday" }],
    },
    db
  );
  if (!poll.ok) throw new Error(poll.error);
  target = { suggestionId: await aSuggestion(member, "A member's idea"), pollId: poll.data.id };
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  state.userId = null;
  state.gate = { enabled: false, guildId: "" };
  vi.stubEnv("DISCORD_WEBHOOK_URL", "");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  vi.stubEnv("AUTH_URL", "");
  await setIntegrationSetting(SETTING_KEYS.webhookUrl, WEBHOOK);
  await setIntegrationSetting(SETTING_KEYS.siteOrigin, ORIGIN);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function as(holder: HolderName): string {
  state.userId = ids[holder];
  return ids[holder];
}

/**
 * Everything a call in these three files can move: the log, the polls, the
 * suggestions, every stored setting (the webhook, the address and the switches
 * are rows in it), the wording, and the gate. A refused call must leave all of
 * it as it was.
 */
async function written() {
  const [lines, pollRows, suggestionRows, settingRows, templateRows] = await Promise.all([
    db.select({ id: auditLog.id }).from(auditLog),
    db
      .select({ id: polls.id, question: polls.question, closesAt: polls.closesAt })
      .from(polls)
      .orderBy(asc(polls.id)),
    db
      .select({ id: eventSuggestions.id, status: eventSuggestions.status })
      .from(eventSuggestions)
      .orderBy(asc(eventSuggestions.id)),
    db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .orderBy(asc(settings.key)),
    db
      .select({ kind: announcementTemplates.kind, version: announcementTemplates.version })
      .from(announcementTemplates)
      .orderBy(asc(announcementTemplates.kind)),
  ]);
  return {
    audit: lines.length,
    polls: pollRows,
    suggestions: suggestionRows,
    settings: settingRows,
    templates: templateRows,
    gate: { ...state.gate },
  };
}

async function auditFor(action: string) {
  return db
    .select({ actor: auditLog.actorUserId, summary: auditLog.summary, detail: auditLog.detail })
    .from(auditLog)
    .where(eq(auditLog.action, action));
}

/* ------------------------------------------------------------------ */
/* The three files' whole exported surface                            */
/* ------------------------------------------------------------------ */

/**
 * One call per action behind a power, each with a payload that **would be
 * written** if the guard were not there - a real poll, a real suggestion, a
 * well-formed webhook and address, a well-formed server id. A refusal proven
 * with a payload the action would have refused anyway proves nothing about who
 * was asking.
 */
const CALLS: Record<string, () => Promise<unknown>> = {
  "polls#createPollAction": () => MODULES.polls.createPollAction(draft("Not theirs to post?")),
  "polls#previewPollEditAction": () =>
    MODULES.polls.previewPollEditAction(target.pollId, draft("Which evening, then?")),
  "polls#updatePollAction": () =>
    MODULES.polls.updatePollAction(target.pollId, draft("Which evening, then?")),
  "polls#closePollAction": () => MODULES.polls.closePollAction(target.pollId),
  "polls#deletePollAction": () => MODULES.polls.deletePollAction(target.pollId),
  "suggestions#setSuggestionStatusAction": () =>
    MODULES.suggestions.setSuggestionStatusAction(target.suggestionId, "planned"),
  "settings#saveAnnouncementSettingsAction": () =>
    MODULES.settings.saveAnnouncementSettingsAction(
      Object.fromEntries(Object.keys(defaultAnnouncementSettings()).map((kind) => [kind, true]))
    ),
  "settings#saveAnnouncementTemplateAction": () =>
    MODULES.settings.saveAnnouncementTemplateAction({
      kind: "match_result",
      body: "{winner} take it.",
      everyone: true,
      roleIds: [],
      expectedVersion: 0,
    }),
  "settings#saveGuildGateAction": () =>
    MODULES.settings.saveGuildGateAction({ enabled: true, guildId: GUILD }),
  "settings#saveIntegrationsAction": () =>
    MODULES.settings.saveIntegrationsAction({
      webhookUrl: SECOND_WEBHOOK,
      siteOrigin: SECOND_ORIGIN,
    }),
};

/**
 * The actions any signed-in member may call. They are not what a power is for,
 * so no holder is expected to be refused them and they have no call above -
 * listed by name, so a new export does not join them by default.
 */
const ANY_MEMBER = [
  "polls#votePollAction",
  "suggestions#addSuggestionAction",
  "suggestions#voteSuggestionAction",
  "suggestions#deleteSuggestionAction",
];

/** What each power lets its holder call. Everything else must refuse them. */
const REACHES: Record<HolderName, readonly string[]> = {
  "polls.manage": [
    "polls#createPollAction",
    "polls#previewPollEditAction",
    "polls#updatePollAction",
    "polls#closePollAction",
    "polls#deletePollAction",
  ],
  "suggestions.moderate": ["suggestions#setSuggestionStatusAction"],
  "settings.announcements": [
    "settings#saveAnnouncementSettingsAction",
    "settings#saveAnnouncementTemplateAction",
  ],
  "settings.integrations": ["settings#saveGuildGateAction", "settings#saveIntegrationsAction"],
};

const REFUSALS = HOLDERS.flatMap((holder) =>
  Object.keys(CALLS)
    .filter((action) => !REACHES[holder].includes(action))
    .map((action) => [holder, action] as const)
);

describe("polls, suggestions and settings, asked by somebody whose power does not reach the action", () => {
  it("files every action the three files export under exactly one power, or under any member", () => {
    const exported = Object.entries(MODULES).flatMap(([name, module]) =>
      Object.keys(module).map((action) => `${name}#${action}`)
    );
    const filed = [...Object.values(REACHES).flat(), ...ANY_MEMBER];

    expect(filed.sort()).toEqual(exported.sort());
  });

  it("has a call here for every action behind a power", () => {
    expect(Object.keys(CALLS).sort()).toEqual(Object.values(REACHES).flat().sort());
  });

  it.each(REFUSALS)("turns the holder of %s away from %s, and writes nothing", async (holder, action) => {
    as(holder);
    const before = await written();

    await expect(CALLS[action]()).rejects.toThrow(/NEXT_REDIRECT/);

    expect(await written()).toEqual(before);
  });
});

/* ------------------------------------------------------------------ */
/* settings.announcements                                             */
/* ------------------------------------------------------------------ */

describe("settings.announcements", () => {
  it("changes an announcement's mentions, and the audit line names the holder", async () => {
    const holder = as("settings.announcements");
    const { version } = await getAnnouncementTemplate("draft_lot_sold");

    const result = await MODULES.settings.saveAnnouncementTemplateAction({
      kind: "draft_lot_sold",
      body: null,
      everyone: false,
      roleIds: [GUILD],
      expectedVersion: version,
    });

    expect(result.ok).toBe(true);
    expect((await getAnnouncementTemplate("draft_lot_sold")).mention).toEqual({
      everyone: false,
      roleIds: [GUILD],
    });
    const lines = await auditFor("announcement.wording_changed");
    expect(lines.map((line) => line.actor)).toContain(holder);
  });

  it("changes an announcement's wording", async () => {
    as("settings.announcements");
    const { version } = await getAnnouncementTemplate("match_result");

    const result = await MODULES.settings.saveAnnouncementTemplateAction({
      kind: "match_result",
      body: "{winner} take it, {score}.",
      everyone: false,
      roleIds: [],
      expectedVersion: version,
    });

    expect(result.ok).toBe(true);
    expect((await getAnnouncementTemplate("match_result")).body).toBe("{winner} take it, {score}.");
  });

  it("switches an announcement, and the audit line names the holder", async () => {
    const holder = as("settings.announcements");
    const before = await getAnnouncementSettings();

    await MODULES.settings.saveAnnouncementSettingsAction({
      ...before,
      match_result: !before.match_result,
    });

    expect((await getAnnouncementSettings()).match_result).toBe(!before.match_result);
    expect((await auditFor("settings.announcements")).map((line) => line.actor)).toContain(holder);
  });

  it("is refused the webhook URL, sent alone", async () => {
    as("settings.announcements");

    await expect(
      MODULES.settings.saveIntegrationsAction({ webhookUrl: SECOND_WEBHOOK })
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect((await getIntegrationConfig()).webhook).toBe(WEBHOOK);
  });

  it("is refused clearing the webhook URL", async () => {
    as("settings.announcements");

    await expect(MODULES.settings.saveIntegrationsAction({ clearWebhook: true })).rejects.toThrow(
      /NEXT_REDIRECT/
    );

    expect((await getIntegrationConfig()).webhook).toBe(WEBHOOK);
  });

  it("is refused the site origin, sent alone", async () => {
    as("settings.announcements");

    await expect(
      MODULES.settings.saveIntegrationsAction({ siteOrigin: SECOND_ORIGIN })
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect((await getIntegrationConfig()).origin).toBe(ORIGIN);
  });
});

/* ------------------------------------------------------------------ */
/* settings.integrations                                              */
/* ------------------------------------------------------------------ */

describe("settings.integrations", () => {
  it("sets the webhook and the address", async () => {
    as("settings.integrations");

    await MODULES.settings.saveIntegrationsAction({
      webhookUrl: SECOND_WEBHOOK,
      siteOrigin: SECOND_ORIGIN,
    });

    expect(await getIntegrationConfig()).toMatchObject({
      webhook: SECOND_WEBHOOK,
      origin: SECOND_ORIGIN,
    });
  });

  it("is named on the audit line for it", async () => {
    const holder = as("settings.integrations");

    await MODULES.settings.saveIntegrationsAction({ webhookUrl: SECOND_WEBHOOK });

    expect((await auditFor("settings.integrations")).map((line) => line.actor)).toContain(holder);
  });

  it("points the sign-in gate at a server, and the audit line names the holder", async () => {
    const holder = as("settings.integrations");

    await MODULES.settings.saveGuildGateAction({ enabled: true, guildId: GUILD });

    expect(state.gate).toEqual({ enabled: true, guildId: GUILD });
    expect((await auditFor("settings.guild_gate")).map((line) => line.actor)).toContain(holder);
  });
});

/* ------------------------------------------------------------------ */
/* polls.manage                                                       */
/* ------------------------------------------------------------------ */

describe("polls.manage", () => {
  it("posts a poll, closes it and deletes it, and each audit line names the holder", async () => {
    const holder = as("polls.manage");

    const created = await MODULES.polls.createPollAction(draft("A holder's first poll?"));
    if (!created.ok) throw new Error(created.error);
    await MODULES.polls.closePollAction(created.data.id);
    await MODULES.polls.deletePollAction(created.data.id);

    expect(await db.select().from(polls).where(eq(polls.id, created.data.id))).toEqual([]);
    const lines = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.actorUserId, holder));
    expect(lines.map((line) => line.action).sort()).toEqual([
      "poll.closed",
      "poll.created",
      "poll.deleted",
    ]);
  });

  it("previews and changes a poll somebody else posted, and the audit line names the holder", async () => {
    const holder = as("polls.manage");
    const edit = { ...draft("Which evening?"), detail: "Edited by a holder." };

    const preview = await MODULES.polls.previewPollEditAction(target.pollId, edit);
    const result = await MODULES.polls.updatePollAction(target.pollId, edit);

    expect([preview.ok, result.ok]).toEqual([true, true]);
    const [row] = await db
      .select({ detail: polls.detail })
      .from(polls)
      .where(eq(polls.id, target.pollId));
    expect(row.detail).toBe("Edited by a holder.");
    expect((await auditFor("poll.updated")).map((line) => line.actor)).toEqual([holder]);
  });
});

/* ------------------------------------------------------------------ */
/* suggestions.moderate                                               */
/* ------------------------------------------------------------------ */

describe("suggestions.moderate", () => {
  async function statusOf(id: string) {
    const rows = await db
      .select({ status: eventSuggestions.status })
      .from(eventSuggestions)
      .where(eq(eventSuggestions.id, id));
    return rows.map((row) => row.status);
  }

  it("sets the status of a suggestion somebody else made, and the audit line names the holder", async () => {
    const holder = as("suggestions.moderate");
    const id = await aSuggestion(member, "Somebody else's idea");

    const result = await MODULES.suggestions.setSuggestionStatusAction(id, "planned");

    expect(result).toEqual({ ok: true, data: undefined });
    expect(await statusOf(id)).toEqual(["planned"]);
    expect((await auditFor("suggestion.status")).map((line) => line.actor)).toContain(holder);
  });

  it("deletes a suggestion somebody else made", async () => {
    as("suggestions.moderate");
    const id = await aSuggestion(member, "One to be moderated away");

    const result = await MODULES.suggestions.deleteSuggestionAction(id);

    expect(result).toEqual({ ok: true, data: undefined });
    expect(await statusOf(id)).toEqual([]);
  });

  it("leaves an admin who holds nothing deleting somebody else's", async () => {
    state.userId = admin;
    const id = await aSuggestion(member, "One for the admin to remove");

    const result = await MODULES.suggestions.deleteSuggestionAction(id);

    expect(result).toEqual({ ok: true, data: undefined });
    expect(await statusOf(id)).toEqual([]);
  });

  it("leaves a member deleting their own", async () => {
    state.userId = member;
    const id = await aSuggestion(member, "My own idea");

    const result = await MODULES.suggestions.deleteSuggestionAction(id);

    expect(result).toEqual({ ok: true, data: undefined });
    expect(await statusOf(id)).toEqual([]);
  });

  it("leaves a member unable to delete somebody else's", async () => {
    state.userId = await makeUser(db, { displayName: "Another member" });

    const result = await MODULES.suggestions.deleteSuggestionAction(target.suggestionId);

    expect(result).toEqual({ ok: false, error: "That is not yours to remove." });
    expect(await statusOf(target.suggestionId)).toEqual(["open"]);
  });

  it.each(HOLDERS.filter((holder) => holder !== "suggestions.moderate"))(
    "is the only power that deletes somebody else's: the holder of %s cannot",
    async (holder) => {
      as(holder);

      const result = await MODULES.suggestions.deleteSuggestionAction(target.suggestionId);

      expect(result).toEqual({ ok: false, error: "That is not yours to remove." });
      expect(await statusOf(target.suggestionId)).toEqual(["open"]);
    }
  );
});
