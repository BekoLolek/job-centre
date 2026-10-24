import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { type Database, type EventConfig, applications, eventRoundScores } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeHost, makeUser } from "@/db/__tests__/helpers";
import type { RoundScoring } from "@/lib/events-policy";
import type { RoundScoreRow } from "@/lib/round-scoring";

/*
 * Task 88 on the screen — R-224, R-227, R-230 / UC-45 1, 2, 3e, 4c, 5a.
 *
 * As `scoring-panel.test.ts`: half of this file renders the sheet from props,
 * and the other half renders the *page*, because the failure worth catching is
 * a screen that works in isolation and is never reached — `ResultsTab` took
 * only `format` and `matchIds` before this task, and the plumbing through
 * `EventEditor` is the part a component test cannot see.
 *
 * The suite is vitest's `node` environment: nothing here types or clicks. What
 * is asserted is the state that arrives — who is listed, with which boxes,
 * seeded with what — and the decisions behind a save are pure functions held
 * in `round-entries.test.ts` and, for the two the sheet owns (what a stored
 * row becomes on screen and what the screen sends back), here.
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

const { default: RoundScores, roundEntriesFrom, roundFormFrom, sheetPlayers } = await import(
  "../RoundScores"
);
const { default: ResultsTab } = await import("../ResultsTab");
const { default: EventEditor } = await import("../EventEditor");
const { default: AdminEventPage } = await import("@/app/admin/events/[id]/page");
const { applyToEvent, createEvent, publishEvent, updateEvent } = await import("@/lib/events");
const { LOCKED_REFUSAL } = await import("@/lib/archive-policy");
const { scheduleSettingsFrom } = await import("@/lib/format");

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

const SIX: RoundScoring = {
  rounds: [{ name: null }, { name: null }, { name: "Semis" }, { name: null }, { name: null }, { name: "Final" }],
  lowWins: false,
  bonuses: [
    { key: "Sub-0.5 answer", value: 2 },
    { key: "Gold run", value: 5 },
  ],
};

const PLAYERS = {
  alice: { displayName: "Alice", avatarUrl: null },
  bob: { displayName: "Bob", avatarUrl: null },
  cass: { displayName: "Cass", avatarUrl: null },
};

const row = (
  roundIndex: number,
  userId: string,
  score: number,
  bonuses: Record<string, number> = {}
): RoundScoreRow => ({ roundIndex, userId, score, bonuses });

/* --------------------------------------------------------------------- */
/* The sheet itself (UC-45 1, 2, 3e, 4c, 5a)                             */
/* --------------------------------------------------------------------- */

function sheet(over: Partial<Parameters<typeof RoundScores>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(RoundScores, {
      eventId: "event-1",
      scoring: SIX,
      rows: [],
      players: PLAYERS,
      seated: ["alice", "bob", "cass"],
      status: "live",
      ...over,
    })
  );
}

const count = (markup: string, needle: string) => markup.split(needle).length - 1;
/** The tail of a score box's label — one per listed player, and nowhere else. */
const SCORE_BOX = '&#x27;s score"';

describe("the round sheet", () => {
  it("lists every accepted applicant by name with one score box each (UC-45 2)", () => {
    const markup = sheet();
    for (const name of ["Alice", "Bob", "Cass"]) {
      expect(markup).toContain(name);
      expect(count(markup, `aria-label="${name}&#x27;s score"`)).toBe(1);
    }
    // Counted, not merely present: three players, three boxes. The closing
    // quote keeps the intro's "each player's score" out of the count.
    expect(count(markup, SCORE_BOX)).toBe(3);
  });

  it("puts the night's bonuses beside each player, one box per bonus per player", () => {
    const markup = sheet();
    expect(count(markup, 'aria-label="Sub-0.5 answer for ')).toBe(3);
    expect(count(markup, 'aria-label="Gold run for ')).toBe(3);
  });

  it("shows no bonus boxes on a night with no bonuses (UC-44 4a)", () => {
    const markup = sheet({ scoring: { ...SIX, bonuses: [] } });
    expect(count(markup, " for Alice")).toBe(0);
    expect(count(markup, SCORE_BOX)).toBe(3);
  });

  it("opens on the stored round: a score as its value, an award as its count, a blank as empty", () => {
    const markup = sheet({
      rows: [row(1, "alice", 10, { "Gold run": 2 }), row(1, "bob", 7)],
    });
    expect(markup).toContain('value="10"');
    expect(markup).toContain('value="7"');
    expect(markup).toContain('value="2"');
    // Cass did not play: her box is empty and says so.
    expect(markup).toContain('placeholder="Blank"');
  });

  it("names every round on the picker by the manager's name or Round N, counting who is scored", () => {
    const markup = sheet({ rows: [row(1, "alice", 10), row(1, "bob", 7), row(6, "cass", 3)] });
    for (const label of ["Round 1", "Round 2", "Semis", "Round 4", "Round 5", "Final"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("2/6 scored");
  });

  it("keeps a recorded player on the sheet after they lose their seat, and says so (5a's mirror)", () => {
    // Somebody accepted after a round was scored appears blank (5a); somebody
    // scored and then withdrawn stays, because a save that silently dropped
    // their row is the quiet destruction this codebase refuses.
    const markup = sheet({ seated: ["alice", "bob"], rows: [row(1, "cass", 4)] });
    expect(markup).toContain("Cass");
    expect(count(markup, SCORE_BOX)).toBe(3);
    expect(markup).toContain("No seat now, still scored here");
  });

  it("says who can be scored and points at Applicants (3e)", () => {
    const markup = sheet();
    expect(markup).toContain(
      "Only somebody holding a seat can be scored. If somebody played who is not listed, accept them on Applicants first."
    );
  });

  it("says nobody holds a seat yet, pointing at Applicants, rather than drawing an empty sheet", () => {
    const markup = sheet({ seated: [] });
    expect(markup).toContain("Nobody holds a seat yet. Accept applicants on Applicants and they appear here, one line each.");
    expect(count(markup, SCORE_BOX)).toBe(0);
  });

  it("says a finished event is locked, with the sentence every finished-event write uses, and offers no box to type in (4c)", () => {
    const markup = sheet({ status: "complete" });
    expect(markup).toContain(LOCKED_REFUSAL);
    // Every input disabled: 3 scores + 6 bonus boxes.
    expect(count(markup, 'disabled=""')).toBe(9);
    expect(sheet()).not.toContain('disabled=""');
  });

  it("names a former member rather than printing an id", () => {
    const markup = sheet({ seated: ["alice", "ghost"], players: { alice: PLAYERS.alice } });
    expect(markup).toContain("A former member");
    expect(markup).not.toContain("ghost");
  });
});

/* --------------------------------------------------------------------- */
/* The two decisions the sheet owns                                      */
/* --------------------------------------------------------------------- */

describe("what a stored round becomes on screen, and what the screen sends back", () => {
  it("seeds a score as text and a count as text, and nothing for a player with no row", () => {
    const form = roundFormFrom([row(1, "alice", 10, { "Gold run": 2 })]);
    expect(form).toEqual({ alice: { score: "10", bonuses: { "Gold run": "2" } } });
    expect(form.bob).toBeUndefined();
  });

  it("sends a blank as null, never as zero (R-228)", () => {
    const entries = roundEntriesFrom(["alice", "bob"], {
      alice: { score: "  ", bonuses: {} },
    });
    expect(entries).toEqual([
      { userId: "alice", score: null, bonuses: {} },
      { userId: "bob", score: null, bonuses: {} },
    ]);
  });

  it("sends a typed score as the number typed, so the whole-number rule sees 7.5 and not 7", () => {
    const [line] = roundEntriesFrom(["alice"], { alice: { score: "7.5", bonuses: {} } });
    expect(line.score).toBe(7.5);
    expect(roundEntriesFrom(["alice"], { alice: { score: "-3", bonuses: {} } })[0].score).toBe(-3);
    expect(roundEntriesFrom(["alice"], { alice: { score: "1o", bonuses: {} } })[0].score).toBeNaN();
  });

  it("sends only the awards given: an empty or zero count is no award, a count is sent as typed", () => {
    const [line] = roundEntriesFrom(["alice"], {
      alice: { score: "10", bonuses: { "Gold run": "0", "Sub-0.5 answer": "2", Clutch: "" } },
    });
    expect(line.bonuses).toEqual({ "Sub-0.5 answer": 2 });
    // A fraction is sent, so the count rule refuses it by name rather than the
    // screen rounding it into an award nobody typed.
    expect(roundEntriesFrom(["alice"], { alice: { score: "1", bonuses: { "Gold run": "1.5" } } })[0].bonuses).toEqual({
      "Gold run": 1.5,
    });
  });

  it("lists the seated and the recorded, once each, by name", () => {
    const nameOf = (id: string) => ({ alice: "Alice", bob: "Bob", cass: "Cass" })[id] ?? id;
    expect(sheetPlayers(["cass", "alice"], [row(1, "alice", 1), row(1, "bob", 2)], nameOf)).toEqual([
      "alice",
      "bob",
      "cass",
    ]);
    expect(sheetPlayers([], [], nameOf)).toEqual([]);
  });
});

/* --------------------------------------------------------------------- */
/* The Results tab hands over to it (plumbing)                           */
/* --------------------------------------------------------------------- */

const EMPTY_BOARD = {
  eventId: "event-1",
  teams: [],
  stages: [],
  blocks: [],
  dayMinutes: [],
  timing: scheduleSettingsFrom(null).timing,
  concurrentLobbies: 1,
  days: 1,
};

function resultsTab(scoring: RoundScoring | null): string {
  return renderToStaticMarkup(
    createElement(ResultsTab, {
      format: EMPTY_BOARD,
      matchIds: {},
      rounds: { scoring, rows: [], players: PLAYERS, seated: ["alice"], status: "live" },
    })
  );
}

describe("the Results tab", () => {
  it("shows the round sheet for a round-scored night", () => {
    const markup = resultsTab(SIX);
    expect(markup).toContain('aria-label="Alice&#x27;s score"');
    expect(markup).not.toContain("No matches yet");
  });

  it("is exactly what it was for a night that is not round-scored — Task 89's empty state, untouched", () => {
    const markup = resultsTab(null);
    expect(markup).toContain("No matches yet");
    expect(markup).not.toContain(SCORE_BOX);
  });
});

/* --------------------------------------------------------------------- */
/* The page builds it (UC-45 1)                                          */
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

async function hostedEvent(accepted: number, config: EventConfig) {
  counter += 1;
  const event = unwrap(
    await createEvent({ ...PUBLISHABLE, title: `Rounds ${counter}`, capacity: 64 }, db)
  );
  unwrap(await publishEvent(event.id, db));
  const members: string[] = [];
  const names: string[] = [];
  for (let index = 0; index < accepted; index += 1) {
    const name = `Scorer ${counter}-${index}`;
    const userId = await makeUser(db, { displayName: name });
    unwrap(await applyToEvent(event.id, userId, {}, db));
    members.push(userId);
    names.push(name);
  }
  unwrap(await updateEvent(event.id, { config }, db));
  const host = await makeUser(db, { displayName: `Host ${counter}` });
  await makeHost(db, event.id, host);
  return { eventId: event.id, host, members, names };
}

async function screen(eventId: string, host: string, tab: string) {
  state.userId = host;
  const tree = await AdminEventPage({
    params: Promise.resolve({ id: eventId }),
    searchParams: Promise.resolve({ tab }),
  });
  const editor = findElement(tree, EventEditor);
  expect(editor, "the page no longer renders the event editor").not.toBeNull();
  return renderToStaticMarkup(editor!);
}

describe("the page", () => {
  it("reaches the sheet on Results for a round-scored solo night, listing the accepted applicants with the stored round", async () => {
    const { eventId, host, members, names } = await hostedEvent(3, {
      ...SOLO,
      roundScoring: { rounds: [...SIX.rounds], lowWins: SIX.lowWins, bonuses: [...SIX.bonuses] },
    });
    await db
      .insert(eventRoundScores)
      .values({ eventId, roundIndex: 1, userId: members[0], score: 12, bonuses: { "Gold run": 1 } });
    // Somebody in the queue holds no seat, so they get no line (UC-45 pre 3).
    const queued = await makeUser(db, { displayName: `Queued ${counter}` });
    unwrap(await applyToEvent(eventId, queued, {}, db));
    await db
      .update(applications)
      .set({ status: "waitlisted", waitlistPosition: 1 })
      .where(and(eq(applications.eventId, eventId), eq(applications.userId, queued)));

    const markup = await screen(eventId, host, "results");
    for (const name of names) expect(markup).toContain(`aria-label="${name}&#x27;s score"`);
    expect(markup).not.toContain(`aria-label="Queued ${counter}&#x27;s score"`);
    expect(count(markup, SCORE_BOX)).toBe(3);
    expect(markup).toContain('value="12"');
    expect(markup).toContain("1/6 scored");
    expect(markup).not.toContain("No matches yet");
  });

  it("leaves a solo night that is not round-scored on the empty state it had", async () => {
    const { eventId, host } = await hostedEvent(2, SOLO);
    const markup = await screen(eventId, host, "results");
    expect(markup).toContain("No matches yet");
    expect(markup).not.toContain(SCORE_BOX);
  });
});
