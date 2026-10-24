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
 * Task 88's per-round write belongs here too, beside `listRoundScores`.
 */

import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { type Database, db as defaultDb, eventRoundScores, events, users } from "@/db";
import { type EventResult, updateEvent } from "@/lib/events";
import {
  type RoundScoring,
  roundScoringConfirmRefusal,
  roundScoringFrom,
  roundScoringLosses,
  roundScoringProblem,
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

/**
 * A display name for each of these users, for the sentences that name who an
 * award came back from. The rows cascade on a user's deletion, so a scored
 * player always has a row here; the fallback is for a profile with no name set.
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
