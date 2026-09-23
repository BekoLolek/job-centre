-- Polls written while the closing time was optional have none, and
-- `set not null` refuses to run at all if one of them is still there — it does
-- not skip the row, it fails the deploy. So they are given one first.
--
-- A week from whenever this runs, rather than `now()`. Both satisfy the
-- constraint; only one of them is honest about what these rows are. They are
-- open questions that members can still vote in, and `now()` would close every
-- one of them at the instant a deploy landed, with no notice to anybody who had
-- not voted yet and no record that a deploy is what ended it. A week leaves
-- them open, gives an admin time to set a real time, and closing one sooner is
-- a single click (UC-23 5).
UPDATE "polls" SET "closes_at" = now() + interval '7 days' WHERE "closes_at" is null;--> statement-breakpoint
ALTER TABLE "polls" ALTER COLUMN "closes_at" SET NOT NULL;
