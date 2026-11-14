import { type ReactElement, type ReactNode, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, events, users } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import type { HostApplication } from "@/lib/hosting";
import type { Power } from "@/lib/permissions-policy";

/*
 * No screen sends a holder somewhere their powers cannot follow (Task 130,
 * R-265 / UC-56).
 *
 * Task 126 left two buttons that worked and then threw the member who pressed
 * them to `/me`:
 *
 *  - **Create draft**, for a holder of `events.create` alone. The action
 *    succeeded and the screen pushed them to `/admin/events/[id]`, which is on
 *    `requireEventManager` - and making an event does not make its maker a
 *    manager of it.
 *  - **Approve and hand it over**, for a holder of `hosts.approve` alone. Same
 *    push, same bounce.
 *
 * The answer was never to widen `requireEventManager`, and each walk below
 * ends by showing the editor still refuses the holder. What changed is where
 * the screen sends them.
 *
 * ## How a flow is walked here, and what that leaves out
 *
 * Each walk is the real thing end to end except the click: the holder's page
 * is opened for real, the props it hands its screen are read off it, the real
 * action runs against an in-memory Postgres, and the screen's own exported
 * decision - `editorAfterCreate`, `editorAfterApproval` - is asked where that
 * leaves them, *with the props the page actually gave it*. Then the place it
 * names is opened, as the same holder.
 *
 * The one hop not covered is the handler calling that decision and handing
 * its answer to `router.push`. That is three lines inside a click handler,
 * and `environment: "node"` has nothing to click with.
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
// The real module but for the router: `redirect` has to stay Next's own, since
// where a guard redirects to is what half of this file reads.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ refresh() {}, push() {} }),
}));

const { default: AdminEventsPage } = await import("../events/page");
const { default: AdminEventPage } = await import("../events/[id]/page");
const { default: AdminHostPage } = await import("../host/page");
const { createEventAction } = await import("../events/actions");
const { approveHostApplicationAction } = await import("../host/actions");
const { default: EventsManager, editorAfterCreate } = await import(
  "@/components/admin/events/EventsManager"
);
const { default: HostQueue, editorAfterApproval } = await import("@/components/admin/HostQueue");
const { grantPower } = await import("@/lib/permissions");
const { createEvent } = await import("@/lib/events");
const { applyToHost } = await import("@/lib/hosting");

let handle: TestDatabase;
let db: Database;
let admin: string;
let counter = 0;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
  admin = await makeUser(db, { displayName: "The admin who granted" });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin));
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  state.userId = null;
});

/** Sign in as a new member holding exactly these powers. */
async function holding(...powers: Power[]): Promise<string> {
  counter += 1;
  const id = await makeUser(db, { displayName: `Holder ${counter}` });
  for (const power of powers) {
    await grantPower({ userId: id, power, grantedByUserId: admin }, db);
  }
  state.userId = id;
  return id;
}

function* elements(node: unknown): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child);
    return;
  }
  if (!isValidElement(node)) return;
  const element = node as ReactElement<Record<string, unknown>>;
  yield element;
  for (const value of Object.values(element.props)) yield* elements(value);
}

/** The props a page handed the one screen of this type it rendered. */
function screen<T>(page: ReactNode, type: unknown): T {
  const found = [...elements(page)].find((element) => element.type === type);
  if (!found) throw new Error("The page did not render that screen.");
  return found.props as T;
}

const editor = (id: string) =>
  AdminEventPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });

const TO_THE_HUB = { digest: expect.stringMatching(/^NEXT_REDIRECT;[a-z]+;\/me;/) };

type ManagerProps = Parameters<typeof EventsManager>[0];
type QueueProps = Parameters<typeof HostQueue>[0];

/* ------------------------------------------------------------------ */
/* Creating an event                                                  */
/* ------------------------------------------------------------------ */

describe("a holder of events.create alone, pressing Create draft", () => {
  it("stays on the events list, which is theirs, and is not sent to an editor that is not", async () => {
    await holding("events.create");
    const before = screen<ManagerProps>(await AdminEventsPage(), EventsManager);

    const created = await createEventAction({ title: "Made by somebody who cannot manage it" });
    if (!created.ok) throw new Error(created.error);
    const next = editorAfterCreate(before.mayManage, created.data.id);

    // Nowhere: they stay where they are, and that page still opens for them.
    expect(next).toBeNull();
    await expect(AdminEventsPage()).resolves.toBeDefined();
    // The event is real, and a draft for somebody who manages events to pick up.
    const [row] = await db.select().from(events).where(eq(events.id, created.data.id));
    expect(row.status).toBe("draft");
    // And the place the button used to send them still turns them away: the
    // guard was not widened to make the old destination work.
    await expect(editor(created.data.id)).rejects.toMatchObject(TO_THE_HUB);
  });

  it("is told before they press it that the draft is somebody else's to set up", async () => {
    await holding("events.create");
    const props = screen<ManagerProps>(await AdminEventsPage(), EventsManager);

    const markup = renderToStaticMarkup(createElement(EventsManager, props));

    expect(markup).toContain("Create draft");
    expect(markup).toContain("somebody who manages events");
    expect(markup).not.toContain("You land in the editor");
  });

  it("is shown no row that links to an editor they cannot open", async () => {
    const made = await createEvent({ title: "Already there" }, db);
    if (!made.ok) throw new Error(made.error);
    await holding("events.create");
    const props = screen<ManagerProps>(await AdminEventsPage(), EventsManager);

    const markup = renderToStaticMarkup(createElement(EventsManager, props));

    expect(markup).not.toContain("/admin/events/");
  });
});

describe("a holder of events.create who also manages events, pressing Create draft", () => {
  it("is sent to the editor, and it opens for them", async () => {
    await holding("events.create", "events.manage");
    const before = screen<ManagerProps>(await AdminEventsPage(), EventsManager);

    const created = await createEventAction({ title: "Made by somebody who manages it too" });
    if (!created.ok) throw new Error(created.error);
    const next = editorAfterCreate(before.mayManage, created.data.id);

    expect(next).toBe(`/admin/events/${created.data.id}`);
    await expect(editor(created.data.id)).resolves.toBeDefined();
  });

  it("is told they land in the editor, and is linked to every event", async () => {
    await holding("events.create", "events.manage");
    const props = screen<ManagerProps>(await AdminEventsPage(), EventsManager);

    const markup = renderToStaticMarkup(createElement(EventsManager, props));

    expect(markup).toContain("You land in the editor");
    expect(markup).toContain("/admin/events/");
  });
});

describe("a holder of events.manage alone, on the events list", () => {
  it("is not offered a form whose action would refuse them", async () => {
    await holding("events.manage");
    const props = screen<ManagerProps>(await AdminEventsPage(), EventsManager);

    const markup = renderToStaticMarkup(createElement(EventsManager, props));

    expect(markup).not.toContain("Create draft");
    expect(markup).toContain("/admin/events/");
  });
});

/* ------------------------------------------------------------------ */
/* Approving a host                                                   */
/* ------------------------------------------------------------------ */

async function anApplication(): Promise<string> {
  counter += 1;
  const result = await applyToHost(
    await makeUser(db, { displayName: `Applicant ${counter}` }),
    {
      title: `Friday REPO night ${counter}`,
      gameName: "REPO",
      gameId: null,
      summary: "Six of us, a few rounds, prizes for whoever survives longest. Two hours tops.",
      playerInfoNeeded: "In-game name",
    },
    db
  );
  if (!result.ok) throw new Error(result.error);
  return result.data.id;
}

async function anEvent(): Promise<string> {
  counter += 1;
  const created = await createEvent({ title: `An unhosted event ${counter}` }, db);
  if (!created.ok) throw new Error(created.error);
  return created.data.id;
}

const applicationOn = (props: QueueProps, id: string): HostApplication | undefined =>
  props.applications.find((row) => row.id === id);

describe("a holder of hosts.approve alone, pressing Approve and hand it over", () => {
  it("stays on the queue, which now shows the application approved, and is not sent to the editor", async () => {
    const applicationId = await anApplication();
    const eventId = await anEvent();
    await holding("hosts.approve");
    const before = screen<QueueProps>(await AdminHostPage(), HostQueue);

    const approved = await approveHostApplicationAction(applicationId, { eventId });
    if (!approved.ok) throw new Error(approved.error);
    const next = editorAfterApproval(before.mayManageEvents, approved.data.eventId);

    expect(applicationOn(before, applicationId)?.status).toBe("pending");
    expect(next).toBeNull();
    // The queue is where they are left, it opens, and it has their decision on it.
    const after = screen<QueueProps>(await AdminHostPage(), HostQueue);
    expect(applicationOn(after, applicationId)?.status).toBe("approved");
    // The old destination still refuses them.
    await expect(editor(eventId)).rejects.toMatchObject(TO_THE_HUB);
  });

  it("is not linked from a decided application to the event either", async () => {
    const applicationId = await anApplication();
    const eventId = await anEvent();
    await holding("hosts.approve");
    const approved = await approveHostApplicationAction(applicationId, { eventId });
    if (!approved.ok) throw new Error(approved.error);

    const props = screen<QueueProps>(await AdminHostPage(), HostQueue);
    const markup = renderToStaticMarkup(createElement(HostQueue, props));

    expect(markup).toContain("approved");
    expect(markup).not.toContain("/admin/events/");
  });

  it("is not offered Create event, which asks for a power they do not hold, and is told why", async () => {
    await anApplication();
    await holding("hosts.approve");
    const props = screen<QueueProps>(await AdminHostPage(), HostQueue);

    const markup = renderToStaticMarkup(createElement(HostQueue, props));

    expect(markup).not.toContain("Create event from this application");
    expect(markup).toContain("Creating an event is a separate power");
    // What their own power does is still theirs to do.
    expect(markup).toContain("Approve and hand it over");
    expect(markup).toContain("Decline");
  });
});

describe("the Games link on an application nobody has decided", () => {
  /*
   * Every pending card says "Games first if the game is not in the catalogue
   * yet". `/admin/games` is `games.manage`'s, so for anybody else the word
   * stays and the link goes: followed, it lands on `/signin?error=admin-only`.
   */
  it("is not a link for a holder of hosts.approve alone, though the sentence is still there", async () => {
    await anApplication();
    await holding("hosts.approve");
    const props = screen<QueueProps>(await AdminHostPage(), HostQueue);

    const markup = renderToStaticMarkup(createElement(HostQueue, props));

    expect(markup).toContain("first if the game is not in the catalogue yet");
    expect(markup).not.toContain("/admin/games");
    // Nothing on the whole screen leads anywhere under /admin that is not theirs.
    expect(markup).not.toContain('href="/admin');
  });

  it("is a link for a decider who also holds games.manage", async () => {
    await anApplication();
    await holding("hosts.approve", "games.manage");
    const props = screen<QueueProps>(await AdminHostPage(), HostQueue);

    const markup = renderToStaticMarkup(createElement(HostQueue, props));

    expect(markup).toContain('href="/admin/games"');
  });

  it("is a link for an admin", async () => {
    await anApplication();
    state.userId = admin;
    const props = screen<QueueProps>(await AdminHostPage(), HostQueue);

    const markup = renderToStaticMarkup(createElement(HostQueue, props));

    expect(markup).toContain('href="/admin/games"');
  });
});

describe("a holder of hosts.approve who also manages events, pressing Approve", () => {
  it("is sent to the editor, and it opens for them", async () => {
    const applicationId = await anApplication();
    const eventId = await anEvent();
    await holding("hosts.approve", "events.manage");
    const before = screen<QueueProps>(await AdminHostPage(), HostQueue);

    const approved = await approveHostApplicationAction(applicationId, { eventId });
    if (!approved.ok) throw new Error(approved.error);
    const next = editorAfterApproval(before.mayManageEvents, approved.data.eventId);

    expect(next).toBe(`/admin/events/${eventId}`);
    await expect(editor(eventId)).resolves.toBeDefined();
  });

  it("is linked from a decided application to its event", async () => {
    const applicationId = await anApplication();
    const eventId = await anEvent();
    await holding("hosts.approve", "events.manage");
    const approved = await approveHostApplicationAction(applicationId, { eventId });
    if (!approved.ok) throw new Error(approved.error);

    const props = screen<QueueProps>(await AdminHostPage(), HostQueue);
    const markup = renderToStaticMarkup(createElement(HostQueue, props));

    expect(markup).toContain(`/admin/events/${eventId}`);
  });
});

describe("an admin on the same two screens", () => {
  it("is sent to the editor from both, as before", async () => {
    state.userId = admin;
    const manager = screen<ManagerProps>(await AdminEventsPage(), EventsManager);
    const queue = screen<QueueProps>(await AdminHostPage(), HostQueue);

    expect(editorAfterCreate(manager.mayManage, "an-id")).toBe("/admin/events/an-id");
    expect(editorAfterApproval(queue.mayManageEvents, "an-id")).toBe("/admin/events/an-id");
  });
});
