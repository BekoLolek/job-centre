-- An event's dates are its days' (R-24): it starts when its first day starts
-- and ends when its last one does. Nothing reads `events.starts_at` or
-- `events.ends_at` any more — `eventDates` in src/lib/events-policy.ts derives
-- both from `event_days`, and every read in src/lib/events.ts goes through it.
--
-- Which leaves the rows written while the event row *was* the calendar. An
-- event with a start time but no day that has a time on it would, from this
-- commit on, read as an event nobody has scheduled: no date on its card, no
-- countdown, no place in "what is coming up", no reminder the day before, and
-- no deadline on the "still coming?" answer. So each of them is given the day
-- it always had — by the insert below when it has no days at all, and by the
-- update after it when the days it has are all undated.
--
-- `WHERE NOT EXISTS` rather than a count or a left join: an event that already
-- has a *dated* day has already said when it runs, and that row is the answer.
-- The statement is therefore safe to run twice — the second run matches
-- nothing, which is what `npm run db:migrate` needs of every deploy.
--
-- Two statements rather than one, because "has day rows" and "has a day row
-- with a time on it" are different questions and an event can be in between
-- them; the second statement below is for exactly that event.
--
-- `day_index` 0 because that is the first day, and `event_days_event_index_uniq`
-- is per event, so one insert per event cannot collide with itself. No label:
-- the day is named "Day 1" wherever it is shown (UC-08 E3), and a label nobody
-- typed is a label a manager then has to delete.
--
-- ## What this does not do
--
-- **A partially dated event is left exactly as it is.** An event whose Day 2
-- has a time and whose Day 1 does not already reads as an event that runs on
-- Day 2's evening — `eventDates` takes the earliest *dated* day — so it has a
-- place in "what is coming up", a countdown and an answer deadline. Writing
-- the old `starts_at` onto its undated Day 1 would move the event to a date
-- its manager did not type into the day list, and could put that day after a
-- later one that is already dated, which `daySequenceProblem` refuses on the
-- next save. The commit that drops the columns is where a human can compare
-- the two for the handful of rows this applies to.
--
-- **An event with no start time gets no day.** There is nothing to backfill
-- *from*: it had no dates before this migration and it has none after it, which
-- is a supported state (`event_days.starts_at` is nullable precisely so "Fri /
-- Sat / Sun, times to be agreed" can be sketched, and UC-13 7a has an event
-- with no start having no answer deadline). Writing it an empty day would
-- invent a "Day 1" for an event that has none, change what the format engine
-- builds a running order over, and still leave it dateless.
--
-- **An `ends_at` that disagrees is left alone.** A handful of older events were
-- set up as one start plus one end rather than as days; after this they read as
-- a single-day event starting when they started. The alternative — a second day
-- starting at `ends_at` — would be a worse answer, because the instant an event
-- *finished* is not the instant its last day *began*, and it would print that
-- wrong time on the page as "Day 2". Both columns are still there, holding
-- exactly what they held, until the follow-up commit drops them; that is the
-- commit that should look at the live rows and decide whether any of them wants
-- real days typed in.
INSERT INTO "event_days" ("event_id", "day_index", "starts_at")
SELECT "events"."id", 0, "events"."starts_at"
FROM "events"
WHERE "events"."starts_at" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "event_days" WHERE "event_days"."event_id" = "events"."id"
  );--> statement-breakpoint
-- The second shape, and the one the insert above cannot reach: **an event with
-- a start time and days that are all undated.**
--
-- `event_days.starts_at` is nullable on purpose — it is how a manager sketches
-- "Fri / Sat / Sun" before the times are agreed — so a pre-Task-12 event could
-- have its start typed on Basics *and* a day list with no times on it. The
-- insert's `NOT EXISTS` asks whether the event has any day row, so it skips
-- that event; and because none of those rows is dated, `eventDates` then
-- answers `null` and the event reads as one nobody has scheduled: no place in
-- "what is coming up", no countdown, no reminder the day before, no deadline on
-- the "still coming?" answer, and `confirmationsOpen` true for ever on an event
-- that has not happened yet. This is the last commit that can recover that
-- date, because the follow-up drops the column it is recovered from.
--
-- So: the day the start belongs to is given the start. Which day that is:
--
--  * **The lowest `day_index`.** An event starts when its first day starts
--    (R-24), so the instant that used to be the event's start is the instant
--    its first day began. Dating a later day instead would move the event.
--  * **Only when no day of that event is dated.** The `NOT EXISTS` is the same
--    "those rows are already the answer" rule as the insert's, asked about
--    *dated* rows — see "A partially dated event is left exactly as it is"
--    above. It is also what keeps this idempotent: after the first run the day
--    it wrote is dated, so the second run matches nothing. A deploy re-runs
--    every applied migration, and this one has to be a no-op when it does.
--  * **One day, not all of them.** The other sketched days have no times
--    because nobody has agreed them; inventing one per day would print times on
--    the page that no manager chose, and two days sharing an instant is a list
--    `daySequenceProblem` refuses on the next save.
UPDATE "event_days" AS "d" SET "starts_at" = "e"."starts_at"
FROM "events" AS "e"
WHERE "d"."event_id" = "e"."id"
  AND "e"."starts_at" IS NOT NULL
  AND "d"."day_index" = (
    SELECT min("day_index") FROM "event_days" WHERE "event_days"."event_id" = "e"."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "event_days" AS "x"
    WHERE "x"."event_id" = "e"."id" AND "x"."starts_at" IS NOT NULL
  );
