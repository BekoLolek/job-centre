import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Database,
  type ProfileFieldOption,
  games,
  profileFields,
  profileValues,
} from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  type ApplicantView,
  type EventResult,
  applyToEvent,
  createEvent,
  getApplicationsForEvent,
  publishEvent,
} from "@/lib/events";

/**
 * Preferred roles on the applicant list (R-258 / Task 119).
 *
 * `getApplicationsForEvent` is the read the event editor hands to the Teams
 * tab as `applicants`, so what it returns is what that tab's props hold. These
 * tests are about the one new fact on each row — `roles` — and about what the
 * read costs. Against real Postgres, because two of the claims are about the
 * database: which question is the game's roles question, and how many
 * statements it takes to read everybody's answer to it.
 *
 * Which marked question wins when a game has two, and that a retired one is
 * skipped, is `rolesFieldFor`'s rule and is tested with it in
 * `admin-games.test.ts`; those two are not repeated here. The test of a
 * question keyed `roles` but not marked is not a repeat of anything there: it
 * is about the lookup *this* read makes, and it is the one test that fails if
 * `events.ts` ever finds the question by its key or its type instead of
 * through the marker.
 */

let harness: TestDatabase;
let db: Database;
let counter = 0;

const NOW = new Date("2026-04-01T18:00:00Z");

/**
 * Values and labels differ, so a test can tell which of the two came back, and
 * the catalogue's order is not alphabetical in either, so a sort cannot pass
 * for it.
 */
const OPTIONS: ProfileFieldOption[] = [
  { value: "tank", label: "Vanguard" },
  { value: "dps", label: "Duelist" },
  { value: "heal", label: "Strategist" },
];

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
});

afterAll(async () => {
  await harness.close();
});

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function expectOk<T>(result: EventResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `Expected success, got: ${result.error} ${JSON.stringify(result.errors ?? {})}`
    );
  }
  return result.data;
}

/**
 * A game with a rank question, a marked roles question, both or neither.
 *
 * The roles question is keyed `mains` and labelled "Mains" on purpose: every
 * test here then also says the question is found by its marker, because a
 * lookup by the key or the label `roles` finds nothing in this fixture.
 *
 * The ids come back as empty strings for a question that was not asked for,
 * so a test names the question it planted without a non-null assertion; no
 * test reads the id of one it left out.
 */
async function game(
  over: { rank?: boolean; roles?: boolean } = {}
): Promise<{ gameId: string; rankFieldId: string; rolesFieldId: string }> {
  const { rank = true, roles = true } = over;
  counter += 1;
  const [row] = await db
    .insert(games)
    .values({ key: `game-${counter}`, name: `Game ${counter}`, rankLadder: ["Gold", "Diamond"] })
    .returning({ id: games.id });

  const [rankField] = rank
    ? await db
        .insert(profileFields)
        .values({ gameId: row.id, key: "rank", label: "Rank", type: "rank", sort: 0 })
        .returning({ id: profileFields.id })
    : [{ id: "" }];

  const [rolesField] = roles
    ? await db
        .insert(profileFields)
        .values({
          gameId: row.id,
          key: "mains",
          label: "Mains",
          type: "multiselect",
          options: OPTIONS,
          holdsRoles: true,
          sort: 1,
        })
        .returning({ id: profileFields.id })
    : [{ id: "" }];

  return { gameId: row.id, rankFieldId: rankField.id, rolesFieldId: rolesField.id };
}

/** A published event for that game (or for none) that accepts whoever applies. */
async function eventFor(gameId: string | null): Promise<string> {
  counter += 1;
  const event = expectOk(
    await createEvent({ ...PUBLISHABLE, title: `Roles ${counter}`, gameId }, db)
  );
  return expectOk(await publishEvent(event.id, db)).id;
}

/** A member accepted on the event, having stored these answers (field id, value). */
async function accepted(eventId: string, ...answers: [string, unknown][]): Promise<string> {
  const userId = await makeUser(db);
  if (answers.length > 0) {
    await db
      .insert(profileValues)
      .values(answers.map(([fieldId, value]) => ({ userId, fieldId, value: value as never })));
  }
  const application = expectOk(await applyToEvent(eventId, userId, { now: NOW }, db));
  if (application.status !== "accepted") throw new Error("The fixture event did not accept.");
  return userId;
}

async function rowFor(eventId: string, userId: string): Promise<ApplicantView> {
  const row = (await getApplicationsForEvent(eventId, db)).find((view) => view.userId === userId);
  if (!row) throw new Error("That member is not on the applicant list.");
  return row;
}

/**
 * This file's database, except that every `select` it is asked to begin is
 * counted — `countingSelects` from `hero-hands.test.ts`, which has the reasons
 * it counts statements rather than rows and why only the handle's own `select`
 * is watched. Every read `getApplicationsForEvent` makes begins there.
 */
function countingSelects(): { database: Database; begun: () => number } {
  let begun = 0;
  const database = new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== "select") return value;
      return (...args: unknown[]) => {
        begun += 1;
        return (value as (...of: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { database, begun: () => begun };
}

async function selectsToList(eventId: string): Promise<number> {
  const counting = countingSelects();
  await getApplicationsForEvent(eventId, counting.database);
  return counting.begun();
}

/* ------------------------------------------------------------------ */
/* What each row carries                                              */
/* ------------------------------------------------------------------ */

describe("an applicant's preferred roles", () => {
  it("are listed by the catalogue's labels, in the catalogue's option order", async () => {
    const fix = await game();
    const eventId = await eventFor(fix.gameId);
    // Stored last-first: the reverse of the catalogue, which lists tank, dps, heal.
    const userId = await accepted(eventId, [fix.rolesFieldId, ["heal", "dps", "tank"]]);

    const row = await rowFor(eventId, userId);

    expect(row.roles).toEqual(["Vanguard", "Duelist", "Strategist"]);
  });

  it("are each player's own", async () => {
    const fix = await game();
    const eventId = await eventFor(fix.gameId);
    const tank = await accepted(eventId, [fix.rolesFieldId, ["tank"]]);
    const healer = await accepted(eventId, [fix.rolesFieldId, ["heal"]]);

    const rows = await getApplicationsForEvent(eventId, db);

    expect(new Map(rows.map((row) => [row.userId, row.roles]))).toEqual(
      new Map([
        [tank, ["Vanguard"]],
        [healer, ["Strategist"]],
      ])
    );
  });

  it("arrive beside the rank, on the same row", async () => {
    const fix = await game();
    const eventId = await eventFor(fix.gameId);
    const userId = await accepted(
      eventId,
      [fix.rankFieldId, "Diamond"],
      [fix.rolesFieldId, ["tank"]]
    );

    const row = await rowFor(eventId, userId);

    expect({ rank: row.rank, roles: row.roles }).toEqual({ rank: "Diamond", roles: ["Vanguard"] });
  });

  it("are read for a game that has no rank question", async () => {
    const fix = await game({ rank: false });
    const eventId = await eventFor(fix.gameId);
    const userId = await accepted(eventId, [fix.rolesFieldId, ["dps"]]);

    const row = await rowFor(eventId, userId);

    expect(row.roles).toEqual(["Duelist"]);
  });

  /**
   * As a stale rank already is: `rank` is whatever string is stored, whether
   * or not the ladder still has it. The role that is gone has no label left,
   * so it comes back as it was stored, after the ones the catalogue still
   * orders.
   */
  it("still include an answer naming an option since removed", async () => {
    const fix = await game();
    const eventId = await eventFor(fix.gameId);
    const userId = await accepted(eventId, [fix.rolesFieldId, ["flex", "dps"]]);

    const row = await rowFor(eventId, userId);

    expect(row.roles).toEqual(["Duelist", "flex"]);
  });
});

/* ------------------------------------------------------------------ */
/* Nothing answered, and nothing to answer                            */
/* ------------------------------------------------------------------ */

describe("an applicant with no roles to show", () => {
  it("has an empty list when the game asks and they have not answered", async () => {
    const fix = await game();
    const eventId = await eventFor(fix.gameId);
    const userId = await accepted(eventId);

    const row = await rowFor(eventId, userId);

    expect(row.roles).toEqual([]);
  });

  it("has an empty list when what is stored is not a list", async () => {
    const fix = await game();
    const eventId = await eventFor(fix.gameId);
    const userId = await accepted(eventId, [fix.rolesFieldId, "tank"]);

    const row = await rowFor(eventId, userId);

    expect(row.roles).toEqual([]);
  });

  it("has null, not an empty list, when the game has no roles question", async () => {
    const fix = await game({ roles: false });
    const eventId = await eventFor(fix.gameId);
    const userId = await accepted(eventId);

    const row = await rowFor(eventId, userId);

    expect(row.roles).toBeNull();
  });

  it("has null when the event has no game", async () => {
    const eventId = await eventFor(null);
    const userId = await accepted(eventId);

    const row = await rowFor(eventId, userId);

    expect(row.roles).toBeNull();
  });

  /**
   * The marker, not the key (R-259): a pick-any keyed `roles` that nobody
   * marked is some other question, and its answers are not roles.
   */
  it("has null when the game's only candidate is keyed `roles` but not marked", async () => {
    const fix = await game({ roles: false });
    const [unmarked] = await db
      .insert(profileFields)
      .values({
        gameId: fix.gameId,
        key: "roles",
        label: "Roles",
        type: "multiselect",
        options: OPTIONS,
        sort: 1,
      })
      .returning({ id: profileFields.id });
    const eventId = await eventFor(fix.gameId);
    const userId = await accepted(eventId, [unmarked.id, ["tank"]]);

    const row = await rowFor(eventId, userId);

    expect(row.roles).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* What the read costs                                                */
/* ------------------------------------------------------------------ */

describe("reading the applicant list", () => {
  /**
   * Compared rather than pinned to a number: the list makes other reads that
   * are none of this file's business, and a literal count would fail the day
   * one of them changed. Four players against one is three more round trips
   * for every read that is made per player, and none for one that is not.
   */
  it("begins no more selects for four players with roles than for one", async () => {
    const fix = await game();
    const one = await eventFor(fix.gameId);
    await accepted(one, [fix.rolesFieldId, ["tank"]]);
    const four = await eventFor(fix.gameId);
    await accepted(four, [fix.rolesFieldId, ["tank"]]);
    await accepted(four, [fix.rolesFieldId, ["dps"]]);
    await accepted(four, [fix.rolesFieldId, ["heal"]]);
    await accepted(four, [fix.rolesFieldId, ["tank", "heal"]]);

    const forOne = await selectsToList(one);
    const forFour = await selectsToList(four);

    expect(forFour).toBe(forOne);
  });

  /**
   * The pair is one read: the roles answers come back in the statement that
   * already fetches the rank answers. Both games have a rank question, so that
   * statement runs for both; only one has a roles question, so a second
   * statement for its answers would show as one more select.
   */
  it("begins no more selects for a game with a roles question than for one without", async () => {
    const withRoles = await game();
    const asked = await eventFor(withRoles.gameId);
    await accepted(asked, [withRoles.rankFieldId, "Gold"], [withRoles.rolesFieldId, ["tank"]]);
    const without = await game({ roles: false });
    const notAsked = await eventFor(without.gameId);
    await accepted(notAsked, [without.rankFieldId, "Gold"]);

    const whenAsked = await selectsToList(asked);
    const whenNotAsked = await selectsToList(notAsked);

    expect(whenAsked).toBe(whenNotAsked);
  });
});
