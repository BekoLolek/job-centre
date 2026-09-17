# Decision 003: How reminders are triggered on a clock

**Date:** 2026-09-15
**Status:** Accepted for the fix (commit `fd0c3bf`); confirm at Gate 2

## Context

R-97 and R-106: seat holders are reminded the day before, with nobody on the site. The
original build scheduled Vercel Cron hourly. Vercel Hobby accepts only cron jobs that run at
most once a day, with per-hour precision, and **fails the whole deployment** otherwise
(vercel.com/docs/cron-jobs/usage-and-pricing). The two most recent pushes failed this way and
production stayed on `82ceae0` for eighteen days.

## Options

| | A: Daily Vercel Cron, wide window | B: Upgrade to Vercel Pro | C: External scheduler (GitHub Actions cron) |
|---|---|---|---|
| **What it is** | `0 12 * * *`, reminding everything starting in the next 36 h, deduped | Keep hourly | A workflow calls the route hourly with the secret |
| **Pros** | - Free, already wired<br>- Idempotent send makes the overlap harmless | - Precise timing | - Free, any frequency |
| **Cons** | - Reminders arrive 12-36 h before, not exactly 24 h | - Paid, for one job | - Secret in a second system<br>- GitHub cron is itself best-effort and pauses on inactive repos |
| **Effort to build** | Done | None | Low |
| **Cost** | Free | Pro plan | Free |
| **Lock-in** | None | None | None |
| **Already known / in repo** | Yes | - | No |

## Recommendation

**A**, because "the day before" does not need hourly precision, and it is the only option that
is free and adds nothing.

## Decision

Implemented as a Tier 1 fix to unblock deploys; awaiting confirmation at Gate 2.

## Consequences

- `schedule.test.ts` fails any future cron that runs more than once a day, before a push.
- `REMINDER_WINDOW_MS` must stay wider than the longest gap between daily runs (24h59m).
- `CRON_SECRET` must be set on Vercel, or the route refuses every call and no reminders are sent.
