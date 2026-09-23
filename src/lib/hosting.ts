import { type SQL, and, desc, eq, isNull, notInArray } from "drizzle-orm";
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
// One constant, so the prefill cannot write a question set the event refuses.
import { MAX_EVENT_QUESTIONS } from "./events";

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

/**
 * A refusal a form can put next to the control that caused it.
 *
 * `errors` is keyed by field name — `title`, `gameName`, `summary`,
 * `playerInfoNeeded`, `expectedPlayers`, `note`, `eventId` — because UC-20 3a
 * is "System marks them", plural: a form that answers four empty fields with
 * one sentence about the first of them makes the member fix one thing, send,
 * and be told about the next. `error` is always a sentence as well, so a caller
 * with nowhere to put the detail still has something to show. This is the shape
 * `events.ts` and `admin-games.ts` already use.
 */
export type HostResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; errors?: Record<string, string> };

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

/**
 * May this person see this event at all?
 *
 * A published event is public. An unpublished one does not exist for anybody
 * but its managers, so every page that shows it answers not found rather than
 * forbidden — nobody learns a half-written event is there by knocking.
 */
export async function canSeeEvent(
  user: { id: string; isAdmin: boolean } | null,
  event: { id: string; status: string },
  database: Database = defaultDb
): Promise<boolean> {
  return event.status !== "draft" || canManageEvent(user, event.id, database);
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

/**
 * The events an approval may be pointed at (UC-21 3).
 *
 * Everything nobody hosts yet, newest first. A host is one grant per event
 * (R-86), so an event that already has one is not on the list — approving a
 * second person onto it would be a co-host, which is a permission model this
 * site does not have and nobody has thought about.
 *
 * Complete and cancelled events are left out for the same reason the admin home
 * leaves them out: nothing about a finished event can need doing, and handing
 * somebody the keys to one is handing them nothing.
 */
export async function linkableEvents(
  database: Database = defaultDb
): Promise<Array<{ id: string; title: string; status: string }>> {
  return database
    .select({ id: events.id, title: events.title, status: events.status })
    .from(events)
    .leftJoin(eventHosts, eq(eventHosts.eventId, events.id))
    .where(
      and(isNull(eventHosts.eventId), notInArray(events.status, ["complete", "cancelled"]))
    )
    .orderBy(desc(events.createdAt));
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

/**
 * Everything wrong with the form at once, keyed by field (UC-20 3a).
 *
 * Every field is checked — the function never stops at the first problem —
 * because "System marks them" is about the form, not about the first control
 * in it. `expectedPlayers` and the summary are checked here rather than waved
 * through: they are the two things an admin judges the application on (R-167,
 * R-168 / UC-20 E1), so they are kept, and kept honest.
 */
function applicationProblems(
  input: HostApplicationInput
): Record<string, string> {
  const problems: Record<string, string> = {};

  if (input.title.trim().length < 3) problems.title = "Give the event a name.";
  else if (input.title.trim().length > TITLE_MAX) {
    problems.title = `Keep the name under ${TITLE_MAX} characters.`;
  }

  if (input.gameName.trim().length < 2) problems.gameName = "Say what game it is.";

  if (input.summary.trim().length < 20) {
    problems.summary =
      "Say a bit more about what the event is — a couple of sentences is plenty.";
  } else if (input.summary.length > SUMMARY_MAX) {
    problems.summary = `Keep the description under ${SUMMARY_MAX} characters.`;
  }

  if (input.playerInfoNeeded.trim().length < 3) {
    problems.playerInfoNeeded =
      "Say what you need to know about each player — rank, role, which packs they own. An admin turns this into the sign-up questions.";
  }

  if (
    input.expectedPlayers !== null &&
    input.expectedPlayers !== undefined &&
    (!Number.isInteger(input.expectedPlayers) ||
      input.expectedPlayers < 2 ||
      input.expectedPlayers > 500)
  ) {
    problems.expectedPlayers = "How many players is somewhere between 2 and 500.";
  }

  return problems;
}

/** The refusal the whole form gets when one or more fields are marked. */
const FORM_REFUSAL = "Some of that needs another look — see the notes on the fields.";

/** What a member is told when they already have one waiting (UC-20 3b). */
export const ALREADY_PENDING =
  "You already have an application waiting. Withdraw it first if you want to change it.";

/**
 * Was this Postgres refusing a second pending application?
 *
 * drizzle re-throws with a generic "Failed query" and hangs the real error off
 * `cause`, so the index name is looked for down the whole chain rather than on
 * the error it was handed.
 */
function isSecondPending(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const step = current as { message?: string; constraint?: string; cause?: unknown };
    const text = `${step.message ?? ""} ${step.constraint ?? ""}`;
    if (text.includes("host_applications_one_pending_per_user")) return true;
    current = step.cause;
  }
  return false;
}

/**
 * Send one.
 *
 * One pending application at a time. Somebody who has had three ideas should
 * send the best one — an admin looking at a queue of six from the same person
 * is looking at a queue, not at a decision.
 *
 * That rule is checked twice, and deliberately. The read below is how the
 * member gets a sentence instead of a crash. The unique index behind the insert
 * (`host_applications_one_pending_per_user`) is how the rule is actually true:
 * two submits in the same second both read no pending row, and only the index
 * can refuse the second insert. Its rejection is caught and turned back into
 * the same sentence, so the two submits differ in timing and in nothing else.
 */
export async function applyToHost(
  userId: string,
  input: HostApplicationInput,
  database: Database = defaultDb
): Promise<HostResult<{ id: string }>> {
  const problems = applicationProblems(input);
  if (Object.keys(problems).length > 0) {
    return { ok: false, error: FORM_REFUSAL, errors: problems };
  }

  const [pending] = await database
    .select({ id: hostApplications.id })
    .from(hostApplications)
    .where(
      and(eq(hostApplications.userId, userId), eq(hostApplications.status, "pending"))
    );
  if (pending) return { ok: false, error: ALREADY_PENDING };

  try {
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
  } catch (error) {
    if (isSecondPending(error)) return { ok: false, error: ALREADY_PENDING };
    throw error;
  }
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

/** The shortest reason worth sending. Anything less is a shrug. */
const REASON_MIN = 5;

/**
 * Decline, with a reason (UC-21 3a).
 *
 * The reason is required, not encouraged. Somebody wrote out what they wanted
 * to run and waited on an answer; "declined", on its own, tells them nothing
 * about whether to change it or to stop asking — and the note is the only thing
 * the decline notification has to carry.
 *
 * The write is keyed on the row *and* on it still being pending, so two admins
 * deciding at once cannot overwrite each other's decision: the second finds
 * nothing to update and is told so, rather than replacing the first decision's
 * author and note.
 */
export async function declineHostApplication(
  id: string,
  decidedByUserId: string,
  note: string | null,
  database: Database = defaultDb
): Promise<HostResult<null>> {
  const reason = note?.trim() ?? "";
  if (reason.length < REASON_MIN) {
    return {
      ok: false,
      error: "Say why. They wrote this out and waited on an answer.",
      errors: {
        note: "A decline needs a reason — one line is enough, and it is all they get.",
      },
    };
  }

  const updated = await database
    .update(hostApplications)
    .set({
      status: "declined",
      decidedByUserId,
      decidedAt: new Date(),
      decisionNote: reason,
      updatedAt: new Date(),
    })
    .where(and(eq(hostApplications.id, id), eq(hostApplications.status, "pending")))
    .returning({ id: hostApplications.id });

  if (updated.length === 0) {
    return { ok: false, error: "That application has already been decided." };
  }
  return { ok: true, data: null };
}

/**
 * Approve, linking the event the admin built from it (UC-21 3).
 *
 * The event already exists by the time this runs: UC-21 step 2 is the admin
 * creating it *from the application*, with the game, the questions and the
 * format, and step 3 is approving onto that event. Creating an empty event
 * inside the approval was the older shape, and it made approving the start of
 * the work rather than the end of it — the applicant got a title and nothing
 * else, and the questions they had spelled out sat in a text box nobody had
 * turned into a form.
 *
 * One transaction: the applicant is made the event's host and the application
 * is marked with the event it became. Half of that happening would leave either
 * an event nobody can edit or a host of nothing.
 *
 * Two things are checked against the row about to be written, not against what
 * the browser sent:
 *
 *  * the event exists, and
 *  * nobody else already hosts it (R-86 — one grant per event).
 *
 * The second is the one that matters. `eventId` arrives from a select on an
 * admin's screen, so without it an approval could be aimed at an event that is
 * already somebody's, and the person holding it would silently gain a co-host
 * with full rights over their evening.
 */
export async function approveHostApplication(
  id: string,
  decidedByUserId: string,
  input: { note?: string | null; eventId: string },
  database: Database = defaultDb
): Promise<HostResult<{ eventId: string }>> {
  if (!input.eventId) {
    return {
      ok: false,
      error: "Choose the event this is for.",
      errors: { eventId: "Create the event from this application first, then approve it." },
    };
  }

  return database.transaction(async (tx) => {
    const [application] = await tx
      .select({ userId: hostApplications.userId, status: hostApplications.status })
      .from(hostApplications)
      .where(eq(hostApplications.id, id));

    if (!application) return { ok: false as const, error: "That application has gone." };
    if (application.status !== "pending") {
      return { ok: false as const, error: "That application has already been decided." };
    }

    const [event] = await tx
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, input.eventId));
    if (!event) {
      return {
        ok: false as const,
        error: "That event no longer exists.",
        errors: { eventId: "Pick another, or create one from this application." },
      };
    }

    const [held] = await tx
      .select({ userId: eventHosts.userId })
      .from(eventHosts)
      .where(eq(eventHosts.eventId, input.eventId));
    if (held && held.userId !== application.userId) {
      return {
        ok: false as const,
        error: "Somebody else already hosts that event.",
        errors: {
          eventId:
            "A host is one grant per event. Create this applicant an event of their own.",
        },
      };
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

/* ------------------------------------------------------------------ */
/* The event the application becomes                                  */
/* ------------------------------------------------------------------ */

/**
 * The questions the application already wrote (UC-21 2).
 *
 * "What do you need to know about each player" is the field the whole form
 * exists for, and until now it was a paragraph an admin re-typed into the
 * Questions tab. One line of it is one short-answer question, in the order they
 * wrote them, and the admin edits them afterwards like any other — this
 * prefills, it does not guess: nothing here invents a type, an option list or a
 * profile link, because getting those wrong is more work to undo than to type.
 *
 * Everything is `required`, because the host said they need it.
 */
export function questionsFromApplication(
  playerInfoNeeded: string
): Array<{ label: string; type: "text"; required: true }> {
  return playerInfoNeeded
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_EVENT_QUESTIONS)
    .map((label) => ({ label, type: "text" as const, required: true as const }));
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
