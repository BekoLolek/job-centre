import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The deploy is refused, not the job, when a schedule is wrong.
 *
 * Vercel Hobby only accepts cron jobs that run at most once a day; anything
 * more frequent fails the whole deployment with "Hobby accounts are limited to
 * daily cron jobs". That failure is invisible from the app — production simply
 * stops updating — which is how an hourly reminder schedule held every deploy
 * back for eighteen days. So it is pinned here, where it fails before a push.
 */

type Cron = { path: string; schedule: string };

const config = JSON.parse(
  readFileSync(join(process.cwd(), "vercel.json"), "utf8")
) as { crons?: Cron[] };

describe("vercel.json crons", () => {
  it("has the reminders job", () => {
    expect(config.crons?.map((cron) => cron.path)).toContain("/api/cron/reminders");
  });

  it.each(config.crons ?? [])("$path runs at most once a day ($schedule)", ({ schedule }) => {
    const fields = schedule.trim().split(/\s+/);
    expect(fields).toHaveLength(5);
    const [minute, hour] = fields;
    // A single fixed minute and hour is once a day at most. Anything else —
    // `*`, a step, a list or a range — runs more often.
    expect(minute).toMatch(/^\d{1,2}$/);
    expect(hour).toMatch(/^\d{1,2}$/);
  });
});
