import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, type EventRow, games, profileFields, profileValues } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { RIVALS_RANK_LADDER } from "@/db/seed";
import {
  type EventResult,
  applyToEvent,
  createEvent,
  getApplicationsForEvent,
  loadApplicationForm,
  publishEvent,
} from "@/lib/events";

/**
 * A retired rank field is not read (Task 122).
 *
 * Retiring a profile field stops the site asking the question; every other
 * read of a profile field drops it from then on. The rank read did not, so a
 * member was admitted or refused on an answer they could no longer see or
 * correct, and a retired field sorted first shadowed the live one behind it.
 *
 * There are two rank reads and they are fixed separately, so each is tested
 * through its own door: the application write (`applyToEvent`) reads one
 * member's rank, and the form and the applicant list (`loadApplicationForm`,
 * `getApplicationsForEvent`) read a list of members' ranks at once.
 *
 * Every test builds its own game, so the fields one test retires are not the
 * fields another reads.
 */

let harness: TestDatabase;
let db: Database;

const NOW = new Date("2026-04-01T18:00:00Z");
let counter = 0;

/** The entry bar, one rank that clears it and one that does not. */
const ENTER = "Platinum III";
const ABOVE = "Diamond I";
const BELOW = "Gold I";

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
});

afterAll(async () => {
  await harness.close();
});

function expectOk<T>(result: EventResult<T>): T {
  if (!result.ok) {
    throw new Error(
      `Expected success, got: ${result.error} ${JSON.stringify(result.errors ?? {})}`
    );
  }
  return result.data;
}

function expectFail<T>(result: EventResult<T>): { error: string } {
  if (result.ok) throw new Error("Expected a failure, but the call succeeded.");
  return result;
}

/** A game of its own with the Rivals ladder, and a published event gated at `ENTER`. */
async function gatedGame(): Promise<{ gameId: string; event: EventRow }> {
  counter += 1;
  const [game] = await db
    .insert(games)
    .values({
      key: `retired-rank-${counter}`,
      name: `Retired rank ${counter}`,
      rankLadder: [...RIVALS_RANK_LADDER],
    })
    .returning({ id: games.id });
  const event = expectOk(
    await createEvent(
      { ...PUBLISHABLE, title: `Retired rank ${counter}`, gameId: game.id, minRankToEnter: ENTER },
      db
    )
  );
  return { gameId: game.id, event: expectOk(await publishEvent(event.id, db)) };
}

/** A rank field of `gameId` at `sort`, retired or not. Hands back its id. */
async function rankField(
  gameId: string,
  over: { sort: number; retired?: boolean }
): Promise<string> {
  const [field] = await db
    .insert(profileFields)
    .values({
      gameId,
      key: `rank-${over.sort}`,
      label: `Rank ${over.sort}`,
      type: "rank",
      sort: over.sort,
      retiredAt: over.retired ? NOW : null,
    })
    .returning({ id: profileFields.id });
  return field.id;
}

async function retire(fieldId: string): Promise<void> {
  await db.update(profileFields).set({ retiredAt: NOW }).where(eq(profileFields.id, fieldId));
}

/** A member with these answers, as `[fieldId, rank]` pairs. */
async function memberAnswering(...answers: Array<[fieldId: string, rank: string]>): Promise<string> {
  const userId = await makeUser(db);
  await db
    .insert(profileValues)
    .values(answers.map(([fieldId, rank]) => ({ userId, fieldId, value: rank as never })));
  return userId;
}

/* ------------------------------------------------------------------ */
/* The gate decision changes when the field is retired                */
/* ------------------------------------------------------------------ */

describe("a rank field that has been retired", () => {
  it("stops admitting an application on its answer", async () => {
    const { gameId, event } = await gatedGame();
    const fieldId = await rankField(gameId, { sort: 0 });
    const before = await memberAnswering([fieldId, ABOVE]);
    const after = await memberAnswering([fieldId, ABOVE]);

    const admitted = expectOk(await applyToEvent(event.id, before, { now: NOW }, db));
    await retire(fieldId);
    const refused = expectFail(await applyToEvent(event.id, after, { now: NOW }, db));

    expect(admitted.status).toBe("accepted");
    expect(refused.error).toContain(ENTER);
    expect((await getApplicationsForEvent(event.id, db)).map((row) => row.userId)).toEqual([
      before,
    ]);
  });

  it("stops the form telling the same member they can enter", async () => {
    const { gameId, event } = await gatedGame();
    const fieldId = await rankField(gameId, { sort: 0 });
    const userId = await memberAnswering([fieldId, ABOVE]);

    const before = await loadApplicationForm(event.id, userId, { now: NOW }, db);
    await retire(fieldId);
    const after = await loadApplicationForm(event.id, userId, { now: NOW }, db);

    expect(before?.eligibility.canEnter).toBe(true);
    expect(after?.eligibility.canEnter).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* An active field sorted after a retired one is the one read         */
/* ------------------------------------------------------------------ */

describe("an active rank field sorted after a retired one", () => {
  /**
   * Sort order and retirement disagree on purpose: the retired field is first
   * by `sort`, which is the one the fall-through used to take, and the member
   * has answered both — below the bar on the retired one, above it on the
   * active one.
   *
   * These are the only tests where a game *with* a retired rank field still
   * yields a rank, so they are what proves the field is dropped rather than
   * the whole game going rankless. A read that sorts retired fields last
   * instead of dropping them passes here; the blocks either side catch it.
   */
  async function answeredBoth() {
    const { gameId, event } = await gatedGame();
    const retired = await rankField(gameId, { sort: 0, retired: true });
    const active = await rankField(gameId, { sort: 1 });
    const userId = await memberAnswering([retired, BELOW], [active, ABOVE]);
    return { event, userId };
  }

  it("admits an application the retired answer would have refused", async () => {
    const { event, userId } = await answeredBoth();

    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    expect(application.status).toBe("accepted");
  });

  it("is the rank the form shows and admits on", async () => {
    const { event, userId } = await answeredBoth();

    const form = await loadApplicationForm(event.id, userId, { now: NOW }, db);

    expect(form?.rank).toBe(ABOVE);
    expect(form?.eligibility.canEnter).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* An answer only on the retired field is no rank                     */
/* ------------------------------------------------------------------ */

describe("a member whose only rank answer is on a retired field", () => {
  /** A field they answered, not yet retired, ahead of an active one they have not. */
  async function answeredOnlyTheFirst() {
    const { gameId, event } = await gatedGame();
    const first = await rankField(gameId, { sort: 0 });
    await rankField(gameId, { sort: 1 });
    const userId = await memberAnswering([first, ABOVE]);
    return { event, userId, first };
  }

  it("reads as having no rank on the form", async () => {
    const { event, userId, first } = await answeredOnlyTheFirst();
    await retire(first);

    const form = await loadApplicationForm(event.id, userId, { now: NOW }, db);

    expect(form?.rank).toBeNull();
    expect(form?.eligibility.canEnter).toBe(false);
  });

  it("is refused in the words a member with no rank is", async () => {
    const { event, userId, first } = await answeredOnlyTheFirst();
    const unranked = await makeUser(db);
    await retire(first);

    const refusal = expectFail(await applyToEvent(event.id, userId, { now: NOW }, db));
    const noRank = expectFail(await applyToEvent(event.id, unranked, { now: NOW }, db));

    expect(refusal.error).toBe(noRank.error);
  });

  it("reads as having no rank in the applicant list, though they applied on it", async () => {
    const { event, userId, first } = await answeredOnlyTheFirst();
    expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));
    await retire(first);

    const [applicant] = await getApplicationsForEvent(event.id, db);

    expect(applicant.userId).toBe(userId);
    expect(applicant.rank).toBeNull();
    expect(applicant.eligibility.canEnter).toBe(false);
  });
});
