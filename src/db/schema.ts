/**
 * Job Centre Events — Phase 1 and Phase 2 schema (docs/platform-plan.md §3.1,
 * §7, §8.1, §8.3, §14).
 *
 * Three groups of tables live here:
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
 *  3. Phase 2's events and applications (§7, §8.1, §8.3): events with their
 *     days and their admin-designed question set, and one application per
 *     member per event carrying answers, per-day availability and a final
 *     attendance confirmation.
 *
 * Conventions: uuid primary keys with a database-side default, `timestamptz`
 * everywhere (absolute instants — the timezone lesson from the current build),
 * and jsonb for anything shaped by admin configuration rather than by code.
 */

import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
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
/* Events (§7, §8.1, §8.3)                                            */
/* ------------------------------------------------------------------ */

/**
 * An event's lifecycle.
 *
 * Note what is *not* here: an `applications_open` flag. Whether a member can
 * apply is derived — published, inside the signup window, not yet started, and
 * with either a seat or a waitlist to join. A stored copy of that answer is a
 * copy that drifts the moment a deadline passes with nobody looking, so
 * `applicationsOpen()` in src/lib/events-policy.ts computes it instead.
 */
export const eventStatus = pgEnum("event_status", [
  /** Being written. Invisible to members. */
  "draft",
  /** Visible; applications follow the signup window. */
  "published",
  /** Running now. */
  "live",
  /** Finished; kept forever, since nothing here is destructive. */
  "complete",
  /** Called off. Applications stay for the record. */
  "cancelled",
]);

export type EventStatus = (typeof eventStatus.enumValues)[number];

/**
 * §8.1 makes an event type a *capability set*, not a code branch — so this is
 * text rather than an enum. Adding "Among Us night" is an `event_templates`
 * row, and an enum would make it a migration instead.
 */
export const EVENT_TYPES = {
  tournament: "tournament",
  casual: "casual",
  jackbox: "jackbox",
  repo: "repo",
  custom: "custom",
} as const;

export const DEFAULT_EVENT_TYPE = EVENT_TYPES.custom;

/**
 * The knobs §8.1 calls a capability set, plus the signup rules that are not
 * columns. Everything is optional and every reader must have a default: a
 * config written by an older template is a normal thing to meet.
 */
export type EventConfig = {
  /** May applicants queue once the seats are gone? Default true (§14). */
  waitlist?: boolean;
  /** How many teams the format engine should build. Null/absent: no teams. */
  teams?: number | null;
  /** Does this event run a bid draft (Phase 3)? */
  draft?: boolean;
  /** Does this event have a bracket (Phase 4)? */
  bracket?: boolean;
} & { [key: string]: SettingValue | undefined };

/** A question as a template carries it, before it becomes an `event_questions` row. */
export type EventQuestionSpec = {
  /** Derived from the label when absent. */
  key?: string;
  label: string;
  type: ProfileFieldType;
  options?: ProfileFieldOption[];
  required?: boolean;
  /**
   * Prefill from the member's profile. A template cannot hold a field *id* —
   * ids differ per deployment — so it names the profile field's key and
   * `createEvent` resolves it against the event's game (§7's whole point).
   */
  profileFieldKey?: string;
};

/**
 * A reusable starting point for an event: "Rivals tournament" with its config
 * and its usual questions already filled in (§7, §8.1).
 *
 * Templates are copied, never referenced: editing a template must not rewrite
 * the questions of an event that is already taking applications.
 */
export const eventTemplates = pgTable(
  "event_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    type: text("type").notNull().default(DEFAULT_EVENT_TYPE),
    /** Which game's profile questions and rank ladder this template assumes. */
    gameId: uuid("game_id").references(() => games.id, { onDelete: "set null" }),
    config: json<EventConfig>("config")
      .notNull()
      .default(sql`'{}'::jsonb`),
    questions: json<EventQuestionSpec[]>("questions")
      .notNull()
      .default(sql`'[]'::jsonb`),
    sort: integer("sort").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [index("event_templates_active_sort_idx").on(table.isActive, table.sort)]
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The public URL segment: /events/[slug]. */
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    type: text("type").notNull().default(DEFAULT_EVENT_TYPE),
    status: eventStatus("status").notNull().default("draft"),
    description: text("description"),
    bannerUrl: text("banner_url"),

    /** The signup window. Null at either end means "no bound that side". */
    signupOpensAt: instant("signup_opens_at"),
    signupClosesAt: instant("signup_closes_at"),
    startsAt: instant("starts_at"),
    endsAt: instant("ends_at"),

    /** Null is unlimited. Anything else is the accepted-seat count (§14). */
    capacity: integer("capacity"),

    /**
     * Which game this event is for, and therefore which rank ladder the two
     * thresholds below are read against. Null for a game-less event (Jackbox
     * has a game row, but a "movie night" need not).
     */
    gameId: uuid("game_id").references(() => games.id, { onDelete: "set null" }),
    /**
     * §8.3's two thresholds. Stored as the ladder *entry name*, exactly as a
     * `rank` profile answer is, so eligibility is a comparison of two positions
     * in `games.rank_ladder` rather than a string match. Null: no threshold.
     */
    minRankToEnter: text("min_rank_to_enter"),
    minRankToCaptain: text("min_rank_to_captain"),

    config: json<EventConfig>("config")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: instant("created_at").notNull().defaultNow(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    // The hub asks two questions: "what is on, soonest first" and "show me
    // everything with this status".
    index("events_status_starts_at_idx").on(table.status, table.startsAt),
    index("events_game_id_idx").on(table.gameId),
    check("events_capacity_positive", sql`${table.capacity} is null or ${table.capacity} > 0`),
  ]
);

/**
 * One day of an event — up to four (§10).
 *
 * `starts_at` is nullable on purpose: an admin sketching "Fri / Sat / Sun"
 * before the times are agreed is the normal way this gets filled in.
 *
 * The range check allows 0–4 rather than 0–3, and the extra slot is not a
 * fifth day. `day_index` is unique per event, so rotating four days into a new
 * order — a permutation with no free slot — cannot be written one row at a time
 * without a place to park one of them. Index 4 is that place: `setEventDays`
 * uses it only mid-transaction, and never leaves a row resting there. The
 * four-day limit itself is `MAX_EVENT_DAYS` in src/lib/events.ts. The
 * alternative was dropping the unique constraint, which trades a real guarantee
 * ("no two Day 2s") for a cosmetic one.
 */
export const eventDays = pgTable(
  "event_days",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    dayIndex: integer("day_index").notNull(),
    startsAt: instant("starts_at"),
    label: text("label"),
  },
  (table) => [
    unique("event_days_event_index_uniq").on(table.eventId, table.dayIndex),
    index("event_days_event_id_idx").on(table.eventId),
    check("event_days_index_range", sql`${table.dayIndex} between 0 and 4`),
  ]
);

/**
 * A question on one event's application form.
 *
 * Same click-first `type` enum as `profile_fields` — §2's rule does not relax
 * because the form is per-event — and the same option shape, so one validator
 * (`parseProfileValue`) covers both.
 */
export const eventQuestions = pgTable(
  "event_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    type: profileFieldType("type").notNull(),
    options: json<ProfileFieldOption[]>("options")
      .notNull()
      .default(sql`'[]'::jsonb`),
    required: boolean("required").notNull().default(false),
    sort: integer("sort").notNull().default(0),
    /**
     * The profile field this question mirrors, if any. When set, the form
     * arrives with the member's stored answer already filled in and they check
     * it rather than retype it — which is the entire reason the profile exists
     * (§2, §7). `set null` on delete: losing the link must not delete the
     * question or the answers already given to it.
     */
    profileFieldId: uuid("profile_field_id").references(() => profileFields.id, {
      onDelete: "set null",
    }),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("event_questions_event_key_uniq").on(table.eventId, table.key),
    index("event_questions_event_sort_idx").on(table.eventId, table.sort),
  ]
);

/**
 * Where an application sits. §14 settles the default as first-come with a
 * waitlist, so there is no "applied, awaiting review" state: a submission is
 * `accepted` or `waitlisted` the moment it lands, decided inside the same
 * transaction that writes it.
 */
export const applicationStatus = pgEnum("application_status", [
  "accepted",
  "waitlisted",
  /** Admin said no. */
  "declined",
  /** The member pulled out. Frees a seat, which promotes the next in line. */
  "withdrawn",
]);

export type ApplicationStatus = (typeof applicationStatus.enumValues)[number];

/** Answers keyed by `event_questions.id` — ids, not keys, so a rename is free. */
export type ApplicationAnswers = Record<string, ProfileValue>;

export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: applicationStatus("status").notNull(),
    answers: json<ApplicationAnswers>("answers")
      .notNull()
      .default(sql`'{}'::jsonb`),
    submittedAt: instant("submitted_at").notNull().defaultNow(),
    /** When an admin last changed the status. Null while it is still automatic. */
    decidedAt: instant("decided_at"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    /** 1-based and contiguous while `status = 'waitlisted'`; null otherwise. */
    waitlistPosition: integer("waitlist_position"),
    /** Admin's note about this application. */
    note: text("note"),
  },
  (table) => [
    unique("applications_event_user_uniq").on(table.eventId, table.userId),
    index("applications_event_status_idx").on(table.eventId, table.status),
    index("applications_user_id_idx").on(table.userId),
    // Submission order is the queue order (§14), so the list read wants it.
    index("applications_event_submitted_idx").on(table.eventId, table.submittedAt),
    // Two people cannot hold the same place in the queue. Renumbering only ever
    // compacts positions downwards in ascending order, so this never fires
    // mid-rewrite — and if a future change gets it wrong, it fires loudly here
    // rather than showing two "#3"s on the admin screen.
    uniqueIndex("applications_waitlist_position_uniq")
      .on(table.eventId, table.waitlistPosition)
      .where(sql`${table.status} = 'waitlisted'`),
    check(
      "applications_waitlist_position_positive",
      sql`${table.waitlistPosition} is null or ${table.waitlistPosition} > 0`
    ),
  ]
);

/** One chip per day: can you make it (§2's "tap the days you can make"). */
export const availabilityState = pgEnum("availability_state", ["yes", "maybe", "no"]);

export type AvailabilityState = (typeof availabilityState.enumValues)[number];

export const availability = pgTable(
  "availability",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    eventDayId: uuid("event_day_id")
      .notNull()
      .references(() => eventDays.id, { onDelete: "cascade" }),
    state: availabilityState("state").notNull(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("availability_application_day_uniq").on(table.applicationId, table.eventDayId),
    index("availability_application_id_idx").on(table.applicationId),
    index("availability_event_day_id_idx").on(table.eventDayId),
  ]
);

/** The "still coming?" answer, asked closer to the date (§2). */
export const confirmationState = pgEnum("confirmation_state", ["in", "out"]);

export type ConfirmationState = (typeof confirmationState.enumValues)[number];

export const confirmations = pgTable(
  "confirmations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    applicationId: uuid("application_id")
      .notNull()
      .unique()
      .references(() => applications.id, { onDelete: "cascade" }),
    state: confirmationState("state").notNull(),
    confirmedAt: instant("confirmed_at").notNull().defaultNow(),
  }
);

/* ------------------------------------------------------------------ */
/* Relations — for db.query.* joins                                   */
/* ------------------------------------------------------------------ */

export const usersRelations = relations(users, ({ many }) => ({
  accounts: many(accounts),
  sessions: many(sessions),
  profileValues: many(profileValues),
  applications: many(applications),
}));

export const accountsRelations = relations(accounts, ({ one }) => ({
  user: one(users, { fields: [accounts.userId], references: [users.id] }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const gamesRelations = relations(games, ({ many }) => ({
  profileFields: many(profileFields),
  events: many(events),
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

export const eventsRelations = relations(events, ({ one, many }) => ({
  game: one(games, { fields: [events.gameId], references: [games.id] }),
  creator: one(users, { fields: [events.createdBy], references: [users.id] }),
  days: many(eventDays),
  questions: many(eventQuestions),
  applications: many(applications),
}));

export const eventDaysRelations = relations(eventDays, ({ one, many }) => ({
  event: one(events, { fields: [eventDays.eventId], references: [events.id] }),
  availability: many(availability),
}));

export const eventQuestionsRelations = relations(eventQuestions, ({ one }) => ({
  event: one(events, { fields: [eventQuestions.eventId], references: [events.id] }),
  profileField: one(profileFields, {
    fields: [eventQuestions.profileFieldId],
    references: [profileFields.id],
  }),
}));

export const applicationsRelations = relations(applications, ({ one, many }) => ({
  event: one(events, { fields: [applications.eventId], references: [events.id] }),
  user: one(users, { fields: [applications.userId], references: [users.id] }),
  decider: one(users, { fields: [applications.decidedBy], references: [users.id] }),
  availability: many(availability),
  confirmation: one(confirmations),
}));

export const availabilityRelations = relations(availability, ({ one }) => ({
  application: one(applications, {
    fields: [availability.applicationId],
    references: [applications.id],
  }),
  day: one(eventDays, { fields: [availability.eventDayId], references: [eventDays.id] }),
}));

export const confirmationsRelations = relations(confirmations, ({ one }) => ({
  application: one(applications, {
    fields: [confirmations.applicationId],
    references: [applications.id],
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
export type EventTemplate = typeof eventTemplates.$inferSelect;
export type NewEventTemplate = typeof eventTemplates.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type EventDay = typeof eventDays.$inferSelect;
export type NewEventDay = typeof eventDays.$inferInsert;
export type EventQuestion = typeof eventQuestions.$inferSelect;
export type NewEventQuestion = typeof eventQuestions.$inferInsert;
export type Application = typeof applications.$inferSelect;
export type NewApplication = typeof applications.$inferInsert;
export type AvailabilityRow = typeof availability.$inferSelect;
export type Confirmation = typeof confirmations.$inferSelect;
