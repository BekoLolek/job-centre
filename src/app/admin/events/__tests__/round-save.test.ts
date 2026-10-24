import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { type Database, type EventConfig, applications, auditLog, events } from "@/db";
import {
  PUBLISHABLE,
  type TestDatabase,
  committingAfter,
  freshDatabase,
  makeHost,
  makeUser,
} from "@/db/__tests__/helpers";

/*
 * Task 88's write — R-224, R-227, R-230, R-233 / UC-45 3-5, 3b, 3c, 3d, 3e, 4a,
 * 4b, 4c, and UC-42 5b one level down.
 *
 * Set up exactly as `round-scoring.test.ts`: the action runs for real against
 * an in-memory Postgres with only what cannot run outside a Next request
 * replaced — the session cookie, the page cache and `after()`.
 *
 * Every refusal is asserted two ways: the whole sentence with `toBe`, and the
 * round's rows read back afterwards and compared with what was there before.
 * "Nothing was written" is asserted as nothing, never as "an error came back".
 *
 * **Two managers saving one round** (4b) is sequenced rather than raced, with
 * `committingAfter`: the other manager's save runs to completion between the
 * loser's reads and the loser's transaction, so everything the loser's screen
 * read is stale by construction. The loser is refused, told the round moved,
 * handed what is there now — and their own rows are nowhere.
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
vi.mock("next/server", () => ({ after: () => {} }));

const { saveRoundAction, saveRoundScoringAction } = await import("../actions");
const { applyToEvent, createEvent, publishEvent, updateEvent } = await import("@/lib/events");
const { LOCKED_REFUSAL } = await import("@/lib/archive-policy");
const { AUDIT_ACTIONS } = await import("@/lib/audit");
const { roundMovedRefusal } = await import("@/lib/events-policy");
const { listRoundScores, saveRound } = await import("@/lib/round-scores");
const { rankRounds } = await import("@/lib/round-scoring");

let handle: TestDatabase;
let db: Database;
let counter = 0;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
  state.db = db;
});

afterAll(async () => {
  await handle.close();
});

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function refusal<T>(result: { ok: true; data: T } | { ok: false; error: string }): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

type Fixture = {
  eventId: string;
  title: string;
  members: string[];
  names: Record<string, string>;
  host: string;
};

const SOLO: EventConfig = {
  eventShape: { teamEvent: false, draft: false, sizing: { mode: "perTeam", value: 6 } },
};

const SIX = {
  rounds: Array.from({ length: 6 }, (_, index) => ({ name: index === 5 ? "Final" : null })),
  lowWins: false,
  bonuses: [
    { key: "Sub-0.5 answer", value: 2 },
    { key: "Gold run", value: 5 },
  ],
};

/** A published solo night with `people` accepted applicants, six rounds set up, and a host saving. */
async function scoredNight(people: number, scoring: typeof SIX | null = SIX): Promise<Fixture> {
  counter += 1;
  const event = unwrap(
    await createEvent({ ...PUBLISHABLE, title: `Popsauce ${counter}`, capacity: 64 }, db)
  );
  unwrap(await publishEvent(event.id, db));
  unwrap(await updateEvent(event.id, { config: SOLO }, db));

  const members: string[] = [];
  const names: Record<string, string> = {};
  for (let index = 0; index < people; index += 1) {
    const name = `Player ${counter}-${index}`;
    const userId = await makeUser(db, { displayName: name });
    unwrap(await applyToEvent(event.id, userId, {}, db));
    members.push(userId);
    names[userId] = name;
  }

  const host = await makeUser(db, { displayName: `Host ${counter}` });
  await makeHost(db, event.id, host);
  state.userId = host;
  if (scoring) unwrap(await saveRoundScoringAction(event.id, scoring));
  return { eventId: event.id, title: event.title, members, names, host };
}

const line = (userId: string, score: number | null, bonuses: Record<string, number> = {}) => ({
  userId,
  score,
  bonuses,
});

/** The round's rows as a screen would have loaded them — what a save says it expects. */
async function loaded(eventId: string, roundIndex: number) {
  return (await listRoundScores(eventId)).filter((row) => row.roundIndex === roundIndex);
}

/**
 * Rows in a fixed order. `listRoundScores` orders a round by its row id, which
 * is a random uuid, so two rows in one round come back in no particular order
 * and an assertion that lists them has to pick one.
 */
function byUser<T extends { userId: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((x, y) => (x.userId < y.userId ? -1 : x.userId > y.userId ? 1 : 0));
}

/* --------------------------------------------------------------------- */
/* One write per round (UC-45 4, 5, 3a, 3b)                              */
/* --------------------------------------------------------------------- */

describe("storing a round", () => {
  it("stores the scores and awards, and a blank player has no row", async () => {
    const { eventId, members } = await scoredNight(3);
    const [alice, bob, cass] = members;

    const saved = unwrap(
      await saveRoundAction(eventId, {
        roundIndex: 2,
        entries: [line(alice, 10, { "Gold run": 1 }), line(bob, null), line(cass, 7)],
        expected: [],
      })
    );

    expect(saved.roundIndex).toBe(2);
    expect(saved.name).toBe("Round 2");
    const rows = await listRoundScores(eventId);
    expect(byUser(rows)).toEqual(
      byUser([
        { roundIndex: 2, userId: alice, score: 10, bonuses: { "Gold run": 1 } },
        { roundIndex: 2, userId: cass, score: 7, bonuses: {} },
      ])
    );
    expect(rows.some((row) => row.userId === bob)).toBe(false);
    expect(byUser(saved.rows)).toEqual(byUser(rows));
  });

  it("records a bonus earned twice as twice, and reads it back as twice (3b)", async () => {
    const { eventId, members } = await scoredNight(1);
    unwrap(
      await saveRoundAction(eventId, {
        roundIndex: 1,
        entries: [line(members[0], 4, { "Sub-0.5 answer": 2 })],
        expected: [],
      })
    );
    const [row] = await listRoundScores(eventId);
    expect(row.bonuses).toEqual({ "Sub-0.5 answer": 2 });
    // And the ranking pays it twice: 4 + 2 × 2.
    expect(rankRounds(SIX, [row])[0].total).toBe(8);
  });

  it("corrects a round by saving it again, and the ranking follows (4a)", async () => {
    const { eventId, members } = await scoredNight(2);
    const [alice, bob] = members;
    unwrap(
      await saveRoundAction(eventId, {
        roundIndex: 1,
        entries: [line(alice, 10), line(bob, 8)],
        expected: [],
      })
    );
    expect(rankRounds(SIX, await listRoundScores(eventId)).map((rank) => rank.userId)).toEqual([
      alice,
      bob,
    ]);

    // The typo: Bob scored 18, not 8. The corrected round replaces the old one.
    const saved = unwrap(
      await saveRoundAction(eventId, {
        roundIndex: 1,
        entries: [line(alice, 10), line(bob, 18)],
        expected: await loaded(eventId, 1),
      })
    );
    expect(saved.replaced).toBe(2);
    const rows = await listRoundScores(eventId);
    expect(rows.length).toBe(2);
    expect(rows.find((row) => row.userId === bob)!.score).toBe(18);
    expect(rankRounds(SIX, rows).map((rank) => rank.userId)).toEqual([bob, alice]);
  });

  it("replaces the whole round, so a player blanked on the correction loses their row", async () => {
    const { eventId, members } = await scoredNight(2);
    const [alice, bob] = members;
    unwrap(
      await saveRoundAction(eventId, {
        roundIndex: 3,
        entries: [line(alice, 10), line(bob, 8)],
        expected: [],
      })
    );
    unwrap(
      await saveRoundAction(eventId, {
        roundIndex: 3,
        entries: [line(alice, 10), line(bob, null)],
        expected: await loaded(eventId, 3),
      })
    );
    expect((await listRoundScores(eventId)).map((row) => row.userId)).toEqual([alice]);
  });

  it("leaves the other rounds exactly as they were", async () => {
    const { eventId, members } = await scoredNight(2);
    const [alice, bob] = members;
    unwrap(
      await saveRoundAction(eventId, {
        roundIndex: 1,
        entries: [line(alice, 10, { "Gold run": 1 }), line(bob, 8)],
        expected: [],
      })
    );
    const roundOne = await loaded(eventId, 1);
    unwrap(
      await saveRoundAction(eventId, { roundIndex: 2, entries: [line(bob, 3)], expected: [] })
    );
    expect(await loaded(eventId, 1)).toEqual(roundOne);
  });

  it("logs every save, naming who and which round", async () => {
    const { eventId, title, members, host } = await scoredNight(2);
    const [alice, bob] = members;
    unwrap(
      await saveRoundAction(eventId, {
        roundIndex: 6,
        entries: [line(alice, 10, { "Gold run": 1, "Sub-0.5 answer": 2 }), line(bob, 8)],
        expected: [],
      })
    );
    unwrap(
      await saveRoundAction(eventId, {
        roundIndex: 6,
        entries: [line(alice, 11), line(bob, 8)],
        expected: await loaded(eventId, 6),
      })
    );

    const lines = await db
      .select({ summary: auditLog.summary, actorUserId: auditLog.actorUserId, subject: auditLog.subject })
      .from(auditLog)
      .where(and(eq(auditLog.eventId, eventId), eq(auditLog.action, "result.round")))
      .orderBy(auditLog.at, auditLog.id);
    expect(lines.length).toBe(2);
    expect(lines[0].actorUserId).toBe(host);
    expect(lines[0].summary).toBe(`Scored Final of "${title}": 2 players and 3 awards.`);
    expect(lines[1].summary).toBe(`Re-scored Final of "${title}": 2 players and no awards.`);
    expect(lines[0].subject).toBe("round-6");
    // The vocabulary knows the action, so the log shows a heading and not the raw string.
    expect(AUDIT_ACTIONS["result.round"]).toBe("Round scored");
  });
});

/* --------------------------------------------------------------------- */
/* What it refuses, writing nothing (UC-45 3c, 3d, 3e, 4c)               */
/* --------------------------------------------------------------------- */

describe("what the save refuses", () => {
  it("refuses a bonus awarded to a blank player, naming them, and writes nothing (3c)", async () => {
    const { eventId, members, names } = await scoredNight(2);
    const [alice, bob] = members;
    unwrap(
      await saveRoundAction(eventId, { roundIndex: 1, entries: [line(alice, 5)], expected: [] })
    );
    const before = await listRoundScores(eventId);

    const said = refusal(
      await saveRoundAction(eventId, {
        roundIndex: 1,
        entries: [line(alice, 6), line(bob, null, { "Gold run": 1 })],
        expected: before,
      })
    );
    expect(said).toBe(
      `${names[bob]} was left blank for Round 1 but given "Gold run". Somebody who did not play a round cannot have earned anything in it.`
    );
    expect(said).not.toContain("whole number");
    // Alice's 6 did not land either: the round is one write or none.
    expect(await listRoundScores(eventId)).toEqual(before);
  });

  it("refuses a score that is not a whole number, naming the player (3d)", async () => {
    const { eventId, members, names } = await scoredNight(2);
    const [alice, bob] = members;
    const said = refusal(
      await saveRoundAction(eventId, {
        roundIndex: 1,
        entries: [line(alice, 5), line(bob, 7.5)],
        expected: [],
      })
    );
    expect(said).toBe(
      `${names[bob]}'s score has to be a whole number. A fraction of a second is a bonus, not a score.`
    );
    expect(said).not.toContain("left blank");
    expect(await listRoundScores(eventId)).toEqual([]);
  });

  it("refuses somebody who holds no seat, naming them and pointing at Applicants (3e)", async () => {
    const { eventId, members } = await scoredNight(1);
    const stranger = await makeUser(db, { displayName: "Walk-in" });
    const said = refusal(
      await saveRoundAction(eventId, {
        roundIndex: 1,
        entries: [line(members[0], 5), line(stranger, 9)],
        expected: [],
      })
    );
    expect(said).toBe(
      "Walk-in holds no seat in this event, so they cannot be scored. Accept them on Applicants first."
    );
    expect(await listRoundScores(eventId)).toEqual([]);
  });

  it("refuses a waitlisted applicant too — a seat is accepted, not applied for", async () => {
    const { eventId, members, names } = await scoredNight(1);
    const [alice] = members;
    const queued = await makeUser(db, { displayName: `Queued ${counter}` });
    unwrap(await applyToEvent(eventId, queued, {}, db));
    await db
      .update(applications)
      .set({ status: "waitlisted", waitlistPosition: 1 })
      .where(and(eq(applications.eventId, eventId), eq(applications.userId, queued)));

    const said = refusal(
      await saveRoundAction(eventId, {
        roundIndex: 1,
        entries: [line(alice, 5), line(queued, 9)],
        expected: [],
      })
    );
    expect(said).toContain(`Queued ${counter} holds no seat`);
    expect(said).not.toContain(names[alice]);
    expect(await listRoundScores(eventId)).toEqual([]);
  });

  it("still lets a recorded player be re-scored after they lost their seat", async () => {
    // `setPlacements`' rule: somebody who played and has since withdrawn still
    // played, and correcting one typo must not drop their row.
    const { eventId, members } = await scoredNight(2);
    const [alice, bob] = members;
    unwrap(
      await saveRoundAction(eventId, {
        roundIndex: 1,
        entries: [line(alice, 5), line(bob, 9)],
        expected: [],
      })
    );
    await db
      .update(applications)
      .set({ status: "withdrawn" })
      .where(and(eq(applications.eventId, eventId), eq(applications.userId, bob)));

    unwrap(
      await saveRoundAction(eventId, {
        roundIndex: 1,
        entries: [line(alice, 6), line(bob, 9)],
        expected: await loaded(eventId, 1),
      })
    );
    expect(byUser(await loaded(eventId, 1)).map((row) => [row.userId, row.score])).toEqual(
      byUser([
        { userId: alice, score: 6 },
        { userId: bob, score: 9 },
      ]).map((row) => [row.userId, row.score])
    );
  });

  it("refuses a bonus the setup does not define, and writes nothing", async () => {
    const { eventId, members, names } = await scoredNight(1);
    const said = refusal(
      await saveRoundAction(eventId, {
        roundIndex: 1,
        entries: [line(members[0], 5, { Clutch: 1 })],
        expected: [],
      })
    );
    expect(said).toBe(
      `${names[members[0]]} was given "Clutch", which is not one of this night's bonuses. Add it on the Scoring panel first.`
    );
    expect(await listRoundScores(eventId)).toEqual([]);
  });

  it("refuses a round the night does not have", async () => {
    const { eventId, members } = await scoredNight(1);
    expect(
      refusal(
        await saveRoundAction(eventId, { roundIndex: 7, entries: [line(members[0], 5)], expected: [] })
      )
    ).toBe("This night has 6 rounds, so there is no round 7 to score.");
    expect(await listRoundScores(eventId)).toEqual([]);
  });

  it("refuses a night that is not scored in rounds, pointing at the Scoring panel", async () => {
    const { eventId, members } = await scoredNight(1, null);
    expect(
      refusal(
        await saveRoundAction(eventId, { roundIndex: 1, entries: [line(members[0], 5)], expected: [] })
      )
    ).toBe("This night is not scored in rounds. Set that up on the Scoring panel first.");
    expect(await listRoundScores(eventId)).toEqual([]);
  });

  it("reads a score off the wire that is not a number as not a whole number, never as a zero", async () => {
    const { eventId, members, names } = await scoredNight(1);
    const said = refusal(
      await saveRoundAction(eventId, {
        roundIndex: 1,
        entries: [{ userId: members[0], score: "7" as unknown as number, bonuses: {} }],
        expected: [],
      })
    );
    expect(said).toBe(
      `${names[members[0]]}'s score has to be a whole number. A fraction of a second is a bonus, not a score.`
    );
    expect(await listRoundScores(eventId)).toEqual([]);
  });

  it("refuses something off the wire that is not a round at all", async () => {
    const { eventId } = await scoredNight(1);
    expect(
      refusal(
        await saveRoundAction(eventId, {
          roundIndex: 1,
          entries: "ten" as unknown as [],
          expected: [],
        })
      )
    ).toBe("That is not a round.");
    expect(
      refusal(
        await saveRoundAction(eventId, {
          roundIndex: 1,
          entries: [],
          expected: { a: 1 } as unknown as [],
        })
      )
    ).toBe("That is not a round.");
  });

  it("refuses a complete event with the one sentence every finished-event write uses (4c)", async () => {
    const { eventId, members } = await scoredNight(2);
    const [alice, bob] = members;
    unwrap(
      await saveRoundAction(eventId, {
        roundIndex: 1,
        entries: [line(alice, 5), line(bob, 9)],
        expected: [],
      })
    );
    const before = await listRoundScores(eventId);
    await db.update(events).set({ status: "complete" }).where(eq(events.id, eventId));

    const said = refusal(
      await saveRoundAction(eventId, {
        roundIndex: 1,
        entries: [line(alice, 50), line(bob, 9)],
        expected: before,
      })
    );
    expect(said).toBe(LOCKED_REFUSAL);
    expect(await listRoundScores(eventId)).toEqual(before);
  });
});

/* --------------------------------------------------------------------- */
/* Two managers saving one round (UC-45 4b)                              */
/* --------------------------------------------------------------------- */

describe("two managers saving one round", () => {
  it("one wins, and the loser is told the round moved and shown what is there now", async () => {
    const { eventId, members } = await scoredNight(3);
    const [alice, bob, cass] = members;

    // Both screens loaded round 1 empty. The other manager saves first, after
    // this one's reads and before this one's transaction opens.
    state.db = committingAfter(db, () =>
      saveRound(
        eventId,
        { roundIndex: 1, entries: [line(alice, 10, { "Gold run": 1 }), line(bob, 8)], expected: [] },
        db
      )
    );
    let result;
    try {
      result = await saveRoundAction(eventId, {
        roundIndex: 1,
        entries: [line(alice, 10), line(cass, 12)],
        expected: [],
      });
    } finally {
      state.db = db;
    }

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe(roundMovedRefusal("Round 1"));
    // What is there now — the winner's round, Gold run included.
    const winner = await loaded(eventId, 1);
    expect(result.moved).toEqual(winner);
    expect(byUser(winner).map((row) => [row.userId, row.score, row.bonuses])).toEqual(
      byUser([
        { userId: alice, score: 10, bonuses: { "Gold run": 1 } },
        { userId: bob, score: 8, bonuses: {} },
      ]).map((row) => [row.userId, row.score, row.bonuses])
    );
    // And the loser's Cass is nowhere.
    expect(winner.some((row) => row.userId === cass)).toBe(false);
  });

  it("goes through once the loser saves again from what they were shown", async () => {
    const { eventId, members } = await scoredNight(3);
    const [alice, bob, cass] = members;
    unwrap(await saveRound(eventId, { roundIndex: 1, entries: [line(alice, 10), line(bob, 8)], expected: [] }, db));

    const stale = await saveRoundAction(eventId, {
      roundIndex: 1,
      entries: [line(cass, 12)],
      expected: [],
    });
    if (stale.ok) throw new Error("expected the stale save to be refused");

    const saved = unwrap(
      await saveRoundAction(eventId, {
        roundIndex: 1,
        entries: [line(alice, 10), line(bob, 8), line(cass, 12)],
        expected: stale.moved!,
      })
    );
    expect(saved.rows.map((row) => row.userId).sort()).toEqual([alice, bob, cass].sort());
  });

  it("is not told the round moved when the other manager stored exactly what they saw", async () => {
    // Same content, whatever the order of rows or keys: nothing observable moved.
    const { eventId, members } = await scoredNight(2);
    const [alice, bob] = members;
    const same = [line(alice, 10, { "Gold run": 1, "Sub-0.5 answer": 1 }), line(bob, 8)];
    unwrap(await saveRound(eventId, { roundIndex: 1, entries: same, expected: [] }, db));

    const saved = unwrap(
      await saveRoundAction(eventId, {
        roundIndex: 1,
        entries: [line(bob, 9), line(alice, 10, { "Gold run": 1, "Sub-0.5 answer": 1 })],
        expected: [line(bob, 8) as never, { userId: alice, score: 10, bonuses: { "Sub-0.5 answer": 1, "Gold run": 1 } }],
      })
    );
    expect(saved.rows.find((row) => row.userId === bob)!.score).toBe(9);
  });

  it("is refused when a bonus arrived that the screen never saw, so a stale save cannot strip it", async () => {
    const { eventId, members } = await scoredNight(2);
    const [alice, bob] = members;
    unwrap(await saveRound(eventId, { roundIndex: 1, entries: [line(alice, 10), line(bob, 8)], expected: [] }, db));
    const seen = await loaded(eventId, 1);
    // Another manager awards Alice a Gold run.
    unwrap(
      await saveRound(
        eventId,
        { roundIndex: 1, entries: [line(alice, 10, { "Gold run": 1 }), line(bob, 8)], expected: seen },
        db
      )
    );

    const stale = await saveRoundAction(eventId, {
      roundIndex: 1,
      entries: [line(alice, 10), line(bob, 9)],
      expected: seen,
    });
    expect(stale.ok).toBe(false);
    expect((await loaded(eventId, 1)).find((row) => row.userId === alice)!.bonuses).toEqual({
      "Gold run": 1,
    });
  });
});

/* --------------------------------------------------------------------- */
/* Hiding a screen is not forbidding it (UC-42 5b)                       */
/* --------------------------------------------------------------------- */

describe("the action's own guard", () => {
  it("refuses a member and a stranger, whatever the editor draws", async () => {
    const { eventId, members, host } = await scoredNight(1);
    state.userId = members[0];
    await expect(
      saveRoundAction(eventId, { roundIndex: 1, entries: [line(members[0], 5)], expected: [] })
    ).rejects.toThrow(/NEXT_REDIRECT/);
    state.userId = null;
    await expect(
      saveRoundAction(eventId, { roundIndex: 1, entries: [line(members[0], 5)], expected: [] })
    ).rejects.toThrow(/NEXT_REDIRECT/);
    expect(await listRoundScores(eventId)).toEqual([]);
    state.userId = host;
  });
});
