import { NextResponse } from "next/server";
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
 * So it needs a scheduler. Vercel Cron calls this route on the schedule in
 * `vercel.json`. Without that, or on any other host, nothing here runs and the
 * reminders quietly never arrive — which is worth knowing, because it is the
 * one notification kind that cannot degrade into "you'll see it next time you
 * open the site".
 *
 * ## Safe to call as often as you like
 *
 * `sendDueReminders` is idempotent: the notification's dedupe key is the event
 * id, so an event is reminded about once however many times this runs, across
 * redeploys and retries. That is what lets a daily run use a look-ahead wider
 * than a day (`REMINDER_WINDOW_MS`) rather than something clever that has to
 * fire exactly once.
 *
 * ## Once a day, and no more
 *
 * Vercel Hobby refuses to *deploy* a project whose cron runs more than once a
 * day — the whole deployment fails, not just the job. An hourly schedule here
 * held production back for eighteen days before anyone noticed, so
 * `src/app/api/cron/__tests__/schedule.test.ts` now fails first.
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
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    console.error("[cron/reminders] failed", error);
    return NextResponse.json({ ok: false, error: "Reminders failed." }, { status: 500 });
  }
}
