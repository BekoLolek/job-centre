-- Entry-rule waivers (R-59 / UC-14 3b): one manager's decision that one member
-- may enter, or captain, despite this event's rank rule.
--
-- ## Nothing here touches a row that already exists
--
-- A new table, a new enum, two indexes and one unique constraint *on that new
-- table*. No `ALTER TABLE` against `events`, `applications` or `users`, no
-- backfill, no `SET NOT NULL`, no new constraint over data this migration
-- cannot see. That is deliberate, and it is the reason this one needs no
-- `UPDATE` ahead of it the way drizzle/0015 and drizzle/0018 did: `CREATE
-- UNIQUE INDEX` and `SET NOT NULL` do not skip the rows that break them, they
-- fail the deploy and leave every later migration stuck behind it. An empty
-- table cannot contain a row that breaks its own constraint, so the one risk
-- those two migrations had to buy their way out of does not exist here.
--
-- What it does take, and the one thing that could hold a deploy up: each of the
-- three `ADD CONSTRAINT … FOREIGN KEY` statements below takes a SHARE ROW
-- EXCLUSIVE lock on the table it points at — `events` and `users` — so a long
-- transaction on either will block this migration (and, behind it, every write
-- queueing for those tables) until it finishes.
--
-- `DATABASE_URL` is blank in this working copy and production cannot be
-- inspected from here, which is exactly why the shape above was chosen over
-- the alternatives considered:
--
--  * **A `waived_rules` column on `applications`.** Needs a default and a
--    backfill over every stored application, and — fatally — cannot hold a
--    waiver for a member who has *no* application, which is the whole point of
--    the Gate-2 amendment: `applyToEvent` refuses a below-rank member before
--    anything is stored, so the waiver has to be able to exist first.
--  * **A check constraint tying a below-rank application to a waiver.** It
--    would be a constraint over rows written years before waivers existed,
--    evaluated against a *rank ladder that has since been edited*. It could
--    only be added by first proving no live row violates it, which is the
--    inspection this migration is not allowed to assume.
--
-- ## Why the thing waived is the rule and not the rank
--
-- `rule` is `enter` or `captain`. Ladders are editable (`LadderEditor`), and
-- an event's threshold is editable after that, so a waiver recording "past
-- Platinum III" would silently stop matching the rule it was granted against.
-- See the table's docblock in src/db/schema.ts.
--
-- ## Idempotent on re-run, like every migration here
--
-- `npm run db:migrate` re-runs the applied list on each deploy; drizzle's
-- journal makes that a no-op for this file, and there is no data statement in
-- it that would do anything if it ran twice.
CREATE TYPE "public"."entry_rule" AS ENUM('enter', 'captain');--> statement-breakpoint
CREATE TABLE "entry_waivers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rule" "entry_rule" NOT NULL,
	"waived_by" uuid,
	"waived_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_waivers_event_user_rule_uniq" UNIQUE("event_id","user_id","rule")
);
--> statement-breakpoint
ALTER TABLE "entry_waivers" ADD CONSTRAINT "entry_waivers_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_waivers" ADD CONSTRAINT "entry_waivers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entry_waivers" ADD CONSTRAINT "entry_waivers_waived_by_users_id_fk" FOREIGN KEY ("waived_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entry_waivers_event_id_idx" ON "entry_waivers" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "entry_waivers_user_id_idx" ON "entry_waivers" USING btree ("user_id");