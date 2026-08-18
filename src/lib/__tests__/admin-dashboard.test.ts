import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, events } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { loadDashboard } from "@/lib/admin-dashboard";
import { openLot, setCaptains, setDraftPool, setTeams } from "@/lib/draft";
import {
  applyToEvent,
  createEvent,
  publishEvent,
  setApplicationStatus,
  updateEvent,
} from "@/lib/events";
import { generateMatches, setStages } from "@/lib/format";

/**
 * `/admin` — what needs attention (§4).
 *
 * Every assertion here is really the same one: **the line disappears when the
 * thing is done**. That is the property that decides whether an admin trusts
 * the page, and it is only true because nothing is stored — there is no
 * `needs_attention` column, and this file is what would fail if somebody added
 * one.
 */

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;
});

afterAll(async () => {
  await harness.close();
});

let counter = 0;

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/** Only this event's lines — the suite shares one database. */
async function itemsFor(eventId: string) {
  const view = await loadDashboard({}, db);
  return view.items.filter((item) => item.event.id === eventId);
}

describe("applications waiting", () => {
  it("appears for somebody the cap queued and nobody has looked at", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ title: `Queue ${counter}` }, db));
    unwrap(await updateEvent(event.id, { capacity: 1 }, db));
    unwrap(await publishEvent(event.id, db));

    const first = await makeUser(db, { displayName: `In ${counter}` });
    const second = await makeUser(db, { displayName: `Queued ${counter}` });
    unwrap(await applyToEvent(event.id, first, {}, db));
    const queued = unwrap(await applyToEvent(event.id, second, {}, db));
    expect(queued.status).toBe("waitlisted");

    const [item] = (await itemsFor(event.id)).filter((row) => row.kind === "applications");
    expect(item.label).toContain("1 applicant is waiting");
    expect(item.href).toBe(`/admin/events/${event.id}?tab=applicants`);

    // Deciding it makes the line go away. Nothing was marked done.
    unwrap(await setApplicationStatus(queued.id, "declined", {}, db));
    expect((await itemsFor(event.id)).filter((row) => row.kind === "applications")).toEqual([]);
  });
});

describe("ready to publish", () => {
  it("says so for a draft with nothing stopping it, and links to the tab", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ title: `Draft ${counter}` }, db));

    const [item] = (await itemsFor(event.id)).filter((row) => row.kind === "publish");
    expect(item.label).toBe("Ready to publish");
    expect(item.href).toBe(`/admin/events/${event.id}?tab=publish`);
  });

  it("counts what is stopping it instead, when something is", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ title: `Blocked ${counter}` }, db));

    // Signups that close before they open: nobody could ever apply. Written
    // straight to the row on purpose — `updateEvent` refuses this pair outright,
    // so the only way to hold it is to have been written by something that did
    // not, which is exactly the state a publish checklist is for.
    await db
      .update(events)
      .set({
        signupOpensAt: new Date("2026-03-10T18:00:00Z"),
        signupClosesAt: new Date("2026-03-01T18:00:00Z"),
      })
      .where(eq(events.id, event.id));

    const [item] = (await itemsFor(event.id)).filter((row) => row.kind === "publish");
    expect(item.label).toContain("to fix before it can be published");
    expect(item.action).toBe("Fix them");
  });

  it("stops mentioning publishing once the event is published", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ title: `Published ${counter}` }, db));
    unwrap(await publishEvent(event.id, db));
    expect((await itemsFor(event.id)).filter((row) => row.kind === "publish")).toEqual([]);
  });
});

describe("captains", () => {
  it("counts the teams without one, and clears when they are chosen", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ title: `Captains ${counter}` }, db));
    unwrap(await publishEvent(event.id, db));

    const captain = await makeUser(db, { displayName: `Cap ${counter}` });
    unwrap(await applyToEvent(event.id, captain, {}, db));
    const teams = unwrap(await setTeams(event.id, [{ name: "Red" }, { name: "Blue" }], db)).teams;

    const [item] = (await itemsFor(event.id)).filter((row) => row.kind === "captains");
    expect(item.label).toBe("2 of 2 teams without a captain");
    expect(item.href).toBe(`/admin/events/${event.id}?tab=captains`);

    unwrap(await setCaptains(event.id, [{ teamId: teams[0].id, userId: captain }], db));
    const [after] = (await itemsFor(event.id)).filter((row) => row.kind === "captains");
    expect(after.label).toBe("1 of 2 teams without a captain");
  });
});

describe("a lot on the block", () => {
  it("is flagged as blocking, and points at the room rather than the editor", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ title: `Lot ${counter}` }, db));
    unwrap(await publishEvent(event.id, db));

    const captain = await makeUser(db, { displayName: `Cap ${counter}` });
    const player = await makeUser(db, { displayName: `Player ${counter}` });
    for (const userId of [captain, player]) {
      unwrap(await applyToEvent(event.id, userId, {}, db));
    }
    const teams = unwrap(await setTeams(event.id, [{ name: "Red" }, { name: "Blue" }], db)).teams;
    unwrap(await setCaptains(event.id, [{ teamId: teams[0].id, userId: captain }], db));
    unwrap(await setDraftPool(event.id, { userIds: [player] }, db));
    unwrap(await openLot(event.id, { userId: player }, db));

    const [item] = (await itemsFor(event.id)).filter((row) => row.kind === "lot_open");
    expect(item.tone).toBe("ember");
    const [row] = await db.select({ slug: events.slug }).from(events).where(eq(events.id, event.id));
    expect(item.href).toBe(`/events/${row.slug}/draft`);
  });
});

describe("the board", () => {
  it("counts matches with no time only once a bracket has been generated", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ title: `Board ${counter}` }, db));
    unwrap(await publishEvent(event.id, db));

    const captains = [
      await makeUser(db, { displayName: `A ${counter}` }),
      await makeUser(db, { displayName: `B ${counter}` }),
    ];
    for (const userId of captains) unwrap(await applyToEvent(event.id, userId, {}, db));
    const teams = unwrap(await setTeams(event.id, [{ name: "Red" }, { name: "Blue" }], db)).teams;
    unwrap(
      await setCaptains(
        event.id,
        teams.map((team, index) => ({ teamId: team.id, userId: captains[index] })),
        db
      )
    );

    // A stage with no rows resolves a whole bracket on read. Counting *that*
    // would put "1 match has no time" on an event nobody has generated yet.
    unwrap(await setStages(event.id, [{ kind: "single_elim" }], db));
    expect((await itemsFor(event.id)).filter((row) => row.kind === "unscheduled")).toEqual([]);

    const stages = unwrap(await setStages(event.id, [{ kind: "single_elim" }], db));
    unwrap(await generateMatches(stages[0].id, db));

    const [item] = (await itemsFor(event.id)).filter((row) => row.kind === "unscheduled");
    expect(item.count).toBeGreaterThan(0);
    expect(item.href).toBe(`/admin/events/${event.id}?tab=schedule`);
  });
});

describe("a finished event", () => {
  it("never appears, because nothing about it can need doing", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ title: `Over ${counter}` }, db));
    unwrap(await updateEvent(event.id, { capacity: 1 }, db));
    unwrap(await publishEvent(event.id, db));

    const first = await makeUser(db, { displayName: `In ${counter}` });
    const second = await makeUser(db, { displayName: `Queued ${counter}` });
    unwrap(await applyToEvent(event.id, first, {}, db));
    unwrap(await applyToEvent(event.id, second, {}, db));
    expect((await itemsFor(event.id)).length).toBeGreaterThan(0);

    await db.update(events).set({ status: "complete" }).where(eq(events.id, event.id));
    expect(await itemsFor(event.id)).toEqual([]);
  });
});

describe("the ordering", () => {
  it("puts what is blocking the night above what is merely due", async () => {
    const view = await loadDashboard({}, db);
    const tones = view.items.map((item) => item.tone);
    const lastEmber = tones.lastIndexOf("ember");
    const firstGold = tones.indexOf("gold");
    if (lastEmber !== -1 && firstGold !== -1) expect(lastEmber).toBeLessThan(firstGold);
  });

  it("gives every line a link and a word for the button", async () => {
    const view = await loadDashboard({}, db);
    expect(view.items.length).toBeGreaterThan(0);
    for (const item of view.items) {
      expect(item.href.startsWith("/")).toBe(true);
      expect(item.action.length).toBeGreaterThan(0);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.detail.length).toBeGreaterThan(0);
    }
  });
});
