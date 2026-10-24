/**
 * The round-score rows, read and — for the Scoring panel — trimmed
 * (R-225, R-226, R-229 / UC-44 2b, 3a, 4d).
 *
 * This is the module that reaches `event_round_scores`. The rules it applies
 * are not here: `roundScoringProblem` and `roundScoringLosses` in
 * `./events-policy` decide what is refused and what is named, and
 * `rankRounds` in `./round-scoring` decides what the rows mean. This file reads
 * the rows, hands them to those, and writes what they allow — which is the
 * split every other `src/lib` write follows, and the one that lets the panel
 * refuse in the same words without a database.
 *
 * Task 88's per-round write is `saveRound`, below `saveRoundScoring`.
 */

import { and, asc, eq, gt, inArray } from "drizzle-orm";
import {
  type Database,
  applications,
  db as defaultDb,
  eventRoundScores,
  events,
  users,
} from "@/db";
import { lockRefusal } from "@/lib/archive-policy";
import { type EventResult, updateEvent } from "@/lib/events";
import {
  type RoundEntry,
  type RoundRow,
  type RoundScoring,
  roundEntriesProblem,
  roundMovedRefusal,
  roundMovedSince,
  roundName,
  roundScoringConfirmRefusal,
  roundScoringFrom,
  roundScoringLosses,
  roundScoringProblem,
  unseatedRefusal,
} from "@/lib/events-policy";
import type { RoundScoreRow } from "@/lib/round-scoring";

function fail<T>(error: string): EventResult<T> {
  return { ok: false, error };
}

/**
 * Every recorded score for this event, round by round — the rows `rankRounds`
 * takes and the rows the Scoring panel counts before it refuses.
 */
export async function listRoundScores(
  eventId: string,
  database: Database = defaultDb
): Promise<RoundScoreRow[]> {
  return database
    .select({
      roundIndex: eventRoundScores.roundIndex,
      userId: eventRoundScores.userId,
      score: eventRoundScores.score,
      bonuses: eventRoundScores.bonuses,
    })
    .from(eventRoundScores)
    .where(eq(eventRoundScores.eventId, eventId))
    .orderBy(asc(eventRoundScores.roundIndex), asc(eventRoundScores.id));
}

export type RoundScoringSaved = {
  /** As stored, read back through `roundScoringFrom`. */
  scoring: RoundScoring;
  /** What the save took away, in the sentences the manager confirmed. */
  losses: string[];
  scoresDiscarded: number;
  awardsDiscarded: number;
};

/**
 * Store how this night is scored, taking away only what the manager confirmed
 * (UC-44 1-6, 2b, 3a, 4d).
 *
 * ## Decided before anything is written — decision 004
 *
 * Every refusal here comes before the transaction opens: the bounds
 * (`roundScoringProblem`), the event being gone, and the three confirmations
 * (`roundScoringLosses` over the rows, read first). Inside the transaction the
 * config write goes **first**, and it is the one statement that can still
 * refuse — `updateEvent` is a compare-and-set whose refusal is its own zero-row
 * result, so returning it has committed nothing (004's third shape). The row
 * deletes and updates that follow cannot refuse at all; a constraint failure
 * among them is a crash, which rolls the config back with it.
 *
 * The rows are counted outside the transaction, so a round scored between the
 * count and the write is not in the sentence the manager confirmed. The delete
 * is by round number rather than by row id, so such a row still goes with the
 * round it was scored in; it is the sentence that would have undercounted, not
 * the write that would have missed.
 *
 * ## What "a bonus goes" means on the row
 *
 * Decision 006 puts the awards on the score row as `Record<key, count>`, so
 * taking an award back is rewriting that object without the key — never a
 * second table to delete from, and never a score lost with it.
 */
export async function saveRoundScoring(
  eventId: string,
  wanted: RoundScoring,
  options: { confirmed: boolean },
  database: Database = defaultDb
): Promise<EventResult<RoundScoringSaved>> {
  const problem = roundScoringProblem(wanted);
  if (problem) return fail(problem);

  const [current] = await database
    .select({ config: events.config })
    .from(events)
    .where(eq(events.id, eventId));
  if (!current) return fail("That event no longer exists.");

  const rows = await listRoundScores(eventId, database);
  const nameOf = await displayNames(
    [...new Set(rows.map((row) => row.userId))],
    database
  );

  // Exactly the three facts, as plain objects: what is stored, and what the
  // ranking reads back. Anything else a caller's object carried stops here.
  const stored = {
    rounds: wanted.rounds.map((round) => ({ name: round.name })),
    lowWins: wanted.lowWins,
    bonuses: wanted.bonuses.map((bonus) => ({ key: bonus.key, value: bonus.value })),
  };

  const losses = roundScoringLosses(roundScoringFrom(current.config), stored, rows, nameOf);
  if (losses.length > 0 && !options.confirmed) return fail(roundScoringConfirmRefusal(losses));

  return database.transaction(async (tx) => {
    const updated = await updateEvent(eventId, { config: { roundScoring: stored } }, tx);
    // The guarded write, and the first one: nothing below has run yet.
    if (!updated.ok) return updated;

    const kept = stored.rounds.length;
    const doomed = rows.filter((row) => row.roundIndex > kept);
    if (doomed.length > 0) {
      await tx
        .delete(eventRoundScores)
        .where(and(eq(eventRoundScores.eventId, eventId), gt(eventRoundScores.roundIndex, kept)));
    }

    const defined = new Set(stored.bonuses.map((bonus) => bonus.key));
    let awardsDiscarded = 0;
    for (const row of rows) {
      if (row.roundIndex > kept) continue;
      const stripped: Record<string, number> = {};
      let removed = 0;
      for (const [key, count] of Object.entries(row.bonuses)) {
        if (defined.has(key)) {
          stripped[key] = count;
        } else {
          removed += 1;
          awardsDiscarded += count;
        }
      }
      if (removed === 0) continue;
      await tx
        .update(eventRoundScores)
        .set({ bonuses: stripped })
        .where(
          and(
            eq(eventRoundScores.eventId, eventId),
            eq(eventRoundScores.roundIndex, row.roundIndex),
            eq(eventRoundScores.userId, row.userId)
          )
        );
    }

    const scoring = roundScoringFrom(updated.data.config);
    // Written as a list a moment ago, so a null here is a broken invariant —
    // and a throw rolls the write back, which is what 004 asks of a crash.
    if (!scoring) throw new Error("The scoring setup was written and could not be read back.");

    return {
      ok: true,
      data: { scoring, losses, scoresDiscarded: doomed.length, awardsDiscarded },
    };
  });
}

export type RoundSaved = {
  roundIndex: number;
  /** The round as the manager named it, or "Round N" — for the audit line. */
  name: string;
  /** The event's title, read under the same lock — for the audit line. */
  title: string;
  /** The round as it is now stored, in `listRoundScores`' order. */
  rows: RoundScoreRow[];
  /** How many rows the round held before — zero for a first scoring, so the log can say "re-scored". */
  replaced: number;
};

export type RoundSaveResult =
  | { ok: true; data: RoundSaved }
  | {
      ok: false;
      error: string;
      /**
       * UC-45 4b only: the round as it is stored now, when the refusal is that
       * it moved since the screen loaded it. The screen re-seeds from these.
       */
      moved?: RoundScoreRow[];
    };

/**
 * Store one round — every player's score and awards, replacing whatever the
 * round held (UC-45 4-5, 3c, 3d, 3e, 4a, 4b, 4c).
 *
 * ## The whole round, in one write, for `setPlacements`' reason
 *
 * The entries sent *are* the round, and the old rows go. There is no diff and
 * no per-player path: a correction is the same call (4a), and a player left
 * blank on it loses their row rather than keeping a stale one. One authority
 * per round, and nothing to get wrong between two.
 *
 * ## Decided before anything is written — decision 004, shape 1
 *
 * Every refusal here precedes the first write. The event row is taken for
 * update first, so the lock (`lockRefusal`, UC-09 6b's gate — the same one
 * `recordGames` asks) and every read after it see what is actually stored
 * rather than what the page was rendered with. Then, in order: the night must
 * be round-scored; the entries must be a round (`roundEntriesProblem`);
 * everybody scored must hold a seat or already be recorded here
 * (`unseatedRefusal`); and the round must not have moved since the screen
 * loaded it (`roundMovedSince`). Only then the delete and the insert, neither
 * of which can refuse — the unique constraint cannot fire on a round that was
 * just emptied of deduplicated entries, and a failure there is a crash that
 * rolls both back.
 *
 * ## Two managers, one round (UC-45 4b) — detected from the rows themselves
 *
 * Task 85 stored no version and no timestamp, and this does not add one. The
 * rows are the round's state, so `expected` — the round as the screen read it
 * — is compared with the round as it is under the lock. The second manager's
 * transaction waits on the first's lock, then reads rows the first just wrote,
 * and is refused with those rows attached: told the round moved, and shown
 * what is there now. That is also what stops a stale screen stripping an award
 * that arrived after it loaded — the award is a difference, so the save does
 * not go through.
 */
export async function saveRound(
  eventId: string,
  input: { roundIndex: number; entries: readonly RoundEntry[]; expected: readonly RoundRow[] },
  database: Database = defaultDb
): Promise<RoundSaveResult> {
  const { roundIndex, entries, expected } = input;

  return database.transaction(async (tx) => {
    const [event] = await tx
      .select({ title: events.title, status: events.status, config: events.config })
      .from(events)
      .where(eq(events.id, eventId))
      .for("update")
      .limit(1);
    if (!event) return fail("That event no longer exists.");

    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    const scoring = roundScoringFrom(event.config);
    if (!scoring) return fail("This night is not scored in rounds. Set that up on the Scoring panel first.");

    const current = await roundRows(tx, eventId, roundIndex);
    const nameOf = await displayNames(
      [...new Set([...entries.map((line) => line.userId), ...current.map((row) => row.userId)])],
      tx
    );

    const problem = roundEntriesProblem(scoring, roundIndex, entries, nameOf);
    if (problem) return fail(problem);

    // UC-45 pre 3: the players are the accepted applicants. Anyone the round
    // already records is scorable too — `unseatedRefusal` says why.
    const seated = await tx
      .select({ userId: applications.userId })
      .from(applications)
      .where(and(eq(applications.eventId, eventId), eq(applications.status, "accepted")));
    const scorable = new Set([
      ...seated.map((row) => row.userId),
      ...current.map((row) => row.userId),
    ]);
    const unseated = unseatedRefusal(entries, scorable, nameOf);
    if (unseated) return fail(unseated);

    const name = roundName(scoring.rounds[roundIndex - 1], roundIndex - 1);
    if (roundMovedSince(expected, current)) {
      return { ok: false, error: roundMovedRefusal(name), moved: current };
    }

    // Everything above has refused; nothing below can.
    await tx
      .delete(eventRoundScores)
      .where(and(eq(eventRoundScores.eventId, eventId), eq(eventRoundScores.roundIndex, roundIndex)));

    const played = entries.filter((line): line is RoundEntry & { score: number } => line.score !== null);
    if (played.length > 0) {
      await tx.insert(eventRoundScores).values(
        played.map((line) => ({
          eventId,
          roundIndex,
          userId: line.userId,
          score: line.score,
          bonuses: { ...line.bonuses },
        }))
      );
    }

    return {
      ok: true,
      data: {
        roundIndex,
        name,
        title: event.title,
        rows: await roundRows(tx, eventId, roundIndex),
        replaced: current.length,
      },
    };
  });
}

/** One round's rows, in `listRoundScores`' order. */
async function roundRows(
  database: Database,
  eventId: string,
  roundIndex: number
): Promise<RoundScoreRow[]> {
  return database
    .select({
      roundIndex: eventRoundScores.roundIndex,
      userId: eventRoundScores.userId,
      score: eventRoundScores.score,
      bonuses: eventRoundScores.bonuses,
    })
    .from(eventRoundScores)
    .where(and(eq(eventRoundScores.eventId, eventId), eq(eventRoundScores.roundIndex, roundIndex)))
    .orderBy(asc(eventRoundScores.id));
}

/**
 * A display name for each of these users, for the sentences that name who an
 * award came back from, or who cannot be scored. The rows cascade on a user's
 * deletion, so a scored player always has a row here; the fallback is for a
 * profile with no name set, or an id that names nobody.
 */
async function displayNames(
  userIds: readonly string[],
  database: Database
): Promise<(userId: string) => string> {
  if (userIds.length === 0) return () => "Unknown member";
  const named = await database
    .select({ id: users.id, displayName: users.displayName, discordId: users.discordId })
    .from(users)
    .where(inArray(users.id, [...userIds]));
  const book = new Map(
    named.map((row) => [row.id, row.displayName ?? row.discordId ?? "Unknown member"])
  );
  return (userId) => book.get(userId) ?? "Unknown member";
}
