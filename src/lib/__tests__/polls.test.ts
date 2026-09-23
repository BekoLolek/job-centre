import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, pollVotes } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  DETAIL_MAX,
  closePoll,
  createPoll,
  deletePoll,
  isClosed,
  listPolls,
  previewPollEdit,
  updatePoll,
  votePoll,
} from "@/lib/polls";

/**
 * Polls (R-91, R-95, R-166 / UC-23).
 *
 * Three rules carry the feature and every one of them is enforced server-side,
 * because every one of them is the sort of thing somebody would accuse you of
 * doing: a poll has to close at a stated time in the future, a closed poll
 * cannot be edited, and an edit that touches votes already cast says what it
 * touches first.
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

function why(result: { ok: true } | { ok: false; error: string }): string {
  if (result.ok) throw new Error("Expected a refusal, and it was accepted.");
  return result.error;
}

const OPTIONS = [{ label: "Thursday" }, { label: "Friday" }, { label: "Saturday" }];

/** Far enough out that the wall clock never catches it up mid-suite. */
const OPEN_UNTIL = new Date("2999-01-01T00:00:00Z");
const LONG_GONE = new Date("2020-01-01T00:00:00Z");

async function aPoll(over: Partial<Parameters<typeof createPoll>[1]> = {}) {
  const admin = await makeUser(db, { displayName: "Admin" });
  const { id } = unwrap(
    await createPoll(
      admin,
      {
        question: "Which night?",
        multiple: false,
        closesAt: OPEN_UNTIL,
        options: OPTIONS,
        ...over,
      },
      db
    )
  );
  return { id, admin };
}

/** The poll as the page reads it. */
async function read(id: string, viewerId: string | null = null) {
  const poll = (await listPolls(viewerId, db)).find((row) => row.id === id);
  if (!poll) throw new Error("The poll is not in the list.");
  return poll;
}

/**
 * Rows left in `poll_votes` for a poll, asked of the table directly.
 *
 * `listPolls` cannot answer this once the poll is gone, and neither can
 * `votePoll` — which is the trap the delete test below used to fall into.
 */
async function votesOn(pollId: string): Promise<number> {
  const rows = await db
    .select({ userId: pollVotes.userId })
    .from(pollVotes)
    .where(eq(pollVotes.pollId, pollId));
  return rows.length;
}

describe("creating", () => {
  it("keeps the options in the order they were given", async () => {
    // UC-23 1.
    const { id } = await aPoll();
    const poll = await read(id);
    expect(poll.options.map((option) => option.label)).toEqual([
      "Thursday",
      "Friday",
      "Saturday",
    ]);
    expect(poll.closed).toBe(false);
    expect(poll.voterCount).toBe(0);
    expect(poll.closesAt).toEqual(OPEN_UNTIL);
  });

  it("refuses a poll that is not one", async () => {
    // UC-23 1a: fewer than two options, or two that say the same thing.
    const admin = await makeUser(db);
    const base = { question: "Which night?", multiple: false, closesAt: OPEN_UNTIL };
    expect((await createPoll(admin, { ...base, options: [{ label: "Only one" }] }, db)).ok).toBe(false);
    expect((await createPoll(admin, { ...base, question: "x", options: OPTIONS }, db)).ok).toBe(false);
    expect(
      (await createPoll(admin, { ...base, options: [{ label: "A" }, { label: "a" }] }, db)).ok
    ).toBe(false);
  });

  it("insists on a closing time", async () => {
    /*
     * UC-23 1 lists it beside the question and the options, and 6 is the reason
     * why: a poll with no closing time never stops by itself, so it never
     * produces the final result the use case ends on. It waits for somebody to
     * remember it instead.
     */
    const admin = await makeUser(db);
    const missing = await createPoll(
      admin,
      { question: "Which night?", multiple: false, closesAt: null, options: OPTIONS },
      db
    );
    expect(missing.ok).toBe(false);
    expect(why(missing)).toMatch(/closes/i);

    // An unparseable `datetime-local` arrives as an Invalid Date, which is not
    // a time either — and compares false against everything, so it would sail
    // past a naive "is it in the past" test.
    const nonsense = await createPoll(
      admin,
      {
        question: "Which night?",
        multiple: false,
        closesAt: new Date("not a date"),
        options: OPTIONS,
      },
      db
    );
    expect(nonsense.ok).toBe(false);
  });

  it("refuses a closing time that has already passed", async () => {
    /*
     * UC-23 1a. A poll born closed is posted, announced to everybody (UC-25)
     * and then refuses the first vote it is given.
     */
    const admin = await makeUser(db);
    const stale = await createPoll(
      admin,
      { question: "Which night?", multiple: false, closesAt: LONG_GONE, options: OPTIONS },
      db
    );
    expect(stale.ok).toBe(false);
    expect(why(stale)).toMatch(/passed/i);

    // The line is *now*, not midnight: a time one minute out is fine, one
    // minute ago is not.
    const now = new Date("2026-06-01T12:00:00Z");
    const soon = new Date("2026-06-01T12:01:00Z");
    const justGone = new Date("2026-06-01T11:59:00Z");
    const base = { question: "Which night?", multiple: false, options: OPTIONS };
    expect((await createPoll(admin, { ...base, closesAt: soon }, db, now)).ok).toBe(true);
    expect((await createPoll(admin, { ...base, closesAt: justGone }, db, now)).ok).toBe(false);
  });

  it("refuses a description longer than the form would allow (R-166 / UC-23 E1a)", async () => {
    /*
     * The composer caps this at 500 characters and the cap is not the check:
     * `createPollAction` is a POST endpoint, so a description arrives from
     * whatever the caller felt like sending.
     */
    const admin = await makeUser(db);
    const base = { question: "Which night?", multiple: false, closesAt: OPEN_UNTIL, options: OPTIONS };

    const long = await createPoll(admin, { ...base, detail: "x".repeat(DETAIL_MAX + 1) }, db);
    expect(long.ok).toBe(false);
    expect(why(long)).toMatch(/description/i);

    const fits = await createPoll(admin, { ...base, detail: "x".repeat(DETAIL_MAX) }, db);
    expect(fits.ok).toBe(true);
    expect((await read(fits.ok ? fits.data.id : "")).detail).toHaveLength(DETAIL_MAX);
  });

  it("shows the description under the question (R-166 / UC-23 E1)", async () => {
    const { id } = await aPoll({ detail: "  Two hours, eight people.  " });
    expect((await read(id)).detail).toBe("Two hours, eight people.");
  });
});

describe("voting", () => {
  it("replaces the answer on a single-choice poll", async () => {
    const { id } = await aPoll();
    const voter = await makeUser(db);
    const poll = await read(id);

    unwrap(await votePoll(id, voter, poll.options[0].id, db));
    const after = unwrap(await votePoll(id, voter, poll.options[1].id, db));

    expect(after.yours).toEqual([poll.options[1].id]);
    const seen = await read(id, voter);
    expect(seen.voterCount).toBe(1);
    expect(seen.options[0].voters).toHaveLength(0);
    expect(seen.options[1].voters).toHaveLength(1);
  });

  it("takes the vote back when the same option is picked again", async () => {
    const { id } = await aPoll();
    const voter = await makeUser(db);
    const poll = await read(id);

    unwrap(await votePoll(id, voter, poll.options[0].id, db));
    const after = unwrap(await votePoll(id, voter, poll.options[0].id, db));
    expect(after.yours).toEqual([]);
  });

  it("stacks answers on a multiple-choice poll", async () => {
    const { id } = await aPoll({ multiple: true });
    const voter = await makeUser(db);
    const poll = await read(id);

    unwrap(await votePoll(id, voter, poll.options[0].id, db));
    const after = unwrap(await votePoll(id, voter, poll.options[2].id, db));
    expect(after.yours).toHaveLength(2);

    // Two votes, one voter — the count is people, not ticks.
    expect((await read(id, voter)).voterCount).toBe(1);
  });

  it("names who voted for what, because the poll is open like Discord's", async () => {
    const { id } = await aPoll();
    const ada = await makeUser(db, { displayName: "Ada" });
    const poll = await read(id);
    unwrap(await votePoll(id, ada, poll.options[0].id, db));

    expect((await read(id)).options[0].voters.map((voter) => voter.name)).toEqual(["Ada"]);
  });

  it("refuses a vote once the poll has closed", async () => {
    const { id } = await aPoll();
    const voter = await makeUser(db);
    const poll = await read(id);

    await closePoll(id, LONG_GONE, db);
    const result = await votePoll(id, voter, poll.options[0].id, db);
    expect(result.ok).toBe(false);
    expect(why(result)).toMatch(/closed/);
  });

  it("refuses an option from another poll", async () => {
    const first = await aPoll();
    const second = await aPoll();
    const voter = await makeUser(db);
    const other = await read(second.id);

    const result = await votePoll(first.id, voter, other.options[0].id, db);
    expect(result.ok).toBe(false);
  });
});

describe("editing", () => {
  it("changes the question and the options while the poll is open", async () => {
    // UC-23 3.
    const { id } = await aPoll();
    const poll = await read(id);

    unwrap(
      await updatePoll(
        id,
        {
          question: "Which night suits?",
          multiple: false,
          closesAt: OPEN_UNTIL,
          options: [
            { id: poll.options[0].id, label: "Thursday evening" },
            { id: poll.options[1].id, label: "Friday" },
            { label: "Sunday" },
          ],
        },
        db
      )
    );

    const after = await read(id);
    expect(after.question).toBe("Which night suits?");
    expect(after.options.map((option) => option.label)).toEqual([
      "Thursday evening",
      "Friday",
      "Sunday",
    ]);
  });

  it("keeps the votes on an option that survives a rename", async () => {
    const { id } = await aPoll();
    const voter = await makeUser(db);
    const poll = await read(id);
    unwrap(await votePoll(id, voter, poll.options[0].id, db));

    unwrap(
      await updatePoll(
        id,
        {
          question: "Which night?",
          multiple: false,
          closesAt: OPEN_UNTIL,
          options: poll.options.map((option, index) =>
            index === 0
              ? { id: option.id, label: "Thursday (renamed)" }
              : { id: option.id, label: option.label }
          ),
        },
        db
      )
    );

    const after = await read(id);
    expect(after.options[0].label).toBe("Thursday (renamed)");
    expect(after.options[0].voters).toHaveLength(1);
  });

  it("says what removing an option would cost before it costs it", async () => {
    // UC-23 4.
    const { id } = await aPoll();
    const poll = await read(id);
    for (let i = 0; i < 3; i += 1) {
      const voter = await makeUser(db);
      unwrap(await votePoll(id, voter, poll.options[2].id, db));
    }

    const preview = await previewPollEdit(
      id,
      {
        question: "Which night?",
        multiple: false,
        closesAt: OPEN_UNTIL,
        options: [
          { id: poll.options[0].id, label: "Thursday" },
          { id: poll.options[1].id, label: "Friday" },
        ],
      },
      db
    );

    expect(preview.lostVotes).toBe(3);
    expect(preview.droppedOptions).toEqual(["Saturday"]);
    // And nothing has actually gone yet.
    expect((await read(id)).options).toHaveLength(3);
  });

  it("counts the votes a rewording speaks for, which the old preview called free", async () => {
    /*
     * UC-23 4 says "if the change alters an option people voted for" — not
     * "removes". Renaming "Thursday" to "Thursday, 9pm start" keeps every vote
     * on it and changes what each of those people said, and nobody is asked
     * again, so the admin is the only person who can be told.
     */
    const { id } = await aPoll();
    const poll = await read(id);
    for (let i = 0; i < 2; i += 1) {
      const voter = await makeUser(db);
      unwrap(await votePoll(id, voter, poll.options[0].id, db));
    }

    const preview = await previewPollEdit(
      id,
      {
        question: "Which night?",
        multiple: false,
        closesAt: OPEN_UNTIL,
        options: [
          { id: poll.options[0].id, label: "Thursday, 9pm start" },
          // Untouched, and with no votes on it either way.
          { id: poll.options[1].id, label: "Friday" },
          { id: poll.options[2].id, label: "Saturday" },
        ],
      },
      db
    );

    expect(preview.reworded).toEqual([
      { from: "Thursday", to: "Thursday, 9pm start", votes: 2 },
    ]);
    // Nothing is lost by a rewording — it is a different thing to be told.
    expect(preview.lostVotes).toBe(0);
  });

  it("leaves an untouched option out of the rewording list", async () => {
    // Otherwise every save of an unchanged poll would raise a confirm, and a
    // confirm that always appears is a confirm nobody reads.
    const { id } = await aPoll();
    const poll = await read(id);
    const voter = await makeUser(db);
    unwrap(await votePoll(id, voter, poll.options[0].id, db));

    const preview = await previewPollEdit(
      id,
      {
        question: "Which night?",
        multiple: false,
        closesAt: OPEN_UNTIL,
        options: poll.options.map((option) => ({ id: option.id, label: option.label })),
      },
      db
    );

    expect(preview.reworded).toEqual([]);
    expect(preview.lostVotes).toBe(0);
    expect(preview.clearedVoters).toBe(0);
  });

  it("counts what switching to single choice clears, before it clears it", async () => {
    // UC-23 4 again: the votes altered by this edit belong to whoever ticked
    // two boxes under a rule that is about to stop existing.
    const { id } = await aPoll({ multiple: true });
    const greedy = await makeUser(db);
    const modest = await makeUser(db);
    const poll = await read(id);

    unwrap(await votePoll(id, greedy, poll.options[0].id, db));
    unwrap(await votePoll(id, greedy, poll.options[1].id, db));
    unwrap(await votePoll(id, modest, poll.options[0].id, db));

    const draft = {
      question: "Which night?",
      multiple: false,
      closesAt: OPEN_UNTIL,
      options: poll.options.map((option) => ({ id: option.id, label: option.label })),
    };

    const preview = await previewPollEdit(id, draft, db);
    expect(preview.clearedVoters).toBe(1);
    expect(preview.lostVotes).toBe(2);
    // The one holding a single answer keeps it.
    expect((await read(id, modest)).yours).toHaveLength(1);

    // What the preview promised is what the edit then does.
    const result = unwrap(await updatePoll(id, draft, db));
    expect(result.lostVotes).toBe(preview.lostVotes);
  });

  it("discards the votes on an option that is removed", async () => {
    const { id } = await aPoll();
    const voter = await makeUser(db);
    const poll = await read(id);
    unwrap(await votePoll(id, voter, poll.options[2].id, db));

    const result = unwrap(
      await updatePoll(
        id,
        {
          question: "Which night?",
          multiple: false,
          closesAt: OPEN_UNTIL,
          options: [
            { id: poll.options[0].id, label: "Thursday" },
            { id: poll.options[1].id, label: "Friday" },
          ],
        },
        db
      )
    );

    expect(result.lostVotes).toBe(1);
    const after = await read(id, voter);
    expect(after.voterCount).toBe(0);
    expect(after.yours).toEqual([]);
  });

  it("refuses an option id that belongs to another poll", async () => {
    /*
     * The rule the rest of this feature keeps: authorise on the row you are
     * about to write, never on an id beside it. `keeping` used to be built from
     * the *input*, so `keeping.has(option.id)` only ever meant "an id was
     * sent", and the update then ran `where pollOptions.id = ...` with no
     * `pollId` beside it. An admin submitting another poll's option id
     * relabelled that poll's option — a real cross-poll write — and silently
     * failed to add the option they actually meant.
     */
    const mine = await aPoll();
    const theirs = await aPoll();
    const other = await read(theirs.id);

    const result = await updatePoll(
      mine.id,
      {
        question: "Which night?",
        multiple: false,
        closesAt: OPEN_UNTIL,
        options: [
          { id: other.options[0].id, label: "Reached across" },
          { label: "Friday" },
          { label: "Saturday" },
        ],
      },
      db
    );

    expect(result.ok).toBe(false);
    expect(why(result)).toMatch(/not on this poll/i);
    // Neither poll moved: not the one reached for, and not the one being saved.
    expect((await read(theirs.id)).options.map((option) => option.label)).toEqual([
      "Thursday",
      "Friday",
      "Saturday",
    ]);
    expect((await read(mine.id)).options.map((option) => option.label)).toEqual([
      "Thursday",
      "Friday",
      "Saturday",
    ]);
  });

  it("refuses any edit once the poll has closed", async () => {
    // UC-23 3a.
    const { id } = await aPoll();
    await closePoll(id, LONG_GONE, db);

    const result = await updatePoll(
      id,
      {
        question: "Sneaky rewording",
        multiple: false,
        closesAt: OPEN_UNTIL,
        options: OPTIONS,
      },
      db
    );
    expect(result.ok).toBe(false);
    expect(why(result)).toMatch(/closed/);
  });

  it("refuses an edit that takes the closing time away", async () => {
    // The rule holds on the way through as well as at the start: an edit is
    // the other way a poll could end up with no ending.
    const { id } = await aPoll();
    const result = await updatePoll(
      id,
      { question: "Which night?", multiple: false, closesAt: null, options: OPTIONS },
      db
    );
    expect(result.ok).toBe(false);
    expect(why(result)).toMatch(/closes/i);
  });

  it("clears anybody holding several votes when a poll becomes single-choice", async () => {
    const { id } = await aPoll({ multiple: true });
    const greedy = await makeUser(db);
    const modest = await makeUser(db);
    const poll = await read(id);

    unwrap(await votePoll(id, greedy, poll.options[0].id, db));
    unwrap(await votePoll(id, greedy, poll.options[1].id, db));
    unwrap(await votePoll(id, modest, poll.options[0].id, db));

    unwrap(
      await updatePoll(
        id,
        {
          question: "Which night?",
          multiple: false,
          closesAt: OPEN_UNTIL,
          options: poll.options.map((option) => ({ id: option.id, label: option.label })),
        },
        db
      )
    );

    // The one holding two is asked again rather than having one picked for them.
    expect((await read(id, greedy)).yours).toEqual([]);
    expect((await read(id, modest)).yours).toHaveLength(1);
  });
});

describe("closing", () => {
  it("is a time, not a flag", () => {
    // UC-23 5a: the closing time passing is the closing.
    expect(isClosed(LONG_GONE)).toBe(true);
    expect(isClosed(OPEN_UNTIL)).toBe(false);
  });

  it("says so when there was nothing to close", async () => {
    // Same reason as the delete below: `poll.closed` in the audit log has to
    // mean a poll actually closed.
    const { id } = await aPoll();
    unwrap(await deletePoll(id, db));

    const result = await closePoll(id, LONG_GONE, db);
    expect(result.ok).toBe(false);
    expect(why(result)).toMatch(/gone/i);
  });

  it("sorts open polls above closed ones", async () => {
    const shut = await aPoll({ question: "Old question" });
    const live = await aPoll({ question: "Live question" });
    await closePoll(shut.id, LONG_GONE, db);

    // Relative order against the shared database — a fresh one per test costs
    // a dozen migrations, which is what used to time this suite out.
    const list = await listPolls(null, db);
    const at = (id: string) => list.findIndex((poll) => poll.id === id);
    expect(at(live.id)).toBeLessThan(at(shut.id));
    expect(list.find((poll) => poll.id === shut.id)?.closed).toBe(true);
  });
});

describe("deleting", () => {
  it("takes the poll and every vote on it", async () => {
    // UC-23 5b.
    const { id } = await aPoll();
    const voter = await makeUser(db);
    const poll = await read(id);
    unwrap(await votePoll(id, voter, poll.options[0].id, db));
    expect(await votesOn(id)).toBe(1);

    unwrap(await deletePoll(id, db));
    expect((await listPolls(null, db)).some((row) => row.id === id)).toBe(false);

    /*
     * The votes went by cascade rather than being left pointing at nothing —
     * asked of `poll_votes` itself. The stand-in this used to make do with was
     * that voting again is refused, which is answered by `votePoll`'s
     * missing-*poll* branch long before it reaches an option, and would hold
     * just as well with every vote still sitting in the table.
     */
    expect(await votesOn(id)).toBe(0);
  });

  it("says so when there was nothing to delete", async () => {
    /*
     * `deletePollAction` writes "Deleted a poll, and the votes on it" to the
     * audit log off the back of this. Two admins on the same poll, or one on a
     * page that went stale, must not both have that sentence written against
     * their name — so the second one is told the poll has gone instead.
     */
    const { id } = await aPoll();
    unwrap(await deletePoll(id, db));

    const again = await deletePoll(id, db);
    expect(again.ok).toBe(false);
    expect(why(again)).toMatch(/gone/i);
  });
});
