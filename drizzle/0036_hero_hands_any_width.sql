-- A stored hand may be any width, not only nine (R-270, R-271 / UC-58 7, 7a).
--
-- `hero_hands_nine_distinct_per_role` (drizzle/0032) says `cardinality = 9` and
-- writes nine inequalities out by hand, because a CHECK may not contain a
-- subquery. An event now says how many heroes it deals in each role, so the
-- rule has to hold for a width nobody has typed yet. A CHECK may call an
-- IMMUTABLE function, and a function may contain the subquery — so the rule
-- moves into one.
--
-- ## Additive only: the nine is still here when this file has run
--
-- A push to main applies this while instances of the previous build are still
-- serving (docs/plan.md's risk register: "Additive-first migrations; drops in a
-- later commit"). So this file **adds** a function and **adds** a constraint,
-- and removes nothing. Both CHECKs are on the table afterwards and a hand must
-- satisfy both — which still means nine, because the new rule accepts every
-- hand the old one accepts and the old one accepts nothing else.
--
-- The nine goes in a second deploy. Its drop is written and deliberately not
-- journalled: `drizzle/later/hero_hands_drop_nine.sql`, which says how to land
-- it. **Do not fold it into this file.** Until it has landed, no width but
-- three can be stored, and nothing that lets a manager save another width may
-- ship (Task 143).
--
-- What `npm run db:generate` wrote was the ADD CONSTRAINT alone, valid at
-- once and with no function for it to call. The function, the guard and the
-- separate VALIDATE are by hand.
--
-- ## The function, clause by clause
--
-- `ids` is the flattened hand and `role_count` is how many roles it is
-- flattened across. The CHECK passes `3`, which is `HERO_ROLES.length` written
-- out because a CHECK cannot import a constant;
-- `src/db/__tests__/hero-hands-width.test.ts` reads it off the live constraint
-- and compares the two.
--
--  - `coalesce(..., false)`: a CHECK counts NULL as satisfied, so this function
--    must never answer NULL. For a NULL array every clause below is NULL. The
--    column is NOT NULL as well; this is so the function is right on its own.
--  - `array_position(ids, null) is null`: no NULL element. Kept as its own
--    clause for the reason 0032 gives — and the grouped count below has the
--    same blind spot from the other side, since one NULL in a block is a group
--    of one.
--  - `cardinality(ids) > 0`: an empty array divides evenly by anything, has no
--    element to be NULL and no pair to repeat, so nothing else here refuses it.
--  - `cardinality(ids) % role_count = 0`: the same number of ids in every role.
--  - `not exists (...)`: no id twice **inside one role's block**. Slot `n`
--    (1-based) is in block `(n - 1) * role_count / cardinality`, integer
--    division — 0 for the first role, 1 for the second. Grouping by block *and*
--    id is what keeps this silent **across** roles: Deadpool as a Vanguard and
--    again as a Duelist is two groups of one, and a legal hand. A `distinct`
--    over the whole array would refuse it.
--
--    Multiplying before dividing, rather than dividing by the width
--    (`cardinality / role_count`), is deliberate: Postgres does not promise to
--    evaluate an AND left to right, and for two ids across three roles the
--    width is 0 — the row would be refused by a division-by-zero error instead
--    of by the constraint's name. This form divides by the cardinality, which
--    is only ever zero when `unnest` has no rows to evaluate it for.
--
-- IMMUTABLE is true of it: it reads its two arguments and nothing else.
--
-- ## What happens to a deployment that already has hands
--
-- **Nothing is rewritten.** There is no UPDATE here. Every stored hand passed
-- the nine, so it is nine distinct-per-role ids with no NULL, which is a
-- well-formed hand of width three; VALIDATE reads each row, finds that, and
-- marks the constraint valid. A hand dealt at three stays nine ids for ever
-- (R-271).
--
-- ## NOT VALID, then VALIDATE
--
-- The shape that lets a large table take the constraint under a brief lock and
-- check its rows under a lighter one. Said plainly: the migrator runs every
-- pending file in one transaction, so here both locks are held until the
-- commit and the separation buys nothing on its own. It is kept because it is
-- correct under either runner and costs nothing — `hero_hands` holds one row
-- per participant per event.
--
-- ## Re-running it changes nothing
--
-- The migrator applies a file once; these statements are re-runnable anyway.
-- `CREATE OR REPLACE` replaces the function with itself. Postgres has no
-- `ADD CONSTRAINT IF NOT EXISTS`, so the ADD is guarded by a look in
-- `pg_constraint` — not by a DROP first, which would be the remove-and-recreate
-- this file exists to avoid. VALIDATE on a valid constraint is a no-op.
CREATE OR REPLACE FUNCTION hero_hand_is_well_formed(ids uuid[], role_count integer)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  select coalesce(
    array_position(ids, null) is null
    and cardinality(ids) > 0
    and cardinality(ids) % role_count = 0
    and not exists (
      select 1
      from unnest(ids) with ordinality as slot(id, position)
      group by (slot.position - 1) * role_count / cardinality(ids), slot.id
      having count(*) > 1
    ),
    false
  )
$$;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'hero_hands_per_role_distinct'
      AND conrelid = 'hero_hands'::regclass
  ) THEN
    ALTER TABLE "hero_hands" ADD CONSTRAINT "hero_hands_per_role_distinct" CHECK (hero_hand_is_well_formed("hero_hands"."hero_ids", 3)) NOT VALID;
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "hero_hands" VALIDATE CONSTRAINT "hero_hands_per_role_distinct";
