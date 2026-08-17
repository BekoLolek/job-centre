CREATE TYPE "public"."draft_balance_mode" AS ENUM('uniform', 'per_team');--> statement-breakpoint
CREATE TYPE "public"."draft_bid_visibility" AS ENUM('admin_only', 'captains', 'everyone');--> statement-breakpoint
CREATE TYPE "public"."draft_bidding_mode" AS ENUM('sealed', 'open');--> statement-breakpoint
CREATE TYPE "public"."draft_lot_status" AS ENUM('open', 'awarded', 'discarded', 'reserved', 'voided');--> statement-breakpoint
CREATE TYPE "public"."draft_pool_kind" AS ENUM('main', 'reserve');--> statement-breakpoint
CREATE TYPE "public"."draft_selection_mode" AS ENUM('wheel', 'admin_pick', 'fixed_order');--> statement-breakpoint
CREATE TABLE "draft_bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lot_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"amount" integer NOT NULL,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_bids_lot_team_uniq" UNIQUE("lot_id","team_id"),
	CONSTRAINT "draft_bids_amount_positive" CHECK ("draft_bids"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "draft_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"balance_mode" "draft_balance_mode" DEFAULT 'uniform' NOT NULL,
	"default_balance" integer DEFAULT 1000 NOT NULL,
	"bidding_mode" "draft_bidding_mode" DEFAULT 'sealed' NOT NULL,
	"min_bid" integer DEFAULT 0 NOT NULL,
	"min_increment" integer DEFAULT 1 NOT NULL,
	"bid_timer_seconds" integer,
	"selection_mode" "draft_selection_mode" DEFAULT 'wheel' NOT NULL,
	"reserve_enabled" boolean DEFAULT true NOT NULL,
	"reserve_rounds" integer,
	"roster_target" integer DEFAULT 6 NOT NULL,
	"must_fill_roster" boolean DEFAULT true NOT NULL,
	"bid_visibility" "draft_bid_visibility" DEFAULT 'admin_only' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_configs_event_id_unique" UNIQUE("event_id"),
	CONSTRAINT "draft_configs_balance_positive" CHECK ("draft_configs"."default_balance" >= 0),
	CONSTRAINT "draft_configs_min_bid_positive" CHECK ("draft_configs"."min_bid" >= 0),
	CONSTRAINT "draft_configs_increment_positive" CHECK ("draft_configs"."min_increment" >= 1),
	CONSTRAINT "draft_configs_roster_target_positive" CHECK ("draft_configs"."roster_target" >= 1),
	CONSTRAINT "draft_configs_timer_positive" CHECK ("draft_configs"."bid_timer_seconds" is null or "draft_configs"."bid_timer_seconds" > 0),
	CONSTRAINT "draft_configs_reserve_rounds_positive" CHECK ("draft_configs"."reserve_rounds" is null or "draft_configs"."reserve_rounds" >= 1)
);
--> statement-breakpoint
CREATE TABLE "draft_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"player_user_id" uuid NOT NULL,
	"status" "draft_lot_status" DEFAULT 'open' NOT NULL,
	"from_kind" "draft_pool_kind" DEFAULT 'main' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_by" uuid,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"winner_team_id" uuid,
	"price" integer,
	"spin" jsonb,
	"voided_at" timestamp with time zone,
	"voided_by" uuid,
	CONSTRAINT "draft_lots_price_positive" CHECK ("draft_lots"."price" is null or "draft_lots"."price" >= 0),
	CONSTRAINT "draft_lots_award_complete" CHECK ("draft_lots"."status" <> 'awarded' or ("draft_lots"."winner_team_id" is not null and "draft_lots"."price" is not null)),
	CONSTRAINT "draft_lots_voided_stamped" CHECK (("draft_lots"."status" = 'voided') = ("draft_lots"."voided_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "draft_pool_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "draft_pool_kind" DEFAULT 'main' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_pool_entries_event_user_uniq" UNIQUE("event_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "team_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"price" integer DEFAULT 0 NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_captain" boolean DEFAULT false NOT NULL,
	"lot_id" uuid,
	CONSTRAINT "team_members_team_user_uniq" UNIQUE("team_id","user_id"),
	CONSTRAINT "team_members_event_user_uniq" UNIQUE("event_id","user_id"),
	CONSTRAINT "team_members_price_positive" CHECK ("team_members"."price" >= 0),
	CONSTRAINT "team_members_captain_is_free" CHECK ("team_members"."is_captain" = false or "team_members"."price" = 0)
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"captain_user_id" uuid,
	"seed" integer,
	"balance_start" integer DEFAULT 0 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_event_name_uniq" UNIQUE("event_id","name"),
	CONSTRAINT "teams_event_captain_uniq" UNIQUE("event_id","captain_user_id"),
	CONSTRAINT "teams_id_event_uniq" UNIQUE("id","event_id"),
	CONSTRAINT "teams_balance_start_positive" CHECK ("teams"."balance_start" >= 0)
);
--> statement-breakpoint
ALTER TABLE "draft_bids" ADD CONSTRAINT "draft_bids_lot_id_draft_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."draft_lots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_bids" ADD CONSTRAINT "draft_bids_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_configs" ADD CONSTRAINT "draft_configs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_lots" ADD CONSTRAINT "draft_lots_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_lots" ADD CONSTRAINT "draft_lots_player_user_id_users_id_fk" FOREIGN KEY ("player_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_lots" ADD CONSTRAINT "draft_lots_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_lots" ADD CONSTRAINT "draft_lots_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_lots" ADD CONSTRAINT "draft_lots_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_lots" ADD CONSTRAINT "draft_lots_winner_event_fk" FOREIGN KEY ("winner_team_id","event_id") REFERENCES "public"."teams"("id","event_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_pool_entries" ADD CONSTRAINT "draft_pool_entries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_pool_entries" ADD CONSTRAINT "draft_pool_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_lot_id_draft_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."draft_lots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_event_fk" FOREIGN KEY ("team_id","event_id") REFERENCES "public"."teams"("id","event_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_captain_user_id_users_id_fk" FOREIGN KEY ("captain_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "draft_bids_lot_id_idx" ON "draft_bids" USING btree ("lot_id");--> statement-breakpoint
CREATE INDEX "draft_lots_event_opened_idx" ON "draft_lots" USING btree ("event_id","opened_at");--> statement-breakpoint
CREATE INDEX "draft_lots_event_status_idx" ON "draft_lots" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "draft_lots_player_idx" ON "draft_lots" USING btree ("player_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_lots_one_open_per_event" ON "draft_lots" USING btree ("event_id") WHERE status = 'open';--> statement-breakpoint
CREATE INDEX "draft_pool_entries_event_kind_sort_idx" ON "draft_pool_entries" USING btree ("event_id","kind","sort");--> statement-breakpoint
CREATE INDEX "team_members_team_id_idx" ON "team_members" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "team_members_user_id_idx" ON "team_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "teams_event_sort_idx" ON "teams" USING btree ("event_id","sort");