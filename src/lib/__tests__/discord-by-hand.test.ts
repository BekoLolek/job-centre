import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  type ChampionshipStatusValue,
  type Database,
  SETTING_KEYS,
  announcementClaims,
  applications,
  championships,
  eventDays,
  events,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import type { AnnouncementSettings, DiscordMessage } from "@/lib/announce";
import { MANUAL_REFUSALS } from "@/lib/announce-manual";

/*
 * Posting one of the five by hand, against a real in-memory Postgres and a fake
 * Discord (R-221 to R-223 / UC-43).
 *
 * The harness `discord.test.ts` and `standings-announcement.test.ts` both use,
 * and for the same three reasons: `@/db`'s `db` is this file's database because
 * the failure path writes its audit row through the default handle; `after()`
 * collects deferred work so no test sleeps; and `fetch` is a stub, so nothing
 * here can reach Discord.
 *
 * Nothing in this file is deferred, though, and that is the point of the
 * feature: `postAnnouncementByHand` is awaited and its return value is the only
 * report an admin gets.
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

vi.mock("next/server", () => ({
  after: (work: () => Promise<void>) => {
    state.jobs.push(work());
  },
}));

const {
  announcementPostedAt,
  getAnnouncementSettings,
  manualAnnouncementPanel,
  postAnnouncementByHand,
  postDueAnnouncements,
  setAnnouncementSettings,
  setIntegrationSetting,
} = await import("@/lib/discord");
const { defaultAnnouncementSettings, stamp } = await import("@/lib/announce");
const { listAudit } = await import("@/lib/audit");
const { addCountingEvent, createChampionship } = await import("@/lib/championships");
const { setPlacements } = await import("@/lib/championship-results");

const WEBHOOK = "https://discord.test/api/webhooks/1/token";

let handle: TestDatabase;
let db: Database;
let counter = 0;

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
  await setIntegrationSetting(SETTING_KEYS.webhookUrl, WEBHOOK);
  await setIntegrationSetting(SETTING_KEYS.siteOrigin, "https://jobcentre.test");
  vi.stubEnv("DISCORD_WEBHOOK_URL", "");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  vi.stubGlobal("fetch", fetchStub);
  fetchStub.mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchStub.mockReset();
  state.jobs = [];
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

/** Switch exactly these on, everything else off. */
async function switches(on: Partial<AnnouncementSettings> = {}) {
  const off = Object.fromEntries(
    Object.keys(defaultAnnouncementSettings()).map((kind) => [kind, false])
  ) as AnnouncementSettings;
  await setAnnouncementSettings({ ...off, ...on }, db);
}

/**
 * One event, inserted directly.
 *
 * Direct rather than through `createEvent` for the reason the scheduled tests
 * do it: every test here is about what this event does and does not have, and
 * `PUBLISHABLE`'s window is deliberately nowhere near any instant in this file.
 */
async function event(
  setup: {
    title?: string;
    status?: "draft" | "published" | "live" | "complete" | "cancelled";
    capacity?: number | null;
    signupOpensAt?: Date | null;
    signupClosesAt?: Date | null;
    dayStarts?: readonly Date[];
    accepted?: number;
  } = {}
): Promise<{ id: string; title: string }> {
  counter += 1;
  const title = setup.title ?? `By hand ${counter}`;
  const [row] = await db
    .insert(events)
    .values({
      slug: `by-hand-${counter}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      status: setup.status ?? "published",
      capacity: setup.capacity ?? null,
      signupOpensAt: setup.signupOpensAt ?? null,
      signupClosesAt: setup.signupClosesAt ?? null,
    })
    .returning({ id: events.id });

  for (const [dayIndex, startsAt] of (setup.dayStarts ?? []).entries()) {
    await db.insert(eventDays).values({ eventId: row.id, dayIndex, startsAt });
  }
  for (let seat = 0; seat < (setup.accepted ?? 0); seat += 1) {
    const userId = await makeUser(db);
    await db.insert(applications).values({ eventId: row.id, userId, status: "accepted" });
  }
  return { id: row.id, title };
}

async function season(status: ChampionshipStatusValue = "published"): Promise<string> {
  counter += 1;
  const made = await createChampionship({ name: `By-hand cup ${counter}` }, db);
  if (!made.ok) throw new Error(made.error);
  if (status !== "hidden") {
    await db.update(championships).set({ status }).where(eq(championships.id, made.data.id));
  }
  return made.data.id;
}

async function counts(seasonId: string, eventId: string): Promise<void> {
  const added = await addCountingEvent(seasonId, eventId, db);
  if (!added.ok) throw new Error(added.error);
}

/** Give the event a finishing order, so it has counted towards the table. */
async function finished(eventId: string, names: string[]): Promise<void> {
  const ids: string[] = [];
  for (const name of names) {
    const userId = await makeUser(db, { displayName: name });
    await db.insert(applications).values({ eventId, userId, status: "accepted" });
    ids.push(userId);
  }
  const saved = await setPlacements(
    eventId,
    ids.map((id, index) => ({ id, position: index + 1 })),
    db
  );
  if (!saved.ok) throw new Error(saved.error);
}

/**
 * The payloads that reached Discord **for this event**, by the embed title.
 *
 * Not `posted()[0]`: this file shares one database and one fetch stub, so a
 * run can see a message an earlier test sent. That is not hypothetical — the
 * same mistake is recorded in `discord.test.ts`.
 */
function sentFor(title: string): DiscordMessage[] {
  return fetchStub.mock.calls
    .map(([, init]) => JSON.parse(String(init.body)) as DiscordMessage)
    .filter((message) => message.embeds[0].title === title);
}

async function claimsFor(eventId: string) {
  return db
    .select({ kind: announcementClaims.kind })
    .from(announcementClaims)
    .where(eq(announcementClaims.eventId, eventId));
}

/** This event's audit lines, newest first. */
async function auditFor(eventId: string) {
  return listAudit({ eventId }, db);
}

const NOW = new Date("2026-11-02T12:00:00.000Z");
const MIN = 60 * 1000;
const HR = 60 * MIN;

/* ------------------------------------------------------------------ */
/* UC-43 3, 4 — it posts, now, from the event as it stands            */
/* ------------------------------------------------------------------ */

describe("posting one of the five by hand (UC-43 3, 4)", () => {
  it("posts the kind that was asked for, and only that one", async () => {
    await switches({ event_published: true, signups_open: true });
    const { id, title } = await event({ dayStarts: [new Date("2027-03-01T18:00:00Z")] });

    const result = await postAnnouncementByHand("signups_open", id, db);

    expect(result.ok).toBe(true);
    /*
     * The footers, not a call count. One post is also what the channel sees
     * when the *wrong* one of two went out, and no posts is how this passes
     * vacuously — both kinds are switched on here, so either could have fired.
     */
    expect(sentFor(title).map((message) => message.embeds[0].footer?.text)).toEqual([
      "Applications open",
    ]);
  });

  it("builds the message from the event as it stands now, not as it was", async () => {
    await switches({ event_published: true });
    const { id } = await event({ title: `Before ${(counter += 1)}` });
    const renamed = `Renamed ${counter}`;
    await db.update(events).set({ title: renamed, capacity: 12 }).where(eq(events.id, id));

    expect((await postAnnouncementByHand("event_published", id, db)).ok).toBe(true);

    const [message] = sentFor(renamed);
    expect(message.embeds[0].title).toBe(renamed);
    expect(message.embeds[0].fields).toContainEqual({
      name: "Places",
      value: "12",
      inline: true,
    });
  });

  it("puts the days' start in a starting-soon post, which is the only place it exists", async () => {
    await switches();
    const startsAt = new Date("2027-04-05T19:30:00Z");
    const { id, title } = await event({ dayStarts: [startsAt] });

    expect((await postAnnouncementByHand("event_starting_soon", id, db)).ok).toBe(true);

    const [message] = sentFor(title);
    expect(message.embeds[0].fields).toContainEqual({
      name: "Starts",
      value: stamp(startsAt, "F"),
      inline: true,
    });
  });

  it("says a closing-soon post is for the waitlist when every seat is taken (UC-38 4c)", async () => {
    await switches();
    const closesAt = new Date(NOW.getTime() + 20 * HR);
    const { id, title } = await event({ capacity: 2, accepted: 2, signupClosesAt: closesAt });

    expect((await postAnnouncementByHand("signups_closing_soon", id, db)).ok).toBe(true);

    const [message] = sentFor(title);
    expect(message.embeds[0].description).toBe(
      `Applications close ${stamp(closesAt, "R")}. The event is full, so this is for the waitlist.`
    );
  });

  it("posts the top of the table for an event that counts towards a published season", async () => {
    await switches();
    const seasonId = await season();
    const { id } = await event({ status: "complete", dayStarts: [new Date("2027-05-01T18:00Z")] });
    await counts(seasonId, id);
    await finished(id, ["Ada", "Bo", "Cy"]);

    const result = await postAnnouncementByHand("standings_changed", id, db);

    expect(result.ok).toBe(true);
    const sent = fetchStub.mock.calls
      .map(([, init]) => JSON.parse(String(init.body)) as DiscordMessage)
      .filter((message) => message.embeds[0].footer?.text === "Standings");
    expect(sent).toHaveLength(1);
    expect(sent[0].embeds[0].fields?.map((field) => field.value)).toEqual([
      "Ada — 25",
      "Bo — 18",
      "Cy — 15",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* R-223 / UC-43 2a — a switched-off kind still posts                 */
/* ------------------------------------------------------------------ */

describe("a kind that is switched off (R-223 / UC-43 2a)", () => {
  it("still posts when the button is pressed, and the scheduler still does not", async () => {
    // Every switch off, including this one.
    await switches();
    const startsAt = new Date(NOW.getTime() + 90 * MIN);
    const { id, title } = await event({ dayStarts: [startsAt] });

    // The switch really is off: without this the test passes on an install
    // whose defaults happen to include it.
    expect((await getAnnouncementSettings(db)).event_starting_soon).toBe(false);

    const result = await postAnnouncementByHand("event_starting_soon", id, db);

    expect(result.ok).toBe(true);
    expect(sentFor(title).map((message) => message.embeds[0].footer?.text)).toEqual([
      "Starting soon",
    ]);

    /*
     * And the contrast that makes it a statement about the *switch* rather than
     * about this event: the same event is due for the scheduler right now, and
     * the scheduler posts nothing for it, because `deliver` obeys the switch
     * and this path deliberately does not go through it.
     */
    await db.delete(announcementClaims).where(eq(announcementClaims.eventId, id));
    const went = await postDueAnnouncements(NOW, db);
    expect(went.posted.filter((one) => one.eventId === id)).toEqual([]);
    expect(sentFor(title)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* UC-43 4b, 4c — the claim                                           */
/* ------------------------------------------------------------------ */

describe("the once-per-event claim (UC-43 4b, 4c)", () => {
  it("takes a free claim, so the scheduler does not post the same thing an hour later", async () => {
    /*
     * The criterion most likely to pass vacuously. A test that posts once and
     * finds one claim row also passes when the post never happened, so all
     * three of these are asserted:
     *
     *  1. the post went out — a payload, by footer, for this event;
     *  2. the claim row exists, and is the only one;
     *  3. a scheduled run afterwards posts nothing for this event — **and**
     *     would have posted had the claim not been there, which is the last
     *     line of the test.
     */
    await switches({ event_starting_soon: true });
    const startsAt = new Date(NOW.getTime() + 90 * MIN);
    const { id, title } = await event({ dayStarts: [startsAt] });

    const result = await postAnnouncementByHand("event_starting_soon", id, db);

    expect(result).toMatchObject({ ok: true, claimed: true });
    expect(sentFor(title).map((message) => message.embeds[0].footer?.text)).toEqual([
      "Starting soon",
    ]);
    expect(await claimsFor(id)).toEqual([{ kind: "event_starting_soon" }]);

    // The scheduler, awake inside the window this event is due in.
    const first = await postDueAnnouncements(NOW, db);
    expect(first.posted.filter((one) => one.eventId === id)).toEqual([]);
    expect(sentFor(title)).toHaveLength(1);

    /*
     * And the claim is why. Without this, every assertion above is satisfied by
     * an event the scheduler was never going to post for — which is exactly
     * the shape of the vacuous pass.
     */
    await db.delete(announcementClaims).where(eq(announcementClaims.eventId, id));
    const second = await postDueAnnouncements(NOW, db);
    expect(second.posted.filter((one) => one.eventId === id)).toEqual([
      { kind: "event_starting_soon", eventId: id },
    ]);
    expect(sentFor(title)).toHaveLength(2);
  });

  it("posts without writing a second row when the claim is already taken (UC-43 4b)", async () => {
    await switches({ event_published: true });
    const { id, title } = await event();
    // Somebody — the scheduler, or an earlier press — already holds it.
    await db
      .insert(announcementClaims)
      .values({ kind: "event_published", eventId: id, claimedAt: new Date("2026-10-01T09:00Z") });

    const result = await postAnnouncementByHand("event_published", id, db);

    // The post still goes out (3a has confirmed it by this point)…
    expect(result).toMatchObject({ ok: true, claimed: false });
    expect(sentFor(title).map((message) => message.embeds[0].footer?.text)).toEqual(["New event"]);
    // …and there is still one claim row, with its original instant untouched.
    expect(await claimsFor(id)).toEqual([{ kind: "event_published" }]);
    expect(await announcementPostedAt("event_published", id, db)).toEqual(
      new Date("2026-10-01T09:00Z")
    );
  });

  it("reads back when a kind went out, which is what the warning says (R-222 / UC-43 3a)", async () => {
    await switches();
    const { id } = await event();
    expect(await announcementPostedAt("signups_open", id, db)).toBeNull();

    const before = new Date();
    expect((await postAnnouncementByHand("signups_open", id, db)).ok).toBe(true);

    const postedAt = await announcementPostedAt("signups_open", id, db);
    expect(postedAt).not.toBeNull();
    expect(postedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    // And it is this kind's instant, not any kind's.
    expect(await announcementPostedAt("event_published", id, db)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The refusals (UC-43 3b, 4a)                                        */
/* ------------------------------------------------------------------ */

describe("a message that cannot be built honestly (UC-43 4a)", () => {
  it("refuses starting-soon for an event with no dated day, and posts nothing", async () => {
    await switches({ event_starting_soon: true });
    const { id } = await event({ dayStarts: [] });

    const result = await postAnnouncementByHand("event_starting_soon", id, db);

    expect(result).toEqual({ ok: false, error: MANUAL_REFUSALS.noDatedDay });
    // Named, rather than a message whose only content is "a time still to be
    // confirmed" — which is the placeholder `{starts}` declares for exactly
    // this case, and is a true sentence about nothing.
    expect(result).toEqual({
      ok: false,
      error:
        "This event has no dated day, so there is no start time to announce. " +
        "Give it a day on the Days tab first.",
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await claimsFor(id)).toEqual([]);
  });

  it("refuses closing-soon for an event with no closing time, and posts nothing", async () => {
    await switches({ signups_closing_soon: true });
    const { id } = await event({ signupClosesAt: null });

    const result = await postAnnouncementByHand("signups_closing_soon", id, db);

    expect(result).toEqual({
      ok: false,
      error:
        "This event has no closing time, so there is nothing to count down to. " +
        "Set one on the Setup tab first.",
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await claimsFor(id)).toEqual([]);
  });

  it("refuses standings for an event in no championship", async () => {
    await switches({ standings_changed: true });
    const { id } = await event();

    expect(await postAnnouncementByHand("standings_changed", id, db)).toEqual({
      ok: false,
      error: "This event counts towards no championship, so there is no table to announce.",
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("refuses standings while the season is still hidden, rather than publishing it to a channel", async () => {
    await switches({ standings_changed: true });
    const seasonId = await season("hidden");
    const { id } = await event({ status: "complete", dayStarts: [new Date("2027-06-01T18:00Z")] });
    await counts(seasonId, id);
    await finished(id, ["Ada", "Bo"]);

    expect(await postAnnouncementByHand("standings_changed", id, db)).toEqual({
      ok: false,
      error: MANUAL_REFUSALS.seasonNotPublished,
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("refuses standings for a counting event with no finishing order yet", async () => {
    await switches({ standings_changed: true });
    const seasonId = await season();
    const { id } = await event({ status: "complete", dayStarts: [new Date("2027-07-01T18:00Z")] });
    await counts(seasonId, id);

    expect(await postAnnouncementByHand("standings_changed", id, db)).toEqual({
      ok: false,
      error: MANUAL_REFUSALS.noFinishingOrder,
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("refuses an event that is no longer there", async () => {
    await switches();
    expect(
      await postAnnouncementByHand(
        "event_published",
        "11111111-1111-1111-1111-111111111111",
        db
      )
    ).toEqual({ ok: false, error: "That event no longer exists." });
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("no webhook (UC-43 3b)", () => {
  it("refuses, says so, posts nothing and claims nothing", async () => {
    await switches({ event_published: true });
    await setIntegrationSetting(SETTING_KEYS.webhookUrl, null, db);
    const { id } = await event();

    const result = await postAnnouncementByHand("event_published", id, db);

    expect(result).toEqual({
      ok: false,
      error:
        "No Discord webhook is configured, so nothing would be posted. " +
        "Set one on the Settings screen first.",
    });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await claimsFor(id)).toEqual([]);
    /*
     * And nothing is logged as failed either. An install with no webhook is an
     * inert feature, not a broken one — the same bargain `deliver` strikes.
     */
    expect(await auditFor(id)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-43 5a — Discord refuses the post                                */
/* ------------------------------------------------------------------ */

describe("a post Discord refuses (UC-43 5a)", () => {
  it("is audited against the event exactly as an automatic one is, and is not reported as success", async () => {
    await switches({ event_published: true });
    const { id } = await event();
    fetchStub.mockResolvedValue(new Response(null, { status: 500 }));

    const result = await postAnnouncementByHand("event_published", id, db);

    // Not success, and the sentence says what happened rather than implying it.
    expect(result).toEqual({
      ok: false,
      error:
        "Discord refused the post: Discord answered 500. " +
        "Nothing reached the channel, and the failure is in the audit log.",
    });

    // The same action, against the same event, as a scheduled failure writes.
    const rows = await auditFor(id);
    expect(rows.map((row) => row.action)).toEqual(["announcement.failed"]);
    expect(rows[0].summary).toBe(
      'The "event_published" announcement did not go out — Discord answered 500.'
    );
    expect(rows[0].detail).toMatchObject({ kind: "event_published", status: 500 });
    expect(rows[0].event?.id).toBe(id);
  });

  it("leaves the claim free, so the scheduler can still post what the channel never got", async () => {
    /*
     * The one place this path differs from the scheduler's on purpose. The
     * scheduler claims before posting and never retries a burnt claim; here the
     * claim is taken only once Discord has accepted the post, because the case
     * this feature exists for is Discord having eaten the first one.
     */
    await switches({ event_starting_soon: true });
    const { id, title } = await event({ dayStarts: [new Date(NOW.getTime() + 90 * MIN)] });
    fetchStub.mockResolvedValue(new Response(null, { status: 404 }));

    expect((await postAnnouncementByHand("event_starting_soon", id, db)).ok).toBe(false);
    expect(await claimsFor(id)).toEqual([]);

    // And the scheduler, next time it wakes, still posts it.
    fetchStub.mockResolvedValue(new Response(null, { status: 204 }));
    const went = await postDueAnnouncements(NOW, db);
    expect(went.posted.filter((one) => one.eventId === id)).toEqual([
      { kind: "event_starting_soon", eventId: id },
    ]);
    /*
     * Two requests for this event: the one Discord refused, and the one it
     * took. `sentFor` counts attempts rather than deliveries, which is what
     * makes the pair the right number here — a single attempt would mean the
     * scheduler had been locked out by a claim that should not exist.
     */
    expect(sentFor(title)).toHaveLength(2);
    expect(await claimsFor(id)).toEqual([{ kind: "event_starting_soon" }]);
  });

  it("reports a request that never completed, without claiming anything", async () => {
    await switches();
    const { id } = await event();
    fetchStub.mockRejectedValue(new Error("The network is down"));

    expect(await postAnnouncementByHand("event_published", id, db)).toEqual({
      ok: false,
      error:
        "Discord refused the post: The network is down " +
        "Nothing reached the channel, and the failure is in the audit log.",
    });
    expect(await claimsFor(id)).toEqual([]);
    expect((await auditFor(id)).map((row) => row.action)).toEqual(["announcement.failed"]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-43 2, 2a, 2b — what the panel is told                           */
/* ------------------------------------------------------------------ */

describe("the panel the Publish tab renders (UC-43 2)", () => {
  it("lists the four kinds for an event in no championship, with their switches", async () => {
    await switches({ event_published: true, signups_closing_soon: true });
    const { id } = await event({
      signupClosesAt: new Date("2027-08-01T18:00Z"),
      dayStarts: [new Date("2027-08-02T18:00Z")],
    });

    const panel = await manualAnnouncementPanel(id, db);

    expect(panel.webhook).toBe(true);
    // The whole list, in order: `standings_changed` is absent (UC-43 2b).
    expect(panel.rows.map((row) => row.kind)).toEqual([
      "event_published",
      "signups_open",
      "signups_closing_soon",
      "event_starting_soon",
    ]);
    // On, off, on, off — the switches as stored, not all one value.
    expect(panel.rows.map((row) => row.enabled)).toEqual([true, false, true, false]);
    expect(panel.rows.map((row) => row.refusal)).toEqual([null, null, null, null]);
    expect(panel.rows.map((row) => row.postedAt)).toEqual([null, null, null, null]);
    expect(panel.rows.map((row) => row.name)).toEqual([
      "New event",
      "Applications open",
      "Closing soon",
      "Starting soon",
    ]);
  });

  it("offers standings once the event counts towards a season (UC-43 2b)", async () => {
    await switches();
    const seasonId = await season();
    const { id } = await event({ status: "complete", dayStarts: [new Date("2027-09-01T18:00Z")] });
    await counts(seasonId, id);

    const panel = await manualAnnouncementPanel(id, db);

    expect(panel.rows.map((row) => row.kind)).toEqual([
      "event_published",
      "signups_open",
      "signups_closing_soon",
      "event_starting_soon",
      "standings_changed",
    ]);
    expect(panel.rows.at(-1)?.refusal).toBeNull();
  });

  it("carries the refusal for each kind whose message could not be built", async () => {
    await switches();
    // No dated day and no closing time: two of the four are refused and two
    // are not, so neither "all refused" nor "none refused" passes.
    const { id } = await event({ signupClosesAt: null, dayStarts: [] });

    const panel = await manualAnnouncementPanel(id, db);

    expect(panel.rows.map((row) => [row.kind, row.refusal])).toEqual([
      ["event_published", null],
      ["signups_open", null],
      ["signups_closing_soon", MANUAL_REFUSALS.noClosingTime],
      ["event_starting_soon", MANUAL_REFUSALS.noDatedDay],
    ]);
  });

  it("says when a kind went out, from the claim row", async () => {
    await switches();
    const { id } = await event();
    const went = new Date("2026-09-09T19:15:00.000Z");
    await db
      .insert(announcementClaims)
      .values({ kind: "event_published", eventId: id, claimedAt: went });

    const panel = await manualAnnouncementPanel(id, db);

    expect(panel.rows.find((row) => row.kind === "event_published")?.postedAt).toEqual(went);
    // And only that one.
    expect(panel.rows.filter((row) => row.postedAt !== null)).toHaveLength(1);
  });

  it("says there is nowhere to post when no webhook is configured (UC-43 3b)", async () => {
    await switches();
    await setIntegrationSetting(SETTING_KEYS.webhookUrl, null, db);
    const { id } = await event();

    const panel = await manualAnnouncementPanel(id, db);

    expect(panel.webhook).toBe(false);
    // Still offered, so the screen can explain rather than show an empty panel.
    expect(panel.rows).toHaveLength(4);
  });
});

/* ------------------------------------------------------------------ */
/* Nothing here is deferred                                           */
/* ------------------------------------------------------------------ */

describe("the by-hand path is awaited, unlike the five announcers", () => {
  it("has finished posting by the time it returns, with nothing left in after()", async () => {
    await switches();
    const { id, title } = await event();

    const result = await postAnnouncementByHand("event_published", id, db);

    // The report is the return value, so the request must already have been
    // made — not handed to `after()` like every other announcer in the module.
    expect(result.ok).toBe(true);
    expect(sentFor(title)).toHaveLength(1);
    expect(state.jobs).toEqual([]);
  });
});
