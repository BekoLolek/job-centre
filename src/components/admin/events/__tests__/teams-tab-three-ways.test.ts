import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MemberLike, TeamLike } from "@/components/draft";
import type { EventConfig } from "@/db";
import type { TeamsFill } from "@/lib/draft";
import { DEFAULT_DRAFT_CONFIG, rosterState } from "@/lib/draft-policy";
import type { ApplicantView } from "@/lib/events";
import { type EventShape, eventShapeFrom, planSides, teamFormatFrom } from "@/lib/events-policy";
import { applicant } from "./applicants-fixture";
import type { DraftTabData } from "../types";

/*
 * Task 81 on the screen — R-220 / UC-42 6, 6a: the Teams tab fills by hand,
 * at random or from a draft, says which route filled the current teams, and
 * counts its teams the way the Format panel does.
 *
 * ## Why the decisions are asserted directly as well as through the markup
 *
 * The confirm state is reachable only by clicking and this suite is a node
 * environment with nothing to click. So the decisions behind the shuffle
 * button — refused, allowed, and what the confirmation has to name — are a
 * pure function (`shuffleGate`) asserted over every combination, and the
 * handler does nothing but obey it. Task 83's `manualPostStep` and Task 80's
 * `standingOn` are the precedent. **No test here mimes a click.**
 *
 * The markup is rendered too, because a pure function nobody calls is a rule
 * that is not holding: the sentences are asserted on the page, with the real
 * `planSides` and `teamCountFrom` behind them.
 *
 * ## 400px
 *
 * No browser. The last block is structural evidence only — the primitives the
 * tab is built from, and that nothing in it demands more width than a phone
 * has — and is stated as such.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

vi.mock("@/app/admin/events/draft-actions", () => ({
  placeOnRosterAction: vi.fn(),
  previewTeamCountAction: vi.fn(),
  previewTeamsAction: vi.fn(),
  randomiseTeamsAction: vi.fn(),
  removeFromRosterAction: vi.fn(),
  saveNightFormatAction: vi.fn(),
  saveTeamsAction: vi.fn(),
  setTeamCountAction: vi.fn(),
}));

const {
  default: TeamsTab,
  countControl,
  fillSentence,
  replacingSentence,
  shuffleGate,
} = await import("../TeamsTab");

const CONFIG = { ...DEFAULT_DRAFT_CONFIG, rosterTarget: 6 };

function team(id: string, name: string, members: MemberLike[] = []): TeamLike {
  return {
    id,
    name,
    seed: null,
    captainUserId: members.find((row) => row.isCaptain)?.userId ?? null,
    balanceStart: CONFIG.defaultBalance,
    balance: CONFIG.defaultBalance,
    roster: rosterState({ id }, members, CONFIG),
    members,
  };
}

/** `count` applicants, all accepted. */
function people(count: number): ApplicantView[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `accepted-${index}`;
    return applicant({
      id: `application-${id}`,
      userId: id,
      status: "accepted",
      displayName: `Player ${index}`,
      member: { id, displayName: `Player ${index}`, avatarUrl: null, discordId: `d-${id}` },
    });
  });
}

const EMPTY: TeamsFill = { route: "empty" };
const HAND: TeamsFill = { route: "hand", placed: 7 };
const RANDOM: TeamsFill = {
  route: "random",
  at: "2026-10-23T18:00:00.000Z",
  dealt: 12,
  byHandSince: 0,
};
const RANDOM_EDITED: TeamsFill = { ...RANDOM, byHandSince: 2 };
const DRAFT: TeamsFill = { route: "draft", won: 10, byHand: 2 };

function tabData(over: Partial<DraftTabData> = {}): DraftTabData {
  return {
    teams: [],
    config: CONFIG,
    pool: { main: [], reserve: [] },
    unpooled: [],
    discarded: [],
    players: {},
    started: false,
    teamFormat: teamFormatFrom({ teamFormat: "6v6" }),
    fill: EMPTY,
    ...over,
  };
}

/** The real reader over a config, never a hand-written shape. */
const shapeOf = (config: EventConfig = {}): EventShape => eventShapeFrom(config);
const TEAMS_OF = (value: number): EventConfig => ({
  eventShape: { teamEvent: true, draft: true, sizing: { mode: "teams", value } },
});
const PER_TEAM = (value: number, draft = true): EventConfig => ({
  eventShape: { teamEvent: true, draft, sizing: { mode: "perTeam", value } },
});

/** Two hand-built teams with seven places between them. */
const TWO_TEAMS = [
  team("t1", "Alpha", [
    { teamId: "t1", userId: "accepted-0", price: 0, isCaptain: false },
    { teamId: "t1", userId: "accepted-1", price: 0, isCaptain: false },
    { teamId: "t1", userId: "accepted-2", price: 0, isCaptain: false },
    { teamId: "t1", userId: "accepted-3", price: 0, isCaptain: false },
  ]),
  team("t2", "Bravo", [
    { teamId: "t2", userId: "accepted-4", price: 0, isCaptain: false },
    { teamId: "t2", userId: "accepted-5", price: 0, isCaptain: false },
    { teamId: "t2", userId: "accepted-6", price: 0, isCaptain: false },
  ]),
];

/** The raw markup, for the things that live in attributes. */
function markup(applicants: ApplicantView[], data: DraftTabData, shape = shapeOf()): string {
  return renderToStaticMarkup(
    createElement(TeamsTab, { eventId: "event-1", applicants, data, shape })
  );
}

/** The tab as a manager reads it: no tags, no entities. */
function render(applicants: ApplicantView[], data: DraftTabData, shape = shapeOf()): string {
  return markup(applicants, data, shape)
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2019;|&rsquo;/g, "’")
    .replace(/&rarr;|&#x2192;/g, "→")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Which route filled the current teams (UC-42 6, 6a)                 */
/* ------------------------------------------------------------------ */

describe("the screen says which route filled the current teams", () => {
  it("says nobody is placed yet, captains aside", () => {
    expect(fillSentence(EMPTY)).toBe(
      "Nobody has been placed on a team yet — captains aside, who are chosen on the Captains tab."
    );
  });

  it("says by hand, with the count", () => {
    expect(fillSentence(HAND)).toBe("Filled by hand — 7 roster places, one at a time.");
  });

  it("says at random, with when and how many were dealt", () => {
    const said = fillSentence(RANDOM);
    expect(said).toMatch(/^Filled at random on .+ — 12 dealt\.$/);
    expect(said).not.toContain("by hand since");
  });

  it("adds the hand placements made since a shuffle", () => {
    expect(fillSentence(RANDOM_EDITED)).toMatch(
      /^Filled at random on .+ — 12 dealt, 2 placed by hand since\.$/
    );
  });

  it("says the draft, splitting what was won from what was placed", () => {
    expect(fillSentence(DRAFT)).toBe("Filled by the draft — 10 won in the room, 2 placed by hand.");
    expect(fillSentence({ route: "draft", won: 4, byHand: 0 })).toBe(
      "Filled by the draft — 4 won in the room."
    );
  });

  it.each([
    ["hand", HAND, "Filled by hand", ["Filled at random", "Filled by the draft", "Nobody has been placed"]],
    ["random", RANDOM, "Filled at random", ["Filled by hand", "Filled by the draft", "Nobody has been placed"]],
    ["draft", DRAFT, "Filled by the draft", ["Filled by hand", "Filled at random", "Nobody has been placed"]],
    ["empty", EMPTY, "Nobody has been placed", ["Filled by hand", "Filled at random", "Filled by the draft"]],
  ] as const)("renders the %s sentence and none of the others", (_route, fill, said, others) => {
    const screen = render(people(12), tabData({ teams: TWO_TEAMS, fill }));
    expect(screen).toContain(said);
    for (const other of others) expect(screen).not.toContain(other);
  });
});

/* ------------------------------------------------------------------ */
/* Three routes, one set of teams (R-220)                             */
/* ------------------------------------------------------------------ */

describe("the three routes are one screen", () => {
  it("names all three routes when the event drafts", () => {
    const screen = render(people(12), tabData());
    expect(screen).toContain("How the teams get filled");
    expect(screen).toContain("By hand —");
    expect(screen).toContain("At random —");
    expect(screen).toContain("From the draft — captains bid for players in the draft room.");
  });

  it("says why the draft route is missing when the event has none", () => {
    const screen = render(people(12), tabData(), shapeOf(PER_TEAM(6, false)));
    expect(screen).toContain(
      "No draft on this event, so the teams are filled here. Setup → Format is where that is decided."
    );
    expect(screen).not.toContain("captains bid for players");
  });

  it("says the three routes fill the same teams", () => {
    expect(render(people(12), tabData())).toContain(
      "Whichever way, it is the same teams: the rosters below are what the draft bids into and what a shuffle replaces."
    );
  });
});

/* ------------------------------------------------------------------ */
/* The count follows the Format panel (R-218 / UC-42 6)               */
/* ------------------------------------------------------------------ */

describe("countControl", () => {
  it("fixes the count at the panel's figure under a count of teams, whoever is accepted", () => {
    expect(countControl(shapeOf(TEAMS_OF(4)), 0)).toEqual({
      fixed: 4,
      note: "Setup → Format says 4 teams. Change it there.",
    });
    expect(countControl(shapeOf(TEAMS_OF(4)), 40).fixed).toBe(4);
  });

  it("fixes it at the planner's count under players per team once it can be worked out", () => {
    expect(countControl(shapeOf(PER_TEAM(6)), 12)).toEqual({
      fixed: 2,
      note: "Setup → Format sizes the teams at 6 a side — 2 teams from the 12 accepted. Change the sizing there.",
    });
    // A fractional team rounds up into a short side, never down.
    expect(countControl(shapeOf(PER_TEAM(6)), 13).fixed).toBe(3);
  });

  it("leaves it free with nobody accepted, and says so", () => {
    expect(countControl(shapeOf(PER_TEAM(6)), 0)).toEqual({
      fixed: null,
      note: "Setup → Format sizes the teams at 6 a side, and nobody is accepted yet — so the count is yours until there are enough to settle it.",
    });
  });

  it("leaves it free while the accepted cannot make two sides, naming both numbers", () => {
    const control = countControl(shapeOf(PER_TEAM(6)), 4);
    expect(control.fixed).toBeNull();
    expect(control.note).toBe(
      "Setup → Format sizes the teams at 6 a side. Only 4 players are accepted, and one team of 6 needs 6. Accept more on the Applicants tab. Until then the count is yours."
    );
  });
});

describe("the count control on the page", () => {
  const field = (raw: string) => raw.match(/<input[^>]*aria-label="Number of teams"[^>]*>/)?.[0] ?? "";

  it("is locked to the panel's count and says where to change it", () => {
    const raw = markup(people(12), tabData(), shapeOf(TEAMS_OF(4)));
    expect(field(raw)).toContain("disabled");
    expect(field(raw)).toContain('value="4"');
    expect(render(people(12), tabData(), shapeOf(TEAMS_OF(4)))).toContain(
      "Setup → Format says 4 teams. Change it there."
    );
  });

  it("is locked to the derived count under players per team", () => {
    const raw = markup(people(12), tabData(), shapeOf(PER_TEAM(6)));
    expect(field(raw)).toContain("disabled");
    expect(field(raw)).toContain('value="2"');
  });

  it("is free, and says why, while the panel cannot say", () => {
    const raw = markup([], tabData(), shapeOf(PER_TEAM(6)));
    expect(field(raw)).not.toContain("disabled");
    expect(render([], tabData(), shapeOf(PER_TEAM(6)))).toContain("nobody is accepted yet");
  });

  it("offers to make it the panel's count when the teams disagree with it", () => {
    // Two teams exist; the panel says four. The button is live, not dead.
    const raw = markup(people(12), tabData({ teams: TWO_TEAMS, fill: HAND }), shapeOf(TEAMS_OF(4)));
    expect(raw).toMatch(/<button[^>]*>\s*Set team count/);
    expect(raw).not.toMatch(/<button[^>]*disabled[^>]*>\s*Set team count/);
  });

  it("has nothing to do when the teams already match the panel", () => {
    const raw = markup(people(12), tabData({ teams: TWO_TEAMS, fill: HAND }), shapeOf(TEAMS_OF(2)));
    expect(raw).toMatch(/<button[^>]*disabled[^>]*>\s*Set team count/);
  });
});

/* ------------------------------------------------------------------ */
/* The random plan is the panel's (UC-41 4 / UC-42 4b)                */
/* ------------------------------------------------------------------ */

describe("the random plan is sized by the Format panel", () => {
  it("makes three teams of four from twelve under '3 teams' — not the comp's two of six", () => {
    const screen = render(people(12), tabData(), shapeOf(TEAMS_OF(3)));
    expect(screen).toContain("12 accepted players make 3 teams of 4, 4, 4");
    expect(screen).toContain("sized by 3 teams in Setup → Format");
    expect(screen).not.toContain("2 teams of 6");
  });

  it("names the light sides under a count of teams", () => {
    const screen = render(people(14), tabData(), shapeOf(TEAMS_OF(4)));
    expect(screen).toContain("14 accepted players make 4 teams of 4, 4, 3, 3");
    expect(screen).toContain("Teams 3, 4 are one light");
  });

  it("still names the short sides against the side size under players per team", () => {
    const screen = render(people(16), tabData(), shapeOf(PER_TEAM(6)));
    expect(screen).toContain("16 accepted players make 3 teams of 6, 5, 5");
    expect(screen).toContain("Teams 2, 3 are short of 6");
  });

  it("shows the planner's refusal and disables the button when sides outnumber people", () => {
    const raw = markup(people(3), tabData(), shapeOf(TEAMS_OF(4)));
    expect(raw).toContain("Only 3 players are accepted, and 4 teams need at least one player each");
    expect(raw).toMatch(/<button[^>]*disabled[^>]*>\s*Make random teams/);
  });

  it("no longer holds the shuffle hostage to an unsaved comp chip", () => {
    // The chip states the comp; the panel sizes the teams. There is nothing
    // stored-versus-clicked for the shuffle to wait on any more.
    expect(render(people(12), tabData())).not.toContain("Save the format first");
  });
});

/* ------------------------------------------------------------------ */
/* The gate the button obeys (UC-41 3a, 3b; UC-42 6a)                 */
/* ------------------------------------------------------------------ */

describe("shuffleGate", () => {
  const ok = planSides({ mode: "teams", value: 2 }, 12);
  const bad = planSides({ mode: "teams", value: 4 }, 3);

  it.each([EMPTY, HAND, RANDOM, DRAFT])("refuses outright once a lot is awarded, whatever filled them (%o)", (fill) => {
    expect(shuffleGate({ started: true, planned: ok, fill, teams: 2, rosterPlaces: 7 })).toEqual({
      allowed: false,
      refusal:
        "The draft has already awarded lots. Random teams would replace the teams those lots were awarded against, so it is refused. Void the lots in the draft room first.",
      replacing: null,
    });
  });

  it("refuses with the planner's own sentence when the numbers do not work", () => {
    if (bad.ok) throw new Error("expected a refusal");
    expect(shuffleGate({ started: false, planned: bad, fill: EMPTY, teams: 0, rosterPlaces: 0 })).toEqual({
      allowed: false,
      refusal: bad.error,
      replacing: null,
    });
  });

  it("allows a first fill with nothing to name", () => {
    expect(shuffleGate({ started: false, planned: ok, fill: EMPTY, teams: 0, rosterPlaces: 0 })).toEqual({
      allowed: true,
      refusal: null,
      replacing: null,
    });
  });

  it.each([
    [EMPTY, "Shuffling discards the 2 teams that already exist, with their names, seeds and 0 roster places — nobody is on them yet."],
    [HAND, "Shuffling discards the 2 teams that already exist, with their names, seeds and 7 roster places — every one of them placed by hand."],
    [RANDOM_EDITED, /^Shuffling discards the 2 teams that already exist, with their names, seeds and 7 roster places — dealt at random on .+, with 2 placed by hand since\.$/],
    [DRAFT, "Shuffling discards the 2 teams that already exist, with their names, seeds and 7 roster places — won in the draft."],
  ])("allows a replacement and names what goes (%o)", (fill, expected) => {
    const gate = shuffleGate({ started: false, planned: ok, fill, teams: 2, rosterPlaces: fill === EMPTY ? 0 : 7 });
    expect(gate.allowed).toBe(true);
    expect(gate.refusal).toBeNull();
    if (typeof expected === "string") expect(gate.replacing).toBe(expected);
    else expect(gate.replacing).toMatch(expected);
  });

  it("is what replacingSentence says, so the panel and the dialog cannot differ", () => {
    expect(replacingSentence(HAND, 2, 7)).toBe(
      shuffleGate({ started: false, planned: ok, fill: HAND, teams: 2, rosterPlaces: 7 }).replacing
    );
  });

  it("puts the replacement sentence on the panel, where a closed dialog cannot hide it", () => {
    const screen = render(people(12), tabData({ teams: TWO_TEAMS, fill: HAND }));
    expect(screen).toContain(
      "Shuffling discards the 2 teams that already exist, with their names, seeds and 7 roster places — every one of them placed by hand."
    );
  });

  it("disables the button when the gate refuses, and offers it when it allows", () => {
    expect(markup(people(12), tabData({ started: true }))).toMatch(
      /<button[^>]*disabled[^>]*>\s*Make random teams/
    );
    const live = markup(people(12), tabData({ teams: TWO_TEAMS, fill: HAND }));
    expect(live).toMatch(/<button[^>]*>\s*Make random teams/);
    expect(live).not.toMatch(/<button[^>]*disabled[^>]*>\s*Make random teams/);
  });
});

/* ------------------------------------------------------------------ */
/* 400px — structural evidence, not a measurement                     */
/* ------------------------------------------------------------------ */

describe("at 400px (structural)", () => {
  /*
   * A dev server was forbidden, so nothing here is a measurement. What is
   * asserted: a phone's 400px minus the page's 16px gutters leaves 368px, and
   * no element in the tab demands more than that as a minimum, every row the
   * tab adds is allowed to wrap, and the controls are the kit's own `Button`,
   * `Stepper` and `Select`, whose tap targets Tasks 31a and 38b settled.
   */
  const raw = markup(people(14), tabData({ teams: TWO_TEAMS, fill: HAND }), shapeOf(TEAMS_OF(3)));

  it("demands no minimum width wider than a phone", () => {
    const rems = [...raw.matchAll(/min-w-\[(\d+(?:\.\d+)?)rem\]/g)].map((hit) => Number(hit[1]) * 16);
    const pixels = [...raw.matchAll(/\bw-\[(\d+)px\]/g)].map((hit) => Number(hit[1]));
    expect(rems.length + pixels.length).toBeGreaterThan(0);
    expect(Math.max(...rems, ...pixels)).toBeLessThanOrEqual(368);
  });

  it("lets every row this task added wrap", () => {
    /*
     * Scoped to the markup Task 81 added — the routes panel and the count
     * control — rather than the whole tab, whose older rows (a pair of
     * 48px move buttons, a chip's actions) were sized by earlier tasks. An
     * inline row that cannot wrap is what overflows a phone, so every `flex`
     * row in these two sections is `flex-wrap`, bar the Stepper's own frame.
     */
    // From the *section's* opening tag, not the heading text — the header row's
    // own class attribute sits before the heading, and a slice that began at
    // the text let a header row with its `flex-wrap` removed survive.
    const sectionBefore = (text: string) => raw.lastIndexOf("<section", raw.indexOf(text));
    const routes = raw.slice(sectionBefore("How the teams get filled"), raw.indexOf("The night"));
    const count = raw.slice(sectionBefore("How many teams"), raw.indexOf("Names and seeds"));
    expect(routes.length).toBeGreaterThan(200);
    expect(count.length).toBeGreaterThan(200);

    // The standalone `flex` class — not `flex-1`, which is an item, not a row.
    const rows = [...`${routes}${count}`.matchAll(/class="([^"]*)"/g)]
      .map((hit) => hit[1])
      .filter((classes) => classes.split(/\s+/).includes("flex"));
    const rigid = rows.filter(
      (classes) => !/\bflex-wrap\b/.test(classes) && !/\bmax-w-xs\b/.test(classes)
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rigid).toEqual([]);
  });

  it("uses the kit's controls, not bare elements", () => {
    // Every button is a `Button`/`Stepper` (`.btn`) or a `ChoiceChip`
    // (`aria-pressed`); those three carry the kit's tap-target sizing.
    expect(raw).not.toMatch(/<button(?![^>]*(?:\bbtn\b|aria-pressed=))/);
  });
});
