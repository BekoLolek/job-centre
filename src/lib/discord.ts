/**
 * Posting the announcements (docs/platform-plan.md §14, checklist.md F2).
 *
 * `./announce` decides what a message *says*; this is the only place that talks
 * to the outside world, and it exists as its own module so that the sentences
 * can be tested exhaustively without a single test ever making a request.
 *
 * ## The non-negotiable
 *
 * **A missing or broken webhook must never fail the action that triggered it.**
 * The member's application succeeded whether or not Discord heard about it, and
 * a lot that was awarded stays awarded if the channel has been deleted. Three
 * separate things enforce that:
 *
 *  1. {@link announce} is `void`, not `Promise<void>`. There is nothing to
 *     await, so no caller can accidentally make the response wait on a network
 *     round trip — and no caller can accidentally propagate a rejection either.
 *  2. The work is handed to Next's `after()`, which runs it once the response
 *     has been sent. The request is finished before the `fetch` starts.
 *  3. Every path inside {@link deliver} is inside a `try`. A DNS failure, a 404
 *     from a deleted webhook, a 429, a timeout and a malformed URL all end in
 *     the same place: a console line and a row in the audit log.
 *
 * ## …and the failure is visible
 *
 * Swallowing an error silently is the other way to get this wrong. A failure
 * writes `announcement.failed` to the audit log with the status code and the
 * kind, so `/admin/audit` shows "Announcement failed — event published, 404"
 * next to everything else that happened that night. The console line is for
 * whoever is watching the server; the audit row is for whoever is not.
 *
 * ## Switched off by default
 *
 * With `DISCORD_WEBHOOK_URL` unset, `webhookUrl()` is `null` and `deliver`
 * returns before it reads a setting or touches the database. The whole feature
 * is an inert no-op, exactly as blank Discord credentials are on `/signin`.
 */

import { after } from "next/server";
import { eq } from "drizzle-orm";
import {
  type Database,
  SETTING_KEYS,
  applications,
  db as defaultDb,
  draftLots,
  events,
  matches,
  settings,
  teams,
  users,
} from "@/db";
import {
  type AnnouncementKind,
  type AnnouncementSettings,
  type DiscordMessage,
  announcementSettingsFrom,
  announcementSettingsValue,
  applicationDecidedMessage,
  eventPublishedMessage,
  lotSoldMessage,
  matchResultMessage,
  siteOrigin,
  webhookUrl,
} from "./announce";
import { recordAudit } from "./audit";
import { formatFor } from "./format";

/* ------------------------------------------------------------------ */
/* The setting                                                        */
/* ------------------------------------------------------------------ */

/**
 * Which announcements are switched on.
 *
 * Never throws: a database that is down at the moment a lot is awarded must not
 * take the award with it, and "we could not read the setting" is not a reason
 * to post something nobody asked for either — so a failed read falls back to
 * the defaults with a logged line.
 */
export async function getAnnouncementSettings(
  database: Database = defaultDb
): Promise<AnnouncementSettings> {
  try {
    const [row] = await database
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SETTING_KEYS.announcements))
      .limit(1);
    return announcementSettingsFrom(row?.value);
  } catch (error) {
    console.error("[discord] could not read the announcement settings", error);
    return announcementSettingsFrom(undefined);
  }
}

/** Write the whole toggle set. The admin screen sends all five together. */
export async function setAnnouncementSettings(
  next: AnnouncementSettings,
  database: Database = defaultDb
): Promise<AnnouncementSettings> {
  const value = announcementSettingsValue(next);
  await database
    .insert(settings)
    .values({ key: SETTING_KEYS.announcements, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date() },
    });
  return announcementSettingsFrom(value);
}

/* ------------------------------------------------------------------ */
/* Posting                                                            */
/* ------------------------------------------------------------------ */

/** How long a webhook gets before we give up on it. */
const TIMEOUT_MS = 5_000;

export type AnnounceContext = {
  /** So a failure shows up under the right event on `/admin/audit`. */
  eventId?: string | null;
};

/**
 * Post one announcement, after the response has gone out.
 *
 * Returns nothing, synchronously. Read the module comment before changing that:
 * the signature *is* the guarantee.
 */
export function announce(
  kind: AnnouncementKind,
  message: DiscordMessage,
  context: AnnounceContext = {}
): void {
  // Cheapest possible check first, so an install with no webhook configured
  // does not even schedule work — let alone read a setting.
  if (!webhookUrl()) return;

  defer(() => deliver(kind, message, context));
}

/**
 * As {@link announce}, but the message is *gathered* after the response too.
 *
 * The four announcers below need a name, a team, a title and a slug that the
 * action does not have to hand, and reading them before returning would put
 * three queries in front of the member's "you're in" — for a message they are
 * not waiting for. So the whole job, reads included, happens in `after()`, and
 * the action hands over an id.
 *
 * A builder that returns `null` means "on reflection, do not post": a part-
 * recorded series, a lot that turned out not to be an award, a row that has
 * been changed again since. That is a decision the gathered data makes, so it
 * belongs here rather than in the action.
 */
function announceGathered(
  kind: AnnouncementKind,
  build: () => Promise<DiscordMessage | null>,
  context: AnnounceContext = {}
): void {
  if (!webhookUrl()) return;

  defer(async () => {
    let message: DiscordMessage | null = null;
    try {
      const enabled = await getAnnouncementSettings();
      if (!enabled[kind]) return;
      message = await build();
    } catch (error) {
      await noteFailure(
        kind,
        context,
        error instanceof Error
          ? `it could not be built (${error.message})`
          : "it could not be built",
        {}
      );
      return;
    }
    if (message) await deliver(kind, message, context);
  });
}

/**
 * Run something once the response is sent.
 *
 * `after()` is the correct home for this on a deployment: it keeps the work
 * inside the request's lifetime so a serverless function is not frozen halfway
 * through the `fetch`, without the response waiting for it. Outside a request
 * scope — a script, a test, a background job — `after()` throws, and there a
 * detached promise is both available and fine.
 */
function defer(work: () => Promise<void>): void {
  try {
    after(work);
  } catch {
    void work().catch((error: unknown) => {
      console.error("[discord] announcement failed outside a request scope", error);
    });
  }
}

async function deliver(
  kind: AnnouncementKind,
  message: DiscordMessage,
  context: AnnounceContext
): Promise<void> {
  const url = webhookUrl();
  if (!url) return;

  const enabled = await getAnnouncementSettings();
  if (!enabled[kind]) return;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Never cached, never deduplicated: two awards for the same price at the
      // same second are two announcements.
      cache: "no-store",
    });

    if (!response.ok) {
      await noteFailure(kind, context, `Discord answered ${response.status}.`, {
        status: response.status,
      });
    }
  } catch (error) {
    await noteFailure(
      kind,
      context,
      error instanceof Error ? error.message : "The request did not complete.",
      {}
    );
  }
}

/**
 * Record that an announcement did not go out.
 *
 * Itself wrapped, because the whole point of this module is that nothing it
 * does can throw into a caller — and `after()`'s callback rejecting would be a
 * logged unhandled rejection in production for no benefit.
 */
async function noteFailure(
  kind: AnnouncementKind,
  context: AnnounceContext,
  reason: string,
  detail: Record<string, string | number>
): Promise<void> {
  console.error(`[discord] the "${kind}" announcement failed: ${reason}`);
  try {
    await recordAudit({
      action: "announcement.failed",
      summary: `The "${kind}" announcement did not go out — ${reason}`,
      eventId: context.eventId ?? null,
      subject: kind,
      detail: { kind, reason, ...detail },
    });
  } catch (error) {
    console.error("[discord] could not record the announcement failure either", error);
  }
}

/* ------------------------------------------------------------------ */
/* The four announcers                                                */
/* ------------------------------------------------------------------ */

/**
 * Every one of these takes an **id** and returns nothing, synchronously.
 *
 * An id rather than a built message, because the alternative is an action
 * assembling a Discord payload — which would put the wording of an announcement
 * in the one layer that is supposed to guard and delegate, and would let two
 * call sites describe the same event differently. An id is also the only thing
 * an action reliably has: `recordGames` hands back a finish time, not a
 * scoreline.
 */

/** An event went public. */
export function announceEventPublished(eventId: string, database: Database = defaultDb): void {
  announceGathered(
    "event_published",
    async () => {
      const [event] = await database.select().from(events).where(eq(events.id, eventId)).limit(1);
      // Only ever announce something that is actually published — a status that
      // moved on again between the click and the callback is not news.
      if (!event || event.status !== "published") return null;

      return eventPublishedMessage({
        title: event.title,
        slug: event.slug,
        type: event.type,
        description: event.description,
        capacity: event.capacity,
        startsAt: event.startsAt,
        signupClosesAt: event.signupClosesAt,
        origin: siteOrigin(),
      });
    },
    { eventId }
  );
}

/**
 * Somebody was accepted, or waitlisted.
 *
 * Nothing is announced for `declined` or `withdrawn`, and there is no setting
 * that would turn them on. Being turned down is not news, it is somebody's
 * afternoon, and a channel that posts it is a channel that costs the community
 * more than the integration is worth.
 */
export function announceApplicationDecision(
  applicationId: string,
  database: Database = defaultDb
): void {
  const kinds = {
    accepted: "application_accepted",
    waitlisted: "application_waitlisted",
  } as const;

  announceGathered(
    // The kind is not known until the row is read, so the gate is applied
    // inside the builder as well. This outer kind only picks the setting that
    // is checked first; a mismatch simply means the builder returns null.
    "application_accepted",
    async () => {
      const [row] = await database
        .select({
          status: applications.status,
          waitlistPosition: applications.waitlistPosition,
          eventId: applications.eventId,
          member: users.displayName,
          fallbackName: users.name,
          eventTitle: events.title,
          slug: events.slug,
        })
        .from(applications)
        .innerJoin(users, eq(applications.userId, users.id))
        .innerJoin(events, eq(applications.eventId, events.id))
        .where(eq(applications.id, applicationId))
        .limit(1);

      if (!row) return null;
      if (row.status !== "accepted" && row.status !== "waitlisted") return null;

      // The waitlisted kind has its own toggle and it defaults off, so it is
      // checked here rather than relying on the outer one.
      const kind = kinds[row.status];
      const enabled = await getAnnouncementSettings(database);
      if (!enabled[kind]) return null;

      return applicationDecidedMessage(kind, {
        member: row.member ?? row.fallbackName ?? "A member",
        eventTitle: row.eventTitle,
        slug: row.slug,
        waitlistPosition: row.waitlistPosition,
        origin: siteOrigin(),
      });
    }
  );
}

/** A lot settled with a winner and a price. */
export function announceLotSold(lotId: string, database: Database = defaultDb): void {
  announceGathered(
    "draft_lot_sold",
    async () => {
      const [row] = await database
        .select({
          status: draftLots.status,
          price: draftLots.price,
          eventId: draftLots.eventId,
          player: users.displayName,
          fallbackName: users.name,
          team: teams.name,
          eventTitle: events.title,
          slug: events.slug,
        })
        .from(draftLots)
        .innerJoin(users, eq(draftLots.playerUserId, users.id))
        .innerJoin(teams, eq(draftLots.winnerTeamId, teams.id))
        .innerJoin(events, eq(draftLots.eventId, events.id))
        .where(eq(draftLots.id, lotId))
        .limit(1);

      // A lot voided in the seconds between the award and the callback must not
      // be announced as a sale — the undo is the whole reason lots are rows.
      if (!row || row.status !== "awarded") return null;

      return lotSoldMessage({
        player: row.player ?? row.fallbackName ?? "A player",
        team: row.team,
        price: row.price ?? 0,
        eventTitle: row.eventTitle,
        slug: row.slug,
        origin: siteOrigin(),
      });
    }
  );
}

/**
 * A series was decided.
 *
 * Nothing is posted for a card that is half filled in. `recordGames` is called
 * on every keystroke-sized save the results screen makes, and a channel that
 * says "0–0" four times before a match starts is a channel switched off within
 * the hour — so the announcement waits for `status === "done"`, which is
 * `format-resolve`'s own answer to "is this settled".
 */
export function announceMatchResult(matchId: string, database: Database = defaultDb): void {
  announceGathered(
    "match_result",
    async () => {
      const [match] = await database
        .select({ eventId: matches.eventId, slot: matches.slot })
        .from(matches)
        .where(eq(matches.id, matchId))
        .limit(1);
      if (!match) return null;

      const [event] = await database
        .select({ title: events.title, slug: events.slug })
        .from(events)
        .where(eq(events.id, match.eventId))
        .limit(1);
      if (!event) return null;

      const view = await formatFor(match.eventId, database);
      const resolved = view?.stages
        .flatMap((stage) => stage.matches)
        .find((row) => row.slot === match.slot);
      if (!resolved || resolved.status !== "done") return null;

      const named = new Map((view?.teams ?? []).map((team) => [team.id, team.name]));

      return matchResultMessage({
        label: resolved.displayLabel,
        teamA: resolved.nameA,
        teamB: resolved.nameB,
        gamesWonA: resolved.gamesWonA,
        gamesWonB: resolved.gamesWonB,
        winner: resolved.winner ? (named.get(resolved.winner) ?? null) : null,
        eventTitle: event.title,
        slug: event.slug,
        origin: siteOrigin(),
      });
    }
    // No `eventId` on the context: the action has a match id and the event is
    // only known once the read has happened, by which point a failure row would
    // have to be threaded back out. A failed result announcement is findable in
    // the unfiltered log, which is enough.
  );
}
