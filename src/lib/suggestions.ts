import { and, eq, inArray, sql } from "drizzle-orm";
import {
  type Database,
  type SuggestionStatus,
  db as defaultDb,
  eventSuggestions,
  suggestionVotes,
  users,
} from "@/db";

/**
 * The suggestion box: "somebody should run one of these."
 *
 * Public to read, because the count *is* the value — an organiser deciding what
 * to run next wants to see that eleven people want a REPO night, and the eleven
 * want to see it too. Voting needs an account: an anonymous tally is a number
 * anybody can make say anything, and this one is meant to justify spending a
 * Saturday on something.
 */

export const TITLE_MAX = 120;
export const DETAIL_MAX = 1000;
export const GAME_MAX = 80;

export type SuggestionVote = 1 | -1 | 0;

export type Suggestion = {
  id: string;
  title: string;
  detail: string | null;
  gameName: string | null;
  status: SuggestionStatus;
  eventId: string | null;
  createdAt: Date;
  by: { id: string; name: string; handle: string | null } | null;
  up: number;
  down: number;
  /** Ups minus downs — what the list sorts on. */
  score: number;
  /** What the reader themselves said, or 0 when they have not, or are signed out. */
  yours: SuggestionVote;
};

export type SuggestionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Every suggestion with its tally.
 *
 * Two queries and a join in memory rather than a grouped join: the vote table
 * is one row per person per suggestion, the whole thing is small, and counting
 * in JavaScript keeps "what did *you* vote" a property of the same pass rather
 * than a second correlated subquery.
 */
export async function listSuggestions(
  viewerId: string | null,
  database: Database = defaultDb
): Promise<Suggestion[]> {
  const rows = await database
    .select({
      id: eventSuggestions.id,
      title: eventSuggestions.title,
      detail: eventSuggestions.detail,
      gameName: eventSuggestions.gameName,
      status: eventSuggestions.status,
      eventId: eventSuggestions.eventId,
      createdAt: eventSuggestions.createdAt,
      byId: users.id,
      byDisplayName: users.displayName,
      byName: users.name,
      byHandle: users.handle,
    })
    .from(eventSuggestions)
    .leftJoin(users, eq(users.id, eventSuggestions.createdByUserId));

  if (rows.length === 0) return [];

  const votes = await database
    .select({
      suggestionId: suggestionVotes.suggestionId,
      userId: suggestionVotes.userId,
      value: suggestionVotes.value,
    })
    .from(suggestionVotes)
    .where(
      inArray(
        suggestionVotes.suggestionId,
        rows.map((row) => row.id)
      )
    );

  const tally = new Map<string, { up: number; down: number; yours: SuggestionVote }>();
  for (const row of rows) tally.set(row.id, { up: 0, down: 0, yours: 0 });
  for (const vote of votes) {
    const counts = tally.get(vote.suggestionId);
    if (!counts) continue;
    if (vote.value > 0) counts.up += 1;
    else counts.down += 1;
    if (viewerId && vote.userId === viewerId) {
      counts.yours = vote.value > 0 ? 1 : -1;
    }
  }

  return rows
    .map((row) => {
      const counts = tally.get(row.id) ?? { up: 0, down: 0, yours: 0 as SuggestionVote };
      return {
        id: row.id,
        title: row.title,
        detail: row.detail,
        gameName: row.gameName,
        status: row.status,
        eventId: row.eventId,
        createdAt: row.createdAt,
        by: row.byId
          ? {
              id: row.byId,
              name: row.byDisplayName ?? row.byName ?? row.byHandle ?? "Member",
              handle: row.byHandle,
            }
          : null,
        up: counts.up,
        down: counts.down,
        score: counts.up - counts.down,
        yours: counts.yours,
      };
    })
    .sort(rank);
}

/**
 * Wanted first, then newest.
 *
 * Declined and done drop below everything open whatever their score, because
 * the list answers "what should we run next" and a thing already run is not an
 * answer to it however popular it was.
 */
function rank(a: Suggestion, b: Suggestion): number {
  const weight = (status: SuggestionStatus) =>
    status === "open" ? 0 : status === "planned" ? 1 : 2;
  return (
    weight(a.status) - weight(b.status) ||
    b.score - a.score ||
    b.createdAt.getTime() - a.createdAt.getTime()
  );
}

/** Add one. The suggester is counted as wanting it, which saves a second click. */
export async function addSuggestion(
  userId: string,
  input: { title: string; detail?: string | null; gameName?: string | null },
  database: Database = defaultDb
): Promise<SuggestionResult<{ id: string }>> {
  const title = input.title.trim();
  if (title.length < 3) return { ok: false, error: "Give it a title." };
  if (title.length > TITLE_MAX) {
    return { ok: false, error: `Keep the title under ${TITLE_MAX} characters.` };
  }
  if ((input.detail ?? "").length > DETAIL_MAX) {
    return { ok: false, error: `Keep the detail under ${DETAIL_MAX} characters.` };
  }

  return database.transaction(async (tx) => {
    const [row] = await tx
      .insert(eventSuggestions)
      .values({
        title,
        detail: input.detail?.trim() || null,
        gameName: input.gameName?.trim() || null,
        createdByUserId: userId,
      })
      .returning({ id: eventSuggestions.id });

    await tx.insert(suggestionVotes).values({ suggestionId: row.id, userId, value: 1 });

    return { ok: true as const, data: { id: row.id } };
  });
}

/**
 * Like, dislike, or take it back.
 *
 * Passing the same value again clears it, which is how every vote control
 * anybody has used behaves — clicking the lit arrow un-lights it. Without that
 * a mis-click is permanent, and the tally quietly fills up with votes nobody
 * meant.
 */
export async function voteSuggestion(
  suggestionId: string,
  userId: string,
  value: 1 | -1,
  database: Database = defaultDb
): Promise<SuggestionResult<{ up: number; down: number; yours: SuggestionVote }>> {
  return database.transaction(async (tx) => {
    const [suggestion] = await tx
      .select({ id: eventSuggestions.id })
      .from(eventSuggestions)
      .where(eq(eventSuggestions.id, suggestionId));
    if (!suggestion) return { ok: false as const, error: "That suggestion has gone." };

    const [existing] = await tx
      .select({ value: suggestionVotes.value })
      .from(suggestionVotes)
      .where(
        and(
          eq(suggestionVotes.suggestionId, suggestionId),
          eq(suggestionVotes.userId, userId)
        )
      );

    if (existing && existing.value === value) {
      await tx
        .delete(suggestionVotes)
        .where(
          and(
            eq(suggestionVotes.suggestionId, suggestionId),
            eq(suggestionVotes.userId, userId)
          )
        );
    } else {
      await tx
        .insert(suggestionVotes)
        .values({ suggestionId, userId, value })
        .onConflictDoUpdate({
          target: [suggestionVotes.suggestionId, suggestionVotes.userId],
          set: { value },
        });
    }

    const counts = await tx
      .select({
        up: sql<number>`count(*) filter (where ${suggestionVotes.value} > 0)`.mapWith(Number),
        down: sql<number>`count(*) filter (where ${suggestionVotes.value} < 0)`.mapWith(Number),
      })
      .from(suggestionVotes)
      .where(eq(suggestionVotes.suggestionId, suggestionId));

    const [mine] = await tx
      .select({ value: suggestionVotes.value })
      .from(suggestionVotes)
      .where(
        and(
          eq(suggestionVotes.suggestionId, suggestionId),
          eq(suggestionVotes.userId, userId)
        )
      );

    return {
      ok: true as const,
      data: {
        up: counts[0]?.up ?? 0,
        down: counts[0]?.down ?? 0,
        yours: (mine ? (mine.value > 0 ? 1 : -1) : 0) as SuggestionVote,
      },
    };
  });
}

/** An admin marking where a suggestion got to. */
export async function setSuggestionStatus(
  suggestionId: string,
  status: SuggestionStatus,
  database: Database = defaultDb
): Promise<void> {
  await database
    .update(eventSuggestions)
    .set({ status, updatedAt: new Date() })
    .where(eq(eventSuggestions.id, suggestionId));
}

/**
 * Remove one.
 *
 * Only ever called for the suggester's own, or by an admin — the check is at
 * the action, which is where the session is. The votes go with it by cascade,
 * which is right: they were votes for this, not for the idea in general.
 */
export async function deleteSuggestion(
  suggestionId: string,
  database: Database = defaultDb
): Promise<void> {
  await database.delete(eventSuggestions).where(eq(eventSuggestions.id, suggestionId));
}

/** Who wrote it, for the ownership check. */
export async function suggestionAuthor(
  suggestionId: string,
  database: Database = defaultDb
): Promise<string | null> {
  const [row] = await database
    .select({ createdByUserId: eventSuggestions.createdByUserId })
    .from(eventSuggestions)
    .where(eq(eventSuggestions.id, suggestionId));
  return row?.createdByUserId ?? null;
}
