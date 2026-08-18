CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"actor_name" text,
	"action" text NOT NULL,
	"event_id" uuid,
	"subject" text,
	"summary" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "handle" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_event_at_idx" ON "audit_log" USING btree ("event_id","at");--> statement-breakpoint
--> statement-breakpoint
-- Backfill: every member who already exists gets the handle they would have
-- been given, before the unique constraint below goes on. Written by hand
-- rather than generated, because drizzle-kit can add a column but has no idea
-- what should be in it — and adding the constraint first would be fine (nulls
-- are distinct) but would leave every existing member without a profile URL
-- until something happened to touch their row.
--
-- The shape mirrors `handleBase` + `uniqueKey` in src/lib/players.ts: slug the
-- Discord name, fall back to `player` when it slugs to nothing, push the
-- reserved words out of the way, then suffix duplicates -2, -3… in join order
-- so the member who has been here longest keeps the bare handle.
UPDATE "users" AS u
SET "handle" = numbered.candidate
FROM (
  SELECT
    id,
    base || CASE WHEN rn = 1 THEN '' ELSE '-' || rn::text END AS candidate
  FROM (
    SELECT
      id,
      base,
      row_number() OVER (PARTITION BY base ORDER BY created_at, id) AS rn
    FROM (
      SELECT
        id,
        created_at,
        CASE
          WHEN slug = '' THEN 'player'
          WHEN slug IN ('admin', 'me', 'events', 'players', 'signin', 'api', 'new')
            THEN slug || '-player'
          ELSE slug
        END AS base
      FROM (
        SELECT
          id,
          created_at,
          trim(both '-' from left(
            regexp_replace(lower(coalesce("display_name", "name", '')), '[^a-z0-9]+', '-', 'g'),
            32
          )) AS slug
        FROM "users"
      ) AS slugged
    ) AS based
  ) AS ranked
) AS numbered
WHERE u.id = numbered.id AND u."handle" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_handle_unique" UNIQUE("handle");