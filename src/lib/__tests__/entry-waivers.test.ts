import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Database,
  type EventRow,
  entryWaivers,
  events,
  games,
  profileFields,
  profileValues,
  teamMembers,
  teams,
  users,
} from "@/db";
import { PUBLISHABLE, type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import { RIVALS_RANK_LADDER } from "@/db/seed";
import { setCaptains, setTeams } from "@/lib/draft";
import {
  type CreateEventInput,
  type EventResult,
  applyToEvent,
  createEvent,
  findMemberByHandle,
  getApplicationsForEvent,
  listEntryWaivers,
  loadApplicationForm,
  publishEvent,
  revokeEntryWaiver,
  updateEvent,
  waiveEntryRule,
} from "@/lib/events";

/**
 * Entry-rule waivers (R-28, R-29, R-50, R-59 / UC-12 2a, UC-14 3b, UC-15 3a).
 *
 * The library half of Task 9. Against real Postgres, because the whole design
 * rests on constraints this cannot afford to be wrong about: the waiver's
 * identity is a unique (event, member, rule), a second grant has to be the same
 * decision rather than a second row, and every statement has to be scoped to
 * the event it was authorised against.
 *
 * The action half — who may write one, and the audit line it leaves — is in
 * `src/app/admin/events/__tests__/waivers.test.ts`, because only the actions
 * know who is acting.
 */

let harness: TestDatabase;
let db: Database;

let rivalsId: string;
let rankFieldId: string;

const NOW = new Date("2026-04-01T18:00:00Z");
let titleCounter = 0;

/** The two thresholds every test here uses, with room either side of them. */
const ENTER = "Platinum III";
const CAPTAIN = "Diamond II";

beforeAll(async () => {
  harness = await freshDatabase();
  db = harness.db;

  const [game] = await db
    .insert(games)
    .values({ key: "rivals", name: "Marvel Rivals", rankLadder: [...RIVALS_RANK_LADDER] })
    .returning({ id: games.id });
  rivalsId = game.id;

  const [rank] = await db
    .insert(profileFields)
    .values({ gameId: rivalsId, key: "rank", label: "Rank", type: "rank", sort: 0 })
    .returning({ id: profileFields.id });
  rankFieldId = rank.id;
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

function expectFail<T>(result: EventResult<T>): {
  error: string;
  errors?: Record<string, string>;
} {
  if (result.ok) throw new Error("Expected a failure, but the call succeeded.");
  return result;
}

/** A published event with both of §8.3's thresholds set. */
async function gatedEvent(over: Partial<CreateEventInput> = {}): Promise<EventRow> {
  titleCounter += 1;
  const event = expectOk(
    await createEvent(
      {
        ...PUBLISHABLE,
        title: `Waivers ${titleCounter}`,
        gameId: rivalsId,
        minRankToEnter: ENTER,
        minRankToCaptain: CAPTAIN,
        ...over,
      },
      db
    )
  );
  return expectOk(await publishEvent(event.id, db));
}

/** A member whose recorded rank for Marvel Rivals is `rank`. */
async function memberRanked(rank: string | null): Promise<string> {
  const userId = await makeUser(db);
  if (rank !== null) {
    await db.insert(profileValues).values({ userId, fieldId: rankFieldId, value: rank as never });
  }
  return userId;
}

async function waiverRows(eventId: string, userId: string) {
  return db
    .select()
    .from(entryWaivers)
    .where(and(eq(entryWaivers.eventId, eventId), eq(entryWaivers.userId, userId)));
}

/* ------------------------------------------------------------------ */
/* UC-12 2a — the member side                                         */
/* ------------------------------------------------------------------ */

describe("UC-12 2a: a member below the entry rank", () => {
  it("is told so before any questions, and refused if they try anyway", async () => {
    const event = await gatedEvent();
    const userId = await memberRanked("Gold I");

    // "Before any questions" is the form read the page renders from: the gate
    // is answered there, so the page can show the rule instead of the form.
    const form = await loadApplicationForm(event.id, userId, { now: NOW }, db);
    expect(form?.eligibility.canEnter).toBe(false);
    expect(form?.eligibility.enterWaived).toBe(false);
    expect(form?.eligibility.enterReason).toContain(ENTER);

    // And the write agrees, which is what makes the page's refusal honest
    // rather than a decoration a direct POST would skip.
    expect(expectFail(await applyToEvent(event.id, userId, { now: NOW }, db)).error).toContain(
      ENTER
    );
    expect(await getApplicationsForEvent(event.id, db)).toEqual([]);
  });

  it("can apply once a manager has waived it, and the page says a waiver is why", async () => {
    const event = await gatedEvent();
    const manager = await makeUser(db);
    const userId = await memberRanked("Gold I");

    // The amendment in the plan: waived for a member on an event, with no
    // application in existence to hang it on.
    expectOk(await waiveEntryRule(event.id, userId, "enter", { by: manager }, db));

    const form = await loadApplicationForm(event.id, userId, { now: NOW }, db);
    expect(form?.eligibility.canEnter).toBe(true);
    expect(form?.waived.enter).toBe(true);
    // Not "you clear it": the member is told a manager let them past (R-50).
    expect(form?.eligibility.enterWaived).toBe(true);
    expect(form?.eligibility.enterReason).toContain("waived");

    const application = expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));
    expect(application.status).toBe("accepted");
  });

  it("is refused again once the waiver is withdrawn", async () => {
    const event = await gatedEvent();
    const userId = await memberRanked("Gold I");
    expectOk(await waiveEntryRule(event.id, userId, "enter", {}, db));
    expectOk(await revokeEntryWaiver(event.id, userId, "enter", db));

    expect(expectFail(await applyToEvent(event.id, userId, { now: NOW }, db)).error).toContain(
      ENTER
    );
  });

  it("shows both rules and this member's standing against each (UC-12 2)", async () => {
    const event = await gatedEvent();
    // Between the two bars: in, but not good enough to lead a team.
    const userId = await memberRanked("Platinum I");

    const form = await loadApplicationForm(event.id, userId, { now: NOW }, db);
    expect(form?.event.minRankToEnter).toBe(ENTER);
    expect(form?.event.minRankToCaptain).toBe(CAPTAIN);
    expect(form?.eligibility.enterCheck.ok).toBe(true);
    expect(form?.eligibility.captainCheck.ok).toBe(false);
    expect(form?.eligibility.captainCheck.message).toContain(CAPTAIN);
    expect(form?.eligibility.canCaptain).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* UC-15 3a — the captain the server refuses                          */
/* ------------------------------------------------------------------ */

describe("UC-15 3a: a captain below the captain rank", () => {
  /** An event with a team and one accepted applicant ranked `rank`. */
  async function teamAndApplicant(rank: string) {
    const event = await gatedEvent();
    const userId = await memberRanked(rank);
    expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));
    const { teams } = expectOk(await setTeams(event.id, [{ name: "Red" }], db));
    return { event, userId, teamId: teams[0].id };
  }

  it("is refused by the server, naming the rule, with nothing written", async () => {
    // Clears the entry bar, so they are a legitimately accepted applicant —
    // the captain rule is the only thing in the way.
    const { event, userId, teamId } = await teamAndApplicant("Platinum I");

    const refusal = expectFail(await setCaptains(event.id, [{ teamId, userId }], db));
    expect(refusal.errors?.[teamId]).toContain(CAPTAIN);

    // Nothing written: no captain on the team, and no roster row for them.
    const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
    expect(team.captainUserId).toBeNull();
    expect(
      await db.select().from(teamMembers).where(eq(teamMembers.userId, userId))
    ).toEqual([]);
  });

  it("is saved once the captain rule is waived for them", async () => {
    const { event, userId, teamId } = await teamAndApplicant("Platinum I");
    const manager = await makeUser(db);
    expectOk(await waiveEntryRule(event.id, userId, "captain", { by: manager }, db));

    const result = expectOk(await setCaptains(event.id, [{ teamId, userId }], db));
    expect(result.teams[0].captainUserId).toBe(userId);
    expect(result.members.some((member) => member.userId === userId && member.isCaptain)).toBe(
      true
    );
  });

  it("is refused again once that waiver is withdrawn", async () => {
    const { event, userId, teamId } = await teamAndApplicant("Platinum I");
    expectOk(await waiveEntryRule(event.id, userId, "captain", {}, db));
    expectOk(await setCaptains(event.id, [{ teamId, userId }], db));
    expectOk(await revokeEntryWaiver(event.id, userId, "captain", db));

    const refusal = expectFail(await setCaptains(event.id, [{ teamId, userId }], db));
    expect(refusal.errors?.[teamId]).toContain(CAPTAIN);
  });

  it("does not refuse a captain over an entry bar their acceptance settled", async () => {
    /*
     * The interaction `meetsCaptainRule` exists for. This member is below
     * *both* bars and was accepted anyway, which §8.3's acceptance override
     * allows — so the entry rule is spent, and the only waiver they should
     * need to captain is the captain one.
     */
    const event = await gatedEvent();
    const userId = await memberRanked("Gold I");
    expectOk(await waiveEntryRule(event.id, userId, "enter", {}, db));
    expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));
    expectOk(await waiveEntryRule(event.id, userId, "captain", {}, db));
    const { teams } = expectOk(await setTeams(event.id, [{ name: "Red" }], db));

    const result = expectOk(
      await setCaptains(event.id, [{ teamId: teams[0].id, userId }], db)
    );
    expect(result.teams[0].captainUserId).toBe(userId);
  });

  it("waives nothing by waiving the other rule", async () => {
    // An `enter` waiver is not a captain waiver. The two rules are separate
    // decisions and the unique key says so; this is the test that would catch
    // a reader of `entry_waivers` that ignored the `rule` column.
    const { event, userId, teamId } = await teamAndApplicant("Platinum I");
    expectOk(await waiveEntryRule(event.id, userId, "enter", {}, db));

    expect(
      expectFail(await setCaptains(event.id, [{ teamId, userId }], db)).errors?.[teamId]
    ).toContain(CAPTAIN);
  });
});

/* ------------------------------------------------------------------ */
/* UC-14 3b — what the record of a waiver is                          */
/* ------------------------------------------------------------------ */

describe("UC-14 3b: the waiver as a record", () => {
  it("records who gave it and when, for a member who has not applied", async () => {
    const event = await gatedEvent();
    const manager = await makeUser(db, { displayName: "Manager Mo" });
    const userId = await memberRanked("Gold I");

    const waiver = expectOk(
      await waiveEntryRule(event.id, userId, "enter", { by: manager, now: NOW }, db)
    );
    expect(waiver.waivedBy).toBe(manager);
    expect(waiver.waivedAt).toEqual(NOW);
    expect(waiver.grantedByName).toBe("Manager Mo");

    const listed = await listEntryWaivers(event.id, db);
    expect(listed.map((row) => [row.userId, row.rule])).toEqual([[userId, "enter"]]);
  });

  it("treats a second grant as the same decision, keeping the first manager", async () => {
    const event = await gatedEvent();
    const first = await makeUser(db, { displayName: "First Fi" });
    const second = await makeUser(db, { displayName: "Second Sy" });
    const userId = await memberRanked("Gold I");

    const once = expectOk(
      await waiveEntryRule(event.id, userId, "enter", { by: first, now: NOW }, db)
    );
    const again = expectOk(
      await waiveEntryRule(event.id, userId, "enter", { by: second }, db)
    );

    // One row, and it still names the manager who actually decided.
    expect(await waiverRows(event.id, userId)).toHaveLength(1);
    expect(again.waivedBy).toBe(first);
    expect(again.waivedAt).toEqual(NOW);

    // `created` is the insert's own answer to "was this a new decision", and
    // the only thing that separates the two calls: the action layer logs on it,
    // so a repeat that reported `true` would be a second audit line for one
    // decision (see `src/app/admin/events/waiver-actions.ts`).
    expect(once.created).toBe(true);
    expect(again.created).toBe(false);
  });

  it("refuses to waive anything on a finished event (UC-09 6b)", async () => {
    const event = await gatedEvent();
    const userId = await memberRanked("Gold I");
    await db.update(events).set({ status: "complete" }).where(eq(events.id, event.id));

    expect(expectFail(await waiveEntryRule(event.id, userId, "enter", {}, db)).error).toContain(
      "finished"
    );
    expect(await waiverRows(event.id, userId)).toEqual([]);
  });

  it("refuses a member nobody has an account for", async () => {
    const event = await gatedEvent();
    expect(
      expectFail(
        await waiveEntryRule(
          event.id,
          "00000000-0000-0000-0000-000000000000",
          "enter",
          {},
          db
        )
      ).error
    ).toContain("account");
  });

  it("withdrawing one that is not there is not an error", async () => {
    const event = await gatedEvent();
    const userId = await memberRanked("Gold I");
    expect(expectOk(await revokeEntryWaiver(event.id, userId, "enter", db)).removed).toBe(false);
  });

  it("shows on the applicant list as a waiver, not as meeting the bar", async () => {
    // UC-14 2's rank column, and what the Applicants tab offers to withdraw.
    const event = await gatedEvent();
    const userId = await memberRanked("Gold I");
    expectOk(await waiveEntryRule(event.id, userId, "enter", {}, db));
    expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    const [applicant] = await getApplicationsForEvent(event.id, db);
    expect(applicant.waived).toEqual({ enter: true, captain: false });
    expect(applicant.eligibility.canEnter).toBe(true);
    expect(applicant.eligibility.enterWaived).toBe(true);
    expect(applicant.eligibility.enterCheck.ok).toBe(false);
  });

  it("finds the member a manager names by their public handle", async () => {
    // The pre-application case has no list to pick from, so the admin screen
    // resolves a handle instead. "@Beko-Waiver" and "beko-waiver" are the same
    // member; a handle nobody holds, and a blank one, are nobody.
    const userId = await memberRanked("Gold I");
    await db.update(users).set({ handle: "beko-waiver" }).where(eq(users.id, userId));

    expect((await findMemberByHandle(" @Beko-Waiver ", db))?.id).toBe(userId);
    expect(await findMemberByHandle("nobody-at-all", db)).toBeNull();
    expect(await findMemberByHandle("  ", db)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The authorisation boundary                                         */
/* ------------------------------------------------------------------ */

describe("a waiver reaches exactly one member on exactly one event", () => {
  it("does not let anybody else past the same rule", async () => {
    const event = await gatedEvent();
    const waived = await memberRanked("Gold I");
    const other = await memberRanked("Gold I");
    expectOk(await waiveEntryRule(event.id, waived, "enter", {}, db));

    expectOk(await applyToEvent(event.id, waived, { now: NOW }, db));
    expect(expectFail(await applyToEvent(event.id, other, { now: NOW }, db)).error).toContain(
      ENTER
    );
  });

  it("does not follow the member to another event", async () => {
    const here = await gatedEvent();
    const there = await gatedEvent();
    const userId = await memberRanked("Gold I");
    expectOk(await waiveEntryRule(here.id, userId, "enter", {}, db));

    expectOk(await applyToEvent(here.id, userId, { now: NOW }, db));
    expect(expectFail(await applyToEvent(there.id, userId, { now: NOW }, db)).error).toContain(
      ENTER
    );
    expect(await listEntryWaivers(there.id, db)).toEqual([]);
  });

  it("is not withdrawable through another event's id", async () => {
    /*
     * The shape `event-scope.ts` warns about, asked of the revoke: a manager of
     * `there` passes their own event id (which is what authorises them) and
     * somebody else's member. The statement is scoped to the pair, so it
     * matches nothing and `here`'s waiver is untouched.
     */
    const here = await gatedEvent();
    const there = await gatedEvent();
    const userId = await memberRanked("Gold I");
    expectOk(await waiveEntryRule(here.id, userId, "enter", {}, db));

    expect(expectOk(await revokeEntryWaiver(there.id, userId, "enter", db)).removed).toBe(false);
    expect(await waiverRows(here.id, userId)).toHaveLength(1);
    expectOk(await applyToEvent(here.id, userId, { now: NOW }, db));
  });
});

/* ------------------------------------------------------------------ */
/* The ladder moves underneath it                                     */
/* ------------------------------------------------------------------ */

describe("a waiver survives the ladder it was granted against", () => {
  it("still lets the member in after the threshold's rank is retired", async () => {
    /*
     * Retiring or reordering a ladder is its own feature (`LadderEditor`), and
     * a waiver that stored "past Platinum III" would stop matching an event
     * whose rule had moved — the member would be refused again with nobody
     * having decided that. The row stores the *rule*, so the decision outlives
     * the bar.
     */
    const event = await gatedEvent();
    const userId = await memberRanked("Gold I");
    expectOk(await waiveEntryRule(event.id, userId, "enter", {}, db));

    // The ladder is rewritten with the old threshold gone, and the event's
    // rule is moved to a bar this member still does not meet.
    const rebuilt = ["Gold III", "Gold II", "Gold I", "Emerald III", "Emerald II", "Emerald I"];
    await db
      .update(games)
      .set({ rankLadder: rebuilt })
      .where(eq(games.id, rivalsId));
    // Both thresholds move, because `updateEvent` validates each of them
    // against the ladder the game has now (R-28, R-29 / UC-08 10b).
    expectOk(
      await updateEvent(
        event.id,
        { minRankToEnter: "Emerald II", minRankToCaptain: "Emerald I" },
        db
      )
    );

    const form = await loadApplicationForm(event.id, userId, { now: NOW }, db);
    expect(form?.eligibility.enterCheck.ok).toBe(false);
    expect(form?.eligibility.canEnter).toBe(true);
    expect(form?.eligibility.enterWaived).toBe(true);
    expectOk(await applyToEvent(event.id, userId, { now: NOW }, db));

    // Put the shared game back for whatever runs next in this file.
    await db
      .update(games)
      .set({ rankLadder: [...RIVALS_RANK_LADDER] })
      .where(eq(games.id, rivalsId));
  });
});
