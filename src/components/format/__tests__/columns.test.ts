/**
 * The bracket canvas's layout, over every shape and every team count.
 *
 * The point of the module is that it has no per-size branch, so these are
 * mostly properties rather than fixtures: every match lands in exactly one
 * column, columns are in round order, and the section order is the board order
 * the scheduler already uses. The one hard fixture is the eight-team double
 * elimination — the shape §5 says the old three-block grid cannot survive.
 */

import { describe, expect, it } from "vitest";
import { generateStage } from "@/lib/bracket";
import { resolveMatches } from "@/lib/format-resolve";
import { makeTeams, TEAM_COUNTS } from "@/lib/__tests__/format-helpers";
import { bracketSections, dayBySlot, widestColumn } from "../columns";

function sectionsFor(kind: Parameters<typeof generateStage>[0], teamCount: number, config = {}) {
  const spec = generateStage(kind, teamCount, config);
  const teams = makeTeams(spec.teamCount);
  return {
    spec,
    sections: bracketSections(
      resolveMatches({ stage: spec, matches: [], teams, seeds: teams.map((t) => t.id) })
    ),
  };
}

describe("bracketSections", () => {
  it("puts an eight-team double elimination in eight columns, not three blocks", () => {
    const { spec, sections } = sectionsFor("double_elim", 8);

    // 7 upper, 6 lower, one grand final.
    expect(spec.matches).toHaveLength(14);
    expect(sections.map((section) => section.label)).toEqual([
      "Upper bracket",
      "Lower bracket",
      "Grand final",
    ]);
    expect(sections.map((section) => section.columns.length)).toEqual([3, 4, 1]);
    expect(sections[0].columns.map((column) => column.matches.length)).toEqual([4, 2, 1]);
    expect(sections[1].columns.map((column) => column.matches.length)).toEqual([2, 2, 1, 1]);
    expect(sections[0].columns.map((column) => column.label)).toEqual([
      "Upper quarters",
      "Upper semis",
      "Upper final",
    ]);
  });

  it("calls the only bracket 'Bracket' when there is no lower one to be upper of", () => {
    const { sections } = sectionsFor("single_elim", 8);
    expect(sections[0].label).toBe("Bracket");
  });

  it.each(TEAM_COUNTS)("places every match exactly once for %i teams", (teamCount) => {
    for (const kind of ["single_elim", "double_elim", "round_robin", "group_playoff"] as const) {
      const { spec, sections } = sectionsFor(kind, teamCount);
      const placed = sections.flatMap((section) =>
        section.columns.flatMap((column) => column.matches.map((match) => match.slot))
      );
      expect([...placed].sort()).toEqual(spec.matches.map((match) => match.slot).sort());
      expect(new Set(placed).size).toBe(placed.length);
    }
  });

  it.each(TEAM_COUNTS)("keeps columns in round order for %i teams", (teamCount) => {
    const { sections } = sectionsFor("double_elim", teamCount);
    for (const section of sections) {
      const rounds = section.columns.map((column) => column.round);
      expect(rounds).toEqual([...rounds].sort((x, y) => x - y));
      // Every match in a column belongs to that column's round and half.
      for (const column of section.columns) {
        for (const match of column.matches) {
          expect(match.round).toBe(column.round);
          expect(match.bracket).toBe(column.bracket);
        }
      }
    }
  });

  it("gives a group stage one section per group, and trims the repeated prefix", () => {
    const { sections } = sectionsFor("group_playoff", 8, { groups: 2, advancePerGroup: 2 });

    expect(sections.slice(0, 2).map((section) => section.label)).toEqual(["Group A", "Group B"]);
    expect(sections[0].group).toBe("a");
    // The section is already called "Group A"; its columns must not say so again.
    expect(sections[0].columns.map((column) => column.label)).toEqual([
      "Round 1",
      "Round 2",
      "Round 3",
    ]);
    // …and the bracket halves follow the tables. A single-elimination playoff
    // can only express third place as a match of its own, so there is one.
    expect(sections.map((section) => section.bracket)).toEqual([
      "rr",
      "rr",
      "upper",
      "bronze",
    ]);
  });

  it("orders sections the way the schedule orders blocks", () => {
    const { sections } = sectionsFor("single_elim", 4, { bronze: "separate" });
    expect(sections.map((section) => section.bracket)).toEqual(["upper", "bronze"]);
  });

  it("keeps a bracket reset in the finals column", () => {
    const { sections } = sectionsFor("double_elim", 4, { bracketReset: true });
    const finals = sections.find((section) => section.bracket === "final");
    expect(finals?.columns.flatMap((column) => column.matches.map((m) => m.slot))).toEqual([
      "gf",
      "gf2",
    ]);
    // Two rounds, so two columns — the reset is not squeezed in beside the final.
    expect(finals?.columns).toHaveLength(2);
  });

  it("lays a round robin out one column per round", () => {
    const { sections } = sectionsFor("round_robin", 6);
    expect(sections).toHaveLength(1);
    expect(sections[0].label).toBe("Table");
    // Six teams is five rounds of three matches.
    expect(sections[0].columns).toHaveLength(5);
    expect(sections[0].columns.every((column) => column.matches.length === 3)).toBe(true);
  });
});

describe("widestColumn", () => {
  it("is the biggest single round anywhere in the stage", () => {
    const { sections } = sectionsFor("double_elim", 8);
    expect(widestColumn(sections)).toBe(4);
    expect(widestColumn([])).toBe(0);
  });
});

describe("dayBySlot", () => {
  it("maps every slot of every block to its day", () => {
    const days = dayBySlot([
      { day: 1, slots: ["ubqf1", "ubqf2"] },
      { day: 2, slots: ["gf"] },
    ]);
    expect(days.get("ubqf1")).toBe(1);
    expect(days.get("gf")).toBe(2);
    expect(days.get("nowhere")).toBeUndefined();
  });
});
