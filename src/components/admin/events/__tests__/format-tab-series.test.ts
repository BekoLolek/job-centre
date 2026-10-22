import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { generateStage } from "@/lib/bracket";
import { normaliseStageConfig } from "@/lib/format-policy";

/*
 * What the Format tab *says* about the series lengths and the modes — UC-18 E1,
 * E2 and E3.
 *
 * All three are settings a manager chooses here and then reads back off a
 * bracket somewhere else, so the screen's own account of them is the thing
 * under test. In particular E2's precedence: a per-half length and a per-round
 * length can both name one match, only one of them applies, and until this was
 * walked the paragraph above the controls described the *opposite* order to the
 * one `bestOfFor` used — and the shadowed round went on showing its own length
 * as though it still applied.
 *
 * `StageSettings` is rendered rather than the whole tab because `Disclosure`
 * unmounts what it is shut over, and this panel is shut on a first render.
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

const { StageSettings, shadowedRounds } = await import("../FormatTab");

/** The settings panel for one generated stage, as markup. */
function render(
  kind: Parameters<typeof generateStage>[0],
  teamCount: number,
  config: Parameters<typeof generateStage>[2] = null
): string {
  const spec = generateStage(kind, teamCount, normaliseStageConfig(kind, config ?? null));
  return renderToStaticMarkup(
    createElement(StageSettings, { kind, spec, onConfig: () => {} })
  );
}

/* ------------------------------------------------------------------ */
/* UC-18 E2 — which length wins, and whether the screen says so       */
/* ------------------------------------------------------------------ */

describe("the Format tab on series lengths (UC-18 E2, R-154)", () => {
  it("states the order the engine actually applies", () => {
    /*
     * Asserted as the whole sentence rather than as the four words in it: a
     * paragraph naming a match, a half, a round and a default in *some* order
     * would satisfy four separate `toContain`s whichever way round it put
     * them, which is exactly how the wrong order survived being read.
     */
    const html = render("double_elim", 4);
    expect(html).toContain(
      "A named match wins outright, then a half of the bracket, then a round number, then the stage default."
    );
    expect(html).toContain("The half beats the round because round numbers restart in each half");
  });

  it("offers a control for the stage, each half in use, and each named match", () => {
    const html = render("double_elim", 4);

    expect(html).toContain("Stage default");
    // The halves a four-team double elimination actually has, and not the ones
    // it does not: there is no group table and no separate bronze match.
    expect(html).toContain("Upper bracket");
    expect(html).toContain("Lower bracket");
    expect(html).toContain("Grand final");
    expect(html).not.toContain("Table games");
    expect(html).not.toContain("Bronze match");
  });

  it("says nothing about a shadowed round while no round is set", () => {
    const html = render("double_elim", 4, { bestOf: 3, bestOfByBracket: { upper: 5 } });
    expect(html).not.toContain("is also covered by a half of the bracket");
  });

  it("names the round whose own length does not apply", () => {
    /*
     * Round 1 is set to Bo7 and the upper bracket to Bo5, so the upper
     * bracket's round 1 plays Bo5 — the round's select still shows Bo7, which
     * is why the screen has to say that it is not what gets played.
     */
    const html = render("double_elim", 4, {
      bestOf: 3,
      bestOfByBracket: { upper: 5 },
      bestOfByRound: { "1": 7 },
    });
    expect(html).toContain(
      "Round 1 is also covered by a half of the bracket or by a named match, and that wins"
    );
  });

  it("conjugates and lists more than one", () => {
    const html = render("double_elim", 4, {
      bestOf: 3,
      bestOfByBracket: { upper: 5, lower: 1 },
      bestOfByRound: { "1": 7, "2": 7 },
    });
    expect(html).toContain("Round 1, Round 2 are also covered");
  });
});

describe("shadowedRounds (UC-18 E2)", () => {
  const spec = (config: Parameters<typeof generateStage>[2]) =>
    generateStage("double_elim", 4, config);

  it("is empty when every round's own length is what its matches play", () => {
    expect(shadowedRounds(spec({ bestOf: 3, bestOfByRound: { "1": 5, "2": 5 } }))).toEqual([]);
  });

  it("names a round a half overrides", () => {
    expect(
      shadowedRounds(spec({ bestOf: 3, bestOfByBracket: { upper: 1 }, bestOfByRound: { "1": 5 } }))
    ).toEqual([1]);
  });

  it("names a round a single named match overrides", () => {
    /*
     * The grand final is round 3 of a four-team double elimination — past the
     * last round of either half, so a per-round length can name it without
     * catching a lower-bracket round of the same number — and it carries
     * `{ gf: 5 }` by default. So setting round 3 to Bo1 sets nothing.
     */
    expect(shadowedRounds(spec({ bestOf: 3, bestOfByRound: { "3": 1 } }))).toEqual([3]);
  });

  it("ignores a round the stage does not play", () => {
    // A key left behind by a shape that had more rounds names no matches, so
    // there is nothing for it to be shadowing.
    expect(shadowedRounds(spec({ bestOf: 3, bestOfByRound: { "9": 1 } }))).toEqual([]);
  });

  it("ignores a round nobody has set a length for", () => {
    expect(shadowedRounds(spec({ bestOf: 3, bestOfByBracket: { upper: 1 } }))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* UC-18 E1 — a mode per map of a series length                        */
/* ------------------------------------------------------------------ */

describe("the Format tab on modes per map (UC-18 E1, R-152)", () => {
  it("offers one field per map, for each series length the stage plays", () => {
    /*
     * A four-team double elimination is Bo3 with a Bo5 grand final by default,
     * so there are two sequences to fill in — three games and five — and the
     * fields are labelled by position because the sequence is ordered.
     */
    const html = render("double_elim", 4);
    const count = (needle: string) => html.split(needle).length - 1;

    expect(html).toContain("Map and mode sequence");
    expect(html).toContain("Bo3");
    expect(html).toContain("Bo5");
    expect(count('value="convoy"')).toBe(2 + 4);
    expect(count('value="domination"')).toBe(2);
    // Game 4 and game 5 exist only in the Bo5 row.
    expect([count("Game 1"), count("Game 3"), count("Game 4"), count("Game 5")]).toEqual([
      2, 2, 1, 1,
    ]);
  });

  it("shows the modes that are configured, not the defaults", () => {
    const html = render("round_robin", 4, {
      bestOf: 3,
      modeSequence: { "3": ["escort", "control", "hardpoint"] },
    });
    expect(html).toContain('value="escort"');
    expect(html).toContain('value="control"');
    expect(html).toContain('value="hardpoint"');
    expect(html).not.toContain('value="convoy"');
  });

  it("says a mode is the game's own word rather than one of two", () => {
    const html = render("double_elim", 4);
    expect(html).toContain(
      "A mode is a plain name that belongs to the game rather than to this site"
    );
  });
});

/* ------------------------------------------------------------------ */
/* Found walking E1/E2: the bronze row marked two chips at once        */
/* ------------------------------------------------------------------ */

describe("the Format tab on third place (UC-18 4)", () => {
  /**
   * `normaliseStageConfig` collapses the two bronze modes into whichever one
   * the bracket can express — `separate` in a single elimination, the lower
   * final in a double one — and the row compared each chip against the
   * collapsed value, so two of the three came out selected for one setting.
   */
  const pressed = (html: string) => html.split('aria-pressed="true"').length - 1;

  it("offers a double elimination its two answers, one of them current", () => {
    const html = render("double_elim", 4);
    expect(html).toContain("Lower final doubles as bronze");
    expect(html).not.toContain("A separate bronze match");
    // The bracket reset toggle is the only other pressed control in here.
    expect(pressed(html)).toBe(2);
  });

  it("offers a single elimination its own two, and not the lower final's", () => {
    const html = render("single_elim", 4);
    expect(html).toContain("A separate bronze match");
    expect(html).not.toContain("Lower final doubles as bronze");
    expect(pressed(html)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* UC-18 E3 — a round robin played twice                              */
/* ------------------------------------------------------------------ */

describe("the Format tab on a double round robin (UC-18 E3, R-155)", () => {
  it("offers the return leg on a table, with both answers named", () => {
    const html = render("round_robin", 4);
    expect(html).toContain("Play every pair twice");
    expect(html).toContain("Home and away");
    expect(html).toContain("Once");
  });

  it("offers it on a group stage's tables too", () => {
    const html = render("group_playoff", 4, { groups: 2 });
    expect(html).toContain("Play every pair twice");
  });

  it("does not offer it on a Swiss, which has no pairs to repeat", () => {
    /*
     * A Swiss's rounds are paired from the table as it stands, so "every pair
     * twice" is not a thing it can be asked for — and `normaliseStageConfig`
     * would keep the flag while `generateStage` ignored it.
     */
    const html = render("swiss", 4);
    expect(html).toContain("Table scoring");
    expect(html).not.toContain("Play every pair twice");
  });

  it("does not offer it on a bracket, which has no table at all", () => {
    const html = render("double_elim", 4);
    expect(html).not.toContain("Table scoring");
    expect(html).not.toContain("Play every pair twice");
  });
});
