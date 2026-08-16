import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type Database,
  type NewProfileField,
  games,
  profileFields,
  profileValues,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { RIVALS_RANK_LADDER } from "@/db/seed";
import { GLOBAL_SECTION_NAME, loadProfile, saveProfileSection } from "@/lib/profile";

/**
 * The member's half of Phase 1, against real Postgres.
 *
 * PGlite rather than a mock, for the same reason `src/db/__tests__` uses it:
 * the interesting behaviour here is upserts on a unique index, cascade deletes
 * and jsonb round trips, and none of those are things a fake would get wrong in
 * the same way Postgres does.
 */

let harness: TestDatabase;
let db: Database;
let userId: string;
let otherUserId: string;

/** Ids of the rows each test builds, so assertions can name them. */
let rivalsId: string;
let jackboxId: string;
let ignId: string;
let rankId: string;
let rolesId: string;
let packsId: string;
let voiceId: string;

const ROLE_OPTIONS = [
  { value: "vanguard", label: "Vanguard" },
  { value: "duelist", label: "Duelist" },
  { value: "strategist", label: "Strategist" },
];

async function addField(
  gameId: string | null,
  field: Omit<NewProfileField, "gameId">
): Promise<string> {
  const [row] = await db
    .insert(profileFields)
    .values({ ...field, gameId })
    .returning({ id: profileFields.id });
  return row.id;
}

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  // A clean catalogue per test: deleting the games cascades to their fields,
  // and deleting a field cascades to its values.
  await db.delete(profileValues);
  await db.delete(profileFields);
  await db.delete(games);

  userId = await makeUser(db);
  otherUserId = await makeUser(db);

  [rivalsId, jackboxId] = await db
    .insert(games)
    .values([
      { key: "rivals", name: "Marvel Rivals", sort: 0, rankLadder: [...RIVALS_RANK_LADDER] },
      { key: "jackbox", name: "Jackbox", sort: 10, rankLadder: [] },
    ])
    .returning({ id: games.id })
    .then((rows) => rows.map((row) => row.id));

  voiceId = await addField(null, {
    key: "voice",
    label: "Happy to use voice chat",
    type: "bool",
    required: true,
    sort: 0,
  });
  ignId = await addField(rivalsId, {
    key: "ign",
    label: "In-game name",
    type: "text",
    required: true,
    sort: 0,
  });
  rankId = await addField(rivalsId, {
    key: "rank",
    label: "Current competitive rank",
    type: "rank",
    required: true,
    sort: 1,
  });
  rolesId = await addField(rivalsId, {
    key: "roles",
    label: "Preferred roles",
    type: "multiselect",
    options: ROLE_OPTIONS,
    required: true,
    sort: 2,
  });
  packsId = await addField(jackboxId, {
    key: "packs",
    label: "Packs you own",
    type: "multiselect",
    options: [{ value: "pack-1", label: "Party Pack 1" }],
    sort: 0,
  });
});

/* ------------------------------------------------------------------ */

describe("loadProfile", () => {
  it("puts the global section first, then the games in sort order", async () => {
    const profile = await loadProfile(userId, db);
    expect(profile.sections.map((section) => section.name)).toEqual([
      GLOBAL_SECTION_NAME,
      "Marvel Rivals",
      "Jackbox",
    ]);
  });

  it("orders a section's questions by sort", async () => {
    const rivals = (await loadProfile(userId, db)).sections[1];
    expect(rivals.fields.map((field) => field.key)).toEqual(["ign", "rank", "roles"]);
  });

  it("gives a rank field the game's ladder as its choices", async () => {
    const rivals = (await loadProfile(userId, db)).sections[1];
    const rank = rivals.fields.find((field) => field.key === "rank");
    expect(rank?.choices).toHaveLength(RIVALS_RANK_LADDER.length);
    expect(rank?.choices[13]).toEqual({ value: "Diamond II", label: "Diamond II" });
  });

  it("gives a game without a ladder an empty one, and shows it anyway", async () => {
    const jackbox = (await loadProfile(userId, db)).sections[2];
    expect(jackbox.rankLadder).toEqual([]);
    expect(jackbox.fields).toHaveLength(1);
  });

  it("reports the section with no questions as an empty state, not a missing one", async () => {
    await db.insert(games).values({ key: "repo", name: "REPO", sort: 20 });
    const profile = await loadProfile(userId, db);
    const repo = profile.sections.find((section) => section.name === "REPO");
    expect(repo).toBeDefined();
    expect(repo?.fields).toEqual([]);
    expect(repo?.completeness.complete).toBe(true);
  });

  it("hides a deactivated game without touching its answers", async () => {
    await saveProfileSection(userId, jackboxId, { [packsId]: ["pack-1"] }, db);
    await db.update(games).set({ isActive: false }).where(eq(games.id, jackboxId));

    const profile = await loadProfile(userId, db);
    expect(profile.sections.map((section) => section.name)).not.toContain("Jackbox");
    // Still in the database, and still counted as the member having answered.
    expect(await db.select().from(profileValues).where(eq(profileValues.userId, userId)))
      .toHaveLength(1);
    expect(profile.untouched).toBe(false);
  });

  it("omits the global section entirely when there are no global questions", async () => {
    await db.delete(profileFields).where(eq(profileFields.id, voiceId));
    const profile = await loadProfile(userId, db);
    expect(profile.sections.map((section) => section.name)).toEqual([
      "Marvel Rivals",
      "Jackbox",
    ]);
  });

  it("says when the admin has defined nothing at all", async () => {
    await db.delete(profileFields);
    const profile = await loadProfile(userId, db);
    expect(profile.empty).toBe(true);
  });

  it("says when this member has answered nothing", async () => {
    expect((await loadProfile(userId, db)).untouched).toBe(true);
    await saveProfileSection(userId, null, { [voiceId]: true }, db);
    expect((await loadProfile(userId, db)).untouched).toBe(false);
  });

  it("never shows one member another member's answers", async () => {
    await saveProfileSection(otherUserId, rivalsId, { [ignId]: "someone-else" }, db);
    const mine = (await loadProfile(userId, db)).sections[1];
    expect(mine.fields.find((field) => field.key === "ign")?.value).toBeNull();
  });

  it("counts only required fields towards completeness", async () => {
    await saveProfileSection(userId, rivalsId, { [ignId]: "lolek" }, db);
    const rivals = (await loadProfile(userId, db)).sections[1];
    expect(rivals.completeness).toMatchObject({
      answered: 1,
      required: 3,
      complete: false,
      missing: ["Current competitive rank", "Preferred roles"],
    });
  });
});

/* ------------------------------------------------------------------ */

describe("saveProfileSection", () => {
  it("stores an answer and reads it back on the next load", async () => {
    const result = await saveProfileSection(userId, rivalsId, { [ignId]: "  lolek  " }, db);
    expect(result.ok).toBe(true);

    const rivals = (await loadProfile(userId, db)).sections[1];
    expect(rivals.fields.find((field) => field.id === ignId)?.value).toBe("lolek");
  });

  it("updates rather than duplicating when the same question is answered twice", async () => {
    await saveProfileSection(userId, rivalsId, { [ignId]: "first" }, db);
    await saveProfileSection(userId, rivalsId, { [ignId]: "second" }, db);

    const rows = await db
      .select()
      .from(profileValues)
      .where(and(eq(profileValues.userId, userId), eq(profileValues.fieldId, ignId)));
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("second");
  });

  it("stores a cleared answer as absence, not as a null row", async () => {
    await saveProfileSection(userId, rivalsId, { [ignId]: "lolek" }, db);
    await saveProfileSection(userId, rivalsId, { [ignId]: "" }, db);

    expect(
      await db
        .select()
        .from(profileValues)
        .where(and(eq(profileValues.userId, userId), eq(profileValues.fieldId, ignId)))
    ).toHaveLength(0);
  });

  it("treats an emptied multiselect as no answer", async () => {
    await saveProfileSection(userId, rivalsId, { [rolesId]: ["duelist"] }, db);
    await saveProfileSection(userId, rivalsId, { [rolesId]: [] }, db);
    expect(
      await db.select().from(profileValues).where(eq(profileValues.fieldId, rolesId))
    ).toHaveLength(0);
  });

  it("keeps false and zero, which are answers", async () => {
    await saveProfileSection(userId, null, { [voiceId]: false }, db);
    const [row] = await db
      .select()
      .from(profileValues)
      .where(eq(profileValues.fieldId, voiceId));
    expect(row.value).toBe(false);

    const global = (await loadProfile(userId, db)).sections[0];
    expect(global.completeness.complete).toBe(true);
  });

  it("writes a multiselect in the admin's option order", async () => {
    await saveProfileSection(userId, rivalsId, { [rolesId]: ["strategist", "vanguard"] }, db);
    const [row] = await db
      .select()
      .from(profileValues)
      .where(eq(profileValues.fieldId, rolesId));
    expect(row.value).toEqual(["vanguard", "strategist"]);
  });

  it("accepts a rank the ladder has and refuses one it does not", async () => {
    expect((await saveProfileSection(userId, rivalsId, { [rankId]: "Diamond II" }, db)).ok).toBe(
      true
    );

    const bad = await saveProfileSection(userId, rivalsId, { [rankId]: "Diamond IV" }, db);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[rankId]).toMatch(/not one of the options/i);

    // The good answer survived the rejected one.
    const [row] = await db.select().from(profileValues).where(eq(profileValues.fieldId, rankId));
    expect(row.value).toBe("Diamond II");
  });

  it("writes nothing at all when any one answer in the batch is rejected", async () => {
    const result = await saveProfileSection(
      userId,
      rivalsId,
      { [ignId]: "lolek", [rankId]: "Wood V" },
      db
    );

    expect(result.ok).toBe(false);
    // Not "the good half went in": all or nothing, so the page never shows a
    // half-applied section.
    expect(
      await db.select().from(profileValues).where(eq(profileValues.userId, userId))
    ).toHaveLength(0);
  });

  it("refuses a question that belongs to a different section", async () => {
    // The forgery case: a Jackbox field id posted at the Rivals section.
    const result = await saveProfileSection(userId, rivalsId, { [packsId]: ["pack-1"] }, db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[packsId]).toMatch(/not part of this section/i);
    expect(await db.select().from(profileValues)).toHaveLength(0);
  });

  it("refuses a field id that does not exist", async () => {
    const result = await saveProfileSection(
      userId,
      rivalsId,
      { "00000000-0000-4000-8000-000000000000": "x" },
      db
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a global field posted at a game section, and the other way round", async () => {
    expect((await saveProfileSection(userId, rivalsId, { [voiceId]: true }, db)).ok).toBe(false);
    expect((await saveProfileSection(userId, null, { [ignId]: "lolek" }, db)).ok).toBe(false);
  });

  it("refuses a game that does not exist, and one that is switched off", async () => {
    const missing = await saveProfileSection(
      userId,
      "00000000-0000-4000-8000-000000000000",
      { [ignId]: "lolek" },
      db
    );
    expect(missing.ok).toBe(false);

    await db.update(games).set({ isActive: false }).where(eq(games.id, rivalsId));
    const hidden = await saveProfileSection(userId, rivalsId, { [ignId]: "lolek" }, db);
    expect(hidden.ok).toBe(false);
    if (!hidden.ok) expect(hidden.errors._).toMatch(/not active/i);
  });

  it("refuses an empty patch rather than pretending to save", async () => {
    expect((await saveProfileSection(userId, rivalsId, {}, db)).ok).toBe(false);
  });

  it("lets a half-filled profile save, and reports what is still missing", async () => {
    // The deliberate rule: `required` is a counter on this page, not a lock.
    const result = await saveProfileSection(userId, rivalsId, { [ignId]: "lolek" }, db);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.completeness).toMatchObject({ answered: 1, required: 3, complete: false });
      expect(result.values[ignId]).toBe("lolek");
    }
  });

  it("hands back the stored value, not the value that was sent", async () => {
    const result = await saveProfileSection(
      userId,
      rivalsId,
      { [rolesId]: ["strategist", "vanguard", "strategist"] },
      db
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.values[rolesId]).toEqual(["vanguard", "strategist"]);
  });

  it("saves several questions of one section in a single call", async () => {
    const result = await saveProfileSection(
      userId,
      rivalsId,
      { [ignId]: "lolek", [rankId]: "Platinum I", [rolesId]: ["duelist"] },
      db
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.completeness.complete).toBe(true);

    const rivals = (await loadProfile(userId, db)).sections[1];
    expect(rivals.fields.map((field) => field.value)).toEqual([
      "lolek",
      "Platinum I",
      ["duelist"],
    ]);
  });

  it("keeps two members' answers to the same question apart", async () => {
    await saveProfileSection(userId, rivalsId, { [ignId]: "mine" }, db);
    await saveProfileSection(otherUserId, rivalsId, { [ignId]: "theirs" }, db);

    const rows = await db.select().from(profileValues).where(eq(profileValues.fieldId, ignId));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.value))).toEqual(new Set(["mine", "theirs"]));
  });

  it("moves updated_at forward when an answer changes", async () => {
    await saveProfileSection(userId, rivalsId, { [ignId]: "first" }, db);
    const [before] = await db
      .select()
      .from(profileValues)
      .where(eq(profileValues.fieldId, ignId));

    await new Promise((resolve) => setTimeout(resolve, 5));
    await saveProfileSection(userId, rivalsId, { [ignId]: "second" }, db);
    const [after] = await db
      .select()
      .from(profileValues)
      .where(eq(profileValues.fieldId, ignId));

    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
  });

  it("loses the answer when the question is deleted, by cascade", async () => {
    await saveProfileSection(userId, rivalsId, { [ignId]: "lolek" }, db);
    await db.delete(profileFields).where(eq(profileFields.id, ignId));
    expect(await db.select().from(profileValues)).toHaveLength(0);
  });
});
