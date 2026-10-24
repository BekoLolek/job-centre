-- One player's score in one round of a round-scored solo event, with the
-- bonuses they earned in it on the same row (R-224 / UC-45 5;
-- docs/decisions/006-round-scored-events.md, decision 1).
--
-- One new table and nothing else — no ALTER to an existing one, no new type.
--
-- ## A recorded fact, and the first stored number in the championship layer
--
-- src/db/schema.ts says, at the head of its championship section, that there is
-- no `points` column anywhere below it. The rule behind that sentence is that a
-- *derived* value is never stored, not that no number is: a round score is what
-- a person typed, exactly as `match_games.score_a` is, and everything worked
-- out from it — a player's total, the night's ranking, the championship places,
-- the standings — stays derived on every read. Nothing here stores a total, so
-- a corrected round (R-233) re-scores all of them with nothing left behind to
-- disagree.
--
-- ## `score` is NOT NULL because a blank round is the absence of a row
--
-- UC-45 3c says a player left blank for a round cannot have earned a bonus in
-- it. With `bonuses` on this row, "did not play" has exactly one representation
-- — no row — so an award with no score behind it is impossible to write rather
-- than refused by a guard somebody can forget. A nullable score would be that
-- row: no score, two bonuses on it. R-228's "never a zero" is the same fact from
-- the ranking's side: a missing row is read as the round's worst mark, which in
-- a low-score-wins event a stored 0 could never be.
--
-- ## `bonuses` is jsonb and its counts are not CHECKed
--
-- `Record<bonusKey, count>`. A bonus is a count because a feat earned three
-- times counts three times (R-230), and it is a column rather than a second
-- table because a second table keyed (event, round, player, bonus) could hold an
-- award with no score behind it — the state the paragraph above makes
-- unrepresentable. A CHECK cannot iterate jsonb, so "every count is at least 1"
-- is the policy function's rule rather than this file's; src/db/schema.ts names
-- the owner. Stated because a CHECK is otherwise this project's preference.
--
-- ## `round_index` is 1-based, with a CHECK saying 32
--
-- `between 1 and 32`, following `event_days_index_range`'s `between 0 and 4`
-- (drizzle/0001): a bound stops a typo creating round 9000. The literal is
-- written out because a CHECK cannot import a constant; `MAX_ROUNDS` in
-- src/lib/round-scoring.ts is the same number and its test reads this clause
-- back out of `information_schema`, so the two cannot drift in silence — the
-- shape `hero_hands_nine_distinct_per_role` (drizzle/0032) already uses.
--
-- ## On delete: cascade from both the event and the player
--
-- Both foreign keys cascade, following `championship_placements` (drizzle/0013)
-- rather than choosing afresh, and for its reason: deleting a member removes
-- their place rather than blocking the delete, because a finishing order with a
-- row missing is still a readable finishing order and the standings re-score
-- without them. A round is the same shape — a round with a row missing is still
-- a readable round, and the ranking re-derives without them. The alternative,
-- `restrict`, would make deleting an account fail on a Popsauce night from two
-- seasons ago. The event side cascades as every per-event table does
-- (`event_days`, `hero_hands`): a score of a round of an event that no longer
-- exists is not a fact about anything.
--
-- ## What happens to a deployment that already has events
--
-- **Nothing. The table starts empty on every install, including one with years
-- of events in it, and no existing event changes in any way.** There is no
-- INSERT, no UPDATE and no backfill of any kind — which makes this file unlike
-- drizzle/0015, 0018, 0020 and 0025, so the reason is stated rather than left
-- to be inferred; it is drizzle/0032's shape of "nothing": **there is no old
-- behaviour at all.** Before this commit a solo event's Results tab rendered an
-- empty state and nothing anywhere stored a per-round score, so there is no
-- event whose rounds *should* already be here, and a backfill could only invent
-- them. Whether an existing solo event is round-scored at all is a question of
-- its `events.config` (UC-44), which this file does not touch: an event nobody
-- has set up for rounds has no rounds, and its page goes on saying so.
--
-- ## Re-running it changes nothing
--
-- One CREATE TABLE, two ADD CONSTRAINT and one CREATE INDEX, no data — so a
-- second pass fails on the CREATE rather than corrupting anything, and a deploy
-- cannot reach a second pass at all: `PgDialect.migrate` runs every pending
-- migration inside one transaction (the note in drizzle/0025 has the detail), so
-- a half-applied file rolls back.
CREATE TABLE "event_round_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"round_index" integer NOT NULL,
	"user_id" uuid NOT NULL,
	"score" integer NOT NULL,
	"bonuses" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "event_round_scores_event_round_user_uniq" UNIQUE("event_id","round_index","user_id"),
	CONSTRAINT "event_round_scores_round_range" CHECK ("event_round_scores"."round_index" between 1 and 32)
);
--> statement-breakpoint
ALTER TABLE "event_round_scores" ADD CONSTRAINT "event_round_scores_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_round_scores" ADD CONSTRAINT "event_round_scores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_round_scores_event_round_idx" ON "event_round_scores" USING btree ("event_id","round_index");