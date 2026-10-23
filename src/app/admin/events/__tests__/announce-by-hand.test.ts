import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  type Database,
  SETTING_KEYS,
  announcementClaims,
  auditLog,
  eventDays,
  events,
} from "@/db";
import {
  type TestDatabase,
  freshDatabase,
  makeHost,
  makeUser,
} from "@/db/__tests__/helpers";
import type { AnnouncementSettings, DiscordMessage } from "@/lib/announce";
import { MANUAL_REFUSALS } from "@/lib/announce-manual";

/*
 * The Publish tab's five buttons, through the action, for real against an
 * in-memory Postgres and a fake Discord (R-221 to R-223 / UC-43).
 *
 * Mocked as `host-scope.test.ts` mocks it — the session cookie, the page cache
 * and `after()` — plus a `fetch` stub, because this action is the one
 * announcement path that is *awaited*: its return value is the whole of what
 * the screen is told, so the request happens inside the call rather than in
 * `after()`.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
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

vi.mock("@/lib/auth", () => ({
  SIGN_IN_PATH: "/signin",
  auth: async () => (state.userId ? { user: { id: state.userId } } : null),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: () => {} }));

const { postAnnouncementByHandAction } = await import("../actions");
const { setAnnouncementSettings, setIntegrationSetting } = await import("@/lib/discord");
const { defaultAnnouncementSettings } = await import("@/lib/announce");
const { AUDIT_ACTIONS, actionLabel } = await import("@/lib/audit");

let handle: TestDatabase;
let db: Database;
let hostId: string;
let strangerId: string;
let counter = 0;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
  hostId = await makeUser(db, { displayName: "Marta the host" });
  strangerId = await makeUser(db, { displayName: "Passing Pat" });
});

afterAll(async () => {
  await handle.close();
});

const fetchStub = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

beforeEach(async () => {
  state.userId = hostId;
  await setIntegrationSetting(SETTING_KEYS.webhookUrl, "https://discord.test/api/webhooks/1/t");
  vi.stubEnv("DISCORD_WEBHOOK_URL", "");
  vi.stubGlobal("fetch", fetchStub);
  fetchStub.mockResolvedValue(new Response(null, { status: 204 }));
  // Every switch off, so nothing below passes because a kind happened to be on.
  await setAnnouncementSettings(
    Object.fromEntries(
      Object.keys(defaultAnnouncementSettings()).map((kind) => [kind, false])
    ) as AnnouncementSettings,
    db
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchStub.mockReset();
});

/** An event this file's host manages. */
async function managed(
  setup: { dayStarts?: readonly Date[]; signupClosesAt?: Date | null } = {}
): Promise<{ id: string; title: string }> {
  counter += 1;
  const title = `Pressed ${counter}`;
  const [row] = await db
    .insert(events)
    .values({
      slug: `pressed-${counter}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      status: "published",
      signupClosesAt: setup.signupClosesAt ?? null,
    })
    .returning({ id: events.id });
  for (const [dayIndex, startsAt] of (setup.dayStarts ?? []).entries()) {
    await db.insert(eventDays).values({ eventId: row.id, dayIndex, startsAt });
  }
  await makeHost(db, row.id, hostId);
  return { id: row.id, title };
}

function sentFor(title: string): DiscordMessage[] {
  return fetchStub.mock.calls
    .map(([, init]) => JSON.parse(String(init.body)) as DiscordMessage)
    .filter((message) => message.embeds[0].title === title);
}

async function linesFor(eventId: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.eventId, eventId), eq(auditLog.action, action)));
}

/** Every audit action recorded against this event. */
async function actionsFor(eventId: string): Promise<string[]> {
  const rows = await db.select().from(auditLog).where(eq(auditLog.eventId, eventId));
  return rows.map((row) => row.action);
}

/* ------------------------------------------------------------------ */
/* UC-43 3, 4, 5 — pressing one                                       */
/* ------------------------------------------------------------------ */

describe("pressing a button (UC-43 3, 4, 5)", () => {
  it("posts, claims, and records who posted it by hand", async () => {
    const { id, title } = await managed();

    const result = await postAnnouncementByHandAction(id, "event_published");

    expect(result).toEqual({ outcome: "posted", name: "New event", claimed: true });
    expect(sentFor(title).map((message) => message.embeds[0].footer?.text)).toEqual([
      "New event",
    ]);

    const rows = await linesFor(id, "announcement.posted_by_hand");
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(hostId);
    expect(rows[0].actorName).toBe("Marta the host");
    expect(rows[0].subject).toBe("event_published");
    expect(rows[0].summary).toBe(
      `Marta the host posted the “New event” announcement for “${title}” by hand.`
    );
    expect(rows[0].detail).toMatchObject({ kind: "event_published", claimed: true });
  });

  it("registers the action in the log's vocabulary, so the line gets a heading", async () => {
    /*
     * The same shape `hero-actions.test.ts` uses for its five, and for the
     * reason `actionLabel` has a fallback: a row whose action is not in
     * `AUDIT_ACTIONS` still renders — as the raw string — so nothing fails
     * anywhere until somebody reads "announcement.posted_by_hand" on
     * `/admin/audit`. The vocabulary entry is a line of code with no other
     * test behind it.
     */
    const { id } = await managed();
    await postAnnouncementByHandAction(id, "event_published");
    const [line] = await linesFor(id, "announcement.posted_by_hand");

    expect(AUDIT_ACTIONS).toHaveProperty("announcement.posted_by_hand");
    expect(actionLabel(line.action)).toBe("Announcement posted by hand");
  });

  it("posts a kind whose switch is off, and still records it (R-223 / UC-43 2a)", async () => {
    const { id, title } = await managed({ dayStarts: [new Date("2027-10-01T18:00Z")] });

    const result = await postAnnouncementByHandAction(id, "event_starting_soon");

    expect(result).toMatchObject({ outcome: "posted", name: "Starting soon" });
    expect(sentFor(title).map((message) => message.embeds[0].footer?.text)).toEqual([
      "Starting soon",
    ]);
    expect(await actionsFor(id)).toEqual(["announcement.posted_by_hand"]);
  });

  it("says the claim was already somebody else's, and writes no second row (UC-43 4b)", async () => {
    const { id, title } = await managed();
    await db
      .insert(announcementClaims)
      .values({ kind: "signups_open", eventId: id, claimedAt: new Date("2026-08-08T08:00Z") });

    // Already posted, so it asks first (below); confirmed, it goes.
    const result = await postAnnouncementByHandAction(id, "signups_open", { confirmed: true });

    expect(result).toEqual({ outcome: "posted", name: "Applications open", claimed: false });
    expect(sentFor(title)).toHaveLength(1);
    expect(
      await db.select().from(announcementClaims).where(eq(announcementClaims.eventId, id))
    ).toHaveLength(1);
    const [line] = await linesFor(id, "announcement.posted_by_hand");
    expect(line.detail).toMatchObject({ claimed: false });
  });
});

/* ------------------------------------------------------------------ */
/* R-222 / UC-43 3a — already posted is a warning                     */
/* ------------------------------------------------------------------ */

describe("a kind that has already gone out (R-222 / UC-43 3a)", () => {
  it("asks rather than posting, and says when it went", async () => {
    const { id, title } = await managed();
    const went = new Date("2026-10-10T19:30:00.000Z");
    await db
      .insert(announcementClaims)
      .values({ kind: "event_published", eventId: id, claimedAt: went });

    const result = await postAnnouncementByHandAction(id, "event_published");

    /*
     * `outcome: "confirm"`, which is a different answer from `"refused"` rather
     * than a refusal with friendlier words. That distinction is the whole of
     * R-222, and it is why this action does not return the `EventResult` the
     * rest of the file does: a two-case result would make this an `ok: false`
     * with a sentence in it, and an assertion on that sentence would be
     * satisfied by any other refusal containing the same phrase — the mutation
     * that escaped Task 78, on a confirm flow exactly like this one.
     */
    expect(result).toEqual({ outcome: "confirm", postedAt: went });
    // And nothing went out: it is an ask, so the channel has not been posted to
    // a second time.
    expect(sentFor(title)).toEqual([]);
    expect(await actionsFor(id)).toEqual([]);
  });

  it("posts it again once confirmed, which is the case the feature exists for", async () => {
    const { id, title } = await managed();
    await db
      .insert(announcementClaims)
      .values({ kind: "event_published", eventId: id, claimedAt: new Date("2026-10-10T19:30Z") });

    // Unconfirmed first, so the pair is one story: asked, then confirmed.
    expect(await postAnnouncementByHandAction(id, "event_published")).toMatchObject({
      outcome: "confirm",
    });
    expect(sentFor(title)).toEqual([]);

    const result = await postAnnouncementByHandAction(id, "event_published", {
      confirmed: true,
    });

    expect(result).toMatchObject({ outcome: "posted" });
    expect(sentFor(title)).toHaveLength(1);
    expect(await actionsFor(id)).toEqual(["announcement.posted_by_hand"]);
  });

  it("does not ask about a kind that has never gone out", async () => {
    // The other half: a first post is not stopped to ask a question nobody
    // needs answered, which is how "always confirm" would pass the test above.
    const { id } = await managed();
    expect(await postAnnouncementByHandAction(id, "event_published")).toMatchObject({
      outcome: "posted",
    });
  });
});

/* ------------------------------------------------------------------ */
/* The refusals                                                       */
/* ------------------------------------------------------------------ */

describe("what the action refuses", () => {
  it("refuses a kind that is not one of the five, posting and logging nothing (R-221)", async () => {
    const { id } = await managed();

    // Its announcer takes an application id, so there is no message to build.
    const result = await postAnnouncementByHandAction(id, "application_declined");

    expect(result).toEqual({ outcome: "refused", error: MANUAL_REFUSALS.notManual });
    expect(result).toEqual({
      outcome: "refused",
      error: "That is not an announcement this screen can post.",
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await actionsFor(id)).toEqual([]);
  });

  it("refuses nonsense, and asks no question about it first", async () => {
    const { id } = await managed();
    await db
      .insert(announcementClaims)
      .values({ kind: "not_a_kind", eventId: id, claimedAt: new Date() });

    // The kind is checked before the claim is read, so a crafted call cannot
    // get a `confirm` for something that could never be posted.
    expect(await postAnnouncementByHandAction(id, "not_a_kind")).toEqual({
      outcome: "refused",
      error: MANUAL_REFUSALS.notManual,
    });
  });

  it("passes the library's refusal through, naming what is missing (UC-43 4a)", async () => {
    const { id } = await managed({ dayStarts: [] });

    expect(await postAnnouncementByHandAction(id, "event_starting_soon")).toEqual({
      outcome: "refused",
      error:
        "This event has no dated day, so there is no start time to announce. " +
        "Give it a day on the Days tab first.",
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await actionsFor(id)).toEqual([]);
  });

  it("refuses when there is no webhook (UC-43 3b)", async () => {
    await setIntegrationSetting(SETTING_KEYS.webhookUrl, null, db);
    const { id } = await managed();

    expect(await postAnnouncementByHandAction(id, "event_published")).toEqual({
      outcome: "refused",
      error: MANUAL_REFUSALS.noWebhook,
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("does not record a post as happening when Discord refused it (UC-43 5a)", async () => {
    const { id } = await managed();
    fetchStub.mockResolvedValue(new Response(null, { status: 503 }));

    const result = await postAnnouncementByHandAction(id, "event_published");

    expect(result).toEqual({
      outcome: "refused",
      error:
        "Discord refused the post: Discord answered 503. " +
        "Nothing reached the channel, and the failure is in the audit log.",
    });
    /*
     * The failure is in the log, as an automatic one would be — and the manual
     * line is **not**, because nothing was posted. "Every manual post is
     * audited" must not become "every press is audited as a post".
     */
    expect(await actionsFor(id)).toEqual(["announcement.failed"]);
    expect(await linesFor(id, "announcement.posted_by_hand")).toEqual([]);
    // Nor is the claim taken, so the scheduler can still post it.
    expect(
      await db.select().from(announcementClaims).where(eq(announcementClaims.eventId, id))
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Who may press it                                                   */
/* ------------------------------------------------------------------ */

describe("who may post an event's announcements", () => {
  it("lets the event's own host, who manages this one event", async () => {
    const { id } = await managed();
    expect(await postAnnouncementByHandAction(id, "event_published")).toMatchObject({
      outcome: "posted",
    });
  });

  it("turns away somebody who does not manage it, before anything is posted", async () => {
    const { id, title } = await managed();
    state.userId = strangerId;

    await expect(postAnnouncementByHandAction(id, "event_published")).rejects.toThrow(
      /NEXT_REDIRECT/
    );

    expect(sentFor(title)).toEqual([]);
    expect(await actionsFor(id)).toEqual([]);
  });

  it("turns away somebody who is not signed in at all", async () => {
    const { id, title } = await managed();
    state.userId = null;

    await expect(postAnnouncementByHandAction(id, "event_published")).rejects.toThrow(
      /NEXT_REDIRECT/
    );
    expect(sentFor(title)).toEqual([]);
  });
});
