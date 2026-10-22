import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Database,
  type EventStatus,
  applications,
  eventDays,
  events,
} from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  EVENT_STARTING_LEAD_MS,
  GITHUB_PING_INTERVAL_MS,
  GITHUB_PING_LATENESS_MS,
  SCHEDULE_TOLERATES_LATENESS,
  SIGNUP_CLOSING_LEAD_MS,
  WORST_RUN_GAP_MS,
  dueScheduledAnnouncements,
} from "@/lib/announce-schedule";

/**
 * The two moments nobody triggers (R-206, R-207 / UC-38 3, 3a, 4, 4a, 4b, 4c,
 * 5b).
 *
 * Every assertion here names **the event it is about**. The whole file shares
 * one database, so an assertion on "how many are due" would be an assertion
 * about every event any other test in this file happened to leave lying around
 * — and it would keep passing once the guard under test stopped working, which
 * is the failure mode this project has been bitten by thirteen times.
 */

let handle: TestDatabase;
let db: Database;

beforeAll(async () => {
  handle = await freshDatabase();
  db = handle.db;
});

afterAll(async () => {
  await handle.close();
});

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

type Setup = {
  status?: EventStatus;
  capacity?: number | null;
  signupClosesAt?: Date | null;
  /** Written as `event_days` rows, because that is where a start lives (R-24). */
  dayStarts?: Array<Date | null>;
  accepted?: number;
};

async function makeEvent(setup: Setup = {}): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const [event] = await db
    .insert(events)
    .values({
      slug: `sched-${suffix}`,
      title: `Scheduled ${suffix}`,
      status: setup.status ?? "published",
      capacity: setup.capacity ?? null,
      signupClosesAt: setup.signupClosesAt ?? null,
    })
    .returning({ id: events.id });

  const starts = setup.dayStarts ?? [];
  for (const [dayIndex, startsAt] of starts.entries()) {
    await db.insert(eventDays).values({ eventId: event.id, dayIndex, startsAt });
  }

  for (let seat = 0; seat < (setup.accepted ?? 0); seat += 1) {
    const userId = await makeUser(db);
    await db.insert(applications).values({ eventId: event.id, userId, status: "accepted" });
  }

  return event.id;
}

/** This event's closing-soon entry, or null. Never "how many are due". */
async function closing(eventId: string, now: Date) {
  const due = await dueScheduledAnnouncements(now, db);
  return due.closingSoon.find((row) => row.eventId === eventId) ?? null;
}

/** This event's starting-soon entry, or null. */
async function starting(eventId: string, now: Date) {
  const due = await dueScheduledAnnouncements(now, db);
  return due.startingSoon.find((row) => row.eventId === eventId) ?? null;
}

/* ------------------------------------------------------------------ */
/* One day before signups close (R-206 / UC-38 3, 3a, 4c)             */
/* ------------------------------------------------------------------ */

describe("signups closing soon", () => {
  const now = new Date("2026-11-02T12:00:00.000Z");

  it("is due inside the day before, and carries that instant", async () => {
    const closesAt = new Date(now.getTime() + 20 * HOUR);
    const id = await makeEvent({ signupClosesAt: closesAt });

    const due = await closing(id, now);
    expect(due).not.toBeNull();
    expect(due?.at.toISOString()).toBe(closesAt.toISOString());
  });

  it("is not due the moment before the window opens", async () => {
    // One minute further out than the lead. The boundary, from the far side.
    const id = await makeEvent({
      signupClosesAt: new Date(now.getTime() + SIGNUP_CLOSING_LEAD_MS + MINUTE),
    });
    expect(await closing(id, now)).toBeNull();
  });

  it("is due at the very edge of the window", async () => {
    const id = await makeEvent({
      signupClosesAt: new Date(now.getTime() + SIGNUP_CLOSING_LEAD_MS),
    });
    expect(await closing(id, now)).not.toBeNull();
  });

  it("is not due once the closing time has passed", async () => {
    const id = await makeEvent({ signupClosesAt: new Date(now.getTime() - MINUTE) });
    expect(await closing(id, now)).toBeNull();
  });

  it("is not due at the closing time itself", async () => {
    // Nothing to warn anybody about: it has closed.
    const id = await makeEvent({ signupClosesAt: now });
    expect(await closing(id, now)).toBeNull();
  });

  /** UC-38 3a — nothing to count back from. */
  it("gets nothing when the event has no closing time", async () => {
    const id = await makeEvent({ signupClosesAt: null });
    expect(await closing(id, now)).toBeNull();
  });

  it("gets nothing for a draft, which members cannot see at all", async () => {
    const id = await makeEvent({
      status: "draft",
      signupClosesAt: new Date(now.getTime() + 20 * HOUR),
    });
    expect(await closing(id, now)).toBeNull();
  });

  it("gets nothing for a cancelled event, which has no signups left to close", async () => {
    const id = await makeEvent({
      status: "cancelled",
      signupClosesAt: new Date(now.getTime() + 20 * HOUR),
    });
    expect(await closing(id, now)).toBeNull();
  });

  /** UC-38 4c — a waitlist place is still worth having, but it must say so. */
  it("still posts for a full event, and says it is full", async () => {
    const id = await makeEvent({
      signupClosesAt: new Date(now.getTime() + 20 * HOUR),
      capacity: 2,
      accepted: 2,
    });
    const due = await closing(id, now);
    expect(due).not.toBeNull();
    expect(due?.full).toBe(true);
  });

  it("does not say an event with a seat left is full", async () => {
    const id = await makeEvent({
      signupClosesAt: new Date(now.getTime() + 20 * HOUR),
      capacity: 2,
      accepted: 1,
    });
    expect((await closing(id, now))?.full).toBe(false);
  });

  it("does not say an uncapped event is full, however many are in", async () => {
    const id = await makeEvent({
      signupClosesAt: new Date(now.getTime() + 20 * HOUR),
      capacity: null,
      accepted: 3,
    });
    expect((await closing(id, now))?.full).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Two hours before the first day starts (R-207 / UC-38 4, 4a, 4b)    */
/* ------------------------------------------------------------------ */

describe("an event starting soon", () => {
  const now = new Date("2026-11-03T12:00:00.000Z");

  it("is due inside the two hours before it starts", async () => {
    const startsAt = new Date(now.getTime() + 90 * MINUTE);
    const id = await makeEvent({ dayStarts: [startsAt] });

    const due = await starting(id, now);
    expect(due).not.toBeNull();
    expect(due?.at.toISOString()).toBe(startsAt.toISOString());
  });

  it("is not due three hours out", async () => {
    const id = await makeEvent({ dayStarts: [new Date(now.getTime() + 3 * HOUR)] });
    expect(await starting(id, now)).toBeNull();
  });

  it("is due at the very edge of the window", async () => {
    const id = await makeEvent({
      dayStarts: [new Date(now.getTime() + EVENT_STARTING_LEAD_MS)],
    });
    expect(await starting(id, now)).not.toBeNull();
  });

  /** UC-38 5b — a missed moment is not posted late. */
  it("is not due once it has started", async () => {
    const id = await makeEvent({ dayStarts: [new Date(now.getTime() - MINUTE)] });
    expect(await starting(id, now)).toBeNull();
  });

  /** UC-38 4a — `starts_at` is nullable, so this is a real event. */
  it("gets nothing when no day has a start time", async () => {
    const id = await makeEvent({ dayStarts: [null, null] });
    expect(await starting(id, now)).toBeNull();
  });

  it("gets nothing when the event has no days at all", async () => {
    const id = await makeEvent({ dayStarts: [] });
    expect(await starting(id, now)).toBeNull();
  });

  /** UC-38 4b — the worst message this feature could send. */
  it("gets nothing for a cancelled event", async () => {
    const id = await makeEvent({
      status: "cancelled",
      dayStarts: [new Date(now.getTime() + 90 * MINUTE)],
    });
    expect(await starting(id, now)).toBeNull();
  });

  it("gets nothing for a draft", async () => {
    const id = await makeEvent({
      status: "draft",
      dayStarts: [new Date(now.getTime() + 90 * MINUTE)],
    });
    expect(await starting(id, now)).toBeNull();
  });

  it("is due for an event already running, which is a status an admin sets early", async () => {
    const id = await makeEvent({
      status: "live",
      dayStarts: [new Date(now.getTime() + 90 * MINUTE)],
    });
    expect(await starting(id, now)).not.toBeNull();
  });

  /**
   * R-24 — the **first** dated day, and the first by its start time rather than
   * by the order the rows went in. `eventDates` sorts, and this is what says so.
   */
  it("counts back from the earliest dated day, not the last one written", async () => {
    const first = new Date(now.getTime() + 90 * MINUTE);
    const later = new Date(now.getTime() + 30 * HOUR);
    // Written later-first, so a function reading row order gets this wrong.
    const id = await makeEvent({ dayStarts: [later, first] });

    const due = await starting(id, now);
    expect(due?.at.toISOString()).toBe(first.toISOString());
  });

  it("ignores a day with no start while counting back from one that has", async () => {
    const first = new Date(now.getTime() + 90 * MINUTE);
    const id = await makeEvent({ dayStarts: [null, first] });
    expect((await starting(id, now))?.at.toISOString()).toBe(first.toISOString());
  });
});

/* ------------------------------------------------------------------ */
/* No instant is formatted on the server (a repo invariant)           */
/* ------------------------------------------------------------------ */

describe("the instants travel as Discord markup", () => {
  const now = new Date("2026-11-04T12:00:00.000Z");

  it("renders a start as a full timestamp in the reader's own zone", async () => {
    const startsAt = new Date("2026-11-04T13:30:00.000Z");
    const id = await makeEvent({ dayStarts: [startsAt] });

    const due = await starting(id, now);
    // The exact markup, not "contains a colon": Discord renders `<t:…:F>` in
    // each reader's zone, and the unix seconds are the only correct payload.
    expect(due?.stamp).toBe(`<t:${startsAt.getTime() / 1000}:F>`);
  });

  it("renders a closing time as a countdown", async () => {
    const closesAt = new Date("2026-11-05T09:00:00.000Z");
    const id = await makeEvent({ signupClosesAt: closesAt });

    const due = await closing(id, now);
    expect(due?.stamp).toBe(`<t:${closesAt.getTime() / 1000}:R>`);
  });

  it("formats no instant on the server, in either message", async () => {
    const id = await makeEvent({
      signupClosesAt: new Date(now.getTime() + 20 * HOUR),
      dayStarts: [new Date(now.getTime() + 90 * MINUTE)],
    });
    const due = await dueScheduledAnnouncements(now, db);
    const mine = [
      ...due.closingSoon.filter((row) => row.eventId === id),
      ...due.startingSoon.filter((row) => row.eventId === id),
    ];
    expect(mine).toHaveLength(2);
    for (const row of mine) {
      /*
       * Nothing but the markup. A guard of "does not contain 2026" would pass
       * on `"Wednesday 4 November"`, and a guard of "contains `<t:`" would pass
       * on a formatted date with the markup bolted on the end — so the whole
       * string has to be the markup and nothing else.
       */
      expect(row.stamp).toMatch(/^<t:\d+:[FR]>$/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* A late run (the criterion that needs a moving clock)               */
/* ------------------------------------------------------------------ */

/**
 * GitHub's scheduler is best-effort, so the test moves the clock instead of
 * asserting a comment.
 *
 * `runs` is the sequence of instants a scheduler *actually woke at*, built from
 * a nominal cadence plus a slip. The question each test asks is which of those
 * wakes found the event — which is the only form the criterion can take once
 * "fires at the right moment" has stopped meaning "an equality test on a
 * timestamp".
 */
function runs(from: Date, until: Date, slipMs: number): Date[] {
  const out: Date[] = [];
  for (let at = from.getTime(); at <= until.getTime(); at += GITHUB_PING_INTERVAL_MS) {
    out.push(new Date(at + slipMs));
  }
  return out;
}

describe("a run that is late", () => {
  const startsAt = new Date("2026-11-06T20:00:00.000Z");

  async function wakesThatSaw(id: string, slipMs: number): Promise<Date[]> {
    const seen: Date[] = [];
    for (const at of runs(
      new Date(startsAt.getTime() - 4 * HOUR),
      new Date(startsAt.getTime() + HOUR),
      slipMs
    )) {
      if (await starting(id, at)) seen.push(at);
    }
    return seen;
  }

  /**
   * The slips worth testing, and why not only the worst one.
   *
   * A slip of exactly one interval is the degenerate case: it reproduces the
   * same grid of wakes with different labels, so "every run 15 minutes late"
   * fires at precisely the same instants as "every run on time" and would
   * prove nothing at all. GitHub's documented delay is a *range* — 5 to 15
   * minutes — so the slips that actually move the wakes relative to the
   * moment are the ones in between, and they are the interesting ones.
   */
  const SLIPS = [0, 5 * MINUTE, 10 * MINUTE, GITHUB_PING_LATENESS_MS];

  it("the arithmetic says both windows survive the worst gap", () => {
    expect(SCHEDULE_TOLERATES_LATENESS).toBe(true);
    expect(WORST_RUN_GAP_MS).toBe(GITHUB_PING_INTERVAL_MS + GITHUB_PING_LATENESS_MS);
  });

  it.each(SLIPS)("still fires at the right moment when every run slips %ims", async (slip) => {
    const id = await makeEvent({ dayStarts: [startsAt] });
    const seen = await wakesThatSaw(id, slip);

    expect(seen.length).toBeGreaterThan(0);
    // It fired *at the right moment*: the first wake to see it is inside the
    // two hours before the start, and no more than one worst-case gap into
    // them — which is the strongest statement a 15-minute cadence permits.
    const lead = startsAt.getTime() - seen[0].getTime();
    expect(lead).toBeLessThanOrEqual(EVENT_STARTING_LEAD_MS);
    expect(lead).toBeGreaterThanOrEqual(EVENT_STARTING_LEAD_MS - WORST_RUN_GAP_MS);
  });

  it("never fires more than one worst-case gap behind the on-time run", async () => {
    const id = await makeEvent({ dayStarts: [startsAt] });
    const onTime = await wakesThatSaw(id, 0);
    expect(onTime.length).toBeGreaterThan(0);

    for (const slip of SLIPS) {
      const late = await wakesThatSaw(id, slip);
      expect(late.length).toBeGreaterThan(0);
      const behind = late[0].getTime() - onTime[0].getTime();
      expect(behind).toBeGreaterThanOrEqual(0);
      expect(behind).toBeLessThanOrEqual(WORST_RUN_GAP_MS);
    }
  });

  /**
   * The half of "does not fire twice" that lives here: **every** wake inside
   * the window sees the event, whatever the slip.
   *
   * That is not a bug — it is precisely why a claim is required, and pinning it
   * is what stops somebody "fixing" the repeat by narrowing the window, which
   * would reintroduce the missed moment a late run causes. The claim itself is
   * not built; see the note at the foot of `announce-schedule.ts`.
   */
  it.each(SLIPS)("is seen by every wake inside the window at a slip of %ims", async (slip) => {
    const id = await makeEvent({ dayStarts: [startsAt] });
    const seen = await wakesThatSaw(id, slip);

    // Two hours of quarter-hourly wakes, so the count is the window divided by
    // the cadence however the grid is shifted.
    expect(seen).toHaveLength(EVENT_STARTING_LEAD_MS / GITHUB_PING_INTERVAL_MS);
    expect(seen.every((at) => at.getTime() < startsAt.getTime())).toBe(true);
  });

  /** UC-38 5b — the scheduler was down for the whole window. */
  it("is never fired once the window has been slept through", async () => {
    const id = await makeEvent({ dayStarts: [startsAt] });
    const seen: Date[] = [];
    // First wake after the event has already begun.
    for (const at of runs(new Date(startsAt.getTime() + MINUTE), new Date(startsAt.getTime() + 6 * HOUR), 0)) {
      if (await starting(id, at)) seen.push(at);
    }
    expect(seen).toEqual([]);
  });

  it("does not post a day-late closing reminder either", async () => {
    const closesAt = new Date("2026-11-07T09:00:00.000Z");
    const id = await makeEvent({ signupClosesAt: closesAt });
    // A whole day of outage: the next wake is after signups closed.
    expect(await closing(id, new Date(closesAt.getTime() + MINUTE))).toBeNull();
    // ...and it would have fired, had anything been awake in time.
    expect(await closing(id, new Date(closesAt.getTime() - HOUR))).not.toBeNull();
  });
});
