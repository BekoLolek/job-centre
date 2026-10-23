/**
 * Idempotent seed for the Phase 1 tables.
 *
 * It creates the starting games catalogue, the profile fields that used to live
 * in a Google Form and Marvel Rivals' hero roster, plus the guild-gate settings
 * rows. Running it twice changes nothing the second time.
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
import { HERO_ROLES } from "@/lib/heroes";
import {
  type Database,
  type HeroRole,
  type NewProfileField,
  SETTING_KEYS,
  type SettingValue,
  db as defaultDb,
  games,
  heroes,
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

/**
 * Marvel Rivals' heroes at **Season 10.5**, as the pools a draw deals from.
 *
 * Checked against the live game on 2026-10-23 rather than recalled, which is
 * the only way this list is worth anything. 54 heroes: 14 Vanguard, 27 Duelist,
 * 12 Strategist, plus **Deadpool, playable as all three** — so the pools below
 * are 15 / 28 / 13 and the table gets 54 rows. Published counts disagree for
 * exactly that reason (docs/requirements.md's last-but-one Constraint).
 *
 * Written as three pools rather than as 54 rows with roles attached, because
 * that is the shape the roster was *verified* in: a reader can count a column
 * against the game's own hero screen, and a hero in two roles simply appears in
 * two pools. `rosterFromPools` turns it back into one row per hero.
 *
 * It goes stale by design. A hero released next season is an admin action
 * (R-214 / UC-40), not an edit to this file and a deploy — and an admin's
 * correction here survives every later seed, because nothing below overwrites a
 * row that exists.
 */
export const RIVALS_HERO_POOLS: Record<HeroRole, readonly string[]> = {
  Vanguard: [
    "Angela",
    "Captain America",
    "Deadpool",
    "Devil Dinosaur",
    "Doctor Strange",
    "Emma Frost",
    "Groot",
    "Hulk",
    "Magneto",
    "Peni Parker",
    "Rogue",
    "The Hood",
    "The Thing",
    "Thor",
    "Venom",
  ],
  Duelist: [
    "Black Cat",
    "Black Panther",
    "Black Widow",
    "Blade",
    "Cyclops",
    "Daredevil",
    "Deadpool",
    "Elsa Bloodstone",
    "Gorr",
    "Hawkeye",
    "Hela",
    "Human Torch",
    "Iron Fist",
    "Iron Man",
    "Magik",
    "Mister Fantastic",
    "Moon Knight",
    "Namor",
    "Phoenix",
    "Psylocke",
    "Scarlet Witch",
    "Spider-Man",
    "Squirrel Girl",
    "Star-Lord",
    "Storm",
    "The Punisher",
    "Winter Soldier",
    "Wolverine",
  ],
  Strategist: [
    "Adam Warlock",
    "Cloak & Dagger",
    "Deadpool",
    "Gambit",
    "Invisible Woman",
    "Jeff The Land Shark",
    "Jubilee",
    "Loki",
    "Luna Snow",
    "Mantis",
    "Rocket Raccoon",
    "Ultron",
    "White Fox",
  ],
};

/** One row per hero, carrying every role it appears in, in `HERO_ROLES` order. */
function rosterFromPools(
  pools: Record<HeroRole, readonly string[]>
): Array<{ name: string; roles: HeroRole[] }> {
  const byName = new Map<string, HeroRole[]>();
  for (const role of HERO_ROLES) {
    for (const name of pools[role]) {
      const roles = byName.get(name);
      if (roles) roles.push(role);
      else byName.set(name, [role]);
    }
  }
  return [...byName].map(([name, roles]) => ({ name, roles }));
}

/** The 54, one row each. Deadpool is the row with three roles. */
export const RIVALS_HEROES: ReadonlyArray<{ name: string; roles: HeroRole[] }> =
  rosterFromPools(RIVALS_HERO_POOLS);

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
      // The same three roles the hero catalogue uses, from the same source:
      // this question and `heroes.roles` are two views of one fact about the
      // game, and a second hand-written copy of the list is how they drift.
      options: HERO_ROLES.map((role) => ({ value: role.toLowerCase(), label: role })),
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
  /** Heroes planted on `rivals`. 54 on a fresh database, 0 on every re-run. */
  heroesInserted: number;
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
    heroesInserted: 0,
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

  // --- heroes ------------------------------------------------------
  // The roster hangs off `rivals`, the game it was read from. `jackbox` has no
  // heroes and is not given an empty list to mean so — no rows *is* no list,
  // which is what the draw page reads to name the game instead of dealing
  // (UC-39 1b).
  const [rivals] = await database
    .select({ id: games.id })
    .from(games)
    .where(eq(games.key, "rivals"))
    .limit(1);
  if (rivals) {
    summary.heroesInserted = await plantHeroes(database, rivals.id, RIVALS_HEROES);
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

/**
 * Plant the heroes whose (game, name) is still free. Returns how many were
 * written — 54 on a fresh database, 0 on every re-run.
 *
 * **Never overwrites** — the rule in this file's module comment, and the one
 * this data needs most: an admin who corrects a hero's roles after a rework
 * must not have the next seed undo it, so a row that already exists is left
 * exactly as it is. The roles here are the roster's, and they are only ever
 * written by the insert that creates the row.
 *
 * One statement rather than 54, unlike the loops above it, and the reason is
 * the one `loadAdminGames` gives for grouping its counts in Postgres: on Neon
 * every statement is an HTTP request, so a row-at-a-time loop over this roster
 * would be 54 of them. Two heroes and five profile fields do not justify the
 * difference in shape; 54 do.
 *
 * The conflict is **targeted** at the (game_id, name) pair rather than left
 * bare, for the reason `makeHost` in the test helpers spells out: a bare `DO
 * NOTHING` forgives every unique violation on the table, so it would go on
 * silently doing nothing if a constraint were added later that this seed should
 * actually be failing on. What stays forgiven is the pair the constraint is on,
 * which is a real no-op.
 *
 * Nothing here checks that the roles are non-empty, and that is not an omission:
 * `rosterFromPools` derives a hero's roles from the pools it appears in, so a
 * hero in no role has no row to write at all — the shape makes UC-40 3b
 * unrepresentable rather than caught. `parseHeroRoles` is the gate for roles
 * that arrive as *input* (Task 77's screen), and
 * `heroes_roles_distinct_nonempty` is the backstop under both.
 *
 * One thing the (game, name) match cannot do, stated because it is the only way
 * a re-seed changes anything an admin can see: a hero an admin has **renamed**
 * no longer matches, so the next seed plants the original name again beside it.
 * That is a visible duplicate an admin can retire, where the alternatives lose
 * the correction outright — and no deploy triggers it, because `npm run build`
 * runs `db:migrate` and not this file.
 */
async function plantHeroes(
  database: Database,
  gameId: string,
  roster: ReadonlyArray<{ name: string; roles: readonly HeroRole[] }>
): Promise<number> {
  if (roster.length === 0) return 0;

  const inserted = await database
    .insert(heroes)
    .values(roster.map((hero) => ({ gameId, name: hero.name, roles: [...hero.roles] })))
    .onConflictDoNothing({ target: [heroes.gameId, heroes.name] })
    .returning({ id: heroes.id });
  return inserted.length;
}

async function main(): Promise<void> {
  const summary = await seed();
  console.log(
    `Seed complete: +${summary.gamesInserted} games, +${summary.fieldsInserted} profile ` +
      `fields, +${summary.heroesInserted} heroes, +${summary.settingsInserted} settings, ` +
      `${summary.adminsPromoted} admin(s) promoted.`
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
