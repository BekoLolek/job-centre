-- A hero is a name and the roles it can play (R-214 / UC-40; the multi-role
-- Constraint in docs/requirements.md).
--
-- One enum type and one table. `heroes` is the per-game catalogue the random
-- draw deals from and the admin screen edits, so a hero released next season is
-- a row rather than a deploy — the same bargain `games` and `profile_fields`
-- already make.
--
-- ## Why `roles` is an array of the enum and not a `role` column
--
-- **Deadpool**, and he is not a corner case to be handled later. The roster was
-- checked against the live game on 2026-10-23 rather than recalled: 54 heroes
-- at Season 10.5, which is 14 Vanguard + 27 Duelist + 12 Strategist *plus
-- Deadpool, playable as all three*. A single `role` column is therefore already
-- wrong against the roster as it stands — it would be migrated the first time
-- anybody noticed, and until then Deadpool would be missing from two of the
-- three pools he belongs to. Storing the set is why the drawable pools are
-- 15 / 28 / 13 rather than 14 / 27 / 12, and why the published counts disagree.
--
-- A real enum rather than text, deliberately unlike `announcement_templates.kind`
-- (drizzle/0029 argues that one the other way): the draw counts the pool **per
-- role**, so `'strategist'` or `'Strategist '` would be counted as a Strategist
-- by nothing at all. The role would hold one hero fewer, and a role below three
-- stops being drawable (UC-39 2a) — a typo turning into a silently shorter
-- pool, rather than into a rejected insert.
--
-- `heroes_roles_distinct_nonempty` is the other half of that, and it is UC-40 3b
-- in the database rather than only in the screen: a hero in **no** role can
-- never be drawn, which is the list lying rather than a hero being unavailable.
-- It also refuses the same role twice, and a NULL element — which needs saying
-- separately, because `null <> null` is NULL and a CHECK counts NULL as
-- satisfied. Three roles is the ceiling, so the three cardinalities spelled out
-- are the whole space; a `distinct unnest` would read better, but a CHECK
-- constraint may not contain a subquery at all.
--
-- ## What happens to a deployment that already has games
--
-- **The table starts empty, on every install, including one with a `rivals` row
-- already in it.** There is no INSERT here and no backfill of any kind, which
-- makes this file unlike drizzle/0015, 0018, 0020 and 0025, so the reason is
-- worth writing down rather than inferring from the absence; drizzle/0027, 0029
-- and 0030 are the other three files whose answer is "nothing".
--
-- The 54 heroes are planted by `src/db/seed.ts`, not from here, and the
-- difference is not bookkeeping:
--
--  * **The seed never overwrites.** Its module comment states the rule — rows
--    are inserted only when missing, because once a row exists the admin UI owns
--    it — and that rule is exactly what this data needs. An admin who corrects
--    a hero's roles after a rework must not have the next redeploy undo it. A
--    migration cannot make that promise: it runs once per deployment and has no
--    "only if missing" to offer a row an admin has since edited.
--  * **54 rows of roster data are not schema.** They are a snapshot of a live
--    game taken on one day, and they go stale by design — which is the whole of
--    R-214. Freezing them into a migration would make the first correction a
--    row that disagrees with the file that created it.
--
-- So an existing deployment has an empty hero list until `npm run db:seed` runs
-- against it. Note that `npm run build` runs `db:migrate` and **not** the seed,
-- so a deploy alone does not plant them; that is a command somebody runs. Until
-- it does, the draw page names the game and offers nothing rather than dealing
-- an empty hand (UC-39 1b), and nothing else reads this table.
--
-- ## Re-running it changes nothing
--
-- One CREATE TYPE, one CREATE TABLE and one ADD CONSTRAINT, no data — so a
-- second pass fails on the CREATE TYPE rather than corrupting anything, and a
-- deploy cannot reach a second pass at all: `PgDialect.migrate` runs every
-- pending migration inside one transaction (the note in drizzle/0025 has the
-- detail), so a half-applied file rolls back.
CREATE TYPE "public"."hero_role" AS ENUM('Vanguard', 'Duelist', 'Strategist');--> statement-breakpoint
CREATE TABLE "heroes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"game_id" uuid NOT NULL,
	"name" text NOT NULL,
	"roles" "hero_role"[] NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "heroes_game_name_uniq" UNIQUE("game_id","name"),
	CONSTRAINT "heroes_roles_distinct_nonempty" CHECK (array_position("heroes"."roles", null) is null and (
        cardinality("heroes"."roles") = 1
        or (cardinality("heroes"."roles") = 2 and "heroes"."roles"[1] <> "heroes"."roles"[2])
        or (
          cardinality("heroes"."roles") = 3
          and "heroes"."roles"[1] <> "heroes"."roles"[2]
          and "heroes"."roles"[1] <> "heroes"."roles"[3]
          and "heroes"."roles"[2] <> "heroes"."roles"[3]
        )
      ))
);
--> statement-breakpoint
ALTER TABLE "heroes" ADD CONSTRAINT "heroes_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE cascade ON UPDATE no action;