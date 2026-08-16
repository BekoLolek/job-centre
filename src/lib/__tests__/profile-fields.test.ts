import { describe, expect, it } from "vitest";
import type { ProfileFieldOption } from "@/db/schema";
import {
  FIELD_TYPES,
  NUMBER_MAX,
  TEXT_MAX_LENGTH,
  choicesFor,
  fieldTypeInfo,
  formatAnswer,
  groupRankLadder,
  hasAnswer,
  isFieldType,
  normaliseOptions,
  normaliseRankLadder,
  parseProfileValue,
  reorder,
  reorderById,
  sectionCompleteness,
  slugify,
  uniqueKey,
  valueStillValid,
} from "@/lib/profile-fields";
import { RIVALS_RANK_LADDER } from "@/db/seed";

const options = (...labels: string[]): ProfileFieldOption[] =>
  labels.map((label) => ({ value: slugify(label), label }));

const ROLES = options("Vanguard", "Duelist", "Strategist");

describe("slugify", () => {
  it("turns a label into a key without the admin ever seeing one", () => {
    expect(slugify("Preferred roles")).toBe("preferred-roles");
    expect(slugify("In-game name")).toBe("in-game-name");
    expect(slugify("REPO")).toBe("repo");
  });

  it("collapses runs of punctuation and trims the edges", () => {
    expect(slugify("  What's your rank?!  ")).toBe("what-s-your-rank");
    expect(slugify("a---b")).toBe("a-b");
    expect(slugify("!!!")).toBe("");
  });

  it("folds accents rather than dropping the letters", () => {
    expect(slugify("Café")).toBe("cafe");
  });

  it("never ends on a dash, even when the cut lands on one", () => {
    const key = slugify("aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee", 21);
    expect(key.endsWith("-")).toBe(false);
    expect(key.length).toBeLessThanOrEqual(21);
  });
});

describe("uniqueKey", () => {
  it("uses the plain slug when it is free", () => {
    expect(uniqueKey("Preferred roles", ["ign", "rank"])).toBe("preferred-roles");
  });

  it("suffixes rather than colliding", () => {
    expect(uniqueKey("Notes", ["notes"])).toBe("notes-2");
    expect(uniqueKey("Notes", ["notes", "notes-2"])).toBe("notes-3");
  });

  it("falls back when the label slugs to nothing", () => {
    expect(uniqueKey("🎮🎮", [])).toBe("field");
    expect(uniqueKey("🎮🎮", ["question"], "question")).toBe("question-2");
  });
});

describe("normaliseOptions", () => {
  it("accepts the plain lines an admin types", () => {
    expect(normaliseOptions(["Vanguard", " Duelist ", "", "Strategist"])).toEqual([
      { value: "vanguard", label: "Vanguard" },
      { value: "duelist", label: "Duelist" },
      { value: "strategist", label: "Strategist" },
    ]);
  });

  it("accepts already-shaped options coming back from a form", () => {
    expect(normaliseOptions([{ value: "duelist", label: "Duelist" }])).toEqual([
      { value: "duelist", label: "Duelist" },
    ]);
  });

  it("keeps the first of two options that slug to the same value", () => {
    expect(normaliseOptions(["Party Pack", "party pack"])).toEqual([
      { value: "party-pack", label: "Party Pack" },
    ]);
  });

  it("shows the value when only a value was supplied", () => {
    expect(normaliseOptions([{ value: "duelist" }])).toEqual([
      { value: "duelist", label: "duelist" },
    ]);
  });

  it("is empty for anything that is not a list", () => {
    expect(normaliseOptions(null)).toEqual([]);
    expect(normaliseOptions("Vanguard")).toEqual([]);
    expect(normaliseOptions([42, null, {}])).toEqual([]);
  });
});

describe("field types", () => {
  it("puts free text last, because it is the exception (plan §2)", () => {
    expect(FIELD_TYPES[FIELD_TYPES.length - 1].type).toBe("text");
  });

  it("knows which types need an option list", () => {
    expect(fieldTypeInfo("select").needsOptions).toBe(true);
    expect(fieldTypeInfo("multiselect").needsOptions).toBe(true);
    expect(fieldTypeInfo("rank").needsOptions).toBe(false);
    expect(fieldTypeInfo("rank").usesRankLadder).toBe(true);
  });

  it("vets a type name off the wire", () => {
    expect(isFieldType("select")).toBe(true);
    expect(isFieldType("SELECT")).toBe(false);
    expect(isFieldType("dropdown")).toBe(false);
    expect(isFieldType(undefined)).toBe(false);
  });
});

describe("choicesFor", () => {
  it("reads the ladder for a rank field and the options for the rest", () => {
    expect(choicesFor("rank", [], ["Bronze III", "Bronze II"])).toEqual([
      { value: "Bronze III", label: "Bronze III" },
      { value: "Bronze II", label: "Bronze II" },
    ]);
    expect(choicesFor("select", ROLES, ["Bronze III"])).toEqual(ROLES);
    expect(choicesFor("bool", ROLES, ["Bronze III"])).toEqual([]);
  });
});

describe("groupRankLadder", () => {
  const grouped = groupRankLadder([...RIVALS_RANK_LADDER]);

  it("turns 23 entries into a handful of tiers, so a pick is two taps", () => {
    expect(RIVALS_RANK_LADDER.length).toBe(23);
    expect(grouped.map((tier) => tier.tier)).toEqual([
      "Bronze",
      "Silver",
      "Gold",
      "Platinum",
      "Diamond",
      "Grandmaster",
      "Celestial",
      "Eternity",
      "One Above All",
    ]);
  });

  it("keeps every entry, its ladder index and its division", () => {
    const diamond = grouped.find((tier) => tier.tier === "Diamond");
    expect(diamond?.entries.map((entry) => entry.division)).toEqual(["III", "II", "I"]);
    const diamondTwo = diamond?.entries.find((entry) => entry.division === "II");
    expect(diamondTwo?.name).toBe("Diamond II");
    expect(RIVALS_RANK_LADDER[diamondTwo!.index]).toBe("Diamond II");
  });

  it("makes an undivided entry a one-tap tier of its own", () => {
    const eternity = grouped.find((tier) => tier.tier === "Eternity");
    expect(eternity?.entries).toHaveLength(1);
    expect(eternity?.entries[0].division).toBeNull();
  });

  it("handles numeric divisions and a ladder an admin invents this afternoon", () => {
    expect(groupRankLadder(["Wood 2", "Wood 1", "Legend"])).toEqual([
      {
        tier: "Wood",
        entries: [
          { name: "Wood 2", index: 0, division: "2" },
          { name: "Wood 1", index: 1, division: "1" },
        ],
      },
      { tier: "Legend", entries: [{ name: "Legend", index: 2, division: null }] },
    ]);
  });

  it("does not merge two runs of the same tier that are far apart", () => {
    const tiers = groupRankLadder(["Gold II", "Silver I", "Gold I"]);
    expect(tiers.map((tier) => tier.tier)).toEqual(["Gold", "Silver", "Gold"]);
  });

  it("is empty for a game without ranks, like Jackbox", () => {
    expect(groupRankLadder([])).toEqual([]);
  });
});

describe("normaliseRankLadder", () => {
  it("trims, drops blanks and drops duplicates while keeping the order", () => {
    expect(normaliseRankLadder(["  Bronze  ", "", "Silver", "bronze", "Gold"])).toEqual([
      "Bronze",
      "Silver",
      "Gold",
    ]);
  });

  it("accepts an empty ladder, because Jackbox has no ranks", () => {
    expect(normaliseRankLadder([])).toEqual([]);
    expect(normaliseRankLadder(null)).toEqual([]);
  });
});

describe("parseProfileValue", () => {
  const select = { type: "select" as const, label: "Role", options: ROLES };
  const multi = { type: "multiselect" as const, label: "Roles", options: ROLES };
  const rank = {
    type: "rank" as const,
    label: "Rank",
    options: [],
    rankLadder: [...RIVALS_RANK_LADDER],
  };

  it("accepts a legal choice and rejects an invented one", () => {
    expect(parseProfileValue(select, "duelist")).toEqual({ ok: true, value: "duelist" });
    expect(parseProfileValue(select, "healer")).toMatchObject({ ok: false });
  });

  it("treats blank as clearing the answer, for every type", () => {
    expect(parseProfileValue(select, "")).toEqual({ ok: true, value: null });
    expect(parseProfileValue(rank, null)).toEqual({ ok: true, value: null });
    expect(parseProfileValue({ type: "bool", label: "V", options: [] }, "")).toEqual({
      ok: true,
      value: null,
    });
    expect(parseProfileValue({ type: "number", label: "N", options: [] }, "")).toEqual({
      ok: true,
      value: null,
    });
    expect(parseProfileValue({ type: "text", label: "T", options: [] }, "   ")).toEqual({
      ok: true,
      value: null,
    });
    expect(parseProfileValue(multi, null)).toEqual({ ok: true, value: [] });
  });

  it("clears a rank rather than trusting one the ladder does not have", () => {
    expect(parseProfileValue(rank, "Diamond II")).toEqual({ ok: true, value: "Diamond II" });
    expect(parseProfileValue(rank, "Diamond IV")).toMatchObject({ ok: false });
    // The ladder is the source: an empty one accepts nothing at all.
    expect(parseProfileValue({ ...rank, rankLadder: [] }, "Diamond II")).toMatchObject({
      ok: false,
    });
  });

  it("returns a multiselect in the admin's option order, not the tapping order", () => {
    expect(parseProfileValue(multi, ["strategist", "vanguard"])).toEqual({
      ok: true,
      value: ["vanguard", "strategist"],
    });
  });

  it("de-duplicates a multiselect and rejects one bad entry outright", () => {
    expect(parseProfileValue(multi, ["duelist", "duelist"])).toEqual({
      ok: true,
      value: ["duelist"],
    });
    expect(parseProfileValue(multi, ["duelist", "healer"])).toMatchObject({ ok: false });
    expect(parseProfileValue(multi, "duelist")).toMatchObject({ ok: false });
  });

  it("reads the spellings of yes and no a form can post", () => {
    const bool = { type: "bool" as const, label: "Voice", options: [] };
    for (const yes of [true, "true", "on", 1, "1"]) {
      expect(parseProfileValue(bool, yes)).toEqual({ ok: true, value: true });
    }
    for (const no of [false, "false", "off", 0, "0"]) {
      expect(parseProfileValue(bool, no)).toEqual({ ok: true, value: false });
    }
    expect(parseProfileValue(bool, "maybe")).toMatchObject({ ok: false });
  });

  it("keeps numbers whole and in range", () => {
    const number = { type: "number" as const, label: "Hours", options: [] };
    expect(parseProfileValue(number, "12")).toEqual({ ok: true, value: 12 });
    expect(parseProfileValue(number, 0)).toEqual({ ok: true, value: 0 });
    expect(parseProfileValue(number, 1.5)).toMatchObject({ ok: false });
    expect(parseProfileValue(number, -1)).toMatchObject({ ok: false });
    expect(parseProfileValue(number, NUMBER_MAX + 1)).toMatchObject({ ok: false });
    expect(parseProfileValue(number, "twelve")).toMatchObject({ ok: false });
    expect(parseProfileValue(number, Number.POSITIVE_INFINITY)).toMatchObject({ ok: false });
  });

  it("trims text and refuses an essay", () => {
    const text = { type: "text" as const, label: "IGN", options: [] };
    expect(parseProfileValue(text, "  lolek  ")).toEqual({ ok: true, value: "lolek" });
    expect(parseProfileValue(text, "x".repeat(TEXT_MAX_LENGTH))).toMatchObject({ ok: true });
    expect(parseProfileValue(text, "x".repeat(TEXT_MAX_LENGTH + 1))).toMatchObject({
      ok: false,
    });
    expect(parseProfileValue(text, 42)).toMatchObject({ ok: false });
  });

  it("does not let a payload smuggle in its own options", () => {
    // The only thing that decides legality is the field, which came from the
    // database — nothing in the request can widen it.
    const narrowed = { ...select, options: options("Vanguard") };
    expect(parseProfileValue(narrowed, "duelist")).toMatchObject({ ok: false });
  });
});

describe("valueStillValid", () => {
  const select = { type: "select" as const, label: "Role", options: ROLES };

  it("is what an admin edit is measured against", () => {
    expect(valueStillValid(select, "duelist")).toBe(true);
    // The admin deleted the Duelist option.
    expect(valueStillValid({ ...select, options: options("Vanguard") }, "duelist")).toBe(false);
    // The admin retyped the question as a number.
    expect(valueStillValid({ type: "number", label: "Role", options: [] }, "duelist")).toBe(
      false
    );
  });

  it("does not count an empty answer as valid", () => {
    expect(valueStillValid(select, null)).toBe(false);
    expect(
      valueStillValid({ type: "multiselect", label: "Roles", options: ROLES }, [])
    ).toBe(false);
  });

  it("keeps a false as a real answer", () => {
    expect(valueStillValid({ type: "bool", label: "Voice", options: [] }, false)).toBe(true);
  });

  it("keeps a zero as a real answer", () => {
    expect(valueStillValid({ type: "number", label: "Hours", options: [] }, 0)).toBe(true);
  });
});

describe("hasAnswer and completeness", () => {
  it("counts false and zero as answers, but not [] or ''", () => {
    expect(hasAnswer(false)).toBe(true);
    expect(hasAnswer(0)).toBe(true);
    expect(hasAnswer([])).toBe(false);
    expect(hasAnswer("")).toBe(false);
    expect(hasAnswer(null)).toBe(false);
    expect(hasAnswer(undefined)).toBe(false);
  });

  it("counts only the required fields, and names the ones still waiting", () => {
    expect(
      sectionCompleteness([
        { label: "IGN", required: true, value: "lolek" },
        { label: "Rank", required: true, value: null },
        { label: "Roles", required: false, value: null },
      ])
    ).toEqual({ answered: 1, required: 2, complete: false, missing: ["Rank"] });
  });

  it("is complete when nothing is required", () => {
    expect(sectionCompleteness([{ label: "Packs", required: false, value: null }])).toEqual({
      answered: 0,
      required: 0,
      complete: true,
      missing: [],
    });
  });
});

describe("formatAnswer", () => {
  const multi = { type: "multiselect" as const, label: "Roles", options: ROLES };

  it("reads an answer back in the admin's labels, not the stored values", () => {
    expect(formatAnswer(multi, ["vanguard", "duelist"])).toBe("Vanguard, Duelist");
    expect(formatAnswer({ type: "bool", label: "V", options: [] }, true)).toBe("Yes");
    expect(formatAnswer({ type: "number", label: "N", options: [] }, 0)).toBe("0");
    expect(formatAnswer(multi, [])).toBe("—");
  });
});

describe("reorder", () => {
  const list = ["a", "b", "c"];

  it("swaps with the neighbour", () => {
    expect(reorder(list, 1, "up")).toEqual(["b", "a", "c"]);
    expect(reorder(list, 1, "down")).toEqual(["a", "c", "b"]);
  });

  it("does nothing at the ends rather than throwing", () => {
    expect(reorder(list, 0, "up")).toEqual(list);
    expect(reorder(list, 2, "down")).toEqual(list);
    expect(reorder(list, -1, "up")).toEqual(list);
    expect(reorder([], 0, "up")).toEqual([]);
  });

  it("does not mutate the input", () => {
    const original = [...list];
    reorder(list, 1, "up");
    expect(list).toEqual(original);
  });

  it("moves by id for rows held as objects", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    expect(reorderById(rows, "b", "up").map((row) => row.id)).toEqual(["b", "a"]);
    expect(reorderById(rows, "nope", "up").map((row) => row.id)).toEqual(["a", "b"]);
  });
});
