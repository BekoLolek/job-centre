import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, games, profileFields } from "@/db";
import { type TestDatabase, freshDatabase } from "@/db/__tests__/helpers";
import { RIVALS_RANK_LADDER } from "@/db/seed";
import {
  type EventResult,
  createEvent,
  getEventById,
  setEventQuestions,
  setEventDays,
  updateEvent,
} from "@/lib/events";
import { blockers, gaps, readiness } from "../readiness";

/**
 * The Publish tab's checklist.
 *
 * Driven through real events rather than hand-built view models: the whole
 * value of the checklist is that it agrees with what `getEventById` actually
 * returns, and a literal fixture is exactly the thing that stops agreeing.
 */

let harness: TestDatabase;
let db: Database;
let rivalsId: string;
let jackboxId: string;
let rankFieldId: string;

let counter = 0;

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;

  const [rivals] = await db
    .insert(games)
    .values({ key: "rivals", name: "Marvel Rivals", rankLadder: [...RIVALS_RANK_LADDER] })
    .returning({ id: games.id });
  rivalsId = rivals.id;

  const [jackbox] = await db
    .insert(games)
    .values({ key: "jackbox", name: "Jackbox", rankLadder: [] })
    .returning({ id: games.id });
  jackboxId = jackbox.id;

  const [rank] = await db
    .insert(profileFields)
    .values({ gameId: rivalsId, key: "rank", label: "Rank", type: "rank", sort: 0 })
    .returning({ id: profileFields.id });
  rankFieldId = rank.id;
});

afterAll(async () => {
  await harness.close();
});

function expectOk<T>(result: EventResult<T>): T {
  if (!result.ok) throw new Error(`Expected success, got: ${result.error}`);
  return result.data;
}

const DAY = 86_400_000;
const NOW = new Date("2026-06-01T12:00:00Z");
const at = (offsetDays: number) => new Date(NOW.getTime() + offsetDays * DAY);

/** An event that passes everything, so each test can spoil exactly one thing. */
async function healthyEvent(over: Parameters<typeof createEvent>[0] = { title: "x" }) {
  counter += 1;
  const event = expectOk(
    await createEvent(
      {
        gameId: rivalsId,
        capacity: 8,
        signupOpensAt: at(1),
        signupClosesAt: at(6),
        startsAt: at(7),
        ...over,
        title: `${over.title || "Readiness"} ${counter}`,
      },
      db
    )
  );

  expectOk(await setEventDays(event.id, [{ startsAt: at(7), label: "Day one" }], db));
  expectOk(
    await setEventQuestions(
      event.id,
      [{ label: "Your rank", type: "rank", profileFieldId: rankFieldId }],
      db
    )
  );
  return event.id;
}

const levelOf = (checks: ReturnType<typeof readiness>, key: string) =>
  checks.find((check) => check.key === key)?.level;

const detailOf = (checks: ReturnType<typeof readiness>, key: string) =>
  checks.find((check) => check.key === key)?.detail ?? "";

async function checksFor(eventId: string) {
  const event = await getEventById(eventId, { now: NOW }, db);
  if (!event) throw new Error("event vanished");
  return readiness(event);
}

describe("readiness", () => {
  it("passes a fully-filled event with nothing blocking and nothing to warn about", async () => {
    const checks = await checksFor(await healthyEvent());

    expect(blockers(checks)).toEqual([]);
    expect(gaps(checks)).toEqual([]);
    expect(levelOf(checks, "title")).toBe("ok");
    expect(levelOf(checks, "days")).toBe("ok");
    expect(levelOf(checks, "questions")).toBe("ok");
    expect(levelOf(checks, "capacity")).toBe("ok");
    expect(levelOf(checks, "window")).toBe("ok");
    expect(levelOf(checks, "rules")).toBe("ok");
  });

  it("counts the prefilled questions, because that is the point of the profile", async () => {
    const checks = await checksFor(await healthyEvent());
    expect(detailOf(checks, "questions")).toMatch(/1 of them prefill/);
  });

  it("says so when nothing prefills", async () => {
    const eventId = await healthyEvent();
    expectOk(
      await setEventQuestions(eventId, [{ label: "Anything else?", type: "text" }], db)
    );

    expect(detailOf(await checksFor(eventId), "questions")).toMatch(/None of them prefill/);
  });

  it("warns — but does not block — an event with no days and no questions", async () => {
    const eventId = await healthyEvent();
    expectOk(await setEventDays(eventId, [], db));
    expectOk(await setEventQuestions(eventId, [], db));

    const checks = await checksFor(eventId);
    expect(levelOf(checks, "days")).toBe("warn");
    expect(levelOf(checks, "questions")).toBe("warn");
    // Neither is a rule the rest of the system has, so neither stops publishing.
    expect(blockers(checks)).toEqual([]);
  });

  it("treats an uncapped event as a gap rather than a fault", async () => {
    const eventId = await healthyEvent();
    expectOk(await updateEvent(eventId, { capacity: null }, db));

    const checks = await checksFor(eventId);
    expect(levelOf(checks, "capacity")).toBe("warn");
    expect(detailOf(checks, "capacity")).toMatch(/never a waitlist/);
    expect(blockers(checks)).toEqual([]);
  });

  it("mentions the waitlist being switched off", async () => {
    const eventId = await healthyEvent();
    expectOk(await updateEvent(eventId, { config: { waitlist: false } }, db));

    expect(detailOf(await checksFor(eventId), "capacity")).toMatch(/closes once they are gone/);
  });

  it("warns about a missing start date, since applications would never close", async () => {
    const eventId = await healthyEvent();
    expectOk(await updateEvent(eventId, { startsAt: null, signupOpensAt: null }, db));

    const checks = await checksFor(eventId);
    expect(levelOf(checks, "window")).toBe("warn");
    expect(detailOf(checks, "window")).toMatch(/never close on their own/);
  });

  it("blocks a signup window that closes before it opens", async () => {
    // `updateEvent` refuses this combination, so reach past it — the checklist
    // has to survive a row that got into that state some other way.
    const eventId = await healthyEvent();
    const { events } = await import("@/db");
    const { eq } = await import("drizzle-orm");
    await db
      .update(events)
      .set({ signupOpensAt: at(6), signupClosesAt: at(2) })
      .where(eq(events.id, eventId));

    const checks = await checksFor(eventId);
    expect(levelOf(checks, "window")).toBe("stop");
    expect(blockers(checks).map((check) => check.key)).toEqual(["window"]);
  });

  it("reports valid rank thresholds and names them", async () => {
    const eventId = await healthyEvent();
    expectOk(
      await updateEvent(
        eventId,
        { minRankToEnter: "Platinum III", minRankToCaptain: "Diamond II" },
        db
      )
    );

    const checks = await checksFor(eventId);
    expect(levelOf(checks, "rules")).toBe("ok");
    expect(detailOf(checks, "rules")).toBe("Platinum III to enter · Diamond II to captain");
  });

  it("warns when a threshold has fallen out of the ladder", async () => {
    const eventId = await healthyEvent();
    expectOk(await updateEvent(eventId, { minRankToEnter: "Platinum III" }, db));

    // The admin shortens the ladder afterwards, which is the realistic accident.
    const { eq } = await import("drizzle-orm");
    await db
      .update(games)
      .set({ rankLadder: ["Bronze III", "Bronze II", "Bronze I"] })
      .where(eq(games.id, rivalsId));

    const checks = await checksFor(eventId);
    expect(levelOf(checks, "rules")).toBe("warn");
    expect(detailOf(checks, "rules")).toMatch(/not enforced/);
    // Never a blocker: locking everyone out because an admin renamed a rank
    // would be the worst of the available behaviours.
    expect(blockers(checks)).toEqual([]);

    await db
      .update(games)
      .set({ rankLadder: [...RIVALS_RANK_LADDER] })
      .where(eq(games.id, rivalsId));
  });

  it("warns about a rank question on a game with no ladder", async () => {
    counter += 1;
    // Jackbox has no ladder, so the question has to be created against Rivals
    // and the event moved — which is exactly how this state arises in practice.
    const eventId = await healthyEvent();
    expectOk(await updateEvent(eventId, { gameId: jackboxId }, db));

    const checks = await checksFor(eventId);
    expect(levelOf(checks, "rank-questions")).toBe("warn");
    expect(detailOf(checks, "rank-questions")).toMatch(/nothing to pick/);
  });

  it("says a game-less event with thresholds will not enforce them", async () => {
    const eventId = await healthyEvent();
    expectOk(await updateEvent(eventId, { minRankToEnter: "Platinum III" }, db));

    // `updateEvent` will not let an admin drop the game while a threshold is
    // set — but `events.game_id` is `on delete set null`, so deleting the game
    // produces exactly this row. The checklist has to describe it rather than
    // pretend it cannot happen.
    const { events } = await import("@/db");
    const { eq } = await import("drizzle-orm");
    await db.update(events).set({ gameId: null }).where(eq(events.id, eventId));

    const checks = await checksFor(eventId);
    expect(levelOf(checks, "rules")).toBe("warn");
    expect(detailOf(checks, "rules")).toMatch(/will not be enforced/i);
  });

  it("says there is no rank requirement when there is none", async () => {
    const checks = await checksFor(await healthyEvent());
    expect(detailOf(checks, "rules")).toMatch(/Anybody can enter/);
  });
});
