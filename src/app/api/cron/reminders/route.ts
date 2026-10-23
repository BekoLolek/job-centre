import { NextResponse } from "next/server";
import { postDueAnnouncements } from "@/lib/discord";
import { sendDueReminders } from "@/lib/notifications";

/**
 * "Starts tomorrow", sent on a clock.
 *
 * ## Why this exists at all
 *
 * Every other notification is *reactive* — somebody published an event, somebody
 * changed the questions — so the code that does the thing can also do the
 * telling. A reminder is not like that. Nothing happens at the moment an event
 * becomes "tomorrow"; the clock simply moves, and if nobody is running, nobody
 * is told.
 *
 * So it needs a scheduler. Two of them call this one route:
 *
 *  - **GitHub Actions**, every quarter hour (`.github/workflows/cron.yml`).
 *    This is the one that does the work, and it exists because a two-hour
 *    reminder (R-207) cannot come out of a once-a-day run at all. It needs
 *    `CRON_SECRET` as a repository secret and `CRON_URL` as a variable, and it
 *    fails loudly rather than silently until both are set.
 *  - **Vercel Cron**, once a day, on the schedule in `vercel.json`. Kept as a
 *    backstop: it is the one scheduler that cannot be switched off by somebody
 *    disabling Actions on the repository, and a day-before reminder still lands
 *    correctly from it. See "Once a day, and no more" below for why it is not
 *    simply set to a quarter hour.
 *
 * Without either, nothing here runs and the reminders quietly never arrive —
 * which is worth knowing, because it is the one notification kind that cannot
 * degrade into "you'll see it next time you open the site".
 *
 * ## Safe to call as often as you like
 *
 * `sendDueReminders` is idempotent: the notification's dedupe key is the event
 * id, so an event is reminded about once however many times this runs, across
 * redeploys and retries. That is what lets a daily run use a look-ahead wider
 * than a day (`REMINDER_WINDOW_MS`) rather than something clever that has to
 * fire exactly once.
 *
 * `postDueAnnouncements` is idempotent the same way and for the same reason,
 * through a row in `announcement_claims` per kind per event rather than a
 * dedupe key (UC-38 5a) — a channel announcement has no recipient, so it
 * cannot use the DM claim table. Its windows are wider still: a day for
 * signups closing, two hours for an event starting.
 *
 * ## It does two things, not one
 *
 * The DMs (R-99 / UC-25) and the three **channel announcements** the clock owns
 * (R-205, R-206, R-207 / UC-38 2, 3, 4) are the same wake, because they are the
 * same question — what has the clock made true since the last run. Both are
 * awaited and both are reported in the body.
 *
 * ## Once a day in `vercel.json`, and no more
 *
 * Vercel Hobby refuses to *deploy* a project whose cron runs more than once a
 * day — the whole deployment fails, not just the job. An hourly schedule here
 * held production back for eighteen days before anyone noticed, so
 * `src/app/api/cron/__tests__/schedule.test.ts` now fails first.
 *
 * That limit is on the *Vercel* schedule, not on this route, which is why the
 * quarter-hour pinger is a GitHub workflow. The same test file pins both: the
 * Vercel entry stays daily, and the workflow stays frequent.
 *
 * ## The secret
 *
 * Vercel signs its cron requests with `CRON_SECRET` in the `Authorization`
 * header when that variable is set. Without one, this route refuses everything
 * rather than defaulting to open — a public endpoint that sends everybody a
 * direct message is not a thing to leave lying around, and failing closed
 * costs a variable rather than an incident.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not set, so this endpoint is closed." },
      { status: 503 }
    );
  }

  const offered = request.headers.get("authorization");
  if (offered !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const result = await sendDueReminders();
    /*
     * The channel half of the same wake (R-205, R-206, R-207 / UC-38 2, 3, 4).
     *
     * After the DMs rather than beside them, and awaited rather than deferred:
     * the two are independent, and a run that reported `{"ok":true}` while
     * silently failing to post is the failure this endpoint's body exists to
     * make visible. `announcements` is a count of what actually went out, which
     * is what tells a working schedule from one that found nothing — the same
     * argument as the counts beside it.
     *
     * Safe to call as often as the schedulers like, for a reason of its own:
     * `sendDueReminders` is idempotent through its dedupe key, and this is
     * idempotent through `announcement_claims`, so a retried or double-pinged
     * run posts nothing twice.
     */
    const announcements = await postDueAnnouncements();
    return NextResponse.json({
      ok: true,
      ...result,
      announcements: announcements.posted.length,
    });
  } catch (error) {
    console.error("[cron/reminders] failed", error);
    return NextResponse.json({ ok: false, error: "Reminders failed." }, { status: 500 });
  }
}
