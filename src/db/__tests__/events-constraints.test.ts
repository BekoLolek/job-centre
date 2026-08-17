import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applications,
  availability,
  confirmations,
  eventDays,
  eventQuestions,
  eventTemplates,
  events,
  games,
  profileFields,
  users,
} from "@/db";
import { type TestDatabase, expectRejection, freshDatabase, makeUser } from "./helpers";

/**
 * What Postgres itself guarantees about the Phase 2 tables.
 *
 * The application code in `src/lib/events.ts` maintains these invariants too,
 * and its own tests check that it does. These tests are the second line: if a
 * future change to that module gets the waitlist wrong, or an admin screen
 * writes a row directly, the database still refuses. Cascades are here for the
 * opposite reason — deleting an event must take its whole tree with it and
 * nothing else, and that is the kind of thing worth proving rather than
 * assuming from the schema declaration.
 */

let ctx: TestDatabase;

beforeAll(async () => {
  ctx = await freshDatabase();
});

afterAll(async () => {
  await ctx.close();
});

let counter = 0;

/** One event, with a unique slug per call. */
async function makeEvent(over: { capacity?: number | null; gameId?: string } = {}) {
  counter += 1;
  const [row] = await ctx.db
    .insert(events)
    .values({
      slug: `event-${counter}`,
      title: `Event ${counter}`,
      capacity: over.capacity ?? null,
      gameId: over.gameId ?? null,
    })
    .returning({ id: events.id });
  return row.id;
}

async function makeDay(eventId: string, dayIndex = 0) {
  const [row] = await ctx.db
    .insert(eventDays)
    .values({ eventId, dayIndex, label: `Day ${dayIndex + 1}` })
    .returning({ id: eventDays.id });
  return row.id;
}

async function makeApplication(
  eventId: string,
  userId: string,
  over: { status?: "accepted" | "waitlisted" | "declined" | "withdrawn"; waitlistPosition?: number } = {}
) {
  const [row] = await ctx.db
    .insert(applications)
    .values({
      eventId,
      userId,
      status: over.status ?? "accepted",
      waitlistPosition: over.waitlistPosition ?? null,
    })
    .returning({ id: applications.id });
  return row.id;
}

/* ------------------------------------------------------------------ */

describe("unique constraints", () => {
  it("stops two events sharing a slug", async () => {
    await ctx.db.insert(events).values({ slug: "rivals-cup", title: "Rivals Cup" });
    await expectRejection(
      () => ctx.db.insert(events).values({ slug: "rivals-cup", title: "Another cup" }),
      /events_slug_unique/
    );
  });

  it("stops one member applying to the same event twice", async () => {
    const eventId = await makeEvent();
    const userId = await makeUser(ctx.db);
    await makeApplication(eventId, userId);
    await expectRejection(
      () => makeApplication(eventId, userId),
      /applications_event_user_uniq/
    );
  });

  it("lets one member apply to two different events", async () => {
    const userId = await makeUser(ctx.db);
    await makeApplication(await makeEvent(), userId);
    await expect(makeApplication(await makeEvent(), userId)).resolves.toBeTruthy();
  });

  it("stops an event having two of the same day", async () => {
    const eventId = await makeEvent();
    await makeDay(eventId, 0);
    await expectRejection(() => makeDay(eventId, 0), /event_days_event_index_uniq/);
  });

  it("lets two events each have a day 0", async () => {
    await makeDay(await makeEvent(), 0);
    await expect(makeDay(await makeEvent(), 0)).resolves.toBeTruthy();
  });

  it("stops two questions on one event sharing a key", async () => {
    const eventId = await makeEvent();
    const question = { eventId, key: "role", label: "Role", type: "select" as const };
    await ctx.db.insert(eventQuestions).values(question);
    await expectRejection(
      () => ctx.db.insert(eventQuestions).values({ ...question, label: "Role again" }),
      /event_questions_event_key_uniq/
    );
  });

  it("stops one application answering the same day twice", async () => {
    const eventId = await makeEvent();
    const dayId = await makeDay(eventId);
    const applicationId = await makeApplication(eventId, await makeUser(ctx.db));

    await ctx.db.insert(availability).values({ applicationId, eventDayId: dayId, state: "yes" });
    await expectRejection(
      () =>
        ctx.db.insert(availability).values({ applicationId, eventDayId: dayId, state: "no" }),
      /availability_application_day_uniq/
    );
  });

  it("keeps confirmations to one per application", async () => {
    const eventId = await makeEvent();
    const applicationId = await makeApplication(eventId, await makeUser(ctx.db));

    await ctx.db.insert(confirmations).values({ applicationId, state: "in" });
    await expectRejection(
      () => ctx.db.insert(confirmations).values({ applicationId, state: "out" }),
      /confirmations_application_id_unique/
    );
  });

  it("stops two people holding the same place in one queue", async () => {
    const eventId = await makeEvent();
    await makeApplication(eventId, await makeUser(ctx.db), {
      status: "waitlisted",
      waitlistPosition: 1,
    });
    const rival = await makeUser(ctx.db);
    await expectRejection(
      () => makeApplication(eventId, rival, { status: "waitlisted", waitlistPosition: 1 }),
      /applications_waitlist_position_uniq/
    );
  });

  it("lets two events each have a first in the queue", async () => {
    const queued = { status: "waitlisted" as const, waitlistPosition: 1 };
    await makeApplication(await makeEvent(), await makeUser(ctx.db), queued);
    await expect(
      makeApplication(await makeEvent(), await makeUser(ctx.db), queued)
    ).resolves.toBeTruthy();
  });

  it("ignores stale positions on rows that are no longer queued", async () => {
    // The index is partial, so a withdrawn row keeping a number cannot block
    // the person who actually holds that place now.
    const eventId = await makeEvent();
    await makeApplication(eventId, await makeUser(ctx.db), {
      status: "withdrawn",
      waitlistPosition: 1,
    });
    await expect(
      makeApplication(eventId, await makeUser(ctx.db), {
        status: "waitlisted",
        waitlistPosition: 1,
      })
    ).resolves.toBeTruthy();
  });
});

describe("check constraints", () => {
  it("refuses a fifth day index", async () => {
    const eventId = await makeEvent();
    await expectRejection(() => makeDay(eventId, 5), /event_days_index_range/);
  });

  it("refuses a negative day index", async () => {
    const eventId = await makeEvent();
    await expectRejection(() => makeDay(eventId, -1), /event_days_index_range/);
  });

  it("allows the scratch index a reorder passes through", async () => {
    // Index 4 is not a fifth day; it is the slot `setEventDays` parks a row on
    // mid-rotation. The schema has to permit it or a legal reorder cannot be
    // written one statement at a time.
    const eventId = await makeEvent();
    await expect(makeDay(eventId, 4)).resolves.toBeTruthy();
  });

  it("refuses a capacity of zero", async () => {
    await expectRejection(
      () => ctx.db.insert(events).values({ slug: "no-seats", title: "No seats", capacity: 0 }),
      /events_capacity_positive/
    );
  });

  it("allows a null capacity, which is what unlimited means", async () => {
    await expect(makeEvent({ capacity: null })).resolves.toBeTruthy();
  });

  it("refuses a queue position of zero", async () => {
    const eventId = await makeEvent();
    const userId = await makeUser(ctx.db);
    await expectRejection(
      () => makeApplication(eventId, userId, { status: "waitlisted", waitlistPosition: 0 }),
      /applications_waitlist_position_positive/
    );
  });

  it("refuses an application pointing at an event that does not exist", async () => {
    const userId = await makeUser(ctx.db);
    await expectRejection(
      () =>
        ctx.db.insert(applications).values({
          eventId: "00000000-0000-0000-0000-000000000000",
          userId,
          status: "accepted",
        }),
      /foreign key|violates/i
    );
  });

  it("refuses an event status outside the enum", async () => {
    await expect(
      ctx.client.query(
        `insert into events (slug, title, status) values ('bad-status', 'Bad', 'archived')`
      )
    ).rejects.toThrow();
  });
});

describe("cascade deletes", () => {
  it("takes an event's whole tree with it", async () => {
    const eventId = await makeEvent();
    const dayId = await makeDay(eventId);
    const userId = await makeUser(ctx.db);
    const applicationId = await makeApplication(eventId, userId);
    await ctx.db
      .insert(eventQuestions)
      .values({ eventId, key: "role", label: "Role", type: "text" });
    await ctx.db.insert(availability).values({ applicationId, eventDayId: dayId, state: "yes" });
    await ctx.db.insert(confirmations).values({ applicationId, state: "in" });

    await ctx.db.delete(events).where(eq(events.id, eventId));

    expect(await ctx.db.select().from(eventDays).where(eq(eventDays.eventId, eventId))).toEqual([]);
    expect(
      await ctx.db.select().from(eventQuestions).where(eq(eventQuestions.eventId, eventId))
    ).toEqual([]);
    expect(
      await ctx.db.select().from(applications).where(eq(applications.eventId, eventId))
    ).toEqual([]);
    // Three hops: event -> application -> availability, and event -> day -> availability.
    expect(
      await ctx.db
        .select()
        .from(availability)
        .where(eq(availability.applicationId, applicationId))
    ).toEqual([]);
    expect(
      await ctx.db
        .select()
        .from(confirmations)
        .where(eq(confirmations.applicationId, applicationId))
    ).toEqual([]);
    // The member survives an event being deleted; only their application goes.
    expect(await ctx.db.select().from(users).where(eq(users.id, userId))).toHaveLength(1);
  });

  it("leaves other events alone", async () => {
    const doomed = await makeEvent();
    const survivor = await makeEvent();
    await makeDay(doomed);
    const keptDay = await makeDay(survivor);

    await ctx.db.delete(events).where(eq(events.id, doomed));

    expect(await ctx.db.select().from(eventDays).where(eq(eventDays.id, keptDay))).toHaveLength(1);
  });

  it("takes a member's applications with them", async () => {
    const eventId = await makeEvent();
    const userId = await makeUser(ctx.db);
    const applicationId = await makeApplication(eventId, userId);
    await ctx.db.insert(confirmations).values({ applicationId, state: "in" });

    await ctx.db.delete(users).where(eq(users.id, userId));

    expect(
      await ctx.db.select().from(applications).where(eq(applications.userId, userId))
    ).toEqual([]);
    expect(
      await ctx.db
        .select()
        .from(confirmations)
        .where(eq(confirmations.applicationId, applicationId))
    ).toEqual([]);
    // The event itself is untouched — it belongs to the community, not the member.
    expect(await ctx.db.select().from(events).where(eq(events.id, eventId))).toHaveLength(1);
  });

  it("takes an application's availability and confirmation with it", async () => {
    const eventId = await makeEvent();
    const dayId = await makeDay(eventId);
    const applicationId = await makeApplication(eventId, await makeUser(ctx.db));
    await ctx.db.insert(availability).values({ applicationId, eventDayId: dayId, state: "maybe" });
    await ctx.db.insert(confirmations).values({ applicationId, state: "out" });

    await ctx.db.delete(applications).where(eq(applications.id, applicationId));

    expect(
      await ctx.db.select().from(availability).where(eq(availability.applicationId, applicationId))
    ).toEqual([]);
    // The day is the event's, not the applicant's, so it stays.
    expect(await ctx.db.select().from(eventDays).where(eq(eventDays.id, dayId))).toHaveLength(1);
  });

  it("takes a day's availability with it, and leaves the application standing", async () => {
    const eventId = await makeEvent();
    const dayId = await makeDay(eventId);
    const applicationId = await makeApplication(eventId, await makeUser(ctx.db));
    await ctx.db.insert(availability).values({ applicationId, eventDayId: dayId, state: "yes" });

    await ctx.db.delete(eventDays).where(eq(eventDays.id, dayId));

    expect(
      await ctx.db.select().from(availability).where(eq(availability.eventDayId, dayId))
    ).toEqual([]);
    expect(
      await ctx.db.select().from(applications).where(eq(applications.id, applicationId))
    ).toHaveLength(1);
  });

  it("keeps the event when its game is deleted, and forgets the game", async () => {
    const [game] = await ctx.db
      .insert(games)
      .values({ key: "doomed-game", name: "Doomed" })
      .returning({ id: games.id });
    const eventId = await makeEvent({ gameId: game.id });
    await ctx.db
      .insert(eventTemplates)
      .values({ name: "Doomed template", gameId: game.id });

    await ctx.db.delete(games).where(eq(games.id, game.id));

    const [event] = await ctx.db.select().from(events).where(eq(events.id, eventId));
    expect(event).toBeTruthy();
    expect(event.gameId).toBeNull();
    const [template] = await ctx.db
      .select()
      .from(eventTemplates)
      .where(eq(eventTemplates.name, "Doomed template"));
    expect(template.gameId).toBeNull();
  });

  it("keeps a question when the profile field it prefilled from goes", async () => {
    const [field] = await ctx.db
      .insert(profileFields)
      .values({ gameId: null, key: "doomed-field", label: "Doomed", type: "text" })
      .returning({ id: profileFields.id });
    const eventId = await makeEvent();
    const [question] = await ctx.db
      .insert(eventQuestions)
      .values({
        eventId,
        key: "linked",
        label: "Linked",
        type: "text",
        profileFieldId: field.id,
      })
      .returning({ id: eventQuestions.id });

    await ctx.db.delete(profileFields).where(eq(profileFields.id, field.id));

    const [row] = await ctx.db
      .select()
      .from(eventQuestions)
      .where(eq(eventQuestions.id, question.id));
    expect(row).toBeTruthy();
    expect(row.profileFieldId).toBeNull();
  });

  it("keeps an event when the admin who created it is deleted", async () => {
    const adminId = await makeUser(ctx.db);
    counter += 1;
    const [event] = await ctx.db
      .insert(events)
      .values({ slug: `created-by-${counter}`, title: "Created by", createdBy: adminId })
      .returning({ id: events.id });

    await ctx.db.delete(users).where(eq(users.id, adminId));

    const [row] = await ctx.db.select().from(events).where(eq(events.id, event.id));
    expect(row).toBeTruthy();
    expect(row.createdBy).toBeNull();
  });

  it("keeps an application when the admin who decided it is deleted", async () => {
    const adminId = await makeUser(ctx.db);
    const eventId = await makeEvent();
    const applicationId = await makeApplication(eventId, await makeUser(ctx.db));
    await ctx.db
      .update(applications)
      .set({ status: "declined", decidedBy: adminId, decidedAt: new Date() })
      .where(eq(applications.id, applicationId));

    await ctx.db.delete(users).where(eq(users.id, adminId));

    const [row] = await ctx.db
      .select()
      .from(applications)
      .where(eq(applications.id, applicationId));
    expect(row).toBeTruthy();
    expect(row.decidedBy).toBeNull();
    expect(row.status).toBe("declined");
  });
});
