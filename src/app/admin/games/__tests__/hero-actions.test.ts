import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database, auditLog, games, heroes } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";

/**
 * The hero server actions, and the audit line each one writes (UC-40 4).
 *
 * "System saves it and **records who changed it in the audit log**" is a step of
 * the main success path, so it is a criterion rather than a nicety — and it is
 * the one thing `src/lib/__tests__/heroes-editing.test.ts` structurally cannot
 * check, because `src/lib/audit.ts` is explicit that `recordAudit` is called
 * from the action layer and nowhere else: this is the only layer that has run
 * `requireAdmin()` and therefore the only one that knows who is acting.
 *
 * Only what cannot run outside a Next request is replaced, the way
 * `settings.test.ts` does it: who is signed in, and the page cache.
 */
const state = vi.hoisted(() => ({ db: undefined as unknown as Database, adminId: "" }));

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

vi.mock("@/lib/session-guards", () => ({
  // A real row, so the line the action writes can name its actor.
  requireAdmin: async () => ({ id: state.adminId, displayName: "Beko" }),
}));

const revalidated: string[] = [];
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => {
    revalidated.push(path);
  },
}));

const {
  createHeroAction,
  renameHeroAction,
  restoreHeroAction,
  retireHeroAction,
  setHeroRolesAction,
} = await import("../actions");
const { AUDIT_ACTIONS, actionLabel } = await import("@/lib/audit");
const { HERO_ROLE_REQUIRED, heroNameTakenRefusal, listHeroes } = await import("@/lib/heroes");

let handle: TestDatabase;
let rivalsId: string;

beforeAll(async () => {
  handle = await freshDatabase();
  state.db = handle.db;
  state.adminId = await makeUser(handle.db, { displayName: "Beko" });
  const [rivals] = await handle.db
    .insert(games)
    .values({ key: "rivals", name: "Marvel Rivals", sort: 0 })
    .returning();
  rivalsId = rivals.id;
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.delete(auditLog);
  await handle.db.delete(heroes);
  revalidated.length = 0;
});

/** The newest audit line, or undefined. */
async function latest() {
  const [row] = await handle.db.select().from(auditLog).orderBy(desc(auditLog.at)).limit(1);
  return row;
}

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

async function addHulk(): Promise<string> {
  return unwrap(await createHeroAction(rivalsId, "Hulk", ["Vanguard"])).id;
}

/* ------------------------------------------------------------------ */
/* The vocabulary                                                     */
/* ------------------------------------------------------------------ */

describe("the hero actions in the log's vocabulary", () => {
  it("labels all five, so no line renders as a raw key", () => {
    /*
     * `actionLabel` falls back to the raw string rather than hiding a row it
     * cannot label, which is the right failure — but "hero.roles" on the log
     * page is a line nobody reads. All five are in the map.
     */
    for (const action of ["added", "renamed", "roles", "retired", "restored"] as const) {
      const key = `hero.${action}`;
      expect(AUDIT_ACTIONS, key).toHaveProperty(key);
      expect(actionLabel(key)).not.toBe(key);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Add                                                                */
/* ------------------------------------------------------------------ */

describe("createHeroAction", () => {
  it("writes the hero and a line naming who added it and what it plays (UC-40 3, 4)", async () => {
    const id = await addHulk();

    const [stored] = await handle.db.select().from(heroes).where(eq(heroes.id, id));
    expect(stored.name).toBe("Hulk");
    expect(stored.roles).toEqual(["Vanguard"]);

    const line = await latest();
    expect(line.action).toBe("hero.added");
    expect(line.actorUserId).toBe(state.adminId);
    expect(line.actorName).toBe("Beko");
    expect(line.subject).toBe(id);
    expect(line.summary).toBe("Added the hero Hulk as Vanguard.");
    expect(line.detail).toEqual({ game: rivalsId, name: "Hulk", roles: ["Vanguard"] });
  });

  it("says all three roles when a hero holds all three (UC-40 3c)", async () => {
    unwrap(await createHeroAction(rivalsId, "Deadpool", ["Strategist", "Duelist", "Vanguard"]));
    expect((await latest()).summary).toBe(
      "Added the hero Deadpool as Vanguard, Duelist, Strategist."
    );
  });

  it("logs nothing when the add is refused (UC-40 3a)", async () => {
    await addHulk();
    await handle.db.delete(auditLog);

    const again = await createHeroAction(rivalsId, "Hulk", ["Vanguard"]);
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error).toBe(heroNameTakenRefusal("Hulk"));
    // No row, and no line about one.
    expect(await listHeroes(rivalsId, handle.db)).toHaveLength(1);
    expect(await latest()).toBeUndefined();
  });

  it("logs nothing when no role was ticked (UC-40 3b)", async () => {
    const result = await createHeroAction(rivalsId, "Nobody", []);
    expect(result.ok === false && result.error).toBe(HERO_ROLE_REQUIRED);
    expect(await latest()).toBeUndefined();
    expect(await listHeroes(rivalsId, handle.db)).toHaveLength(0);
  });

  it("refreshes this screen and the log, and not the profile page", async () => {
    // A hero is not a profile question, so nothing a member is asked changed.
    await addHulk();
    expect([...new Set(revalidated)].sort()).toEqual(["/admin/audit", "/admin/games"]);
  });
});

/* ------------------------------------------------------------------ */
/* Rename — both names, which is the point                            */
/* ------------------------------------------------------------------ */

describe("renameHeroAction", () => {
  it("records the old name as well as the new one", async () => {
    /*
     * **The (game, name) trap's only surviving record.** There is no stable key
     * column, so after the update the row has no memory of what the hero used
     * to be called — and the next run of the seed plants the old name again as
     * a second hero. This line is how somebody reading the list afterwards
     * works out which of the two is the duplicate.
     */
    const id = await addHulk();
    const data = unwrap(await renameHeroAction(id, "The Hulk"));
    expect(data).toEqual({ name: "The Hulk", previousName: "Hulk" });

    const line = await latest();
    expect(line.action).toBe("hero.renamed");
    expect(line.actorName).toBe("Beko");
    expect(line.subject).toBe(id);
    expect(line.summary).toBe("Renamed the hero Hulk to The Hulk.");
    expect(line.detail).toEqual({ game: rivalsId, from: "Hulk", to: "The Hulk" });
  });

  it("logs nothing when the rename is refused", async () => {
    const id = await addHulk();
    unwrap(await createHeroAction(rivalsId, "Venom", ["Vanguard"]));
    await handle.db.delete(auditLog);

    const result = await renameHeroAction(id, "Venom");
    expect(result.ok === false && result.error).toBe(heroNameTakenRefusal("Venom"));
    expect(await latest()).toBeUndefined();
    const [unchanged] = await handle.db.select().from(heroes).where(eq(heroes.id, id));
    expect(unchanged.name).toBe("Hulk");
  });
});

/* ------------------------------------------------------------------ */
/* Roles                                                              */
/* ------------------------------------------------------------------ */

describe("setHeroRolesAction", () => {
  it("records the set the hero now plays", async () => {
    const id = await addHulk();
    const data = unwrap(await setHeroRolesAction(id, ["Duelist", "Vanguard"]));
    expect(data.roles).toEqual(["Vanguard", "Duelist"]);

    const line = await latest();
    expect(line.action).toBe("hero.roles");
    expect(line.actorName).toBe("Beko");
    expect(line.subject).toBe(id);
    expect(line.summary).toBe("Hulk is now Vanguard, Duelist.");
    expect(line.detail).toEqual({ game: rivalsId, roles: ["Vanguard", "Duelist"] });
  });

  it("logs nothing when every box was unticked (UC-40 3b)", async () => {
    const id = await addHulk();
    await handle.db.delete(auditLog);

    const result = await setHeroRolesAction(id, []);
    expect(result.ok === false && result.error).toBe(HERO_ROLE_REQUIRED);
    expect(await latest()).toBeUndefined();
    const [unchanged] = await handle.db.select().from(heroes).where(eq(heroes.id, id));
    expect(unchanged.roles).toEqual(["Vanguard"]);
  });
});

/* ------------------------------------------------------------------ */
/* Retire and restore (UC-40 4a)                                      */
/* ------------------------------------------------------------------ */

describe("retireHeroAction", () => {
  it("records a retirement, and says what the hands keep", async () => {
    const id = await addHulk();
    expect(unwrap(await retireHeroAction(id))).toEqual({ name: "Hulk" });

    const line = await latest();
    expect(line.action).toBe("hero.retired");
    expect(line.actorName).toBe("Beko");
    expect(line.subject).toBe(id);
    // The log is read by somebody asking where a hero went, and "retired" on
    // its own invites the answer that the hands went with it.
    expect(line.summary).toBe("Retired the hero Hulk. Hands already dealt still name it.");
  });

  it("keeps the row, so nothing in the log is about a deletion", async () => {
    const id = await addHulk();
    unwrap(await retireHeroAction(id));
    expect(await listHeroes(rivalsId, handle.db)).toHaveLength(1);
    expect((await latest()).action).not.toContain("delete");
  });

  it("records bringing one back", async () => {
    const id = await addHulk();
    unwrap(await retireHeroAction(id));
    expect(unwrap(await restoreHeroAction(id))).toEqual({ name: "Hulk" });

    const line = await latest();
    expect(line.action).toBe("hero.restored");
    expect(line.actorName).toBe("Beko");
    expect(line.summary).toBe("Brought the hero Hulk back into the draw.");
  });
});
