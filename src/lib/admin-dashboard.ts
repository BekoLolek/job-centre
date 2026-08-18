/**
 * `/admin` — what needs attention (docs/platform-plan.md §4).
 *
 * "Pending applications, unscheduled matches." This is the page you have open
 * on the night, so it answers exactly one question — *what should I do next* —
 * and every answer is a link to the screen that does it.
 *
 * ## Everything here is derived
 *
 * There is no `needs_attention` column and there must never be one, for the
 * same reason there is no `applications_open` (§14): a stored to-do outlives
 * the thing it was about. An admin who accepts the last applicant and still
 * sees "3 waiting" stops trusting the page, and a dashboard nobody trusts is
 * worse than no dashboard. So each item is a count taken now.
 *
 * ## Which events are looked at
 *
 * Everything except `complete` and `cancelled`. A finished event is read-only
 * (`./archive-policy`), so nothing about it *can* need attention — and an
 * unfinished one always can, including a draft nobody else can see, which is
 * precisely where "ready to publish" lives.
 *
 * ## Nothing here decides a rule
 *
 * The publish checklist is `readiness()`'s, the drawn-series flag is
 * `format-resolve`'s `needsDecision`, the seat counts are `capacityState`'s.
 * This module counts what those already worked out and writes the sentence.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  type Database,
  type EventStatus,
  applications,
  db as defaultDb,
  draftLots,
  teams,
} from "@/db";
import { blockers, readiness } from "@/components/admin/events/readiness";
import { type EventDetail, type EventSummary, getEventById, listEvents } from "./events";
import { type FormatView, formatFor, matchIdsFor } from "./format";

/* ------------------------------------------------------------------ */
/* Shapes                                                             */
/* ------------------------------------------------------------------ */

export type AttentionKind =
  | "applications"
  | "publish"
  | "captains"
  | "lot_open"
  | "needs_winner"
  | "unscheduled";

export type AttentionItem = {
  /** Stable across renders, so React and a test can both name a row. */
  key: string;
  kind: AttentionKind;
  /** The line itself. Says the number and the thing. */
  label: string;
  /** Why it matters, in one sentence. */
  detail: string;
  /** The exact screen that fixes it (§4). */
  href: string;
  /** The word on the button. */
  action: string;
  /** How many of whatever it is. Drives the ordering. */
  count: number;
  /** `ember` is "the night is blocked on this"; `gold` is "do this next". */
  tone: "ember" | "gold";
  event: { id: string; title: string; slug: string; status: EventStatus };
};

export type DashboardView = {
  items: AttentionItem[];
  /** Events currently running. The hero of the page when there are any. */
  live: EventSummary[];
  /** Published and still to come, soonest first. */
  upcoming: EventSummary[];
  drafts: EventSummary[];
  totals: {
    events: number;
    waiting: number;
    needsWinner: number;
    unscheduled: number;
    openLots: number;
  };
};

/* ------------------------------------------------------------------ */
/* Loading                                                            */
/* ------------------------------------------------------------------ */

/** The statuses worth scanning. See the module comment. */
const ACTIVE: readonly EventStatus[] = ["draft", "published", "live"];

/**
 * Build the dashboard.
 *
 * One pass over the active events, then one `formatFor` each for the ones that
 * have a bracket. That is a handful of reads on a site that runs a few events
 * at a time, and the page is `force-dynamic`, so there is nothing to cache and
 * nothing to invalidate.
 */
export async function loadDashboard(
  options: { now?: Date } = {},
  database: Database = defaultDb
): Promise<DashboardView> {
  const now = options.now ?? new Date();
  const all = await listEvents({ now }, database);

  const active = all.filter((event) => ACTIVE.includes(event.status));
  const ids = active.map((event) => event.id);

  const [waitingRows, openLots, teamRows] = await Promise.all([
    ids.length > 0
      ? database
          .select({ id: applications.id, eventId: applications.eventId })
          .from(applications)
          // §14 makes applications first-come, so there is no `applied` status
          // to queue in — most people land accepted without anybody deciding
          // anything. What actually waits on an admin is somebody the *cap*
          // waitlisted rather than a person: `decided_at` null on a waitlisted
          // row. That is the same definition the editor's Applicants tab dots.
          .where(
            and(
              inArray(applications.eventId, ids),
              eq(applications.status, "waitlisted"),
              isNull(applications.decidedAt)
            )
          )
      : Promise.resolve([]),
    ids.length > 0
      ? database
          .select({ id: draftLots.id, eventId: draftLots.eventId })
          .from(draftLots)
          .where(and(inArray(draftLots.eventId, ids), eq(draftLots.status, "open")))
      : Promise.resolve([]),
    ids.length > 0
      ? database
          .select({
            id: teams.id,
            eventId: teams.eventId,
            captainUserId: teams.captainUserId,
          })
          .from(teams)
          .where(inArray(teams.eventId, ids))
      : Promise.resolve([]),
  ]);

  const waitingBy = tally(waitingRows.map((row) => row.eventId));
  const openBy = tally(openLots.map((row) => row.eventId));
  const teamsBy = tally(teamRows.map((row) => row.eventId));
  const captainlessBy = tally(
    teamRows.filter((row) => !row.captainUserId).map((row) => row.eventId)
  );

  const items: AttentionItem[] = [];
  let needsWinner = 0;
  let unscheduled = 0;

  for (const event of active) {
    const at = { id: event.id, title: event.title, slug: event.slug, status: event.status };
    const editor = (tab: string) => `/admin/events/${event.id}?tab=${tab}`;

    /* --- applications nobody has decided ---------------------------- */
    const waiting = waitingBy.get(event.id) ?? 0;
    if (waiting > 0) {
      items.push({
        key: `${event.id}:applications`,
        kind: "applications",
        label: `${waiting} ${waiting === 1 ? "applicant is" : "applicants are"} waiting for a seat`,
        detail:
          "The cap queued them and nobody has looked since. Accept one to override the cap, or leave them for the next withdrawal.",
        href: editor("applicants"),
        action: "Decide them",
        count: waiting,
        tone: "gold",
        event: at,
      });
    }

    /* --- a lot on the block ----------------------------------------- */
    const open = openBy.get(event.id) ?? 0;
    if (open > 0) {
      items.push({
        key: `${event.id}:lot`,
        kind: "lot_open",
        label: "A lot is on the block",
        detail:
          "The draft is waiting on you to award it, send them to the reserve pool, or cancel the lot.",
        href: `/events/${event.slug}/draft`,
        action: "Open the room",
        count: open,
        tone: "ember",
        event: at,
      });
    }

    /* --- ready to publish -------------------------------------------- */
    if (event.status === "draft") {
      const detail = await getEventById(event.id, { now }, database);
      if (detail) {
        const stopped = blockers(readiness(detail));
        items.push(
          stopped.length === 0
            ? {
                key: `${event.id}:publish`,
                kind: "publish",
                label: "Ready to publish",
                detail:
                  "Nothing is stopping it. Until you publish it, no member can see that it exists.",
                href: editor("publish"),
                action: "Publish it",
                count: 1,
                tone: "gold",
                event: at,
              }
            : {
                key: `${event.id}:publish`,
                kind: "publish",
                label: `${stopped.length} ${stopped.length === 1 ? "thing" : "things"} to fix before it can be published`,
                detail: stopped.map((check) => check.label).join(" · "),
                href: editor("publish"),
                action: "Fix them",
                count: stopped.length,
                tone: "gold",
                event: at,
              }
        );
      }
    }

    /* --- captains ---------------------------------------------------- */
    const teamCount = teamsBy.get(event.id) ?? 0;
    const captainless = captainlessBy.get(event.id) ?? 0;
    if (teamCount > 0 && captainless > 0 && event.status !== "draft") {
      items.push({
        key: `${event.id}:captains`,
        kind: "captains",
        label: `${captainless} of ${teamCount} teams without a captain`,
        detail: "A team with no captain cannot bid, so the draft cannot start.",
        href: editor("captains"),
        action: "Choose them",
        count: captainless,
        tone: "gold",
        event: at,
      });
    }

    /* --- the board --------------------------------------------------- */
    const board = await boardCounts(event.id, database);
    if (board) {
      if (board.needsWinner > 0) {
        needsWinner += board.needsWinner;
        items.push({
          key: `${event.id}:winner`,
          kind: "needs_winner",
          label: `${board.needsWinner} ${board.needsWinner === 1 ? "series needs" : "series need"} a winner`,
          detail:
            "Every game is in and the series is drawn, so nothing above it on the bracket can resolve until somebody calls it.",
          href: editor("results"),
          action: "Call them",
          count: board.needsWinner,
          tone: "ember",
          event: at,
        });
      }

      if (board.unscheduled > 0) {
        unscheduled += board.unscheduled;
        items.push({
          key: `${event.id}:schedule`,
          kind: "unscheduled",
          label: `${board.unscheduled} ${board.unscheduled === 1 ? "match has" : "matches have"} no time`,
          detail:
            "Give each day a start time and the running order fills itself in from the format.",
          href: editor("schedule"),
          action: "Lay it out",
          count: board.unscheduled,
          tone: "gold",
          event: at,
        });
      }
    }
  }

  // Blocked first, then the biggest pile. Within an event the order the checks
  // were pushed in is already the order you would work through them.
  items.sort((a, b) => {
    if (a.tone !== b.tone) return a.tone === "ember" ? -1 : 1;
    return b.count - a.count;
  });

  return {
    items,
    live: all.filter((event) => event.status === "live"),
    upcoming: all.filter(
      (event) =>
        event.status === "published" &&
        (event.startsAt === null || event.startsAt.getTime() >= now.getTime())
    ),
    drafts: all.filter((event) => event.status === "draft"),
    totals: {
      events: active.length,
      waiting: waitingRows.length,
      needsWinner,
      unscheduled,
      openLots: openLots.length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function tally(ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of ids) out.set(id, (out.get(id) ?? 0) + 1);
  return out;
}

type BoardCounts = {
  needsWinner: number;
  unscheduled: number;
};

/**
 * The three board questions, over the matches that actually exist.
 *
 * `matchIdsFor` is the filter that matters and it is the same one the Format
 * tab uses: `formatFor` resolves a stage's matches from its generated spec
 * whether or not a single row has been written, so counting those would put
 * "six matches have no time" on an event whose bracket has never been
 * generated — a to-do for work nobody has started.
 */
async function boardCounts(
  eventId: string,
  database: Database
): Promise<BoardCounts | null> {
  const [view, ids] = await Promise.all([
    formatFor(eventId, database),
    matchIdsFor(eventId, database),
  ]);
  if (!view) return null;

  const stored = storedMatches(view, ids);

  return {
    needsWinner: stored.filter((match) => match.needsDecision).length,
    // A skipped bracket reset is not an unscheduled match — it is a match that
    // is never going to be played.
    unscheduled: stored.filter((match) => !match.scheduledAt && !match.skipped).length,
  };
}

function storedMatches(view: FormatView, ids: Record<string, string>) {
  return view.stages.flatMap((stage) => stage.matches).filter((match) => ids[match.slot]);
}

/** Re-exported so the page can render an event's own line without a second read. */
export type { EventDetail };
