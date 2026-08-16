/**
 * Idempotent seed for the Phase 1 tables.
 *
 * It creates the starting games catalogue and the profile fields that used to
 * live in a Google Form, plus the guild-gate settings rows. Running it twice
 * changes nothing the second time.
 *
 * Rows are inserted only when missing — never overwritten. The seed's job is to
 * make a fresh database usable; once a row exists the admin UI owns it, so a
 * re-run must not stomp on an edited label or a reordered ladder. Changing what
 * an *existing* deployment holds is a migration or an admin action, not this.
 *
 * `npm run db:seed`
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray } from "drizzle-orm";
import {
  type Database,
  type NewProfileField,
  SETTING_KEYS,
  type SettingValue,
  db as defaultDb,
  games,
  profileFields,
  settings,
  users,
} from "./index";

/* ------------------------------------------------------------------ */
/* Reference data                                                     */
/* ------------------------------------------------------------------ */

/**
 * Marvel Rivals competitive ladder, lowest first. Order is the whole point:
 * a `rank` profile field renders this list, and "is A above B" is an index
 * comparison rather than a lookup table.
 */
export const RIVALS_RANK_LADDER = [
  "Bronze III",
  "Bronze II",
  "Bronze I",
  "Silver III",
  "Silver II",
  "Silver I",
  "Gold III",
  "Gold II",
  "Gold I",
  "Platinum III",
  "Platinum II",
  "Platinum I",
  "Diamond III",
  "Diamond II",
  "Diamond I",
  "Grandmaster III",
  "Grandmaster II",
  "Grandmaster I",
  "Celestial III",
  "Celestial II",
  "Celestial I",
  "Eternity",
  "One Above All",
] as const;

export const RIVALS_ROLES = ["Vanguard", "Duelist", "Strategist"] as const;

const JACKBOX_PACKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({
  value: `pack-${n}`,
  label: `Party Pack ${n}`,
}));

/** Games the platform starts with. Admins add more from the UI. */
const SEED_GAMES = [
  {
    key: "rivals",
    name: "Marvel Rivals",
    sort: 0,
    isActive: true,
    rankLadder: [...RIVALS_RANK_LADDER],
  },
  {
    // No ladder at all — proves the shape generalises past ranked shooters.
    key: "jackbox",
    name: "Jackbox",
    sort: 10,
    isActive: true,
    rankLadder: [],
  },
] as const;

/** Fields with no game are asked of every member (§7's `global` scope). */
const GLOBAL_FIELDS: Array<Omit<NewProfileField, "gameId">> = [
  {
    key: "voice",
    label: "Happy to use voice chat",
    type: "bool",
    required: true,
    sort: 0,
  },
];

const FIELDS_BY_GAME: Record<string, Array<Omit<NewProfileField, "gameId">>> = {
  rivals: [
    {
      // The one unavoidable free-text field: we cannot enumerate usernames.
      key: "ign",
      label: "In-game name",
      type: "text",
      required: true,
      sort: 0,
    },
    {
      // Options stay empty — a `rank` field reads its game's rankLadder.
      key: "rank",
      label: "Current competitive rank",
      type: "rank",
      required: true,
      sort: 1,
    },
    {
      key: "roles",
      label: "Preferred roles",
      type: "multiselect",
      options: RIVALS_ROLES.map((role) => ({ value: role.toLowerCase(), label: role })),
      required: true,
      sort: 2,
    },
  ],
  jackbox: [
    {
      key: "packs",
      label: "Packs you own",
      type: "multiselect",
      options: JACKBOX_PACKS,
      required: false,
      sort: 0,
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Seed                                                               */
/* ------------------------------------------------------------------ */

export type SeedSummary = {
  gamesInserted: number;
  fieldsInserted: number;
  settingsInserted: number;
  adminsPromoted: number;
  /** Allowlisted ids with no user row yet — they get the flag on first login. */
  adminsPending: string[];
};

/** Comma-separated allowlist from the environment, cleaned up. */
export function parseAdminDiscordIds(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
}

/** Only the two variables the seed actually reads. */
export type SeedEnv = {
  DISCORD_GUILD_ID?: string;
  ADMIN_DISCORD_IDS?: string;
};

export async function seed(
  database: Database = defaultDb,
  // `process.env` is a broad string map; SeedEnv narrows it to what is read.
  env: SeedEnv = process.env as SeedEnv
): Promise<SeedSummary> {
  const summary: SeedSummary = {
    gamesInserted: 0,
    fieldsInserted: 0,
    settingsInserted: 0,
    adminsPromoted: 0,
    adminsPending: [],
  };

  // --- games -------------------------------------------------------
  for (const game of SEED_GAMES) {
    const inserted = await database
      .insert(games)
      .values({ ...game, rankLadder: [...game.rankLadder] })
      .onConflictDoNothing()
      .returning({ id: games.id });
    summary.gamesInserted += inserted.length;
  }

  // --- profile fields ----------------------------------------------
  for (const field of GLOBAL_FIELDS) {
    summary.fieldsInserted += await insertField(database, null, field);
  }

  for (const [gameKey, fields] of Object.entries(FIELDS_BY_GAME)) {
    const [game] = await database
      .select({ id: games.id })
      .from(games)
      .where(eq(games.key, gameKey))
      .limit(1);
    if (!game) continue;
    for (const field of fields) {
      summary.fieldsInserted += await insertField(database, game.id, field);
    }
  }

  // --- settings ----------------------------------------------------
  // Guild-gated sign-in is on by default (§13 Q1). The guild id comes from the
  // environment on a fresh install and is editable in admin from then on.
  const settingRows: Array<{ key: string; value: SettingValue }> = [
    { key: SETTING_KEYS.guildGateEnabled, value: true },
    { key: SETTING_KEYS.guildId, value: env.DISCORD_GUILD_ID ?? "" },
  ];
  for (const row of settingRows) {
    const inserted = await database
      .insert(settings)
      .values(row)
      .onConflictDoNothing()
      .returning({ key: settings.key });
    summary.settingsInserted += inserted.length;
  }

  // --- admin allowlist ---------------------------------------------
  // Only promotes users who already exist; someone on the list who has never
  // signed in has no row yet, and picks the flag up when Auth.js creates one.
  const adminIds = parseAdminDiscordIds(env.ADMIN_DISCORD_IDS);
  if (adminIds.length > 0) {
    const promoted = await database
      .update(users)
      .set({ isAdmin: true })
      .where(inArray(users.discordId, adminIds))
      .returning({ discordId: users.discordId });
    summary.adminsPromoted = promoted.length;
    const found = new Set(promoted.map((row) => row.discordId));
    summary.adminsPending = adminIds.filter((id) => !found.has(id));
  }

  return summary;
}

/** Insert one profile field if (game, key) is free. Returns 1 or 0. */
async function insertField(
  database: Database,
  gameId: string | null,
  field: Omit<NewProfileField, "gameId">
): Promise<number> {
  const inserted = await database
    .insert(profileFields)
    .values({ ...field, gameId })
    // No conflict target: the (game_id, key) constraint is NULLS NOT DISTINCT,
    // and letting Postgres match whichever unique constraint fired keeps this
    // working for global fields too.
    .onConflictDoNothing()
    .returning({ id: profileFields.id });
  return inserted.length;
}

async function main(): Promise<void> {
  const summary = await seed();
  console.log(
    `Seed complete: +${summary.gamesInserted} games, +${summary.fieldsInserted} profile ` +
      `fields, +${summary.settingsInserted} settings, ${summary.adminsPromoted} admin(s) ` +
      `promoted.`
  );
  if (summary.adminsPending.length > 0) {
    console.log(
      `Waiting on first sign-in before promoting: ${summary.adminsPending.join(", ")}`
    );
  }
}

// `tsx src/db/seed.ts` runs this; importing the module does not.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    }
  );
}
