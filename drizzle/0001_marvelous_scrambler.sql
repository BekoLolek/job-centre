CREATE TYPE "public"."application_status" AS ENUM('accepted', 'waitlisted', 'declined', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."availability_state" AS ENUM('yes', 'maybe', 'no');--> statement-breakpoint
CREATE TYPE "public"."confirmation_state" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('draft', 'published', 'live', 'complete', 'cancelled');--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "application_status" NOT NULL,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"waitlist_position" integer,
	"note" text,
	CONSTRAINT "applications_event_user_uniq" UNIQUE("event_id","user_id"),
	CONSTRAINT "applications_waitlist_position_positive" CHECK ("applications"."waitlist_position" is null or "applications"."waitlist_position" > 0)
);
--> statement-breakpoint
CREATE TABLE "availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"event_day_id" uuid NOT NULL,
	"state" "availability_state" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_application_day_uniq" UNIQUE("application_id","event_day_id")
);
--> statement-breakpoint
CREATE TABLE "confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"state" "confirmation_state" NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "confirmations_application_id_unique" UNIQUE("application_id")
);
--> statement-breakpoint
CREATE TABLE "event_days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"day_index" integer NOT NULL,
	"starts_at" timestamp with time zone,
	"label" text,
	CONSTRAINT "event_days_event_index_uniq" UNIQUE("event_id","day_index"),
	CONSTRAINT "event_days_index_range" CHECK ("event_days"."day_index" between 0 and 4)
);
--> statement-breakpoint
CREATE TABLE "event_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" "profile_field_type" NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"profile_field_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_questions_event_key_uniq" UNIQUE("event_id","key")
);
--> statement-breakpoint
CREATE TABLE "event_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'custom' NOT NULL,
	"game_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"type" text DEFAULT 'custom' NOT NULL,
	"status" "event_status" DEFAULT 'draft' NOT NULL,
	"description" text,
	"banner_url" text,
	"signup_opens_at" timestamp with time zone,
	"signup_closes_at" timestamp with time zone,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"capacity" integer,
	"game_id" uuid,
	"min_rank_to_enter" text,
	"min_rank_to_captain" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_slug_unique" UNIQUE("slug"),
	CONSTRAINT "events_capacity_positive" CHECK ("events"."capacity" is null or "events"."capacity" > 0)
);
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability" ADD CONSTRAINT "availability_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability" ADD CONSTRAINT "availability_event_day_id_event_days_id_fk" FOREIGN KEY ("event_day_id") REFERENCES "public"."event_days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "confirmations" ADD CONSTRAINT "confirmations_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_days" ADD CONSTRAINT "event_days_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_questions" ADD CONSTRAINT "event_questions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_questions" ADD CONSTRAINT "event_questions_profile_field_id_profile_fields_id_fk" FOREIGN KEY ("profile_field_id") REFERENCES "public"."profile_fields"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_templates" ADD CONSTRAINT "event_templates_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applications_event_status_idx" ON "applications" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "applications_user_id_idx" ON "applications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "applications_event_submitted_idx" ON "applications" USING btree ("event_id","submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_waitlist_position_uniq" ON "applications" USING btree ("event_id","waitlist_position") WHERE "applications"."status" = 'waitlisted';--> statement-breakpoint
CREATE INDEX "availability_application_id_idx" ON "availability" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "availability_event_day_id_idx" ON "availability" USING btree ("event_day_id");--> statement-breakpoint
CREATE INDEX "event_days_event_id_idx" ON "event_days" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "event_questions_event_sort_idx" ON "event_questions" USING btree ("event_id","sort");--> statement-breakpoint
CREATE INDEX "event_templates_active_sort_idx" ON "event_templates" USING btree ("is_active","sort");--> statement-breakpoint
CREATE INDEX "events_status_starts_at_idx" ON "events" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "events_game_id_idx" ON "events" USING btree ("game_id");