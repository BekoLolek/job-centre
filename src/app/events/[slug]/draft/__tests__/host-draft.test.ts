import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, draftLots, users } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  awardLot,
  getDraftSnapshot,
  openLot,
  placeBid,
  setCaptains,
  setDraftPool,
  setTeams,
  viewerFor,
} from "@/lib/draft";
import { applyToEvent, createEvent, publishEvent } from "@/lib/events";
import { addHost } from "@/lib/hosting";

/*
 * A host running their own event's draft room, against an in-memory Postgres.
 *
 * Only what cannot run outside a Next request is replaced: the session cookie,
 * the page cache and `after()`, exactly as `host-scope.test.ts` does it. The
 * page, the room and the console actions are the real ones, so "the host gets
 * the console" is proved by the role the server hands back, not by a flag.
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

const { default: DraftRoomPage } = await import("../page");
const { runDraftAction } = await import("../actions");
type AdminCommand = import("../actions").AdminCommand;
const { loadRoom } = await import("../room");

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

type DraftEvent = { eventId: string; alpha: string; players: string[] };

/**
 * A published event with two captained teams and six players in the main pool.
 *
 * Six so every console test below can put its own player on the block without
 * waiting for another test's lot to settle.
 */
async function draftEvent(): Promise<DraftEvent> {
  counter += 1;
  const created = unwrap(await createEvent({ ...PUBLISHABLE, title: `Host draft ${counter}` }, db));
  unwrap(await publishEvent(created.id, db));

  const members: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const userId = await makeUser(db);
    unwrap(await applyToEvent(created.id, userId, {}, db));
    members.push(userId);
  }

  const written = unwrap(await setTeams(created.id, [{ name: "Alpha" }, { name: "Bravo" }], db));
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

  return { eventId: created.id, alpha: alpha.id, players: members.slice(2) };
}

async function lotsOf(eventId: string) {
  return db.select().from(draftLots).where(eq(draftLots.eventId, eventId));
}

let a: DraftEvent;
let b: DraftEvent;
let hostOfA: string;

beforeAll(async () => {
  a = await draftEvent();
  b = await draftEvent();
  hostOfA = await makeUser(db);
  await addHost(a.eventId, hostOfA, null, db);
});

beforeEach(() => {
  state.userId = hostOfA;
});

/* ------------------------------------------------------------------ */
/* Who the room thinks you are                                        */
/* ------------------------------------------------------------------ */

describe("the draft room's role for a host", () => {
  it("makes the host of this event its manager", async () => {
    expect(await viewerFor(a.eventId, hostOfA, false, db)).toEqual({
      role: "admin",
      userId: hostOfA,
      teamId: null,
    });
  });

  it("leaves the host of another event a watcher", async () => {
    expect(await viewerFor(b.eventId, hostOfA, false, db)).toMatchObject({ role: "observer" });
  });

  it("hands the host the console view when the room loads", async () => {
    const [user] = await db.select().from(users).where(eq(users.id, hostOfA));

    const payload = await loadRoom(a.eventId, user);

    expect(payload?.view.role).toBe("admin");
  });
});

/* ------------------------------------------------------------------ */
/* An unpublished event's draft room                                  */
/* ------------------------------------------------------------------ */

describe("the draft room of an unpublished event", () => {
  let hidden: { slug: string };

  beforeAll(async () => {
    const created = unwrap(await createEvent({ ...PUBLISHABLE, title: "Unpublished draft" }, db));
    await addHost(created.id, hostOfA, null, db);
    hidden = { slug: created.slug };
  });

  function open(slug: string) {
    return DraftRoomPage({ params: Promise.resolve({ slug }) });
  }

  it("opens for its host", async () => {
    await expect(open(hidden.slug)).resolves.toBeTruthy();
  });

  it("is not found for another member", async () => {
    state.userId = await makeUser(db);

    await expect(open(hidden.slug)).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });
});

/* ------------------------------------------------------------------ */
/* Running the console                                                */
/* ------------------------------------------------------------------ */

describe("a host running their own event's draft", () => {
  it("puts a player on the block and awards the lot to the team that bid", async () => {
    const opened = await runDraftAction(a.eventId, { type: "pick", userId: a.players[0], kind: "main" });
    const lotId = opened.payload?.view.lot?.id ?? "";
    unwrap(await placeBid(lotId, a.alpha, 50, {}, db));

    const outcome = await runDraftAction(a.eventId, { type: "award", teamId: a.alpha });

    expect(opened).toMatchObject({ ok: true, error: null });
    expect(outcome).toMatchObject({ ok: true, error: null });
    const [lot] = await db.select().from(draftLots).where(eq(draftLots.id, lotId));
    expect(lot).toMatchObject({ status: "awarded", winnerTeamId: a.alpha, price: 50 });
  });

  it("undoes the last award", async () => {
    const lot = unwrap(await openLot(a.eventId, { userId: a.players[4], kind: "main" }, db));
    unwrap(await placeBid(lot.id, a.alpha, 20, {}, db));
    unwrap(await awardLot(lot.id, a.alpha, {}, db));

    const outcome = await runDraftAction(a.eventId, { type: "undo" });

    expect(outcome).toMatchObject({ ok: true, error: null });
    expect((await lotsOf(a.eventId)).map((row) => row.status)).toContain("voided");
  });

  it("discards a lot nobody bid on", async () => {
    await runDraftAction(a.eventId, { type: "pick", userId: a.players[1], kind: "main" });

    const outcome = await runDraftAction(a.eventId, { type: "discard" });

    expect(outcome).toMatchObject({ ok: true, error: null });
    expect((await lotsOf(a.eventId)).map((lot) => lot.status)).toContain("discarded");
  });

  it("sends a lot to the reserve pool", async () => {
    await runDraftAction(a.eventId, { type: "pick", userId: a.players[2], kind: "main" });

    const outcome = await runDraftAction(a.eventId, { type: "reserve" });

    expect(outcome).toMatchObject({ ok: true, error: null });
    expect((await lotsOf(a.eventId)).map((lot) => lot.status)).toContain("reserved");
  });

  it("cancels the open lot", async () => {
    await runDraftAction(a.eventId, { type: "pick", userId: a.players[3], kind: "main" });

    const outcome = await runDraftAction(a.eventId, { type: "cancel" });

    expect(outcome).toMatchObject({ ok: true, error: null });
    expect(await getDraftSnapshot(a.eventId, {}, db)).toMatchObject({ lot: null });
  });
});

describe("a host reaching for another event's draft", () => {
  let openOnB: string;

  beforeAll(async () => {
    const lot = unwrap(await openLot(b.eventId, { userId: b.players[0], kind: "main" }, db));
    unwrap(await placeBid(lot.id, b.alpha, 30, {}, db));
    openOnB = lot.id;
  });

  // Thunks, because B's ids do not exist until `beforeAll` has run.
  it.each([
    ["pick", (): AdminCommand => ({ type: "pick", userId: b.players[1], kind: "main" })],
    ["award", (): AdminCommand => ({ type: "award", teamId: b.alpha })],
    ["discard", (): AdminCommand => ({ type: "discard" })],
    ["reserve", (): AdminCommand => ({ type: "reserve" })],
    ["cancel", (): AdminCommand => ({ type: "cancel" })],
    ["undo", (): AdminCommand => ({ type: "undo" })],
  ])("is refused %s, and nothing is written", async (_name, command) => {
    await expect(runDraftAction(b.eventId, command())).rejects.toMatchObject({
      digest: expect.stringMatching(/^NEXT_REDIRECT/),
    });

    expect(await lotsOf(b.eventId)).toMatchObject([{ id: openOnB, status: "open", price: null }]);
  });
});
