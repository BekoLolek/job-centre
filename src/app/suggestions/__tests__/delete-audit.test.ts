import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, auditLog, eventSuggestions, users } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";

/**
 * Removing a suggestion leaves a line behind (Task 139).
 *
 * It used to leave nothing. That was thin while only an admin could remove
 * somebody else's; `suggestions.moderate` is grantable now (R-261), so a member
 * holding it could take anybody's idea off the list — and every like on it, by
 * cascade — with no record that it had ever been there.
 *
 * Two different things happen behind the one button and the log tells them
 * apart: somebody taking their own idea back, and somebody removing another
 * member's. Which one it was is read from the row's author and not from the
 * power the actor holds, so the fixture includes the case that separates the
 * two — a moderator removing their *own*.
 *
 * Built the way `polls-suggestions-settings-powers.test.ts` is: the action, the
 * guard and `powersOf` run for real against an in-memory Postgres, with only
 * the session cookie and the page cache replaced.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  userId: null as string | null,
}));

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  const db = new Proxy({} as Database, {
    get(_target, property) {
      const real = state.db as unknown as Record<string | symbol, unknown>;
      const value = Reflect.get(real, property, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
  return { ...actual, db };
});

vi.mock("@/lib/auth", () => ({
  SIGN_IN_PATH: "/signin",
  auth: async () => (state.userId ? { user: { id: state.userId } } : null),
}));

const revalidated: string[] = [];
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path);
  },
}));

const { deleteSuggestionAction } = await import("../actions");
const { actionLabel, actionTone } = await import("@/lib/audit");
const { grantPower } = await import("@/lib/permissions");
const { addSuggestion } = await import("@/lib/suggestions");

let handle: TestDatabase;
let db: Database;
/** No power at all: may remove only their own. */
let dana: string;
/** Holds `suggestions.moderate`, and is not an admin. */
let moderator: string;
/** The flag, and no row in `user_permissions`. */
let admin: string;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;

  dana = await makeUser(db, { displayName: "Dana" });
  moderator = await makeUser(db, { displayName: "Morgan the moderator" });
  admin = await makeUser(db, { displayName: "Beko" });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, admin));
  await grantPower(
    { userId: moderator, power: "suggestions.moderate", grantedByUserId: admin },
    db
  );
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await db.delete(auditLog);
  await db.delete(eventSuggestions);
  revalidated.length = 0;
});

/** A suggestion from `by`. Adding one writes no audit line, so none to clear. */
async function aSuggestion(by: string, title: string): Promise<string> {
  const result = await addSuggestion(by, { title, detail: "Somebody ought to run this." }, db);
  if (!result.ok) throw new Error(result.error);
  return result.data.id;
}

/** Every audit line, newest first. */
async function lines() {
  return db.select().from(auditLog).orderBy(desc(auditLog.at));
}

async function stillThere(id: string): Promise<boolean> {
  const rows = await db.select().from(eventSuggestions).where(eq(eventSuggestions.id, id));
  return rows.length === 1;
}

/* ------------------------------------------------------------------ */
/* Somebody else's                                                    */
/* ------------------------------------------------------------------ */

describe("a moderator removing somebody else's suggestion", () => {
  it("writes one line naming the moderator, the suggestion and whose it was", async () => {
    // The row is gone afterwards, so the title and the author have to be on
    // the line: there is nothing left to look either of them up from.
    const id = await aSuggestion(dana, "A REPO night");
    // A second one, from somebody else, so a line that named whichever
    // suggestion or author came first would not pass by luck.
    await aSuggestion(admin, "A decoy that stays");
    state.userId = moderator;

    const result = await deleteSuggestionAction(id);

    expect(result).toEqual({ ok: true, data: undefined });
    expect(await stillThere(id)).toBe(false);
    const written = await lines();
    expect(written).toHaveLength(1);
    const [line] = written;
    expect(line.action).toBe("suggestion.deleted");
    expect(line.actorUserId).toBe(moderator);
    expect(line.actorName).toBe("Morgan the moderator");
    expect(line.subject).toBe(id);
    expect(line.summary).toBe("Removed “A REPO night”, a suggestion from Dana.");
    expect(line.detail).toEqual({
      title: "A REPO night",
      authorUserId: dana,
      authorName: "Dana",
      own: false,
    });
  });

  it("is recorded under an action the log marks as destructive", async () => {
    const id = await aSuggestion(dana, "A REPO night");
    state.userId = moderator;

    await deleteSuggestionAction(id);

    expect(actionTone((await lines())[0].action)).toBe("flare");
  });

  it("is recorded the same way for an admin who holds no power", async () => {
    const id = await aSuggestion(dana, "A REPO night");
    state.userId = admin;

    await deleteSuggestionAction(id);

    const [line] = await lines();
    expect(line.action).toBe("suggestion.deleted");
    expect(line.actorUserId).toBe(admin);
    expect(line.summary).toBe("Removed “A REPO night”, a suggestion from Dana.");
  });

  it("says nobody is on record as its author when the account behind it has gone", async () => {
    // `created_by_user_id` is set null when an account is deleted, and only
    // somebody who may remove anybody's can remove what is left.
    const id = await aSuggestion(dana, "An orphaned idea");
    await db
      .update(eventSuggestions)
      .set({ createdByUserId: null })
      .where(eq(eventSuggestions.id, id));
    state.userId = moderator;

    await deleteSuggestionAction(id);

    const [line] = await lines();
    expect(line.action).toBe("suggestion.deleted");
    expect(line.summary).toBe(
      "Removed the suggestion “An orphaned idea”. Nobody is on record as its author."
    );
    expect(line.detail).toEqual({
      title: "An orphaned idea",
      authorUserId: null,
      authorName: null,
      own: false,
    });
  });
});

/* ------------------------------------------------------------------ */
/* Their own                                                          */
/* ------------------------------------------------------------------ */

describe("a member removing their own suggestion", () => {
  it("is recorded too, naming the member and the suggestion", async () => {
    const id = await aSuggestion(dana, "A REPO night");
    state.userId = dana;

    const result = await deleteSuggestionAction(id);

    expect(result).toEqual({ ok: true, data: undefined });
    const written = await lines();
    expect(written).toHaveLength(1);
    const [line] = written;
    expect(line.action).toBe("suggestion.withdrawn");
    expect(line.actorUserId).toBe(dana);
    expect(line.actorName).toBe("Dana");
    expect(line.subject).toBe(id);
    expect(line.summary).toBe("Removed their own suggestion “A REPO night”.");
    expect(line.detail).toEqual({
      title: "A REPO night",
      authorUserId: dana,
      authorName: "Dana",
      own: true,
    });
  });

  it("reads differently from a moderator removing the same member's suggestion", async () => {
    // Same author, same title, two actors: everything a reader could tell the
    // two lines apart by has to come from who pressed the button.
    const first = await aSuggestion(dana, "A REPO night");
    state.userId = dana;
    await deleteSuggestionAction(first);
    const second = await aSuggestion(dana, "A REPO night");
    state.userId = moderator;
    await deleteSuggestionAction(second);

    const written = await lines();
    const byOwner = written.find((line) => line.subject === first);
    const byModerator = written.find((line) => line.subject === second);
    expect(written).toHaveLength(2);
    expect(byOwner?.action).toBe("suggestion.withdrawn");
    expect(byModerator?.action).toBe("suggestion.deleted");
    expect(actionLabel("suggestion.withdrawn")).not.toBe(actionLabel("suggestion.deleted"));
    expect(byOwner?.summary).not.toBe(byModerator?.summary);
  });

  it("is told apart by whose the row was, not by the power the actor holds", async () => {
    // A moderator may remove anybody's — and this one is their own. A line
    // decided from the power would say they removed somebody else's.
    const id = await aSuggestion(moderator, "The moderator's own idea");
    state.userId = moderator;

    await deleteSuggestionAction(id);

    const [line] = await lines();
    expect(line.action).toBe("suggestion.withdrawn");
    expect(line.summary).toBe("Removed their own suggestion “The moderator's own idea”.");
    expect(line.detail).toMatchObject({ authorUserId: moderator, own: true });
  });

  it("is not marked as something a power took away", async () => {
    const id = await aSuggestion(dana, "A REPO night");
    state.userId = dana;

    await deleteSuggestionAction(id);

    const [line] = await lines();
    expect(line.action).toBe("suggestion.withdrawn");
    expect(actionTone(line.action)).toBe("muted");
  });
});

/* ------------------------------------------------------------------ */
/* Nothing happened, nothing said                                     */
/* ------------------------------------------------------------------ */

describe("a removal that is refused", () => {
  it("logs nothing when a member aims at somebody else's", async () => {
    const id = await aSuggestion(moderator, "Not Dana's to remove");
    state.userId = dana;

    const result = await deleteSuggestionAction(id);

    expect(result).toEqual({ ok: false, error: "That is not yours to remove." });
    expect(await stillThere(id)).toBe(true);
    expect(await lines()).toHaveLength(0);
  });

  it("logs nothing when there is no such suggestion", async () => {
    state.userId = moderator;

    const result = await deleteSuggestionAction("00000000-0000-4000-8000-000000000000");

    expect(result.ok).toBe(false);
    expect(await lines()).toHaveLength(0);
  });
});

describe("the pages a removal refreshes", () => {
  it("includes the log, which now has a line about it", async () => {
    const id = await aSuggestion(dana, "A REPO night");
    state.userId = dana;

    await deleteSuggestionAction(id);

    expect([...new Set(revalidated)].sort()).toEqual(["/admin", "/admin/audit", "/suggestions"]);
  });
});
