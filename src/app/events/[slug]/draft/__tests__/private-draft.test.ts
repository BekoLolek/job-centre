import { renderToReadableStream } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, auditLog, users } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";
import { openLot, setCaptains, setDraftPool, setTeams } from "@/lib/draft";
import { applyToEvent, createEvent, getEventById, publishEvent, updateEvent } from "@/lib/events";
import { privateDraftFrom } from "@/lib/events-policy";

/*
 * A draft only its captains can watch — R-253 / UC-50.
 *
 * > **2.** System stops serving the draft room, the pool and the lots to
 * > anybody who is not a captain of this event or a manager of it.
 * > **2a.** A member who is not a captain opens the room's URL — turned away
 * > by the page's own guard, told the draft is private rather than shown an
 * > empty room. A hidden link is not an authorisation.
 * > **2b.** A captain of a *different* event — turned away. Captaincy is per
 * > event.
 * > **2c.** Made public again — served to everybody from that moment.
 * > **3a.** A manager who is also a captain — let in, no special case.
 * > **4.** The event's teams and their rosters stay public throughout.
 *
 * Against an in-memory Postgres, with the page, the room, the poll action and
 * the admin action all real; only the session cookie, the page cache and
 * `after()` are replaced, exactly as `host-draft.test.ts` does it. The guard is
 * asserted at **three** doors, because each is reachable on its own: the page
 * (what a URL gets), `loadRoom` (what every payload is built by) and
 * `loadRoomAction` (what the browser polls once a second). A guard on the page
 * alone would serve the whole room to anybody who called the poll directly.
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

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  };
});

const { default: DraftRoomPage } = await import("../page");
const { PRIVATE_DRAFT_TITLE, PRIVATE_DRAFT_SENTENCE } = await import("../PrivateDraft");
const { default: EventPage } = await import("../../page");
const { loadRoomAction } = await import("../actions");
const { loadRoom } = await import("../room");
const { saveDraftConfigAction, saveDraftPrivacyAction } = await import(
  "@/app/admin/events/draft-actions"
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

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

let counter = 0;

type DraftEvent = {
  eventId: string;
  slug: string;
  /** Captain of Alpha. */
  captain: string;
  /** Accepted, in the pool, and nobody's captain. */
  player: string;
  /** Alpha's and Bravo's team names, for the public page. */
  teamNames: string[];
  /** The two captains' display names, as the roster chips print them. */
  captainNames: string[];
};

/** A published event with two captained teams and a seeded pool. */
async function draftEvent(): Promise<DraftEvent> {
  counter += 1;
  const created = unwrap(await createEvent({ ...PUBLISHABLE, title: `Private draft ${counter}` }, db));
  unwrap(await publishEvent(created.id, db));

  const members: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    const userId = await makeUser(db, { displayName: `Private ${counter}-${index}` });
    unwrap(await applyToEvent(created.id, userId, {}, db));
    members.push(userId);
  }

  const written = unwrap(
    await setTeams(created.id, [{ name: `Alpha ${counter}` }, { name: `Bravo ${counter}` }], db)
  );
  const [alpha, bravo] = written.teams;
  unwrap(
    await setCaptains(
      created.id,
      [
        { teamId: alpha.id, userId: members[0] },
        { teamId: bravo.id, userId: members[1] },
      ],
      db
    )
  );
  unwrap(await setDraftPool(created.id, {}, db));

  return {
    eventId: created.id,
    slug: created.slug,
    captain: members[0],
    player: members[2],
    teamNames: [alpha.name, bravo.name],
    captainNames: [`Private ${counter}-0`, `Private ${counter}-1`],
  };
}

async function setPrivate(eventId: string, privateDraft: boolean) {
  unwrap(await updateEvent(eventId, { config: { privateDraft } }, db));
}

async function userRow(userId: string) {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  return row;
}

/** A page's markup as its reader sees it: no tags, no entities. */
async function text(page: Promise<unknown>): Promise<string> {
  const stream = await renderToReadableStream((await page) as React.ReactElement);
  await stream.allReady;
  return (await new Response(stream).text())
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

function room(slug: string) {
  return DraftRoomPage({ params: Promise.resolve({ slug }) });
}

function eventPage(slug: string) {
  return EventPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve({ tab: "teams" }) });
}

let a: DraftEvent;
let b: DraftEvent;
let member: string;
let admin: string;

beforeAll(async () => {
  a = await draftEvent();
  b = await draftEvent();
  member = await makeUser(db);
  admin = await makeUser(db);
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin));
  await setPrivate(a.eventId, true);
});

beforeEach(() => {
  state.userId = null;
});

/* ------------------------------------------------------------------ */
/* The page's own guard (UC-50 2, 2a, 2b, 3, 3a)                      */
/* ------------------------------------------------------------------ */

describe("the room's URL while the draft is private", () => {
  it("turns a signed-in member who is not a captain away, and says the draft is private", async () => {
    state.userId = member;

    const page = await text(room(a.slug));

    expect(page).toContain(PRIVATE_DRAFT_TITLE);
    expect(page).toContain(PRIVATE_DRAFT_SENTENCE);
    // The room itself — its header and its wheel — is not in the markup.
    expect(page).not.toContain("Job Centre · Draft room");
    expect(page).not.toContain("Sealed bids");
  });

  it("turns a signed-out visitor away the same way, with a way to sign in", async () => {
    state.userId = null;

    const page = await text(room(a.slug));

    expect(page).toContain(PRIVATE_DRAFT_SENTENCE);
    expect(page).toContain("Sign in");
    expect(page).not.toContain("Job Centre · Draft room");
  });

  it("turns a player in the pool away — in the draft is not a captain of it", async () => {
    state.userId = a.player;

    const page = await text(room(a.slug));

    expect(page).toContain(PRIVATE_DRAFT_SENTENCE);
    expect(page).not.toContain("Job Centre · Draft room");
  });

  it("turns a captain of a different event away — captaincy is per event (2b)", async () => {
    state.userId = b.captain;

    const page = await text(room(a.slug));

    expect(page).toContain(PRIVATE_DRAFT_SENTENCE);
    expect(page).not.toContain("Job Centre · Draft room");
  });

  it("serves the room to a captain of this event", async () => {
    state.userId = a.captain;

    const page = await text(room(a.slug));

    expect(page).toContain("Job Centre · Draft room");
    expect(page).not.toContain(PRIVATE_DRAFT_SENTENCE);
  });

  it("serves the room to the event's host", async () => {
    const host = await makeUser(db);
    await makeHost(db, a.eventId, host);
    state.userId = host;

    const page = await text(room(a.slug));

    expect(page).toContain("Job Centre · Draft room");
    expect(page).not.toContain(PRIVATE_DRAFT_SENTENCE);
  });

  it("serves the room to an admin", async () => {
    state.userId = admin;

    const page = await text(room(a.slug));

    expect(page).toContain("Job Centre · Draft room");
  });

  it("serves the room to a manager who is also a captain — two reasons, no special case (3a)", async () => {
    // Its own event, because A already has a host (one grant per event, R-86).
    // The captain is made host as well: `viewerFor` answers "admin" for them,
    // and the guard lets that role through as readily as "captain".
    const own = await draftEvent();
    await setPrivate(own.eventId, true);
    await makeHost(db, own.eventId, own.captain);
    state.userId = own.captain;

    const page = await text(room(own.slug));

    expect(page).toContain("Job Centre · Draft room");
    expect(page).not.toContain(PRIVATE_DRAFT_SENTENCE);
  });
});

/* ------------------------------------------------------------------ */
/* The payload and the poll — the data source, not the page           */
/* ------------------------------------------------------------------ */

describe("the room's payload while the draft is private", () => {
  it("is withheld from a member who is not a captain, by loadRoom itself", async () => {
    expect(await loadRoom(a.eventId, await userRow(member))).toBeNull();
  });

  it("is withheld from a signed-out poll", async () => {
    expect(await loadRoom(a.eventId, null)).toBeNull();
  });

  it("is withheld from a captain of a different event", async () => {
    expect(await loadRoom(a.eventId, await userRow(b.captain))).toBeNull();
  });

  it("is built for a captain of this event, with their bid standing", async () => {
    const payload = await loadRoom(a.eventId, await userRow(a.captain));
    expect(payload?.view.role).toBe("captain");
    expect(payload?.standing).not.toBeNull();
  });

  it("is withheld from the browser's poll for a member who is not a captain", async () => {
    // The action the room polls once a second. A guard on the page alone
    // would serve every lot and every bid to anybody who called this.
    state.userId = member;
    expect(await loadRoomAction(a.eventId)).toBeNull();

    state.userId = a.captain;
    expect((await loadRoomAction(a.eventId))?.view.role).toBe("captain");
  });

  it("is still built for everybody on an event whose draft is public (2c has nothing to backfill)", async () => {
    expect((await loadRoom(b.eventId, await userRow(member)))?.view.role).toBe("observer");
    expect((await loadRoom(b.eventId, null))?.view.role).toBe("observer");
  });
});

/* ------------------------------------------------------------------ */
/* The result stays public (UC-50 4)                                  */
/* ------------------------------------------------------------------ */

describe("the public event page while the draft is private", () => {
  it("still lists every team and its captain on the Teams tab, to a member who cannot watch the draft", async () => {
    state.userId = member;

    const page = await text(eventPage(a.slug));

    for (const name of a.teamNames) expect(page).toContain(name);
    for (const name of a.captainNames) expect(page).toContain(`${name} Captain`);
    expect(page).not.toContain(PRIVATE_DRAFT_SENTENCE);
  });

  it("still lists them signed out", async () => {
    state.userId = null;

    const page = await text(eventPage(a.slug));

    for (const name of a.teamNames) expect(page).toContain(name);
  });
});

/* ------------------------------------------------------------------ */
/* Turning it on and off from the Draft tab (UC-50 1, 2c)             */
/* ------------------------------------------------------------------ */

describe("saveDraftPrivacyAction", () => {
  it("stores the flag as one top-level key on events.config, and reads it back", async () => {
    const own = await draftEvent();
    const host = await makeUser(db);
    await makeHost(db, own.eventId, host);
    state.userId = host;

    const closed = await saveDraftPrivacyAction(own.eventId, true);

    expect(closed).toEqual({ ok: true, data: { privateDraft: true } });
    const stored = await getEventById(own.eventId, {}, db);
    expect(stored?.config?.privateDraft).toBe(true);
    expect(privateDraftFrom(stored?.config)).toBe(true);
  });

  it("serves the room to everybody again the moment it is turned off, with nothing to backfill (2c)", async () => {
    const own = await draftEvent();
    state.userId = admin;
    unwrap(await saveDraftPrivacyAction(own.eventId, true));
    expect(await loadRoom(own.eventId, await userRow(member))).toBeNull();

    unwrap(await saveDraftPrivacyAction(own.eventId, false));

    expect((await loadRoom(own.eventId, await userRow(member)))?.view.role).toBe("observer");
    expect((await loadRoom(own.eventId, null))?.view.role).toBe("observer");
  });

  it("leaves an audit line saying who closed the doors, and none for a re-save of the same answer", async () => {
    const own = await draftEvent();
    state.userId = admin;

    unwrap(await saveDraftPrivacyAction(own.eventId, true));
    unwrap(await saveDraftPrivacyAction(own.eventId, true));

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventId, own.eventId));
    const lines = rows.filter((row) => row.action === "draft.privacy");
    expect(lines).toHaveLength(1);
    expect(lines[0].summary).toMatch(/private/i);
  });

  it("is refused for a member who manages nothing, and writes nothing", async () => {
    const own = await draftEvent();
    state.userId = member;

    await expect(saveDraftPrivacyAction(own.eventId, true)).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_REDIRECT/),
    });

    expect(privateDraftFrom((await getEventById(own.eventId, {}, db))?.config)).toBe(false);
  });

  it("is refused for the host of a different event", async () => {
    const own = await draftEvent();
    const other = await draftEvent();
    const host = await makeUser(db);
    await makeHost(db, other.eventId, host);
    state.userId = host;

    await expect(saveDraftPrivacyAction(own.eventId, true)).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_REDIRECT/),
    });
  });

  it("is not frozen by the rules lock — the doors close after the first lot has opened, while a rule cannot move", async () => {
    const own = await draftEvent();
    unwrap(await openLot(own.eventId, { userId: own.player, kind: "main" }, db));
    state.userId = admin;

    // The lock is live: a rule change is refused now (UC-16 1a)...
    const rule = await saveDraftConfigAction(own.eventId, { minBid: 50 });
    expect(rule.ok).toBe(false);

    // ...and the flag is not a rule, so it still moves.
    const closed = await saveDraftPrivacyAction(own.eventId, true);

    expect(closed).toEqual({ ok: true, data: { privateDraft: true } });
    expect(await loadRoom(own.eventId, await userRow(member))).toBeNull();
    expect((await loadRoom(own.eventId, await userRow(own.captain)))?.view.lot).not.toBeNull();
  });
});
