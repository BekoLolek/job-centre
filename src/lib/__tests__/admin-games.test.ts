import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type Database, events, games, profileFields, profileValues } from "@/db";
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
  restoreField,
  retireField,
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
  // Events hold a game's rank rules, which UC-03 3b is about; they survive
  // their game (`on delete set null`), so they have to go first and by name.
  await db.delete(events);
  await db.delete(games);
  userId = await makeUser(db);
});

/** An event with a rank rule on `gameId`, which is what UC-03 3b warns about. */
async function eventWithRankRule(
  gameId: string,
  over: { title?: string; slug?: string; enter?: string; captain?: string } = {}
): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const [row] = await db
    .insert(events)
    .values({
      slug: over.slug ?? `event-${suffix}`,
      title: over.title ?? "Rivals night",
      gameId,
      minRankToEnter: over.enter ?? null,
      minRankToCaptain: over.captain ?? null,
    })
    .returning({ id: events.id });
  return row.id;
}

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

  // UC-03 1a: "Name already used - System rejects with 'That game already
  // exists'". Case is not a difference anybody means, so "repo" is "REPO".
  it("refuses a name that is already used, whatever the case", async () => {
    await createGame({ name: "REPO" }, db);
    const second = await createGame({ name: "repo" }, db);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe("That game already exists.");
  });

  it("reports a clashing key rather than inventing repo-2", async () => {
    await createGame({ name: "REPO" }, db);
    // A different name that slugs to the same key, so the key check is the one
    // doing the work here rather than the name check above.
    const second = await createGame({ name: "Repo!" }, db);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already a game with the key/i);
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

  // UC-03 1a again, on the other door in. A rule that only holds on the way in
  // is not a rule: renaming is how you would otherwise end up with two
  // "Marvel Rivals" the create path would have refused outright.
  it("refuses a rename onto a name another game already has", async () => {
    await createGame({ name: "Marvel Rivals" }, db);
    const other = await addRepo();

    const clash = await renameGame(other.id, "marvel rivals", db);
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error).toBe("That game already exists.");

    // Its own name back is not a clash — saving an unchanged row must work.
    expect((await renameGame(other.id, "REPO", db)).ok).toBe(true);
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

  // UC-03 5a: editing a detail keeps members' existing answers. The edit that
  // strands one is precisely the edit that used to delete it.
  it("keeps an answer the edit strands, and says how many it stranded", async () => {
    const { field } = await gameWithAnsweredSelect();
    const result = await updateField(
      field.id,
      { label: "Role", type: "select", options: ["Sniper"] },
      db
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.strandedAnswers).toBe(1);
    expect(await fieldAnswerCount(field.id, db)).toBe(1);

    const [row] = await db.select().from(profileValues);
    expect(row.value).toBe("medic");
  });

  it("gives a stranded answer back when the question is put back", async () => {
    // The point of keeping it: the edit is reversible, and an admin's second
    // thoughts cost nothing. A delete could not be undone by anybody.
    const { field, game } = await gameWithAnsweredSelect();
    await updateField(field.id, { label: "Role", type: "number" }, db);
    await updateField(
      field.id,
      { label: "Role", type: "select", options: ["Sniper", "Medic"] },
      db
    );

    const section = (await loadProfile(userId, db)).sections.find(
      (row) => row.gameId === game.id
    );
    expect(section?.fields[0].value).toBe("medic");
  });

  it("strands nothing on a harmless edit", async () => {
    const { field } = await gameWithAnsweredSelect();
    const result = await updateField(
      field.id,
      { label: "Which role?", type: "select", options: ["Sniper", "Medic", "Scout"] },
      db
    );
    if (result.ok) expect(result.data.strandedAnswers).toBe(0);
    expect(await fieldAnswerCount(field.id, db)).toBe(1);
  });

  it("keeps the answers even when the type changes out from under them", async () => {
    const { field } = await gameWithAnsweredSelect();
    const result = await updateField(field.id, { label: "Role", type: "number" }, db);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.strandedAnswers).toBe(1);
    expect(await fieldAnswerCount(field.id, db)).toBe(1);
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

  // UC-03 5a: retiring is the way to stop asking something people have
  // answered, so the destructive door is shut rather than guarded.
  it("refuses to delete a question people have answered, and says to retire it", async () => {
    const { field } = await gameWithAnsweredSelect();
    const result = await deleteField(field.id, db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/retire it instead/i);

    expect(await db.select().from(profileFields)).toHaveLength(1);
    expect(await db.select().from(profileValues)).toHaveLength(1);
  });

  it("still deletes the five-minute-old typo nobody has answered", async () => {
    const game = await addRepo();
    const typo = await createField(game.id, { label: "Whta is your IGN", type: "text" }, db);
    if (!typo.ok) throw new Error(typo.error);

    const result = await deleteField(typo.data.id, db);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.deletedAnswers).toBe(0);
    expect(await db.select().from(profileFields)).toHaveLength(0);
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

/**
 * UC-03 5a: "Admin reorders or retires a detail - System keeps members'
 * existing answers but stops asking."
 *
 * Both halves matter, and they pull opposite ways: the answer has to still be
 * in `profile_values` *and* the question has to be off the member's form. A
 * test that only checks one of them passes for a delete or for a no-op.
 */
describe("retiring a question (UC-03 5a)", () => {
  async function answeredQuestion() {
    const game = await addRepo();
    const field = await createField(game.id, { label: "Old handle", type: "text" }, db);
    if (!field.ok) throw new Error(field.error);
    await saveProfileSection(userId, game.id, { [field.data.id]: "lolek" }, db);
    return { game, fieldId: field.data.id };
  }

  it("keeps the answer and stops asking the question", async () => {
    const { game, fieldId } = await answeredQuestion();

    const retired = await retireField(fieldId, db);
    expect(retired.ok).toBe(true);
    if (retired.ok) expect(retired.data.keptAnswers).toBe(1);

    // Kept.
    expect(await fieldAnswerCount(fieldId, db)).toBe(1);
    const [stored] = await db.select().from(profileValues);
    expect(stored.value).toBe("lolek");

    // Not asked.
    const section = (await loadProfile(userId, db)).sections.find(
      (row) => row.gameId === game.id
    );
    expect(section?.fields.map((field) => field.id)).not.toContain(fieldId);
  });

  it("stops a retired question counting against a complete profile", async () => {
    const game = await addRepo();
    const asked = await createField(game.id, { label: "IGN", type: "text", required: true }, db);
    const dropped = await createField(
      game.id,
      { label: "Old handle", type: "text", required: true },
      db
    );
    if (!asked.ok || !dropped.ok) throw new Error("setup");
    await saveProfileSection(userId, game.id, { [asked.data.id]: "lolek" }, db);

    const before = (await loadProfile(userId, db)).sections.find(
      (row) => row.gameId === game.id
    );
    expect(before?.completeness.complete).toBe(false);

    await retireField(dropped.data.id, db);
    const after = (await loadProfile(userId, db)).sections.find(
      (row) => row.gameId === game.id
    );
    expect(after?.completeness.complete).toBe(true);
  });

  it("refuses a save to a question it has stopped asking", async () => {
    const { game, fieldId } = await answeredQuestion();
    await retireField(fieldId, db);

    // A page open since before the retirement. The stored answer is the one
    // the member gave while it was asked; this is not a second chance to add.
    const result = await saveProfileSection(userId, game.id, { [fieldId]: "new" }, db);
    expect(result.ok).toBe(false);
    const [stored] = await db.select().from(profileValues);
    expect(stored.value).toBe("lolek");
  });

  it("brings the question and every answer back when it is restored", async () => {
    const { game, fieldId } = await answeredQuestion();
    await retireField(fieldId, db);

    const restored = await restoreField(fieldId, db);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.data.restoredAnswers).toBe(1);

    const section = (await loadProfile(userId, db)).sections.find(
      (row) => row.gameId === game.id
    );
    expect(section?.fields.find((field) => field.id === fieldId)?.value).toBe("lolek");
  });

  it("shows a retired question to the admin, separately, with its answers", async () => {
    const { game, fieldId } = await answeredQuestion();
    await retireField(fieldId, db);

    const shown = (await loadAdminGames(db)).games.find((row) => row.id === game.id);
    expect(shown?.fields).toHaveLength(0);
    expect(shown?.retired.map((field) => field.id)).toEqual([fieldId]);
    expect(shown?.retired[0].answers).toBe(1);
    // The game's weight is what is stored, not what is on a form today.
    expect(shown?.answers).toBe(1);
  });

  it("parks a retired question behind the live ones so the arrows keep working", async () => {
    const game = await addRepo();
    const one = await createField(game.id, { label: "One", type: "text" }, db);
    const two = await createField(game.id, { label: "Two", type: "text" }, db);
    const three = await createField(game.id, { label: "Three", type: "text" }, db);
    if (!one.ok || !two.ok || !three.ok) throw new Error("setup");

    await retireField(two.data.id, db);
    // "Three" moves up past "One", not past the retired question between them.
    await moveField(three.data.id, "up", db);

    const rows = await db.select().from(profileFields).orderBy(asc(profileFields.sort));
    expect(rows.map((row) => row.label)).toEqual(["Three", "One", "Two"]);
    expect(rows.map((row) => row.sort)).toEqual([0, 1, 2]);
  });

  it("takes a second click on retire as a double click, not a fault", async () => {
    const { fieldId } = await answeredQuestion();
    const first = await retireField(fieldId, db, new Date("2026-01-01T00:00:00Z"));
    const second = await retireField(fieldId, db, new Date("2026-06-01T00:00:00Z"));
    expect(second.ok).toBe(true);
    // The date it was retired is the first one — the second click changed
    // nothing, which is what "already done" should mean.
    if (first.ok && second.ok) {
      expect(second.data.field.retiredAt?.toISOString()).toBe(
        first.data.field.retiredAt?.toISOString()
      );
    }
  });

  it("reports retiring something already gone", async () => {
    expect((await retireField("00000000-0000-4000-8000-000000000000", db)).ok).toBe(false);
    expect((await restoreField("00000000-0000-4000-8000-000000000000", db)).ok).toBe(false);
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
      events: [],
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

  /*
   * UC-03 3b: "Ranks reordered while an event has an entry rule on this game -
   * System warns which events are affected before saving."
   *
   * This is the case with no other symptom. A reorder removes no rank and
   * orphans no answer, so the answer-count warning stays silent — and every
   * event's stored "Platinum I or above" quietly starts admitting a different
   * set of people. The warning is the only thing standing between an admin and
   * that, so it is named, before the write, per event.
   */
  describe("events whose rank rules a reorder re-aims (UC-03 3b)", () => {
    it("names the event, and which of its two rules moved", async () => {
      const { gameId } = await rivalsWithRank();
      await eventWithRankRule(gameId, { title: "Rivals night", enter: "Diamond II" });

      // Reversing puts Diamond II near the bottom: the same rule now lets in
      // almost everybody it used to keep out.
      const impact = await previewRankLadder(gameId, [...RIVALS_RANK_LADDER].reverse(), db);
      expect(impact.answers).toBe(0);
      expect(impact.events).toHaveLength(1);
      expect(impact.events[0].title).toBe("Rivals night");
      expect(impact.events[0].rules).toEqual(["enter"]);
      expect(impact.events[0].ranks).toEqual(["Diamond II"]);
      expect(impact.events[0].ranksGone).toBe(false);
    });

    it("reports both thresholds when both move", async () => {
      const { gameId } = await rivalsWithRank();
      await eventWithRankRule(gameId, {
        title: "Captains draft",
        enter: "Gold III",
        captain: "Diamond II",
      });

      const impact = await previewRankLadder(gameId, [...RIVALS_RANK_LADDER].reverse(), db);
      expect(impact.events[0].rules).toEqual(["enter", "captain"]);
      expect(impact.events[0].ranks).toEqual(["Gold III", "Diamond II"]);
    });

    it("says so when the rank a rule names is going altogether", async () => {
      const { gameId } = await rivalsWithRank();
      await eventWithRankRule(gameId, { enter: "Diamond II" });

      const kept = RIVALS_RANK_LADDER.filter((rank) => rank !== "Diamond II");
      const impact = await previewRankLadder(gameId, kept, db);
      expect(impact.events[0].ranksGone).toBe(true);
    });

    it("stays quiet when the reorder does not change who the rule admits", async () => {
      const { gameId } = await rivalsWithRank();
      await eventWithRankRule(gameId, { enter: "Diamond II" });

      // A new rank on the top: every existing rank keeps its place relative to
      // the threshold, so no stored rule means anything new. Warning about
      // this is how a warning becomes noise nobody reads.
      const appended = [...RIVALS_RANK_LADDER, "Celestial Prime"];
      expect((await previewRankLadder(gameId, appended, db)).events).toEqual([]);

      // And the ladder untouched is obviously quiet.
      expect(
        (await previewRankLadder(gameId, [...RIVALS_RANK_LADDER], db)).events
      ).toEqual([]);
    });

    it("leaves out an event with no rank rule, and one for another game", async () => {
      const { gameId } = await rivalsWithRank();
      await eventWithRankRule(gameId, { title: "Casual night" });
      const other = await addRepo();
      await eventWithRankRule(other.id, { title: "REPO night", enter: "Diamond II" });

      const impact = await previewRankLadder(gameId, [...RIVALS_RANK_LADDER].reverse(), db);
      expect(impact.events).toEqual([]);
    });
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
    expect(view).toEqual({
      games: [],
      globalFields: [],
      globalRetired: [],
      globalAnswers: 0,
    });
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
