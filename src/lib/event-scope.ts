import { eq } from "drizzle-orm";
import { type Database, applications, db as defaultDb, matches, stages } from "@/db";

/**
 * Which event a child row belongs to.
 *
 * This exists because of one specific hole that opened the moment hosts did.
 *
 * Every event action takes an `eventId` — but for the actions keyed on a child
 * (an application, a match, a stage) that argument was only ever used to
 * revalidate the right page. The *write* is keyed on the child id, and the
 * library reads the child's own event to decide what it may do. Under
 * `requireAdmin()` that was harmless, because an admin may touch every event
 * anyway.
 *
 * Under a host's permission it is a privilege escalation: pass the id of the
 * event you host to satisfy the guard, pass a match id from somebody else's
 * event to the write, and the guard has checked a fact that has nothing to do
 * with what is about to happen.
 *
 * So for those actions the event is resolved *from the child* and the
 * argument is not trusted for anything. The rule is worth stating plainly
 * because it will come up again the next time an action is added:
 *
 *   **Authorise on the row you are about to write, never on an id beside it.**
 */

export async function eventIdOfApplication(
  applicationId: string,
  database: Database = defaultDb
): Promise<string | null> {
  const [row] = await database
    .select({ eventId: applications.eventId })
    .from(applications)
    .where(eq(applications.id, applicationId));
  return row?.eventId ?? null;
}

export async function eventIdOfMatch(
  matchId: string,
  database: Database = defaultDb
): Promise<string | null> {
  const [row] = await database
    .select({ eventId: matches.eventId })
    .from(matches)
    .where(eq(matches.id, matchId));
  return row?.eventId ?? null;
}

export async function eventIdOfStage(
  stageId: string,
  database: Database = defaultDb
): Promise<string | null> {
  const [row] = await database
    .select({ eventId: stages.eventId })
    .from(stages)
    .where(eq(stages.id, stageId));
  return row?.eventId ?? null;
}
