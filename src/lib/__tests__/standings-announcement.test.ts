import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  type ChampionshipStatusValue,
  type Database,
  SETTING_KEYS,
  applications,
  championships,
  events,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import type { AnnouncementSettings, DiscordMessage } from "@/lib/announce";
import { type TopRow, topOfTheTable } from "@/lib/championship-policy";

/*
 * UC-36 3 and 3a — the new top of the table in the Discord channel.
 *
 * The same harness `discord.test.ts` uses, and for the same three reasons:
 * `@/db`'s `db` is this file's database because `deliver` reads the webhook
 * and writes its failure row through the default handle; `after()` collects
 * the deferred work so a test awaits the job it started; and `fetch` is a stub,
 * so nothing here can reach Discord.
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

const { announceStandings, setAnnouncementSettings, setIntegrationSetting } = await import(
  "@/lib/discord"
);
const { defaultAnnouncementSettings } = await import("@/lib/announce");
const { listAudit } = await import("@/lib/audit");
const { addCountingEvent, createChampionship } = await import("@/lib/championships");
const { setPlacements } = await import("@/lib/championship-results");

/**
 * The webhook every test is configured with.
 *
 * The token half is a word no other string in this file contains, which is
 * what lets "the audit row does not carry the credential" be a real assertion
 * rather than a shape check.
 */
const WEBHOOK = "https://discord.test/api/webhooks/1/supersecretwebhooktoken";

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
  // Configured on the settings screen only — the environment says nothing.
  await setIntegrationSetting(SETTING_KEYS.webhookUrl, WEBHOOK);
  vi.stubEnv("DISCORD_WEBHOOK_URL", "");
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
async function switches(on: Partial<AnnouncementSettings>) {
  const off = Object.fromEntries(
    Object.keys(defaultAnnouncementSettings()).map((kind) => [kind, false])
  ) as AnnouncementSettings;
  await setAnnouncementSettings({ ...off, ...on });
}

async function season(status: ChampionshipStatusValue = "published"): Promise<string> {
  counter += 1;
  const made = await createChampionship({ name: `Cup ${counter}` }, db);
  if (!made.ok) throw new Error(made.error);
  if (status !== "hidden") {
    await db.update(championships).set({ status }).where(eq(championships.id, made.data.id));
  }
  return made.data.id;
}

async function night(seasonId: string, title: string, startsAt: Date): Promise<string> {
  counter += 1;
  const [row] = await db
    .insert(events)
    .values({ slug: `told-${counter}`, title, status: "complete", startsAt })
    .returning({ id: events.id });
  const added = await addCountingEvent(seasonId, row.id, db);
  if (!added.ok) throw new Error(added.error);
  return row.id;
}

async function accepted(eventId: string, displayName: string): Promise<string> {
  const userId = await makeUser(db, { displayName });
  await db.insert(applications).values({ eventId, userId, status: "accepted" });
  return userId;
}

async function finished(eventId: string, order: string[]): Promise<void> {
  const saved = await setPlacements(
    eventId,
    order.map((id, index) => ({ id, position: index + 1 })),
    db
  );
  if (!saved.ok) throw new Error(saved.error);
}

/** Announce, and wait for the job it deferred. */
async function announced(eventId: string): Promise<void> {
  announceStandings(eventId);
  await Promise.all(state.jobs);
  state.jobs = [];
}

function posted(): DiscordMessage[] {
  return fetchStub.mock.calls.map(([, init]) => JSON.parse(String(init.body)) as DiscordMessage);
}

/* ------------------------------------------------------------------ */
/* UC-36 3 — the new top of the table                                 */
/* ------------------------------------------------------------------ */

describe("the standings announcement", () => {
  it("posts the top three and who leads, once the switch is on", async () => {
    await switches({ standings_changed: true });
    const seasonId = await season();
    const eventId = await night(seasonId, "Opening night", new Date("2027-01-01T18:00:00Z"));
    const first = await accepted(eventId, "Ada");
    const second = await accepted(eventId, "Bo");
    const third = await accepted(eventId, "Cy");
    const fourth = await accepted(eventId, "Di");
    await finished(eventId, [first, second, third, fourth]);

    await announced(eventId);

    const [message] = posted();
    expect(message.embeds[0].footer?.text).toBe("Standings");
    // The first night of a season: nobody took the lead from anybody.
    expect(message.embeds[0].description).toContain("The first standings are in");
    expect(message.embeds[0].description).toContain("**Ada**");
    expect(message.embeds[0].fields?.map((field) => field.name)).toEqual(["1st", "2nd", "3rd"]);
    expect(message.embeds[0].fields?.map((field) => field.value)).toEqual([
      "Ada — 25",
      "Bo — 18",
      "Cy — 15",
    ]);
    // Never pings anybody, whatever a display name says.
    expect(message.allowed_mentions).toEqual({ parse: [] });
  });

  it("says who took the lead at the night just scored", async () => {
    await switches({ standings_changed: true });
    const seasonId = await season();
    const one = await night(seasonId, "Night one", new Date("2027-02-01T18:00:00Z"));
    const two = await night(seasonId, "Night two", new Date("2027-02-08T18:00:00Z"));
    const ada = await accepted(one, "Ada");
    const bo = await accepted(one, "Bo");
    const cy = await accepted(one, "Cy");
    for (const userId of [ada, bo, cy]) {
      await db.insert(applications).values({ eventId: two, userId, status: "accepted" });
    }

    await finished(one, [ada, bo, cy]);
    await finished(two, [bo, cy, ada]);
    await announced(two);

    // 18 + 25 = 43 to Ada's 25 + 15 = 40, so the lead changed hands at the
    // night just scored — which is the one thing this message is for.
    expect(posted()[0].embeds[0].description).toContain("**Bo** takes the lead");
  });

  it("puts both names in the sentence when the top is shared", async () => {
    await switches({ standings_changed: true });
    const seasonId = await season();
    const one = await night(seasonId, "Level one", new Date("2027-02-15T18:00:00Z"));
    const two = await night(seasonId, "Level two", new Date("2027-02-22T18:00:00Z"));
    const ada = await accepted(one, "Ada");
    const bo = await accepted(one, "Bo");
    for (const userId of [ada, bo]) {
      await db.insert(applications).values({ eventId: two, userId, status: "accepted" });
    }

    await finished(one, [ada, bo]);
    // A first and a second each: level on points, level on countback, and the
    // standings show them level rather than picking one (R-181).
    await finished(two, [bo, ada]);
    await announced(two);

    const embed = posted()[0].embeds[0];
    expect(embed.description).toContain("**Ada** and **Bo**");
    expect(embed.fields?.map((field) => field.name)).toEqual(["=1st", "=1st"]);
  });

  it("claims nothing about the lead when an older night is recorded late", async () => {
    await switches({ standings_changed: true });
    const seasonId = await season();
    const early = await night(seasonId, "The early one", new Date("2027-03-01T18:00:00Z"));
    const late = await night(seasonId, "The late one", new Date("2027-03-08T18:00:00Z"));
    const ada = await accepted(early, "Ada");
    const bo = await accepted(early, "Bo");
    await db.insert(applications).values({ eventId: late, userId: ada, status: "accepted" });
    await db.insert(applications).values({ eventId: late, userId: bo, status: "accepted" });

    // The later night is scored first; the March result arrives afterwards.
    await finished(late, [bo, ada]);
    await finished(early, [ada, bo]);
    await announced(early);

    /*
     * The movement figures are measured at the last night *played*, which is
     * not the night just scored — so the message says where the table stands
     * and does not say who took what from whom.
     */
    const description = posted()[0].embeds[0].description ?? "";
    expect(description).toContain("The table has moved after **The early one**");
    expect(description).not.toContain("takes the lead");
    expect(description).not.toContain("stays top");
  });
});

/* ------------------------------------------------------------------ */
/* UC-36 3a — the switch, the webhook, and the seasons it refuses     */
/* ------------------------------------------------------------------ */

describe("what is not announced", () => {
  it("posts nothing until an admin asks for it", async () => {
    // The default, untouched. A deploy must not start posting something
    // nobody switched on.
    await setAnnouncementSettings(defaultAnnouncementSettings());
    const seasonId = await season();
    const eventId = await night(seasonId, "Default night", new Date("2027-04-01T18:00:00Z"));
    const player = await accepted(eventId, "Ada");
    await finished(eventId, [player]);

    await announced(eventId);

    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("posts nothing while its switch is off, even with every other one on", async () => {
    await switches({
      event_published: true,
      application_accepted: true,
      draft_lot_sold: true,
      match_result: true,
      standings_changed: false,
    });
    const seasonId = await season();
    const eventId = await night(seasonId, "Muted night", new Date("2027-05-01T18:00:00Z"));
    const player = await accepted(eventId, "Ada");
    await finished(eventId, [player]);

    await announced(eventId);

    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("posts nothing and logs nothing with no channel configured", async () => {
    await setIntegrationSetting(SETTING_KEYS.webhookUrl, null);
    await switches({ standings_changed: true });
    const seasonId = await season();
    const eventId = await night(seasonId, "No channel night", new Date("2027-06-01T18:00:00Z"));
    const player = await accepted(eventId, "Ada");
    await finished(eventId, [player]);

    await announced(eventId);

    expect(fetchStub).not.toHaveBeenCalled();
    expect(
      (await listAudit({ eventId }, db)).filter((row) => row.action === "announcement.failed")
    ).toEqual([]);
  });

  it("posts nothing about a hidden season (R-189)", async () => {
    await switches({ standings_changed: true });
    const seasonId = await season("hidden");
    const eventId = await night(seasonId, "Draft season night", new Date("2027-07-01T18:00:00Z"));
    const player = await accepted(eventId, "Ada");
    await finished(eventId, [player]);

    await announced(eventId);

    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("posts nothing when the order has been cleared", async () => {
    await switches({ standings_changed: true });
    const seasonId = await season();
    const eventId = await night(seasonId, "Cleared night", new Date("2027-08-01T18:00:00Z"));
    const player = await accepted(eventId, "Ada");
    await finished(eventId, []);

    await announced(eventId);

    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("posts nothing about an event that counts towards nothing", async () => {
    await switches({ standings_changed: true });
    counter += 1;
    const [row] = await db
      .insert(events)
      .values({ slug: `plain-${counter}`, title: "Just an event", status: "complete" })
      .returning({ id: events.id });

    await announced(row.id);

    expect(fetchStub).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* A refusal, and what the log may say about it                       */
/* ------------------------------------------------------------------ */

describe("a post Discord refuses", () => {
  it("is logged under the event, with the reason and never the webhook", async () => {
    await switches({ standings_changed: true });
    fetchStub.mockResolvedValue(new Response(null, { status: 404 }));
    const seasonId = await season();
    const eventId = await night(seasonId, "Refused night", new Date("2027-09-01T18:00:00Z"));
    const player = await accepted(eventId, "Ada");
    await finished(eventId, [player]);

    await announced(eventId);

    const failures = (await listAudit({ eventId }, db)).filter(
      (row) => row.action === "announcement.failed"
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].summary).toContain("404");

    /*
     * The standing constraint: the webhook URL is the whole credential, and a
     * failure row is read on `/admin/audit` by anybody with the rights to look
     * at it. The token must not be in the row in any form.
     */
    const written = JSON.stringify(failures[0]);
    expect(written).not.toContain("supersecretwebhooktoken");
    expect(written).not.toContain("discord.test");
  });
});

/* ------------------------------------------------------------------ */
/* The decision itself (pure)                                         */
/* ------------------------------------------------------------------ */

describe("topOfTheTable", () => {
  function row(over: Partial<TopRow> & { position: number }): TopRow {
    return {
      userId: `user-${over.position}`,
      name: `Player ${over.position}`,
      points: 0,
      level: false,
      moved: 0,
      ...over,
    };
  }

  it("takes positions rather than rows, so a shared place stays whole", () => {
    const standings = [
      row({ position: 1, level: true }),
      row({ position: 1, level: true }),
      row({ position: 3 }),
      row({ position: 4 }),
    ];

    const top = topOfTheTable(standings, { movement: "here" });

    expect(top.rows.map((entry) => entry.position)).toEqual([1, 1, 3]);
  });

  it("calls the first standings of a season first, not a lead change", () => {
    // Everybody's `moved` is null on the first night, which is the same value
    // a newcomer carries — and the two mean entirely different things.
    const standings = [row({ position: 1, moved: null }), row({ position: 2, moved: null })];

    expect(topOfTheTable(standings, { movement: "none" }).lead).toBe("first");
  });

  it("sees a lead taken by somebody who climbed into it", () => {
    const standings = [row({ position: 1, moved: 2 }), row({ position: 2, moved: -1 })];

    expect(topOfTheTable(standings, { movement: "here" }).lead).toBe("changed");
  });

  it("sees a lead taken by somebody who was not in the standings at all", () => {
    const standings = [row({ position: 1, moved: null }), row({ position: 2, moved: -1 })];

    expect(topOfTheTable(standings, { movement: "here" }).lead).toBe("changed");
  });

  it("sees a lead held, however much moved underneath it", () => {
    const standings = [
      row({ position: 1, moved: 0 }),
      row({ position: 2, moved: 6 }),
      row({ position: 3, moved: -4 }),
    ];

    expect(topOfTheTable(standings, { movement: "here" }).lead).toBe("held");
  });

  it("refuses to say what changed when the figures belong to another night", () => {
    const standings = [row({ position: 1, moved: 3 }), row({ position: 2, moved: -1 })];

    expect(topOfTheTable(standings, { movement: "elsewhere" }).lead).toBe("unknown");
  });
});
