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
  type AnyPgColumn,
  boolean,
  check,
  customType,
  foreignKey,
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
    /**
     * The public profile's URL segment — `/players/[handle]` (§4).
     *
     * Derived from the Discord username once and then **never recomputed**: a
     * handle that followed a rename would break every link that has ever been
     * posted, which is precisely the property a permanent record must not have.
     * Nullable because the Auth.js adapter inserts a `users` row itself and
     * knows nothing about this column, so `ensureHandles` fills it in the first
     * time anything needs one. Unique, which is what "stable and unique" costs:
     * two members called `beko` cannot both hold `/players/beko`.
     */
    handle: text("handle").unique(),
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
  /**
   * object — which Discord announcements are switched on (Phase 5, §14).
   *
   * One row holding a flag per announcement kind rather than a row per kind:
   * the screen writes all five together and every reader wants all five, so a
   * single key is one read and one write instead of five of each.
   * `announcementSettingsFrom` in src/lib/announce.ts supplies the defaults for
   * anything the stored object does not mention, which is what lets a new kind
   * ship without a migration.
   */
  announcements: "discord.announcements",
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
/* Teams and the draft (§7, §9, §14)                                  */
/* ------------------------------------------------------------------ */

/**
 * A team in one event.
 *
 * Note what §7's sketch had and this does not: `balance_left`. A stored
 * remaining balance is a second copy of "start, minus everything you have won",
 * and the moment an award is voided or a price corrected the two disagree —
 * with the stored one winning, because it is the one the bid check reads. So
 * the balance is derived from the awarded lots every time (`balanceFor` in
 * src/lib/draft-policy.ts), for exactly the reason there is no
 * `applications_open` column on `events`.
 *
 * `(id, event_id)` is unique for no reason of its own: it is the target of the
 * composite foreign key on `team_members` below, which is what lets Postgres —
 * not just the application code — guarantee that nobody is on two teams in the
 * same event.
 */
export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * The captain. Nullable because an admin names the teams before they choose
     * who leads them, and `set null` because deleting a member must not delete
     * a team that has already drafted a roster.
     */
    captainUserId: uuid("captain_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Bracket seeding (Phase 4). Null while it is undecided. */
    seed: integer("seed"),
    /** What this team had to spend before the draft started. */
    balanceStart: integer("balance_start").notNull().default(0),
    sort: integer("sort").notNull().default(0),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("teams_event_name_uniq").on(table.eventId, table.name),
    // Nulls are distinct by default, so any number of teams may sit without a
    // captain — but one person cannot lead two teams in the same event.
    unique("teams_event_captain_uniq").on(table.eventId, table.captainUserId),
    unique("teams_id_event_uniq").on(table.id, table.eventId),
    index("teams_event_sort_idx").on(table.eventId, table.sort),
    check("teams_balance_start_positive", sql`${table.balanceStart} >= 0`),
  ]
);

/**
 * One player on one roster.
 *
 * §14 settles that **a captain occupies a roster slot**: they are a row here
 * with `is_captain = true` and `price = 0`, and they never enter the draft
 * pool. Roster-size limits and the "keep enough to fill your roster" rule
 * therefore count them without a special case anywhere.
 *
 * `event_id` is redundant with `teams.event_id` and is here on purpose: paired
 * with the composite foreign key it is provably the team's event, and it makes
 * `(event_id, user_id)` unique enforceable — the one invariant a race could
 * otherwise break, two admins awarding the same player to two teams at once.
 */
export const teamMembers = pgTable(
  "team_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    teamId: uuid("team_id").notNull(),
    /** Always equal to the team's event; the composite key below proves it. */
    eventId: uuid("event_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** What they cost. Zero for a captain, who was never bid for. */
    price: integer("price").notNull().default(0),
    acquiredAt: instant("acquired_at").notNull().defaultNow(),
    isCaptain: boolean("is_captain").notNull().default(false),
    /** The lot that produced this row; null for a captain. */
    lotId: uuid("lot_id").references((): AnyPgColumn => draftLots.id, { onDelete: "set null" }),
  },
  (table) => [
    foreignKey({
      columns: [table.teamId, table.eventId],
      foreignColumns: [teams.id, teams.eventId],
      name: "team_members_team_event_fk",
    }).onDelete("cascade"),
    unique("team_members_team_user_uniq").on(table.teamId, table.userId),
    unique("team_members_event_user_uniq").on(table.eventId, table.userId),
    index("team_members_team_id_idx").on(table.teamId),
    index("team_members_user_id_idx").on(table.userId),
    check("team_members_price_positive", sql`${table.price} >= 0`),
    // A captain is never bought, so a non-zero captain price is a bug, not a
    // handicap. §14 is explicit that they cost nothing and fill a slot.
    check(
      "team_members_captain_is_free",
      sql`${table.isCaptain} = false or ${table.price} = 0`
    ),
  ]
);

/** The two wheels. `main` is the draft proper; `reserve` is the second pass. */
export const draftPoolKind = pgEnum("draft_pool_kind", ["main", "reserve"]);

export type DraftPoolKind = (typeof draftPoolKind.enumValues)[number];

/**
 * A player waiting to be drafted.
 *
 * §7 sketched this as a `draft_pools` row holding an ordered `user_ids` array.
 * Rows instead, one per player: moving somebody to the reserve pool is then an
 * update of one column rather than a rewrite of two arrays that can disagree
 * about who is where, and "is this player still in the pool" is an index lookup
 * rather than a scan of a blob.
 *
 * Unique on (event, user), so a player is in exactly one pool at a time — the
 * invariant the array model could not state at all.
 */
export const draftPoolEntries = pgTable(
  "draft_pool_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: draftPoolKind("kind").notNull().default("main"),
    sort: integer("sort").notNull().default(0),
    addedAt: instant("added_at").notNull().defaultNow(),
  },
  (table) => [
    unique("draft_pool_entries_event_user_uniq").on(table.eventId, table.userId),
    index("draft_pool_entries_event_kind_sort_idx").on(table.eventId, table.kind, table.sort),
  ]
);

/**
 * How a lot ended.
 *
 * `voided` is the undo, and it is a status rather than a delete because
 * checklist.md's standing rule is that nothing is destructive: an undone award
 * keeps its winner and its price so the history can say what was undone, and
 * every derived figure — balances above all — simply ignores it.
 */
export const draftLotStatus = pgEnum("draft_lot_status", [
  /** On the block now. At most one per event. */
  "open",
  "awarded",
  /** Nobody wanted them, or the admin pulled them. Out of the draft. */
  "discarded",
  /** Sent to the reserve pool to come round again later. */
  "reserved",
  /** Undone. Kept for the record; counts for nothing. */
  "voided",
]);

export type DraftLotStatus = (typeof draftLotStatus.enumValues)[number];

/**
 * Everything a viewer needs to animate the same spin as everybody else.
 *
 * The pool snapshot, the landing index, the start instant and the duration are
 * jointly deterministic: two browsers opening the page mid-spin compute the
 * identical wheel angle, and one opening it afterwards can replay it. Stored as
 * one jsonb blob because it is written once, read whole, and never queried by
 * field — the opposite of the pool, which is why that one is rows.
 */
export type DraftSpin = {
  /** The pool exactly as it stood, in order — user ids. */
  pool: string[];
  /** Index into `pool` the wheel lands on. */
  targetIndex: number;
  /** Epoch milliseconds. Absolute, like every other instant here. */
  startedAt: number;
  durationMs: number;
  turns: number;
};

export const draftLots = pgTable(
  "draft_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    playerUserId: uuid("player_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: draftLotStatus("status").notNull().default("open"),
    /** Which pool they were pulled from, so an undo puts them back in it. */
    fromKind: draftPoolKind("from_kind").notNull().default("main"),

    openedAt: instant("opened_at").notNull().defaultNow(),
    openedBy: uuid("opened_by").references(() => users.id, { onDelete: "set null" }),
    /** When the lot stopped taking bids — award, discard or reserve. */
    closedAt: instant("closed_at"),
    closedBy: uuid("closed_by").references(() => users.id, { onDelete: "set null" }),

    winnerTeamId: uuid("winner_team_id"),
    price: integer("price"),

    /** Null when the admin picked the player rather than spinning for them. */
    spin: json<DraftSpin | null>("spin"),

    /** The undo trace. The award columns above are left exactly as they were. */
    voidedAt: instant("voided_at"),
    voidedBy: uuid("voided_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => [
    // The winning team must belong to the same event as the lot. Nullable
    // winner plus MATCH SIMPLE means an unawarded lot is not checked at all.
    //
    // Deliberately no `on delete` action. `set null` would fight the
    // `award_complete` check below — an awarded lot with its winner blanked is
    // a state the check forbids — and `cascade` would delete the price along
    // with the team, which checklist.md rules out. So deleting a team that has
    // won lots is simply refused, which is the same answer `setTeams` gives;
    // deleting the whole event still works, because the lots go with it in the
    // same statement.
    foreignKey({
      columns: [table.winnerTeamId, table.eventId],
      foreignColumns: [teams.id, teams.eventId],
      name: "draft_lots_winner_event_fk",
    }),
    index("draft_lots_event_opened_idx").on(table.eventId, table.openedAt),
    index("draft_lots_event_status_idx").on(table.eventId, table.status),
    index("draft_lots_player_idx").on(table.playerUserId),
    // One player on the block at a time, per event. The admin screen refuses a
    // second spin, but two admins clicking at once is a race the screen cannot
    // see and this index can.
    uniqueIndex("draft_lots_one_open_per_event")
      .on(table.eventId)
      .where(sql`status = 'open'`),
    check("draft_lots_price_positive", sql`${table.price} is null or ${table.price} >= 0`),
    // An award without a winner or without a price is not an award. This is the
    // constraint that makes "balance derived from awarded lots" total: every
    // row the sum touches has a number in it.
    check(
      "draft_lots_award_complete",
      sql`${table.status} <> 'awarded' or (${table.winnerTeamId} is not null and ${table.price} is not null)`
    ),
    check(
      "draft_lots_voided_stamped",
      sql`(${table.status} = 'voided') = (${table.voidedAt} is not null)`
    ),
  ]
);

/**
 * One team's bid on one lot.
 *
 * Unique on (lot, team) as §7 asks, which is what makes a sealed bid final and
 * a double-clicked submit harmless. Open bidding raises the *same* row rather
 * than adding another, so the constraint holds either way and "what did they
 * bid" never needs a max over a history.
 */
export const draftBids = pgTable(
  "draft_bids",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => draftLots.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    amount: integer("amount").notNull(),
    placedAt: instant("placed_at").notNull().defaultNow(),
  },
  (table) => [
    unique("draft_bids_lot_team_uniq").on(table.lotId, table.teamId),
    index("draft_bids_lot_id_idx").on(table.lotId),
    check("draft_bids_amount_positive", sql`${table.amount} >= 0`),
  ]
);

/** Uniform balances, or one per team so an admin can handicap (§9). */
export const draftBalanceMode = pgEnum("draft_balance_mode", ["uniform", "per_team"]);

export type DraftBalanceMode = (typeof draftBalanceMode.enumValues)[number];

/** Sealed (today's behaviour) or open with a minimum increment (§9). */
export const draftBiddingMode = pgEnum("draft_bidding_mode", ["sealed", "open"]);

export type DraftBiddingMode = (typeof draftBiddingMode.enumValues)[number];

/** How the next player is chosen (§9). */
export const draftSelectionMode = pgEnum("draft_selection_mode", [
  "wheel",
  "admin_pick",
  "fixed_order",
]);

export type DraftSelectionMode = (typeof draftSelectionMode.enumValues)[number];

/**
 * Who sees a bid amount, and when (§9's last bullet).
 *
 * A settled lot's *winning* amount is public under every setting — a draft
 * whose prices are secret afterwards is not a draft anyone would run — so this
 * only governs what is visible while a lot is still open.
 */
export const draftBidVisibility = pgEnum("draft_bid_visibility", [
  /** Today's behaviour: admin sees all, a captain sees their own, nobody else. */
  "admin_only",
  /** Every captain sees every amount live. What open bidding requires. */
  "captains",
  /** The room sees them live too. */
  "everyone",
]);

export type DraftBidVisibility = (typeof draftBidVisibility.enumValues)[number];

/**
 * One event's draft rules.
 *
 * ## Why this is a table and not `events.config`
 *
 * `events.config` is the right home for the capability flags §8.1 describes —
 * `teams`, `draft`, `bracket` — which are a handful of booleans read by page
 * code deciding which tabs exist. The draft rules are a different animal, and
 * three things settle it:
 *
 *  1. **`updateEvent` merges `config` one level deep** (`{...current, ...patch}`).
 *     A nested `draft: {…}` object would be *replaced* by any partial patch, so
 *     an admin saving the Basics tab with a stale form would silently reset the
 *     roster size. Losing a bidding rule to a shallow merge is the kind of bug
 *     that is invisible until the money is wrong.
 *  2. **These values are read on the hot path.** `canPlaceBid` consults the
 *     roster target, the minimum increment and the must-fill rule on every bid;
 *     they deserve typed columns with check constraints, not a jsonb reach that
 *     every caller has to re-validate because a config written last month might
 *     hold anything.
 *  3. **Postgres can state the invariants.** `roster_target > 0`, a non-negative
 *     default balance, an increment of at least one — a jsonb blob can hold
 *     nonsense and nothing notices until a division by zero.
 *
 * The cost is one table and one join, and neither is felt: it is one row per
 * event, read once per draft screen. Absent, every reader falls back to
 * `DEFAULT_DRAFT_CONFIG` in src/lib/draft-policy.ts, so an event that has never
 * opened the Draft tab still has complete, sane rules.
 */
export const draftConfigs = pgTable(
  "draft_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .unique()
      .references(() => events.id, { onDelete: "cascade" }),

    /** Uniform balances, or per team (§9's handicapping). */
    balanceMode: draftBalanceMode("balance_mode").notNull().default("uniform"),
    /** What a team starts with under `uniform`, and the default under `per_team`. */
    defaultBalance: integer("default_balance").notNull().default(1000),

    biddingMode: draftBiddingMode("bidding_mode").notNull().default("sealed"),
    /** The floor for any bid. Zero — today's behaviour — means free is a bid. */
    minBid: integer("min_bid").notNull().default(0),
    /** Open bidding only: how far above the standing bid a raise must go. */
    minIncrement: integer("min_increment").notNull().default(1),
    /** Null is no timer, which is how the draft runs today. */
    bidTimerSeconds: integer("bid_timer_seconds"),

    selectionMode: draftSelectionMode("selection_mode").notNull().default("wheel"),

    reserveEnabled: boolean("reserve_enabled").notNull().default(true),
    /**
     * How many times a reserve player may come back round. Null is unlimited.
     * §9 asks for the number without saying what it counts; see the note in
     * src/lib/draft-policy.ts.
     */
    reserveRounds: integer("reserve_rounds"),

    /** Roster size including the captain (§14). */
    rosterTarget: integer("roster_target").notNull().default(6),
    /** §9's blind-bid protection. */
    mustFillRoster: boolean("must_fill_roster").notNull().default(true),

    bidVisibility: draftBidVisibility("bid_visibility").notNull().default("admin_only"),

    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check("draft_configs_balance_positive", sql`${table.defaultBalance} >= 0`),
    check("draft_configs_min_bid_positive", sql`${table.minBid} >= 0`),
    check("draft_configs_increment_positive", sql`${table.minIncrement} >= 1`),
    check("draft_configs_roster_target_positive", sql`${table.rosterTarget} >= 1`),
    check(
      "draft_configs_timer_positive",
      sql`${table.bidTimerSeconds} is null or ${table.bidTimerSeconds} > 0`
    ),
    check(
      "draft_configs_reserve_rounds_positive",
      sql`${table.reserveRounds} is null or ${table.reserveRounds} >= 1`
    ),
  ]
);

/* ------------------------------------------------------------------ */
/* Competition — the format engine (§7, §8.2, §10)                    */
/* ------------------------------------------------------------------ */

/**
 * What shape a stage is. §7 lists four; `group_playoff` is the fifth §8.2 asks
 * for, and it is one stage rather than two because its bracket's sources point
 * *into* its own group tables (`group:a:rank:2`) — splitting it would put a
 * source reference across a stage boundary for no gain.
 */
export const stageKind = pgEnum("stage_kind", [
  "round_robin",
  "single_elim",
  "double_elim",
  /** Round 1 is generated; later rounds are paired from the table as it fills. */
  "swiss",
  "group_playoff",
]);

export type StageKindValue = (typeof stageKind.enumValues)[number];

/**
 * A stage's rules as stored. The shape is `StageConfig` in
 * src/lib/format-policy.ts, which is also the only thing that reads it —
 * `normaliseStageConfig` fills every gap, so a config written by an older
 * admin screen is a normal thing to meet, exactly as with `events.config`.
 *
 * jsonb rather than columns, unlike `draft_configs`: nothing here is on a hot
 * path, half of it is a map keyed by round or by slot (which columns cannot
 * express at all), and the format tab saves the whole object at once so the
 * shallow-merge hazard that settled the draft's case does not arise.
 */
export type StageConfigJson = Record<string, unknown>;

/**
 * One phase of an event's competition: a group stage, a bracket, or both.
 *
 * `(id, event_id)` is unique for the same reason `teams`' pair is: it is the
 * target of the composite foreign key on `matches`, which is what lets Postgres
 * — not just the application code — guarantee that a match, its stage and its
 * two teams all belong to the same event.
 */
export const stages = pgTable(
  "stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    /** What the tabs call it: "Group stage", "Playoffs". */
    name: text("name"),
    kind: stageKind("kind").notNull(),
    sort: integer("sort").notNull().default(0),
    config: json<StageConfigJson>("config")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("stages_id_event_uniq").on(table.id, table.eventId),
    index("stages_event_sort_idx").on(table.eventId, table.sort),
  ]
);

/**
 * One match. The row holds what actually happened; everything else about it —
 * its label, its stakes note, which round it belongs to on the board — is
 * regenerated from the stage's kind, team count and config, because that
 * generation is deterministic and a stored copy is a copy that goes stale.
 *
 * ## `source_a` / `source_b` are the point of the table
 *
 * A slot says *where* its teams come from, not who they are: `seed:1`,
 * `winner:ubsf1`, `loser:ubf`, `group:a:rank:2`. Correcting a score from three
 * days ago re-propagates the whole bracket on the next read, because there is
 * nothing downstream to be stale (§1.1, §8.5). `team_a_id` is filled in anyway
 * for a table game, where the pairing is known from the start and there is
 * nothing to resolve.
 *
 * ## `event_id` is redundant, and deliberate
 *
 * It is always the stage's event — the composite key below proves it — and it
 * is what makes the team references checkable: a match cannot name a team from
 * a different event, which is the one mistake a stale admin form could
 * otherwise make silently. Deleting a team that has played is simply refused
 * (no `on delete` action), for the same reason `draft_lots` refuses it: `set
 * null` cannot null one column of a composite key, and cascading would erase a
 * completed result, which checklist.md rules out. Deleting the event still
 * works, since everything goes in the same statement.
 */
export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stageId: uuid("stage_id").notNull(),
    /**
     * Always equal to the stage's event; the composite key below proves it.
     *
     * The plain cascade here is doing real work as well as documenting intent:
     * without it, deleting an event cascades to `teams` and to `stages`, and
     * the team references below — which are deliberately `no action` — can fire
     * before the stage cascade has taken the matches away. With it, the matches
     * go in the same statement and nothing is ever momentarily orphaned. This
     * is the same pairing `draft_lots` uses.
     */
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    /** Unique within the stage: `rr-1-2`, `ubsf1`, `lbf`, `gf`. */
    slot: text("slot").notNull(),
    /** Round within this match's own half of the stage. */
    round: integer("round").notNull().default(1),
    /** Dependency depth. Everything sharing a phase can be played at once. */
    phase: integer("phase").notNull().default(1),
    bestOf: integer("best_of").notNull().default(1),

    teamAId: uuid("team_a_id"),
    teamBId: uuid("team_b_id"),
    sourceA: text("source_a"),
    sourceB: text("source_b"),

    /** An absolute instant. Rendered in each viewer's own zone. */
    scheduledAt: instant("scheduled_at"),
    /** When it actually finished — stamped the moment it becomes decided. */
    finishedAt: instant("finished_at"),
    durationMin: integer("duration_min"),
    /** Set by the admin when the games alone do not settle it (a drawn decider). */
    winnerOverrideId: uuid("winner_override_id"),

    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.stageId, table.eventId],
      foreignColumns: [stages.id, stages.eventId],
      name: "matches_stage_event_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamAId, table.eventId],
      foreignColumns: [teams.id, teams.eventId],
      name: "matches_team_a_event_fk",
    }),
    foreignKey({
      columns: [table.teamBId, table.eventId],
      foreignColumns: [teams.id, teams.eventId],
      name: "matches_team_b_event_fk",
    }),
    foreignKey({
      columns: [table.winnerOverrideId, table.eventId],
      foreignColumns: [teams.id, teams.eventId],
      name: "matches_winner_override_event_fk",
    }),
    unique("matches_stage_slot_uniq").on(table.stageId, table.slot),
    index("matches_stage_phase_idx").on(table.stageId, table.phase),
    // The schedule reads "what is on, soonest first" across a whole event.
    index("matches_event_scheduled_idx").on(table.eventId, table.scheduledAt),
    // An even series cannot be won without a tiebreak nobody asked for.
    check("matches_best_of_odd", sql`${table.bestOf} >= 1 and ${table.bestOf} % 2 = 1`),
    check("matches_round_positive", sql`${table.round} >= 1`),
    check("matches_phase_positive", sql`${table.phase} >= 1`),
    check(
      "matches_duration_positive",
      sql`${table.durationMin} is null or ${table.durationMin} > 0`
    ),
    // A team cannot play itself. Both null is the normal unresolved state.
    check(
      "matches_distinct_teams",
      sql`${table.teamAId} is null or ${table.teamBId} is null or ${table.teamAId} <> ${table.teamBId}`
    ),
  ]
);

/**
 * One map of one series.
 *
 * `mode` is text rather than an enum on purpose: the modes belong to the game
 * (`games` catalogue), so adding "Escort" must be a row somewhere, never a
 * migration — the same rule that keeps `events.type` text.
 *
 * The table is `match_games` and not `games` because `games` above is the admin
 * catalogue; §7's sketch used the same name for both.
 */
export const matchGames = pgTable(
  "match_games",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    /** Position in the series, from 0. */
    index: integer("index").notNull(),
    mode: text("mode").notNull().default(""),
    map: text("map").notNull().default(""),
    referee: text("referee").notNull().default(""),
    scoreA: integer("score_a").notNull().default(0),
    scoreB: integer("score_b").notNull().default(0),
    /**
     * Ticked off by the admin. A score typed in but not ticked counts for
     * nothing anywhere — which is what lets an admin fill a card in advance.
     */
    played: boolean("played").notNull().default(false),
  },
  (table) => [
    unique("match_games_match_index_uniq").on(table.matchId, table.index),
    index("match_games_match_id_idx").on(table.matchId),
    check("match_games_index_positive", sql`${table.index} >= 0`),
    check(
      "match_games_scores_positive",
      sql`${table.scoreA} >= 0 and ${table.scoreB} >= 0`
    ),
  ]
);

/* ------------------------------------------------------------------ */
/* Audit log (Phase 5)                                                */
/* ------------------------------------------------------------------ */

/**
 * Who did what, and when.
 *
 * Append-only by construction: there is no update path and no delete path
 * anywhere in the codebase, which is the whole point of a log. It is written by
 * `recordAudit` in src/lib/audit.ts, and **only ever from the action layer** —
 * the actions are the trust boundary and the only place that knows who is
 * acting, whereas `src/lib/events.ts` and friends take a `Database` and are
 * called by tests, seeds and each other.
 *
 * ## Why the actor's name is copied onto the row
 *
 * `actor_user_id` is a real foreign key so the log can link to a profile, but
 * it is `set null` on delete and the *name* is a snapshot. A log that reads
 * "somebody accepted 14 applications" the day an account is removed is not a
 * log. The same argument makes `summary` a stored sentence rather than
 * something rebuilt on read from ids that may since have changed meaning.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    at: instant("at").notNull().defaultNow(),
    /** Null for anything the system did to itself — a failed announcement. */
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** What the actor was called at the time. Never rewritten. */
    actorName: text("actor_name"),
    /** One of `AUDIT_ACTIONS` in src/lib/audit.ts. Text, so a new one is not a migration. */
    action: text("action").notNull(),
    /** The event this happened inside, when there is one. `/admin/audit` filters on it. */
    eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }),
    /** What was acted on — an application id, a lot id, a match slot. Free-form. */
    subject: text("subject"),
    /** The line the log shows, written when it happened. */
    summary: text("summary").notNull(),
    /** Anything worth keeping that is not in the sentence — before and after values. */
    detail: json<Record<string, SettingValue>>("detail")
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (table) => [
    // The log is read newest-first, and newest-first filtered to one event.
    index("audit_log_at_idx").on(table.at),
    index("audit_log_event_at_idx").on(table.eventId, table.at),
  ]
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

export const teamsRelations = relations(teams, ({ one, many }) => ({
  event: one(events, { fields: [teams.eventId], references: [events.id] }),
  captain: one(users, { fields: [teams.captainUserId], references: [users.id] }),
  members: many(teamMembers),
  bids: many(draftBids),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  team: one(teams, { fields: [teamMembers.teamId], references: [teams.id] }),
  user: one(users, { fields: [teamMembers.userId], references: [users.id] }),
}));

export const draftPoolEntriesRelations = relations(draftPoolEntries, ({ one }) => ({
  event: one(events, { fields: [draftPoolEntries.eventId], references: [events.id] }),
  user: one(users, { fields: [draftPoolEntries.userId], references: [users.id] }),
}));

export const draftLotsRelations = relations(draftLots, ({ one, many }) => ({
  event: one(events, { fields: [draftLots.eventId], references: [events.id] }),
  player: one(users, { fields: [draftLots.playerUserId], references: [users.id] }),
  winner: one(teams, { fields: [draftLots.winnerTeamId], references: [teams.id] }),
  bids: many(draftBids),
}));

export const draftBidsRelations = relations(draftBids, ({ one }) => ({
  lot: one(draftLots, { fields: [draftBids.lotId], references: [draftLots.id] }),
  team: one(teams, { fields: [draftBids.teamId], references: [teams.id] }),
}));

export const draftConfigsRelations = relations(draftConfigs, ({ one }) => ({
  event: one(events, { fields: [draftConfigs.eventId], references: [events.id] }),
}));

export const stagesRelations = relations(stages, ({ one, many }) => ({
  event: one(events, { fields: [stages.eventId], references: [events.id] }),
  matches: many(matches),
}));

export const matchesRelations = relations(matches, ({ one, many }) => ({
  stage: one(stages, { fields: [matches.stageId], references: [stages.id] }),
  event: one(events, { fields: [matches.eventId], references: [events.id] }),
  teamA: one(teams, { fields: [matches.teamAId], references: [teams.id] }),
  teamB: one(teams, { fields: [matches.teamBId], references: [teams.id] }),
  games: many(matchGames),
}));

export const matchGamesRelations = relations(matchGames, ({ one }) => ({
  match: one(matches, { fields: [matchGames.matchId], references: [matches.id] }),
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
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
export type DraftPoolEntry = typeof draftPoolEntries.$inferSelect;
export type NewDraftPoolEntry = typeof draftPoolEntries.$inferInsert;
export type DraftLot = typeof draftLots.$inferSelect;
export type NewDraftLot = typeof draftLots.$inferInsert;
export type DraftBid = typeof draftBids.$inferSelect;
export type NewDraftBid = typeof draftBids.$inferInsert;
export type DraftConfigRow = typeof draftConfigs.$inferSelect;
export type NewDraftConfigRow = typeof draftConfigs.$inferInsert;
export type Stage = typeof stages.$inferSelect;
export type NewStage = typeof stages.$inferInsert;
export type MatchRow = typeof matches.$inferSelect;
export type NewMatchRow = typeof matches.$inferInsert;
export type MatchGameRow = typeof matchGames.$inferSelect;
export type NewMatchGameRow = typeof matchGames.$inferInsert;
export type AuditRow = typeof auditLog.$inferSelect;
export type NewAuditRow = typeof auditLog.$inferInsert;
