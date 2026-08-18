import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, events, users } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  awardLot,
  openLot,
  placeBid,
  setCaptains,
  setDraftPool,
  setTeams,
} from "@/lib/draft";
import { applyToEvent, createEvent, publishEvent, setApplicationStatus } from "@/lib/events";
import {
  formatFor,
  generateMatches,
  matchIdsFor,
  recordGames,
  setStages,
} from "@/lib/format";
import {
  displayNamesFor,
  ensureHandles,
  getPlayerByHandle,
  getPlayerProfile,
  handleBase,
  handleOf,
} from "@/lib/players";

/**
 * Public player profiles (§4).
 *
 * Two things are being pinned here. The first is that a handle is *stable and
 * unique*: unique because two members called `beko` cannot both hold the same
 * URL, and stable because a handle that followed a Discord rename would break
 * every link that had ever been posted.
 *
 * The second is what the page is allowed to show. There is a test below that
 * exists purely to fail if `applications.answers` ever reaches this module.
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

describe("the base handle", () => {
  it("slugs the Discord name", () => {
    expect(handleBase({ displayName: "Beko Lolek" })).toBe("beko-lolek");
    expect(handleBase({ displayName: "Café Nyx" })).toBe("cafe-nyx");
  });

  it("falls back to a word rather than a snowflake", () => {
    // A URL is a thing people read out, and an eighteen-digit number is not.
    expect(handleBase({ displayName: "🔥🔥🔥" })).toBe("player");
    expect(handleBase({ displayName: null, name: null })).toBe("player");
  });

  it("pushes the reserved words out of the way", () => {
    expect(handleBase({ displayName: "admin" })).toBe("admin-player");
    expect(handleBase({ displayName: "Events" })).toBe("events-player");
  });
});

describe("assigning handles", () => {
  it("gives one to a member who has none, and links to it", async () => {
    const userId = await makeUser(db, { displayName: `Solo ${(counter += 1)}` });
    const handle = await handleOf(userId, db);
    expect(handle).toBe(`solo-${counter}`);
    expect((await getPlayerByHandle(handle as string, db))?.id).toBe(userId);
  });

  it("is idempotent — signing in twice does not renumber anybody", async () => {
    const userId = await makeUser(db, { displayName: `Twice ${(counter += 1)}` });
    const first = await handleOf(userId, db);
    const second = await handleOf(userId, db);
    const third = await ensureHandles([userId], db);
    expect(second).toBe(first);
    expect(third.get(userId)).toBe(first);
  });

  it("never recomputes after a rename, so old links keep working", async () => {
    const userId = await makeUser(db, { displayName: `Before ${(counter += 1)}` });
    const original = await handleOf(userId, db);

    await db.update(users).set({ displayName: "Something Else" }).where(eq(users.id, userId));

    expect(await handleOf(userId, db)).toBe(original);
    expect((await getPlayerByHandle(original as string, db))?.id).toBe(userId);
  });

  it("disambiguates two members with the same name", async () => {
    counter += 1;
    const a = await makeUser(db, { displayName: `Clash ${counter}` });
    const b = await makeUser(db, { displayName: `Clash ${counter}` });
    const c = await makeUser(db, { displayName: `clash ${counter}` });

    const handles = await ensureHandles([a, b, c], db);
    const all = [handles.get(a), handles.get(b), handles.get(c)];

    expect(new Set(all).size).toBe(3);
    expect(all).toContain(`clash-${counter}`);
    expect(all).toContain(`clash-${counter}-2`);
    expect(all).toContain(`clash-${counter}-3`);
  });

  it("assigns a whole batch in one call without colliding inside it", async () => {
    counter += 1;
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(await makeUser(db, { displayName: `Batch ${counter}` }));
    }
    const handles = await ensureHandles(ids, db);
    expect(new Set(handles.values()).size).toBe(5);
  });

  it("says nothing about an unknown handle rather than throwing", async () => {
    expect(await getPlayerByHandle("nobody-has-this", db)).toBeNull();
    expect(await getPlayerByHandle("   ", db)).toBeNull();
  });

  it("looks a handle up case-insensitively, because URLs get retyped", async () => {
    const userId = await makeUser(db, { displayName: `Case ${(counter += 1)}` });
    const handle = (await handleOf(userId, db)) as string;
    expect((await getPlayerByHandle(handle.toUpperCase(), db))?.id).toBe(userId);
  });
});

describe("display names", () => {
  it("come back keyed by id, with the nulls skipped", async () => {
    const userId = await makeUser(db, { displayName: "Named" });
    const names = await displayNamesFor([userId, null, undefined], db);
    expect(names.get(userId)).toBe("Named");
    expect(names.size).toBe(1);
  });

  it("is empty for an empty list, without a query", async () => {
    expect(await displayNamesFor([], db)).toEqual(new Map());
  });
});

/** A played event with one drafted player, one captain and a champion. */
async function playedEvent(): Promise<{
  eventId: string;
  captain: string;
  bought: string;
  spare: string;
  slug: string;
}> {
  counter += 1;
  const event = unwrap(await createEvent({ title: `Profile fixture ${counter}` }, db));
  unwrap(await publishEvent(event.id, db));

  const captain = await makeUser(db, { displayName: `Captain ${counter}` });
  const bought = await makeUser(db, { displayName: `Bought ${counter}` });
  const spare = await makeUser(db, { displayName: `Spare ${counter}` });
  for (const userId of [captain, bought, spare]) {
    unwrap(await applyToEvent(event.id, userId, {}, db));
  }

  const teams = unwrap(await setTeams(event.id, [{ name: "Red" }, { name: "Blue" }], db)).teams;
  unwrap(await setCaptains(event.id, [{ teamId: teams[0].id, userId: captain }], db));

  unwrap(await setDraftPool(event.id, { userIds: [bought] }, db));
  const lot = unwrap(await openLot(event.id, { userId: bought }, db));
  unwrap(await placeBid(lot.id, teams[0].id, 320, {}, db));
  unwrap(await awardLot(lot.id, teams[0].id, {}, db));

  const stages = unwrap(await setStages(event.id, [{ kind: "single_elim" }], db));
  unwrap(await generateMatches(stages[0].id, db));

  // Play the whole (one-match) bracket so somebody is champion.
  const ids = await matchIdsFor(event.id, db);
  const view = await formatFor(event.id, db);
  for (const match of view?.stages.flatMap((stage) => stage.matches) ?? []) {
    const id = ids[match.slot];
    if (!id || !match.teamAId || !match.teamBId) continue;
    unwrap(
      await recordGames(
        id,
        match.games.map((_, index) => ({ index, scoreA: 1, scoreB: 0, played: true })),
        {},
        db
      )
    );
  }

  await db.update(events).set({ status: "complete" }).where(eq(events.id, event.id));

  return { eventId: event.id, captain, bought, spare, slug: event.slug };
}

describe("the profile", () => {
  it("lists the events, the team and what they went for", async () => {
    const fixture = await playedEvent();
    const [user] = await db.select().from(users).where(eq(users.id, fixture.bought));
    const profile = await getPlayerProfile(user, db);

    expect(profile.entries).toHaveLength(1);
    const [entry] = profile.entries;
    expect(entry.event.slug).toBe(fixture.slug);
    expect(entry.team?.name).toBe("Red");
    expect(entry.price).toBe(320);
    expect(entry.isCaptain).toBe(false);
    expect(profile.totals.spent).toBe(320);
    expect(profile.totals.top).toBe(320);
    expect(profile.totals.drafted).toBe(1);
  });

  it("gives a captain no price, because they were never bid for", async () => {
    const fixture = await playedEvent();
    const [user] = await db.select().from(users).where(eq(users.id, fixture.captain));
    const profile = await getPlayerProfile(user, db);

    const [entry] = profile.entries;
    expect(entry.isCaptain).toBe(true);
    // §14 gives a captain a roster row at zero. Zero is not a price.
    expect(entry.price).toBeNull();
    expect(profile.totals.drafted).toBe(0);
    expect(profile.totals.captained).toBe(1);
  });

  it("records what they won", async () => {
    const fixture = await playedEvent();
    const [user] = await db.select().from(users).where(eq(users.id, fixture.captain));
    const profile = await getPlayerProfile(user, db);

    expect(profile.entries[0].placement?.position).toBe(1);
    expect(profile.entries[0].won).toBe(true);
    expect(profile.totals.won).toBe(1);
    expect(profile.totals.podiums).toBe(1);
  });

  it("lists an accepted member with no team at all", async () => {
    const fixture = await playedEvent();
    const [user] = await db.select().from(users).where(eq(users.id, fixture.spare));
    const profile = await getPlayerProfile(user, db);

    expect(profile.entries).toHaveLength(1);
    expect(profile.entries[0].team).toBeNull();
    expect(profile.entries[0].price).toBeNull();
    expect(profile.totals.teams).toBe(0);
  });

  it("is empty, not broken, for somebody who has done nothing", async () => {
    const userId = await makeUser(db, { displayName: `Newcomer ${(counter += 1)}` });
    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const profile = await getPlayerProfile(user, db);

    expect(profile.entries).toEqual([]);
    expect(profile.totals).toEqual({
      events: 0,
      teams: 0,
      drafted: 0,
      spent: 0,
      top: 0,
      captained: 0,
      won: 0,
      podiums: 0,
    });
    expect(profile.handle).toBeTruthy();
  });
});

describe("what the profile refuses to show", () => {
  it("never lists a draft event, so it cannot leak that one is being planned", async () => {
    counter += 1;
    const draft = unwrap(await createEvent({ title: `Secret ${counter}` }, db));
    const userId = await makeUser(db, { displayName: `Insider ${counter}` });

    // An accepted application on an unpublished event — the admin's own test
    // run, or an event that was published and pulled back to draft.
    unwrap(await publishEvent(draft.id, db));
    unwrap(await applyToEvent(draft.id, userId, {}, db));
    await db.update(events).set({ status: "draft" }).where(eq(events.id, draft.id));

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const profile = await getPlayerProfile(user, db);
    expect(profile.entries).toHaveLength(0);
  });

  it("never lists an event somebody was declined from or withdrew from", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ title: `Turned down ${counter}` }, db));
    unwrap(await publishEvent(event.id, db));

    const userId = await makeUser(db, { displayName: `Declined ${counter}` });
    const applied = unwrap(await applyToEvent(event.id, userId, {}, db));
    unwrap(await setApplicationStatus(applied.id, "declined", {}, db));

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    expect((await getPlayerProfile(user, db)).entries).toHaveLength(0);
  });

  it("carries no application answers anywhere in its shape", async () => {
    // Profile *answers* are for applications, not for display. This asserts on
    // the whole serialised profile rather than on a field, so it fails if an
    // answer ever arrives by a route nobody thought of.
    counter += 1;
    const event = unwrap(await createEvent({ title: `Answers ${counter}` }, db));
    unwrap(await publishEvent(event.id, db));
    const questions = unwrap(
      await (
        await import("@/lib/events")
      ).setEventQuestions(
        event.id,
        [{ label: "Anything else?", type: "text", options: [], required: false }],
        db
      )
    ).questions;

    const userId = await makeUser(db, { displayName: `Wrote ${counter}` });
    unwrap(
      await applyToEvent(
        event.id,
        userId,
        { answers: { [questions[0].id]: "my phone number is 07…" } },
        db
      )
    );

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    const profile = await getPlayerProfile(user, db);

    expect(profile.entries).toHaveLength(1);
    expect(JSON.stringify(profile)).not.toContain("my phone number");
    expect(JSON.stringify(profile)).not.toContain("Anything else?");
  });
});
