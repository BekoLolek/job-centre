import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  type Database,
  SETTING_KEYS,
  applications,
  auditLog,
  eventHosts,
  events,
} from "@/db";
import { type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";
import type { AnnouncementSettings } from "@/lib/announce";
import type { Power } from "@/lib/permissions-policy";

/*
 * `/admin/events`' actions, asked by members who hold powers (Task 126,
 * R-261 / UC-56).
 *
 * The actions run for real against an in-memory Postgres, mocked exactly as
 * `host-scope.test.ts` and `announce-by-hand.test.ts` mock them: the session
 * cookie, the page cache, `after()`, and a `fetch` stub for the one
 * announcement path that is awaited.
 *
 * "Can do nothing else in the file" is asked of **every export the module
 * has**, not of a few picked ones: `CALLS` names a call for each, and the first
 * test fails the day the module exports something `CALLS` does not list.
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
  // `/admin/settings/actions.ts` imports these; nothing here gets far enough to call them.
  getGateConfig: async () => {
    throw new Error("not used here");
  },
  setGateConfig: async () => {
    throw new Error("not used here");
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: () => {} }));

const actions = await import("../actions");
const settingsActions = await import("../../settings/actions");
const { grantPower } = await import("@/lib/permissions");
const { canManageEvent } = await import("@/lib/hosting");
const { setAnnouncementSettings, setIntegrationSetting } = await import("@/lib/discord");
const { defaultAnnouncementSettings } = await import("@/lib/announce");

let handle: TestDatabase;
let db: Database;
let counter = 0;

/** Who is asking. Each holds exactly the powers the name says, and hosts nothing. */
const HOLDERS = {
  "events.create": ["events.create"],
  "events.manage": ["events.manage"],
  "announce.post": ["announce.post"],
  "hosts.approve": ["hosts.approve"],
  "no power at all": [],
} as const satisfies Record<string, readonly Power[]>;
type HolderName = keyof typeof HOLDERS;

const ids = {} as Record<HolderName, string>;
/** A published event nobody hosts, and one application to it. */
let target: { eventId: string; applicationId: string };

async function anEvent(): Promise<{ id: string; title: string }> {
  counter += 1;
  const title = `Powers ${counter}`;
  const [row] = await db
    .insert(events)
    .values({
      slug: `powers-${counter}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      status: "published",
    })
    .returning({ id: events.id });
  return { id: row.id, title };
}

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;

  const granter = await makeUser(db, { displayName: "The admin who granted" });
  for (const name of Object.keys(HOLDERS) as HolderName[]) {
    ids[name] = await makeUser(db, { displayName: `Holder of ${name}` });
    for (const power of HOLDERS[name]) {
      await grantPower({ userId: ids[name], power, grantedByUserId: granter }, db);
    }
  }

  const event = await anEvent();
  const applicant = await makeUser(db);
  const [application] = await db
    .insert(applications)
    .values({ eventId: event.id, userId: applicant, status: "waitlisted" })
    .returning({ id: applications.id });
  target = { eventId: event.id, applicationId: application.id };
});

afterAll(async () => {
  await handle.close();
});

const fetchStub = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

beforeEach(async () => {
  state.userId = null;
  await setIntegrationSetting(SETTING_KEYS.webhookUrl, "https://discord.test/api/webhooks/1/t");
  vi.stubEnv("DISCORD_WEBHOOK_URL", "");
  vi.stubGlobal("fetch", fetchStub);
  fetchStub.mockResolvedValue(new Response(null, { status: 204 }));
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

function as(holder: HolderName): string {
  state.userId = ids[holder];
  return ids[holder];
}

/** How many audit lines and events there are - what a refused call must not move. */
async function written(): Promise<{ audit: number; events: number }> {
  const [lines, rows] = await Promise.all([
    db.select({ id: auditLog.id }).from(auditLog),
    db.select({ id: events.id }).from(events),
  ]);
  return { audit: lines.length, events: rows.length };
}

async function linesFor(eventId: string, action: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.eventId, eventId), eq(auditLog.action, action)));
}

/* ------------------------------------------------------------------ */
/* The file's whole exported surface                                  */
/* ------------------------------------------------------------------ */

/**
 * One call per export of `../actions`, aimed at an event nobody here hosts and
 * at an application to it - real rows, so a child-keyed action is refused for
 * who is asking and not for an id that resolves to nothing.
 */
const CALLS: Record<string, () => Promise<unknown>> = {
  createEventAction: () => actions.createEventAction({ title: "Not theirs to create" }),
  saveBasicsAction: () =>
    actions.saveBasicsAction(target.eventId, {
      title: "Renamed",
      slug: "renamed",
      type: "tournament",
      description: null,
      bannerUrl: null,
      gameId: null,
      capacity: null,
      entryMode: "first_come",
      waitlist: true,
      signupOpensAt: null,
      signupClosesAt: null,
    }),
  setEventStatusAction: () => actions.setEventStatusAction(target.eventId, "published", "cancelled"),
  publishEventAction: () => actions.publishEventAction(target.eventId),
  postAnnouncementByHandAction: () =>
    actions.postAnnouncementByHandAction(target.eventId, "event_published"),
  previewEventDaysAction: () => actions.previewEventDaysAction(target.eventId, []),
  saveEventDaysAction: () => actions.saveEventDaysAction(target.eventId, []),
  saveEventQuestionsAction: () => actions.saveEventQuestionsAction(target.eventId, []),
  saveEntryRulesAction: () =>
    actions.saveEntryRulesAction(target.eventId, { minRankToEnter: null, minRankToCaptain: null }),
  saveEventShapeAction: () =>
    actions.saveEventShapeAction(target.eventId, {
      teamEvent: true,
      draft: false,
      mode: "teams",
      value: 2,
    }),
  saveRoundScoringAction: () =>
    actions.saveRoundScoringAction(target.eventId, {
      rounds: [{ name: null }],
      lowWins: false,
      bonuses: [],
    }),
  clearRoundScoringAction: () => actions.clearRoundScoringAction(target.eventId, { confirmed: true }),
  saveRoundAction: () =>
    actions.saveRoundAction(target.eventId, { roundIndex: 1, entries: [], expected: [] }),
  addEventToChampionshipAction: () =>
    actions.addEventToChampionshipAction(target.eventId, "00000000-0000-4000-8000-000000000000"),
  saveEventChampionshipAction: () => actions.saveEventChampionshipAction(target.eventId, { weight: 2 }),
  removeEventFromChampionshipAction: () => actions.removeEventFromChampionshipAction(target.eventId),
  saveEventPlacementsAction: () => actions.saveEventPlacementsAction(target.eventId, []),
  decideApplicationAction: () => actions.decideApplicationAction(target.applicationId, "accepted", {}),
  saveApplicationNoteAction: () => actions.saveApplicationNoteAction(target.applicationId, "A note"),
  setApplicantAvailabilityAction: () => actions.setApplicantAvailabilityAction(target.applicationId, {}),
};

/**
 * What each holder's power lets them call here. Everything else in the file
 * must refuse them.
 *
 * No row for a member with no power at all: no guard asks about the *absence*
 * of a power, so anything that let such a member in would let these three in
 * as well, and their rows already fail.
 */
const REACHES: Record<Exclude<HolderName, "events.manage" | "no power at all">, readonly string[]> = {
  "events.create": ["createEventAction"],
  "announce.post": ["postAnnouncementByHandAction"],
  "hosts.approve": [],
};

const REFUSALS = (Object.keys(REACHES) as (keyof typeof REACHES)[]).flatMap((holder) =>
  Object.keys(CALLS)
    .filter((action) => !REACHES[holder].includes(action))
    .map((action) => [holder, action] as const)
);

describe("the whole of /admin/events/actions.ts, asked by somebody whose power does not reach it", () => {
  it("has a call here for every action the file exports", () => {
    expect(Object.keys(CALLS).sort()).toEqual(Object.keys(actions).sort());
  });

  it.each(REFUSALS)("turns the holder of %s away from %s, and writes nothing", async (holder, action) => {
    as(holder);
    const before = await written();

    await expect(CALLS[action]()).rejects.toThrow(/NEXT_REDIRECT/);

    expect(await written()).toEqual(before);
  });
});

/* ------------------------------------------------------------------ */
/* events.create                                                      */
/* ------------------------------------------------------------------ */

describe("events.create", () => {
  it("creates an event, and the audit line names the holder", async () => {
    const holder = as("events.create");

    const result = await actions.createEventAction({ title: "A holder's first event" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [row] = await db.select().from(events).where(eq(events.id, result.data.id));
    expect(row.title).toBe("A holder's first event");
    const lines = await linesFor(result.data.id, "event.created");
    expect(lines.map((line) => [line.actorUserId, line.actorName])).toEqual([
      [holder, "Holder of events.create"],
    ]);
  });

  it("is not what events.manage gives: managing every event creates none", async () => {
    as("events.manage");
    const before = await written();

    await expect(actions.createEventAction({ title: "Not theirs to create" })).rejects.toThrow(
      /NEXT_REDIRECT/
    );

    expect(await written()).toEqual(before);
  });
});

/* ------------------------------------------------------------------ */
/* events.manage                                                      */
/* ------------------------------------------------------------------ */

describe("events.manage", () => {
  it("manages an event the holder does not host, and the audit line names them", async () => {
    const holder = as("events.manage");
    const event = await anEvent();

    const result = await actions.saveEntryRulesAction(event.id, {
      minRankToEnter: null,
      minRankToCaptain: null,
    });

    expect(result).toEqual({ ok: true, data: null });
    expect(await db.select().from(eventHosts).where(eq(eventHosts.userId, holder))).toEqual([]);
    expect((await linesFor(event.id, "event.entryRules")).map((line) => line.actorUserId)).toEqual([
      holder,
    ]);
  });

  it("reaches an application to an event the holder does not host", async () => {
    as("events.manage");

    const result = await actions.saveApplicationNoteAction(target.applicationId, "Might be late");

    expect(result).toEqual({ ok: true, data: null });
  });

  it("is the third answer canManageEvent gives, beside the admin and the host", async () => {
    const event = await anEvent();

    const answers = {
      holder: await canManageEvent({ id: ids["events.manage"], isAdmin: false }, event.id, db),
      otherPower: await canManageEvent({ id: ids["events.create"], isAdmin: false }, event.id, db),
      member: await canManageEvent({ id: ids["no power at all"], isAdmin: false }, event.id, db),
    };

    expect(answers).toEqual({ holder: true, otherPower: false, member: false });
  });

  it("leaves a host managing theirs, and only theirs", async () => {
    const mine = await anEvent();
    const host = await makeUser(db, { displayName: "A host with no powers" });
    await makeHost(db, mine.id, host);
    state.userId = host;

    const own = await actions.saveEntryRulesAction(mine.id, {
      minRankToEnter: null,
      minRankToCaptain: null,
    });
    const foreign = actions.saveEntryRulesAction(target.eventId, {
      minRankToEnter: null,
      minRankToCaptain: null,
    });

    expect(own).toEqual({ ok: true, data: null });
    await expect(foreign).rejects.toThrow(/NEXT_REDIRECT/);
    expect((await linesFor(mine.id, "event.entryRules")).map((line) => line.actorUserId)).toEqual([
      host,
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* announce.post                                                      */
/* ------------------------------------------------------------------ */

describe("announce.post", () => {
  it("posts by hand on an event the holder neither hosts nor manages, and the audit line names them", async () => {
    const holder = as("announce.post");
    const event = await anEvent();

    const result = await actions.postAnnouncementByHandAction(event.id, "event_published");

    expect(result).toEqual({ outcome: "posted", name: "New event", claimed: true });
    expect(await canManageEvent({ id: holder, isAdmin: false }, event.id, db)).toBe(false);
    const lines = await linesFor(event.id, "announcement.posted_by_hand");
    expect(lines.map((line) => [line.actorUserId, line.summary])).toEqual([
      [
        holder,
        `Holder of announce.post posted the “New event” announcement for “${event.title}” by hand.`,
      ],
    ]);
  });

  it("still lets a manager post, who holds no such power", async () => {
    as("events.manage");
    const event = await anEvent();

    const result = await actions.postAnnouncementByHandAction(event.id, "event_published");

    expect(result).toMatchObject({ outcome: "posted" });
  });

  it("is not a host's: hosting one event posts nothing on another", async () => {
    const mine = await anEvent();
    const event = await anEvent();
    const host = await makeUser(db);
    await makeHost(db, mine.id, host);
    state.userId = host;

    await expect(
      actions.postAnnouncementByHandAction(event.id, "event_published")
    ).rejects.toThrow(/NEXT_REDIRECT/);

    expect(fetchStub).not.toHaveBeenCalled();
    expect(await linesFor(event.id, "announcement.posted_by_hand")).toEqual([]);
  });

  /*
   * What an announcement says comes from two places: the event, which the
   * surface table above already refuses this holder, and the wording and
   * switches on `/admin/settings`. Every export of that module, for the same
   * reason every export of this one.
   */
  it.each(Object.keys(settingsActions))(
    "cannot change what an announcement says through %s",
    async (name) => {
      as("announce.post");
      const before = await written();
      const action = settingsActions[name as keyof typeof settingsActions] as (
        input: unknown
      ) => Promise<unknown>;

      await expect(action({})).rejects.toThrow(/NEXT_REDIRECT/);

      expect(await written()).toEqual(before);
    }
  );
});
