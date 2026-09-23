import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { type Database, eventHosts, hostApplications } from "@/db";
import {
  PUBLISHABLE,
  type TestDatabase,
  expectRejection,
  freshDatabase,
  makeHost,
  makeUser,
} from "@/db/__tests__/helpers";
import { createEvent, getEventById, publishEvent, updateEvent } from "@/lib/events";
import {
  ALREADY_PENDING,
  applyToHost,
  approveHostApplication,
  canManageEvent,
  canSeeEvent,
  declineHostApplication,
  eventsHostedBy,
  getHostApplication,
  linkableEvents,
  listHostApplications,
  myHostApplications,
  questionsFromApplication,
  withdrawHostApplication,
} from "@/lib/hosting";

/**
 * Applying to host, and the permission it grants (R-83 to R-86 / UC-20, UC-21).
 *
 * `canManageEvent` is the only thing standing between "a member" and "an
 * editor for somebody else's event", so most of what is here is that one
 * function answered from every direction.
 *
 * The rest follows the two use cases line by line, and two of them are checked
 * against Postgres rather than against the library: one pending application per
 * member is a *rule*, and a rule that only a read enforces is a rule that two
 * clicks in the same second break.
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

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/** The refusal, with its field marks — for the tests that read them. */
function refusal(
  result: { ok: true } | { ok: false; error: string; errors?: Record<string, string> }
): { error: string; errors: Record<string, string> } {
  if (result.ok) throw new Error("Expected a refusal, and it went through.");
  return { error: result.error, errors: result.errors ?? {} };
}

let counter = 0;
async function anEvent(): Promise<string> {
  counter += 1;
  const created = await createEvent({ title: `Hosted fixture ${counter}` }, db);
  if (!created.ok) throw new Error(created.error);
  return created.data.id;
}

const APPLICATION = {
  title: "Friday REPO night",
  gameName: "REPO",
  summary: "Six of us, a few rounds, prizes for whoever survives longest. Two hours tops.",
  playerInfoNeeded: "Their in-game name, and whether they own the DLC.",
};

/* ------------------------------------------------------------------ */
/* The permission                                                     */
/* ------------------------------------------------------------------ */

describe("canManageEvent", () => {
  it("lets an admin manage any event", async () => {
    const eventId = await anEvent();
    const admin = { id: await makeUser(db), isAdmin: true };
    expect(await canManageEvent(admin, eventId, db)).toBe(true);
  });

  it("refuses an ordinary member", async () => {
    const eventId = await anEvent();
    const member = { id: await makeUser(db), isAdmin: false };
    expect(await canManageEvent(member, eventId, db)).toBe(false);
  });

  it("refuses nobody at all", async () => {
    expect(await canManageEvent(null, await anEvent(), db)).toBe(false);
  });

  it("lets a host manage the event they were given", async () => {
    const eventId = await anEvent();
    const host = { id: await makeUser(db), isAdmin: false };
    await makeHost(db, eventId, host.id);
    expect(await canManageEvent(host, eventId, db)).toBe(true);
  });

  it("does NOT let a host manage anybody else's event", async () => {
    // The whole boundary (UC-21 5a). A host is trusted with one evening, not
    // with the site.
    const mine = await anEvent();
    const theirs = await anEvent();
    const host = { id: await makeUser(db), isAdmin: false };
    await makeHost(db, mine, host.id);

    expect(await canManageEvent(host, mine, db)).toBe(true);
    expect(await canManageEvent(host, theirs, db)).toBe(false);
  });

  it("reads the grant every time, so removing the row ends it", async () => {
    // Nothing in the site removes a grant — approving is the only thing that
    // writes one (R-86). This is the other half of that: the answer comes from
    // the table on every call, so it is never a cached yes.
    const eventId = await anEvent();
    const host = { id: await makeUser(db), isAdmin: false };
    await makeHost(db, eventId, host.id);

    await db.delete(eventHosts).where(eq(eventHosts.eventId, eventId));
    expect(await canManageEvent(host, eventId, db)).toBe(false);
  });
});

describe("canSeeEvent", () => {
  it("shows a published event to anyone, signed out included", async () => {
    const event = { id: await anEvent(), status: "published" };

    expect(await canSeeEvent({ id: await makeUser(db), isAdmin: false }, event, db)).toBe(true);
    expect(await canSeeEvent(null, event, db)).toBe(true);
  });

  it("shows an unpublished event to its host", async () => {
    const event = { id: await anEvent(), status: "draft" };
    const host = { id: await makeUser(db), isAdmin: false };
    await makeHost(db, event.id, host.id);

    expect(await canSeeEvent(host, event, db)).toBe(true);
  });

  it("hides an unpublished event from another member and from somebody signed out", async () => {
    const event = { id: await anEvent(), status: "draft" };

    expect(await canSeeEvent({ id: await makeUser(db), isAdmin: false }, event, db)).toBe(false);
    expect(await canSeeEvent(null, event, db)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Applying (UC-20)                                                   */
/* ------------------------------------------------------------------ */

describe("applying", () => {
  it("keeps what the admin needs to set the event up", async () => {
    // UC-20 2 to 4: what they describe is what the admin reads in UC-21.
    const userId = await makeUser(db, { displayName: "Ada" });
    const { id } = unwrap(await applyToHost(userId, APPLICATION, db));

    const application = await getHostApplication(id, db);
    expect(application?.status).toBe("pending");
    expect(application?.gameName).toBe("REPO");
    expect(application?.playerInfoNeeded).toMatch(/in-game name/);
    expect(application?.by?.name).toBe("Ada");
  });

  it("keeps the expected players and the summary (R-167, R-168 / UC-20 E1)", async () => {
    const userId = await makeUser(db);
    const { id } = unwrap(
      await applyToHost(userId, { ...APPLICATION, expectedPlayers: 12 }, db)
    );

    const application = await getHostApplication(id, db);
    expect(application?.expectedPlayers).toBe(12);
    expect(application?.summary).toBe(APPLICATION.summary);
  });

  it("marks every empty field at once rather than the first (UC-20 3a)", async () => {
    const userId = await makeUser(db);

    const { error, errors } = refusal(
      await applyToHost(
        userId,
        { title: "", gameName: "", summary: "", playerInfoNeeded: "" },
        db
      )
    );

    expect(Object.keys(errors).sort()).toEqual([
      "gameName",
      "playerInfoNeeded",
      "summary",
      "title",
    ]);
    // And a sentence for a caller with nowhere to put the marks.
    expect(error).toBeTruthy();
    expect(await myHostApplications(userId, db)).toEqual([]);
  });

  it("marks only the field that is wrong, and says what is wrong with it", async () => {
    const userId = await makeUser(db);

    const { errors } = refusal(
      await applyToHost(userId, { ...APPLICATION, expectedPlayers: 900 }, db)
    );

    expect(Object.keys(errors)).toEqual(["expectedPlayers"]);
    expect(errors.expectedPlayers).toMatch(/between 2 and 500/);
  });

  it("insists on the two things approving it depends on", async () => {
    const userId = await makeUser(db);
    // No game: the admin cannot attach one.
    expect(refusal(await applyToHost(userId, { ...APPLICATION, gameName: "" }, db)).errors)
      .toHaveProperty("gameName");
    // No player info: the admin cannot write the questions.
    expect(
      refusal(await applyToHost(userId, { ...APPLICATION, playerInfoNeeded: "" }, db)).errors
    ).toHaveProperty("playerInfoNeeded");
    // A summary that says nothing.
    expect(refusal(await applyToHost(userId, { ...APPLICATION, summary: "pls" }, db)).errors)
      .toHaveProperty("summary");
  });

  it("allows one pending application at a time (UC-20 3b)", async () => {
    const userId = await makeUser(db);
    unwrap(await applyToHost(userId, APPLICATION, db));

    const second = await applyToHost(userId, { ...APPLICATION, title: "Another idea" }, db);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error).toMatch(/already have an application/);
  });

  it("frees them up again once they withdraw (UC-20 4a)", async () => {
    const userId = await makeUser(db);
    const { id } = unwrap(await applyToHost(userId, APPLICATION, db));
    await withdrawHostApplication(id, db);

    expect((await applyToHost(userId, APPLICATION, db)).ok).toBe(true);
    expect((await getHostApplication(id, db))?.status).toBe("withdrawn");
  });

  it("shows a person only their own", async () => {
    const mine = await makeUser(db);
    const theirs = await makeUser(db);
    unwrap(await applyToHost(mine, APPLICATION, db));
    unwrap(await applyToHost(theirs, APPLICATION, db));

    const list = await myHostApplications(mine, db);
    expect(list).toHaveLength(1);
    expect(list[0].by?.id).toBe(mine);
  });
});

describe("one pending application, in the database (UC-20 3b)", () => {
  it("is refused by Postgres, not only by the read in applyToHost", async () => {
    // The rule as the database holds it. `applyToHost` is not involved: a
    // second pending row cannot exist however it is written.
    const userId = await makeUser(db);
    unwrap(await applyToHost(userId, APPLICATION, db));

    await expectRejection(
      () =>
        db.insert(hostApplications).values({
          userId,
          title: "Straight past the library",
          gameName: "REPO",
          summary: APPLICATION.summary,
          playerInfoNeeded: APPLICATION.playerInfoNeeded,
        }),
      /host_applications_one_pending_per_user/
    );
  });

  it("still lets them keep every decided application they have ever sent", async () => {
    // Partial index: the rule is about the queue, not about the record.
    const userId = await makeUser(db);
    const first = unwrap(await applyToHost(userId, APPLICATION, db));
    await withdrawHostApplication(first.id, db);
    const second = unwrap(await applyToHost(userId, APPLICATION, db));
    unwrap(
      await declineHostApplication(second.id, await makeUser(db), "Clashes with the final", db)
    );

    expect((await applyToHost(userId, APPLICATION, db)).ok).toBe(true);
    expect(await myHostApplications(userId, db)).toHaveLength(3);
  });

  it("refuses the second of two sent at the same moment, with the same sentence", async () => {
    /*
     * The race the read cannot see: both calls look for a pending row before
     * either has inserted one, so both find none. Only the index can refuse the
     * loser — and it must come back as the sentence the member would get a
     * minute later, not as a crash.
     */
    const userId = await makeUser(db);

    const [first, second] = await Promise.all([
      applyToHost(userId, APPLICATION, db),
      applyToHost(userId, { ...APPLICATION, title: "Sent twice" }, db),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const loser = first.ok ? second : first;
    expect(loser.ok === false && loser.error).toBe(ALREADY_PENDING);
    expect(
      await db
        .select({ id: hostApplications.id })
        .from(hostApplications)
        .where(
          and(eq(hostApplications.userId, userId), eq(hostApplications.status, "pending"))
        )
    ).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Deciding (UC-21)                                                   */
/* ------------------------------------------------------------------ */

describe("approving", () => {
  it("links the event the admin built from it and hands it over (UC-21 3, 4)", async () => {
    const applicant = await makeUser(db);
    const admin = await makeUser(db);
    const { id } = unwrap(await applyToHost(applicant, APPLICATION, db));
    const eventId = await anEvent();

    unwrap(await approveHostApplication(id, admin, { eventId }, db));

    expect(await canManageEvent({ id: applicant, isAdmin: false }, eventId, db)).toBe(true);
    const application = await getHostApplication(id, db);
    expect(application?.status).toBe("approved");
    expect(application?.eventId).toBe(eventId);
    expect(await eventsHostedBy(applicant, db)).toHaveLength(1);
  });

  it("refuses an event somebody else already hosts, and grants nothing (R-86)", async () => {
    /*
     * The failure mode this check exists for: `eventId` comes off a select in
     * the browser, so an approval aimed at an event that is already somebody's
     * would hand a second person full rights over their evening. One grant per
     * event, authorised on the row being written.
     */
    const theirHost = await makeUser(db);
    const applicant = await makeUser(db);
    const admin = await makeUser(db);
    const eventId = await anEvent();
    await makeHost(db, eventId, theirHost);
    const { id } = unwrap(await applyToHost(applicant, APPLICATION, db));

    const { errors } = refusal(await approveHostApplication(id, admin, { eventId }, db));

    expect(errors).toHaveProperty("eventId");
    expect(await canManageEvent({ id: applicant, isAdmin: false }, eventId, db)).toBe(false);
    expect((await getHostApplication(id, db))?.status).toBe("pending");
    expect(
      await db.select().from(eventHosts).where(eq(eventHosts.eventId, eventId))
    ).toHaveLength(1);
  });

  it("refuses an event that is not there, and one that was never chosen", async () => {
    const applicant = await makeUser(db);
    const admin = await makeUser(db);
    const { id } = unwrap(await applyToHost(applicant, APPLICATION, db));

    expect(refusal(await approveHostApplication(id, admin, { eventId: "" }, db)).errors)
      .toHaveProperty("eventId");
    expect(
      refusal(
        await approveHostApplication(
          id,
          admin,
          { eventId: "00000000-0000-0000-0000-000000000000" },
          db
        )
      ).errors
    ).toHaveProperty("eventId");
    expect((await getHostApplication(id, db))?.status).toBe("pending");
  });

  it("refuses to decide the same application twice", async () => {
    const applicant = await makeUser(db);
    const admin = await makeUser(db);
    const { id } = unwrap(await applyToHost(applicant, APPLICATION, db));

    unwrap(await approveHostApplication(id, admin, { eventId: await anEvent() }, db));
    const again = await approveHostApplication(id, admin, { eventId: await anEvent() }, db);

    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error).toMatch(/already been decided/);
  });
});

describe("declining", () => {
  it("needs a reason, and changes nothing without one (UC-21 3a)", async () => {
    const applicant = await makeUser(db);
    const admin = await makeUser(db);
    const { id } = unwrap(await applyToHost(applicant, APPLICATION, db));

    for (const note of [null, "", "   ", "no"]) {
      const { errors } = refusal(await declineHostApplication(id, admin, note, db));
      expect(errors).toHaveProperty("note");
    }

    const application = await getHostApplication(id, db);
    expect(application?.status).toBe("pending");
    expect(application?.decidedAt).toBeNull();
  });

  it("does not grant anything, and says why (UC-21 3a)", async () => {
    const applicant = await makeUser(db);
    const admin = await makeUser(db);
    const { id } = unwrap(await applyToHost(applicant, APPLICATION, db));
    const eventId = await anEvent();

    unwrap(await declineHostApplication(id, admin, "Clashes with the tournament", db));

    const application = await getHostApplication(id, db);
    expect(application?.status).toBe("declined");
    expect(application?.decisionNote).toBe("Clashes with the tournament");
    expect(application?.eventId).toBeNull();
    expect(await canManageEvent({ id: applicant, isAdmin: false }, eventId, db)).toBe(false);
  });

  it("refuses to decide one that has already been decided", async () => {
    const applicant = await makeUser(db);
    const first = await makeUser(db);
    const second = await makeUser(db);
    const { id } = unwrap(await applyToHost(applicant, APPLICATION, db));

    unwrap(await declineHostApplication(id, first, "Not this term", db));
    const again = await declineHostApplication(id, second, "Changed my mind", db);

    expect(again.ok).toBe(false);
    // The first decision stands, with its author and its reason.
    expect((await getHostApplication(id, db))?.decisionNote).toBe("Not this term");
  });
});

describe("the queue", () => {
  it("leaves the undecided ones on top", async () => {
    const settled = await makeUser(db);
    const waiting = await makeUser(db);

    const first = unwrap(await applyToHost(settled, APPLICATION, db));
    unwrap(await declineHostApplication(first.id, await makeUser(db), "Another time", db));
    const second = unwrap(
      await applyToHost(waiting, { ...APPLICATION, title: "Still waiting" }, db)
    );

    // Relative order against the shared database — see the note in
    // `suggestions.test.ts` for why not a fresh one per test.
    const queue = await listHostApplications(db);
    const at = (id: string) => queue.findIndex((row) => row.id === id);
    expect(at(second.id)).toBeLessThan(at(first.id));
    expect(queue[0].status).toBe("pending");
  });
});

/* ------------------------------------------------------------------ */
/* What an approval may be pointed at (UC-21 2, 3)                    */
/* ------------------------------------------------------------------ */

describe("linkable events", () => {
  it("offers an event nobody hosts, and drops it once somebody does", async () => {
    const eventId = await anEvent();
    const has = async () => (await linkableEvents(db)).some((row) => row.id === eventId);

    expect(await has()).toBe(true);
    await makeHost(db, eventId, await makeUser(db));
    expect(await has()).toBe(false);
  });

  it("leaves out an event nothing can need doing to", async () => {
    // A cancelled event has no evening left to hand anybody, so it is not
    // something an approval can be pointed at.
    counter += 1;
    const created = unwrap(
      await createEvent({ ...PUBLISHABLE, title: `Called off ${counter}` }, db)
    );
    unwrap(await publishEvent(created.id, db));
    unwrap(await updateEvent(created.id, { status: "cancelled" }, db));
    expect((await getEventById(created.id, {}, db))?.status).toBe("cancelled");

    expect((await linkableEvents(db)).some((row) => row.id === created.id)).toBe(false);
  });
});

describe("the questions the application already wrote (UC-21 2)", () => {
  it("makes one required short answer per line, in their order", () => {
    expect(
      questionsFromApplication("In-game name\n  Do you own the DLC?  \n\nRank")
    ).toEqual([
      { label: "In-game name", type: "text", required: true },
      { label: "Do you own the DLC?", type: "text", required: true },
      { label: "Rank", type: "text", required: true },
    ]);
  });

  it("never writes more questions than an event will take", () => {
    const many = Array.from({ length: 60 }, (_, index) => `Question ${index}`).join("\n");
    expect(questionsFromApplication(many).length).toBeLessThanOrEqual(40);
  });
});
