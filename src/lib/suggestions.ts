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
 *
 * ## What a suggestion has to say (R-87, R-165 / UC-22 1, 1a, E1)
 *
 * A title *and* a short description, both required. UC-22 1 asks for both and
 * the reason is the one the list exists for: "Rivals night" is not a proposal
 * anybody can back or refuse, and a row nobody can judge is a row that sits at
 * zero forever. The game stays optional — E1 asks for it so organisers can tell
 * at a glance, and an idea that is not about one game should not have to invent
 * one.
 *
 * Every one of those limits is checked here, on the server, and not only by the
 * `maxLength` on the input. A browser attribute stops typing; it does not stop
 * a POST, and every action on this feature is a public endpoint — see the
 * Next.js Server Actions guide: "Treat every action as an untrusted entry
 * point."
 */

export const TITLE_MIN = 3;
export const TITLE_MAX = 120;
export const DETAIL_MAX = 1000;
export const GAME_MAX = 80;

export type SuggestionVote = 1 | -1 | 0;

/** What somebody is proposing. The game is the only optional part. */
export type SuggestionInput = {
  title: string;
  detail: string;
  gameName?: string | null;
};

export type Suggestion = {
  id: string;
  title: string;
  detail: string;
  gameName: string | null;
  status: SuggestionStatus;
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
        // Required from Task 24 on; rows written before it may still hold null,
        // and the column stays nullable so they survive (see the migration).
        detail: row.detail ?? "",
        gameName: row.gameName,
        status: row.status,
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
 * Wanted first, then newest (R-88 / UC-22 4).
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

/**
 * Why a suggestion is not one (UC-22 1a).
 *
 * Trimmed before measuring, so a thousand spaces is empty rather than merely
 * long, and so the length the writer is told about is the length that is
 * stored.
 */
function refusal(input: SuggestionInput): string | null {
  const title = input.title.trim();
  if (title.length < TITLE_MIN) return "Give it a title.";
  if (title.length > TITLE_MAX) {
    return `Keep the title under ${TITLE_MAX} characters.`;
  }

  const detail = input.detail.trim();
  if (detail.length === 0) {
    return "Say a little about it — what it is, and why it would be good.";
  }
  if (detail.length > DETAIL_MAX) {
    return `Keep the description under ${DETAIL_MAX} characters.`;
  }

  if ((input.gameName ?? "").trim().length > GAME_MAX) {
    return `Keep the game name under ${GAME_MAX} characters.`;
  }

  return null;
}

/**
 * Add one (R-87, R-164 / UC-22 1, E2).
 *
 * The suggester is counted as wanting it, which saves a second click and is
 * what E2 asks for: an idea posted by somebody who would not turn up to it is
 * not an idea, so the first like is not worth making them prove.
 */
export async function addSuggestion(
  userId: string,
  input: SuggestionInput,
  database: Database = defaultDb
): Promise<SuggestionResult<{ id: string }>> {
  const bad = refusal(input);
  if (bad) return { ok: false, error: bad };

  return database.transaction(async (tx) => {
    const [row] = await tx
      .insert(eventSuggestions)
      .values({
        title: input.title.trim(),
        detail: input.detail.trim(),
        gameName: input.gameName?.trim() || null,
        createdByUserId: userId,
      })
      .returning({ id: eventSuggestions.id });

    await tx.insert(suggestionVotes).values({ suggestionId: row.id, userId, value: 1 });

    return { ok: true as const, data: { id: row.id } };
  });
}

/**
 * Like, dislike, or take it back (R-89 / UC-22 3, 3a).
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

/**
 * An admin marking where a suggestion got to (R-90 / UC-22 5, 6).
 *
 * Refuses rather than saying nothing when the row has gone. The screen moves
 * the dropdown optimistically — it has to, or the control fights the cursor —
 * so silence here leaves "Planned" showing against a suggestion that was
 * deleted while the page was open, and leaves it showing until a reload.
 */
export async function setSuggestionStatus(
  suggestionId: string,
  status: SuggestionStatus,
  database: Database = defaultDb
): Promise<SuggestionResult<undefined>> {
  const changed = await database
    .update(eventSuggestions)
    .set({ status, updatedAt: new Date() })
    .where(eq(eventSuggestions.id, suggestionId))
    .returning({ id: eventSuggestions.id });

  if (changed.length === 0) return { ok: false, error: "That suggestion has gone." };
  return { ok: true, data: undefined };
}

/**
 * Remove one (R-163 / UC-22 E3).
 *
 * The ownership test is the `where` clause of the delete itself rather than a
 * read beside it: authorise on the row you are about to write. A suggestion id
 * is a uuid somebody can POST straight at this action, and a check that reads
 * one row and then deletes by id is a check with a gap in the middle of it.
 *
 * Nothing deleted means the row was not theirs, or was not there — one sentence
 * answers both and is true either way. The votes go with it by cascade, which
 * is right: they were votes for this, not for the idea in general.
 */
export async function deleteSuggestion(
  suggestionId: string,
  actor: { userId: string; isAdmin: boolean },
  database: Database = defaultDb
): Promise<SuggestionResult<undefined>> {
  const mine = actor.isAdmin
    ? eq(eventSuggestions.id, suggestionId)
    : and(
        eq(eventSuggestions.id, suggestionId),
        eq(eventSuggestions.createdByUserId, actor.userId)
      );

  const gone = await database
    .delete(eventSuggestions)
    .where(mine)
    .returning({ id: eventSuggestions.id });

  if (gone.length === 0) return { ok: false, error: "That is not yours to remove." };
  return { ok: true, data: undefined };
}
