-- `events.starts_at` and `events.ends_at` go, and `events_status_starts_at_idx`
-- with them (R-24 / UC-11 2, docs/plan.md Task 50).
--
-- An event's dates are its days': `eventDates` in src/lib/events-policy.ts
-- takes the first dated day's start and the last one's, and since Task 12
-- nothing in src/ reads or writes either column. drizzle/0020 moved every
-- event's date into `event_days` so that this commit could be written.
--
-- The index goes because it is `(status, starts_at)` and the second column no
-- longer exists. It is **not** replaced by an index on `status` alone: the one
-- selective status read is `listEvents({ status: "live" })` on the front page,
-- every other caller asks for most of the table and sorts in TypeScript, and
-- Task 50 asks for a replacement to be measured rather than inherited — which
-- nothing here can do, because `DATABASE_URL` is blank in this working copy by
-- design. src/db/schema.ts records the query to `EXPLAIN` when the table is
-- large enough for the answer to differ.
--
-- ## Why there is a count above the drops, and why it does not refuse
--
-- A dropped column is a one-way door, and these two are the only copy of
-- anything they still hold that `event_days` does not. drizzle/0020 was
-- deliberate about what it left behind, and each of those shapes is answered
-- here:
--
--  * **An event whose start is in the column and nowhere else.** 0020's two
--    statements between them give a day to every event that had a start and no
--    dated day. That is true of the rows as 0020 *left* them and not of the
--    rows this file *finds*, because the day list is editable in between: there
--    is a third cause beside "something wrote the column after 0020" and "0020
--    did not do what it says", and it is an ordinary manager using the Days
--    tab. `setEventDays` writes `startsAt: day.startsAt ?? null`
--    (src/lib/events.ts), and `dayListProblem` beside it asks for neither a
--    time nor a minimum number of days — an undated day list is the documented
--    "times to be agreed" state (UC-08 E3; `event_days.starts_at` is nullable
--    for exactly that, and 0020 says so itself). So a legacy event whose
--    manager clears its day times, or deletes its days, between the two deploys
--    is back in this shape by a supported route.
--
--    This used to `RAISE EXCEPTION`. That made one manager's supported edit
--    halt the deploy, and every migration queued behind it, until somebody
--    edited production by hand. It is a `RAISE NOTICE` now, for two reasons.
--
--    **Nothing on screen changes either way.** Nothing in src/ has read either
--    column since Task 12, and `eventDates` already answers `null` for an event
--    with no dated day — so that event reads as undated before the drop and
--    after it (R-24 / UC-11 2). The refusal was protecting a fact the site had
--    already stopped telling anybody.
--
--    **And the instant is not lost.** The audit insert below covers this shape
--    too (see its `WHERE`), so the column's value is written against its event
--    whether the deploy stops or not — which is the whole of what the refusal
--    was for. The two cannot drift apart, because they are the same condition
--    read twice.
--
--    The HINT it carried was worse than the stop. "Give them a dated
--    `event_days` row and deploy again" **re-dates an event whose manager
--    deliberately un-dated it**: it gets a card date back, a place in "what is
--    coming up", a countdown and a deadline on the "still coming?" answer
--    (UC-13 7a) — an operator following a migration's advice and undoing a
--    decision somebody took on purpose. The non-destructive remedy was never
--    mentioned: if the column is the answer the manager wants, the days are
--    typed in on the Days tab where they belong; if it is not, `events.starts_at`
--    was simply stale and `NULL` was always the honest value for it. Neither is
--    a deploy's business, so the notice names the rows and says where their
--    instants have been written, and lets the deploy finish.
--
--  * **A `starts_at` that disagrees with the first dated day.** 0020 left a
--    partially dated event alone on purpose ("A partially dated event is left
--    exactly as it is"): its Day 2 has a time, so it already reads as an event
--    that runs on Day 2's evening, and writing the old start onto its undated
--    Day 1 would move the event to a date its manager never typed. That event
--    keeps the date it reads from its days, so nothing on the site changes —
--    but the instant in the column is still the last trace of what Basics used
--    to say.
--
--  * **An `ends_at` that is not any day's start.** 0020 never backfilled
--    `ends_at` at all, because the instant an event *finished* is not the
--    instant its last day *began*, and a second day starting at `ends_at`
--    would print a time nobody chose.
--
-- None of the three stops the deploy, and none of them needs to: nothing has
-- read either column since Task 12, so no screen changes when they go. What
-- they must not do is vanish without trace, because 0020 said "that is the
-- commit that should look at the live rows and decide whether any of them wants
-- real days typed in" and nobody can look at a column that has been dropped. So
-- every instant the day rows do not already hold is written to `audit_log`
-- first, against the event it belongs to — which is where an admin filtering the
-- log by that event will look (R-110 / UC-27 3) — and the drop then takes
-- nothing that is not written down. That is also what makes a **hand-applied**
-- drop safe, which drizzle/0025's docblock treats as a real scenario: the audit
-- row is written by the same file, in the same transaction, before the column
-- goes.
--
-- The action is not in `AUDIT_ACTIONS` and does not need to be: `actionLabel`
-- falls back to the raw string, and something a migration did once is not a
-- verb the site has a button for. Same reasoning as drizzle/0025, which is also
-- where the `AT TIME ZONE 'UTC'` spelling comes from — `::text` renders a
-- timestamptz in whatever the session's TimeZone happens to be, so the same row
-- would be logged differently depending on which machine ran the deploy.
--
-- ## Re-running it changes nothing
--
-- The block returns immediately once `starts_at` is gone, so the guard and the
-- audit insert run exactly once however many times this file is replayed;
-- plpgsql plans a statement when it first executes it, not when the block is
-- entered, so the statements below that name the dropped column are never
-- planned on a second pass. The drops are `IF EXISTS` for the same reason.
-- drizzle never re-applies a recorded migration, but a replay is how this file
-- is tested, and a migration that cannot survive one is a migration nobody can
-- prove.
--
-- One note on the `DROP INDEX`: it is **not load-bearing**. Postgres drops an
-- index with the last column it covers, so the `ALTER TABLE` below would take
-- `events_status_starts_at_idx` on its own, and no test can tell the two apart
-- — removing the statement leaves the suite green. It is kept because it is
-- what `drizzle-kit generate` emitted and because it says the intent out loud:
-- the index is going because nothing reads the column, not merely as a side
-- effect. What *is* tested is that nothing replaces it (see
-- `migrations.test.ts`, "leaves no index on the dropped date column").
DO $$
DECLARE
  orphans bigint;
  sample text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'events'
      AND column_name = 'starts_at'
  ) THEN
    RETURN;
  END IF;

  -- The query that finds an event whose date lives *only* in the column: a
  -- start on the row, and not one day with a time on it.
  SELECT count(*), string_agg(e.slug, ', ' ORDER BY e.slug)
    INTO orphans, sample
  FROM events AS e
  WHERE e.starts_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM event_days AS d
      WHERE d.event_id = e.id AND d.starts_at IS NOT NULL
    );

  IF orphans > 0 THEN
    RAISE NOTICE
      'events.starts_at held a start no dated event_days row holds, for % event(s): %. Each one already read as undated on the site, and each start is in audit_log against its event under action event.dates_column_dropped. If one of them wants that date back, type the days in on the Days tab; if the column was simply stale, there is nothing to do.',
      orphans, sample;
  END IF;

  -- Everything else the drop would discard, kept against its event.
  INSERT INTO audit_log ("actor_user_id", "actor_name", "action", "event_id", "subject", "summary", "detail")
  SELECT
    NULL,
    'Migration drizzle/0026',
    'event.dates_column_dropped',
    e.id,
    e.slug,
    'The event start and end columns were dropped; an event''s dates are its days'' (R-24). This event held an instant the day rows do not, so it is recorded here rather than lost.',
    jsonb_build_object(
      'columnStartsAt',
        to_char(e.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'columnEndsAt',
        to_char(e.ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      -- What the site reads instead, so the two can be compared by eye.
      'firstDatedDay',
        to_char(
          (SELECT min(d.starts_at) FROM event_days AS d
           WHERE d.event_id = e.id AND d.starts_at IS NOT NULL) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        ),
      'lastDatedDay',
        to_char(
          (SELECT max(d.starts_at) FROM event_days AS d
           WHERE d.event_id = e.id AND d.starts_at IS NOT NULL) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        )
    )
  FROM events AS e
  WHERE
    -- A start the first dated day does not already say.
    (
      e.starts_at IS NOT NULL
      AND e.starts_at <> (
        SELECT min(d.starts_at) FROM event_days AS d
        WHERE d.event_id = e.id AND d.starts_at IS NOT NULL
      )
    )
    -- Or a start **no** day says, which the comparison above cannot express:
    -- with no dated day the subquery is NULL, `<>` is NULL, and the row is not
    -- selected. This is the shape the notice above counts — the one the
    -- exception used to stop the deploy over — and it is the shape where the
    -- column is the *only* copy, so it is the one that most needs writing down.
    OR (
      e.starts_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM event_days AS d
        WHERE d.event_id = e.id AND d.starts_at IS NOT NULL
      )
    )
    -- Or an end that is not any of its days' starts. 0020 never backfilled one.
    OR (
      e.ends_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM event_days AS d
        WHERE d.event_id = e.id AND d.starts_at = e.ends_at
      )
    );
END
$$;--> statement-breakpoint
DROP INDEX IF EXISTS "events_status_starts_at_idx";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN IF EXISTS "starts_at";--> statement-breakpoint
ALTER TABLE "events" DROP COLUMN IF EXISTS "ends_at";
