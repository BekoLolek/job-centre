import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, suggestionVotes } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  DETAIL_MAX,
  GAME_MAX,
  TITLE_MAX,
  addSuggestion,
  deleteSuggestion,
  listSuggestions,
  setSuggestionStatus,
  voteSuggestion,
} from "@/lib/suggestions";

/**
 * The suggestion box (R-87 to R-90, R-163 to R-165 / UC-22).
 *
 * The tally is the whole feature, so what is pinned down here is the counting:
 * one person is one vote whatever they click, changing your mind moves the
 * number rather than adding to it, and clicking the same arrow twice takes the
 * vote back.
 *
 * The second half is the writing rules. Every one of them is asserted against
 * the library rather than the form, because the form is a courtesy and this is
 * the check: a server action is a public endpoint, so `maxLength` on an input
 * and a disabled button are worth nothing to somebody posting at it directly.
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

function why(result: { ok: true } | { ok: false; error: string }): string {
  if (result.ok) throw new Error("Expected a refusal, and it was accepted.");
  return result.error;
}

/** The smallest thing UC-22 1 calls a suggestion: a title and a description. */
function proposal(over: Partial<Parameters<typeof addSuggestion>[1]> = {}) {
  return { title: "A REPO night", detail: "Five of us, two hours, one torch.", ...over };
}

/**
 * Rows left in `suggestion_votes` for a suggestion, asked of the table itself.
 *
 * `listSuggestions` cannot answer this once the suggestion is gone, so a delete
 * test that only reads the list is not testing the cascade at all.
 */
async function votesOn(suggestionId: string): Promise<number> {
  const rows = await db
    .select({ userId: suggestionVotes.userId })
    .from(suggestionVotes)
    .where(eq(suggestionVotes.suggestionId, suggestionId));
  return rows.length;
}

/** Where a row landed in the list, so order can be asserted without a clean slate. */
function place(list: Array<{ id: string }>, id: string): number {
  const at = list.findIndex((row) => row.id === id);
  expect(at).toBeGreaterThanOrEqual(0);
  return at;
}

describe("adding", () => {
  it("counts the suggester as wanting it", async () => {
    // UC-22 E2: the author's like is counted without a second click.
    const userId = await makeUser(db, { displayName: "Ada" });
    const { id } = unwrap(await addSuggestion(userId, proposal(), db));

    const [row] = (await listSuggestions(userId, db)).filter((s) => s.id === id);
    expect(row.up).toBe(1);
    expect(row.score).toBe(1);
    expect(row.yours).toBe(1);
    expect(row.by?.name).toBe("Ada");
  });

  it("keeps the game, so organisers can tell at a glance", async () => {
    // UC-22 E1.
    const userId = await makeUser(db);
    const { id } = unwrap(
      await addSuggestion(userId, proposal({ gameName: "  R.E.P.O.  " }), db)
    );

    const [row] = (await listSuggestions(null, db)).filter((s) => s.id === id);
    expect(row.gameName).toBe("R.E.P.O.");
  });

  it("refuses a title that is not one", async () => {
    // UC-22 1a: empty, or too long.
    const userId = await makeUser(db);
    expect((await addSuggestion(userId, proposal({ title: "  " }), db)).ok).toBe(false);
    expect(
      (await addSuggestion(userId, proposal({ title: "x".repeat(TITLE_MAX + 1) }), db)).ok
    ).toBe(false);
    expect(
      (await addSuggestion(userId, proposal({ title: "x".repeat(TITLE_MAX) }), db)).ok
    ).toBe(true);
  });

  it("refuses a suggestion with nothing said about it", async () => {
    /*
     * UC-22 1 asks for a title *and* a short description, and 1a says empty is
     * rejected. A bare title is not a proposal anybody can back or refuse — it
     * is a row that sits at zero because nobody can tell what they would be
     * voting for.
     */
    const userId = await makeUser(db);

    const empty = await addSuggestion(userId, proposal({ detail: "" }), db);
    expect(empty.ok).toBe(false);
    expect(why(empty)).toMatch(/about it/i);

    // Whitespace is empty. It is trimmed before it is measured, so a page of
    // spaces is neither a description nor "too long".
    const blank = await addSuggestion(userId, proposal({ detail: "   \n  " }), db);
    expect(blank.ok).toBe(false);
    expect(why(blank)).toMatch(/about it/i);
  });

  it("refuses a description longer than the column is meant to hold", async () => {
    // UC-22 1a.
    const userId = await makeUser(db);
    const long = await addSuggestion(
      userId,
      proposal({ detail: "x".repeat(DETAIL_MAX + 1) }),
      db
    );
    expect(long.ok).toBe(false);
    expect(why(long)).toMatch(/description/i);

    expect(
      (await addSuggestion(userId, proposal({ detail: "x".repeat(DETAIL_MAX) }), db)).ok
    ).toBe(true);
  });

  it("refuses a game name past GAME_MAX, on the server", async () => {
    /*
     * UC-22 1a for the field E1 added. The form caps this at 80 characters and
     * the form is not the check — `addSuggestionAction` is a POST endpoint that
     * anybody can call with anything. The message names the game so this fails
     * if the limit is ever quietly applied to the wrong field.
     */
    const userId = await makeUser(db);
    const long = await addSuggestion(
      userId,
      proposal({ gameName: "x".repeat(GAME_MAX + 1) }),
      db
    );
    expect(long.ok).toBe(false);
    expect(why(long)).toMatch(/game/i);

    const fits = await addSuggestion(
      userId,
      proposal({ gameName: "x".repeat(GAME_MAX) }),
      db
    );
    expect(fits.ok).toBe(true);
  });
});

describe("voting", () => {
  it("is one person one vote, however many times they click", async () => {
    const author = await makeUser(db);
    const voter = await makeUser(db);
    const { id } = unwrap(await addSuggestion(author, proposal({ title: "Jackbox" }), db));

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
    const { id } = unwrap(await addSuggestion(author, proposal({ title: "Chess" }), db));

    unwrap(await voteSuggestion(id, voter, 1, db));
    const after = unwrap(await voteSuggestion(id, voter, -1, db));

    expect(after.up).toBe(1);
    expect(after.down).toBe(1);
    expect(after.yours).toBe(-1);
  });

  it("takes a vote back when the same arrow is clicked again", async () => {
    const author = await makeUser(db);
    const voter = await makeUser(db);
    const { id } = unwrap(await addSuggestion(author, proposal({ title: "Golf" }), db));

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
    const { id } = unwrap(await addSuggestion(author, proposal({ title: "Darts" }), db));
    const [row] = (await listSuggestions(null, db)).filter((s) => s.id === id);
    expect(row.up).toBe(1);
    expect(row.yours).toBe(0);
  });
});

describe("the list", () => {
  it("puts what people want most at the top", async () => {
    // UC-22 4.
    const author = await makeUser(db);
    const a = unwrap(await addSuggestion(author, proposal({ title: "Wanted" }), db));
    const b = unwrap(await addSuggestion(author, proposal({ title: "Less wanted" }), db));

    for (let i = 0; i < 3; i += 1) {
      const voter = await makeUser(db);
      await voteSuggestion(a.id, voter, 1, db);
    }
    const grump = await makeUser(db);
    await voteSuggestion(b.id, grump, -1, db);

    // Relative order, against the shared database. Asserting on absolute
    // positions would mean a database per test, and building one costs a dozen
    // migrations — which is what used to time this suite out.
    const list = await listSuggestions(null, db);
    expect(place(list, a.id)).toBeLessThan(place(list, b.id));
    expect(list.find((row) => row.id === a.id)?.score).toBe(4);
    expect(list.find((row) => row.id === b.id)?.score).toBe(0);
  });

  it("drops the settled ones below the open ones, whatever they scored", async () => {
    const author = await makeUser(db);
    const done = unwrap(await addSuggestion(author, proposal({ title: "Already run" }), db));
    const open = unwrap(await addSuggestion(author, proposal({ title: "Still wanted" }), db));

    for (let i = 0; i < 5; i += 1) {
      const voter = await makeUser(db);
      await voteSuggestion(done.id, voter, 1, db);
    }
    unwrap(await setSuggestionStatus(done.id, "done", db));

    // Six votes against one, and it still sits below the open one.
    const list = await listSuggestions(null, db);
    expect(place(list, open.id)).toBeLessThan(place(list, done.id));
  });
});

describe("marking where it got to", () => {
  it("shows everyone the status an admin set", async () => {
    // UC-22 5, 6.
    const author = await makeUser(db);
    const { id } = unwrap(await addSuggestion(author, proposal({ title: "Planned one" }), db));

    unwrap(await setSuggestionStatus(id, "planned", db));
    const [row] = (await listSuggestions(null, db)).filter((s) => s.id === id);
    expect(row.status).toBe("planned");
  });

  it("says so when the suggestion went while the page was open", async () => {
    /*
     * The screen moves the dropdown optimistically, so a refusal that is not
     * returned is a refusal nobody sees: "Planned" stays on a row that no
     * longer exists until somebody reloads. UC-22 5 is only true if the status
     * shown is the status stored.
     */
    const result = await setSuggestionStatus(
      "00000000-0000-0000-0000-000000000000",
      "planned",
      db
    );
    expect(result.ok).toBe(false);
    expect(why(result)).toMatch(/gone/i);
  });
});

describe("deleting", () => {
  it("takes the votes with it", async () => {
    // UC-22 E3.
    const author = await makeUser(db);
    const voter = await makeUser(db);
    const { id } = unwrap(await addSuggestion(author, proposal({ title: "Gone soon" }), db));
    await voteSuggestion(id, voter, 1, db);
    // The author's own like (UC-22 E2) and the voter's.
    expect(await votesOn(id)).toBe(2);

    unwrap(await deleteSuggestion(id, { userId: author, isAdmin: false }, db));
    expect((await listSuggestions(null, db)).some((s) => s.id === id)).toBe(false);

    // And the votes went by cascade. The row vanishing from the list says
    // nothing about that — the votes could all still be sitting in the table.
    expect(await votesOn(id)).toBe(0);
  });

  it("refuses another member's, without touching it", async () => {
    /*
     * UC-22 E3's last sentence. The ownership test is the `where` clause of the
     * delete itself, so this is not "the action forgot to check" — there is no
     * statement that could remove somebody else's row.
     */
    const author = await makeUser(db);
    const stranger = await makeUser(db);
    const { id } = unwrap(await addSuggestion(author, proposal({ title: "Not yours" }), db));

    const result = await deleteSuggestion(id, { userId: stranger, isAdmin: false }, db);
    expect(result.ok).toBe(false);
    expect(why(result)).toMatch(/not yours/i);
    expect((await listSuggestions(null, db)).some((s) => s.id === id)).toBe(true);
  });

  it("lets an admin remove anybody's", async () => {
    const author = await makeUser(db);
    const admin = await makeUser(db);
    const { id } = unwrap(await addSuggestion(author, proposal({ title: "Off topic" }), db));

    unwrap(await deleteSuggestion(id, { userId: admin, isAdmin: true }, db));
    expect((await listSuggestions(null, db)).some((s) => s.id === id)).toBe(false);
  });

  it("refuses one that has already gone rather than reporting success", async () => {
    const author = await makeUser(db);
    const result = await deleteSuggestion(
      "00000000-0000-0000-0000-000000000000",
      { userId: author, isAdmin: false },
      db
    );
    expect(result.ok).toBe(false);
  });
});
