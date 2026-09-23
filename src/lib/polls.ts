import { and, eq, inArray } from "drizzle-orm";
import {
  type Database,
  db as defaultDb,
  pollOptions,
  pollVotes,
  polls,
  users,
} from "@/db";

/**
 * Polls, open like Discord's.
 *
 * Counts are public and so is who voted for what. That is a decision, not an
 * oversight: a poll about which night suits people is far more useful when you
 * can see *who* said Thursday, and a community that needs a secret ballot needs
 * a different feature rather than this one with the names hidden. The screen
 * says so before anybody votes.
 *
 * ## The closing time (R-91 / UC-23 1, 1a)
 *
 * Required, and in the future. A poll with no closing time never reaches UC-23
 * 6 by itself — it waits for an admin to remember it — and one that closes in
 * the past is born closed, which means it is posted, announced to everybody
 * (UC-25) and refuses the first vote it gets.
 *
 * ## The editing rule
 *
 * Before the closing time an admin may still change the question and the
 * options; after it, nothing moves. A poll whose wording can change after the
 * result is a poll that proves nothing, and "we closed it and then reworded the
 * question" is the exact accusation this rule exists to make impossible.
 *
 * UC-23 4 is the softer half of the same idea: an edit that *does* land while
 * the poll is open has to say what it costs first. Three things cost something,
 * and {@link previewPollEdit} counts all three — an option removed takes its
 * votes with it, an option reworded leaves people having answered a question
 * that now reads differently, and a multiple-choice poll turned single-choice
 * cannot keep anybody who ticked two boxes.
 */

export const QUESTION_MAX = 200;
export const DETAIL_MAX = 500;
export const OPTION_MAX = 100;
export const MAX_OPTIONS = 20;
export const MIN_OPTIONS = 2;

export type PollOption = {
  id: string;
  label: string;
  /** Everyone who picked it, in the order they did. */
  voters: Array<{ id: string; name: string; handle: string | null }>;
};

export type Poll = {
  id: string;
  question: string;
  detail: string | null;
  multiple: boolean;
  closesAt: Date;
  closed: boolean;
  createdAt: Date;
  by: { id: string; name: string } | null;
  options: PollOption[];
  /** People who voted at all, not the sum of the options — a multi-choice poll double-counts. */
  voterCount: number;
  /** Option ids the reader picked. */
  yours: string[];
};

export type PollResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Shut, as of now. */
export function isClosed(closesAt: Date, now: Date = new Date()): boolean {
  return closesAt.getTime() <= now.getTime();
}

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

export async function listPolls(
  viewerId: string | null,
  database: Database = defaultDb,
  now: Date = new Date()
): Promise<Poll[]> {
  const rows = await database
    .select({
      id: polls.id,
      question: polls.question,
      detail: polls.detail,
      multiple: polls.multiple,
      closesAt: polls.closesAt,
      createdAt: polls.createdAt,
      byId: users.id,
      byDisplayName: users.displayName,
      byName: users.name,
      byHandle: users.handle,
    })
    .from(polls)
    .leftJoin(users, eq(users.id, polls.createdByUserId));

  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const options = await database
    .select({
      id: pollOptions.id,
      pollId: pollOptions.pollId,
      label: pollOptions.label,
      sort: pollOptions.sort,
    })
    .from(pollOptions)
    .where(inArray(pollOptions.pollId, ids));

  const votes = await database
    .select({
      pollId: pollVotes.pollId,
      optionId: pollVotes.optionId,
      userId: pollVotes.userId,
      createdAt: pollVotes.createdAt,
      voterDisplayName: users.displayName,
      voterName: users.name,
      voterHandle: users.handle,
    })
    .from(pollVotes)
    .leftJoin(users, eq(users.id, pollVotes.userId))
    .where(inArray(pollVotes.pollId, ids));

  return rows
    .map((row) => {
      const mine = votes.filter((vote) => vote.pollId === row.id);
      const voters = new Set(mine.map((vote) => vote.userId));

      return {
        id: row.id,
        question: row.question,
        detail: row.detail,
        multiple: row.multiple,
        closesAt: row.closesAt,
        closed: isClosed(row.closesAt, now),
        createdAt: row.createdAt,
        by: row.byId
          ? { id: row.byId, name: row.byDisplayName ?? row.byName ?? row.byHandle ?? "Admin" }
          : null,
        options: options
          .filter((option) => option.pollId === row.id)
          .sort((a, b) => a.sort - b.sort)
          .map((option) => ({
            id: option.id,
            label: option.label,
            voters: mine
              .filter((vote) => vote.optionId === option.id)
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
              .map((vote) => ({
                id: vote.userId,
                name: vote.voterDisplayName ?? vote.voterName ?? vote.voterHandle ?? "Member",
                handle: vote.voterHandle,
              })),
          })),
        voterCount: voters.size,
        yours: viewerId
          ? mine.filter((vote) => vote.userId === viewerId).map((vote) => vote.optionId)
          : [],
      };
    })
    // Open first, then newest. A closed poll is a record; an open one is a question.
    .sort(
      (a, b) =>
        Number(a.closed) - Number(b.closed) || b.createdAt.getTime() - a.createdAt.getTime()
    );
}

/* ------------------------------------------------------------------ */
/* Writing                                                            */
/* ------------------------------------------------------------------ */

export type PollInput = {
  question: string;
  detail?: string | null;
  multiple: boolean;
  /**
   * Required. Typed nullable all the same, because the browser sends an empty
   * `datetime-local` as nothing and a POST straight at the action can send
   * anything at all — a rule that cannot be expressed cannot be refused.
   */
  closesAt: Date | null;
  /** Existing options keep their id and their votes; new ones have none. */
  options: Array<{ id?: string; label: string }>;
};

function refusal(input: PollInput, now: Date): string | null {
  const question = input.question.trim();
  if (question.length < 3) return "Give the poll a question.";
  if (question.length > QUESTION_MAX) {
    return `Keep the question under ${QUESTION_MAX} characters.`;
  }

  // R-166 / UC-23 E1a. Checked here and not only by the form's `maxLength`:
  // a server action is a public endpoint, so the form is a courtesy.
  if ((input.detail ?? "").trim().length > DETAIL_MAX) {
    return `Keep the description under ${DETAIL_MAX} characters.`;
  }

  if (input.closesAt === null || Number.isNaN(input.closesAt.getTime())) {
    return "Say when the poll closes.";
  }
  if (isClosed(input.closesAt, now)) {
    return "That closing time has already passed — pick one in the future.";
  }

  const labels = input.options.map((option) => option.label.trim()).filter(Boolean);
  if (labels.length < MIN_OPTIONS) return `A poll needs at least ${MIN_OPTIONS} options.`;
  if (labels.length > MAX_OPTIONS) return `A poll can have at most ${MAX_OPTIONS} options.`;
  if (labels.some((label) => label.length > OPTION_MAX)) {
    return `Keep each option under ${OPTION_MAX} characters.`;
  }
  if (new Set(labels.map((label) => label.toLowerCase())).size !== labels.length) {
    return "Two options say the same thing.";
  }
  return null;
}

export async function createPoll(
  createdByUserId: string,
  input: PollInput,
  database: Database = defaultDb,
  now: Date = new Date()
): Promise<PollResult<{ id: string }>> {
  const bad = refusal(input, now);
  if (bad) return { ok: false, error: bad };
  // `refusal` has just proved this; the column is `not null` and TypeScript
  // cannot see across the function boundary.
  const closesAt = input.closesAt as Date;

  return database.transaction(async (tx) => {
    const [poll] = await tx
      .insert(polls)
      .values({
        question: input.question.trim(),
        detail: input.detail?.trim() || null,
        multiple: input.multiple,
        closesAt,
        createdByUserId,
      })
      .returning({ id: polls.id });

    await tx.insert(pollOptions).values(
      input.options
        .map((option) => option.label.trim())
        .filter(Boolean)
        .map((label, index) => ({ pollId: poll.id, label, sort: index }))
    );

    return { ok: true as const, data: { id: poll.id } };
  });
}

/**
 * What editing this poll would cost, asked before the edit is made (UC-23 4).
 *
 * Read-only. Three separate costs, kept separate because they are not the same
 * thing to be told:
 *
 * - `lostVotes` — answers that will not exist afterwards. The votes on options
 *   being removed, plus everybody cleared by the poll becoming single-choice.
 *   This is the number `updatePoll` returns, and the two are asserted equal.
 * - `reworded` — options that keep their votes while changing what those votes
 *   said. Nobody is asked again, so the admin is told who they are speaking
 *   for.
 * - `clearedVoters` — people holding more than one answer when the poll stops
 *   allowing that.
 *
 * Every vote is counted under one heading only, the most severe that applies,
 * so the three numbers add up rather than overlapping.
 */
export type PollEditPreview = {
  closed: boolean;
  lostVotes: number;
  droppedOptions: string[];
  reworded: Array<{ from: string; to: string; votes: number }>;
  /** People cleared because the poll stops letting them hold several answers. */
  clearedVoters: number;
};

/**
 * The answer for a poll that is not there: nothing changes, because there is
 * nothing to change.
 *
 * A function rather than a shared constant. The value carries two arrays, and a
 * constant hands every caller the same two — so a caller that ever sorted or
 * pushed to one would be editing the answer every later caller gets. Nothing
 * does that today, which is exactly why it is cheap to make impossible now.
 */
function noEdit(): PollEditPreview {
  return {
    closed: false,
    lostVotes: 0,
    droppedOptions: [],
    reworded: [],
    clearedVoters: 0,
  };
}

export async function previewPollEdit(
  pollId: string,
  input: PollInput,
  database: Database = defaultDb,
  now: Date = new Date()
): Promise<PollEditPreview> {
  const [poll] = await database
    .select({ closesAt: polls.closesAt })
    .from(polls)
    .where(eq(polls.id, pollId));
  if (!poll) return noEdit();

  const existing = await database
    .select({ id: pollOptions.id, label: pollOptions.label })
    .from(pollOptions)
    .where(eq(pollOptions.pollId, pollId));

  const votes = await database
    .select({ optionId: pollVotes.optionId, userId: pollVotes.userId })
    .from(pollVotes)
    .where(eq(pollVotes.pollId, pollId));

  const keeping = new Set(input.options.map((option) => option.id).filter(Boolean));
  const dropping = existing.filter((option) => !keeping.has(option.id));
  const dropped = new Set(dropping.map((option) => option.id));

  // What is still standing after the removals — everything below is measured
  // against that, in the same order `updatePoll` does the work.
  let surviving = votes.filter((vote) => !dropped.has(vote.optionId));
  let lostVotes = votes.length - surviving.length;

  let clearedVoters = 0;
  if (!input.multiple) {
    const held = new Map<string, number>();
    for (const vote of surviving) held.set(vote.userId, (held.get(vote.userId) ?? 0) + 1);
    const overloaded = new Set(
      [...held.entries()].filter(([, count]) => count > 1).map(([id]) => id)
    );
    if (overloaded.size > 0) {
      clearedVoters = overloaded.size;
      const before = surviving.length;
      surviving = surviving.filter((vote) => !overloaded.has(vote.userId));
      lostVotes += before - surviving.length;
    }
  }

  const reworded: PollEditPreview["reworded"] = [];
  for (const option of input.options) {
    if (!option.id || dropped.has(option.id)) continue;
    const was = existing.find((row) => row.id === option.id);
    const label = option.label.trim();
    if (!was || was.label === label) continue;

    const affected = surviving.filter((vote) => vote.optionId === option.id).length;
    if (affected > 0) reworded.push({ from: was.label, to: label, votes: affected });
  }

  return {
    closed: isClosed(poll.closesAt, now),
    lostVotes,
    droppedOptions: dropping.map((option) => option.label),
    reworded,
    clearedVoters,
  };
}

/**
 * Change a poll that is still open.
 *
 * The closed check is here and not only on the screen, because "the button was
 * enabled when the page loaded" is not an argument — a poll can close between
 * the render and the click, and that is exactly the moment somebody would want
 * to sneak an edit in.
 */
export async function updatePoll(
  pollId: string,
  input: PollInput,
  database: Database = defaultDb,
  now: Date = new Date()
): Promise<PollResult<{ lostVotes: number }>> {
  const bad = refusal(input, now);
  if (bad) return { ok: false, error: bad };
  const closesAt = input.closesAt as Date;

  return database.transaction(async (tx) => {
    const [poll] = await tx
      .select({ closesAt: polls.closesAt })
      .from(polls)
      .where(eq(polls.id, pollId));
    if (!poll) return { ok: false as const, error: "That poll has gone." };
    if (isClosed(poll.closesAt, now)) {
      return {
        ok: false as const,
        error: "That poll has closed. A closed poll cannot be edited — the result stands.",
      };
    }

    const existing = await tx
      .select({ id: pollOptions.id })
      .from(pollOptions)
      .where(eq(pollOptions.pollId, pollId));

    /*
     * Two sets, and the difference between them is the point.
     *
     * `claimed` is what the *input* says it is keeping, and it is only good for
     * working out what has been dropped. `keeping` is what this poll actually
     * has, read back a moment ago inside this transaction, and it is what the
     * update further down is allowed to write to. Built the other way round —
     * from the input — `keeping.has(option.id)` collapses into "an id was
     * sent", and the update then runs against whatever id the caller named: an
     * admin posting another poll's option id relabels *that* poll's option and
     * silently fails to add the one they meant. Authorise on the row you are
     * about to write, never on an id beside it.
     */
    const claimed = new Set(input.options.map((option) => option.id).filter(Boolean));
    const keeping = new Set(existing.map((option) => option.id));
    const dropping = existing.filter((option) => !claimed.has(option.id));

    // And an id this poll does not have is refused outright rather than quietly
    // turned into a new option: it is a stale form or somebody reaching across
    // polls, and neither is an edit that can be carried out as asked.
    if (input.options.some((option) => option.id && !keeping.has(option.id))) {
      return { ok: false as const, error: "That option is not on this poll." };
    }

    let lostVotes = 0;
    if (dropping.length > 0) {
      const doomed = await tx
        .select({ optionId: pollVotes.optionId })
        .from(pollVotes)
        .where(
          inArray(
            pollVotes.optionId,
            dropping.map((option) => option.id)
          )
        );
      lostVotes = doomed.length;
      // The votes go by cascade when the option does.
      await tx.delete(pollOptions).where(
        inArray(
          pollOptions.id,
          dropping.map((option) => option.id)
        )
      );
    }

    await tx
      .update(polls)
      .set({
        question: input.question.trim(),
        detail: input.detail?.trim() || null,
        multiple: input.multiple,
        closesAt,
        updatedAt: new Date(),
      })
      .where(eq(polls.id, pollId));

    let sort = 0;
    for (const option of input.options) {
      const label = option.label.trim();
      if (!label) continue;
      if (option.id && keeping.has(option.id)) {
        await tx
          .update(pollOptions)
          .set({ label, sort })
          .where(and(eq(pollOptions.id, option.id), eq(pollOptions.pollId, pollId)));
      } else {
        await tx.insert(pollOptions).values({ pollId, label, sort });
      }
      sort += 1;
    }

    /*
     * Going from multiple to single leaves people holding several votes, which
     * the new rule says is impossible. Rather than pick one for them — which
     * would be inventing an answer they did not give — everybody with more
     * than one is cleared and asked again.
     */
    if (!input.multiple) {
      const all = await tx
        .select({ userId: pollVotes.userId, optionId: pollVotes.optionId })
        .from(pollVotes)
        .where(eq(pollVotes.pollId, pollId));
      const counts = new Map<string, number>();
      for (const vote of all) counts.set(vote.userId, (counts.get(vote.userId) ?? 0) + 1);
      const overloaded = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
      if (overloaded.length > 0) {
        await tx
          .delete(pollVotes)
          .where(and(eq(pollVotes.pollId, pollId), inArray(pollVotes.userId, overloaded)));
        lostVotes += all.filter((vote) => overloaded.includes(vote.userId)).length;
      }
    }

    return { ok: true as const, data: { lostVotes } };
  });
}

/**
 * Close it now, or set a time (R-95 / UC-23 5). Closing is the one edit a
 * closed poll allows nothing after.
 *
 * Says whether it closed anything, rather than returning nothing whatever
 * happened. `closePollAction` writes a "Closed a poll" line to the audit log
 * off the back of this, and a line about a poll that had already been deleted
 * is a log that says something untrue — the same reason `setSuggestionStatus`
 * refuses instead of shrugging.
 */
export async function closePoll(
  pollId: string,
  at: Date = new Date(),
  database: Database = defaultDb
): Promise<PollResult<undefined>> {
  const closed = await database
    .update(polls)
    .set({ closesAt: at, updatedAt: new Date() })
    .where(eq(polls.id, pollId))
    .returning({ id: polls.id });

  if (closed.length === 0) return { ok: false, error: "That poll has gone." };
  return { ok: true, data: undefined };
}

/**
 * Remove a poll and, by cascade, every vote on it (R-95 / UC-23 5b).
 *
 * Reports what it removed, for the same reason {@link closePoll} does: the
 * audit line says "Deleted a poll, and the votes on it", and two admins pressing
 * Delete on the same poll should not write that sentence twice.
 */
export async function deletePoll(
  pollId: string,
  database: Database = defaultDb
): Promise<PollResult<undefined>> {
  const gone = await database
    .delete(polls)
    .where(eq(polls.id, pollId))
    .returning({ id: polls.id });

  if (gone.length === 0) return { ok: false, error: "That poll has gone." };
  return { ok: true, data: undefined };
}

/**
 * Cast, change or withdraw a vote.
 *
 * Single-choice replaces whatever they had. Multiple-choice toggles the one
 * option, so unticking the last box leaves them having voted for nothing —
 * which is a real answer and not the same as never having voted.
 */
export async function votePoll(
  pollId: string,
  userId: string,
  optionId: string,
  database: Database = defaultDb,
  now: Date = new Date()
): Promise<PollResult<{ yours: string[] }>> {
  return database.transaction(async (tx) => {
    const [poll] = await tx
      .select({ multiple: polls.multiple, closesAt: polls.closesAt })
      .from(polls)
      .where(eq(polls.id, pollId));
    if (!poll) return { ok: false as const, error: "That poll has gone." };
    if (isClosed(poll.closesAt, now)) {
      return { ok: false as const, error: "That poll has closed." };
    }

    const [option] = await tx
      .select({ id: pollOptions.id })
      .from(pollOptions)
      .where(and(eq(pollOptions.id, optionId), eq(pollOptions.pollId, pollId)));
    if (!option) return { ok: false as const, error: "That option is not on this poll." };

    const held = await tx
      .select({ optionId: pollVotes.optionId })
      .from(pollVotes)
      .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, userId)));
    const already = held.some((vote) => vote.optionId === optionId);

    if (poll.multiple) {
      if (already) {
        await tx
          .delete(pollVotes)
          .where(and(eq(pollVotes.optionId, optionId), eq(pollVotes.userId, userId)));
      } else {
        await tx.insert(pollVotes).values({ pollId, optionId, userId });
      }
    } else {
      await tx
        .delete(pollVotes)
        .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, userId)));
      // Clicking the one you already had is how you take it back.
      if (!already) await tx.insert(pollVotes).values({ pollId, optionId, userId });
    }

    const now2 = await tx
      .select({ optionId: pollVotes.optionId })
      .from(pollVotes)
      .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, userId)));

    return { ok: true as const, data: { yours: now2.map((vote) => vote.optionId) } };
  });
}
