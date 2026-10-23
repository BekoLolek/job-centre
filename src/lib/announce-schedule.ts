import { inArray } from "drizzle-orm";
import { type Database, applications, db as defaultDb, events } from "@/db";
import { publishingOpensSignups, stamp } from "./announce";
import { readDatesFor } from "./events";
import { capacityState } from "./events-policy";

/**
 * The three announcements nobody triggers (R-205, R-206, R-207 / UC-38 2, 2a,
 * 3, 3a, 4, 4a, 4b, 4c, 5a, 5b).
 *
 * ## Why this is a module and not a call site
 *
 * Every other announcement is *reactive*: somebody published an event, somebody
 * awarded a lot, so the code that does the thing can also do the telling. These
 * three are not. Nothing happens at the moment applications open, or at the
 * moment an event becomes "closing tomorrow" or "starting in two hours" — the
 * clock simply moves, and if nobody is running, nobody is told. That is the
 * same argument
 * `src/app/api/cron/reminders/route.ts` makes about reminder DMs, and this is
 * the announcement half of the same wake.
 *
 * ## A window, not an instant
 *
 * The naive reading of "two hours before the event starts" is an equality test
 * on a timestamp, and it would never fire. A scheduler wakes when it wakes; it
 * does not wake at `startsAt − 2h` to the millisecond. So each moment is a
 * **window** measured on the event's own clock — fire while the target instant
 * is ahead of us but no further than its lead:
 *
 *     0 < target − now ≤ lead
 *
 * Both bounds are load-bearing, and they are the two acceptance criteria that
 * sound like footnotes:
 *
 *  - **The upper bound tolerates a late run.** The quarter-hour schedule in
 *    `.github/workflows/cron.yml` nominally wakes every
 *    {@link GITHUB_PING_INTERVAL_MS}, and GitHub's scheduler is best-effort:
 *    a run can be {@link GITHUB_PING_LATENESS_MS} late under load, never early.
 *    Two consecutive *effective* runs are therefore at worst
 *    `interval + lateness` apart — 30 minutes — so a closed window is certain
 *    to contain a run once it is at least that wide. The narrower of the two
 *    leads is {@link EVENT_STARTING_LEAD_MS}, two hours, which is four times
 *    that gap. Nothing here assumes exactness, and
 *    {@link SCHEDULE_TOLERATES_LATENESS} is the arithmetic rather than a
 *    comment claiming it.
 *  - **The lower bound refuses to post late** (UC-38 5b). The window ends *at*
 *    the instant it counts back from, so a scheduler that was down from
 *    `startsAt − 2h` until after the event started posts nothing. A reminder to
 *    turn up to an event that began yesterday is noise, and the window is what
 *    decides that — not the fact a row still exists.
 *
 * The window is deliberately as wide as the lead rather than a narrow band
 * around it, which is what makes the announcement go out at the *earliest* run
 * after the moment arrives: "two hours before" is the promise, so 1h58m is
 * right and 1h30m is what a narrow band would turn a late run into.
 *
 * ## What it does not do
 *
 * It decides **which** events are due and **what the facts are**. It does not
 * post, and it does not word anything: a window this wide only fires once per
 * event because a claim says so, and the sentence belongs in `./announce` with
 * every other sentence. See the note at the foot of this file.
 *
 * ## No instant is formatted here (a repo invariant)
 *
 * Every entry carries `stamp`, which is Discord's `<t:unix:…>` markup and not a
 * date anybody has formatted. Discord renders it in each reader's own timezone,
 * which is more correct than any string this site could choose — and the site
 * does not know the reader's zone to choose with. `./announce`'s {@link stamp}
 * is the one place that markup is built, so this reaches for it rather than
 * doing the arithmetic again.
 */

/* ------------------------------------------------------------------ */
/* The cadence this is scheduled at                                   */
/* ------------------------------------------------------------------ */

/**
 * How often `.github/workflows/cron.yml` asks for a wake: every quarter hour.
 *
 * Not Vercel's `0 12 * * *`. Vercel Hobby refuses to *deploy* a project whose
 * cron runs more than once a day (the route's docblock has the eighteen-day
 * story), and a two-hour reminder cannot come out of a daily run at all — so
 * the frequent pinger is GitHub Actions and the Vercel job stays as a backstop.
 */
export const GITHUB_PING_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How late a GitHub-scheduled run may be. Their own documentation warns that
 * scheduled workflows are delayed under load; 5 to 15 minutes is the range
 * quoted, so the worst case is the one taken here.
 *
 * It only ever runs *late*. A cron that fires early is not a thing, which is
 * why the gap below is `interval + lateness` and not twice the lateness.
 */
export const GITHUB_PING_LATENESS_MS = 15 * 60 * 1000;

/**
 * The longest a window may have to survive between two runs that actually
 * happened: one on time, the next the full lateness behind its slot.
 */
export const WORST_RUN_GAP_MS = GITHUB_PING_INTERVAL_MS + GITHUB_PING_LATENESS_MS;

/** One day before signups close (R-206 / UC-38 3). */
export const SIGNUP_CLOSING_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * Two hours before the **first dated day** starts (R-207 / UC-38 4).
 *
 * The first day's start, not a start on the event row: there is no start on the
 * event row. Dates are derived (R-24), drizzle/0026 dropped the columns, and
 * `readDatesFor` is the one answer to "when does this begin".
 */
export const EVENT_STARTING_LEAD_MS = 2 * 60 * 60 * 1000;

/**
 * The look-ahead for applications **opening** (R-205 / UC-38 2, 2a).
 *
 * The narrowest lead the schedule permits, and deliberately not a round number
 * somebody liked: exactly {@link WORST_RUN_GAP_MS}, the smallest window that is
 * still certain to contain a run. The other two leads are chosen by the
 * requirement — "one day before", "two hours before" are what R-206 and R-207
 * ask for — and this one is not, because R-205 asks for the channel to be told
 * *when signups open* rather than some period beforehand. So the lead here is
 * pure schedule tolerance, and every millisecond of it is a millisecond the
 * announcement can be early by.
 *
 * **Why it is forward-looking at all, when the moment it announces is "now".**
 * The window has to be forward-only, and that is the whole of how UC-38 2a is
 * satisfied without a `published_at` column (see
 * {@link dueScheduledAnnouncements}): an event whose signups were already open
 * when it was published has `signupOpensAt` in the past *forever*, so it never
 * enters a window of the form `0 < target − now ≤ lead` and never gets a second
 * announcement a moment after its first. A window that reached backwards — "it
 * opened within the last half hour" — would post one for every event ever
 * published into an open window, on the first run after this deploy, which is
 * exactly the double post 2a forbids.
 *
 * The cost is that this announcement can go out up to one gap **before** the
 * door actually opens, and `signupsOpenMessage`'s sentence reads "Applications
 * have opened". Half an hour is the worst case and it is the smallest worst
 * case available; it is recorded in docs/plan.md as Task 68's one open
 * question rather than papered over here, because narrowing it means either a
 * more frequent schedule or a reworded default, and a reworded default is a
 * golden that moves (see `AS_IT_WAS` in the tests).
 */
export const SIGNUPS_OPENING_LEAD_MS = WORST_RUN_GAP_MS;

/**
 * Whether every window is wide enough to be certain of catching a run, given
 * how late GitHub may be.
 *
 * Exported as the arithmetic rather than asserted in a comment, so that
 * shrinking a lead below the worst-case gap is a failing test and not a
 * discovery made in a quiet channel. See the module comment.
 */
export const SCHEDULE_TOLERATES_LATENESS =
  SIGNUP_CLOSING_LEAD_MS >= WORST_RUN_GAP_MS &&
  EVENT_STARTING_LEAD_MS >= WORST_RUN_GAP_MS &&
  SIGNUPS_OPENING_LEAD_MS >= WORST_RUN_GAP_MS;

/* ------------------------------------------------------------------ */
/* What is due                                                        */
/* ------------------------------------------------------------------ */

/** One event, due one of the two scheduled announcements. */
export type DueAnnouncement = {
  eventId: string;
  title: string;
  slug: string;
  /** The instant the window counted back from. */
  at: Date;
  /**
   * `at` as Discord's own markup — `<t:unix:R>` for a countdown to a closing
   * time, `<t:unix:F>` for a start. **Never a formatted date**: see the module
   * comment.
   */
  stamp: string;
};

/**
 * Signups closing, which carries one extra fact: whether the event is full.
 *
 * A full event still gets this announcement (UC-38 4c) — a waitlist place is
 * still worth having, and somebody who hears "closes tomorrow" and finds a
 * queue has lost nothing. But the message has to *say* it is full, or the
 * announcement is an invitation to apply for a seat that is not there.
 */
export type DueClosingSoon = DueAnnouncement & {
  full: boolean;
  /**
   * The seat cap, or null when uncapped — what `{places}` renders.
   *
   * Carried beside `full` rather than derived from it, because they answer
   * different questions: a full event with twelve seats and a full uncapped
   * event are different sentences, and "No limit" is a thing the message says.
   */
  capacity: number | null;
};

/**
 * Applications opening, which carries the facts `signupsOpenMessage` was built
 * to take (R-205 / UC-38 2).
 *
 * The one entry whose instants are **not** pre-rendered, and the reason is that
 * its builder predates this module: `signupsOpenMessage` takes the start and
 * the closing time as `Date`s and stamps them itself, exactly as
 * `eventPublishedMessage` does, because it is the same four facts said at the
 * other moment. Handing it strings would mean a second copy of its vocabulary.
 * Nothing is *formatted* either way — `./announce`'s `stamp` is still the only
 * thing that turns an instant into text.
 *
 * `at` is the opening instant itself, which is what the window was measured on.
 */
export type DueSignupsOpen = {
  eventId: string;
  title: string;
  slug: string;
  /** The instant applications open. */
  at: Date;
  capacity: number | null;
  /** The derived start — its first dated day's (R-24). Null when it has none. */
  startsAt: Date | null;
  signupClosesAt: Date | null;
};

export type ScheduledAnnouncementsDue = {
  signupsOpen: DueSignupsOpen[];
  closingSoon: DueClosingSoon[];
  startingSoon: DueAnnouncement[];
};

/**
 * Which events are inside which window right now.
 *
 * ## The two statuses, and why they differ
 *
 * **Closing soon is `published` only.** Applications follow the signup window
 * on a published event and nowhere else. A `draft` is invisible to members
 * (R-32) and announcing one would publish it in the loudest possible way; a
 * `cancelled` event has no signups left to close, and "apply before tomorrow"
 * is worse than silence there. `live` and `complete` cannot reach the window
 * anyway — `signupWindowProblem` refuses a closing time after the first day
 * starts, so an event that has begun has a closing time in the past — but the
 * filter says `published` rather than relying on that, because the reason is
 * about what an announcement means and not about an arithmetic coincidence.
 *
 * **Starting soon is `published` or `live`**, matching `eventsStartingSoon` in
 * `./notifications`, which is the same question asked about DMs. `cancelled` is
 * excluded by name (UC-38 4b): a reminder to turn up to a called-off event is
 * the single worst message this feature could send.
 *
 * **Signups opening is `published` only**, and for the stronger of the closing
 * reasons: applications follow the signup window on a published event and
 * nowhere else, so on a `draft` there is no door to open and on a `cancelled`
 * one there never will be.
 *
 * ## Why opening asks {@link publishingOpensSignups} instead of `inWindow`
 *
 * The lower bound of all three windows is the same comparison — is the instant
 * still ahead of us — but for this one that comparison already has a name, a
 * docblock and a test to the millisecond, because it is **also** the rule that
 * decides whether publishing and opening are one moment or two (UC-38 2a). So
 * this asks it rather than re-deriving `delta > 0` beside it: `true` means
 * there is no second moment to announce, either because the window opened
 * before now or because nothing ever held it shut. The upper bound is then the
 * lead, and the window stays **forward-only** — which is what makes 2a free.
 * See {@link SIGNUPS_OPENING_LEAD_MS}; widening it backwards would post a
 * signups-open announcement for every event ever published into an open
 * window.
 *
 * ## Nothing to count back from
 *
 * `signupClosesAt` is nullable and so is `event_days.starts_at`, so an event
 * may genuinely have no instant to count back from. It gets nothing — not a
 * message with a hole in it (UC-38 3a, 4a).
 */
export async function dueScheduledAnnouncements(
  now: Date = new Date(),
  database: Database = defaultDb
): Promise<ScheduledAnnouncementsDue> {
  const rows = await database
    .select({
      id: events.id,
      title: events.title,
      slug: events.slug,
      status: events.status,
      capacity: events.capacity,
      signupOpensAt: events.signupOpensAt,
      signupClosesAt: events.signupClosesAt,
    })
    .from(events);

  const closingCandidates: Array<{
    id: string;
    title: string;
    slug: string;
    capacity: number | null;
    closesAt: Date;
  }> = [];
  for (const row of rows) {
    if (row.status !== "published") continue;
    const closesAt = row.signupClosesAt;
    if (!inWindow(closesAt, now, SIGNUP_CLOSING_LEAD_MS)) continue;
    closingCandidates.push({
      id: row.id,
      title: row.title,
      slug: row.slug,
      capacity: row.capacity,
      closesAt,
    });
  }

  /*
   * Applications opening, decided by the one predicate that already names this
   * rule (see the docblock). `!publishingOpensSignups(row, now)` is the lower
   * bound — the opening is still ahead — and the lead is the upper one.
   */
  const openingCandidates = rows.filter((row) => {
    if (row.status !== "published") return false;
    const opens = row.signupOpensAt;
    if (!opens) return false;
    if (publishingOpensSignups({ signupOpensAt: opens }, now)) return false;
    return opens.getTime() - now.getTime() <= SIGNUPS_OPENING_LEAD_MS;
  });

  const startingCandidates = rows.filter(
    (row) => row.status === "published" || row.status === "live"
  );

  /*
   * One read of the days for every event that could still be starting soon or
   * opening, because the start is only in `event_days` (R-24) and a per-event
   * read would be a query per event on a job that runs every fifteen minutes.
   * The opening announcement carries the start too — it is one of the four
   * facts `signupsOpenMessage` says — so both lists are asked for together
   * rather than in two round trips.
   */
  const dates = await readDatesFor(database, [
    ...new Set([...startingCandidates, ...openingCandidates].map((row) => row.id)),
  ]);

  const signupsOpen: DueSignupsOpen[] = openingCandidates.map((row) => ({
    eventId: row.id,
    title: row.title,
    slug: row.slug,
    // Non-null by construction: `openingCandidates` dropped every row whose
    // `signupOpensAt` is null or already past.
    at: row.signupOpensAt as Date,
    capacity: row.capacity,
    startsAt: dates.get(row.id)?.startsAt ?? null,
    signupClosesAt: row.signupClosesAt,
  }));

  const startingSoon: DueAnnouncement[] = [];
  for (const row of startingCandidates) {
    const startsAt = dates.get(row.id)?.startsAt ?? null;
    if (!inWindow(startsAt, now, EVENT_STARTING_LEAD_MS)) continue;
    startingSoon.push({
      eventId: row.id,
      title: row.title,
      slug: row.slug,
      at: startsAt,
      stamp: stamp(startsAt, "F"),
    });
  }

  /*
   * And one read of the applications for the events that are closing, which is
   * the only thing "full" can be worked out from. Skipped entirely when nothing
   * is closing, which is every run but a handful.
   */
  const seats = await seatsFor(
    database,
    closingCandidates.map((row) => row.id)
  );

  const closingSoon: DueClosingSoon[] = closingCandidates.map((row) => ({
    eventId: row.id,
    title: row.title,
    slug: row.slug,
    at: row.closesAt,
    // A countdown rather than a date, the same style `eventPublishedMessage`
    // already uses for a closing time: "in 23 hours" is what a reader needs.
    stamp: stamp(row.closesAt, "R"),
    full: capacityState({ capacity: row.capacity }, seats.get(row.id) ?? []).full,
    capacity: row.capacity,
  }));

  return { signupsOpen, closingSoon, startingSoon };
}

/**
 * Is `target` ahead of `now` by no more than `lead`?
 *
 * The whole window, in one place, so the two moments cannot drift apart about
 * what "due" means. `null` is never due: an event with no closing time and one
 * with no dated day both land here (UC-38 3a, 4a).
 *
 * `> 0` and not `>= 0`: the instant itself has arrived, and an announcement
 * saying "signups close in no time at all" is a message about something that
 * has already happened.
 */
function inWindow(target: Date | null, now: Date, lead: number): target is Date {
  if (target === null) return false;
  const delta = target.getTime() - now.getTime();
  return delta > 0 && delta <= lead;
}

/** Every application's status, per event, for {@link capacityState}. */
async function seatsFor(
  database: Database,
  eventIds: readonly string[]
): Promise<Map<string, Array<{ status: (typeof applications.$inferSelect)["status"] }>>> {
  const out = new Map<string, Array<{ status: (typeof applications.$inferSelect)["status"] }>>();
  if (eventIds.length === 0) return out;

  const rows = await database
    .select({ eventId: applications.eventId, status: applications.status })
    .from(applications)
    .where(inArray(applications.eventId, [...eventIds]));

  for (const row of rows) {
    const bag = out.get(row.eventId) ?? [];
    bag.push({ status: row.status });
    out.set(row.eventId, bag);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Where the posting lives                                            */
/* ------------------------------------------------------------------ */

/**
 * This module decides **which** events are due and **what the facts are**. It
 * does not post, and it does not word anything.
 *
 * `postDueAnnouncements` in `./discord` is the other half, and the split is the
 * same one every announcement in this repo has: the sentence belongs in
 * `./announce` with every other sentence, the webhook and the audit row belong
 * in `./discord` with every other outbound call, and this file is the clock.
 *
 * Two things that half needs, which is why it is there and not here:
 *
 *  1. **The three kinds** in `ANNOUNCEMENTS` — `signups_open`,
 *     `signups_closing_soon` and `event_starting_soon` — each with a
 *     placeholder table and a builder. Without a registered kind, `deliver`
 *     reads an undefined switch, treats it as off, and posts nothing, so the
 *     feature would be dead code that looked wired up.
 *  2. **The claim**, `announcement_claims`, keyed `(kind, event_id)` — what
 *     makes a second run inside one window post nothing (UC-38 5a). A window a
 *     day wide is one the quarter-hour schedule wakes inside ninety-odd times,
 *     so this is not an optimisation. `notification_dm_claims` could not hold
 *     it: a channel announcement has no recipient, and that table's key is a
 *     NOT NULL `user_id` (drizzle/0030 has the argument in full).
 */
