-- An announcement's wording is data, and a mention is the admin's own words
-- (R-201, R-202 / UC-37; the mention Constraint in docs/requirements.md).
--
-- One new table and nothing else. The eleven-ish announcement kinds have their
-- wording compiled into `src/lib/announce.ts` as functions, and this is where an
-- admin's override for one of them lives, together with who that announcement
-- mentions.
--
-- ## What happens to existing deployments
--
-- **Nothing, and that is the whole answer.** There is no backfill here, no
-- INSERT, no UPDATE and no data statement of any kind — which makes this file
-- unlike drizzle/0015, 0018, 0020 and 0025, so the reason is worth writing down
-- rather than inferring from the absence. drizzle/0027 is the other file in this
-- folder whose answer is "nothing", and the argument is the same shape.
--
-- **The absence of a row *is* "unedited".** `src/lib/announce.ts` reads a
-- missing row as "nobody has touched this kind" and calls the compiled function,
-- so every announcement on an existing deployment goes on posting byte for byte
-- what it posted before this migration: the same embed, no `content` key, and
-- `allowed_mentions: { parse: [] }`. There is therefore nothing a backfill could
-- write that would not be a *worse* copy of the default.
--
-- Worse, specifically, and this is the trap: the compiled copy is **not one
-- sentence per kind, it is a function**. A waitlisting reads differently with
-- and without a queue number; a lot that went for nothing says so in words; a
-- drawn series is waiting on an admin; a moved table says one of four things
-- depending on who took the lead. A backfill would have to pick one variant of
-- each and freeze it into a row, and from that moment every announcement of
-- that kind would post the frozen variant — a deployment silently starting to
-- post something nobody asked for, which is the exact failure the defaults
-- shape in `announcementSettingsFrom` was built to avoid. So the migration
-- writes no rows, and `announcement_templates` starts empty on every install.
--
-- The same argument is why `body` is **nullable**: a row with a null body is an
-- admin who chose a mention and left the wording alone, and it too posts the
-- compiled copy. Only a non-null `body` ever replaces a sentence.
--
-- ## Why `kind` is text rather than a Postgres enum
--
-- Deliberately unlike `notification_kind`, `entry_rule` and
-- `profile_field_type`, each of which is a real enum here precisely so that a
-- caller cannot invent a value. A **new announcement kind must be able to ship
-- without a migration** (the module comment in `src/lib/announce.ts` says so,
-- and Tasks 62 and 63 are about to add three), and an enum would make each one
-- an `ALTER TYPE` plus a deploy. A row naming a kind that no longer exists is
-- never read, which is already how a stale key in the switches object behaves.
--
-- ## Why a table and not another `settings` key
--
-- The switches next door are seven booleans in one jsonb row, because one
-- screen writes all seven together and every reader wants all seven. A wording
-- is the opposite shape: up to 4096 characters of admin text, edited one kind at
-- a time. In one blob, two admins editing two *different* kinds would overwrite
-- each other, because each save carries that editor's stale copy of the other
-- six. A row per kind makes that collision impossible across kinds, and
-- `version` makes it detectable within one (UC-37 7a).
--
-- ## Re-running it changes nothing
--
-- One CREATE TABLE and one ADD CONSTRAINT, no data, so a second pass fails on
-- the CREATE rather than corrupting anything — and a deploy cannot reach a
-- second pass at all: `PgDialect.migrate` runs every pending migration inside
-- one transaction (the note in drizzle/0025 has the detail), so a half-applied
-- file rolls back.
CREATE TABLE "announcement_templates" (
	"kind" text PRIMARY KEY NOT NULL,
	"body" text,
	"mention_everyone" boolean DEFAULT false NOT NULL,
	"mention_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "announcement_templates" ADD CONSTRAINT "announcement_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;