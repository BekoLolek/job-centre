# Decision 005: No connection pool limit, because production is behind PgBouncer

**Date:** 2026-10-23
**Status:** Accepted (Task 66)

## Context

The Scale constraint in `docs/requirements.md` is "the whole room during a live draft" — the one
moment this app deliberately invites concurrency, and the one where a refused connection is
least recoverable: a captain whose bid fails on a pool error does not get another chance at
that lot.

`src/db/index.ts` builds the handle as `new Pool({ connectionString: url })` with **no `max`**,
no `idleTimeoutMillis` and no `connectionTimeoutMillis`. `@neondatabase/serverless`'s `Pool`
follows node-postgres and defaults to **10** connections, and on Vercel **each serverless
instance holds its own pool**, so the ceiling is 10 × however many instances Vercel runs.

Whether that is a problem depends entirely on **which endpoint `DATABASE_URL` names**. Neon
offers a direct endpoint and a PgBouncer-backed pooled one, distinguished by `-pooler` in the
host. That value cannot be read from this repo: `DATABASE_URL` is blank locally by design, and
the Constraints forbid it reaching any screen.

**The operator confirmed on 2026-10-23 that production's `DATABASE_URL` host contains
`-pooler`.** Production therefore connects through PgBouncer.

## Options

| | A: Leave the pool unbounded | B: Set a `max` anyway | C: `max: 1` |
|---|---|---|---|
| **What it is** | No `max`; PgBouncer absorbs the fan-out | A `max` sized to Neon's limit ÷ expected instances | One connection per instance |
| **Pros** | - Nothing to size wrongly<br>- Cold starts stay cheap | - Explicit ceiling in the code | - Trivially bounded |
| **Cons** | - Reader has to know the endpoint is pooled | - A number that is right for one plan and one traffic shape, with nothing to recompute it from<br>- Duplicates a limit PgBouncer already enforces | - **Serialises every request in that instance behind whichever transaction is open**, including the lock-ordered writes of Tasks 36 and 56 |
| **Effort** | None (plus this record) | Low | None |
| **Lock-in** | None | None | None |

## Decision

**A.** With PgBouncer in front, the client-side `max` governs how many connections one instance
opens to *the pooler*, which is cheap and multiplexed; the real limit is PgBouncer's and is set
on Neon's side. A second ceiling in application code would be a number nobody can recompute
when the plan or the traffic changes, and the failure it would cause — a request waiting on a
pool slot while PgBouncer has capacity to spare — is invisible in logs.

**`max: 1` is specifically rejected.** This app uses interactive transactions throughout
(`src/lib/draft.ts`, `events.ts`, `format.ts`, `championship-results.ts`, and five more), and a
pool of one serialises every request in that instance behind whichever transaction is open. A
pool smaller than the concurrent transactions in one instance **deadlocks rather than
queueing**: the open transaction waits for a second connection that the pool will only hand out
when the first is returned.

**No `connectionTimeoutMillis`, deliberately.** Neon's compute suspends when idle on the free
tier, so the first connection after a quiet spell pays a cold start of a few seconds. A short
connection timeout would turn that cold start into a failed request for whoever happens to
arrive first — the opposite of what is wanted. A reader waiting two seconds is a slow page; a
reader getting an error is a broken one.

## What makes transaction pooling safe here, and what would stop being safe

PgBouncer in transaction mode hands a different backend connection to each transaction, so
anything scoped to a **session** rather than a transaction breaks. This app uses none of it, and
the absence is what the decision rests on:

- **Locks are `select … for update`**, taken on a row inside the transaction that needs it —
  written as drizzle's `.for("update")`, in `admin-allowlist.ts`, `championship-results.ts`,
  `draft.ts`, `events.ts` and `format.ts`. Row locks are held by the transaction, so they survive
  transaction pooling unchanged. Session-scoped `pg_advisory_lock` would not: the unlock could
  land on a different backend from the lock, and the lock would never be released.
  (Worth knowing: the words "for update" appear in this repo **only in comments**. The first
  version of the test below looked for the phrase and found nothing once comments were stripped,
  which is the same trap as a sweep satisfied by its own prose, pointed the other way.)
- **No `LISTEN`/`NOTIFY`**, no `WITH HOLD` cursors, no `SET` outside a transaction, no temporary
  tables, no session-level advisory locks.
- **No named prepared statements** — nothing calls drizzle's `.prepare()`.

`src/db/__tests__/pooling.test.ts` sweeps for each of those, so introducing one fails there
rather than in production during a draft. If a future change genuinely needs one, the endpoint
has to move to the direct host **and** this record has to be revisited — at which point the
`max` and `idleTimeout` arithmetic that option B describes becomes the work, and `max: 1` is
still wrong for the reason above.

## Consequences

- `src/db/index.ts` is unchanged. The reasoning lives in its docblock beside the `Pool`
  construction, pointing here, because that line is where the next person will ask the question.
- Switching `DATABASE_URL` to the direct endpoint silently removes the thing this decision rests
  on. Nothing in code can detect that — the connection string never reaches a test — so it is
  written here and in `src/db/index.ts` as the condition it is.
- The cold-start cost after autosuspend is accepted as a slow first request rather than
  engineered around.
