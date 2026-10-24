import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type Database, type EventConfig, eventRoundScores } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";

/*
 * Task 87 on the screen — R-225, R-226, R-229 / UC-44 1-6, 6b.
 *
 * As `shape-panel.test.ts`: half of this file renders the *page*, because the
 * failure worth catching is a panel that is persisted and reachable by URL and
 * absent from the Setup rail — Task 80 found exactly that, because every test
 * arrived by URL. So the rail's items are read off the markup the real
 * `AdminEventPage` built and compared with `SETUP_KEYS`.
 *
 * The suite is vitest's `node` environment: nothing here clicks. What is
 * asserted is the state that arrives, and every decision behind it is held
 * directly in `scoring-tabs.test.ts` and `round-scoring-setup.test.ts`.
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
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

const { SETUP_KEYS, SETUP_LABELS, visibleSetup } = await import("../tabs");
const { default: ScoringTab } = await import("../ScoringTab");
const { default: EventEditor } = await import("../EventEditor");
const { default: AdminEventPage } = await import("@/app/admin/events/[id]/page");
const { applyToEvent, createEvent, publishEvent, updateEvent } = await import("@/lib/events");
const { eventShapeFrom, roundScoringFrom } = await import("@/lib/events-policy");
const { MAX_ROUNDS } = await import("@/lib/round-scoring");

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

const SOLO: EventConfig = {
  eventShape: { teamEvent: false, draft: false, sizing: { mode: "perTeam", value: 6 } },
};

const SIX = {
  rounds: [{ name: null }, { name: null }, { name: "Semis" }, { name: null }, { name: null }, { name: "Final" }],
  lowWins: false,
  bonuses: [
    { key: "Sub-0.5 answer", value: 2 },
    { key: "Gold run", value: 5 },
  ],
};

/** A published event with `accepted` accepted applicants and a host reading it. */
async function hostedEvent(accepted: number, config?: EventConfig) {
  counter += 1;
  const event = unwrap(
    await createEvent({ ...PUBLISHABLE, title: `Scoring ${counter}`, capacity: 64 }, db)
  );
  unwrap(await publishEvent(event.id, db));
  const members: string[] = [];
  for (let index = 0; index < accepted; index += 1) {
    const userId = await makeUser(db, { displayName: `Scorer ${counter}-${index}` });
    unwrap(await applyToEvent(event.id, userId, {}, db));
    members.push(userId);
  }
  if (config) unwrap(await updateEvent(event.id, { config }, db));
  const host = await makeUser(db, { displayName: `Host ${counter}` });
  await makeHost(db, event.id, host);
  return { eventId: event.id, host, members };
}

/* --------------------------------------------------------------------- */
/* The panel itself (UC-44 1-5)                                          */
/* --------------------------------------------------------------------- */

function panel(
  over: Partial<Parameters<typeof ScoringTab>[0]> & { config?: EventConfig } = {}
): string {
  const { config, ...rest } = over;
  return renderToStaticMarkup(
    createElement(ScoringTab, {
      eventId: "event-1",
      scoring: roundScoringFrom(config ?? {}),
      rows: [],
      players: {},
      ...rest,
    })
  );
}

describe("the Scoring panel", () => {
  it("asks the three questions, in order", () => {
    const markup = panel();
    const rounds = markup.indexOf("How many rounds?");
    const direction = markup.indexOf("Which way is a round won?");
    const bonuses = markup.indexOf("What are the bonuses?");
    expect(rounds).toBeGreaterThan(-1);
    expect(direction).toBeGreaterThan(rounds);
    expect(bonuses).toBeGreaterThan(direction);
  });

  it("says a night nobody has set up is not scored in rounds yet, and opens on the defaults", () => {
    const markup = panel();
    expect(markup).toContain("not scored in rounds yet");
    expect(markup).toContain("1 round, highest total wins, no bonuses");
  });

  it("opens on the stored setup rather than the defaults (UC-44 6a)", () => {
    // R-237: a template carries `config`, so an event made from one arrives
    // here with the key already present.
    const markup = panel({ config: { roundScoring: SIX } });
    expect(markup).toContain("6 rounds, highest total wins, 2 bonuses");
    expect(markup).not.toContain("not scored in rounds yet");
    expect(markup).toContain('value="Semis"');
    expect(markup).toContain('value="Final"');
    expect(markup).toContain('value="Sub-0.5 answer"');
  });

  it("states what it will do with the choices, and that a blank round counts as the worst score (UC-44 5)", () => {
    const markup = panel({ config: { roundScoring: { ...SIX, lowWins: true } } });
    expect(markup).toContain("6 rounds, lowest total wins, 2 bonuses");
    expect(markup).toContain("worst score");
  });

  it("labels each round by its position and never repeats that as its own hint", () => {
    // `dayLabel`'s rule: a field labelled by position must not show "Round 2"
    // twice. The name box for an unnamed round carries no value and no hint
    // reading "Round 2".
    const markup = panel({ config: { roundScoring: SIX } });
    expect(markup).toContain("Round 1");
    expect(markup).toContain("Round 6");
    expect(markup).not.toContain('value="Round 1"');
    expect(markup).not.toContain('placeholder="Round');
  });

  it("offers one box per round name, one per bonus name and value, and the round counter — nothing derived", () => {
    const markup = panel({ config: { roundScoring: SIX } });
    const boxes = markup.match(/<input/g) ?? [];
    // 6 round names + 2 bonus names + 2 bonus values + the counter's own input.
    expect(boxes.length).toBe(6 + 2 + 2 + 1);
  });

  it("caps the round counter at the table's bound", () => {
    expect(panel()).toContain(`max="${MAX_ROUNDS}"`);
  });

  it("shows no bonus boxes when there are none, and says so (UC-44 4a)", () => {
    const markup = panel();
    expect(markup).toContain("No bonuses yet");
    expect(markup).not.toContain('placeholder="Sub-0.5 answer"');
  });

  it("shows a refusal on the panel rather than waiting for the server", () => {
    const markup = panel({
      config: {
        roundScoring: { ...SIX, bonuses: [{ key: "Fast", value: 2 }, { key: "Fast", value: 3 }] },
      },
    });
    expect(markup).toContain("Two bonuses are called &quot;Fast&quot;");
  });

  it("shows a bonus worth nothing as the refusal it is (UC-44 4c)", () => {
    const markup = panel({
      config: { roundScoring: { ...SIX, bonuses: [{ key: "Fast", value: 0 }] } },
    });
    expect(markup).toContain("&quot;Fast&quot; has to be worth at least a point");
  });

  it("names what a save would discard, and asks for the box to be ticked (UC-44 2b, 4d)", () => {
    /*
     * The confirm states are reached by editing, which this suite cannot do.
     * What it can render is the same decision over rows that disagree with
     * the stored setup — scores in a round the count no longer has, and an
     * award carrying a bonus the setup no longer defines — which is the state a
     * lowered count or a deleted bonus puts the panel in one edit later. The
     * decision itself is held over every combination in
     * `round-scoring-setup.test.ts`; this proves the panel prints it.
     */
    const markup = panel({
      config: { roundScoring: { ...SIX, rounds: SIX.rounds.slice(0, 2) } },
      rows: [
        { roundIndex: 1, userId: "alice", score: 10, bonuses: { Clutch: 2 } },
        { roundIndex: 5, userId: "bob", score: 7, bonuses: {} },
      ],
      players: { alice: { displayName: "Alice", avatarUrl: null } },
    });
    expect(markup).toContain("Cutting the night to 2 rounds discards 1 score, from Round 5.");
    expect(markup).toContain("Dropping &quot;Clutch&quot; takes back 2 awards, from Alice (x2).");
    expect(markup).toContain("Tick the box below to go ahead");
    expect(markup).toContain('type="checkbox"');
  });

  it("offers no confirmation when nothing would be lost", () => {
    const markup = panel({
      config: { roundScoring: SIX },
      rows: [{ roundIndex: 1, userId: "alice", score: 10, bonuses: { "Gold run": 1 } }],
    });
    expect(markup).not.toContain("Tick the box below");
    expect(markup).not.toContain('type="checkbox"');
  });
});

/* --------------------------------------------------------------------- */
/* The page builds the editor (UC-44 1, 6b)                              */
/* --------------------------------------------------------------------- */

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

function selected(markup: string): string | null {
  return /aria-selected="true"[^>]*>\s*<span>([^<]+)<\/span>/.exec(markup)?.[1] ?? null;
}

/** The Setup sub-rail's items, in the order it draws them — see `shape-panel.test.ts`. */
function setupRail(markup: string): string[] {
  const list = /aria-label="Setup"([\s\S]*?)<\/div>/.exec(markup)?.[1] ?? "";
  return [...list.matchAll(/<span class="text-13">([^<]+)<\/span>/g)].map((hit) => hit[1]);
}

describe("the rail the page builds", () => {
  it("offers every panel, Scoring last, on a solo event — read off SETUP_KEYS", async () => {
    /*
     * Reachability, not persistence: a panel only a hand-typed `?tab=scoring`
     * reaches is Task 84's unreachable page one floor up. The expected list is
     * the module's, so the panel cannot be persisted and forgotten here.
     */
    const { eventId, host } = await hostedEvent(4, SOLO);
    const markup = await screen(eventId, host);
    expect(setupRail(markup)).toEqual(SETUP_KEYS.map((key) => SETUP_LABELS[key]));
    expect(setupRail(markup)).toContain("Scoring");
    expect(setupRail(markup).length).toBe(7);
  });

  it("does not offer Scoring on a team event (UC-44 6b)", async () => {
    const { eventId, host } = await hostedEvent(4);
    const markup = await screen(eventId, host);
    const shape = eventShapeFrom({});
    expect(shape.teamEvent).toBe(true);
    expect(setupRail(markup)).toEqual(visibleSetup(shape).map((key) => SETUP_LABELS[key]));
    expect(setupRail(markup)).not.toContain("Scoring");
    // The rest of Setup is whole.
    expect(setupRail(markup)).toContain("Format");
    expect(setupRail(markup)).toContain("Basics");
  });

  it("reaches the panel for ?tab=scoring on a solo event", async () => {
    const { eventId, host } = await hostedEvent(4, SOLO);
    const markup = await screen(eventId, host, "scoring");
    expect(selected(markup)).toBe("Setup");
    expect(markup).toContain("How many rounds?");
  });

  it("hands the panel the stored setup and the rows the page read", async () => {
    const { eventId, host, members } = await hostedEvent(4, {
      ...SOLO,
      roundScoring: { ...SIX, rounds: SIX.rounds.slice(0, 2) },
    });
    // Rows the page must read for the panel to be able to refuse (UC-44 2b).
    await db
      .insert(eventRoundScores)
      .values({ eventId, roundIndex: 4, userId: members[0], score: 3, bonuses: {} });

    const markup = await screen(eventId, host, "scoring");
    expect(markup).toContain("2 rounds, highest total wins, 2 bonuses");
    expect(markup).toContain("Cutting the night to 2 rounds discards 1 score, from Round 4.");
  });

  it("lands ?tab=scoring on a team event on Setup → Format, and says why", async () => {
    const { eventId, host } = await hostedEvent(4);
    const markup = await screen(eventId, host, "scoring");
    expect(selected(markup)).toBe("Setup");
    expect(markup).toContain("Does it have teams?");
    expect(markup).toContain("Scoring is only for an event with no sides");
    expect(markup).not.toContain("How many rounds?");
  });

  it("says nothing when the panel does apply", async () => {
    const { eventId, host } = await hostedEvent(4, SOLO);
    const markup = await screen(eventId, host, "scoring");
    expect(markup).not.toContain("is where that is decided");
  });
});
