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
 * ## The editing rule
 *
 * Before the closing time an admin may still change the question and the
 * options; after it, nothing moves. A poll whose wording can change after the
 * result is a poll that proves nothing, and "we closed it and then reworded the
 * question" is the exact accusation this rule exists to make impossible.
 *
 * Removing an option that already has votes discards them. That cannot be
 * avoided — the votes were for a thing that no longer exists — so the count is
 * returned before the edit is made and the screen has to say it out loud.
 */

export const QUESTION_MAX = 200;
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
  closesAt: Date | null;
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

/** Shut, as of now. A poll with no closing time never is. */
export function isClosed(closesAt: Date | null, now: Date = new Date()): boolean {
  return closesAt !== null && closesAt.getTime() <= now.getTime();
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
  closesAt: Date | null;
  /** Existing options keep their id and their votes; new ones have none. */
  options: Array<{ id?: string; label: string }>;
};

function refusal(input: PollInput): string | null {
  const question = input.question.trim();
  if (question.length < 3) return "Give the poll a question.";
  if (question.length > QUESTION_MAX) {
    return `Keep the question under ${QUESTION_MAX} characters.`;
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
  database: Database = defaultDb
): Promise<PollResult<{ id: string }>> {
  const bad = refusal(input);
  if (bad) return { ok: false, error: bad };

  return database.transaction(async (tx) => {
    const [poll] = await tx
      .insert(polls)
      .values({
        question: input.question.trim(),
        detail: input.detail?.trim() || null,
        multiple: input.multiple,
        closesAt: input.closesAt,
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
 * What editing this poll would cost, asked before the edit is made.
 *
 * `lostVotes` counts the votes on options the edit drops. It is read-only, and
 * the screen shows it in the confirm — an edit that silently discards eleven
 * people's answers is the sort of thing that gets noticed a week later by the
 * eleven people.
 */
export async function previewPollEdit(
  pollId: string,
  input: PollInput,
  database: Database = defaultDb
): Promise<{ closed: boolean; lostVotes: number; droppedOptions: string[] }> {
  const [poll] = await database
    .select({ closesAt: polls.closesAt })
    .from(polls)
    .where(eq(polls.id, pollId));
  if (!poll) return { closed: false, lostVotes: 0, droppedOptions: [] };

  const existing = await database
    .select({ id: pollOptions.id, label: pollOptions.label })
    .from(pollOptions)
    .where(eq(pollOptions.pollId, pollId));

  const keeping = new Set(input.options.map((option) => option.id).filter(Boolean));
  const dropping = existing.filter((option) => !keeping.has(option.id));
  if (dropping.length === 0) {
    return { closed: isClosed(poll.closesAt), lostVotes: 0, droppedOptions: [] };
  }

  const votes = await database
    .select({ optionId: pollVotes.optionId })
    .from(pollVotes)
    .where(
      inArray(
        pollVotes.optionId,
        dropping.map((option) => option.id)
      )
    );

  return {
    closed: isClosed(poll.closesAt),
    lostVotes: votes.length,
    droppedOptions: dropping.map((option) => option.label),
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
  const bad = refusal(input);
  if (bad) return { ok: false, error: bad };

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

    const keeping = new Set(input.options.map((option) => option.id).filter(Boolean));
    const dropping = existing.filter((option) => !keeping.has(option.id));

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
        closesAt: input.closesAt,
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
          .where(eq(pollOptions.id, option.id));
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

/** Close it now, or set a time. Closing is the one edit a closed poll allows nothing after. */
export async function closePoll(
  pollId: string,
  at: Date = new Date(),
  database: Database = defaultDb
): Promise<void> {
  await database.update(polls).set({ closesAt: at, updatedAt: new Date() }).where(eq(polls.id, pollId));
}

export async function deletePoll(
  pollId: string,
  database: Database = defaultDb
): Promise<void> {
  await database.delete(polls).where(eq(polls.id, pollId));
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
