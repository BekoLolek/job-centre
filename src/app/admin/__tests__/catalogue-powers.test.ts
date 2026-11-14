import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  type Database,
  auditLog,
  championships,
  eventTemplates,
  events,
  games,
  heroes,
  profileFields,
  users,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";

/*
 * The catalogue's three action files, asked by members who hold powers
 * (Task 127, R-261 / UC-56): `/admin/games` on `games.manage`,
 * `/admin/templates` on `templates.manage`, `/admin/championships` on
 * `championships.manage`.
 *
 * The actions run for real against an in-memory Postgres, mocked as
 * `admin/events/__tests__/powers.test.ts` mocks them: the session cookie, the
 * database handle and the page cache. `session-guards` is the real one - what
 * is under test is which guard each action asks.
 *
 * "Exactly its own file's actions and no other" is asked of **every export of
 * all three modules**: `SURFACES` names a call for each, and the first test
 * fails the day one of them exports something that is not listed.
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

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const gamesActions = await import("../games/actions");
const templatesActions = await import("../templates/actions");
const championshipsActions = await import("../championships/actions");
const { grantPower } = await import("@/lib/permissions");
const { createField, createGame, retireField } = await import("@/lib/admin-games");
const { createHero, retireHero } = await import("@/lib/heroes");
const { createTemplate } = await import("@/lib/admin-templates");

let handle: TestDatabase;
let db: Database;
let counter = 0;

const POWERS = ["games.manage", "templates.manage", "championships.manage"] as const;
type CataloguePower = (typeof POWERS)[number];

/** Each holds exactly the power the name says. The admin holds none at all. */
const ids = {} as Record<CataloguePower | "admin", string>;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;

  ids.admin = await makeUser(db, { displayName: "An admin holding nothing" });
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, ids.admin));
  for (const power of POWERS) {
    ids[power] = await makeUser(db, { displayName: `Holder of ${power}` });
    await grantPower({ userId: ids[power], power, grantedByUserId: ids.admin }, db);
  }
});

afterAll(async () => {
  await handle.close();
});

/** Real rows for every call to act on, made fresh so no test inherits another's edits. */
let target: {
  n: number;
  gameId: string;
  fieldId: string;
  retiredFieldId: string;
  heroId: string;
  retiredHeroId: string;
  templateId: string;
  championshipId: string;
  eventId: string;
};

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

beforeEach(async () => {
  state.userId = null;
  counter += 1;
  const n = counter;

  const game = unwrap(await createGame({ name: `Game ${n}` }, db));
  const field = unwrap(await createField(game.id, { label: `Asked ${n}`, type: "text" }, db));
  const retiredField = unwrap(
    await createField(game.id, { label: `Retired ${n}`, type: "text" }, db)
  );
  unwrap(await retireField(retiredField.id, db));
  const hero = unwrap(await createHero(game.id, `Hero ${n}`, ["Vanguard"], db));
  const retiredHero = unwrap(await createHero(game.id, `Benched ${n}`, ["Duelist"], db));
  unwrap(await retireHero(retiredHero.id, db));
  const template = unwrap(await createTemplate({ name: `Template ${n}` }, db));
  const [championship] = await db
    .insert(championships)
    .values({ slug: `season-${n}`, name: `Season ${n}`, status: "published" })
    .returning({ id: championships.id });
  const [event] = await db
    .insert(events)
    .values({ slug: `catalogue-${n}`, title: `Catalogue ${n}`, status: "published" })
    .returning({ id: events.id });

  target = {
    n,
    gameId: game.id,
    fieldId: field.id,
    retiredFieldId: retiredField.id,
    heroId: hero.id,
    retiredHeroId: retiredHero.id,
    templateId: template.id,
    championshipId: championship.id,
    eventId: event.id,
  };
});

/** Every table these fixtures populate. A refused call must leave all of it as it was. */
async function written() {
  const [audit, game, field, hero, template, championship] = await Promise.all([
    db.select().from(auditLog),
    db.select().from(games),
    db.select().from(profileFields),
    db.select().from(heroes),
    db.select().from(eventTemplates),
    db.select().from(championships),
  ]);
  return { audit, game, field, hero, template, championship };
}

/* ------------------------------------------------------------------ */
/* The whole exported surface of all three files                      */
/* ------------------------------------------------------------------ */

type Calls = Record<string, () => Promise<unknown>>;

/**
 * One call per export, under the power its file is on. Each is one that
 * succeeds for somebody allowed to make it, so "reaches" below means the write
 * happened and not merely that the guard let go.
 *
 * The key is not self-proving: the surface test compares names only, so it
 * cannot see a thunk that calls a different action from the one it is filed
 * under. Each of these calls its namesake; keep it so when adding one.
 */
const SURFACES: Record<CataloguePower, { module: Record<string, unknown>; calls: Calls }> = {
  "games.manage": {
    module: gamesActions,
    calls: {
      createGameAction: () => gamesActions.createGameAction(`Made ${target.n}`),
      renameGameAction: () => gamesActions.renameGameAction(target.gameId, `Renamed ${target.n}`),
      setGameActiveAction: () => gamesActions.setGameActiveAction(target.gameId, false),
      moveGameAction: () => gamesActions.moveGameAction(target.gameId, "up"),
      previewRankLadderAction: () => gamesActions.previewRankLadderAction(target.gameId, ["Bronze"]),
      setRankLadderAction: () => gamesActions.setRankLadderAction(target.gameId, ["Bronze", "Gold"]),
      createFieldAction: () =>
        gamesActions.createFieldAction(target.gameId, { label: `Added ${target.n}`, type: "text" }),
      previewFieldEditAction: () =>
        gamesActions.previewFieldEditAction(target.fieldId, { label: "Reworded", type: "text" }),
      updateFieldAction: () =>
        gamesActions.updateFieldAction(target.fieldId, { label: "Reworded", type: "text" }),
      retireFieldAction: () => gamesActions.retireFieldAction(target.fieldId),
      restoreFieldAction: () => gamesActions.restoreFieldAction(target.retiredFieldId),
      moveFieldAction: () => gamesActions.moveFieldAction(target.fieldId, "down"),
      deleteFieldAction: () => gamesActions.deleteFieldAction(target.fieldId),
      createHeroAction: () =>
        gamesActions.createHeroAction(target.gameId, `Added hero ${target.n}`, ["Strategist"]),
      renameHeroAction: () => gamesActions.renameHeroAction(target.heroId, `Renamed ${target.n}`),
      setHeroRolesAction: () => gamesActions.setHeroRolesAction(target.heroId, ["Duelist"]),
      retireHeroAction: () => gamesActions.retireHeroAction(target.heroId),
      restoreHeroAction: () => gamesActions.restoreHeroAction(target.retiredHeroId),
    },
  },
  "templates.manage": {
    module: templatesActions,
    calls: {
      createTemplateAction: () =>
        templatesActions.createTemplateAction({ name: `Made ${target.n}` }),
      updateTemplateAction: () =>
        templatesActions.updateTemplateAction(target.templateId, { name: `Renamed ${target.n}` }),
      duplicateTemplateAction: () => templatesActions.duplicateTemplateAction(target.templateId),
      setTemplateActiveAction: () =>
        templatesActions.setTemplateActiveAction(target.templateId, false),
      moveTemplateAction: () => templatesActions.moveTemplateAction(target.templateId, "up"),
      deleteTemplateAction: () => templatesActions.deleteTemplateAction(target.templateId),
      createTemplateFromEventAction: () =>
        templatesActions.createTemplateFromEventAction(target.eventId),
    },
  },
  "championships.manage": {
    module: championshipsActions,
    calls: {
      createChampionshipAction: () =>
        championshipsActions.createChampionshipAction({ name: `Made ${target.n}` }),
      saveChampionshipAction: () =>
        championshipsActions.saveChampionshipAction(target.championshipId, {
          description: "Six events, best four count.",
        }),
      setChampionshipStatusAction: () =>
        championshipsActions.setChampionshipStatusAction(
          target.championshipId,
          "published",
          "hidden"
        ),
    },
  },
};

/** Every (who, whose file, which action) there is: three holders and the admin, over all three files. */
const ROWS = ([...POWERS, "admin"] as const).flatMap((holder) =>
  POWERS.flatMap((surface) =>
    Object.keys(SURFACES[surface].calls).map((action) => [holder, surface, action] as const)
  )
);

/** A holder reaches their own file. The admin reaches all three. */
const REACHES = ROWS.filter(([holder, surface]) => holder === "admin" || holder === surface);
/**
 * Everything else is a refusal - each holder on the two files that are not
 * theirs. These are the rows that fail when a guard quietly accepts a second
 * power. No row for a member holding nothing: no guard asks about the absence
 * of a power, so anything admitting them admits a holder here first.
 */
const REFUSALS = ROWS.filter(([holder, surface]) => holder !== "admin" && holder !== surface);

describe("the catalogue's three action files", () => {
  it.each(POWERS)("have a call here for every action the %s file exports", (power) => {
    expect(Object.keys(SURFACES[power].calls).sort()).toEqual(
      Object.keys(SURFACES[power].module).sort()
    );
  });

  it.each(REACHES)("let %s through %s's %s", async (holder, surface, action) => {
    state.userId = ids[holder];

    const result = await SURFACES[surface].calls[action]();

    expect(result).not.toMatchObject({ ok: false });
  });

  it.each(REFUSALS)(
    "turn the holder of %s away from %s's %s, and write nothing",
    async (holder, surface, action) => {
      state.userId = ids[holder];
      const before = await written();

      await expect(SURFACES[surface].calls[action]()).rejects.toThrow(/NEXT_REDIRECT/);

      expect(await written()).toEqual(before);
    }
  );
});

/* ------------------------------------------------------------------ */
/* Who the log says did it                                            */
/* ------------------------------------------------------------------ */

async function actorsOf(action: string, subject: string) {
  const lines = await db.select().from(auditLog).where(eq(auditLog.subject, subject));
  return lines
    .filter((line) => line.action === action)
    .map((line) => [line.actorUserId, line.actorName]);
}

describe("the audit line a holder's write leaves", () => {
  it("names the games.manage holder who retired a hero", async () => {
    state.userId = ids["games.manage"];

    await gamesActions.retireHeroAction(target.heroId);

    expect(await actorsOf("hero.retired", target.heroId)).toEqual([
      [ids["games.manage"], "Holder of games.manage"],
    ]);
  });

  it("names the templates.manage holder who deleted a template", async () => {
    state.userId = ids["templates.manage"];

    await templatesActions.deleteTemplateAction(target.templateId);

    expect(await actorsOf("template.deleted", target.templateId)).toEqual([
      [ids["templates.manage"], "Holder of templates.manage"],
    ]);
  });

  it("names the championships.manage holder who changed a season", async () => {
    state.userId = ids["championships.manage"];

    await championshipsActions.saveChampionshipAction(target.championshipId, {
      description: "Six events, best four count.",
    });

    expect(await actorsOf("championship.updated", target.championshipId)).toEqual([
      [ids["championships.manage"], "Holder of championships.manage"],
    ]);
  });
});

describe("reopening a season as a holder the site has no name for", () => {
  it("says somebody did, not that an admin did", async () => {
    const nameless = await makeUser(db);
    await db.update(users).set({ displayName: null, name: null }).where(eq(users.id, nameless));
    await grantPower(
      { userId: nameless, power: "championships.manage", grantedByUserId: ids.admin },
      db
    );
    await db
      .update(championships)
      .set({ status: "closed" })
      .where(eq(championships.id, target.championshipId));
    state.userId = nameless;

    await championshipsActions.setChampionshipStatusAction(
      target.championshipId,
      "closed",
      "published"
    );

    const lines = await db.select().from(auditLog).where(eq(auditLog.subject, target.championshipId));
    expect(lines.map((line) => [line.action, line.summary])).toEqual([
      ["championship.reopened", `Somebody reopened "Season ${target.n}".`],
    ]);
  });
});
