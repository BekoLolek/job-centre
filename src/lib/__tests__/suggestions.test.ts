import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  addSuggestion,
  deleteSuggestion,
  listSuggestions,
  setSuggestionStatus,
  voteSuggestion,
} from "@/lib/suggestions";

/**
 * The suggestion box.
 *
 * The tally is the whole feature, so what is pinned down here is the counting:
 * one person is one vote whatever they click, changing your mind moves the
 * number rather than adding to it, and clicking the same arrow twice takes the
 * vote back.
 */

let handle: TestDatabase;
let db: Database;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
});

afterAll(async () => {
  await handle.close();
});

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

describe("adding", () => {
  it("counts the suggester as wanting it", async () => {
    const userId = await makeUser(db, { displayName: "Ada" });
    const { id } = unwrap(await addSuggestion(userId, { title: "A REPO night" }, db));

    const [row] = (await listSuggestions(userId, db)).filter((s) => s.id === id);
    expect(row.up).toBe(1);
    expect(row.score).toBe(1);
    expect(row.yours).toBe(1);
    expect(row.by?.name).toBe("Ada");
  });

  it("refuses a title that is not one", async () => {
    const userId = await makeUser(db);
    expect((await addSuggestion(userId, { title: "  " }, db)).ok).toBe(false);
    expect((await addSuggestion(userId, { title: "x".repeat(200) }, db)).ok).toBe(false);
  });
});

describe("voting", () => {
  it("is one person one vote, however many times they click", async () => {
    const author = await makeUser(db);
    const voter = await makeUser(db);
    const { id } = unwrap(await addSuggestion(author, { title: "Jackbox" }, db));

    const on = unwrap(await voteSuggestion(id, voter, 1, db));
    expect(on.yours).toBe(1);
    expect(on.up).toBe(2); // theirs and the author's

    const off = unwrap(await voteSuggestion(id, voter, 1, db));
    expect(off.yours).toBe(0);
    expect(off.up).toBe(1); // the author's alone

    // However many times they click, they are worth one vote and never two.
    const backOn = unwrap(await voteSuggestion(id, voter, 1, db));
    expect(backOn.yours).toBe(1);
    expect(backOn.up).toBe(2);
  });

  it("moves a vote rather than adding one when somebody changes their mind", async () => {
    const author = await makeUser(db);
    const voter = await makeUser(db);
    const { id } = unwrap(await addSuggestion(author, { title: "Chess" }, db));

    unwrap(await voteSuggestion(id, voter, 1, db));
    const after = unwrap(await voteSuggestion(id, voter, -1, db));

    expect(after.up).toBe(1);
    expect(after.down).toBe(1);
    expect(after.yours).toBe(-1);
  });

  it("takes a vote back when the same arrow is clicked again", async () => {
    const author = await makeUser(db);
    const voter = await makeUser(db);
    const { id } = unwrap(await addSuggestion(author, { title: "Golf" }, db));

    unwrap(await voteSuggestion(id, voter, -1, db));
    const after = unwrap(await voteSuggestion(id, voter, -1, db));
    expect(after.down).toBe(0);
    expect(after.yours).toBe(0);
  });

  it("refuses a suggestion that has gone", async () => {
    const voter = await makeUser(db);
    const result = await voteSuggestion(
      "00000000-0000-0000-0000-000000000000",
      voter,
      1,
      db
    );
    expect(result.ok).toBe(false);
  });

  it("shows a signed-out reader the counts and no vote of their own", async () => {
    const author = await makeUser(db);
    const { id } = unwrap(await addSuggestion(author, { title: "Darts" }, db));
    const [row] = (await listSuggestions(null, db)).filter((s) => s.id === id);
    expect(row.up).toBe(1);
    expect(row.yours).toBe(0);
  });
});

describe("the list", () => {
  it("puts what people want most at the top", async () => {
    const fresh = await freshDatabase();
    const scoped = fresh.db;
    try {
      const author = await makeUser(scoped);
      const a = unwrap(await addSuggestion(author, { title: "Wanted" }, scoped));
      const b = unwrap(await addSuggestion(author, { title: "Less wanted" }, scoped));

      for (let i = 0; i < 3; i += 1) {
        const voter = await makeUser(scoped);
        await voteSuggestion(a.id, voter, 1, scoped);
      }
      const grump = await makeUser(scoped);
      await voteSuggestion(b.id, grump, -1, scoped);

      const list = await listSuggestions(null, scoped);
      expect(list[0].title).toBe("Wanted");
      expect(list[0].score).toBe(4);
      expect(list[1].score).toBe(0);
    } finally {
      await fresh.close();
    }
  });

  it("drops the settled ones below the open ones, whatever they scored", async () => {
    const fresh = await freshDatabase();
    const scoped = fresh.db;
    try {
      const author = await makeUser(scoped);
      const done = unwrap(await addSuggestion(author, { title: "Already run" }, scoped));
      const open = unwrap(await addSuggestion(author, { title: "Still wanted" }, scoped));

      for (let i = 0; i < 5; i += 1) {
        const voter = await makeUser(scoped);
        await voteSuggestion(done.id, voter, 1, scoped);
      }
      await setSuggestionStatus(done.id, "done", scoped);

      const list = await listSuggestions(null, scoped);
      // Six votes against one, and it still sits below the open one.
      expect(list[0].title).toBe("Still wanted");
      expect(list[1].title).toBe("Already run");
    } finally {
      await fresh.close();
    }
  });
});

describe("deleting", () => {
  it("takes the votes with it", async () => {
    const author = await makeUser(db);
    const voter = await makeUser(db);
    const { id } = unwrap(await addSuggestion(author, { title: "Gone soon" }, db));
    await voteSuggestion(id, voter, 1, db);

    await deleteSuggestion(id, db);
    expect((await listSuggestions(null, db)).some((s) => s.id === id)).toBe(false);
  });
});
