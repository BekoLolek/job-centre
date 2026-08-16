/**
 * Job Centre Events — Phase 1 schema (docs/platform-plan.md §3.1, §7, §14).
 *
 * Two groups of tables live here:
 *
 *  1. The four tables `@auth/drizzle-adapter` requires (`users`, `accounts`,
 *     `sessions`, `verification_tokens`). Their *TypeScript property* names are
 *     fixed by the adapter — it reads `account.providerAccountId`,
 *     `session.sessionToken`, `user.emailVerified` and so on by name. The SQL
 *     column names underneath are ours, so they stay snake_case like the rest of
 *     the database. `users` is extended with the Discord identity columns §7 asks
 *     for; the adapter ignores columns it does not know about.
 *
 *  2. The per-game profile machinery from §14: an admin-editable `games`
 *     catalogue that `profile_fields.game_id` points at, so "add a game and say
 *     what info I want from players" is a UI action rather than a migration.
 *
 * Conventions: uuid primary keys with a database-side default, `timestamptz`
 * everywhere (absolute instants — the timezone lesson from the current build),
 * and jsonb for anything shaped by admin configuration rather than by code.
 */

import { relations, sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ */
/* Shared column helpers                                              */
/* ------------------------------------------------------------------ */

/** Every timestamp in this database is an absolute instant. */
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * `jsonb`, but without drizzle's double-parse.
 *
 * drizzle's built-in `jsonb()` calls `JSON.parse` on anything the driver hands
 * back as a string. Both drivers we use (PGlite and `@neondatabase/serverless`)
 * already parse jsonb themselves, so a stored JSON *string* gets parsed twice:
 * `"123456789012345678"` comes back as the number 123456789012345680 — a
 * silently corrupted Discord snowflake — and `"true"` comes back as a boolean.
 *
 * Arrays and objects are unaffected, which is why the bug hides until a scalar
 * setting is stored. This type writes with `JSON.stringify` and reads whatever
 * the driver already decoded, which is correct for both. The
 * "does not double-parse a scalar" test guards it.
 */
const json = <T>(name: string) =>
  customType<{ data: T; driverData: unknown }>({
    dataType: () => "jsonb",
    toDriver: (value: T) => JSON.stringify(value),
    fromDriver: (value: unknown) => value as T,
  })(name);

/* ------------------------------------------------------------------ */
/* Identity — the Auth.js tables (§3.2, §7)                           */
/* ------------------------------------------------------------------ */

export const users = pgTable(
  "users",
  {
    // The adapter accepts a uuid primary key as long as it has a default;
    // it checks `hasDefault` and lets the database mint the id.
    id: uuid("id").primaryKey().defaultRandom(),

    // --- columns the Auth.js adapter reads and writes ---
    name: text("name"),
    email: text("email").unique(),
    emailVerified: instant("email_verified"),
    image: text("image"),

    // --- Job Centre identity (§7) ---
    /** Discord snowflake. The real identity key; `id` is only ours. */
    discordId: text("discord_id").unique(),
    /** What the site shows. Seeded from Discord, editable later. */
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    /** Seeded from the ADMIN_DISCORD_IDS allowlist; grantable in admin later. */
    isAdmin: boolean("is_admin").notNull().default(false),
    createdAt: instant("created_at").notNull().defaultNow(),
    lastSeenAt: instant("last_seen_at"),
  },
  (table) => [index("users_is_admin_idx").on(table.isAdmin)]
);

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<"oauth" | "oidc" | "email" | "webauthn">().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    // snake_case property names here are the adapter's, not a style slip:
    // it copies OAuth token fields across verbatim.
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerAccountId] }),
    index("accounts_user_id_idx").on(table.userId),
  ]
);

export const sessions = pgTable(
  "sessions",
  {
    sessionToken: text("session_token").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires: instant("expires").notNull(),
  },
  // Database sessions (§3.2) so an admin can revoke access: both lookups —
  // "this user's sessions" and the expiry sweep — want an index.
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    index("sessions_expires_idx").on(table.expires),
  ]
);

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: instant("expires").notNull(),
  },
  (table) => [primaryKey({ columns: [table.identifier, table.token] })]
);

/* ------------------------------------------------------------------ */
/* Games catalogue (§14)                                              */
/* ------------------------------------------------------------------ */

/**
 * A game or activity the community runs events for. Admin-definable, which is
 * the whole point of §13 Q4: adding "Jackbox" is a row, not a deploy.
 *
 * NOTE: §7 also lists a `games` table under Competition, meaning the individual
 * maps within a match. That one should land as `match_games` in Phase 4 — this
 * name is the catalogue.
 */
export const games = pgTable(
  "games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Stable slug used in URLs and by seeds, e.g. `rivals`. */
    key: text("key").notNull().unique(),
    name: text("name").notNull(),
    sort: integer("sort").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    /**
     * Ordered rank names, lowest first — e.g. Bronze III … One Above All.
     * Empty for games without ranks (Jackbox). A `rank` profile field renders
     * its game's ladder as a picker, so the ladder is data, not an enum.
     */
    rankLadder: json<string[]>("rank_ladder")
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [index("games_active_sort_idx").on(table.isActive, table.sort)]
);

/* ------------------------------------------------------------------ */
/* Profiles (§7, §14)                                                 */
/* ------------------------------------------------------------------ */

/**
 * Click-first by design: `text` exists as the last resort for things like an
 * in-game name that genuinely cannot be a picker. Everything else should be a
 * choice the member taps.
 */
export const profileFieldType = pgEnum("profile_field_type", [
  "select",
  "multiselect",
  /** Choose one entry from the owning game's `rankLadder`. */
  "rank",
  "bool",
  "number",
  "text",
]);

export type ProfileFieldType = (typeof profileFieldType.enumValues)[number];

/** Option list for `select` / `multiselect`. Ignored by the other types. */
export type ProfileFieldOption = { value: string; label: string };

export const profileFields = pgTable(
  "profile_fields",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * Null means a global field asked of every member regardless of game
     * (§7 called this `scope: global`). Otherwise it belongs to one game.
     */
    gameId: uuid("game_id").references(() => games.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: profileFieldType("type").notNull(),
    options: json<ProfileFieldOption[]>("options")
      .notNull()
      .default(sql`'[]'::jsonb`),
    required: boolean("required").notNull().default(false),
    sort: integer("sort").notNull().default(0),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    // nullsNotDistinct matters: without it Postgres would happily accept two
    // global fields sharing a key, because NULL != NULL.
    unique("profile_fields_game_key_uniq").on(table.gameId, table.key).nullsNotDistinct(),
    index("profile_fields_game_sort_idx").on(table.gameId, table.sort),
  ]
);

/**
 * One member's answer to one field. `value` holds the raw JSON shape the field
 * type implies: string for select/rank/text, string[] for multiselect, boolean
 * for bool, number for number.
 */
export const profileValues = pgTable(
  "profile_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fieldId: uuid("field_id")
      .notNull()
      .references(() => profileFields.id, { onDelete: "cascade" }),
    value: json<ProfileValue>("value").notNull(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("profile_values_user_field_uniq").on(table.userId, table.fieldId),
    // The profile page reads every value for one member in one go.
    index("profile_values_user_id_idx").on(table.userId),
    index("profile_values_field_id_idx").on(table.fieldId),
  ]
);

export type ProfileValue = string | string[] | number | boolean | null;

/* ------------------------------------------------------------------ */
/* Settings (§14)                                                     */
/* ------------------------------------------------------------------ */

/**
 * Single-row-per-key config store. Phase 1 needs it for the guild gate: the
 * guild id and the toggle are admin settings, not constants, so the gate can be
 * relaxed or repointed without a deploy (§3.2).
 */
/** Whatever JSON an admin setting holds. Narrow it at the read site. */
export type SettingValue = string | number | boolean | null | SettingValue[] | { [key: string]: SettingValue };

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: json<SettingValue>("value").notNull(),
  updatedAt: instant("updated_at").notNull().defaultNow(),
});

/** Setting keys Phase 1 knows about. Not a constraint — just the vocabulary. */
export const SETTING_KEYS = {
  /** boolean — is sign-in restricted to members of the guild below? */
  guildGateEnabled: "auth.guild_gate_enabled",
  /** string — the Discord guild id sign-in is gated against. */
  guildId: "auth.guild_id",
} as const;

/* ------------------------------------------------------------------ */
/* Relations — for db.query.* joins                                   */
/* ------------------------------------------------------------------ */

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
  profileValues: many(profileValues),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const gamesRelations = relations(games, ({ many }) => ({
  profileFields: many(profileFields),
}));

export const profileFieldsRelations = relations(profileFields, ({ one, many }) => ({
  game: one(games, { fields: [profileFields.gameId], references: [games.id] }),
  values: many(profileValues),
}));

export const profileValuesRelations = relations(profileValues, ({ one }) => ({
  user: one(users, { fields: [profileValues.userId], references: [users.id] }),
  field: one(profileFields, {
    fields: [profileValues.fieldId],
    references: [profileFields.id],
  }),
}));

/* ------------------------------------------------------------------ */
/* Row types                                                          */
/* ------------------------------------------------------------------ */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Game = typeof games.$inferSelect;
export type NewGame = typeof games.$inferInsert;
export type ProfileField = typeof profileFields.$inferSelect;
export type NewProfileField = typeof profileFields.$inferInsert;
export type ProfileValueRow = typeof profileValues.$inferSelect;
export type Setting = typeof settings.$inferSelect;
