import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Database, type EventConfig } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";

/*
 * Tasks 79 and 80 on the screen — R-217, R-218, R-219 / UC-42 1-5a.
 *
 * ## Half of this file renders the *page*, not the panel
 *
 * That is deliberate and it is the only half that can catch the failure this
 * project has already had: `roles={roles}` was deleted from a page and every
 * test stayed green, because they all rendered the component directly with a
 * prop they had handed it themselves. Tab visibility is exactly that shape of
 * risk — the editor derives it, but *where a `?tab=` lands* is the server
 * page's call, and a component test cannot see the page forget to pass it.
 *
 * So the second block calls the real `AdminEventPage`, with a real event in a
 * real in-memory Postgres, walks the element tree it returns for the
 * `EventEditor` the page built, and renders *that*. Deleting `initialTab`,
 * `initialSetup` or `tabNotice` from the page fails a test below; so does
 * deleting the rail.
 *
 * ## What it cannot do
 *
 * The suite is vitest's `node` environment: no DOM, nothing to click. No test
 * here presses anything. What is asserted is the state that *arrives* — which
 * tabs the rail draws, which one is selected, which sentence is on the page —
 * and the decisions behind it are held directly in `shape-tabs.test.ts`.
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

/*
 * Partially mocked: `useRouter` has no router outside a request, but `redirect`
 * and `notFound` are the real ones — the page's own guard is not something to
 * replace in a file that renders the page.
 */
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

const { SETUP_KEYS, SETUP_LABELS } = await import("../tabs");
const { default: ShapeTab } = await import("../ShapeTab");
const { default: EventEditor } = await import("../EventEditor");
const { default: AdminEventPage } = await import("@/app/admin/events/[id]/page");
const { applyToEvent, createEvent, publishEvent, updateEvent } = await import("@/lib/events");
const { eventShapeFrom } = await import("@/lib/events-policy");
const { setTeamCount } = await import("@/lib/draft");

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

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/** A published event with `accepted` accepted applicants and a host reading it. */
async function hostedEvent(accepted: number, config?: EventConfig) {
  counter += 1;
  const event = unwrap(
    await createEvent({ ...PUBLISHABLE, title: `Shape ${counter}`, capacity: 64 }, db)
  );
  unwrap(await publishEvent(event.id, db));

  for (let index = 0; index < accepted; index += 1) {
    const userId = await makeUser(db, { displayName: `Shape ${counter}-${index}` });
    unwrap(await applyToEvent(event.id, userId, {}, db));
  }

  if (config) unwrap(await updateEvent(event.id, { config }, db));

  const host = await makeUser(db, { displayName: `Host ${counter}` });
  await makeHost(db, event.id, host);
  return { eventId: event.id, host };
}

const SOLO: EventConfig = {
  eventShape: { teamEvent: false, draft: false, sizing: { mode: "perTeam", value: 6 } },
};
const NO_DRAFT: EventConfig = {
  eventShape: { teamEvent: true, draft: false, sizing: { mode: "perTeam", value: 6 } },
};

/* --------------------------------------------------------------------- */
/* The panel itself (UC-42 1-4)                                          */
/* --------------------------------------------------------------------- */

function panel(
  over: Partial<Parameters<typeof ShapeTab>[0]> & { config?: EventConfig } = {}
): string {
  const { config, ...rest } = over;
  return renderToStaticMarkup(
    createElement(ShapeTab, {
      eventId: "event-1",
      shape: eventShapeFrom(config ?? {}),
      accepted: 18,
      existingTeams: 0,
      draftStarted: false,
      ...rest,
    })
  );
}

describe("the Format panel", () => {
  it("asks the three questions, in order", () => {
    const markup = panel();
    expect(markup).toContain("Does it have teams?");
    expect(markup).toContain("Is there a draft?");
    expect(markup).toContain("How are the teams sized?");
  });

  it("prints the use case's own consequence sentence", () => {
    // UC-42 4, with 18 accepted and six to a side.
    expect(panel()).toContain("3 teams from the 18 accepted");
  });

  it("changes the consequence when the accepted count changes, with nothing saved", () => {
    expect(panel({ accepted: 18 })).toContain("3 teams from the 18 accepted");
    expect(panel({ accepted: 24 })).toContain("4 teams from the 24 accepted");
    // The stored half is the same in both — one figure, one source.
    expect(panel({ accepted: 24 })).toContain("6 per team");
  });

  it("offers one box, not two", () => {
    // R-218: the derived figure is a sentence, never a field. Two number boxes
    // on this panel would be two places to disagree.
    const boxes = panel().match(/<input/g) ?? [];
    expect(boxes.length).toBe(1);
  });

  it("reads the other way round when that is the stored mode", () => {
    const markup = panel({
      config: {
        eventShape: { teamEvent: true, draft: true, sizing: { mode: "teams", value: 3 } },
      },
    });
    expect(markup).toContain("How many teams");
    expect(markup).toContain("6 per team from the 18 accepted");
  });

  it("says which sides are short before anything is saved", () => {
    // UC-42 4b.
    const markup = panel({
      accepted: 16,
      config: {
        eventShape: { teamEvent: true, draft: true, sizing: { mode: "teams", value: 3 } },
      },
    });
    expect(markup).toContain("6, 5, 5 from the 16 accepted");
    expect(markup).toContain("before anything is saved");
  });

  it("states an assumption rather than a count with nobody accepted", () => {
    // UC-42 4a.
    const markup = panel({ accepted: 0 });
    expect(markup).toContain("once anybody is");
    expect(markup).toContain("an assumption rather than a count");
    expect(markup).not.toContain("0 teams from");
  });

  it("names the tabs that go before the admin loses them", () => {
    const markup = panel({ config: SOLO });
    expect(markup).toContain("Draft, Teams, Captains, Bracket");
    expect(markup).toContain("Schedule and Results");
  });

  it("stops asking about the draft and the sizing on a solo event", () => {
    const markup = panel({ config: SOLO });
    expect(markup).not.toContain("Is there a draft?");
    expect(markup).not.toContain("How are the teams sized?");
  });

  it("refuses the switch-off while teams exist, naming how many (UC-42 2a)", () => {
    const markup = panel({ config: SOLO, existingTeams: 4 });
    expect(markup).toContain("This event already has 4 teams");
    expect(markup).toContain("Discard the 4 teams and their rosters");
  });

  it("refuses it outright once lots are awarded, and offers no confirmation (UC-42 3a)", () => {
    const markup = panel({ config: SOLO, existingTeams: 4, draftStarted: true });
    expect(markup).toContain("Void the awards on the Draft tab");
    expect(markup).not.toContain("Discard the 4 teams");
  });

  it("refuses turning only the draft off once lots are awarded", () => {
    const markup = panel({ config: NO_DRAFT, draftStarted: true });
    expect(markup).toContain("Void the awards on the Draft tab");
  });

  it("shows a bound on the panel rather than waiting for the server", () => {
    const markup = panel({
      config: {
        eventShape: { teamEvent: true, draft: true, sizing: { mode: "teams", value: 99 } },
      },
    });
    expect(markup).toContain("An event has between 2 and 8 teams.");
  });

  it("shows the planner's refusal when the accepted count cannot make two sides", () => {
    expect(panel({ accepted: 4 })).toContain("Accept more on the Applicants tab");
  });
});

/* --------------------------------------------------------------------- */
/* The page builds the editor (R-219 / UC-42 5, 5a)                      */
/* --------------------------------------------------------------------- */

/** The first element of this type anywhere in the tree the page returned. */
function findElement(node: ReactNode, type: unknown): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child as ReactNode, type);
      if (hit) return hit;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  if (node.type === type) return node;
  const props = node.props as { children?: ReactNode };
  return findElement(props.children, type);
}

/**
 * Render `/admin/events/[id]?tab=…` as the page itself builds it.
 *
 * The page is an async server component, so it is awaited for its element tree
 * and the `EventEditor` *it* constructed is pulled out of that tree and
 * rendered. Nothing here hands the editor a prop: every prop under test is one
 * the page put there, which is the whole reason this block exists.
 */
async function screen(eventId: string, host: string, tab?: string) {
  state.userId = host;
  const tree = await AdminEventPage({
    params: Promise.resolve({ id: eventId }),
    searchParams: Promise.resolve(tab === undefined ? {} : { tab }),
  });
  const editor = findElement(tree, EventEditor);
  expect(editor, "the page no longer renders the event editor").not.toBeNull();
  return renderToStaticMarkup(editor!);
}

/** A rail item's label — `<span>` with no attributes, unlike the Setup rail's. */
const railed = (markup: string, label: string) => markup.includes(`<span>${label}</span>`);

/** Which rail item the editor opened on. */
function selected(markup: string): string | null {
  return /aria-selected="true"[^>]*>\s*<span>([^<]+)<\/span>/.exec(markup)?.[1] ?? null;
}

/**
 * The Setup sub-rail's own items, in the order it draws them.
 *
 * Its labels carry a class and the step rail's do not, which is what lets
 * {@link railed} tell "Bracket, the step" from "Format, the panel" apart. This
 * reads the secondary rail only — it is scoped to the `aria-label="Setup"`
 * tablist, whose children are buttons rather than divs, so the first closing
 * `</div>` after it is the list's own.
 */
function setupRail(markup: string): string[] {
  const list = /aria-label="Setup"([\s\S]*?)<\/div>/.exec(markup)?.[1] ?? "";
  return [...list.matchAll(/<span class="text-13">([^<]+)<\/span>/g)].map((hit) => hit[1]);
}

describe("the rail the page builds", () => {
  it("draws every tab for a team event that drafts", async () => {
    const { eventId, host } = await hostedEvent(12);
    const markup = await screen(eventId, host);
    for (const label of [
      "Setup",
      "Draft",
      "Bracket",
      "Schedule",
      "Results",
      "Publish",
      "Applicants",
      "Teams",
      "Captains",
    ]) {
      expect(railed(markup, label), label).toBe(true);
    }
  });

  it("calls the bracket step Bracket, not Format", async () => {
    const { eventId, host } = await hostedEvent(12);
    const markup = await screen(eventId, host);
    expect(railed(markup, "Bracket")).toBe(true);
    expect(railed(markup, "Format")).toBe(false);
  });

  it("drops Draft, Teams, Captains and Bracket from a solo event", async () => {
    const { eventId, host } = await hostedEvent(12, SOLO);
    const markup = await screen(eventId, host);
    for (const label of ["Draft", "Teams", "Captains", "Bracket"]) {
      expect(railed(markup, label), label).toBe(false);
    }
  });

  it("keeps Schedule and Results on a solo event — a running order and a winner", async () => {
    const { eventId, host } = await hostedEvent(12, SOLO);
    const markup = await screen(eventId, host);
    expect(railed(markup, "Schedule")).toBe(true);
    expect(railed(markup, "Results")).toBe(true);
    expect(railed(markup, "Setup")).toBe(true);
    expect(railed(markup, "Publish")).toBe(true);
    expect(railed(markup, "Applicants")).toBe(true);
  });

  it("drops only Draft from a team event with no draft", async () => {
    const { eventId, host } = await hostedEvent(12, NO_DRAFT);
    const markup = await screen(eventId, host);
    expect(railed(markup, "Draft")).toBe(false);
    expect(railed(markup, "Teams")).toBe(true);
    expect(railed(markup, "Bracket")).toBe(true);
    expect(railed(markup, "Captains")).toBe(true);
  });

  it("opens on the tab the URL asks for", async () => {
    const { eventId, host } = await hostedEvent(12);
    expect(selected(await screen(eventId, host, "teams"))).toBe("Teams");
    expect(selected(await screen(eventId, host, "draft"))).toBe("Draft");
  });

  it("still opens the bracket for ?tab=format", async () => {
    // The alias order makes this easy to break; this is the end-to-end half of
    // `shape-tabs.test.ts`'s unit assertion.
    const { eventId, host } = await hostedEvent(12);
    expect(selected(await screen(eventId, host, "format"))).toBe("Bracket");
  });

  it("reaches the Format panel for ?tab=shape", async () => {
    const { eventId, host } = await hostedEvent(12);
    const markup = await screen(eventId, host, "shape");
    expect(selected(markup)).toBe("Setup");
    expect(markup).toContain("Does it have teams?");
  });

  it("offers the Format panel on the Setup rail, so it is reachable by clicking", async () => {
    /*
     * The criterion says **reachable**, and a panel that only a hand-typed
     * `?tab=shape` reaches is not: it is Task 84's unreachable draw page one
     * floor up. Deleting the item from the Setup rail left every other test in
     * this file green, because they all arrive by URL — so this is the test
     * that notices.
     *
     * The list is read off `SETUP_KEYS` rather than written out, so a seventh
     * panel that nobody adds to the rail fails here too.
     */
    const { eventId, host } = await hostedEvent(12);
    const markup = await screen(eventId, host);
    expect(setupRail(markup)).toEqual(SETUP_KEYS.map((key) => SETUP_LABELS[key]));
    expect(setupRail(markup)).toContain("Format");
  });

  it("keeps the Setup rail whole on a solo event too", async () => {
    // R-219 takes tabs off the *main* rail. Nothing about a solo event makes
    // the panel that decides it disappear.
    const { eventId, host } = await hostedEvent(12, SOLO);
    expect(setupRail(await screen(eventId, host))).toContain("Format");
  });
});

describe("a link to a tab the event no longer has", () => {
  it("lands on Setup with the Format panel open, and says why", async () => {
    // UC-42 5a. These links are in `/admin`'s action lines and in bookmarks.
    const { eventId, host } = await hostedEvent(12, SOLO);
    const markup = await screen(eventId, host, "draft");

    expect(selected(markup)).toBe("Setup");
    // The screen that would bring the tab back, not merely a screen.
    expect(markup).toContain("Does it have teams?");
    expect(markup).toContain("Setup → Format is where that is decided");
    expect(markup).toContain("Draft is only for an event with sides");
  });

  it("renders no empty draft console and does not fall over", async () => {
    const { eventId, host } = await hostedEvent(12, SOLO);
    const markup = await screen(eventId, host, "draft");
    // The Draft tab's own heading is nowhere on the page.
    expect(markup).not.toContain("Draft order");
    expect(markup.length).toBeGreaterThan(500);
  });

  it("says why for the bracket too", async () => {
    const { eventId, host } = await hostedEvent(12, SOLO);
    const markup = await screen(eventId, host, "format");
    expect(selected(markup)).toBe("Setup");
    expect(markup).toContain("Bracket is only for an event with sides");
  });

  it("says nothing when the tab does apply", async () => {
    const { eventId, host } = await hostedEvent(12);
    const markup = await screen(eventId, host, "draft");
    expect(markup).not.toContain("is where that is decided");
  });

  it("hands the panel the counts it needs to refuse (UC-42 2a)", async () => {
    // The teams come off the page's own read, so a solo-bound event with teams
    // already on it shows the discard confirmation rather than a bare switch.
    const { eventId, host } = await hostedEvent(12);
    // Four teams is what the Format panel says first, because since Task 81
    // `setTeamCount` refuses a count the panel contradicts (twelve at six a
    // side would be two).
    unwrap(
      await updateEvent(
        eventId,
        { config: { eventShape: { teamEvent: true, draft: true, sizing: { mode: "teams", value: 4 } } } },
        db
      )
    );
    unwrap(await setTeamCount(eventId, 4, db));
    unwrap(await updateEvent(eventId, { config: SOLO }, db));

    const markup = await screen(eventId, host, "shape");
    expect(markup).toContain("This event already has 4 teams");
  });
});
