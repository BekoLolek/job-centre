-- One template per name, in the database (R-125 / UC-28 4a).
--
-- `createTemplate` and `updateTemplate` both enforce 4a by reading every name,
-- folding it and comparing. That answers the admin who types "Rivals cup" a
-- minute after somebody else did; it cannot answer the two who type it in the
-- same instant, because it is a read-then-insert — both reads find the name
-- free, both inserts land, and the create-event picker then offers two
-- identical rows that build different events. `freeName`'s "copy", "copy 2"
-- suffixing has the same race, one layer along. This index is the half a read
-- cannot enforce, and `src/lib/admin-templates.ts` turns its rejection back
-- into the same sentence the read produces, so the two creates differ in
-- timing and in nothing else.
--
-- ## What "the same name" means, and why the index is not `lower(name)`
--
-- `cleanTemplateName` trims and **collapses whitespace** before storing, and
-- `takenNames` collapses again on the way back, so "Rivals cup" and
-- "Rivals  cup" are one name to the code. An index on `lower(name)` alone
-- would have admitted the second — the index would then be *weaker* than the
-- rule it exists to enforce, which is the defect this file would be adding
-- rather than fixing. So the expression folds the same way the code does:
--
--   lower(btrim(regexp_replace(name, '[[:space:]]+', ' ', 'g')))
--
-- `[[:space:]]` rather than `\s`, and the reason is narrower than it looks.
-- The two are **equivalent here** — measured against PGlite, both fold a
-- space, a tab and a collapsed run identically — so this is not a bug being
-- avoided. It is a dependency being avoided: `\s` only survives to the regex
-- engine while `standard_conforming_strings` is `on`. With it `off`, `'\s+'`
-- is parsed as the string `s+` and the expression quietly folds the **letter
-- s** instead of whitespace — measured too, the same way: with it off,
-- 'Rivals cup' folds to 'rival  cup'. That would not raise an error; it would
-- build a working index on a different meaning of "the same name", in a file
-- that can never be changed again once it is recorded against a database.
-- `on` is the default and is what this deployment has, so the risk is a future
-- server setting rather than a present fault — and the POSIX class simply has
-- no backslash to lose.
--
-- One disagreement with the code remains, and it is documented rather than
-- closed. Postgres folds **ASCII** whitespace here — and `\s` would not have
-- helped, which was measured: neither expression folds U+00A0. JavaScript's
-- `\s` does. So 'Rivals cup' folds to 'rivals cup' in
-- `cleanTemplateName` and to itself in this index, and a second template
-- called 'Rivals cup' would be admitted by the database where the code
-- calls it a duplicate.
--
-- The **code is the stricter side**, and that is the safe direction: it
-- refuses that name before the index is ever consulted, so the gap costs a
-- race window on an input nobody types and can never produce a raw database
-- error in place of UC-28 4a's sentence. Closing it would mean restating
-- JavaScript's whitespace set by hand — eleven code points, by memory, in an
-- index expression that cannot be changed later without reindexing
-- production — to win a race on a non-breaking space. Not worth it; worth
-- writing down.
--
-- ## What happens to templates that already share a name, and why
--
-- `CREATE UNIQUE INDEX` does not skip the rows that offend it. If two
-- templates in production fold to one name today the statement fails, the
-- migration fails with it, and every later migration is stuck behind a deploy
-- that needs somebody to edit production by hand. `DATABASE_URL` is blank in
-- this working copy by design, so nobody here can look first — which is why
-- the duplicates are dealt with below, in the same transaction that tightens
-- the rule, exactly as drizzle/0018 had to withdraw duplicate pending
-- applications and drizzle/0025 had to drop a second host grant.
--
-- They can exist. 4a has only ever been a read, the race above survives it,
-- and `cleanTemplateName`'s collapsing arrived after the table did — so a row
-- written by a seed, by an earlier migration, or by two admins in one instant
-- can fold onto another.
--
-- ### The loser is RENAMED, not deleted and not deactivated
--
-- The third option, and the right one here, where 0018 changed a status and
-- 0025 deleted a row. Neither of those had this one available: a duplicate
-- pending application and a second host grant are duplicate *facts*, and there
-- is nothing to rename. A template is a starting point with a label on it, the
-- conflict is entirely in the label, and so the cheapest true fix is to change
-- the label:
--
--  * **Nothing is destroyed.** The config, the questions and the setup columns
--    all survive, which matters because a template kept for next season is a
--    requirement (R-128) and the row may be the only record of a setup.
--  * **No event loses its provenance.** `events.created_from_template_id` is
--    `on delete set null`, so deleting the loser would blank the link on every
--    event made from it and silently drop "used 4 times" to nothing. A rename
--    touches no event at all.
--  * **It is the behaviour the application already has.** `freeName` suffixes
--    a name the *system* chose rather than refusing it, which is precisely the
--    case here: nobody typed "Rivals cup 2", this file chose it. The migration
--    and the running code resolve a system-chosen collision the same way.
--
-- Deactivating instead (`is_active = false`) was considered and rejected: it
-- would not satisfy the index — two hidden rows still share a name — and it
-- would quietly take a template out of the picker, which is a decision an
-- admin makes (UC-28 7, 8), not one a deploy makes for them.
--
-- ### Which row keeps the name: the EARLIEST created
--
-- `created_at` ascending, `id` breaking a tie so the statement picks the same
-- row every time it is run.
--
-- The same direction as drizzle/0025 and the opposite of drizzle/0018, and the
-- reason is 0025's. There, a host grant was kept because it was a permission
-- somebody had been *using*; in 0018 the newest pending application was kept
-- because an application is an *intention* and the newest is the one the
-- member most recently meant. A template name is the first kind, not the
-- second: it is what the create-event picker lists (UC-08 1), what an admin
-- types when they say "start from Rivals cup", and what the audit log already
-- records against every event made from it. The older row is the one people
-- have been picking by that name and the one existing events' provenance is
-- already associated with; renaming it would move the label out from under a
-- template in use. Two same-named templates are also not two attempts at one
-- thing — both exist, both work — so 0018's "the newest is the one they meant"
-- has nothing to get hold of.
--
-- The suffix is `freeName`'s: " 2", then " 3", and so on until one is free,
-- checked against the same fold so the new name cannot collide with a row
-- that is already called "Rivals cup 2" — which is a realistic shape, because
-- `duplicateTemplate` produces exactly those names. The base is cut to 80
-- characters minus the suffix (`TEMPLATE_NAME_MAX`), so the suffix survives
-- the truncation rather than being cut off by it.
--
-- ### Nobody is notified, and that is deliberate
--
-- drizzle/0025 wrote the losing member a notification because a *person* had
-- lost a permission they had personally been told they had. Nothing here
-- matches that shape: `event_templates` has no owner column, nobody is losing
-- anything but a label, and the audience for "a template got renamed" is
-- whoever maintains templates — the admins. The channel this site has for
-- telling admins what happened to admin-only data is the audit log
-- (R-110 / UC-27 3), and the rows below are written to it, against the
-- template as their `subject`, so filtering the log by that template finds the
-- rename. Minting a `notification_kind` for it was rejected: a kind is a
-- per-member switch (R-104), and a one-off migration notice has no business
-- becoming a permanent one.
--
-- ### Re-running it changes nothing
--
-- The rename removes the conflict, so a second pass finds no group with more
-- than one row, writes no audit line and renames nothing. The audit insert and
-- the rename are in **one statement** rather than two, which is a deliberate
-- improvement on drizzle/0025: that file's audit insert doubles if a hand run
-- is stopped between it and the DELETE that makes it a no-op, and there is no
-- such gap here. The index is created `IF NOT EXISTS`.
--
-- A failed *deploy* cannot half-apply this file either: `PgDialect.migrate`
-- runs every pending migration inside one `session.transaction`, so a
-- statement that throws rolls the whole file back (drizzle/0025 has the full
-- note). The hand-applied case is the one the idempotence above is for.
DO $$
DECLARE
  folded       text;
  kept_id      uuid;
  kept_name    text;
  loser        record;
  base         text;
  candidate    text;
  suffix       integer;
BEGIN
  FOR folded IN
    SELECT lower(btrim(regexp_replace("name", '[[:space:]]+', ' ', 'g')))
    FROM "event_templates"
    GROUP BY 1
    HAVING count(*) > 1
  LOOP
    SELECT "id", "name" INTO kept_id, kept_name
    FROM "event_templates"
    WHERE lower(btrim(regexp_replace("name", '[[:space:]]+', ' ', 'g'))) = folded
    ORDER BY "created_at", "id"
    LIMIT 1;

    FOR loser IN
      SELECT "id", "name"
      FROM "event_templates"
      WHERE lower(btrim(regexp_replace("name", '[[:space:]]+', ' ', 'g'))) = folded
        AND "id" <> kept_id
      ORDER BY "created_at", "id"
    LOOP
      base := btrim(regexp_replace(loser."name", '[[:space:]]+', ' ', 'g'));
      suffix := 2;
      LOOP
        -- 80 is TEMPLATE_NAME_MAX. The base is cut first and re-trimmed, so a
        -- cut that lands on a space cannot leave "Rivals  2" behind.
        candidate :=
          btrim(left(base, 80 - length(suffix::text) - 1)) || ' ' || suffix::text;
        EXIT WHEN NOT EXISTS (
          SELECT 1 FROM "event_templates"
          WHERE lower(btrim(regexp_replace("name", '[[:space:]]+', ' ', 'g')))
              = lower(btrim(regexp_replace(candidate, '[[:space:]]+', ' ', 'g')))
        );
        suffix := suffix + 1;
        /*
         * A thousand templates folding onto one name is not a state this site
         * can reach, but the fallback is a name rather than an exception on
         * purpose: drizzle/0026's review found a guard that halted a deploy —
         * and every migration behind it — over a state nobody could fix
         * without hand-editing production. A row's own id is unique by
         * construction, so this always terminates with a usable name, and the
         * audit line below records it.
         */
        IF suffix > 1000 THEN
          candidate := left(base, 80 - 37) || ' ' || loser."id"::text;
          EXIT;
        END IF;
      END LOOP;

      INSERT INTO "audit_log" (
        "actor_user_id", "actor_name", "action", "subject", "summary", "detail"
      ) VALUES (
        NULL,
        'Migration drizzle/0028',
        'template.name_superseded',
        loser."id"::text,
        'Template renamed: two templates had the same name, and a name is one '
          || 'template per name (R-125). The earlier template kept it.',
        jsonb_build_object(
          'wasCalled', loser."name",
          'nowCalled', candidate,
          'keptId',    kept_id::text,
          'keptName',  kept_name
        )
      );

      UPDATE "event_templates" SET "name" = candidate WHERE "id" = loser."id";
    END LOOP;
  END LOOP;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_templates_name_uniq" ON "event_templates" USING btree (lower(btrim(regexp_replace("name", '[[:space:]]+', ' ', 'g'))));
