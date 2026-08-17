/**
 * Laying a bracket out as columns — the shape §5's "bracket canvas" needs.
 *
 * The old board stacks three fixed blocks (upper / lower / grand final) and
 * hand-places six slot ids inside them. That survives exactly one tournament
 * shape. This derives the layout instead: a **section** per half of the stage
 * and a **column** per round inside it, which is the same answer for four teams
 * as for eight and needs no branch for either.
 *
 * Pure, and it takes resolved matches rather than the generated spec: a
 * `ResolvedMatch` already carries its round, its half, its group and the words
 * for its round, so nothing here re-derives anything. Ordering is the order the
 * resolver produced, which is the generated order — so a column reads top to
 * bottom the way the bracket was built.
 */

import type { MatchBracket } from "@/lib/bracket";
import type { ResolvedMatch } from "@/lib/format-resolve";
import { bracketLabel } from "./labels";

export type BracketColumn = {
  /** Unique within the stage. */
  key: string;
  /** "Upper semis", "Lower round 2", "Grand final". */
  label: string;
  bracket: MatchBracket;
  round: number;
  matches: ResolvedMatch[];
};

export type BracketSection = {
  key: string;
  /** "Upper bracket", "Group A", "Bronze". */
  label: string;
  bracket: MatchBracket;
  /** The group key when this section is one group's table; null otherwise. */
  group: string | null;
  columns: BracketColumn[];
};

/** Board order, matching `format-schedule`'s so a column list reads like a day. */
const SECTION_ORDER: Record<MatchBracket, number> = {
  rr: 0,
  upper: 1,
  lower: 2,
  bronze: 3,
  final: 4,
};

/** "Group A · Round 1" inside a section already titled "Group A" is just "Round 1". */
function trimGroup(label: string, group: string | null): string {
  if (!group) return label;
  const prefix = `Group ${group.toUpperCase()} · `;
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

/**
 * Group a stage's matches into sections and columns.
 *
 * A group stage becomes one section per group rather than one shared "table"
 * section, because two groups' round 1s are not the same round and a column
 * holding both would say they were.
 */
export function bracketSections(matches: ResolvedMatch[]): BracketSection[] {
  const hasLower = matches.some((match) => match.bracket === "lower");
  const sections = new Map<string, BracketSection>();

  for (const match of matches) {
    const group = match.bracket === "rr" ? match.group : null;
    const sectionKey = group ? `rr:${group}` : match.bracket;

    let section = sections.get(sectionKey);
    if (!section) {
      section = {
        key: sectionKey,
        label: group ? `Group ${group.toUpperCase()}` : bracketLabel(match.bracket, hasLower),
        bracket: match.bracket,
        group,
        columns: [],
      };
      sections.set(sectionKey, section);
    }

    const columnKey = `${sectionKey}:${match.round}`;
    let column = section.columns.find((entry) => entry.key === columnKey);
    if (!column) {
      column = {
        key: columnKey,
        label: trimGroup(match.roundLabel, group),
        bracket: match.bracket,
        round: match.round,
        matches: [],
      };
      section.columns.push(column);
    }
    column.matches.push(match);
  }

  const out = [...sections.values()];
  out.sort(
    (x, y) =>
      SECTION_ORDER[x.bracket] - SECTION_ORDER[y.bracket] ||
      (x.group ?? "").localeCompare(y.group ?? "")
  );
  for (const section of out) section.columns.sort((x, y) => x.round - y.round);
  return out;
}

/**
 * The widest column in the whole stage.
 *
 * What the canvas uses to decide whether a section is worth centring: a column
 * of one against a column of four looks wrong centred, and right when it is.
 */
export function widestColumn(sections: BracketSection[]): number {
  let widest = 0;
  for (const section of sections) {
    for (const column of section.columns) {
      widest = Math.max(widest, column.matches.length);
    }
  }
  return widest;
}

/**
 * Which day each match runs on, from the block plan.
 *
 * The blocks own the day — a match's own `scheduledAt` is an instant and says
 * nothing about which of four days the organiser calls it — so this is the one
 * honest mapping, and the Results tab groups by it.
 */
export function dayBySlot(blocks: Array<{ day: number; slots: string[] }>): Map<string, number> {
  const out = new Map<string, number>();
  for (const block of blocks) {
    for (const slot of block.slots) out.set(slot, block.day);
  }
  return out;
}
