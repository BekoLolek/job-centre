-- R-199: a third "still coming?" answer, so an uncertain seat can be said to be
-- uncertain instead of being left silent. R-200/UC-25 10: a second reminder kind
-- that asks for that answer before it closes, which cannot share
-- `event_reminder` because the dedupe key is the kind and the subject and the
-- two would swallow each other for the same event.
--
-- Both appended rather than placed with a `BEFORE`: nothing orders either enum.
-- The order members are offered the three answers in is `CONFIRMATION_CHOICES`
-- in src/components/events/labels.ts, and the order the preferences screen
-- lists kinds in is `NOTIFICATION_KINDS` in src/lib/notify-policy.ts — the same
-- reasoning as 0016_standings_changed.sql.
--
-- Nothing is backfilled with 'maybe' here, and nothing may be: drizzle applies
-- every pending migration inside one transaction, and Postgres refuses to *use*
-- an enum value added in the transaction that added it. A backfill written
-- below would fail the whole deploy, not just itself. There is nothing to
-- backfill anyway — 'maybe' is a thing members say, and no existing row means it.
ALTER TYPE "public"."confirmation_state" ADD VALUE 'maybe';--> statement-breakpoint
ALTER TYPE "public"."notification_kind" ADD VALUE 'confirmation_due';
