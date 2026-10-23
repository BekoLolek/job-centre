/**
 * The audit log — who did what, and when (Phase 5).
 *
 * ## Why the writes live in the action layer
 *
 * `recordAudit` is called from the action files under `src/app` and from
 * nowhere else, and that is a rule rather than an accident. They are the trust
 * boundary: they are the only layer that has run `requireAdmin()` and therefore
 * the only layer that knows *who is acting*. The rules modules underneath —
 * `events.ts`, `draft.ts`, `format.ts` — take a `Database` and are called by
 * tests, by seeds, by preview helpers and by each other, so an insert scattered
 * in there would log a phantom every time a test set something up and would log
 * nothing at all about the person who pressed the button.
 *
 * The corollary is that a write which succeeds in the library and then fails to
 * log is possible. That is the correct trade: the log is a record of intent,
 * and losing a line from it must never cost somebody their application. Hence
 * {@link recordAudit} swallowing its own errors.
 *
 * ## Append-only
 *
 * There is no update and no delete in this module, and there is no other
 * writer. The single `.delete` reachable anywhere near this table is the
 * `events` cascade, and nothing in the application deletes an event.
 *
 * ## What is *not* stored
 *
 * Profile answers, application answers, bid amounts before a lot settles. The
 * log says an application was accepted, not what was in it. Everything a line
 * carries is something already visible on a page to whoever can read the log.
 */

import { and, desc, eq, inArray, lt } from "drizzle-orm";
import {
  type AuditRow,
  type Database,
  type SettingValue,
  auditLog,
  db as defaultDb,
  events,
  users,
} from "@/db";

/* ------------------------------------------------------------------ */
/* The vocabulary                                                     */
/* ------------------------------------------------------------------ */

/**
 * Everything the log records, and the word the screen puts in front of it.
 *
 * Stored as text rather than a Postgres enum for the same reason `events.type`
 * is: adding a line to this list must not be a migration. A row whose action is
 * not in this map still renders — `actionLabel` falls back to the raw string —
 * because a log that hides rows it does not recognise is worse than a log with
 * an ugly line in it.
 */
export const AUDIT_ACTIONS = {
  "event.created": "Event created",
  "event.status": "Status changed",
  "event.published": "Published",
  "event.reopened": "Reopened",
  "event.basics": "Setup changed",
  "event.entryRules": "Entry rules changed",
  "event.days": "Days changed",
  "event.questions": "Application form changed",
  /*
   * What kind of event this is — teams or not, draft or not, how the sides are
   * sized (R-217, R-218 / UC-42).
   *
   * Its own action rather than a detail on `event.basics`, because it is the
   * line somebody scans for when four tabs have gone from an editor they were
   * using: "who turned the teams off, and did the teams go with them" is a
   * question only this row answers. Deliberately not called "Format changed" —
   * `format.stages` below already is, and it means the bracket.
   */
  "event.shape": "Event format changed",
  "application.decided": "Application decided",
  "application.availability": "Applicant's days corrected",
  "waiver.granted": "Entry rule waived",
  "waiver.revoked": "Entry waiver withdrawn",
  "team.set": "Teams changed",
  "team.count": "Team count changed",
  "team.roster": "Roster changed by hand",
  "team.captains": "Captains changed",
  "draft.config": "Draft rules changed",
  "draft.pool": "Draft pool changed",
  "draft.awarded": "Lot awarded",
  "draft.voided": "Lot voided",
  "draft.discarded": "Lot discarded",
  "result.recorded": "Result recorded",
  "result.cleared": "Result cleared",
  "result.override": "Winner overturned",
  "match.reflip": "Coin re-flipped",
  "schedule.applied": "Schedule rebuilt",
  // "Bracket", not "Format": the Setup panel called Format is `event.shape`
  // above, and this row is the stages — the thing the Bracket step edits.
  "format.stages": "Bracket changed",
  "format.generated": "Bracket generated",
  "settings.announcements": "Announcements changed",
  "settings.guild_gate": "Sign-in gate changed",
  "suggestion.status": "Suggestion updated",
  "poll.created": "Poll posted",
  "poll.updated": "Poll changed",
  "poll.closed": "Poll closed",
  "poll.deleted": "Poll deleted",
  "host.applied": "Host application sent",
  "host.approved": "Host application approved",
  "host.declined": "Host application declined",
  "settings.integrations": "Integrations changed",
  "announcement.failed": "Announcement failed",
  "announcement.wording_changed": "Announcement wording changed",
  "announcement.pings_everyone": "Announcement set to ping everyone",
  /*
   * An announcement an admin pressed a button to send (R-221 / UC-43 5).
   *
   * Its own action rather than a flag in a detail blob, for the reason
   * `announcement.pings_everyone` is one: "who posted that by hand" is a
   * question somebody asks of the log by scanning it, and a `byHand: true`
   * inside a detail object is not something a scan finds. It also tells the two
   * writers of an announcement apart — everything else in this list that posts
   * is something the site did on its own.
   */
  "announcement.posted_by_hand": "Announcement posted by hand",
  "user.admin.granted": "Admin granted",
  "user.admin.revoked": "Admin revoked",
  "user.sessions.ended": "Sessions ended",
  "user.note": "Note added",
  "template.created": "Template created",
  "template.updated": "Template changed",
  "template.duplicated": "Template duplicated",
  "template.from_event": "Template made from an event",
  "template.activated": "Template activated",
  "template.deactivated": "Template deactivated",
  "template.moved": "Templates reordered",
  "template.deleted": "Template deleted",
  "championship.created": "Championship created",
  "championship.updated": "Championship changed",
  "championship.status": "Championship status changed",
  "championship.reopened": "Championship reopened",
  "championship.event.added": "Event counts towards a championship",
  "championship.event.changed": "Counting event changed",
  "championship.event.removed": "Event stopped counting",
  "championship.result": "Championship result recorded",
  // The hero catalogue (R-214 / UC-40 4). `hero.renamed` is the one that has to
  // be here: after the write nothing on the row says the hero was ever called
  // anything else, so this line is the only record of the old name — and the
  // only way to recognise the duplicate a later re-seed plants under it.
  "hero.added": "Hero added",
  "hero.renamed": "Hero renamed",
  "hero.roles": "Hero roles changed",
  "hero.retired": "Hero retired",
  "hero.restored": "Hero brought back",
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

/** The heading for one action, or the raw string when it is one we do not know. */
export function actionLabel(action: string): string {
  return (AUDIT_ACTIONS as Record<string, string>)[action] ?? action;
}

/** The actions worth colouring differently — the ones that took something away. */
const DESTRUCTIVE: ReadonlySet<string> = new Set([
  "draft.voided",
  "draft.discarded",
  "result.cleared",
  "result.override",
  "format.generated",
  "format.stages",
  "announcement.failed",
  // The poll goes and every vote on it goes with it, by cascade.
  "poll.deleted",
  // Taking the admin flag away is the one line on this log that changes who can
  // read the log, so it gets the colour that says "look at this one".
  "user.admin.revoked",
  // Somebody was signed out of every device they had open (UC-02 4a).
  "user.sessions.ended",
  "template.deactivated",
  // The row goes. Every event made from it keeps running (UC-28 8a) — a
  // template holds a setup, not history — but the starting point itself is
  // gone, and this is the line that says who removed it.
  "template.deleted",
  // It takes a season's results away with it: the places recorded in that event
  // go by the cascade, and the standings re-score without them.
  "championship.event.removed",
]);

/** The actions that hand something out. Read next to `DESTRUCTIVE` above. */
const NOTABLE: ReadonlySet<string> = new Set(["user.admin.granted"]);

export function actionTone(action: string): "union" | "flare" | "muted" {
  if (DESTRUCTIVE.has(action)) return "flare";
  if (action === "announcement.failed") return "flare";
  /*
   * Not destructive — nothing is lost — but it is the one audit line that says
   * the site has been pointed at four hundred people at once, and R-202 made
   * that an admin's choice rather than a ban. It reads in the same tone as a
   * failed announcement for the same reason: both are lines you want to find
   * without filtering for them. Only the transition is recorded, so this is
   * not a row per post (UC-37 4c).
   */
  if (action === "announcement.pings_everyone") return "flare";
  if (NOTABLE.has(action)) return "union";
  return action.startsWith("draft.") || action.startsWith("result.") ? "union" : "muted";
}

/* ------------------------------------------------------------------ */
/* Writing                                                            */
/* ------------------------------------------------------------------ */

export type AuditEntry = {
  action: AuditAction | (string & {});
  /** The sentence the log shows. Written now, never rebuilt on read. */
  summary: string;
  /** Who did it. Null only for something the system did to itself. */
  actor?: { id: string; displayName?: string | null; name?: string | null } | null;
  eventId?: string | null;
  /** What was acted on — an application id, a lot id, a match slot. */
  subject?: string | null;
  detail?: Record<string, SettingValue>;
  now?: Date;
};

/**
 * Write one line.
 *
 * **Never throws and never rejects.** A failed insert is logged to the server
 * console and swallowed, because every caller is an action that has already
 * succeeded: the application was accepted, the lot was awarded, the result is
 * recorded. Turning "the log is full" into "your application failed" would be a
 * strictly worse outcome than a missing line, and the caller has nothing
 * sensible it could do with the error anyway.
 *
 * Returns the row when it landed, so a test can assert on it without a second
 * read, and `null` when it did not.
 */
export async function recordAudit(
  entry: AuditEntry,
  database: Database = defaultDb
): Promise<AuditRow | null> {
  try {
    const [row] = await database
      .insert(auditLog)
      .values({
        at: entry.now ?? new Date(),
        actorUserId: entry.actor?.id ?? null,
        actorName: entry.actor
          ? (entry.actor.displayName ?? entry.actor.name ?? null)
          : null,
        action: entry.action,
        eventId: entry.eventId ?? null,
        subject: entry.subject ?? null,
        summary: entry.summary.trim().slice(0, 500),
        detail: entry.detail ?? {},
      })
      .returning();
    return row ?? null;
  } catch (error) {
    console.error("[audit] could not record an entry; the action itself succeeded", error);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

export type AuditView = {
  id: string;
  at: Date;
  action: string;
  label: string;
  tone: "union" | "flare" | "muted";
  summary: string;
  subject: string | null;
  detail: Record<string, SettingValue>;
  actor: {
    id: string | null;
    /** The snapshot, falling back to the live row when the snapshot is missing. */
    name: string;
    handle: string | null;
  };
  event: { id: string; title: string; slug: string } | null;
};

export type ListAuditOptions = {
  /** Only this event's lines. */
  eventId?: string | null;
  /** Default 100. The screen pages with `before`. */
  limit?: number;
  /** Everything strictly older than this instant — the "load more" cursor. */
  before?: Date | null;
};

/**
 * The log, newest first, optionally filtered to one event (§4).
 *
 * Two queries rather than a three-way join: the rows, then the handful of
 * events and actors they mention. It reads more clearly, and the second query
 * is what lets an actor's *live* handle appear next to their *stored* name, so
 * the line still says who it was and the link still goes somewhere.
 */
export async function listAudit(
  options: ListAuditOptions = {},
  database: Database = defaultDb
): Promise<AuditView[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);

  const filters = [
    options.eventId ? eq(auditLog.eventId, options.eventId) : undefined,
    options.before ? lt(auditLog.at, options.before) : undefined,
  ].filter(Boolean);

  const rows = await database
    .select()
    .from(auditLog)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(limit);

  if (rows.length === 0) return [];

  const eventIds = [...new Set(rows.map((row) => row.eventId).filter(Boolean))] as string[];
  const actorIds = [...new Set(rows.map((row) => row.actorUserId).filter(Boolean))] as string[];

  const [eventRows, actorRows] = await Promise.all([
    eventIds.length > 0
      ? database
          .select({ id: events.id, title: events.title, slug: events.slug })
          .from(events)
          .where(inArray(events.id, eventIds))
      : Promise.resolve([]),
    actorIds.length > 0
      ? database
          .select({
            id: users.id,
            displayName: users.displayName,
            name: users.name,
            handle: users.handle,
          })
          .from(users)
          .where(inArray(users.id, actorIds))
      : Promise.resolve([]),
  ]);

  const eventById = new Map(eventRows.map((row) => [row.id, row]));
  const actorById = new Map(actorRows.map((row) => [row.id, row]));

  return rows.map((row) => {
    const actor = row.actorUserId ? actorById.get(row.actorUserId) : undefined;
    return {
      id: row.id,
      at: row.at,
      action: row.action,
      label: actionLabel(row.action),
      tone: actionTone(row.action),
      summary: row.summary,
      subject: row.subject,
      detail: row.detail ?? {},
      actor: {
        id: row.actorUserId,
        // The snapshot wins: it is what they were called when it happened.
        name: row.actorName ?? actor?.displayName ?? actor?.name ?? "The system",
        handle: actor?.handle ?? null,
      },
      event: eventById.get(row.eventId ?? "") ?? null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* The event filter                                                   */
/* ------------------------------------------------------------------ */

/** As much of an event as the filter needs to name one. */
export type AuditFilterEvent = { id: string; title: string };

/**
 * What `?event=` on `/admin/audit` turned out to mean (R-110 / UC-27 3).
 *
 * Three answers, and the third is the one this type exists for.
 */
export type AuditFilter =
  | { kind: "all" }
  | { kind: "event"; event: AuditFilterEvent }
  | { kind: "unknown"; raw: string };

/**
 * Read `?event=` against the events that exist.
 *
 * The page used to do this inline, as `events.some(…) ? raw : null` — an id
 * that matched nothing fell back to "everything", with a comment arguing that
 * a stale bookmark is likelier than an event with no entries, so showing the
 * whole log is the kinder answer.
 *
 * It is not, and the browser proves it: `/admin/audit?event=not-a-uuid` shows
 * every line on the site under a heading that says "Everything", with nothing
 * anywhere to say that a filter was asked for and dropped. This is the log
 * disputes are settled from. An admin who follows a link to one event's
 * history and is silently handed all of them reads the first few lines as that
 * event's, and they are not. Saying "that filter does not name an event" costs
 * one sentence and cannot be misread.
 *
 * A blank or absent parameter is `all`, which is the ordinary state of the page
 * and not an error.
 *
 * Pure, and takes the events rather than reading them, so the three outcomes
 * are testable without a request or a database.
 */
export function resolveAuditFilter(
  raw: string | string[] | null | undefined,
  events: readonly AuditFilterEvent[]
): AuditFilter {
  const wanted = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? "";
  if (!wanted) return { kind: "all" };

  const event = events.find((row) => row.id === wanted);
  return event ? { kind: "event", event } : { kind: "unknown", raw: wanted };
}

/** How many lines the log holds, optionally for one event. */
export async function countAudit(
  eventId: string | null = null,
  database: Database = defaultDb
): Promise<number> {
  const rows = await database
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(eventId ? eq(auditLog.eventId, eventId) : undefined);
  return rows.length;
}
