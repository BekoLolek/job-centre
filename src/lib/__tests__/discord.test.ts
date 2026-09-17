import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, SETTING_KEYS } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import type { AnnouncementSettings, DiscordMessage } from "@/lib/announce";

/*
 * Posting, against a real in-memory Postgres and a fake Discord.
 *
 * Three things are replaced, plus a spy. `@/db`'s `db` is pointed at this
 * file's database, because `deliver` reads the webhook and writes its failure
 * row through the default handle. `after()` collects the deferred work instead
 * of needing a request, so a test awaits exactly the job it started rather
 * than sleeping. And `fetch` is a stub: nothing in this file can reach Discord.
 * The spy is on the decision message builder, which calls the real one unless
 * a test makes it throw.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  jobs: [] as Array<Promise<void>>,
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

vi.mock("@/lib/announce", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/announce")>();
  return { ...actual, applicationDecidedMessage: vi.fn(actual.applicationDecidedMessage) };
});

vi.mock("next/server", () => ({
  after: (work: () => Promise<void>) => {
    state.jobs.push(work());
  },
}));

const { announceApplicationDecision, setAnnouncementSettings, setIntegrationSetting } =
  await import("@/lib/discord");
const { applicationDecidedMessage, defaultAnnouncementSettings } = await import("@/lib/announce");
const { listAudit, recordAudit } = await import("@/lib/audit");
const { loadDashboard } = await import("@/lib/admin-dashboard");
const { applyToEvent, createEvent, publishEvent, setApplicationStatus } = await import(
  "@/lib/events"
);

let handle: TestDatabase;
let db: Database;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
});

afterAll(async () => {
  await handle.close();
});

const fetchStub = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

beforeEach(async () => {
  // Configured on the settings screen only — the environment says nothing.
  await setIntegrationSetting(SETTING_KEYS.webhookUrl, "https://discord.test/api/webhooks/1/token");
  vi.stubEnv("DISCORD_WEBHOOK_URL", "");
  vi.stubGlobal("fetch", fetchStub);
  fetchStub.mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchStub.mockReset();
  // Back to the real builder, in case a test made it throw and it never did.
  vi.mocked(applicationDecidedMessage).mockReset();
  vi.useRealTimers();
  state.jobs = [];
});

let counter = 0;

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/** Switch exactly these on, everything else off. */
async function switches(on: Partial<AnnouncementSettings>) {
  const off = Object.fromEntries(
    Object.keys(defaultAnnouncementSettings()).map((kind) => [kind, false])
  ) as AnnouncementSettings;
  await setAnnouncementSettings({ ...off, ...on });
}

/** An application decided as `status`, on its own published event. */
async function decided(status: "waitlisted" | "declined") {
  counter += 1;
  const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Announce ${counter}` }, db));
  unwrap(await publishEvent(event.id, db));
  const member = await makeUser(db, { displayName: `Member ${counter}` });
  const application = unwrap(await applyToEvent(event.id, member, {}, db));
  unwrap(await setApplicationStatus(application.id, status, {}, db));
  return { eventId: event.id, applicationId: application.id };
}

/** Run the announcement and wait for the job it deferred. */
async function announced(applicationId: string) {
  announceApplicationDecision(applicationId);
  await Promise.all(state.jobs);
}

function posted(): DiscordMessage[] {
  return fetchStub.mock.calls.map(([, init]) => JSON.parse(String(init.body)) as DiscordMessage);
}

describe("an application decision", () => {
  it("posts a waitlisting when only the waitlisted switch is on", async () => {
    await switches({ application_accepted: false, application_waitlisted: true });
    const { applicationId } = await decided("waitlisted");

    await announced(applicationId);

    expect(posted().map((message) => message.embeds[0].footer?.text)).toEqual(["Waitlisted"]);
  });

  it("posts a decline when the declined switch is on", async () => {
    await switches({ application_declined: true });
    const { applicationId } = await decided("declined");

    await announced(applicationId);

    expect(posted().map((message) => message.embeds[0].footer?.text)).toEqual(["Declined"]);
  });

  it("posts nothing for a decline while its switch is off", async () => {
    await switches({ application_accepted: true, application_waitlisted: true });
    const { applicationId } = await decided("declined");

    await announced(applicationId);

    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("a post Discord refuses", () => {
  it("is logged under the event it was about", async () => {
    await switches({ application_accepted: true, application_waitlisted: true });
    fetchStub.mockResolvedValue(new Response(null, { status: 500 }));
    const { eventId, applicationId } = await decided("waitlisted");

    await announced(applicationId);

    const rows = await listAudit({ eventId });
    expect(rows.filter((row) => row.action === "announcement.failed")).toHaveLength(1);
  });
});

describe("a message that cannot be built", () => {
  it("is logged under the event the decision was about", async () => {
    await switches({ application_waitlisted: true });
    vi.mocked(applicationDecidedMessage).mockImplementationOnce(() => {
      throw new Error("no sentence for that");
    });
    const { eventId, applicationId } = await decided("waitlisted");

    await announced(applicationId);

    const rows = await listAudit({ eventId });
    expect(rows.filter((row) => row.action === "announcement.failed")).toHaveLength(1);
  });
});

describe("no channel configured", () => {
  it("posts nothing and logs nothing", async () => {
    await setIntegrationSetting(SETTING_KEYS.webhookUrl, null);
    await switches({ application_waitlisted: true });
    const { eventId, applicationId } = await decided("waitlisted");

    await announced(applicationId);

    expect(fetchStub).not.toHaveBeenCalled();
    expect((await listAudit({ eventId })).filter((row) => row.action === "announcement.failed")).toEqual([]);
  });
});

describe("a post still in flight when the webhook is replaced", () => {
  it("is stamped from before the save, so the admin home does not list it", async () => {
    await switches({ application_waitlisted: true });
    const { eventId, applicationId } = await decided("waitlisted");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2033-01-01T00:00:00Z"));
    fetchStub.mockImplementation(async () => {
      // The admin saves a new webhook while Discord is still thinking about
      // the old one, and the refusal only lands after that.
      vi.setSystemTime(new Date("2033-01-01T00:01:00Z"));
      await recordAudit({
        action: "settings.integrations",
        summary: "Integrations changed — webhook set.",
        detail: { webhookChanged: true },
      });
      vi.setSystemTime(new Date("2033-01-01T00:02:00Z"));
      return new Response(null, { status: 500 });
    });

    await announced(applicationId);

    const view = await loadDashboard({}, db);
    expect(view.items.filter((item) => item.kind === "announcements" && item.event?.id === eventId)).toEqual([]);
  });
});
