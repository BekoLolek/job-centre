import { createHash } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { generateStage } from "@/lib/bracket";
import type { RoundScoring } from "@/lib/events-policy";
import type { FormatView, StageView } from "@/lib/format";
import { DEFAULT_FORMAT_TIMING, normaliseStageConfig } from "@/lib/format-policy";
import { dayMinutes, planBlocks } from "@/lib/format-schedule";
import { blankGamesFor, resolveMatches } from "@/lib/format-resolve";
import type { RoundScoreRow } from "@/lib/round-scoring";
import {
  SETUP_LABELS,
  TAB_KEYS,
  TAB_LABELS,
  type TabVisibility,
  tabHiddenBecause,
  visibleSetup,
} from "../tabs";

/*
 * Task 89 — the night's table on the Results tab (R-231, R-234, R-235 /
 * UC-46 3, 3a, 4a), and the empty state it retires.
 *
 * Three things this file exists to hold:
 *
 *  1. **The table shows the parts, not just the total.** Every scored round and
 *     every bonus is a column beside the total, a player's row is theirs by
 *     name, and the order is the ranking's — with ties and the unplaced put in
 *     a *chosen* order, because `listRoundScores` hands rows back in random
 *     uuid order and a table that re-shuffled tied players between renders
 *     would be a table nobody trusts.
 *  2. **No sentence on a solo event's Results tab names a tab the reader
 *     cannot open.** Swept over the *rendered* markup of every solo state the
 *     tab has, against the hidden tabs read off `tabs.ts` rather than a list
 *     written here — so the test's own literals cannot satisfy it, and a new
 *     team-only tab is swept for without anybody editing this file.
 *  3. **A team event's Results tab is byte-for-byte what it was.** Pinned as a
 *     digest of the markup captured before this task touched the file, for a
 *     bare board and a populated one. A legitimate change to the team board
 *     moves the pin on purpose; nothing moves it by accident.
 *
 * The suite is vitest's `node` environment: nothing clicks. The router and the
 * two action modules are mocked for the reason `results-tab-unresolved.test.ts`
 * mocks them — importing them would drag the session into a markup test.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));
vi.mock("@/app/admin/events/format-actions", () => ({
  recordGamesAction: vi.fn(),
  setWinnerOverrideAction: vi.fn(),
  reflipMatchAction: vi.fn(),
  clearMatchAction: vi.fn(),
}));
vi.mock("@/app/admin/events/actions", () => ({ saveRoundAction: vi.fn() }));

const { default: ResultsTab } = await import("../ResultsTab");
const { default: RoundTable, nightTable } = await import("../RoundTable");

/* --------------------------------------------------------------------- */
/* Fixtures                                                              */
/* --------------------------------------------------------------------- */

const SOLO: TabVisibility = { teamEvent: false, draft: false };
const TEAM: TabVisibility = { teamEvent: true, draft: true };

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
  dee: { displayName: "Dee", avatarUrl: null },
};
const SEATED = ["alice", "bob", "cass", "dee"];
const nameOf = (id: string) => PLAYERS[id as keyof typeof PLAYERS]?.displayName ?? id;

const row = (
  roundIndex: number,
  userId: string,
  score: number,
  bonuses: Record<string, number> = {}
): RoundScoreRow => ({ roundIndex, userId, score, bonuses });

/**
 * Two rounds of six scored, out of order, with Bob missing round 1.
 *
 *  - Alice: 10 + 7 = 17, plus one Gold run (+5) and two Sub-0.5 (+4) → 26.
 *  - Cass: 10 + 7 = 17, no bonuses → 17.
 *  - Bob: blank in round 1 counts as that round's worst recorded score, 10
 *    (R-228), so 10 + 7 = 17. Bob and Cass tie on 17 and share second; nobody
 *    is third.
 *  - Dee holds a seat and has no row anywhere: not placed (Task 86's rule).
 *
 * Handed over *shuffled* — Cass before Alice, round 3 before round 1 — because
 * the order the rows arrive in is the one thing the table must not inherit.
 */
const PARTIAL: RoundScoreRow[] = [
  row(3, "cass", 7),
  row(1, "cass", 10),
  row(3, "bob", 7),
  row(3, "alice", 7, { "Sub-0.5 answer": 2 }),
  row(1, "alice", 10, { "Gold run": 1 }),
];

const EMPTY_BOARD: FormatView = {
  eventId: "event-1",
  teams: [],
  stages: [],
  blocks: [],
  dayMinutes: [],
  timing: DEFAULT_FORMAT_TIMING,
  concurrentLobbies: 1,
  days: 1,
};

/** A three-team Bo1 round robin, every card untouched. Small on purpose. */
function teamBoard(): FormatView {
  const teams = [1, 2, 3].map((n) => ({ id: `team-${n}`, name: `Team ${n}`, seed: n }));
  const spec = generateStage("round_robin", teams.length, normaliseStageConfig("round_robin", { bestOf: 1 }));
  const stage: StageView = {
    id: "stage-1",
    name: "Table",
    kind: "round_robin",
    sort: 0,
    config: spec.config,
    teamCount: teams.length,
    spec,
    matches: resolveMatches({
      stage: spec,
      matches: spec.matches.map((match) => ({
        slot: match.slot,
        bestOf: match.bestOf,
        teamAId: null,
        teamBId: null,
        sourceA: match.sourceA,
        sourceB: match.sourceB,
        scheduledAt: null,
        finishedAt: null,
        durationMin: null,
        winnerOverrideId: null,
        firstSideChoice: "a" as const,
        games: blankGamesFor(match),
      })),
      teams,
      seeds: teams.map((team) => team.id),
    }),
    standings: [],
    groups: [],
    placements: [],
    champion: null,
    seeding: null,
    seeds: teams.map((team) => team.id),
    handEditedAt: null,
    outOfDateSince: null,
  };
  const blocks = planBlocks([spec], {
    timing: DEFAULT_FORMAT_TIMING,
    concurrentLobbies: 2,
    days: 1,
    blockDays: null,
  });
  return {
    eventId: "event-1",
    teams,
    stages: [stage],
    blocks,
    dayMinutes: dayMinutes(blocks),
    timing: DEFAULT_FORMAT_TIMING,
    concurrentLobbies: 2,
    days: 1,
  };
}

type TabProps = Parameters<typeof ResultsTab>[0];

/** The whole tab, a solo event with every seat filled unless told otherwise. */
function tab(over: Partial<TabProps> & { scoring?: RoundScoring | null; rows?: RoundScoreRow[] } = {}): string {
  const { scoring = null, rows = [], ...rest } = over;
  const format = rest.format ?? EMPTY_BOARD;
  return renderToStaticMarkup(
    createElement(ResultsTab, {
      format,
      matchIds: Object.fromEntries(
        format.stages.flatMap((stage) => stage.matches.map((m) => [m.slot, `row-${m.slot}`]))
      ),
      shape: SOLO,
      rounds: { scoring, rows, players: PLAYERS, seated: SEATED, status: "live" },
      ...rest,
    })
  );
}

function table(over: Partial<Parameters<typeof RoundTable>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(RoundTable, {
      scoring: SIX,
      rows: PARTIAL,
      players: PLAYERS,
      seated: SEATED,
      ...over,
    })
  );
}

/** Each `<tr>` of the markup as its cells' text, tags stripped. */
function grid(markup: string): string[][] {
  return (markup.match(/<tr[\s\S]*?<\/tr>/g) ?? []).map((tr) =>
    [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) =>
      cell[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    )
  );
}

/** The markup as a reader sees it: tags gone, React's escaped apostrophe put back. */
const text = (markup: string) =>
  markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const digest = (markup: string) => createHash("sha256").update(markup).digest("hex");

/* --------------------------------------------------------------------- */
/* The table (UC-46 3)                                                   */
/* --------------------------------------------------------------------- */

describe("the night's table", () => {
  it("shows the finishing order with every scored round and every bonus beside the total", () => {
    const [head, ...body] = grid(table());
    expect(head).toEqual(["", "Player", "Round 1", "Semis", "Sub-0.5 answer +2", "Gold run +5", "Total"]);
    expect(body).toEqual([
      ["1", "Alice", "10", "7", "×2", "×1", "26"],
      ["2", "Bob", "—", "7", "—", "—", "17"],
      ["2", "Cass", "10", "7", "—", "—", "17"],
      ["—", "Dee Not scored in any round", "—", "—", "—", "—", "—"],
    ]);
  });

  it("gives a participant their own rounds on the row that carries their name", () => {
    // R-235 proper is the public page's (Task 90). What the admin table owes a
    // participant reading over the manager's shoulder is that their rounds are
    // on *their* row and nobody else's — which is what a row per player means.
    const rows = grid(table()).slice(1);
    const alice = rows.find((cells) => cells[1] === "Alice");
    const cass = rows.find((cells) => cells[1] === "Cass");
    expect(alice?.slice(2, 6)).toEqual(["10", "7", "×2", "×1"]);
    expect(cass?.slice(2, 6)).toEqual(["10", "7", "—", "—"]);
  });

  it("names the rounds the manager named and numbers the rest, in round order whatever order the rows came in", () => {
    const [head] = grid(table({ rows: [row(6, "alice", 1), row(2, "alice", 1), row(4, "alice", 1)] }));
    expect(head.slice(2, 5)).toEqual(["Round 2", "Round 4", "Final"]);
  });

  it("says how many rounds the table covers on a partly-scored night (3a)", () => {
    expect(text(table())).toContain("Covers 2 of 6 rounds so far — the order as it stands.");
  });

  it("says every round is in once they are", () => {
    const full = [1, 2, 3, 4, 5, 6].flatMap((round) => [row(round, "alice", 1), row(round, "bob", 2)]);
    const markup = table({ rows: full });
    expect(text(markup)).toContain("Covers all 6 rounds.");
    expect(text(markup)).not.toContain("so far");
  });

  it("says nothing is scored yet rather than drawing a table with a header (4a)", () => {
    const markup = table({ rows: [] });
    expect(text(markup)).toContain(
      "Nothing is scored yet. Save a round above and the table appears here — every round and every bonus beside the total."
    );
    expect(markup).not.toContain("<table");
    expect(markup).not.toContain("Covers");
  });

  it("explains a dash only when there is one to explain (R-228)", () => {
    // Bob's blank in round 1 counts as 10, so his visible row sums to 7 against
    // a total of 17 — the one case a reader checking the arithmetic needs told.
    const explained =
      "A dash is a round the player did not play. It counts as the worst score anybody recorded in that round, so a total can differ from the row's visible sum.";
    expect(text(table())).toContain(explained);
    expect(text(table({ rows: [row(1, "alice", 3), row(1, "bob", 4)] }))).not.toContain(explained);
  });

  it("says which way the night scores, so a low-wins table does not read upside down", () => {
    expect(text(table())).toContain("6 rounds, highest total wins, 2 bonuses");
    const low = table({ scoring: { ...SIX, lowWins: true } });
    expect(text(low)).toContain("lowest total wins");
    // And a bonus is shown as the points it takes off, not adds.
    expect(grid(low)[0]).toContain("Gold run −5");
  });

  it("draws no bonus columns on a night with no bonuses", () => {
    const [head] = grid(table({ scoring: { ...SIX, bonuses: [] } }));
    expect(head).toEqual(["", "Player", "Round 1", "Semis", "Total"]);
  });

  it("names a former member rather than printing an id", () => {
    const markup = table({ rows: [row(1, "ghost", 4)], players: {}, seated: [] });
    expect(markup).toContain("A former member");
    expect(markup).not.toContain("ghost");
  });

  it("scrolls sideways inside its own panel rather than widening the page (400px, structural)", () => {
    // No browser in this suite, so this is the shape and not a measurement:
    // the table is the widest thing on the site — a column per round and per
    // bonus — and the sheet above it already moved names to their own line for
    // the same reason. The wrapper is the one `StandingsTable` uses.
    const markup = table();
    expect(markup).toMatch(/class="[^"]*overflow-x-auto[^"]*"[^>]*><table/);
    expect(markup).toMatch(/<table class="[^"]*whitespace-nowrap/);
  });
});

/* --------------------------------------------------------------------- */
/* The order is chosen, not inherited                                    */
/* --------------------------------------------------------------------- */

describe("the table's order", () => {
  const seated = ["dee", "cass", "bob", "alice"];

  it("ranks by position, breaks a shared place by name, and puts the unplaced last by name", () => {
    const { rounds, lines } = nightTable(SIX, PARTIAL, seated, nameOf);
    expect(rounds).toEqual([1, 3]);
    expect(lines.map((line) => [line.userId, line.position, line.total])).toEqual([
      ["alice", 1, 26],
      ["bob", 2, 17],
      ["cass", 2, 17],
      ["dee", null, null],
    ]);
  });

  it("gives the same order whatever order the rows arrive in", () => {
    // The uuid trap: a round's rows have no stable order from the database.
    const forwards = nightTable(SIX, PARTIAL, seated, nameOf).lines.map((line) => line.userId);
    const backwards = nightTable(SIX, [...PARTIAL].reverse(), seated, nameOf).lines.map((line) => line.userId);
    expect(backwards).toEqual(forwards);
  });

  it("keeps a recorded player who has lost their seat, and counts a seated one without rows as unplaced", () => {
    const { lines } = nightTable(SIX, [row(1, "cass", 4)], ["alice"], nameOf);
    expect(lines.map((line) => [line.userId, line.position])).toEqual([
      ["cass", 1],
      ["alice", null],
    ]);
  });

  it("files a player's rows by round and adds their awards up across rounds", () => {
    const alice = nightTable(SIX, PARTIAL, seated, nameOf).lines[0];
    expect([...alice.byRound.keys()].sort()).toEqual([1, 3]);
    expect(alice.byRound.get(1)?.score).toBe(10);
    expect(Object.fromEntries(alice.bonuses)).toEqual({ "Sub-0.5 answer": 2, "Gold run": 1 });
  });
});

/* --------------------------------------------------------------------- */
/* The Results tab's three empty states                                  */
/* --------------------------------------------------------------------- */

describe("the Results tab on a solo event", () => {
  it("says a night with no scoring setup has no matches to record, and points at the Scoring panel it does have", () => {
    const markup = tab({ scoring: null });
    expect(text(markup)).toContain(
      `This event has no sides, so there are no matches to record. To score it in rounds, set that up under ${TAB_LABELS.setup} → ${SETUP_LABELS.scoring}, and the night's table appears here.`
    );
    // The place it names is one a solo event actually has.
    expect(visibleSetup(SOLO)).toContain("scoring");
    expect(markup).not.toContain("No matches yet");
  });

  it("shows the sheet and, under it, the nothing-scored sentence for a round-scored night nobody has scored", () => {
    const markup = tab({ scoring: SIX, rows: [] });
    expect(markup).toContain('aria-label="Alice&#x27;s score"');
    expect(text(markup)).toContain("Nothing is scored yet.");
    expect(markup).not.toContain("<table");
    expect(markup.indexOf("Save Round 1")).toBeLessThan(markup.indexOf("Nothing is scored yet."));
  });

  it("shows the sheet and the table as it stands for a partly-scored night", () => {
    const markup = tab({ scoring: SIX, rows: PARTIAL });
    expect(markup).toContain('aria-label="Alice&#x27;s score"');
    expect(text(markup)).toContain("Covers 2 of 6 rounds so far");
    expect(grid(markup).slice(1).map((cells) => cells[1])).toEqual([
      "Alice",
      "Bob",
      "Cass",
      "Dee Not scored in any round",
    ]);
  });
});

/* --------------------------------------------------------------------- */
/* The sweep (criterion 5)                                               */
/* --------------------------------------------------------------------- */

describe("no sentence on a solo event's Results tab names a tab the reader cannot open", () => {
  /**
   * Read off the module, not written here: the labels of every tab
   * `tabHiddenBecause` hides for a solo event. The retired sentence's own
   * phrase is swept for separately — the bracket step was called "Format"
   * before Task 79 relabelled it, and "Format tab" is the exact phrase this
   * task retires; "Format" alone is the Setup panel, which a solo event has.
   */
  const hidden = TAB_KEYS.filter((key) => tabHiddenBecause(key, SOLO) !== null).map((key) => TAB_LABELS[key]);

  /** Every state the tab has for a solo event, reachable from props. */
  const states: Record<string, () => string> = {
    "no scoring setup": () => tab({ scoring: null }),
    "round-scored, nothing scored": () => tab({ scoring: SIX, rows: [] }),
    "round-scored, partly scored": () => tab({ scoring: SIX, rows: PARTIAL }),
    "round-scored, every round in": () =>
      tab({ scoring: SIX, rows: [1, 2, 3, 4, 5, 6].map((round) => row(round, "alice", 1)) }),
    "round-scored, nobody seated": () =>
      tab({ rounds: { scoring: SIX, rows: [], players: {}, seated: [], status: "live" } }),
    "round-scored, finished event": () =>
      tab({ rounds: { scoring: SIX, rows: PARTIAL, players: PLAYERS, seated: ["alice"], status: "complete" } }),
  };

  it("has a list to sweep for, and states to sweep", () => {
    // Floors, so an empty scan fails rather than passes (Task 31's lesson).
    expect(hidden.length).toBeGreaterThanOrEqual(4);
    expect(hidden).toContain("Bracket");
    expect(Object.keys(states).length).toBeGreaterThanOrEqual(6);
  });

  for (const [name, render] of Object.entries(states)) {
    it(`names no hidden tab when ${name}`, () => {
      const seen = text(render());
      expect(seen.length).toBeGreaterThan(100);
      for (const label of hidden) {
        expect(seen, `"${label}" on a solo event's Results tab (${name})`).not.toMatch(
          new RegExp(`\\b${label}\\b`, "i")
        );
      }
      expect(seen, `the retired sentence's phrase (${name})`).not.toMatch(/Format tab/i);
    });
  }
});

/* --------------------------------------------------------------------- */
/* A team event is untouched (criterion 6)                               */
/* --------------------------------------------------------------------- */

describe("a team event's Results tab", () => {
  /*
   * Captured from the file as it stood before Task 89 touched it, as the
   * sha256 of `renderToStaticMarkup`'s output over exactly the fixtures above
   * (310 and 5679 bytes of markup) — a fixture that cannot drift. Pinned
   * rather than eyeballed: "renders exactly as it does today" is a claim
   * about bytes.
   */
  const BEFORE = {
    empty: "62d1999204f84e271cfb8e1b4e4a9e8f927527967583fd06059b5c6829b0fe3b",
    board: "5567be8c13ee4f23bac96deb4408a1cdb4eb0d1ce4cf8e5d9e74d8924706d7c3",
  };

  it("keeps the empty state it had, word for word", () => {
    const markup = tab({ shape: TEAM, scoring: null });
    expect(text(markup)).toContain(
      "No matches yet. Choose a format and generate them on the Format tab — the cards here are the generated matches, not something typed in twice."
    );
    expect(digest(markup)).toBe(BEFORE.empty);
  });

  it("renders a populated board exactly as it did", () => {
    const markup = tab({ shape: TEAM, scoring: null, format: teamBoard() });
    expect(markup).toContain("Record result");
    expect(digest(markup)).toBe(BEFORE.board);
  });

  it("gets the table beside the sheet when somebody did set one up to score in rounds (UC-42 5b)", () => {
    // Hiding the Scoring panel is not forbidding its save. A team event with a
    // stored setup already got the sheet above its board; a sheet whose total
    // nobody can see the parts of is the thing R-234 exists to prevent.
    const markup = tab({ shape: TEAM, scoring: SIX, rows: PARTIAL, format: teamBoard() });
    expect(markup).toContain('aria-label="Alice&#x27;s score"');
    expect(text(markup)).toContain("Covers 2 of 6 rounds so far");
    expect(markup).toContain("Record result");
  });
});
