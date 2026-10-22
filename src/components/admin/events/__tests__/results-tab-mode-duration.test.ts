import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { generateStage } from "@/lib/bracket";
import type { FormatView, StageView } from "@/lib/format";
import { DEFAULT_FORMAT_TIMING, normaliseStageConfig } from "@/lib/format-policy";
import { dayMinutes, planBlocks } from "@/lib/format-schedule";
import { type MatchRecord, blankGamesFor, resolveMatches } from "@/lib/format-resolve";

/*
 * Recording the mode a map was played on, and how long the match took —
 * UC-19 E1 and E3.
 *
 * Both are *this screen's* half of a feature the server already had. The patch
 * type has carried `mode` since the engine was written and `recordGames` stores
 * it; the card had no field for it, so R-153's "record which mode each map was"
 * was unreachable, and nothing on the screen said what the minutes box did to
 * the rest of the day.
 *
 * ## Why the payload is a function
 *
 * `renderToStaticMarkup` runs no handlers, so there is no way to press Save in
 * a node test. `recordFieldsFrom` is therefore exported and called directly —
 * the same reason `FlaggedAlert` is exported in
 * `results-tab-unresolved.test.ts`. It is also where the third bug was: the
 * card posted its own start time on every save, and `recordGamesAction` reads
 * a *present* `scheduledAt` as a hand move.
 *
 * The router and the action module are mocked for the reason that file mocks
 * them: importing the actions would drag the database and the session into a
 * node test that only wants markup.
 */

const actions = vi.hoisted(() => ({
  recordGamesAction: vi.fn(),
  setWinnerOverrideAction: vi.fn(),
  reflipMatchAction: vi.fn(),
  clearMatchAction: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

vi.mock("@/app/admin/events/format-actions", () => actions);

const { default: ResultsTab, MatchEditor, draftFrom, recordFieldsFrom } = await import(
  "../ResultsTab"
);

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

const TEAMS = Array.from({ length: 4 }, (_unused, index) => ({
  id: `team-${index + 1}`,
  name: `Team ${index + 1}`,
  seed: index + 1,
}));

/** A Bo3 round robin, so every card is editable and every series has modes. */
const CONFIG = normaliseStageConfig("round_robin", {
  bestOf: 3,
  modeSequence: { "3": ["convoy", "convoy", "domination"] },
});
const SPEC = generateStage("round_robin", TEAMS.length, CONFIG);

function records(): MatchRecord[] {
  return SPEC.matches.map((match) => ({
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
  }));
}

function board(rows: MatchRecord[] = records()): FormatView {
  const stage: StageView = {
    id: "stage-1",
    name: "Table",
    kind: "round_robin",
    sort: 0,
    config: SPEC.config,
    teamCount: TEAMS.length,
    spec: SPEC,
    matches: resolveMatches({
      stage: SPEC,
      matches: rows,
      teams: TEAMS,
      seeds: TEAMS.map((team) => team.id),
    }),
    standings: [],
    groups: [],
    placements: [],
    champion: null,
    seeding: null,
    seeds: TEAMS.map((team) => team.id),
    handEditedAt: null,
    outOfDateSince: null,
  };
  const blocks = planBlocks([SPEC], {
    timing: DEFAULT_FORMAT_TIMING,
    concurrentLobbies: 2,
    days: 1,
    blockDays: null,
  });
  return {
    eventId: "event-1",
    teams: TEAMS,
    stages: [stage],
    blocks,
    dayMinutes: dayMinutes(blocks),
    timing: DEFAULT_FORMAT_TIMING,
    concurrentLobbies: 2,
    days: 1,
  };
}

/** The whole tab, with every card shut — which is how it first renders. */
function renderTab(view: FormatView): string {
  return renderToStaticMarkup(
    createElement(ResultsTab, {
      format: view,
      matchIds: Object.fromEntries(
        view.stages.flatMap((stage) => stage.matches.map((m) => [m.slot, `row-${m.slot}`]))
      ),
    })
  );
}

/**
 * One card's editor, open.
 *
 * `renderToStaticMarkup` runs no handlers, so the tab's own cards are all shut
 * and hold nothing but their button — hence rendering the editor the tab
 * delegates to, exactly as `results-tab-unresolved.test.ts` renders
 * `FlaggedAlert`.
 */
function renderEditor(view: FormatView, slot: string): string {
  return renderToStaticMarkup(
    createElement(MatchEditor, {
      match: matchOf(view, slot),
      open: true,
      busy: false,
      onOpen: () => {},
      onSave: () => {},
      onDecide: () => {},
      onClear: () => {},
      onReflip: () => {},
    })
  );
}

/** One resolved match off the board, by slot. */
function matchOf(view: FormatView, slot: string) {
  const match = view.stages[0].matches.find((entry) => entry.slot === slot);
  if (!match) throw new Error(`no ${slot}`);
  return match;
}

/** What the card holds when it opens — the component's own function. */
function draftOf(view: FormatView, slot: string) {
  return draftFrom(matchOf(view, slot));
}

/* ------------------------------------------------------------------ */
/* UC-19 E1 — the mode each map was played on                         */
/* ------------------------------------------------------------------ */

describe("the Results card on the mode a map was played on (UC-19 E1, R-153)", () => {
  it("has a field for it on every game of the series", () => {
    /*
     * Counted, not merely present. A Bo3 card has three games, so three mode
     * fields — a `toContain("Mode")` would pass with one field on the first
     * game and none on the two that were actually in doubt.
     */
    const html = renderEditor(board(), "rr-1-2");
    const fields = [...html.matchAll(/aria-label="Mode played, game (\d)"/g)].map((m) => m[1]);
    expect(fields).toEqual(["1", "2", "3"]);
  });

  it("fills each field in from the stage's own mode sequence", () => {
    // Which is what makes an untouched card record what was planned rather
    // than blanking the mode of every game it saves.
    const html = renderEditor(board(), "rr-1-2");
    const values = [...html.matchAll(/aria-label="Mode played, game \d"[^>]*value="([^"]*)"/g)].map(
      (m) => m[1]
    );
    expect(values).toEqual(["convoy", "convoy", "domination"]);
  });

  it("carries the mode into the patch, per game", () => {
    const view = board();
    const match = matchOf(view, "rr-1-2");
    const form = draftOf(view, "rr-1-2");
    // The room played the decider as a convoy after all.
    form.games[2] = { ...form.games[2], mode: "Convoy", scoreA: "13", scoreB: "9", played: true };

    const fields = recordFieldsFrom(match, form);
    expect(fields.games.map((game) => [game.index, game.mode])).toEqual([
      [0, "convoy"],
      [1, "convoy"],
      [2, "Convoy"],
    ]);
    // `recordGames` normalises it through the same function `modeSequence` is
    // read with, so the record and the plan end up the same string.
    expect(fields.games[2].played).toBe(true);
  });

  it("names the mode on the game's own heading, from what is stored", () => {
    const rows = records();
    const first = rows.find((row) => row.slot === "rr-1-2");
    if (!first) throw new Error("no rr-1-2");
    first.games[0] = { ...first.games[0], mode: "payload_escort" };

    const html = renderEditor(board(rows), "rr-1-2");
    // `modeLabel` turns the stored name back into words, on the heading the
    // field sits under — so the two never disagree.
    expect(html).toContain("G1 · Payload escort");
    expect(html).toContain("G3 · Domination");
  });

  it("shows the recorded mode on the match itself, not only in the editor", () => {
    /*
     * UC-18 E1's outcome — *"System shows each map's mode on the match"* — read
     * off the tab rather than the editor, because the editor is shut until
     * somebody clicks it and the board is what the room looks at.
     */
    const rows = records();
    const first = rows.find((row) => row.slot === "rr-1-2");
    if (!first) throw new Error("no rr-1-2");
    first.games[0] = {
      ...first.games[0],
      mode: "payload_escort",
      map: "Harbour",
      scoreA: 13,
      scoreB: 9,
      played: true,
    };

    const html = renderTab(board(rows));
    expect(html).toContain("Harbour · payload_escort");
  });

  it("is not on a card nobody can fill in yet (UC-19 pre1)", () => {
    /*
     * A bracket slot waiting on a result has no teams, so the editor does not
     * open on it at all — and the mode is part of the editor rather than of
     * the card, so it must not appear there either.
     */
    const bracket = generateStage("single_elim", 4, { bestOf: 3 });
    const waiting = resolveMatches({
      stage: bracket,
      matches: bracket.matches.map((match) => ({
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
      teams: TEAMS,
      seeds: TEAMS.map((team) => team.id),
    }).find((match) => match.slot === "f");
    if (!waiting) throw new Error("no final");

    const html = renderToStaticMarkup(
      createElement(MatchEditor, {
        match: waiting,
        open: true,
        busy: false,
        onOpen: () => {},
        onSave: () => {},
        onDecide: () => {},
        onClear: () => {},
        onReflip: () => {},
      })
    );
    expect(html).toContain("still waiting on");
    expect(html).not.toContain("Mode played, game");
  });
});

/* ------------------------------------------------------------------ */
/* UC-19 E2 — a start the manager did not move                        */
/* ------------------------------------------------------------------ */

describe("the Results card and the start time it did not move (UC-19 E2, R-157)", () => {
  it("leaves the start out of the patch when the field was not touched", () => {
    /*
     * `recordGamesAction` calls `setMatchSchedule` whenever `scheduledAt` is
     * present, and that marks the stage hand-edited — which stops the matches
     * being rebuilt when the teams change and makes the Format tab blame
     * hand-moved times for it. A card that posts its own start back on every
     * save marked the stage for recording a scoreline.
     */
    const rows = records();
    const first = rows.find((row) => row.slot === "rr-1-2");
    if (!first) throw new Error("no rr-1-2");
    first.scheduledAt = "2026-06-20T16:00:00.000Z";

    const view = board(rows);
    const fields = recordFieldsFrom(matchOf(view, "rr-1-2"), draftOf(view, "rr-1-2"));
    expect("scheduledAt" in fields).toBe(false);
  });

  it("leaves it out on a card that has no start time at all", () => {
    // The worse half of the same bug: `null` over `null` was still a write,
    // and still a mark.
    const view = board();
    const fields = recordFieldsFrom(matchOf(view, "rr-1-2"), draftOf(view, "rr-1-2"));
    expect("scheduledAt" in fields).toBe(false);
  });

  it("sends it as an instant when the field was changed", () => {
    const view = board();
    const form = { ...draftOf(view, "rr-1-2"), scheduledAt: "2026-06-20T18:30" };

    const fields = recordFieldsFrom(matchOf(view, "rr-1-2"), form);
    expect(fields.scheduledAt).toBe("2026-06-20T16:30:00.000Z");
  });

  it("sends null when the field was cleared", () => {
    const rows = records();
    const first = rows.find((row) => row.slot === "rr-1-2");
    if (!first) throw new Error("no rr-1-2");
    first.scheduledAt = "2026-06-20T16:00:00.000Z";

    const view = board(rows);
    const form = { ...draftOf(view, "rr-1-2"), scheduledAt: "" };
    expect(recordFieldsFrom(matchOf(view, "rr-1-2"), form).scheduledAt).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* UC-19 E3 — how long the match took                                 */
/* ------------------------------------------------------------------ */

describe("the Results card on how long the match took (UC-19 E3, R-158)", () => {
  it("offers the minutes, and says what they do to the day", () => {
    const html = renderEditor(board(), "rr-1-2");
    expect(html).toContain('aria-label="How long the match took, in minutes"');
    expect(html).toContain(
      "re-flows the rest of that day — from the minutes above when they are filled in, and from the clock when they are not."
    );
  });

  it("sends the minutes as a number", () => {
    const view = board();
    const form = { ...draftOf(view, "rr-1-2"), durationMin: "75" };
    expect(recordFieldsFrom(matchOf(view, "rr-1-2"), form).durationMin).toBe(75);
  });

  it("sends null for a blank box, so the finish comes off the clock", () => {
    const view = board();
    expect(
      recordFieldsFrom(matchOf(view, "rr-1-2"), draftOf(view, "rr-1-2")).durationMin
    ).toBeNull();
  });

  it("shows a stored duration back in the box", () => {
    const rows = records();
    const first = rows.find((row) => row.slot === "rr-1-2");
    if (!first) throw new Error("no rr-1-2");
    first.durationMin = 42;

    const view = board(rows);
    expect(draftOf(view, "rr-1-2").durationMin).toBe("42");
    expect(recordFieldsFrom(matchOf(view, "rr-1-2"), draftOf(view, "rr-1-2")).durationMin).toBe(
      42
    );
  });
});
