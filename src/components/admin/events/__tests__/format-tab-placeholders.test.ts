import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { generateStage } from "@/lib/bracket";
import { type EventShape, eventShapeFrom } from "@/lib/events-policy";
import type { FormatView, StageView } from "@/lib/format";
import {
  DEFAULT_FORMAT_TIMING,
  MAX_TEAMS,
  MIN_TEAMS,
  normaliseStageConfig,
} from "@/lib/format-policy";
import { dayMinutes, planBlocks } from "@/lib/format-schedule";
import { resolveMatches } from "@/lib/format-resolve";

/*
 * Where the bracket tab's placeholder team count comes from — R-218, the
 * "stuck on 8 teams" report.
 *
 * The tab used to seed its stand-in teams from a local `useState` that started
 * at eight and was never written anywhere, so the number an admin chose there
 * was gone on the next load and the number they had *saved* — on Setup →
 * Format — was never consulted. The placeholders stay (the format is the
 * decision an admin makes before anybody has formed a team); the figure is now
 * the Format panel's, and when that panel cannot settle one yet the tab says
 * what it is assuming instead of drawing eight teams in silence.
 *
 * The router and the action module are mocked for the reason
 * `format-tab-out-of-date.test.ts` mocks them: importing the actions would drag
 * the database and the session into a node test that only wants markup.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {}, push: () => {} }),
}));

vi.mock("@/app/admin/events/format-actions", () => ({
  previewStagesAction: vi.fn(async () => []),
  rebuildStageAction: vi.fn(),
  saveStagesAction: vi.fn(),
}));

const { default: FormatTab, placeholderPlan } = await import("../FormatTab");

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

function teams(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `team-${index + 1}`,
    name: `Real ${index + 1}`,
    seed: index + 1,
  }));
}

/** One round robin stage, resolved by the real resolver from the real generator. */
function formatView(real: ReturnType<typeof teams>): FormatView {
  const config = normaliseStageConfig("round_robin", { bestOf: 1 });
  const spec = generateStage("round_robin", Math.max(real.length, MIN_TEAMS), config);
  const stage: StageView = {
    id: "stage-1",
    name: "Round robin",
    kind: "round_robin",
    sort: 0,
    config: spec.config,
    teamCount: real.length,
    spec,
    matches: resolveMatches({ stage: spec, matches: [], teams: real, seeds: null }),
    standings: [],
    groups: [],
    placements: [],
    champion: null,
    seeding: null,
    seeds: real.map((team) => team.id),
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
    teams: real,
    stages: [stage],
    blocks,
    dayMinutes: dayMinutes(blocks),
    timing: DEFAULT_FORMAT_TIMING,
    concurrentLobbies: 2,
    days: 1,
  };
}

const perTeam = (value: number): EventShape =>
  eventShapeFrom({ eventShape: { teamEvent: true, draft: true, sizing: { mode: "perTeam", value } } });
const ofTeams = (value: number): EventShape =>
  eventShapeFrom({ eventShape: { teamEvent: true, draft: true, sizing: { mode: "teams", value } } });

function render({
  shape,
  accepted = 0,
  capacity = null,
  real = 0,
}: {
  shape: EventShape;
  accepted?: number;
  capacity?: number | null;
  real?: number;
}): string {
  return renderToStaticMarkup(
    createElement(FormatTab, {
      eventId: "event-1",
      format: formatView(teams(real)),
      matchIds: {},
      maxStages: 4,
      shape,
      accepted,
      capacity,
    })
  );
}

/** A round robin's match count is the one number that changes with every team added. */
const roundRobinMatches = (count: number) => `${(count * (count - 1)) / 2} matches`;

/* ------------------------------------------------------------------ */
/* The count is the Format panel's                                    */
/* ------------------------------------------------------------------ */

describe("the bracket tab's placeholder count (R-218)", () => {
  it("draws the bracket for the number of teams set on the Format panel", () => {
    const html = render({ shape: ofTeams(5) });

    expect(html).toContain(`>5/${MAX_TEAMS}<`);
    expect(html).toContain(roundRobinMatches(5));
    expect(html).toContain("Team 5");
    expect(html).not.toContain("Team 6");
  });

  it("changes the preview when that number changes there", () => {
    expect(render({ shape: ofTeams(4) })).toContain(roundRobinMatches(4));
    expect(render({ shape: ofTeams(6) })).toContain(roundRobinMatches(6));
  });

  it("derives the count from players-per-team and the accepted, as the Format panel does", () => {
    const html = render({ shape: perTeam(6), accepted: 24 });

    expect(html).toContain(`>4/${MAX_TEAMS}<`);
    expect(html).toContain(roundRobinMatches(4));
    expect(html).toContain("6 per team, which is 4 teams from the 24 accepted");
    expect(html).not.toContain("this preview assumes");
  });

  it("says where the number comes from and that nothing is written", () => {
    const html = render({ shape: ofTeams(4) });
    expect(html).toContain(
      "Placeholders. The count is the Format panel’s — 4 teams — and every shape below is built for that many, byes included. The real teams take their places as they are formed, and nothing here is written down until they exist. Setup → Format is where the number changes."
    );
  });

  it("lets real teams win over the Format panel once there are enough of them", () => {
    const html = render({ shape: ofTeams(6), real: 4 });

    expect(html).toContain(`>4/${MAX_TEAMS}<`);
    expect(html).toContain(roundRobinMatches(4));
    expect(html).toContain("Real 4");
    expect(html).not.toContain("Placeholders.");
  });
});

/* ------------------------------------------------------------------ */
/* Placeholders before any real team exists                           */
/* ------------------------------------------------------------------ */

describe("placeholders before any real team exists", () => {
  it("runs the whole screen on stand-ins named Team 1 to Team N", () => {
    const html = render({ shape: ofTeams(3) });
    expect(html).toContain("Team 1");
    expect(html).toContain("Team 3");
    expect(html).not.toContain("Team 4");
    expect(html).toContain("these are placeholder teams");
  });

  it("writes nothing — the Format panel owns the number, and this tab cannot reach its action", () => {
    /*
     * A static render cannot see a write that never happens, so this is about
     * the source: the only actions this file can call are the stage ones, and
     * it holds no state of its own for the team count.
     */
    const source = fs.readFileSync(path.resolve(__dirname, "../FormatTab.tsx"), "utf8");
    expect(source).not.toContain("saveEventShapeAction");
    expect(source).not.toContain("setTeamCountAction");
    expect(source).not.toContain("setPreviewSize");
  });
});

/* ------------------------------------------------------------------ */
/* When the count cannot be derived yet                               */
/* ------------------------------------------------------------------ */

describe("when the Format panel cannot settle a count yet", () => {
  it("assumes every seat fills, and says so in a sentence the reader can act on", () => {
    const html = render({ shape: perTeam(6), accepted: 0, capacity: 24 });

    expect(html).toContain(`>4/${MAX_TEAMS}<`);
    expect(html).toContain(roundRobinMatches(4));
    expect(html).toContain(
      "Placeholders. 6 per team on Setup → Format does not settle a count yet: nobody is accepted, so there is nothing to divide. Until it does, this preview assumes every one of the 24 seats fills — 4 teams. Accept applicants and the real count takes over, or set a number of teams there and the assumption goes."
    );
  });

  it("carries the planner’s own reason when some are accepted but too few", () => {
    const html = render({ shape: perTeam(6), accepted: 4, capacity: 24 });
    expect(html).toContain(
      "6 per team on Setup → Format does not settle a count yet: Only 4 players are accepted, and one team of 6 needs 6. Accept more on the Applicants tab. Until it does, this preview assumes every one of the 24 seats fills — 4 teams."
    );
  });

  it("falls to the smallest event there is when there is no seat cap to assume", () => {
    const html = render({ shape: perTeam(6), accepted: 0, capacity: null });

    expect(html).toContain(`>${MIN_TEAMS}/${MAX_TEAMS}<`);
    expect(html).toContain(
      `Until it does, this preview is drawn for the smallest event there is — ${MIN_TEAMS} teams — because there is no seat cap to assume fills. Set a number of teams there and it is drawn for that instead.`
    );
  });

  it("falls to the smallest event when a full house would not fit, and says why", () => {
    const html = render({ shape: perTeam(3), accepted: 0, capacity: 64 });

    expect(html).toContain(`>${MIN_TEAMS}/${MAX_TEAMS}<`);
    expect(html).toContain(
      `this preview is drawn for the smallest event there is — ${MIN_TEAMS} teams — because a full house would not do: 64 players at 3 a team would make 22 teams, and an event can have at most ${MAX_TEAMS}.`
    );
  });
});

/* ------------------------------------------------------------------ */
/* The decision, directly                                             */
/* ------------------------------------------------------------------ */

describe("placeholderPlan", () => {
  it.each([
    ["a count of teams needs nobody accepted", ofTeams(5), 0, null, 5, false],
    ["a count of teams ignores the accepted", ofTeams(5), 30, 64, 5, false],
    ["players per team divide the accepted", perTeam(6), 18, null, 3, false],
    ["players per team fall back to the seats", perTeam(6), 0, 30, 5, true],
    ["players per team fall back to the seats past a too-small accepted", perTeam(6), 4, 30, 5, true],
    ["one team's worth plus one is two sides, and settled", perTeam(6), 7, 30, 2, false],
    ["no accepted and no cap is the smallest event", perTeam(6), 0, null, MIN_TEAMS, true],
    ["a cap too big for the site is the smallest event", perTeam(3), 0, 64, MIN_TEAMS, true],
  ] as const)("%s", (_name, shape, accepted, capacity, count, assumed) => {
    const plan = placeholderPlan(shape, accepted, capacity);
    expect(plan.count).toBe(count);
    expect(plan.sentence.includes("this preview")).toBe(assumed);
  });
});

/* ------------------------------------------------------------------ */
/* No invented default survives                                       */
/* ------------------------------------------------------------------ */

describe("no literal team-count default survives in the bracket tab", () => {
  /**
   * The scope of this sweep is honest and narrow: the bracket tab's own source,
   * with its comments stripped so a note about the old behaviour cannot be what
   * trips it — and this file is not what it reads, so its own literals cannot
   * vouch for it. The one number it hunts is the one the report was about.
   */
  const source = fs.readFileSync(path.resolve(__dirname, "../FormatTab.tsx"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("strips the comments it is told to ignore", () => {
    expect(code).not.toContain("plan §");
    expect(code).toContain("export default function FormatTab");
  });

  it("holds no bare eight anywhere in the code", () => {
    expect(code).not.toMatch(/\b8\b/);
  });

  it("seeds no state with a team count", () => {
    // `.*` and not `[^)]*`: the seed this hunts was `useState(() => Math.max(realCount, 8))`,
    // whose arrow's own `()` would stop a character class short of the name.
    expect(code).not.toMatch(/useState\(.*\brealCount\b/);
  });
});
