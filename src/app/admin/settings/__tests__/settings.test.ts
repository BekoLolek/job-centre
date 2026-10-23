import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { desc, eq } from "drizzle-orm";
import { type Database, SETTING_KEYS, announcementTemplates, auditLog, events } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { PageHeader, StatTile } from "@/components/ui";
import {
  ANNOUNCEMENTS,
  type AnnouncementKind,
  defaultAnnouncementSettings,
} from "@/lib/announce";

/*
 * `/admin/settings`, the page and its integrations action, against an
 * in-memory Postgres.
 *
 * Only what cannot run outside a Next request is replaced: who is signed in,
 * the sign-in gate (it lives beside NextAuth, which will not load here) and the
 * page cache. `@/db`'s `db` is pointed at this file's database the same way
 * `host-scope.test.ts` does it.
 */
const state = vi.hoisted(() => ({ db: undefined as unknown as Database, adminId: "" }));

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

vi.mock("@/lib/session-guards", () => ({
  // A real row, so the audit line the action writes can name its actor.
  requireAdmin: async () => ({ id: state.adminId, displayName: "Admin" }),
}));

vi.mock("@/lib/auth", () => ({
  getGateConfig: async () => ({ enabled: false, guildId: "", source: { guildId: "none" } }),
  setGateConfig: async () => {
    throw new Error("not used here");
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { default: AdminSettingsPage } = await import("../page");
const { default: AnnouncementSettings, NOT_POSTED_YET } = await import(
  "@/components/admin/AnnouncementSettings"
);
const { saveAnnouncementTemplateAction, saveIntegrationsAction } = await import("../actions");
const {
  getAnnouncementTemplate,
  getIntegrationConfig,
  setAnnouncementSettings,
  setIntegrationSetting,
} = await import("@/lib/discord");

/** The switches a kind has until somebody touches them. */
const defaults = defaultAnnouncementSettings();
const { loadDashboard } = await import("@/lib/admin-dashboard");
const { recordAudit } = await import("@/lib/audit");

let handle: TestDatabase;

beforeAll(async () => {
  handle = await freshDatabase();
  state.db = handle.db;
  state.adminId = await makeUser(handle.db, { displayName: "Admin" });
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  vi.stubEnv("DISCORD_WEBHOOK_URL", "");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  vi.stubEnv("AUTH_URL", "");
  await setIntegrationSetting(SETTING_KEYS.webhookUrl, null);
  await setIntegrationSetting(SETTING_KEYS.siteOrigin, null);
  // The switches are one stored row, so a test that changes them changes them
  // for whatever runs next. Back to the defaults before each one.
  await setAnnouncementSettings(defaults);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** The first element of this component type anywhere in a rendered tree. */
function findElement(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(node)) {
    return node.map((child) => findElement(child, type)).find(Boolean) ?? null;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return null;
  if (node.type === type) return node;
  return findElement(node.props.children as ReactNode, type);
}

describe("the webhook status", () => {
  it("shows a webhook saved on this screen as configured", async () => {
    await setIntegrationSetting(SETTING_KEYS.webhookUrl, "https://discord.test/api/webhooks/1/token");

    const page = await AdminSettingsPage();

    expect(findElement(page, AnnouncementSettings)?.props.configured).toBe(true);
  });

  it("shows no webhook as not set up", async () => {
    const page = await AdminSettingsPage();

    expect(findElement(page, AnnouncementSettings)?.props.configured).toBe(false);
  });
});

describe("saving the integrations", () => {
  it("saves nothing when the webhook is valid but the address is not", async () => {
    const result = await saveIntegrationsAction({
      webhookUrl: "https://discord.test/api/webhooks/2/token",
      siteOrigin: "not an address",
    });

    expect(result.ok).toBe(false);
    expect((await getIntegrationConfig()).webhook).toBeNull();
  });

  it("clears the site address back to the deployment's", async () => {
    await setIntegrationSetting(SETTING_KEYS.siteOrigin, "https://old.example.test");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://jobcentre.example.test");

    const result = await saveIntegrationsAction({ clearSiteOrigin: true });

    expect(result).toEqual({
      ok: true,
      data: { webhook: null, origin: "https://jobcentre.example.test" },
    });
  });
});

describe("a failed announcement on the admin home", () => {
  /*
   * The save action stamps its audit row with the clock, so the clock is set.
   * Each test runs in a year of its own, and the address-only one in the later
   * year, so the webhook save in the other can never be what hides its failure
   * whichever order they run in.
   */
  let counter = 0;

  async function failureOnEvent(at: string) {
    counter += 1;
    const [event] = await handle.db
      .insert(events)
      .values({ slug: `announce-home-${counter}`, title: `Announce home ${counter}` })
      .returning({ id: events.id });
    await recordAudit(
      {
        action: "announcement.failed",
        summary: "The announcement did not go out — Discord answered 404.",
        eventId: event.id,
        now: new Date(at),
      },
      handle.db
    );
    return event.id;
  }

  async function failuresFor(eventId: string) {
    const view = await loadDashboard({}, handle.db);
    return view.items.filter((item) => item.kind === "announcements" && item.event?.id === eventId);
  }

  it("clears once the webhook is saved", async () => {
    const eventId = await failureOnEvent("2031-01-01T00:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-01-01T01:00:00Z"));

    unwrap(await saveIntegrationsAction({ webhookUrl: "https://discord.test/api/webhooks/3/token" }));

    expect(await failuresFor(eventId)).toEqual([]);
  });

  it("stays after a save that only changed the site address", async () => {
    const eventId = await failureOnEvent("2032-01-01T00:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2032-01-01T01:00:00Z"));

    unwrap(await saveIntegrationsAction({ siteOrigin: "https://jobcentre.example.test" }));

    expect(await failuresFor(eventId)).toHaveLength(1);
  });
});

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/* ------------------------------------------------------------------ */
/* Saving one announcement's wording (UC-37 6, 7, 7a)                 */
/* ------------------------------------------------------------------ */

/**
 * The action behind the editor, against the real database.
 *
 * The component test next door proves the admin *sees* each refusal; this
 * proves the save actually refuses, and that nothing reaches the row when it
 * does. Both halves are needed: a screen that showed the right sentence while
 * the action saved anyway would pass either one alone.
 */
describe("saving an announcement's wording", () => {
  const KIND: AnnouncementKind = "match_result";

  beforeEach(async () => {
    await handle.db.delete(announcementTemplates);
    await handle.db.delete(auditLog);
  });

  async function latestAudit(action: string) {
    return handle.db
      .select({ summary: auditLog.summary, detail: auditLog.detail, actor: auditLog.actorName })
      .from(auditLog)
      .where(eq(auditLog.action, action))
      .orderBy(desc(auditLog.at));
  }

  it("stores the wording and the mention, and says who changed it (UC-37 7)", async () => {
    const saved = unwrap(
      await saveAnnouncementTemplateAction({
        kind: KIND,
        body: "{winner} take it, {score} over {teamB}.",
        everyone: true,
        roleIds: ["123456789012345678"],
        expectedVersion: 0,
      })
    );

    expect(saved.body).toBe("{winner} take it, {score} over {teamB}.");
    expect(saved.mention).toEqual({ everyone: true, roleIds: ["123456789012345678"] });
    expect(saved.version).toBe(1);

    // Read back through the module that reads it, not off the row, so the
    // thing proven stored is the thing `deliver` will post.
    const stored = await getAnnouncementTemplate(KIND);
    expect(stored.body).toBe("{winner} take it, {score} over {teamB}.");
    expect(stored.mention.roleIds).toEqual(["123456789012345678"]);

    const [row] = await latestAudit("announcement.wording_changed");
    expect(row.summary).toBe(
      "The “match_result” announcement was edited and now mentions @everyone <@&123456789012345678>."
    );
    expect(row.actor).toBe("Admin");

    // UC-37 4c: a line of its own, because "which announcement pings four
    // hundred people" is a question somebody answers by scanning the log.
    const [pings] = await latestAudit("announcement.pings_everyone");
    expect(pings.summary).toBe("The “match_result” announcement now pings the whole server.");
  });

  it.each([
    {
      what: "a placeholder the kind does not offer (UC-37 3a)",
      body: "{captain} take it",
      roleIds: [] as string[],
      says: "This announcement has no {captain}. It offers {teamA}, {teamB}, {score}, {winner}, {match}, {event}.",
    },
    {
      what: "an empty wording (UC-37 3b)",
      body: "   ",
      roleIds: [] as string[],
      says: "An announcement with no words is the switch being off — use the switch instead.",
    },
    {
      what: "a wording over Discord's limit (UC-37 3c)",
      body: "x".repeat(4097),
      roleIds: [] as string[],
      says: "Discord accepts 4096 characters in an announcement; that is 4097.",
    },
    {
      what: "a role name where an id goes",
      body: null,
      roleIds: ["Pingers"],
      says: "“Pingers” is not a role id. A role ping needs the id Discord gives the role, not its name.",
    },
  ])("refuses $what and stores nothing", async ({ body, roleIds, says }) => {
    const result = await saveAnnouncementTemplateAction({
      kind: KIND,
      body,
      everyone: false,
      roleIds,
      expectedVersion: 0,
    });

    expect(result.ok).toBe(false);
    // The sentence, not `ok === false`: the words are the feature, and a
    // refusal with the wrong reason in it is a refusal nobody can act on.
    expect(result.ok === false && result.error).toBe(says);
    expect(await handle.db.select().from(announcementTemplates)).toEqual([]);
    expect(await latestAudit("announcement.wording_changed")).toEqual([]);
  });

  it("does not quietly drop a role name it cannot use", async () => {
    /*
     * The trap this action's comment names. `announcementTemplateFrom` filters
     * non-snowflakes out, so running the payload through it would have saved
     * happily with the mention silently missing — an admin who pasted a role
     * name would be told "Saved" and never notified anybody. The refusal above
     * is the behaviour; this is the assertion that it is not a cleaned save.
     */
    const result = await saveAnnouncementTemplateAction({
      kind: KIND,
      body: null,
      everyone: false,
      roleIds: ["123456789012345678", "Pingers"],
      expectedVersion: 0,
    });

    expect(result.ok).toBe(false);
    expect(await getAnnouncementTemplate(KIND)).toMatchObject({ version: 0, body: null });
  });

  it("tells the loser of a race what is in force now (UC-37 7a)", async () => {
    unwrap(
      await saveAnnouncementTemplateAction({
        kind: KIND,
        body: "First in wins: {winner}.",
        everyone: false,
        roleIds: [],
        expectedVersion: 0,
      })
    );

    // The second editor was opened before the first save landed, so it is
    // still saving against version 0.
    const second = await saveAnnouncementTemplateAction({
      kind: KIND,
      body: "Second in loses: {winner}.",
      everyone: false,
      roleIds: [],
      expectedVersion: 0,
    });

    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error).toBe(
      "Somebody else changed this announcement while you were editing it."
    );
    // And the row that won, handed over so the screen can show it rather than
    // telling an admin to go and look.
    expect(second.ok === false && second.current?.body).toBe("First in wins: {winner}.");
    expect(second.ok === false && second.current?.version).toBe(1);

    // The winner's words are the ones in force, and the loser's are nowhere.
    expect((await getAnnouncementTemplate(KIND)).body).toBe("First in wins: {winner}.");
  });

  it("goes back to the site's own wording when the body is cleared to null", async () => {
    const first = unwrap(
      await saveAnnouncementTemplateAction({
        kind: KIND,
        body: "Mine: {winner}.",
        everyone: false,
        roleIds: [],
        expectedVersion: 0,
      })
    );

    const back = unwrap(
      await saveAnnouncementTemplateAction({
        kind: KIND,
        body: null,
        everyone: false,
        roleIds: [],
        expectedVersion: first.version,
      })
    );

    expect(back.body).toBeNull();
    expect(back.version).toBe(2);
    expect((await getAnnouncementTemplate(KIND)).body).toBeNull();
  });

  it("refuses a kind that does not exist", async () => {
    const result = await saveAnnouncementTemplateAction({
      kind: "event_unpublished",
      body: "Anything",
      everyone: false,
      roleIds: [],
      expectedVersion: 0,
    });

    expect(result.ok === false && result.error).toBe("There is no announcement of that kind.");
    expect(await handle.db.select().from(announcementTemplates)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The page's own count                                               */
/* ------------------------------------------------------------------ */

describe("the page", () => {
  it("hands the editor every kind's stored wording", async () => {
    const page = await AdminSettingsPage();
    const props = findElement(page, AnnouncementSettings)?.props as
      | { templates?: Record<string, unknown>; openKind?: unknown }
      | undefined;

    expect(Object.keys(props?.templates ?? {}).sort()).toEqual(
      ANNOUNCEMENTS.map((spec) => spec.kind).sort()
    );
    expect(props?.openKind).toBeNull();
  });

  it("opens the kind `?kind=` names, and refuses one it does not recognise", async () => {
    const good = await AdminSettingsPage({
      searchParams: Promise.resolve({ kind: "draft_lot_sold" }),
    });
    expect(findElement(good, AnnouncementSettings)?.props.openKind).toBe("draft_lot_sold");

    const bad = await AdminSettingsPage({
      searchParams: Promise.resolve({ kind: "../../etc/passwd" }),
    });
    expect(findElement(bad, AnnouncementSettings)?.props.openKind).toBeNull();
  });

  it("counts only the kinds something actually posts", async () => {
    /*
     * "Announcing 5/8" with `signups_open` among the five would be the page
     * saying a message is going out when none is. The kinds with no trigger
     * come out of both halves of the tile, and the row that owns the eighth
     * says so itself (R-205, Task 68).
     *
     * Every unwired kind is switched **on** first, and that is the whole point
     * of this setup rather than a flourish: with the defaults, `signups_open`
     * is off, so a numerator counted over all eight kinds happens to give the
     * same figure and the mistake is invisible. Turning them on is what makes
     * the two readings differ.
     */
    const live = ANNOUNCEMENTS.filter((spec) => !NOT_POSTED_YET.includes(spec.kind));
    const onLive = live.filter((spec) => defaults[spec.kind]).length;

    await setAnnouncementSettings({
      ...defaults,
      ...Object.fromEntries(NOT_POSTED_YET.map((kind) => [kind, true])),
    } as typeof defaults);

    const page = await AdminSettingsPage();
    const header = findElement(page, PageHeader);
    const tile = findElement(header?.props.aside as ReactNode, StatTile);

    expect(tile?.props.label).toBe("Announcing");
    expect(tile?.props.value).toBe(`${onLive}/${live.length}`);
    // The current figures, written out: four of the ten kinds fire on the
    // defaults, and every kind has a trigger as this lands, so both halves
    // count all ten. The line above is what holds the *rule* if that changes.
    expect(tile?.props.value).toBe("4/10");
    expect(ANNOUNCEMENTS).toHaveLength(10);
  });
});
