-- One row per grant (R-261 / UC-55, docs/decisions/007-permissions.md).
--
-- `user_permissions` holds the powers a member has been given: the member,
-- the power, who granted it, when. The primary key is (member, power), so a
-- second row for the same grant is refused: a plain insert of it is an error.
-- `grantPower` in `src/lib/permissions.ts` is what makes a repeat a no-op,
-- with `ON CONFLICT DO NOTHING` aimed at this key.
--
-- ## One table, and nothing else
--
-- No existing table, column, constraint, index or enum is touched. A push to
-- main applies this file while instances of the previous build are still
-- serving (docs/plan.md's risk register: "Additive-first migrations; drops in
-- a later commit"), and a table they have never heard of costs them nothing.
--
-- There is no data statement. Nobody holds a power until an admin grants one,
-- and `users.is_admin` is not copied in: the admin flag is a superuser above
-- the vocabulary and is never a row here.
--
-- `power` is text with no CHECK. The vocabulary lives in
-- `src/lib/permissions-policy.ts`, and adding a name to it must not need a
-- migration — the convention `audit_log.action` follows. `grantPower` in
-- `src/lib/permissions.ts` is what refuses a name outside it.
--
-- ## Run twice
--
-- The whole file can be, and a second run changes nothing — including over
-- grants made since the first.
--
-- That is not what `npm run db:generate` wrote, and the difference is by
-- hand. It wrote a plain `CREATE TABLE` followed by two `ALTER TABLE ... ADD
-- CONSTRAINT` statements for the foreign keys. `CREATE TABLE` takes `IF NOT
-- EXISTS`; `ADD CONSTRAINT` does not, in any Postgres. So the two foreign
-- keys are declared inside the table instead, under the names drizzle gave
-- them and with the same actions, where the one `IF NOT EXISTS` covers all of
-- it. The resulting table is the one the generated statements build: the
-- 0035 tests in `src/db/__tests__/migrations.test.ts` list its columns,
-- constraints and indexes by name.
CREATE TABLE IF NOT EXISTS "user_permissions" (
	"user_id" uuid NOT NULL,
	"power" text NOT NULL,
	"granted_by_user_id" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_permissions_user_id_power_pk" PRIMARY KEY("user_id","power"),
	CONSTRAINT "user_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "user_permissions_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);
