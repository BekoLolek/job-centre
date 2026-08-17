CREATE TYPE "public"."stage_kind" AS ENUM('round_robin', 'single_elim', 'double_elim', 'swiss', 'group_playoff');--> statement-breakpoint
CREATE TABLE "match_games" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"mode" text DEFAULT '' NOT NULL,
	"map" text DEFAULT '' NOT NULL,
	"referee" text DEFAULT '' NOT NULL,
	"score_a" integer DEFAULT 0 NOT NULL,
	"score_b" integer DEFAULT 0 NOT NULL,
	"played" boolean DEFAULT false NOT NULL,
	CONSTRAINT "match_games_match_index_uniq" UNIQUE("match_id","index"),
	CONSTRAINT "match_games_index_positive" CHECK ("match_games"."index" >= 0),
	CONSTRAINT "match_games_scores_positive" CHECK ("match_games"."score_a" >= 0 and "match_games"."score_b" >= 0)
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stage_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"phase" integer DEFAULT 1 NOT NULL,
	"best_of" integer DEFAULT 1 NOT NULL,
	"team_a_id" uuid,
	"team_b_id" uuid,
	"source_a" text,
	"source_b" text,
	"scheduled_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_min" integer,
	"winner_override_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_stage_slot_uniq" UNIQUE("stage_id","slot"),
	CONSTRAINT "matches_best_of_odd" CHECK ("matches"."best_of" >= 1 and "matches"."best_of" % 2 = 1),
	CONSTRAINT "matches_round_positive" CHECK ("matches"."round" >= 1),
	CONSTRAINT "matches_phase_positive" CHECK ("matches"."phase" >= 1),
	CONSTRAINT "matches_duration_positive" CHECK ("matches"."duration_min" is null or "matches"."duration_min" > 0),
	CONSTRAINT "matches_distinct_teams" CHECK ("matches"."team_a_id" is null or "matches"."team_b_id" is null or "matches"."team_a_id" <> "matches"."team_b_id")
);
--> statement-breakpoint
CREATE TABLE "stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text,
	"kind" "stage_kind" NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stages_id_event_uniq" UNIQUE("id","event_id")
);
--> statement-breakpoint
ALTER TABLE "match_games" ADD CONSTRAINT "match_games_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_stage_event_fk" FOREIGN KEY ("stage_id","event_id") REFERENCES "public"."stages"("id","event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_team_a_event_fk" FOREIGN KEY ("team_a_id","event_id") REFERENCES "public"."teams"("id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_team_b_event_fk" FOREIGN KEY ("team_b_id","event_id") REFERENCES "public"."teams"("id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_winner_override_event_fk" FOREIGN KEY ("winner_override_id","event_id") REFERENCES "public"."teams"("id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "match_games_match_id_idx" ON "match_games" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "matches_stage_phase_idx" ON "matches" USING btree ("stage_id","phase");--> statement-breakpoint
CREATE INDEX "matches_event_scheduled_idx" ON "matches" USING btree ("event_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "stages_event_sort_idx" ON "stages" USING btree ("event_id","sort");