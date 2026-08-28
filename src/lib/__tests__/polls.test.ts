import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { type TestDatabase, freshDatabase, makeUser } from "@/db/__tests__/helpers";
import {
  closePoll,
  createPoll,
  isClosed,
  listPolls,
  previewPollEdit,
  updatePoll,
  votePoll,
} from "@/lib/polls";

/**
 * Polls.
 *
 * Two rules carry the feature and both are enforced server-side, because both
 * are the sort of thing somebody would accuse you of doing: a closed poll
 * cannot be edited, and an edit that discards votes says how many first.
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

const OPTIONS = [{ label: "Thursday" }, { label: "Friday" }, { label: "Saturday" }];

async function aPoll(over: Partial<Parameters<typeof createPoll>[1]> = {}) {
  const admin = await makeUser(db, { displayName: "Admin" });
  const { id } = unwrap(
    await createPoll(
      admin,
      {
        question: "Which night?",
        multiple: false,
        closesAt: null,
        options: OPTIONS,
        ...over,
      },
      db
    )
  );
  return { id, admin };
}

describe("creating", () => {
  it("keeps the options in the order they were given", async () => {
    const { id } = await aPoll();
    const poll = (await listPolls(null, db)).find((row) => row.id === id)!;
    expect(poll.options.map((option) => option.label)).toEqual([
      "Thursday",
      "Friday",
      "Saturday",
    ]);
    expect(poll.closed).toBe(false);
    expect(poll.voterCount).toBe(0);
  });

  it("refuses a poll that is not one", async () => {
    const admin = await makeUser(db);
    const base = { question: "Which night?", multiple: false, closesAt: null };
    expect((await createPoll(admin, { ...base, options: [{ label: "Only one" }] }, db)).ok).toBe(false);
    expect((await createPoll(admin, { ...base, question: "x", options: OPTIONS }, db)).ok).toBe(false);
    expect(
      (await createPoll(admin, { ...base, options: [{ label: "A" }, { label: "a" }] }, db)).ok
    ).toBe(false);
  });
});

describe("voting", () => {
  it("replaces the answer on a single-choice poll", async () => {
    const { id } = await aPoll();
    const voter = await makeUser(db);
    const poll = (await listPolls(null, db)).find((row) => row.id === id)!;

    unwrap(await votePoll(id, voter, poll.options[0].id, db));
    const after = unwrap(await votePoll(id, voter, poll.options[1].id, db));

    expect(after.yours).toEqual([poll.options[1].id]);
    const read = (await listPolls(voter, db)).find((row) => row.id === id)!;
    expect(read.voterCount).toBe(1);
    expect(read.options[0].voters).toHaveLength(0);
    expect(read.options[1].voters).toHaveLength(1);
  });

  it("takes the vote back when the same option is picked again", async () => {
    const { id } = await aPoll();
    const voter = await makeUser(db);
    const poll = (await listPolls(null, db)).find((row) => row.id === id)!;

    unwrap(await votePoll(id, voter, poll.options[0].id, db));
    const after = unwrap(await votePoll(id, voter, poll.options[0].id, db));
    expect(after.yours).toEqual([]);
  });

  it("stacks answers on a multiple-choice poll", async () => {
    const { id } = await aPoll({ multiple: true });
    const voter = await makeUser(db);
    const poll = (await listPolls(null, db)).find((row) => row.id === id)!;

    unwrap(await votePoll(id, voter, poll.options[0].id, db));
    const after = unwrap(await votePoll(id, voter, poll.options[2].id, db));
    expect(after.yours).toHaveLength(2);

    const read = (await listPolls(voter, db)).find((row) => row.id === id)!;
    // Two votes, one voter — the count is people, not ticks.
    expect(read.voterCount).toBe(1);
  });

  it("names who voted for what, because the poll is open like Discord's", async () => {
    const { id } = await aPoll();
    const ada = await makeUser(db, { displayName: "Ada" });
    const poll = (await listPolls(null, db)).find((row) => row.id === id)!;
    unwrap(await votePoll(id, ada, poll.options[0].id, db));

    const read = (await listPolls(null, db)).find((row) => row.id === id)!;
    expect(read.options[0].voters.map((voter) => voter.name)).toEqual(["Ada"]);
  });

  it("refuses a vote once the poll has closed", async () => {
    const { id } = await aPoll();
    const voter = await makeUser(db);
    const poll = (await listPolls(null, db)).find((row) => row.id === id)!;

    await closePoll(id, new Date("2020-01-01T00:00:00Z"), db);
    const result = await votePoll(id, voter, poll.options[0].id, db);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/closed/);
  });

  it("refuses an option from another poll", async () => {
    const first = await aPoll();
    const second = await aPoll();
    const voter = await makeUser(db);
    const other = (await listPolls(null, db)).find((row) => row.id === second.id)!;

    const result = await votePoll(first.id, voter, other.options[0].id, db);
    expect(result.ok).toBe(false);
  });
});

describe("editing", () => {
  it("changes the question and the options while the poll is open", async () => {
    const { id } = await aPoll();
    const poll = (await listPolls(null, db)).find((row) => row.id === id)!;

    unwrap(
      await updatePoll(
        id,
        {
          question: "Which night suits?",
          multiple: false,
          closesAt: null,
          options: [
            { id: poll.options[0].id, label: "Thursday evening" },
            { id: poll.options[1].id, label: "Friday" },
            { label: "Sunday" },
          ],
        },
        db
      )
    );

    const after = (await listPolls(null, db)).find((row) => row.id === id)!;
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
    const poll = (await listPolls(null, db)).find((row) => row.id === id)!;
    unwrap(await votePoll(id, voter, poll.options[0].id, db));

    unwrap(
      await updatePoll(
        id,
        {
          question: "Which night?",
          multiple: false,
          closesAt: null,
          options: poll.options.map((option, index) =>
            index === 0 ? { id: option.id, label: "Thursday (renamed)" } : { id: option.id, label: option.label }
          ),
        },
        db
      )
    );

    const after = (await listPolls(null, db)).find((row) => row.id === id)!;
    expect(after.options[0].label).toBe("Thursday (renamed)");
    expect(after.options[0].voters).toHaveLength(1);
  });

  it("says what removing an option would cost before it costs it", async () => {
    const { id } = await aPoll();
    const poll = (await listPolls(null, db)).find((row) => row.id === id)!;
    for (let i = 0; i < 3; i += 1) {
      const voter = await makeUser(db);
      unwrap(await votePoll(id, voter, poll.options[2].id, db));
    }

    const preview = await previewPollEdit(
      id,
      {
        question: "Which night?",
        multiple: false,
        closesAt: null,
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
    const still = (await listPolls(null, db)).find((row) => row.id === id)!;
    expect(still.options).toHaveLength(3);
  });

  it("discards the votes on an option that is removed", async () => {
    const { id } = await aPoll();
    const voter = await makeUser(db);
    const poll = (await listPolls(null, db)).find((row) => row.id === id)!;
    unwrap(await votePoll(id, voter, poll.options[2].id, db));

    const result = unwrap(
      await updatePoll(
        id,
        {
          question: "Which night?",
          multiple: false,
          closesAt: null,
          options: [
            { id: poll.options[0].id, label: "Thursday" },
            { id: poll.options[1].id, label: "Friday" },
          ],
        },
        db
      )
    );

    expect(result.lostVotes).toBe(1);
    const after = (await listPolls(voter, db)).find((row) => row.id === id)!;
    expect(after.voterCount).toBe(0);
    expect(after.yours).toEqual([]);
  });

  it("refuses any edit once the poll has closed", async () => {
    const { id } = await aPoll();
    await closePoll(id, new Date("2020-01-01T00:00:00Z"), db);

    const result = await updatePoll(
      id,
      { question: "Sneaky rewording", multiple: false, closesAt: null, options: OPTIONS },
      db
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/closed/);
  });

  it("clears anybody holding several votes when a poll becomes single-choice", async () => {
    const { id } = await aPoll({ multiple: true });
    const greedy = await makeUser(db);
    const modest = await makeUser(db);
    const poll = (await listPolls(null, db)).find((row) => row.id === id)!;

    unwrap(await votePoll(id, greedy, poll.options[0].id, db));
    unwrap(await votePoll(id, greedy, poll.options[1].id, db));
    unwrap(await votePoll(id, modest, poll.options[0].id, db));

    unwrap(
      await updatePoll(
        id,
        {
          question: "Which night?",
          multiple: false,
          closesAt: null,
          options: poll.options.map((option) => ({ id: option.id, label: option.label })),
        },
        db
      )
    );

    const after = (await listPolls(greedy, db)).find((row) => row.id === id)!;
    // The one holding two is asked again rather than having one picked for them.
    expect(after.yours).toEqual([]);
    const forModest = (await listPolls(modest, db)).find((row) => row.id === id)!;
    expect(forModest.yours).toHaveLength(1);
  });
});

describe("closing", () => {
  it("is a time, not a flag", () => {
    expect(isClosed(null)).toBe(false);
    expect(isClosed(new Date("2020-01-01T00:00:00Z"))).toBe(true);
    expect(isClosed(new Date("2999-01-01T00:00:00Z"))).toBe(false);
  });

  it("sorts open polls above closed ones", async () => {
    const shut = await aPoll({ question: "Old question" });
    const live = await aPoll({ question: "Live question" });
    await closePoll(shut.id, new Date("2020-01-01T00:00:00Z"), db);

    // Relative order against the shared database — a fresh one per test costs
    // nine migrations, which is what used to time this suite out.
    const list = await listPolls(null, db);
    const at = (id: string) => list.findIndex((poll) => poll.id === id);
    expect(at(live.id)).toBeLessThan(at(shut.id));
    expect(list.find((poll) => poll.id === shut.id)?.closed).toBe(true);
  });
});
