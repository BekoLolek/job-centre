import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { generateStage } from "@/lib/bracket";
import type { DependentFlag, FormatView, StageView } from "@/lib/format";
import { DEFAULT_FORMAT_TIMING, normaliseStageConfig } from "@/lib/format-policy";
import { dayMinutes, planBlocks } from "@/lib/format-schedule";
import { type MatchRecord, blankGamesFor, resolveMatches } from "@/lib/format-resolve";

/*
 * What the Results tab *says* about a card nobody can fill in yet, and about a
 * correction that moved a later team — UC-19 precondition 1 and UC-19 3a.
 *
 * Both are refused or reported by the server, and both have to be legible on
 * the screen before the manager clicks: a disabled button with no sentence
 * beside it is indistinguishable from a broken page, and a flag the tab shows
 * for a second and swallows is not a flag.
 *
 * The router and the action module are mocked for the reason
 * `format-tab-out-of-date.test.ts` and `teams-tab-placement.test.ts` mock them:
 * importing the actions would drag the database and the session into a node
 * test that only wants markup.
 *
 * **`renderToStaticMarkup` runs no effects and no handlers**, so the flag alert
 * is rendered through the component the tab delegates it to rather than by
 * pretending to save. That is why `FlaggedAlert` is exported — a message this
 * load-bearing has to be readable back in a test, and state three hundred lines
 * inside a client component is not.
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

const { default: ResultsTab, FlaggedAlert } = await import("../ResultsTab");

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

const TEAMS = Array.from({ length: 4 }, (_unused, index) => ({
  id: `team-${index + 1}`,
  name: `Team ${index + 1}`,
  seed: index + 1,
}));

const CONFIG = normaliseStageConfig("double_elim", { bestOf: 3 });
const SPEC = generateStage("double_elim", TEAMS.length, CONFIG);

/** Every generated match as an untouched stored row, so every card is editable. */
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
    name: "Playoffs",
    kind: "double_elim",
    sort: 0,
    config: SPEC.config,
    teamCount: TEAMS.length,
    spec: SPEC,
    matches: resolveMatches({ stage: SPEC, matches: rows, teams: TEAMS, seeds: TEAMS.map((t) => t.id) }),
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

function render(view: FormatView): string {
  return renderToStaticMarkup(
    createElement(ResultsTab, {
      format: view,
      matchIds: Object.fromEntries(
        view.stages.flatMap((stage) => stage.matches.map((m) => [m.slot, `row-${m.slot}`]))
      ),
    })
  );
}

/* ------------------------------------------------------------------ */
/* UC-19 precondition 1 — a card with nobody in it                    */
/* ------------------------------------------------------------------ */

describe("ResultsTab on a slot that has not resolved (UC-19 pre1)", () => {
  it("says what the upper final is waiting on instead of offering the editor", () => {
    const html = render(board());

    expect(html).toContain(
      "This match is still waiting on Upper semi 1 winner and Upper semi 2 winner, so it cannot have a result yet."
    );
    expect(html).toContain("Not played yet");
  });

  it("offers the editor on exactly the cards whose teams are known", () => {
    /*
     * Counted rather than merely present. A four-team double elimination has
     * six slots and only the two upper semis resolve off the seeding — the
     * other four wait on a result — so a `toContain("Record result")` would
     * pass just as happily with the refusal applied to none of them.
     */
    const view = board();
    const resolved = view.stages[0].matches.filter((m) => m.teamAId && m.teamBId);
    const waiting = view.stages[0].matches.filter((m) => !m.teamAId || !m.teamBId);
    expect([resolved.map((m) => m.slot), waiting.length]).toEqual([["ubsf1", "ubsf2"], 4]);

    const html = render(view);
    const count = (needle: string) => html.split(needle).length - 1;
    // Each card is rendered once by day and once by bracket is *not* the case:
    // only the chosen grouping is in the markup, and "day" is the default.
    expect(count("Record result")).toBe(resolved.length);
    expect(count("Not played yet")).toBe(waiting.length);
  });

  it("offers nothing destructive on an unresolved card that is empty", () => {
    // A bracket slot nobody has played has nothing to clear, so the one button
    // the waiting state keeps is not shown either.
    const html = render(board());
    expect(html).not.toContain("Clear the maps recorded here");
  });

  it("offers the clear when an unresolved card is carrying maps (UC-19 3a's way out)", () => {
    /*
     * The trap this avoids: a correction upstream leaves the upper final with
     * maps against nobody, and a tab that only disabled the card would leave
     * them there for ever.
     */
    const rows = records();
    const final = rows.find((row) => row.slot === "ubf");
    if (!final) throw new Error("no upper final");
    final.games[0] = { ...final.games[0], scoreA: 13, scoreB: 11, played: true };

    const html = render(board(rows));
    expect(html).toContain("Clear the maps recorded here");
    expect(html).toContain("still waiting on");
  });
});

/* ------------------------------------------------------------------ */
/* UC-19 3a — the flag the save hands back                            */
/* ------------------------------------------------------------------ */

describe("FlaggedAlert (UC-19 3a)", () => {
  const flag = (over: Partial<DependentFlag> = {}): DependentFlag => ({
    slot: "ubf",
    label: "Upper final",
    playedGames: 2,
    before: { a: "team-1", b: "team-2" },
    after: { a: "team-3", b: "team-2" },
    ...over,
  });

  function alert(flagged: DependentFlag[]): string {
    return renderToStaticMarkup(
      createElement(FlaggedAlert, { flagged, teams: TEAMS, onDismiss: () => {} })
    );
  }

  it("renders nothing at all when the save moved nobody", () => {
    expect(alert([])).toBe("");
  });

  it("names the match, both pairings and how many maps are on it", () => {
    const html = alert([flag()]);

    expect(html).toContain("1 later match now has a different team");
    expect(html).toContain("has maps recorded already");
    expect(html).toContain("Upper final");
    // Teams by name, left to right, so the manager can check it against a room.
    expect(html).toContain("Team 1");
    expect(html).toContain("Team 3");
    expect(html).toContain("2 maps recorded");
    expect(html).toContain("Those maps were played by the teams on the left.");
    expect(html).toContain("nothing has been changed for you");
  });

  it("says “nobody” for a slot that has gone back to waiting", () => {
    const html = alert([flag({ after: { a: null, b: "team-2" } })]);
    expect(html).toContain("nobody");
  });

  it("counts and conjugates more than one", () => {
    const html = alert([flag(), flag({ slot: "gf", label: "Grand final", playedGames: 1 })]);
    expect(html).toContain("2 later matches now have a different team");
    expect(html).toContain("have maps recorded already");
    expect(html).toContain("Grand final");
    expect(html).toContain("1 map recorded");
  });
});
