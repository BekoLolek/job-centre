-- One waiting host application per member (R-83 / UC-20 3b).
--
-- The rule was only ever enforced by the read `applyToHost` does before it
-- inserts, so the table may already hold two pending rows for one member —
-- from two submits in the same second, or from any row written before that
-- read existed. A unique index does not skip those rows: `CREATE UNIQUE INDEX`
-- fails outright, the migration fails with it, and every later migration is
-- stuck behind a deploy that needs somebody to edit production by hand. So the
-- duplicates are dealt with here, in the same transaction that tightens the
-- rule, rather than assumed not to exist.
--
-- What happens to them: the member's newest pending application stays pending,
-- and the older ones become `withdrawn`.
--
--  * Not deleted. The application is what an approval points back at, and a
--    row that was in the queue is part of the record of what was asked for.
--  * Not `declined`. A decline is an admin's decision — it carries who made it
--    and notifies the applicant (UC-21 3a). Nobody decided these, and writing
--    a decision nobody made into the log is worse than the duplicate was.
--  * `withdrawn` is the state that already means "no longer waiting, and not
--    because anybody judged it". It is the one the member can reach themselves
--    (UC-20 4a), it frees them to send another, and their own page already
--    renders it greyed out with the note below.
--
-- The newest is the one kept because it is the one they most recently meant;
-- the older rows are the drafts it replaced. `id` breaks a tie on `created_at`
-- so the statement picks the same row every time it is run.
UPDATE "host_applications" SET
  "status" = 'withdrawn',
  "decision_note" = 'Withdrawn automatically: only one application can wait at a time, and you had sent a newer one. Send it again whenever you like.',
  "updated_at" = now()
WHERE "status" = 'pending'
  AND "id" NOT IN (
    SELECT DISTINCT ON ("user_id") "id"
    FROM "host_applications"
    WHERE "status" = 'pending'
    ORDER BY "user_id", "created_at" DESC, "id" DESC
  );--> statement-breakpoint
CREATE UNIQUE INDEX "host_applications_one_pending_per_user" ON "host_applications" USING btree ("user_id") WHERE status = 'pending';
