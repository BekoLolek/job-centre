import { type SQL, and, desc, eq } from "drizzle-orm";
import {
  type Database,
  type HostApplicationStatus,
  db as defaultDb,
  eventHosts,
  events,
  games,
  hostApplications,
  users,
} from "@/db";

/**
 * Applying to run an event, and the permission that comes with being approved.
 *
 * ## What a host is
 *
 * A row in `event_hosts` is the whole grant: within that one event the holder
 * can do what an admin can, and outside it they are an ordinary member. A host
 * is not a small admin — they are somebody trusted with one evening.
 *
 * That boundary is enforced by {@link canManageEvent} and nothing else, so
 * there is exactly one place to read to know what a host can do, and exactly
 * one place to get it wrong.
 *
 * ## Why the application asks for so much
 *
 * Approving one means creating the event, attaching a game and writing the
 * questions applicants will answer. If the form does not carry the game and
 * the questions, approving it is the start of a conversation rather than the
 * end of one — and a conversation in Discord is what this whole site exists to
 * replace. So the game and "what you need to know about each player" are
 * required, and the rest is optional.
 */

export const SUMMARY_MAX = 2000;
export const TITLE_MAX = 120;

export type HostApplication = {
  id: string;
  status: HostApplicationStatus;
  title: string;
  gameName: string;
  gameId: string | null;
  summary: string;
  format: string | null;
  expectedPlayers: number | null;
  proposedWhen: string | null;
  playerInfoNeeded: string;
  decisionNote: string | null;
  decidedAt: Date | null;
  eventId: string | null;
  eventSlug: string | null;
  createdAt: Date;
  by: { id: string; name: string; handle: string | null } | null;
};

export type HostResult<T> = { ok: true; data: T } | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* The permission                                                     */
/* ------------------------------------------------------------------ */

/**
 * May this person manage this event?
 *
 * Admins may manage every event. A host may manage exactly the one they were
 * given. There is no third answer, and no partial one — "full permissions to
 * manage that one event" is the grant, so a host publishing their own event is
 * within it. What they cannot do is touch anybody else's, reach `/admin`, or
 * change who is an admin.
 */
export async function canManageEvent(
  user: { id: string; isAdmin: boolean } | null,
  eventId: string,
  database: Database = defaultDb
): Promise<boolean> {
  if (!user) return false;
  if (user.isAdmin) return true;

  const [row] = await database
    .select({ userId: eventHosts.userId })
    .from(eventHosts)
    .where(and(eq(eventHosts.eventId, eventId), eq(eventHosts.userId, user.id)));
  return Boolean(row);
}

/** The events this person hosts, for their own dashboard. */
export async function eventsHostedBy(
  userId: string,
  database: Database = defaultDb
): Promise<Array<{ id: string; title: string; slug: string; status: string }>> {
  return database
    .select({
      id: events.id,
      title: events.title,
      slug: events.slug,
      status: events.status,
    })
    .from(eventHosts)
    .innerJoin(events, eq(events.id, eventHosts.eventId))
    .where(eq(eventHosts.userId, userId));
}

/** Everyone who hosts this event, for the editor to show. */
export async function hostsOf(
  eventId: string,
  database: Database = defaultDb
): Promise<Array<{ id: string; name: string; handle: string | null }>> {
  const rows = await database
    .select({
      id: users.id,
      displayName: users.displayName,
      name: users.name,
      handle: users.handle,
    })
    .from(eventHosts)
    .innerJoin(users, eq(users.id, eventHosts.userId))
    .where(eq(eventHosts.eventId, eventId));

  return rows.map((row) => ({
    id: row.id,
    name: row.displayName ?? row.name ?? row.handle ?? "Member",
    handle: row.handle,
  }));
}

export async function addHost(
  eventId: string,
  userId: string,
  grantedByUserId: string | null,
  database: Database = defaultDb
): Promise<void> {
  await database
    .insert(eventHosts)
    .values({ eventId, userId, grantedByUserId })
    .onConflictDoNothing();
}

export async function removeHost(
  eventId: string,
  userId: string,
  database: Database = defaultDb
): Promise<void> {
  await database
    .delete(eventHosts)
    .where(and(eq(eventHosts.eventId, eventId), eq(eventHosts.userId, userId)));
}

/* ------------------------------------------------------------------ */
/* The application                                                    */
/* ------------------------------------------------------------------ */

export type HostApplicationInput = {
  title: string;
  gameName: string;
  gameId?: string | null;
  summary: string;
  format?: string | null;
  expectedPlayers?: number | null;
  proposedWhen?: string | null;
  playerInfoNeeded: string;
};

function refusal(input: HostApplicationInput): string | null {
  if (input.title.trim().length < 3) return "Give the event a name.";
  if (input.title.trim().length > TITLE_MAX) {
    return `Keep the name under ${TITLE_MAX} characters.`;
  }
  if (input.gameName.trim().length < 2) return "Say what game it is.";
  if (input.summary.trim().length < 20) {
    return "Say a bit more about what the event is — a couple of sentences is plenty.";
  }
  if (input.summary.length > SUMMARY_MAX) {
    return `Keep the description under ${SUMMARY_MAX} characters.`;
  }
  if (input.playerInfoNeeded.trim().length < 3) {
    return "Say what you need to know about each player — rank, role, which packs they own. An admin turns this into the sign-up questions.";
  }
  if (
    input.expectedPlayers !== null &&
    input.expectedPlayers !== undefined &&
    (!Number.isInteger(input.expectedPlayers) ||
      input.expectedPlayers < 2 ||
      input.expectedPlayers > 500)
  ) {
    return "How many players is somewhere between 2 and 500.";
  }
  return null;
}

/**
 * Send one.
 *
 * One pending application at a time. Somebody who has had three ideas should
 * send the best one — an admin looking at a queue of six from the same person
 * is looking at a queue, not at a decision.
 */
export async function applyToHost(
  userId: string,
  input: HostApplicationInput,
  database: Database = defaultDb
): Promise<HostResult<{ id: string }>> {
  const bad = refusal(input);
  if (bad) return { ok: false, error: bad };

  const [pending] = await database
    .select({ id: hostApplications.id })
    .from(hostApplications)
    .where(
      and(eq(hostApplications.userId, userId), eq(hostApplications.status, "pending"))
    );
  if (pending) {
    return {
      ok: false,
      error: "You already have an application waiting. Withdraw it first if you want to change it.",
    };
  }

  const [row] = await database
    .insert(hostApplications)
    .values({
      userId,
      title: input.title.trim(),
      gameName: input.gameName.trim(),
      gameId: input.gameId ?? null,
      summary: input.summary.trim(),
      format: input.format?.trim() || null,
      expectedPlayers: input.expectedPlayers ?? null,
      proposedWhen: input.proposedWhen?.trim() || null,
      playerInfoNeeded: input.playerInfoNeeded.trim(),
    })
    .returning({ id: hostApplications.id });

  return { ok: true, data: { id: row.id } };
}

/** The one shaped read the three list functions share. */
async function read(database: Database, where?: SQL): Promise<HostApplication[]> {
  const rows = await database
    .select({
      id: hostApplications.id,
      status: hostApplications.status,
      title: hostApplications.title,
      gameName: hostApplications.gameName,
      gameId: hostApplications.gameId,
      summary: hostApplications.summary,
      format: hostApplications.format,
      expectedPlayers: hostApplications.expectedPlayers,
      proposedWhen: hostApplications.proposedWhen,
      playerInfoNeeded: hostApplications.playerInfoNeeded,
      decisionNote: hostApplications.decisionNote,
      decidedAt: hostApplications.decidedAt,
      eventId: hostApplications.eventId,
      createdAt: hostApplications.createdAt,
      byId: users.id,
      byDisplayName: users.displayName,
      byName: users.name,
      byHandle: users.handle,
      eventSlug: events.slug,
    })
    .from(hostApplications)
    .leftJoin(users, eq(users.id, hostApplications.userId))
    .leftJoin(events, eq(events.id, hostApplications.eventId))
    .where(where)
    .orderBy(desc(hostApplications.createdAt));


  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    title: row.title,
    gameName: row.gameName,
    gameId: row.gameId,
    summary: row.summary,
    format: row.format,
    expectedPlayers: row.expectedPlayers,
    proposedWhen: row.proposedWhen,
    playerInfoNeeded: row.playerInfoNeeded,
    decisionNote: row.decisionNote,
    decidedAt: row.decidedAt,
    eventId: row.eventId,
    eventSlug: row.eventSlug,
    createdAt: row.createdAt,
    by: row.byId
      ? {
          id: row.byId,
          name: row.byDisplayName ?? row.byName ?? row.byHandle ?? "Member",
          handle: row.byHandle,
        }
      : null,
  }));
}

/** Everything an admin has to look at, newest first. */
export async function listHostApplications(
  database: Database = defaultDb
): Promise<HostApplication[]> {
  const rows = await read(database);
  // Pending first: the list is a queue before it is a record.
  return rows.sort(
    (a, b) => Number(b.status === "pending") - Number(a.status === "pending")
  );
}

/** One person's own, for their dashboard. */
export async function myHostApplications(
  userId: string,
  database: Database = defaultDb
): Promise<HostApplication[]> {
  return read(database, eq(hostApplications.userId, userId));
}

export async function getHostApplication(
  id: string,
  database: Database = defaultDb
): Promise<HostApplication | null> {
  const [row] = await read(database, eq(hostApplications.id, id));
  return row ?? null;
}

/** Take it back. Only ever the applicant's own — checked at the action. */
export async function withdrawHostApplication(
  id: string,
  database: Database = defaultDb
): Promise<void> {
  await database
    .update(hostApplications)
    .set({ status: "withdrawn", updatedAt: new Date() })
    .where(and(eq(hostApplications.id, id), eq(hostApplications.status, "pending")));
}

export async function declineHostApplication(
  id: string,
  decidedByUserId: string,
  note: string | null,
  database: Database = defaultDb
): Promise<void> {
  await database
    .update(hostApplications)
    .set({
      status: "declined",
      decidedByUserId,
      decidedAt: new Date(),
      decisionNote: note?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(hostApplications.id, id));
}

/**
 * Approve, and hand over the keys.
 *
 * One transaction: the event is created, the applicant is made its host, and
 * the application is marked with the event it became. Half of that happening
 * would leave either an event nobody can edit or a host of nothing.
 *
 * The event is created as a **draft**. Approving somebody to run an evening is
 * not the same as putting it on the calendar, and the host still has to fill in
 * the dates and publish it — which they can, because within this one event they
 * have what an admin has.
 */
export async function approveHostApplication(
  id: string,
  decidedByUserId: string,
  input: { note?: string | null; eventId: string },
  database: Database = defaultDb
): Promise<HostResult<{ eventId: string }>> {
  return database.transaction(async (tx) => {
    const [application] = await tx
      .select({ userId: hostApplications.userId, status: hostApplications.status })
      .from(hostApplications)
      .where(eq(hostApplications.id, id));

    if (!application) return { ok: false as const, error: "That application has gone." };
    if (application.status !== "pending") {
      return { ok: false as const, error: "That application has already been decided." };
    }

    await tx
      .insert(eventHosts)
      .values({
        eventId: input.eventId,
        userId: application.userId,
        grantedByUserId: decidedByUserId,
      })
      .onConflictDoNothing();

    await tx
      .update(hostApplications)
      .set({
        status: "approved",
        decidedByUserId,
        decidedAt: new Date(),
        decisionNote: input.note?.trim() || null,
        eventId: input.eventId,
        updatedAt: new Date(),
      })
      .where(eq(hostApplications.id, id));

    return { ok: true as const, data: { eventId: input.eventId } };
  });
}

/** The games this site already knows, so the form is a dropdown for the common case. */
export async function hostableGames(
  database: Database = defaultDb
): Promise<Array<{ id: string; name: string }>> {
  const rows = await database
    .select({ id: games.id, name: games.name, active: games.isActive })
    .from(games);
  return rows
    .filter((row) => row.active !== false)
    .map((row) => ({ id: row.id, name: row.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
