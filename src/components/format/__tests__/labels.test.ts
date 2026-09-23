/**
 * The words the format engine's output is printed with.
 *
 * These are display decisions, but two of them are load-bearing: `bronzeFor`
 * has to agree with `normaliseStageConfig` or the Format tab shows an option
 * that will not be stored, and `seriesSentence` is the one place the plan's
 * "Bo3, grand final Bo5" is turned back into a sentence.
 */

import { describe, expect, it } from "vitest";
import { generateStage } from "@/lib/bracket";
import { normaliseStageConfig } from "@/lib/format-policy";
import {
  advancePerGroup,
  bracketLabel,
  bronzeFor,
  formatSentence,
  hhmm,
  matchStatusLabel,
  matchStatusTone,
  modeLabel,
  modesInUse,
  seriesLabel,
  seriesLengthsInUse,
  seriesSentence,
  slotOriginLabel,
  stageKindLabel,
  tiebreakerLabel,
  STAGE_KIND_CHOICES,
} from "../labels";
import { resolveMatches } from "@/lib/format-resolve";
import { blankRecords, makeTeams } from "@/lib/__tests__/format-helpers";

/**
 * UC-11 8a: "Slot not yet decided - System shows where it comes from ('Winner
 * of Upper semi 1')." The example in the use case is the assertion.
 *
 * `format-resolve` decides *which* match feeds a slot and prints it as
 * "<label> winner"; `slotOriginLabel` only chooses the word order. So the
 * fixtures are real generated stages rather than hand-written strings: the
 * suffix this function removes is a contract with that module, and a test that
 * spelled both sides itself would keep passing after the contract moved.
 */
describe("slotOriginLabel", () => {
  /** Every unresolved slot of a stage nobody has played a game of yet. */
  const unplayed = (kind: "double_elim" | "single_elim" | "group_playoff", teams: number) => {
    const spec = generateStage(kind, teams);
    const resolved = resolveMatches({
      stage: spec,
      matches: blankRecords(spec),
      teams: makeTeams(teams),
    });
    return resolved.flatMap((match) => [
      ...(match.teamAId ? [] : [slotOriginLabel(match.sourceA, match.nameA)]),
      ...(match.teamBId ? [] : [slotOriginLabel(match.sourceB, match.nameB)]),
    ]);
  };

  it("says where a bracket slot's team comes from, the way UC-11 8a says it", () => {
    const said = unplayed("double_elim", 8);

    expect(said).toContain("Winner of Upper semi 1");
    expect(said).toContain("Winner of Upper quarter 1");
    expect(said).toContain("Loser of Upper final");
    expect(said).toContain("Winner of Lower round 2 \u00b7 1");
  });

  it("never leaves the relationship trailing behind the label", () => {
    const said = [
      ...unplayed("double_elim", 8),
      ...unplayed("single_elim", 8),
      ...unplayed("group_playoff", 8),
    ];

    expect(said.length).toBeGreaterThan(0);
    expect(said.filter((line) => /\s(winner|loser)$/i.test(line))).toEqual([]);
  });

  it("leaves the sources that already read forwards alone", () => {
    // A group placing and a seed are already noun-first, and a reference
    // nobody recognises has nothing to reword.
    expect(slotOriginLabel("group:a:rank:1", "Group A #1")).toBe("Group A #1");
    expect(slotOriginLabel("seed:3", "Seed 3")).toBe("Seed 3");
    expect(slotOriginLabel(null, "TBD")).toBe("TBD");
    expect(slotOriginLabel("nonsense", "TBD")).toBe("TBD");
  });

  it("does not take a word off the end of a name just because it reads like one", () => {
    // The source is consulted, not the string: a real team called
    // "Grand Final Winner" keeps its name. Callers only pass an unresolved
    // slot, but the function must not be the reason that rule has to hold.
    expect(slotOriginLabel("seed:2", "Grand Final Winner")).toBe("Grand Final Winner");
    // ...and a winner reference whose label somehow lost its suffix is left
    // exactly as the resolver produced it rather than rebuilt from a guess.
    expect(slotOriginLabel("winner:ubsf1", "Upper semi 1")).toBe("Upper semi 1");
    expect(slotOriginLabel("winner:ubsf1", "winner")).toBe("winner");
  });
});

describe("stageKindLabel", () => {
  it("names every kind the policy layer knows", () => {
    for (const choice of STAGE_KIND_CHOICES) {
      expect(stageKindLabel(choice.value)).toBe(choice.label);
    }
  });

  it("falls back to the raw value for a kind from the future", () => {
    expect(stageKindLabel("king_of_the_hill")).toBe("king_of_the_hill");
  });
});

describe("bracketLabel", () => {
  it("only calls a bracket 'upper' when there is a lower one to be upper of", () => {
    expect(bracketLabel("upper", true)).toBe("Upper bracket");
    expect(bracketLabel("upper", false)).toBe("Bracket");
  });
});

describe("bronzeFor", () => {
  it("agrees with what normaliseStageConfig will actually store", () => {
    for (const kind of ["single_elim", "double_elim", "round_robin", "swiss"] as const) {
      for (const chosen of ["none", "lower_final", "separate"] as const) {
        expect(bronzeFor(kind, chosen)).toBe(normaliseStageConfig(kind, { bronze: chosen }).bronze);
      }
    }
  });
});

describe("seriesSentence", () => {
  it("says a uniform stage in one phrase", () => {
    const spec = generateStage("round_robin", 4, { bestOf: 1 });
    expect(seriesSentence(spec)).toBe("Bo1 throughout");
  });

  it("names the exception rather than every match", () => {
    // The defaults: Bo3 through the bracket, Bo5 grand final.
    const spec = generateStage("double_elim", 4);
    expect(seriesSentence(spec)).toBe("Bo3, grand final Bo5");
  });

  it("is empty when there is nothing to say", () => {
    expect(seriesSentence({ ...generateStage("round_robin", 2), matches: [] })).toBe("");
  });
});

describe("seriesLabel and modeLabel", () => {
  it("prints a series length the way everybody says it", () => {
    expect(seriesLabel(3)).toBe("Bo3");
  });

  it("turns a stored mode key back into words", () => {
    expect(modeLabel("domination")).toBe("Domination");
    expect(modeLabel("payload_escort")).toBe("Payload escort");
    expect(modeLabel("")).toBe("Unnamed mode");
  });
});

describe("modesInUse and seriesLengthsInUse", () => {
  it("reports what the stage actually plays, in first-seen order", () => {
    const spec = generateStage("double_elim", 4);
    expect(modesInUse(spec)).toEqual(["convoy", "domination"]);
    expect(seriesLengthsInUse(spec)).toEqual([3, 5]);
  });
});

describe("formatSentence", () => {
  it("says a double elimination in the plain words §6.2 asks for", () => {
    expect(formatSentence(generateStage("double_elim", 8))).toEqual([
      "8 teams",
      "double elimination",
      "Bo3, grand final Bo5",
      "lower final doubles as bronze",
    ]);
  });

  it("mentions the reset only when there is one", () => {
    expect(formatSentence(generateStage("double_elim", 4, { bracketReset: true }))).toContain(
      "bracket reset on"
    );
    expect(formatSentence(generateStage("double_elim", 4))).not.toContain("bracket reset on");
  });

  it("describes a group stage by its groups and what they feed", () => {
    const parts = formatSentence(
      generateStage("group_playoff", 8, { groups: 2, advancePerGroup: 2 })
    );
    expect(parts).toContain("2 groups, top 2 through");
    expect(parts).toContain("single elimination playoff");
  });

  it("says home and away when the table is played twice", () => {
    expect(formatSentence(generateStage("round_robin", 4, { doubleRound: true }))).toContain(
      "home and away"
    );
  });
});

describe("advancePerGroup", () => {
  it("is capped by the thinnest group, exactly as the generator caps it", () => {
    // Five teams into two groups is three and two — only two can go through.
    const spec = generateStage("group_playoff", 5, { groups: 2, advancePerGroup: 3 });
    expect(advancePerGroup(spec)).toBe(2);
  });

  it("is nothing at all when the stage has no groups", () => {
    expect(advancePerGroup(generateStage("double_elim", 4))).toBe(0);
  });
});

describe("match status", () => {
  const base = { status: "pending" as const, needsDecision: false };

  it("says a drawn knockout series needs a winner before it says anything else", () => {
    expect(matchStatusLabel({ status: "done", needsDecision: true })).toBe("Needs a winner");
    expect(matchStatusTone({ status: "done", needsDecision: true })).toBe("open");
  });

  it("maps the four statuses onto the pill's vocabulary", () => {
    expect(matchStatusLabel(base)).toBe("Not played");
    expect(matchStatusTone(base)).toBe("draft");
    expect(matchStatusTone({ ...base, status: "live" })).toBe("live");
    expect(matchStatusTone({ ...base, status: "done" })).toBe("complete");
    expect(matchStatusLabel({ ...base, status: "void" })).toBe("Not needed");
    expect(matchStatusTone({ ...base, status: "void" })).toBe("cancelled");
  });
});

describe("hhmm", () => {
  it("is the old board's unit, to the minute", () => {
    expect(hhmm(0)).toBe("0h 00m");
    expect(hhmm(65)).toBe("1h 05m");
    expect(hhmm(600)).toBe("10h 00m");
  });

  it("never prints a negative day", () => {
    expect(hhmm(-30)).toBe("0h 00m");
  });
});

describe("tiebreakerLabel", () => {
  it("names the rules, and says which one is terminal", () => {
    expect(tiebreakerLabel("mini_league")).toBe("Mini league between the level teams");
    expect(tiebreakerLabel("name")).toContain("always");
    expect(tiebreakerLabel("coin_toss")).toBe("coin_toss");
  });
});
