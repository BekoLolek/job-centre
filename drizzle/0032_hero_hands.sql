-- The nine heroes a participant was dealt for an event: dealt once, and it
-- stands (R-212 / UC-39 3a, 3b, 5a, 6a).
--
-- One new table and nothing else — no ALTER to an existing one, no new type.
--
-- ## The unique constraint is the requirement, not an index for speed
--
-- `hero_hands_event_user_uniq` on (event_id, user_id) is R-212 itself. "My draw
-- happens once and stands" is a uniqueness claim about a pair, so it is held
-- where uniqueness can be held: a second deal is refused by Postgres whatever
-- code asks for it. `dealFor` in src/lib/hero-hands.ts inserts with
-- `on conflict do nothing … returning()` and reads the empty return as "somebody
-- else got there first" — the pattern `announcement_claims` (drizzle/0030) uses
-- for the same reason, and the reason it is not a read-then-write: two devices
-- clicking in the same instant (UC-39 3b) both read "no hand" and both deal.
-- `applications_event_user_uniq` is the shape followed here on purpose; one
-- application per member per event is the same sentence about the same pair.
--
-- ## Why nine ids in one array column
--
-- Because the constraint above demands one row per pair, and a row per card
-- could not carry it. The nine ids and the claim have to be the *same* write or
-- there is a window in which a hand exists and is empty.
--
-- **Ids and not names.** A hero is identified by `(game, name)` with no stable
-- key column — Task 73 declined one, and `renameHero` in src/lib/heroes.ts
-- documents what that costs — so a stored name would stop matching the roster
-- the first time an admin fixed a spelling, and the hand would quietly lose a
-- hero. The id survives a rename, and it survives a **retirement**, which is
-- UC-40 4a: `retireHero` writes `retired_at` and deletes nothing, the draw stops
-- offering the row, and this array still points at it. What was dealt stays
-- dealt.
--
-- Position carries the role: the array is the three role lists flattened in
-- `HERO_ROLES` order, three to a role, so 1-3 are Vanguard, 4-6 Duelist, 7-9
-- Strategist. A `role` column would be wrong rather than redundant, because
-- **Deadpool is playable in all three** — the same id can legitimately appear
-- twice in one hand, so (hand, hero) is not a key and only position tells
-- "Deadpool as my Vanguard" from "Deadpool as my Duelist".
--
-- `hero_hands_nine_distinct_per_role` is therefore distinct **within** each
-- triple and deliberately silent across them: a constraint forbidding a repeated
-- id anywhere in the array would refuse a legal hand. The
-- `array_position(..., null) is null` half is not decoration, for the reason
-- `heroes_roles_distinct_nonempty` gives in drizzle/0031: `null <> null` is NULL
-- and a CHECK counts NULL as satisfied, so a NULL element would pass every
-- inequality below it. The `= 9` is `HERO_ROLES.length * HEROES_PER_ROLE`
-- written out, because a CHECK cannot import a constant;
-- `src/lib/__tests__/hero-hands.test.ts` asserts the two agree, so a fourth role
-- could not leave the code and this file disagreeing in silence.
--
-- There is no foreign key on the array elements, because Postgres cannot
-- reference a table from one. The exposure is a hard `delete` of a `games` row,
-- which cascades to `heroes`, and the site has no such path: games are switched
-- off with `is_active` and heroes are retired. `handFor` throws naming a missing
-- id rather than returning a hand of eight, because a short hand presented as
-- whole is the failure worth avoiding.
--
-- ## What happens to a deployment that already has events
--
-- **Nothing. The table starts empty on every install, including one with years
-- of events in it, and no existing event changes in any way.** There is no
-- INSERT, no UPDATE and no backfill of any kind here — which makes this file
-- unlike drizzle/0015, 0018, 0020 and 0025, so the reason is worth stating
-- rather than inferring from the absence; drizzle/0027, 0029, 0030 and 0031 are
-- the others whose answer is "nothing", and this is 0030's shape of it: **there
-- is no old behaviour at all.**
--
-- Nothing has ever dealt a hand. Before this commit the draw existed only as a
-- pure function over a pool (src/lib/heroes-policy.ts, Task 74) with no caller
-- that stored anything, and `heroes` itself arrived empty one migration ago and
-- is planted by `npm run db:seed` rather than by a migration. So there is no
-- event, past or present, that *should* already have hands, and a backfill could
-- only invent them — nine heroes per participant per past event, dealt now from
-- a roster that did not exist on the night, presented as what those players were
-- holding. That is not a migration, it is a fabrication, and it would also be
-- read by the draw page as "you already drew" for an event nobody drew for.
--
-- The one real consequence for existing events is worth naming so that it is a
-- decision: **an event that has already happened is now drawable.** No hand
-- exists for it, so any participant opening its draw page would be dealt one.
-- That is correct and it is not this table's business — which events offer a
-- draw at all is the page's question (Task 76, UC-39 1, 1b) and the hero list's
-- (an event whose game has no heroes cannot deal). A column here saying "draws
-- are closed" would be a second place to store what the event already knows.
--
-- ## Re-running it changes nothing
--
-- One CREATE TABLE, two ADD CONSTRAINT and one CREATE INDEX, no data — so a
-- second pass fails on the CREATE rather than corrupting anything, and a deploy
-- cannot reach a second pass at all: `PgDialect.migrate` runs every pending
-- migration inside one transaction (the note in drizzle/0025 has the detail), so
-- a half-applied file rolls back.
CREATE TABLE "hero_hands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"hero_ids" uuid[] NOT NULL,
	"dealt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hero_hands_event_user_uniq" UNIQUE("event_id","user_id"),
	CONSTRAINT "hero_hands_nine_distinct_per_role" CHECK (array_position("hero_hands"."hero_ids", null) is null
        and cardinality("hero_hands"."hero_ids") = 9
        and "hero_hands"."hero_ids"[1] <> "hero_hands"."hero_ids"[2]
        and "hero_hands"."hero_ids"[1] <> "hero_hands"."hero_ids"[3]
        and "hero_hands"."hero_ids"[2] <> "hero_hands"."hero_ids"[3]
        and "hero_hands"."hero_ids"[4] <> "hero_hands"."hero_ids"[5]
        and "hero_hands"."hero_ids"[4] <> "hero_hands"."hero_ids"[6]
        and "hero_hands"."hero_ids"[5] <> "hero_hands"."hero_ids"[6]
        and "hero_hands"."hero_ids"[7] <> "hero_hands"."hero_ids"[8]
        and "hero_hands"."hero_ids"[7] <> "hero_hands"."hero_ids"[9]
        and "hero_hands"."hero_ids"[8] <> "hero_hands"."hero_ids"[9])
);
--> statement-breakpoint
ALTER TABLE "hero_hands" ADD CONSTRAINT "hero_hands_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hero_hands" ADD CONSTRAINT "hero_hands_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hero_hands_event_idx" ON "hero_hands" USING btree ("event_id");