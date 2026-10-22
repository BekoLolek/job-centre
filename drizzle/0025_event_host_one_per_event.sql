-- One host per event, in the database (R-86 / UC-21 5a).
--
-- `approveHostApplication` re-reads `event_hosts` inside its transaction and
-- refuses an event somebody else already holds. That answers the second admin
-- who clicks a minute later; it cannot answer two admins clicking in the same
-- instant, because it is still a read-then-insert — both reads find the event
-- unheld, both inserts land, and the applicant who was handed the event has
-- silently acquired a co-host with full rights over their evening. This index
-- is the half of the rule a read cannot enforce, and `src/lib/hosting.ts`
-- turns its rejection back into the same sentence the read produces, so the
-- two approvals differ in timing and in nothing else.
--
-- ## Why there is anything above the CREATE
--
-- `CREATE UNIQUE INDEX` does not skip the rows that offend it. If one event in
-- production holds two host rows today the statement fails, the migration
-- fails with it, and every later migration is stuck behind a deploy that needs
-- somebody to edit production by hand. `DATABASE_URL` is blank in this working
-- copy by design, so nobody can look first — which means the duplicates are
-- dealt with here, in the same transaction that tightens the rule, exactly as
-- drizzle/0018 had to withdraw duplicate pending applications and drizzle/0015
-- had to give the undated polls a closing time.
--
-- Two host rows for one event can exist: before the re-read landed there was
-- nothing but the admin's dropdown stopping it, and the race above survives
-- that re-read.
--
-- ## Which row survives: the EARLIER grant
--
-- `granted_at` ascending, `user_id` breaking a tie so the statement picks the
-- same row every time it is run.
--
-- The opposite of drizzle/0018, and for a reason. There the newest pending
-- application was kept because an application is an *intention* and the newest
-- is the one the member most recently meant. A host grant is not an intention,
-- it is a permission somebody has been using: the earlier holder is the one
-- who has had the event since it was handed over, and may well have published
-- it, written its questions, picked its teams and built its bracket. Keeping
-- the later row would take the event away from whoever has been running it and
-- give it to somebody who was never meant to have it — `linkableEvents` stops
-- offering an event the moment it has a host, so the second grant was never
-- something an admin was offered.
--
-- ## The losing member is told, and the admins are told
--
-- Being made a host is something the applicant was notified about (UC-21 4) and
-- something their own page at `/host` shows. Deleting the row with no word to
-- anybody would take that away in silence, so two rows are written first:
--
--  * a notification to them — the same `host_decision` kind their approval
--    used, so it cannot be muted (it is `fixed` in `notify-policy.ts`) — saying
--    what happened, that it was not their fault, and what to ask for. Its
--    dedupe key is derived from the event and the member, so a re-run writes
--    nothing new.
--  * an audit line against the event, which is where an admin filtering the
--    log by that event will look (R-110 / UC-27 3). Its action is not in
--    `AUDIT_ACTIONS` and does not need to be: `actionLabel` falls back to the
--    raw string, and something a migration did once is not a verb the site has
--    a button for.
--
-- What is deliberately *not* touched is their `host_applications` row. It was
-- approved, an admin approved it, and that is a true record of what happened;
-- rewriting its status to `declined` would log a decision nobody made (0018's
-- reasoning), and rewriting it to `pending` would be refused outright by
-- `host_applications_one_pending_per_user` for anybody who has since sent
-- another. The remedy is an event of their own, which needs an admin — which
-- is what the notification asks for and what the audit line tells the admins.
--
-- ## Re-running it changes nothing
--
-- The delete makes both inserts find no rows on a second pass, the
-- notification insert has `ON CONFLICT DO NOTHING` besides, and the index is
-- created `IF NOT EXISTS`.
--
-- The guards are there for a file applied **by hand**, which is the only way it
-- can ever be half applied. A failed *deploy* cannot leave it that way:
-- `PgDialect.migrate` (node_modules/drizzle-orm/pg-core/dialect.js) runs every
-- pending migration inside one `session.transaction`, and `src/db/migrate.ts`
-- reaches it through the `neon-serverless` migrator, whose session issues a real
-- `begin`/`commit`/`rollback` over the WebSocket `Pool` — so a statement that
-- throws rolls the whole file back and nothing in it is recorded. (The
-- `neon-http` driver is the one that cannot do this, and it throws on
-- `transaction` rather than running the statements loose; `src/db/index.ts`
-- deliberately does not use it.) `DATABASE_URL` being blank in this working
-- copy is what makes the hand-applied case real rather than theoretical: the
-- duplicates above cannot be inspected before the deploy, so somebody running
-- the three data statements against production first and finishing the job
-- afterwards is a thing that can happen.
--
-- One statement is not covered, and it is the audit insert. A re-run is a no-op
-- only because the DELETE has removed the rows both SELECTs feed on, so it is
-- the ordering that protects them rather than the statements themselves. Hand
-- run the notification and the audit line, stop before the DELETE, and come
-- back: the notification is saved by its dedupe key, and the audit line is
-- written a second time. Two log lines for one superseded grant is a log that
-- overstates what happened, which is why this is written down here — fixing it
-- would mean an anti-join against `audit_log` on the action and subject, and
-- changing the SQL of a migration that is already recorded against a database
-- is a worse trade than knowing about it.
INSERT INTO "notifications" (
  "user_id", "kind", "title", "body", "href", "event_id", "dedupe_key"
)
SELECT
  "losing"."user_id",
  'host_decision',
  'You are no longer hosting ' || "e"."title",
  'This event had two hosts at once, and a host is one grant per event — so the earlier grant was kept and yours was removed. Nothing you did caused it, and nothing you set up has been deleted. Ask an admin and they can hand you an event of your own.',
  '/host',
  "losing"."event_id",
  'host_decision:grant-superseded:' || "losing"."event_id" || ':' || "losing"."user_id"
FROM "event_hosts" AS "losing"
JOIN "events" AS "e" ON "e"."id" = "losing"."event_id"
WHERE ("losing"."event_id", "losing"."user_id") NOT IN (
  SELECT DISTINCT ON ("event_id") "event_id", "user_id"
  FROM "event_hosts"
  ORDER BY "event_id", "granted_at", "user_id"
)
ON CONFLICT ("user_id", "dedupe_key") DO NOTHING;--> statement-breakpoint
INSERT INTO "audit_log" (
  "actor_user_id", "actor_name", "action", "event_id", "subject", "summary", "detail"
)
SELECT
  NULL,
  'Migration drizzle/0025',
  'host.grant_superseded',
  "losing"."event_id",
  "losing"."user_id",
  'Host grant removed: this event had two hosts, and a host is one grant per event (R-86). The earlier grant was kept.',
  jsonb_build_object(
    'removedUserId', "losing"."user_id"::text,
    -- UTC, spelled out, rather than `::text`: that renders a timestamptz in
    -- whatever the session's TimeZone happens to be, so the same row would be
    -- logged differently depending on which machine ran the deploy.
    'removedGrantedAt',
      to_char("losing"."granted_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'keptUserId', (
      SELECT "kept"."user_id"::text
      FROM "event_hosts" AS "kept"
      WHERE "kept"."event_id" = "losing"."event_id"
      ORDER BY "kept"."granted_at", "kept"."user_id"
      LIMIT 1
    )
  )
FROM "event_hosts" AS "losing"
WHERE ("losing"."event_id", "losing"."user_id") NOT IN (
  SELECT DISTINCT ON ("event_id") "event_id", "user_id"
  FROM "event_hosts"
  ORDER BY "event_id", "granted_at", "user_id"
);--> statement-breakpoint
DELETE FROM "event_hosts" AS "losing"
WHERE ("losing"."event_id", "losing"."user_id") NOT IN (
  SELECT DISTINCT ON ("event_id") "event_id", "user_id"
  FROM "event_hosts"
  ORDER BY "event_id", "granted_at", "user_id"
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_hosts_one_host_per_event" ON "event_hosts" USING btree ("event_id");
