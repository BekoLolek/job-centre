import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, auditLog, eventHosts, events, users } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { createEvent } from "@/lib/events";
import { OWN_APPLICATION, applyToHost, canManageEvent, getHostApplication } from "@/lib/hosting";
import type { Power } from "@/lib/permissions-policy";

/*
 * Deciding a host application as a member who holds `hosts.approve`
 * (Task 126, R-261, R-264 / UC-56).
 *
 * Mocked as `decisions.test.ts` beside this file mocks it, and for its
 * reasons. That file still asks what an admin and a member with nothing get;
 * this one asks what the power gives, what it does not, and the one thing it
 * must never give: an `event_hosts` row for the holder's own application.
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
const { grantPower } = await import("@/lib/permissions");

let handle: TestDatabase;
let db: Database;
let granter: string;
let counter = 0;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
  granter = await makeUser(db, { displayName: "The admin who granted" });
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  state.userId = null;
});

/** A member holding exactly these powers, signed in. */
async function holderOf(...powers: Power[]): Promise<string> {
  counter += 1;
  const id = await makeUser(db, { displayName: `Holder ${counter}` });
  for (const power of powers) {
    await grantPower({ userId: id, power, grantedByUserId: granter }, db);
  }
  state.userId = id;
  return id;
}

/** A pending application from this member, or from somebody new. */
async function anApplication(applicant?: string) {
  counter += 1;
  const by = applicant ?? (await makeUser(db, { displayName: `Applicant ${counter}` }));
  const title = `Friday REPO night ${counter}`;
  const result = await applyToHost(
    by,
    {
      title,
      gameName: "REPO",
      gameId: null,
      summary: "Six of us, a few rounds, prizes for whoever survives longest. Two hours tops.",
      playerInfoNeeded: "In-game name",
    },
    db
  );
  if (!result.ok) throw new Error(result.error);
  return { id: result.data.id, applicant: by, title };
}

/** An event nobody hosts, made the way an admin's screen makes one. */
async function anEvent(): Promise<string> {
  counter += 1;
  const created = await createEvent({ title: `An unhosted event ${counter}` }, db);
  if (!created.ok) throw new Error(created.error);
  return created.data.id;
}

async function auditFor(applicationId: string) {
  return db.select().from(auditLog).where(eq(auditLog.subject, applicationId));
}

const eventCount = async () => (await db.select({ id: events.id }).from(events)).length;

/* ------------------------------------------------------------------ */
/* What the power gives                                               */
/* ------------------------------------------------------------------ */

describe("a hosts.approve holder", () => {
  it("approves somebody's application, and the audit line names the holder", async () => {
    const application = await anApplication();
    const eventId = await anEvent();
    const holder = await holderOf("hosts.approve");

    const result = await approveHostApplicationAction(application.id, { eventId });

    expect(result).toEqual({ ok: true, data: { eventId } });
    expect((await getHostApplication(application.id, db))?.status).toBe("approved");
    expect(await canManageEvent({ id: application.applicant, isAdmin: false }, eventId, db)).toBe(
      true
    );
    expect(
      (await auditFor(application.id)).map((line) => [line.action, line.actorUserId])
    ).toEqual([["host.approved", holder]]);
  });

  it("declines one, and the audit line names the holder", async () => {
    const application = await anApplication();
    const holder = await holderOf("hosts.approve");

    const result = await declineHostApplicationAction(application.id, "Clashes with the final.");

    expect(result).toEqual({ ok: true, data: null });
    expect((await getHostApplication(application.id, db))?.status).toBe("declined");
    expect(
      (await auditFor(application.id)).map((line) => [line.action, line.actorUserId])
    ).toEqual([["host.declined", holder]]);
  });

  // Creating a blank one is `createEventAction`, and that refusal is a row of
  // the surface table in `admin/events/__tests__/powers.test.ts`.
  it("does not thereby create an event from the application", async () => {
    const application = await anApplication();
    await holderOf("hosts.approve");
    const before = await eventCount();

    await expect(createEventFromApplicationAction(application.id)).rejects.toThrow(
      /NEXT_REDIRECT/
    );

    expect(await eventCount()).toBe(before);
    expect(await auditFor(application.id)).toEqual([]);
  });

  it("creates the event from an application once they hold events.create as well", async () => {
    const application = await anApplication();
    const holder = await holderOf("hosts.approve", "events.create");

    const result = await createEventFromApplicationAction(application.id);

    expect(result.ok).toBe(true);
    expect(
      (await auditFor(application.id)).map((line) => [line.action, line.actorUserId])
    ).toEqual([["event.created", holder]]);
  });
});

describe("an events.create holder", () => {
  it("decides no host application and creates no event from one", async () => {
    const application = await anApplication();
    const eventId = await anEvent();
    await holderOf("events.create");
    const before = await eventCount();

    await expect(createEventFromApplicationAction(application.id)).rejects.toThrow(
      /NEXT_REDIRECT/
    );
    await expect(approveHostApplicationAction(application.id, { eventId })).rejects.toThrow(
      /NEXT_REDIRECT/
    );
    await expect(declineHostApplicationAction(application.id, "Not for us")).rejects.toThrow(
      /NEXT_REDIRECT/
    );

    expect(await eventCount()).toBe(before);
    expect((await getHostApplication(application.id, db))?.status).toBe("pending");
    expect(await auditFor(application.id)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The escalation the power must not be (R-264)                       */
/* ------------------------------------------------------------------ */

describe("approving your own application", () => {
  it("is refused by name for a hosts.approve holder, and grants nothing", async () => {
    const holder = await holderOf("hosts.approve");
    const application = await anApplication(holder);
    const eventId = await anEvent();

    const result = await approveHostApplicationAction(application.id, { eventId });

    expect(result).toEqual({ ok: false, error: OWN_APPLICATION });
    expect(await canManageEvent({ id: holder, isAdmin: false }, eventId, db)).toBe(false);
    expect(await db.select().from(eventHosts).where(eq(eventHosts.eventId, eventId))).toEqual([]);
    expect((await getHostApplication(application.id, db))?.status).toBe("pending");
    expect(await auditFor(application.id)).toEqual([]);
  });

  it("is refused onto an event the holder created from it themselves", async () => {
    // The whole path with both powers in one pair of hands: apply, build the
    // event from the application, approve. The last step is the escalation.
    const holder = await holderOf("hosts.approve", "events.create");
    const application = await anApplication(holder);
    const created = await createEventFromApplicationAction(application.id);
    if (!created.ok) throw new Error(created.error);

    const result = await approveHostApplicationAction(application.id, {
      eventId: created.data.eventId,
    });

    expect(result).toEqual({ ok: false, error: OWN_APPLICATION });
    expect(await canManageEvent({ id: holder, isAdmin: false }, created.data.eventId, db)).toBe(
      false
    );
    expect((await getHostApplication(application.id, db))?.status).toBe("pending");
  });

  it("leaves the application for another holder to approve", async () => {
    const applicant = await holderOf("hosts.approve");
    const application = await anApplication(applicant);
    const eventId = await anEvent();
    const other = await holderOf("hosts.approve");

    const result = await approveHostApplicationAction(application.id, { eventId });

    expect(result).toEqual({ ok: true, data: { eventId } });
    expect(
      (await auditFor(application.id)).map((line) => [line.action, line.actorUserId])
    ).toEqual([["host.approved", other]]);
  });

  it("is unchanged for an admin, who manages every event already", async () => {
    const admin = await holderOf();
    await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin));
    const application = await anApplication(admin);
    const eventId = await anEvent();

    const result = await approveHostApplicationAction(application.id, { eventId });

    expect(result).toEqual({ ok: true, data: { eventId } });
    expect((await getHostApplication(application.id, db))?.status).toBe("approved");
    expect(
      (await db.select().from(eventHosts).where(eq(eventHosts.eventId, eventId))).map(
        (row) => row.userId
      )
    ).toEqual([admin]);
  });
});
