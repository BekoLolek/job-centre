import { type ReactElement, type ReactNode, isValidElement } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { type Database, users } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";
import type { Power } from "@/lib/permissions-policy";

/*
 * What each screen offers a member who holds a power (Task 130, R-265 /
 * UC-56 2): **every screen that offers a thing asks the same question the
 * action asks.**
 *
 * Each action already answers to a power (Tasks 126 to 128). The screens in
 * front of them still read the admin flag, so a holder had the server's
 * permission and no button - or a button whose action was certain to refuse.
 * Every table here names the power beside the flag: a holder of the right one,
 * a holder of the wrong one, an admin holding none, a member holding none.
 *
 * Nothing is rendered. Each page is called as the function it is and the
 * element it returns is searched for the component the page hands its answer
 * to, so what is asserted is what the page decided and not markup.
 *
 * **This is not where anybody is stopped.** That an action refuses is
 * `polls-suggestions-settings-powers.test.ts`, `admin/__tests__/catalogue-powers.test.ts`
 * and the two `powers.test.ts` files; that a page refuses is
 * `admin/__tests__/holder-pages.test.ts`.
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
  getGateConfig: async () => ({ enabled: false, guildId: "", source: { guildId: "none" } }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/server", () => ({ after: () => {} }));

/*
 * `listAudit` is the real one, wrapped so the dashboard's calls can be
 * counted - as `admin/audit/__tests__/audit.test.ts` wraps it, and for its
 * reason: "is not shown the log" could be a page that read it and threw the
 * rows away, and only the count tells the two apart.
 */
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, listAudit: vi.fn(actual.listAudit) };
});

const { default: SuggestionsPage } = await import("../suggestions/page");
const { default: PollsPage } = await import("../polls/page");
const { default: AdminEventPage } = await import("../admin/events/[id]/page");
const { default: AdminEventsPage } = await import("../admin/events/page");
const { default: AdminHostPage } = await import("../admin/host/page");
const { default: AdminSettingsPage } = await import("../admin/settings/page");
const { default: AdminDashboardPage } = await import("../admin/page");
const { default: SuggestionBox } = await import("@/components/suggestions/SuggestionBox");
const { default: PollList } = await import("@/components/polls/PollList");
const { default: EventEditor } = await import("@/components/admin/events/EventEditor");
const { default: EventsManager } = await import("@/components/admin/events/EventsManager");
const { default: HostQueue } = await import("@/components/admin/HostQueue");
const { default: AnnouncementSettings } = await import("@/components/admin/AnnouncementSettings");
const { default: ServerSettings } = await import("@/components/admin/ServerSettings");
const { grantPower } = await import("@/lib/permissions");
const { createEvent, publishEvent } = await import("@/lib/events");
const { applyToHost } = await import("@/lib/hosting");
const { listAudit, recordAudit } = await import("@/lib/audit");

let handle: TestDatabase;
let db: Database;
let admin: string;
let eventId: string;
let counter = 0;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;

  admin = await makeUser(db, { displayName: "An admin holding nothing" });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin));

  // What the dashboard has to say something about: a draft that is not ready
  // to publish, an event that is coming up, an application to host, and a
  // line in the log.
  eventId = await anEvent("A draft nobody has finished");
  const coming = await createEvent({ ...PUBLISHABLE, title: "Coming up" }, db);
  if (!coming.ok) throw new Error(coming.error);
  const published = await publishEvent(coming.data.id, db);
  if (!published.ok) throw new Error(published.error);
  const applied = await applyToHost(
    await makeUser(db, { displayName: "An applicant" }),
    {
      title: "Friday REPO night",
      gameName: "REPO",
      gameId: null,
      summary: "Six of us, a few rounds, prizes for whoever survives longest. Two hours tops.",
      playerInfoNeeded: "In-game name",
    },
    db
  );
  if (!applied.ok) throw new Error(applied.error);
  await recordAudit(
    { action: "announcement.failed", summary: "It did not go out.", eventId, subject: "event_published" },
    db
  );
});

afterAll(async () => {
  await handle.close();
});

beforeEach(() => {
  state.userId = null;
  vi.mocked(listAudit).mockClear();
});

async function anEvent(title: string): Promise<string> {
  const created = await createEvent({ title }, db);
  if (!created.ok) throw new Error(created.error);
  return created.data.id;
}

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

/** Who opens the screen: "admin", "visitor", or a new member holding the powers named, comma-separated. */
async function signInAs(who: string): Promise<void> {
  if (who === "visitor") state.userId = null;
  else if (who === "admin") state.userId = admin;
  else await holding(...(who === "nothing" ? [] : (who.split(", ") as Power[])));
}

/** Every element a page built, wherever it put it: children, an `aside`, a `footer`. */
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

function find(page: ReactNode, type: unknown): ReactElement<Record<string, unknown>> | undefined {
  return [...elements(page)].find((element) => element.type === type);
}

/* ------------------------------------------------------------------ */
/* The three screens that read the flag alone                         */
/* ------------------------------------------------------------------ */

describe("/suggestions, whose moderating controls are suggestions.moderate's", () => {
  it.each([
    ["suggestions.moderate", true],
    ["admin", true],
    // The neighbouring power, on the neighbouring screen: not this one's.
    ["polls.manage", false],
    ["nothing", false],
    ["visitor", false],
  ])("offered to %s: %s", async (who, offered) => {
    await signInAs(who);

    const page = await SuggestionsPage();

    expect(find(page, SuggestionBox)?.props.isAdmin).toBe(offered);
  });
});

describe("/polls, whose posting and closing controls are polls.manage's", () => {
  it.each([
    ["polls.manage", true],
    ["admin", true],
    ["suggestions.moderate", false],
    ["nothing", false],
    ["visitor", false],
  ])("offered to %s: %s", async (who, offered) => {
    await signInAs(who);

    const page = await PollsPage();

    expect(find(page, PollList)?.props.isAdmin).toBe(offered);
  });
});

describe("Save as template in the event editor, which is templates.manage's", () => {
  const open = (id = eventId) =>
    AdminEventPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });

  it.each([
    // The editor opens for whoever manages the event; the button is a second question.
    ["events.manage, templates.manage", true],
    ["admin", true],
    ["events.manage", false],
    // Every power but the one, so the button is not following "holds anything".
    ["events.manage, events.create, games.manage, championships.manage, destructive", false],
  ])("offered to %s: %s", async (who, offered) => {
    await signInAs(who);

    const page = await open();

    expect(find(page, EventEditor)?.props.mayManageTemplates).toBe(offered);
  });

  it("offered to the event's own host who also holds templates.manage", async () => {
    const theirs = await anEvent("Hosted by a curator");
    await makeHost(db, theirs, await holding("templates.manage"));

    expect(find(await open(theirs), EventEditor)?.props.mayManageTemplates).toBe(true);
  });

  it("not offered to the event's own host, who holds nothing", async () => {
    const theirs = await anEvent("Hosted by a member");
    await makeHost(db, theirs, await holding());

    expect(find(await open(theirs), EventEditor)?.props.mayManageTemplates).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The screens two powers share                                       */
/* ------------------------------------------------------------------ */

describe("/admin/settings, which is two powers' screen", () => {
  it.each([
    ["settings.announcements", true, false],
    ["settings.integrations", false, true],
    ["settings.announcements, settings.integrations", true, true],
    ["admin", true, true],
  ])("shows %s the announcements: %s, the server's wiring: %s", async (who, announcements, wiring) => {
    await signInAs(who);

    const page = await AdminSettingsPage();

    expect(Boolean(find(page, AnnouncementSettings))).toBe(announcements);
    expect(Boolean(find(page, ServerSettings))).toBe(wiring);
  });
});

describe("/admin/events, which is two powers' screen", () => {
  it.each([
    ["events.create", true, false],
    ["events.manage", false, true],
    ["events.create, events.manage", true, true],
    ["admin", true, true],
  ])("offers %s the new-event form: %s, the events to manage: %s", async (who, create, manage) => {
    await signInAs(who);

    const props = find(await AdminEventsPage(), EventsManager)?.props;

    expect(props?.mayCreate).toBe(create);
    expect(props?.mayManage).toBe(manage);
  });

  it("hands no event to a holder who could open none of them", async () => {
    await signInAs("events.create");

    expect(find(await AdminEventsPage(), EventsManager)?.props.rows).toEqual([]);
  });

  it("hands every event to a holder who manages them", async () => {
    await signInAs("events.manage");

    const rows = find(await AdminEventsPage(), EventsManager)?.props.rows as { event: { id: string } }[];

    expect(rows.map((row) => row.event.id)).toContain(eventId);
  });
});

describe("/admin/host, whose first step needs a second power", () => {
  it.each([
    ["hosts.approve", false, false, false],
    ["hosts.approve, events.create", true, false, false],
    ["hosts.approve, events.manage", false, true, false],
    ["hosts.approve, games.manage", false, false, true],
    ["admin", true, true, true],
  ])(
    "offers %s Create event: %s, the way into an event: %s, the way to Games: %s",
    async (who, create, manage, games) => {
      await signInAs(who);

      const props = find(await AdminHostPage(), HostQueue)?.props;

      expect(props?.mayCreateEvent).toBe(create);
      expect(props?.mayManageEvents).toBe(manage);
      expect(props?.mayManageGames).toBe(games);
    }
  );
});

/* ------------------------------------------------------------------ */
/* The dashboard's cards                                              */
/* ------------------------------------------------------------------ */

/** Where the dashboard would send its reader, with ids taken out and one of each. */
async function destinations(): Promise<string[]> {
  const page = await AdminDashboardPage();
  const hrefs = [...elements(page)].flatMap((element) =>
    typeof element.props.href === "string" ? [element.props.href] : []
  );
  const shapes = hrefs.map((href) =>
    href
      .replace(/\?.*$/, "")
      .replace(/^\/admin\/events\/[^/]+$/, "/admin/events/[id]")
      .replace(/^\/events\/[^/]+/, "/events/[slug]")
  );
  return [...new Set(shapes)].sort();
}

describe("/admin, which shows only the cards a holder's powers reach", () => {
  it.each([
    // The draft's lines, what is coming up, and the member's view of it.
    ["events.manage", ["/admin/events", "/admin/events/[id]", "/events/[slug]"]],
    // Nothing waits on somebody who can only make one - but making one is theirs.
    ["events.create", ["/admin/events"]],
    ["hosts.approve", ["/admin/host"]],
    // The failed announcement resolves in the log, and so does the tail.
    ["audit.read", ["/admin/audit"]],
    // Powers whose work is on another screen: let in, and shown nothing to follow.
    ["games.manage", []],
    ["polls.manage", []],
    ["hosts.approve, audit.read", ["/admin/audit", "/admin/host"]],
    ["admin", ["/admin/audit", "/admin/events", "/admin/events/[id]", "/admin/host", "/events/[slug]"]],
  ])("sends %s only to %j", async (who, expected) => {
    await signInAs(who);

    expect(await destinations()).toEqual(expected);
  });

  it("reads the log for a holder of audit.read, and for an admin", async () => {
    await signInAs("audit.read");
    await AdminDashboardPage();
    await signInAs("admin");
    await AdminDashboardPage();

    expect(listAudit).toHaveBeenCalledTimes(2);
  });

  it("does not read the log at all for a holder it is not shown to", async () => {
    await signInAs("events.manage, hosts.approve, members.read");

    await AdminDashboardPage();

    expect(listAudit).not.toHaveBeenCalled();
  });
});
