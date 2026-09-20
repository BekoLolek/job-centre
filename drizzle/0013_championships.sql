CREATE TYPE "public"."championship_status" AS ENUM('hidden', 'published', 'closed');--> statement-breakpoint
CREATE TABLE "championship_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"championship_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"points_table" jsonb,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "championship_events_event_uniq" UNIQUE("event_id"),
	CONSTRAINT "championship_events_weight_positive" CHECK ("championship_events"."weight" > 0)
);
--> statement-breakpoint
CREATE TABLE "championship_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"championship_event_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"user_id" uuid,
	"team_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "championship_placements_event_user_uniq" UNIQUE("championship_event_id","user_id"),
	CONSTRAINT "championship_placements_event_team_uniq" UNIQUE("championship_event_id","team_id"),
	CONSTRAINT "championship_placements_position_positive" CHECK ("championship_placements"."position" >= 1),
	CONSTRAINT "championship_placements_one_subject" CHECK (("championship_placements"."user_id" is not null) <> ("championship_placements"."team_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "championships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "championship_status" DEFAULT 'hidden' NOT NULL,
	"runs_from" date,
	"runs_to" date,
	"points_table" jsonb DEFAULT '[25,18,15,12,10,8,6,4,2,1]'::jsonb NOT NULL,
	"participation_points" integer DEFAULT 0 NOT NULL,
	"count_best" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "championships_slug_unique" UNIQUE("slug"),
	CONSTRAINT "championships_months_ordered" CHECK ("championships"."runs_from" is null or "championships"."runs_to" is null or "championships"."runs_to" >= "championships"."runs_from"),
	CONSTRAINT "championships_months_are_first" CHECK (("championships"."runs_from" is null or extract(day from "championships"."runs_from") = 1)
          and ("championships"."runs_to" is null or extract(day from "championships"."runs_to") = 1)),
	CONSTRAINT "championships_participation_positive" CHECK ("championships"."participation_points" >= 0),
	CONSTRAINT "championships_count_best_positive" CHECK ("championships"."count_best" is null or "championships"."count_best" > 0)
);
--> statement-breakpoint
ALTER TABLE "championship_events" ADD CONSTRAINT "championship_events_championship_id_championships_id_fk" FOREIGN KEY ("championship_id") REFERENCES "public"."championships"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "championship_events" ADD CONSTRAINT "championship_events_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "championship_placements" ADD CONSTRAINT "championship_placements_championship_event_id_championship_events_id_fk" FOREIGN KEY ("championship_event_id") REFERENCES "public"."championship_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "championship_placements" ADD CONSTRAINT "championship_placements_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "championship_placements" ADD CONSTRAINT "championship_placements_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "championships" ADD CONSTRAINT "championships_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "championship_events_championship_idx" ON "championship_events" USING btree ("championship_id");--> statement-breakpoint
CREATE UNIQUE INDEX "championships_open_name_uniq" ON "championships" USING btree ("name") WHERE status <> 'closed';--> statement-breakpoint
CREATE INDEX "championships_status_idx" ON "championships" USING btree ("status");