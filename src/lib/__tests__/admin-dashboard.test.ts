import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, applications, events } from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { loadDashboard } from "@/lib/admin-dashboard";
import { recordAudit } from "@/lib/audit";
import { addCountingEvent, createChampionship } from "@/lib/championships";
import { setPlacements } from "@/lib/championship-results";
import { openLot, setCaptains, setDraftPool, setTeams } from "@/lib/draft";
import {
  applyToEvent,
  createEvent,
  publishEvent,
  setApplicationStatus,
  updateEvent,
} from "@/lib/events";
import { generateMatches, setStages } from "@/lib/format";
import { applyToHost, declineHostApplication } from "@/lib/hosting";

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
  return view.items.filter((item) => item.event?.id === eventId);
}

describe("applications waiting", () => {
  it("appears for somebody the cap queued and nobody has looked at", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Queue ${counter}` }, db));
    // Two seats — R-26's minimum — so it takes two applicants to fill them and
    // a third to be the one left waiting.
    unwrap(await updateEvent(event.id, { capacity: 2 }, db));
    unwrap(await publishEvent(event.id, db));

    const first = await makeUser(db, { displayName: `In ${counter}` });
    const alsoIn = await makeUser(db, { displayName: `Also in ${counter}` });
    const second = await makeUser(db, { displayName: `Queued ${counter}` });
    unwrap(await applyToEvent(event.id, first, {}, db));
    unwrap(await applyToEvent(event.id, alsoIn, {}, db));
    const queued = unwrap(await applyToEvent(event.id, second, {}, db));
    expect(queued.status).toBe("waitlisted");

    const [item] = (await itemsFor(event.id)).filter((row) => row.kind === "applications");
    expect(item.label).toContain("1 applicant is waiting");
    expect(item.href).toBe(`/admin/events/${event.id}?tab=applicants`);

    // Deciding it makes the line go away. Nothing was marked done.
    unwrap(await setApplicationStatus(queued.id, "declined", {}, db));
    expect((await itemsFor(event.id)).filter((row) => row.kind === "applications")).toEqual([]);
  });

  /**
   * The other pile, and the one the first version of this module left out.
   *
   * UC-27 2 and R-109 both say "pending applications". An approval event's
   * applications land `pending` (R-27 / UC-12 7b) and nothing but a manager's
   * decision moves them — no cap to promote them, no withdrawal to free a seat
   * — so if any application belongs on this page it is this one. The module's
   * own comment said it was deliberately missing and named this task.
   */
  it("appears for an approval event's applications nobody has decided (UC-27 2)", async () => {
    counter += 1;
    const event = unwrap(
      await createEvent(
        { ...PUBLISHABLE, title: `Approval ${counter}`, config: { entryMode: "approval" } },
        db
      )
    );
    unwrap(await publishEvent(event.id, db));

    const first = await makeUser(db, { displayName: `Hopeful ${counter}` });
    const second = await makeUser(db, { displayName: `Also hopeful ${counter}` });
    const one = unwrap(await applyToEvent(event.id, first, {}, db));
    unwrap(await applyToEvent(event.id, second, {}, db));
    expect(one.status).toBe("pending");

    const pending = () =>
      itemsFor(event.id).then((rows) =>
        rows.filter((row) => row.kind === "pending_applications")
      );

    const [item] = await pending();
    expect(item.label).toBe("2 applications need a decision");
    expect(item.count).toBe(2);
    expect(item.href).toBe(`/admin/events/${event.id}?tab=applicants`);
    expect(item.action).toBe("Decide them");
    // Nothing else resolves it, so it is blocking rather than merely due.
    expect(item.urgency).toBe("blocked");

    // Deciding one takes it off the count; deciding both takes the line away.
    unwrap(await setApplicationStatus(one.id, "accepted", {}, db));
    const [after] = await pending();
    expect(after.label).toBe("1 application needs a decision");

    const [other] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(and(eq(applications.eventId, event.id), eq(applications.status, "pending")));
    unwrap(await setApplicationStatus(other.id, "declined", {}, db));
    expect(await pending()).toEqual([]);
  });

  it("does not list a first-come event's seats as needing a decision", async () => {
    // The two piles are different work and must not be counted twice: a
    // first-come application decides itself on the way in (§14).
    counter += 1;
    const event = unwrap(
      await createEvent({ ...PUBLISHABLE, title: `First come ${counter}` }, db)
    );
    unwrap(await publishEvent(event.id, db));
    const member = await makeUser(db, { displayName: `Seated ${counter}` });
    expect(unwrap(await applyToEvent(event.id, member, {}, db)).status).toBe("accepted");

    expect(
      (await itemsFor(event.id)).filter((row) => row.kind === "pending_applications")
    ).toEqual([]);
  });
});

describe("ready to publish", () => {
  it("says so for a draft with nothing stopping it, and links to the tab", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Draft ${counter}` }, db));

    const [item] = (await itemsFor(event.id)).filter((row) => row.kind === "publish");
    expect(item.label).toBe("Ready to publish");
    expect(item.href).toBe(`/admin/events/${event.id}?tab=publish`);
  });

  it("counts what is stopping it instead, when something is", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Blocked ${counter}` }, db));

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
    const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Published ${counter}` }, db));
    unwrap(await publishEvent(event.id, db));
    expect((await itemsFor(event.id)).filter((row) => row.kind === "publish")).toEqual([]);
  });
});

describe("captains", () => {
  it("counts the teams without one, and clears when they are chosen", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Captains ${counter}` }, db));
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
    const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Lot ${counter}` }, db));
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
    expect(item.urgency).toBe("blocked");
    const [row] = await db.select({ slug: events.slug }).from(events).where(eq(events.id, event.id));
    expect(item.href).toBe(`/events/${row.slug}/draft`);
  });
});

describe("the board", () => {
  it("counts matches with no time only once a bracket has been generated", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Board ${counter}` }, db));
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

describe("an announcement that did not post", () => {
  /*
   * Stamped on a clock of their own, each later than the last. Whether a
   * webhook save hides a failure is tested through the real save action, in
   * `src/app/admin/settings/__tests__/settings.test.ts`.
   */
  let tick = 0;
  const later = () => new Date(Date.UTC(2030, 0, 1) + (tick += 1) * 60_000);

  async function failed(eventId: string | null) {
    await recordAudit(
      {
        action: "announcement.failed",
        summary: "The announcement did not go out — Discord answered 404.",
        eventId,
        now: later(),
      },
      db
    );
  }

  async function failuresFor(eventId: string | null) {
    const view = await loadDashboard({}, db);
    return view.items.filter(
      (item) => item.kind === "announcements" && (item.event?.id ?? null) === eventId
    );
  }

  async function publishedEvent(title: string) {
    counter += 1;
    const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `${title} ${counter}` }, db));
    unwrap(await publishEvent(event.id, db));
    return event;
  }

  it("appears under its event and links to that event's audit log", async () => {
    const event = await publishedEvent("Unheard");
    await failed(event.id);

    const [item] = await failuresFor(event.id);
    expect(item.label).toBe("1 announcement did not post");
    expect(item.href).toBe(`/admin/audit?event=${event.id}`);
  });

  it("still appears once the event is complete", async () => {
    const event = await publishedEvent("Finished");
    await failed(event.id);
    await db.update(events).set({ status: "complete" }).where(eq(events.id, event.id));

    expect(await failuresFor(event.id)).toHaveLength(1);
  });

  it("still appears more than a day later", async () => {
    const event = await publishedEvent("Old");
    await failed(event.id);

    const view = await loadDashboard({ now: new Date(Date.UTC(2030, 0, 5)) }, db);
    expect(view.items.filter((item) => item.kind === "announcements" && item.event?.id === event.id)).toHaveLength(1);
  });

  it("appears without an event, linking to the whole log", async () => {
    await failed(null);

    const [item] = await failuresFor(null);
    expect(item.href).toBe("/admin/audit");
  });
});

describe("a finished event", () => {
  it("never appears, because nothing about it can need doing", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Over ${counter}` }, db));
    unwrap(await updateEvent(event.id, { capacity: 2 }, db));
    unwrap(await publishEvent(event.id, db));

    const first = await makeUser(db, { displayName: `In ${counter}` });
    const alsoIn = await makeUser(db, { displayName: `Also in ${counter}` });
    const second = await makeUser(db, { displayName: `Queued ${counter}` });
    unwrap(await applyToEvent(event.id, first, {}, db));
    unwrap(await applyToEvent(event.id, alsoIn, {}, db));
    unwrap(await applyToEvent(event.id, second, {}, db));
    expect((await itemsFor(event.id)).length).toBeGreaterThan(0);

    await db.update(events).set({ status: "complete" }).where(eq(events.id, event.id));
    expect(await itemsFor(event.id)).toEqual([]);
  });
});

describe("a championship result nobody has recorded", () => {
  it("appears for an event that has been played, and goes once the order is in", async () => {
    // UC-33 5. The one item that deliberately looks past the active statuses:
    // the event whose result is most obviously missing is the one that
    // finished last night, and recording it is allowed on a complete event
    // (UC-33 1b) because the result belongs to the season, not to the event.
    counter += 1;
    const event = unwrap(
      await createEvent({ ...PUBLISHABLE, title: `Season night ${counter}` }, db)
    );
    unwrap(await publishEvent(event.id, db));
    const player = await makeUser(db, { displayName: `Racer ${counter}` });
    unwrap(await applyToEvent(event.id, player, {}, db));

    const season = unwrap(await createChampionship({ name: `Dashboard season ${counter}` }, db));
    unwrap(await addCountingEvent(season.id, event.id, db));
    await db.update(events).set({ status: "complete" }).where(eq(events.id, event.id));

    const [item] = (await itemsFor(event.id)).filter(
      (row) => row.kind === "championship_result"
    );
    expect(item.href).toBe(`/admin/events/${event.id}?tab=championship`);
    expect(item.detail).toContain(season.name);

    unwrap(await setPlacements(event.id, [{ id: player, position: 1 }], db));

    expect(
      (await itemsFor(event.id)).filter((row) => row.kind === "championship_result")
    ).toEqual([]);
  });
});

describe("a member waiting to hear about an event they want to run", () => {
  it("appears on the admin home while it is pending, and goes when it is decided", async () => {
    // R-109 / UC-27 2: the third thing the admin home has to show, next to
    // pending applications and unscheduled matches. It has no event — an
    // application is what exists before the event does.
    counter += 1;
    const applicant = await makeUser(db, { displayName: `Would-be host ${counter}` });
    const application = unwrap(
      await applyToHost(
        applicant,
        {
          title: `Friday REPO night ${counter}`,
          gameName: "REPO",
          summary: "Six of us, a few rounds, prizes for whoever survives longest.",
          playerInfoNeeded: "In-game name",
        },
        db
      )
    );

    const before = (await loadDashboard({}, db)).items.filter(
      (item) => item.kind === "host_applications"
    );
    expect(before).toHaveLength(1);
    expect(before[0].href).toBe("/admin/host");
    expect(before[0].event).toBeNull();
    expect(before[0].count).toBe(1);

    // Decided is decided: nothing is marked done, the count is just taken again.
    unwrap(
      await declineHostApplication(application.id, await makeUser(db), "Another time", db)
    );

    expect(
      (await loadDashboard({}, db)).items.filter((item) => item.kind === "host_applications")
    ).toEqual([]);
  });
});

describe("the admin home's extra attention items (UC-27 E1)", () => {
  /**
   * E1: "At step 2, System **also** lists events ready to publish, events with
   * teams missing captains, an open draft lot, and matches needing a winner."
   *
   * Each of those four has a test of its own above; this is the "also", which
   * is the part a line-by-line test cannot see — one event in a state that
   * deserves three of them at once, and all three reaching the admin rather
   * than the first one winning. The fourth (ready to publish) is mutually
   * exclusive with them by design: it only appears while the event is a draft,
   * and teams and a draft lot only exist once it is published, so it is
   * asserted beside them rather than among them.
   */
  it("lists captains, an open lot and a drawn series together, each with its own link", async () => {
    counter += 1;
    const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Everything ${counter}` }, db));

    // A draft event: "ready to publish" is E1's first item.
    expect(
      (await itemsFor(event.id)).map((item) => item.kind)
    ).toEqual(["publish"]);

    unwrap(await publishEvent(event.id, db));

    const captain = await makeUser(db, { displayName: `Cap ${counter}` });
    const player = await makeUser(db, { displayName: `Player ${counter}` });
    for (const userId of [captain, player]) {
      unwrap(await applyToEvent(event.id, userId, {}, db));
    }
    const teams = unwrap(await setTeams(event.id, [{ name: "Red" }, { name: "Blue" }], db)).teams;
    // One captain of two, so "missing captains" is true of the other.
    unwrap(await setCaptains(event.id, [{ teamId: teams[0].id, userId: captain }], db));
    unwrap(await setDraftPool(event.id, { userIds: [player] }, db));
    unwrap(await openLot(event.id, { userId: player }, db));

    const items = await itemsFor(event.id);
    const kinds = items.map((item) => item.kind);
    expect(kinds).toContain("captains");
    expect(kinds).toContain("lot_open");
    // Published, so publishing is no longer a decision anybody owes.
    expect(kinds).not.toContain("publish");

    // Every one of them is a decision with a screen behind it (§4), which is
    // what makes the list worth reading rather than a status board.
    for (const item of items) {
      expect(item.href.startsWith("/")).toBe(true);
      expect(item.event?.id).toBe(event.id);
    }
  });

  it("says nothing about an event in no state at all (UC-27 2a)", async () => {
    counter += 1;
    // Published, inside its sign-up window, nobody waiting, no teams, no
    // bracket: there is genuinely nothing to decide, and the page has to be
    // able to say so rather than inventing a line.
    const event = unwrap(await createEvent({ ...PUBLISHABLE, title: `Quiet ${counter}` }, db));
    unwrap(await publishEvent(event.id, db));
    expect(await itemsFor(event.id)).toEqual([]);
  });
});

describe("the ordering", () => {
  it("puts what is blocking the night above what is merely due", async () => {
    const view = await loadDashboard({}, db);
    const urgencies = view.items.map((item) => item.urgency);
    const lastBlocked = urgencies.lastIndexOf("blocked");
    const firstNext = urgencies.indexOf("next");
    if (lastBlocked !== -1 && firstNext !== -1) expect(lastBlocked).toBeLessThan(firstNext);
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
