import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { type Database, SETTING_KEYS, events } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";

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
const { default: AnnouncementSettings } = await import("@/components/admin/AnnouncementSettings");
const { saveIntegrationsAction } = await import("../actions");
const { getIntegrationConfig, setIntegrationSetting } = await import("@/lib/discord");
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
