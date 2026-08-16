import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Database, games, profileFields, profileValues } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { RIVALS_RANK_LADDER } from "@/db/seed";
import {
  createField,
  createGame,
  deleteField,
  fieldAnswerCount,
  loadAdminGames,
  moveField,
  moveGame,
  previewFieldEdit,
  previewRankLadder,
  renameGame,
  setGameActive,
  setRankLadder,
  updateField,
} from "@/lib/admin-games";
import { loadProfile, saveProfileSection } from "@/lib/profile";

/**
 * The admin's half of Phase 1, against real Postgres.
 *
 * The thing worth testing hardest is not that a row can be inserted — it is
 * what happens to *answers already stored* when the question they answered
 * changes underneath them. Every destructive path here is expected to say what
 * it will destroy before it does it, and to leave nothing dangling afterwards.
 */

let harness: TestDatabase;
let db: Database;
let userId: string;

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await db.delete(profileValues);
  await db.delete(profileFields);
  await db.delete(games);
  userId = await makeUser(db);
});

/** The admin flow the brief is measured against: a game, then two questions. */
async function addRepo() {
  const game = await createGame({ name: "REPO" }, db);
  if (!game.ok) throw new Error(game.error);
  return game.data;
}

/* ------------------------------------------------------------------ */

describe("createGame", () => {
  it("takes a name and nothing else", async () => {
    const result = await createGame({ name: "  REPO  " }, db);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.name).toBe("REPO");
    expect(result.data.key).toBe("repo");
    expect(result.data.isActive).toBe(true);
    expect(result.data.rankLadder).toEqual([]);
  });

  it("slugs the key from the name so an admin never types one", async () => {
    const result = await createGame({ name: "Marvel Rivals" }, db);
    if (result.ok) expect(result.data.key).toBe("marvel-rivals");
  });

  it("puts each new game at the bottom of the order", async () => {
    await createGame({ name: "First" }, db);
    await createGame({ name: "Second" }, db);
    const rows = await db.select().from(games).orderBy(asc(games.sort));
    expect(rows.map((row) => row.name)).toEqual(["First", "Second"]);
    expect(rows.map((row) => row.sort)).toEqual([0, 1]);
  });

  it("reports a clashing key rather than inventing repo-2", async () => {
    await createGame({ name: "REPO" }, db);
    const second = await createGame({ name: "repo" }, db);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already a game/i);
  });

  it("refuses a nameless game, or one with no letters in it", async () => {
    expect((await createGame({ name: "   " }, db)).ok).toBe(false);
    expect((await createGame({ name: "🎮" }, db)).ok).toBe(false);
  });

  it("accepts a ladder up front, cleaned", async () => {
    const result = await createGame(
      { name: "Ladders", rankLadder: [" Bronze ", "", "Silver", "bronze"] },
      db
    );
    if (result.ok) expect(result.data.rankLadder).toEqual(["Bronze", "Silver"]);
  });
});

describe("renameGame and setGameActive", () => {
  it("renames without moving the key", async () => {
    const game = await addRepo();
    const result = await renameGame(game.id, "R.E.P.O.", db);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("R.E.P.O.");
      expect(result.data.key).toBe("repo");
    }
  });

  it("refuses a blank name and a game that is gone", async () => {
    const game = await addRepo();
    expect((await renameGame(game.id, "  ", db)).ok).toBe(false);
    expect(
      (await renameGame("00000000-0000-4000-8000-000000000000", "X", db)).ok
    ).toBe(false);
  });

  it("deactivates without losing an answer, and reactivating brings it back", async () => {
    const game = await addRepo();
    const field = await createField(
      game.id,
      { label: "Mic?", type: "bool", required: true },
      db
    );
    if (!field.ok) throw new Error(field.error);
    await saveProfileSection(userId, game.id, { [field.data.id]: true }, db);

    await setGameActive(game.id, false, db);
    expect((await loadProfile(userId, db)).sections.map((s) => s.name)).not.toContain("REPO");
    expect(await db.select().from(profileValues)).toHaveLength(1);

    await setGameActive(game.id, true, db);
    const repo = (await loadProfile(userId, db)).sections.find((s) => s.name === "REPO");
    expect(repo?.fields[0].value).toBe(true);
  });
});

describe("moveGame", () => {
  it("swaps two games and renumbers sort densely", async () => {
    await createGame({ name: "A" }, db);
    const b = await createGame({ name: "B" }, db);
    if (!b.ok) throw new Error(b.error);

    await moveGame(b.data.id, "up", db);
    const rows = await db.select().from(games).orderBy(asc(games.sort));
    expect(rows.map((row) => row.name)).toEqual(["B", "A"]);
    expect(rows.map((row) => row.sort)).toEqual([0, 1]);
  });

  it("does nothing at the ends", async () => {
    const a = await createGame({ name: "A" }, db);
    if (!a.ok) throw new Error(a.error);
    expect((await moveGame(a.data.id, "up", db)).ok).toBe(true);
    const rows = await db.select().from(games);
    expect(rows[0].sort).toBe(0);
  });

  it("recovers an order even when two rows arrived sharing a sort", async () => {
    // The state a naive "sort = sort ± 1" implementation eventually produces.
    await db.insert(games).values([
      { key: "a", name: "A", sort: 5 },
      { key: "b", name: "B", sort: 5 },
      { key: "c", name: "C", sort: 5 },
    ]);
    const [, b] = await db.select().from(games).orderBy(asc(games.sort), asc(games.name));

    await moveGame(b.id, "up", db);
    const rows = await db.select().from(games).orderBy(asc(games.sort), asc(games.name));
    expect(rows.map((row) => row.name)).toEqual(["B", "A", "C"]);
    expect(rows.map((row) => row.sort)).toEqual([0, 1, 2]);
  });

  it("reorders what the member sees", async () => {
    const rivals = await createGame({ name: "Marvel Rivals" }, db);
    const jackbox = await createGame({ name: "Jackbox" }, db);
    if (!rivals.ok || !jackbox.ok) throw new Error("setup");
    await createField(rivals.data.id, { label: "IGN", type: "text" }, db);
    await createField(jackbox.data.id, { label: "IGN", type: "text" }, db);

    await moveGame(jackbox.data.id, "up", db);
    expect((await loadProfile(userId, db)).sections.map((s) => s.name)).toEqual([
      "Jackbox",
      "Marvel Rivals",
    ]);
  });
});

/* ------------------------------------------------------------------ */

describe("createField", () => {
  it("adds a question with a key slugged from the label", async () => {
    const game = await addRepo();
    const result = await createField(
      game.id,
      { label: "Preferred roles", type: "multiselect", options: ["Sniper", "Medic"] },
      db
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.key).toBe("preferred-roles");
    expect(result.data.options).toEqual([
      { value: "sniper", label: "Sniper" },
      { value: "medic", label: "Medic" },
    ]);
    expect(result.data.sort).toBe(0);
  });

  it("disambiguates a repeated label inside one game", async () => {
    const game = await addRepo();
    await createField(game.id, { label: "Notes", type: "text" }, db);
    const second = await createField(game.id, { label: "Notes", type: "text" }, db);
    if (second.ok) expect(second.data.key).toBe("notes-2");
  });

  it("lets two different games both have a 'rank' question", async () => {
    const one = await addRepo();
    const two = await createGame({ name: "Other" }, db);
    if (!two.ok) throw new Error(two.error);

    expect((await createField(one.id, { label: "Notes", type: "text" }, db)).ok).toBe(true);
    expect((await createField(two.data.id, { label: "Notes", type: "text" }, db)).ok).toBe(true);
  });

  it("makes global fields work, which is what NULLS NOT DISTINCT is for", async () => {
    expect((await createField(null, { label: "Voice", type: "bool" }, db)).ok).toBe(true);
    const second = await createField(null, { label: "Voice", type: "bool" }, db);
    // Not a crash on the unique index: the key is disambiguated first.
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.key).toBe("voice-2");

    const view = await loadAdminGames(db);
    expect(view.globalFields).toHaveLength(2);
  });

  it("insists a select has something to select from", async () => {
    const game = await addRepo();
    const result = await createField(game.id, { label: "Role", type: "select" }, db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/at least one option/i);
  });

  it("refuses an unknown type off the wire", async () => {
    const game = await addRepo();
    expect((await createField(game.id, { label: "X", type: "dropdown" }, db)).ok).toBe(false);
    expect((await createField(game.id, { label: "X", type: "" }, db)).ok).toBe(false);
  });

  it("refuses a rank question on a game with no ladder", async () => {
    const game = await addRepo();
    const result = await createField(game.id, { label: "Rank", type: "rank" }, db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no rank ladder/i);

    await setRankLadder(game.id, ["Bronze", "Silver"], db);
    expect((await createField(game.id, { label: "Rank", type: "rank" }, db)).ok).toBe(true);
  });

  it("appends rather than stacking everything at sort 0", async () => {
    const game = await addRepo();
    await createField(game.id, { label: "One", type: "text" }, db);
    await createField(game.id, { label: "Two", type: "text" }, db);
    const rows = await db.select().from(profileFields).orderBy(asc(profileFields.sort));
    expect(rows.map((row) => row.sort)).toEqual([0, 1]);
  });
});

describe("moveField", () => {
  it("reorders within a game and renumbers", async () => {
    const game = await addRepo();
    await createField(game.id, { label: "One", type: "text" }, db);
    const two = await createField(game.id, { label: "Two", type: "text" }, db);
    if (!two.ok) throw new Error(two.error);

    await moveField(two.data.id, "up", db);
    const rows = await db.select().from(profileFields).orderBy(asc(profileFields.sort));
    expect(rows.map((row) => row.label)).toEqual(["Two", "One"]);
    expect(rows.map((row) => row.sort)).toEqual([0, 1]);
  });

  it("cannot pull a question out of its own section", async () => {
    const game = await addRepo();
    const global = await createField(null, { label: "Voice", type: "bool" }, db);
    await createField(game.id, { label: "One", type: "text" }, db);
    if (!global.ok) throw new Error(global.error);

    // The global field is alone in its section, so "up" is a no-op — it must
    // not swap with a field belonging to a game.
    await moveField(global.data.id, "up", db);
    const [row] = await db
      .select()
      .from(profileFields)
      .where(eq(profileFields.id, global.data.id));
    expect(row.gameId).toBeNull();
    expect(row.sort).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

describe("answers, and what edits do to them", () => {
  async function gameWithAnsweredSelect() {
    const game = await addRepo();
    const field = await createField(
      game.id,
      { label: "Role", type: "select", options: ["Sniper", "Medic"] },
      db
    );
    if (!field.ok) throw new Error(field.error);
    await saveProfileSection(userId, game.id, { [field.data.id]: "medic" }, db);
    return { game, field: field.data };
  }

  it("counts the answers a delete would destroy", async () => {
    const { field } = await gameWithAnsweredSelect();
    expect(await fieldAnswerCount(field.id, db)).toBe(1);

    const second = await makeUser(db);
    await saveProfileSection(second, field.gameId, { [field.id]: "sniper" }, db);
    expect(await fieldAnswerCount(field.id, db)).toBe(2);
  });

  it("reports the count on the admin view without a query per field", async () => {
    const { game, field } = await gameWithAnsweredSelect();
    const view = await loadAdminGames(db);
    const shown = view.games.find((row) => row.id === game.id);
    expect(shown?.fields.find((row) => row.id === field.id)?.answers).toBe(1);
    expect(shown?.answers).toBe(1);
  });

  it("previews an edit that would invalidate answers, without making it", async () => {
    const { field } = await gameWithAnsweredSelect();

    const harmless = await previewFieldEdit(
      field.id,
      { label: "Role", type: "select", options: ["Sniper", "Medic", "Scout"] },
      db
    );
    expect(harmless).toEqual({ answers: 1, invalidated: 0 });

    const destructive = await previewFieldEdit(
      field.id,
      { label: "Role", type: "select", options: ["Sniper"] },
      db
    );
    expect(destructive).toEqual({ answers: 1, invalidated: 1 });

    // Still nothing changed.
    const [row] = await db.select().from(profileFields).where(eq(profileFields.id, field.id));
    expect(row.options).toHaveLength(2);
    expect(await fieldAnswerCount(field.id, db)).toBe(1);
  });

  it("clears the answers an edit really does invalidate", async () => {
    const { field } = await gameWithAnsweredSelect();
    const result = await updateField(
      field.id,
      { label: "Role", type: "select", options: ["Sniper"] },
      db
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.clearedAnswers).toBe(1);
    expect(await fieldAnswerCount(field.id, db)).toBe(0);
  });

  it("keeps the answers a harmless edit does not", async () => {
    const { field } = await gameWithAnsweredSelect();
    const result = await updateField(
      field.id,
      { label: "Which role?", type: "select", options: ["Sniper", "Medic", "Scout"] },
      db
    );
    if (result.ok) expect(result.data.clearedAnswers).toBe(0);
    expect(await fieldAnswerCount(field.id, db)).toBe(1);
  });

  it("clears everything when the type changes out from under the answers", async () => {
    const { field } = await gameWithAnsweredSelect();
    const result = await updateField(field.id, { label: "Role", type: "number" }, db);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.clearedAnswers).toBe(1);
    expect(await fieldAnswerCount(field.id, db)).toBe(0);
  });

  it("leaves the key alone on a relabel", async () => {
    const { field } = await gameWithAnsweredSelect();
    await updateField(
      field.id,
      { label: "Completely different", type: "select", options: ["Sniper", "Medic"] },
      db
    );
    const [row] = await db.select().from(profileFields).where(eq(profileFields.id, field.id));
    expect(row.key).toBe("role");
    expect(row.label).toBe("Completely different");
  });

  it("refuses an invalid edit before touching anything", async () => {
    const { field } = await gameWithAnsweredSelect();
    expect((await updateField(field.id, { label: "", type: "select" }, db)).ok).toBe(false);
    expect((await updateField(field.id, { label: "Role", type: "select" }, db)).ok).toBe(false);
    expect(await fieldAnswerCount(field.id, db)).toBe(1);
  });

  it("deletes a question and says how many answers went with it", async () => {
    const { field } = await gameWithAnsweredSelect();
    const result = await deleteField(field.id, db);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.deletedAnswers).toBe(1);

    expect(await db.select().from(profileFields)).toHaveLength(0);
    expect(await db.select().from(profileValues)).toHaveLength(0);
  });

  it("closes the gap in sort after a delete", async () => {
    const game = await addRepo();
    const one = await createField(game.id, { label: "One", type: "text" }, db);
    await createField(game.id, { label: "Two", type: "text" }, db);
    await createField(game.id, { label: "Three", type: "text" }, db);
    if (!one.ok) throw new Error(one.error);

    await deleteField(one.data.id, db);
    const rows = await db.select().from(profileFields).orderBy(asc(profileFields.sort));
    expect(rows.map((row) => row.label)).toEqual(["Two", "Three"]);
    expect(rows.map((row) => row.sort)).toEqual([0, 1]);
  });

  it("reports a delete of something already gone", async () => {
    expect((await deleteField("00000000-0000-4000-8000-000000000000", db)).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("rank ladders", () => {
  async function rivalsWithRank() {
    const game = await createGame(
      { name: "Marvel Rivals", rankLadder: [...RIVALS_RANK_LADDER] },
      db
    );
    if (!game.ok) throw new Error(game.error);
    const field = await createField(game.data.id, { label: "Rank", type: "rank" }, db);
    if (!field.ok) throw new Error(field.error);
    await saveProfileSection(userId, game.data.id, { [field.data.id]: "Diamond II" }, db);
    return { gameId: game.data.id, fieldId: field.data.id };
  }

  it("stores an ordered ladder, cleaned", async () => {
    const game = await addRepo();
    const result = await setRankLadder(game.id, [" Wood ", "Stone", "wood", ""], db);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.ladder).toEqual(["Wood", "Stone"]);
  });

  it("accepts an empty ladder, because Jackbox has none", async () => {
    const game = await addRepo();
    const result = await setRankLadder(game.id, [], db);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.ladder).toEqual([]);
  });

  it("previews how many answers a shortened ladder orphans", async () => {
    const { gameId } = await rivalsWithRank();
    const kept = RIVALS_RANK_LADDER.filter((rank) => rank !== "Diamond II");

    const impact = await previewRankLadder(gameId, kept, db);
    expect(impact.removed).toEqual(["Diamond II"]);
    expect(impact.answers).toBe(1);

    // Reordering alone removes nothing.
    const reordered = [...RIVALS_RANK_LADDER].reverse();
    expect(await previewRankLadder(gameId, reordered, db)).toEqual({
      removed: [],
      answers: 0,
    });
  });

  it("clears the answers naming a rank it removed", async () => {
    const { gameId, fieldId } = await rivalsWithRank();
    const kept = RIVALS_RANK_LADDER.filter((rank) => rank !== "Diamond II");

    const result = await setRankLadder(gameId, kept, db);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.clearedAnswers).toBe(1);
    expect(await fieldAnswerCount(fieldId, db)).toBe(0);
  });

  it("keeps an answer when the ladder is only reordered", async () => {
    const { gameId, fieldId } = await rivalsWithRank();
    const reordered = [...RIVALS_RANK_LADDER].reverse();

    const result = await setRankLadder(gameId, reordered, db);
    if (result.ok) expect(result.data.clearedAnswers).toBe(0);
    expect(await fieldAnswerCount(fieldId, db)).toBe(1);
  });

  it("refuses an absurdly long ladder", async () => {
    const game = await addRepo();
    const huge = Array.from({ length: 61 }, (_, n) => `Rank ${n}`);
    expect((await setRankLadder(game.id, huge, db)).ok).toBe(false);
  });

  it("refuses a game that is gone", async () => {
    expect(
      (await setRankLadder("00000000-0000-4000-8000-000000000000", ["A"], db)).ok
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("loadAdminGames", () => {
  it("shows inactive games too — this is where you switch them back on", async () => {
    const game = await addRepo();
    await setGameActive(game.id, false, db);
    const view = await loadAdminGames(db);
    expect(view.games.map((row) => row.name)).toEqual(["REPO"]);
    expect(view.games[0].isActive).toBe(false);
  });

  it("keeps global fields out of every game", async () => {
    const game = await addRepo();
    await createField(null, { label: "Voice", type: "bool" }, db);
    await createField(game.id, { label: "Notes", type: "text" }, db);

    const view = await loadAdminGames(db);
    expect(view.globalFields.map((field) => field.label)).toEqual(["Voice"]);
    expect(view.games[0].fields.map((field) => field.label)).toEqual(["Notes"]);
  });

  it("is empty and does not throw on a fresh database", async () => {
    const view = await loadAdminGames(db);
    expect(view).toEqual({ games: [], globalFields: [], globalAnswers: 0 });
  });
});

/* ------------------------------------------------------------------ */

describe("the whole flow: add REPO and ask two questions", () => {
  it("takes a name, two questions, and shows up on the member's profile", async () => {
    // This is the §13 Q4 requirement, end to end and without a line of code.
    const game = await createGame({ name: "REPO" }, db);
    if (!game.ok) throw new Error(game.error);

    const first = await createField(
      game.data.id,
      { label: "Have you played it before?", type: "bool", required: true },
      db
    );
    const second = await createField(
      game.data.id,
      {
        label: "Preferred lobby size",
        type: "select",
        options: ["Duo", "Trio", "Full six"],
        required: false,
      },
      db
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const profile = await loadProfile(userId, db);
    const repo = profile.sections.find((section) => section.name === "REPO");
    expect(repo?.fields.map((field) => field.label)).toEqual([
      "Have you played it before?",
      "Preferred lobby size",
    ]);
    expect(repo?.fields[1].choices.map((choice) => choice.label)).toEqual([
      "Duo",
      "Trio",
      "Full six",
    ]);

    const saved = await saveProfileSection(
      userId,
      game.data.id,
      { [first.data.id]: true, [second.data.id]: "trio" },
      db
    );
    expect(saved.ok).toBe(true);
    if (saved.ok) expect(saved.completeness.complete).toBe(true);

    const again = await loadProfile(userId, db);
    expect(again.sections.find((s) => s.name === "REPO")?.fields.map((f) => f.value)).toEqual([
      true,
      "trio",
    ]);
  });
});
