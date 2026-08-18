ALTER TABLE "match_games" ADD COLUMN "side_chosen" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "first_side_choice" text DEFAULT 'a' NOT NULL;--> statement-breakpoint
ALTER TABLE "match_games" ADD CONSTRAINT "match_games_side_chosen" CHECK ("match_games"."side_chosen" is null or "match_games"."side_chosen" in ('attack', 'defence'));--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_first_side_choice" CHECK ("matches"."first_side_choice" in ('a', 'b'));