import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, auditLog, eventHosts, games, users } from "@/db";
import { type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";
import { createEvent, getEventById } from "@/lib/events";
import { applyToHost, canManageEvent, getHostApplication } from "@/lib/hosting";

/*
 * Deciding a host application, through the actions (UC-21).
 *
 * The actions run for real against an in-memory Postgres. Only what cannot run
 * outside a Next request is replaced: the session cookie, the page cache, and
 * `after()` — which drops the deferred notifications, since outside a request
 * they would run detached and race this file's database close. `@/db`'s `db` is
 * pointed at this file's database the same way `host-scope.test.ts` does it.
 *
 * Two questions are asked of every action here: does it do the step the use
 * case describes, and can anybody who is not an admin reach it. The second one
 * matters because every export of a `"use server"` module is a POST endpoint
 * (Next.js, "Server Actions and Mutations" → Security): the screen is behind
 * `requireAdmin()`, and that is not what protects the action.
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

const {
  approveHostApplicationAction,
  createEventFromApplicationAction,
  declineHostApplicationAction,
} = await import("../actions");

let handle: TestDatabase;
let db: Database;
let admin: string;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
  admin = await makeUser(db, { displayName: "An admin" });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin));
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  state.userId = admin;
});

let counter = 0;

const PLAYER_INFO = "In-game name\nDo you own the DLC?";

/** A member with one pending application, and the game they picked. */
async function anApplication(over: { gameId?: string | null } = {}) {
  counter += 1;
  const applicant = await makeUser(db, { displayName: `Applicant ${counter}` });
  const result = await applyToHost(
    applicant,
    {
      title: `Friday REPO night ${counter}`,
      gameName: "REPO",
      gameId: over.gameId ?? null,
      summary: "Six of us, a few rounds, prizes for whoever survives longest. Two hours tops.",
      playerInfoNeeded: PLAYER_INFO,
    },
    db
  );
  if (!result.ok) throw new Error(result.error);
  return { id: result.data.id, applicant, title: `Friday REPO night ${counter}` };
}

async function auditFor(applicationId: string) {
  return db.select().from(auditLog).where(eq(auditLog.subject, applicationId));
}

/* ------------------------------------------------------------------ */
/* UC-21 2: the event is built from the application                   */
/* ------------------------------------------------------------------ */

describe("creating the event from the application", () => {
  it("prefills its name, its game and its questions", async () => {
    counter += 1;
    const [game] = await db
      .insert(games)
      .values({ key: `repo-${counter}`, name: "REPO" })
      .returning({ id: games.id });
    const application = await anApplication({ gameId: game.id });

    const result = await createEventFromApplicationAction(application.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const event = await getEventById(result.data.eventId, {}, db);
    expect(event?.title).toBe(application.title);
    expect(event?.game?.id).toBe(game.id);
    // One question per line of what they said they need to know, in order.
    expect(event?.questions.map((question) => question.label)).toEqual([
      "In-game name",
      "Do you own the DLC?",
    ]);
    expect(event?.questions.every((question) => question.required)).toBe(true);
  });

  it("leaves the application pending and grants nothing — it is step 2, not step 3", async () => {
    const application = await anApplication();

    const result = await createEventFromApplicationAction(application.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await getHostApplication(application.id, db))?.status).toBe("pending");
    expect(
      await canManageEvent({ id: application.applicant, isAdmin: false }, result.data.eventId, db)
    ).toBe(false);
  });

  it("does not attach a game the applicant only typed the name of", async () => {
    // Guessing a catalogue from free text is how three spellings of one game
    // get in. The admin adds it on /admin/games and picks it on the event.
    const application = await anApplication();

    const result = await createEventFromApplicationAction(application.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await getEventById(result.data.eventId, {}, db))?.game).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* UC-21 3, 4: approving links that event                             */
/* ------------------------------------------------------------------ */

describe("approving", () => {
  it("links the event the admin created and hands it over", async () => {
    const application = await anApplication();
    const created = await createEventFromApplicationAction(application.id);
    if (!created.ok) throw new Error(created.error);

    const result = await approveHostApplicationAction(application.id, {
      eventId: created.data.eventId,
      note: "Looks good.",
    });

    expect(result.ok).toBe(true);
    const row = await getHostApplication(application.id, db);
    expect(row?.status).toBe("approved");
    expect(row?.eventId).toBe(created.data.eventId);
    expect(
      await canManageEvent({ id: application.applicant, isAdmin: false }, created.data.eventId, db)
    ).toBe(true);
    expect(
      (await auditFor(application.id))
        .filter((line) => line.action === "host.approved")
        .map((line) => line.eventId)
    ).toEqual([created.data.eventId]);
  });

  it("refuses an event that is already somebody else's, and grants nothing (R-86)", async () => {
    /*
     * The failure mode: `eventId` is whatever the browser sent, so an approval
     * aimed at an event another member already hosts would give a second person
     * full rights over their evening. Nothing is granted and nothing is logged.
     */
    counter += 1;
    const theirs = await createEvent({ title: `Somebody else's ${counter}` }, db);
    if (!theirs.ok) throw new Error(theirs.error);
    const theirHost = await makeUser(db);
    await makeHost(db, theirs.data.id, theirHost);
    const application = await anApplication();

    const result = await approveHostApplicationAction(application.id, {
      eventId: theirs.data.id,
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors).toHaveProperty("eventId");
    expect(
      await canManageEvent({ id: application.applicant, isAdmin: false }, theirs.data.id, db)
    ).toBe(false);
    expect(await db.select().from(eventHosts).where(eq(eventHosts.eventId, theirs.data.id)))
      .toHaveLength(1);
    expect((await getHostApplication(application.id, db))?.status).toBe("pending");
    expect(await auditFor(application.id)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-21 3a: declining needs a reason                                 */
/* ------------------------------------------------------------------ */

describe("declining", () => {
  it("refuses without a reason, marks the field, and decides nothing", async () => {
    const application = await anApplication();

    const result = await declineHostApplicationAction(application.id, "   ");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors).toHaveProperty("note");
    expect((await getHostApplication(application.id, db))?.status).toBe("pending");
    // Nothing decided means nothing logged: the log is not a record of clicks.
    expect(await auditFor(application.id)).toEqual([]);
  });

  it("records the reason, because it is all the applicant gets back", async () => {
    const application = await anApplication();

    const result = await declineHostApplicationAction(
      application.id,
      "Clashes with the tournament final."
    );

    expect(result.ok).toBe(true);
    const row = await getHostApplication(application.id, db);
    expect(row?.status).toBe("declined");
    expect(row?.decisionNote).toBe("Clashes with the tournament final.");
    expect((await auditFor(application.id)).map((line) => line.action)).toEqual([
      "host.declined",
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-27 1a, UC-21 5b: none of this is a host's to reach              */
/* ------------------------------------------------------------------ */

describe("somebody who is not an admin", () => {
  it("cannot create, approve or decline, and nothing is written", async () => {
    // A host of their own event is the sharpest case: they are trusted with an
    // evening, and deciding who else gets one is exactly the power that must
    // not come with it.
    counter += 1;
    const theirs = await createEvent({ title: `A host's own ${counter}` }, db);
    if (!theirs.ok) throw new Error(theirs.error);
    const host = await makeUser(db);
    await makeHost(db, theirs.data.id, host);
    const application = await anApplication();
    state.userId = host;

    await expect(createEventFromApplicationAction(application.id)).rejects.toThrow(
      /NEXT_REDIRECT/
    );
    await expect(
      approveHostApplicationAction(application.id, { eventId: theirs.data.id })
    ).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(declineHostApplicationAction(application.id, "Not for us")).rejects.toThrow(
      /NEXT_REDIRECT/
    );

    expect((await getHostApplication(application.id, db))?.status).toBe("pending");
    expect(
      await canManageEvent({ id: application.applicant, isAdmin: false }, theirs.data.id, db)
    ).toBe(false);
    expect(await auditFor(application.id)).toEqual([]);
  });

  it("cannot reach them signed out either", async () => {
    const application = await anApplication();
    state.userId = null;

    await expect(declineHostApplicationAction(application.id, "Not for us")).rejects.toThrow(
      /NEXT_REDIRECT/
    );
    expect((await getHostApplication(application.id, db))?.status).toBe("pending");
  });
});
