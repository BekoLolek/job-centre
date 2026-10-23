/**
 * The browser-sweep fixture: every state the site can be in, built by the site's
 * own functions, against the local PGlite database.
 *
 *     DATABASE_URL="" node ./node_modules/tsx/dist/cli.mjs scripts/qa-fixture.ts
 *
 * ## Why this file exists at all
 *
 * A dataset exactly like this one existed before — 25 members, events in every
 * status, applications in every state, a draft with awarded lots, scored
 * championships — and it was *clicked* into being over an afternoon. It lived
 * as a folder on one machine with no script behind it, and when `./data/pg` was
 * corrupted it went with it. Every note the sweep had written against it became
 * unverifiable in the same instant, because there was no way to get the data
 * back and check.
 *
 * So the rule this file is written to is not "set up some test data". It is:
 * **the sweep's world must be reconstructible from the repository.** That is
 * what makes a finding reproducible a month later, on another machine, by
 * somebody who was not there.
 *
 * ## Cleanly re-runnable, not idempotent
 *
 * Stated plainly because the difference matters and because "idempotent" is the
 * word people reach for when they have not checked.
 *
 * This script **wipes and rebuilds**. It is not idempotent in the strict sense:
 * it does not inspect what is there and add only what is missing, and the row
 * *ids* it produces differ from run to run (see "What is not stable" below). It
 * is *cleanly re-runnable*: running it twice in a row leaves the database in the
 * same shape as running it once — the same counts, the same slugs, the same
 * discord ids, the same handles, the same titles — with no accumulation, no
 * duplicate-key failure and no half-state. That is the property a sweep needs.
 *
 * Why wipe rather than merge: nearly every state here is reached by *moving*
 * through the state machine (apply → accept → waitlist → decline, publish →
 * live → complete), and a merge would have to recognise a half-finished journey
 * and resume it. That recogniser is more code than the whole fixture, and it is
 * code whose bugs look exactly like the application bugs the sweep is hunting.
 * A wipe has no such failure mode.
 *
 * ### The wipe refuses to run anywhere but a local PGlite
 *
 * {@link assertLocalPglite} asks {@link driverFor} and aborts on `neon`. It
 * does not take the caller's word for it — not an argument, not a flag, not the
 * absence of `DATABASE_URL` on the command line — because the cost of being
 * wrong once is the production database, and `npm run build` already runs
 * `db:migrate` against whatever `DATABASE_URL` names. The check is on the one
 * thing that decides which database `src/db/index.ts` actually opened.
 *
 * {@link KEEP} names the four reference tables the wipe leaves alone: `games`,
 * `heroes`, `profile_fields` and `settings`. Those are `src/db/seed.ts`'s
 * output, not this file's, and none of them holds a foreign key into anything
 * truncated below — so `truncate … cascade` cannot reach them. Everything else
 * in the `public` schema is this fixture's to own.
 *
 * ## Built through the application, not through inserts
 *
 * `saveProfileSection`, `createEvent`, `publishEvent`, `setEventDays`,
 * `setEventQuestions`, `applyToEvent`, `setApplicationStatus`,
 * `withdrawApplication`, `setConfirmation`, `waiveEntryRule`, `applyToHost`,
 * `approveHostApplication`, `declineHostApplication`, `setTeams`,
 * `setCaptains`, `setDraftPool`, `openLot`, `placeBid`, `awardLot`,
 * `discardLot`, `moveToReserve`, `voidLot`, `createChampionship`,
 * `addCountingEvent`, `setPlacements`, `setChampionshipStatus`, `createPoll`,
 * `votePoll`, `closePoll`, `addSuggestion`, `voteSuggestion`,
 * `setSuggestionStatus`, `ensureHandles`.
 *
 * A raw insert can write a row the application can never produce — an accepted
 * applicant on an event with no seats, a waitlist with a hole in it, an awarded
 * lot that never cost anybody any money. A sweep against those states proves
 * nothing, because the bug it finds may be a bug in the fixture. Every state
 * below is therefore *reached*, through the same transactions a real admin's
 * clicks would open, and a refusal from any of them stops this script rather
 * than being papered over.
 *
 * **The one exception is members.** There is no sign-up function to call: a
 * member arrives through Auth.js's Discord callback, which needs Discord. So
 * {@link plantMembers} inserts `users` rows directly, in the shape
 * `makeUser` in `src/db/__tests__/helpers.ts` uses, and `ensureHandles` — a
 * real application function — derives their `/players/[handle]` segments
 * afterwards. Nothing else in this file writes a table directly.
 *
 * ## Determinism
 *
 * A fixture that differs between runs makes a sweep finding unreproducible:
 * "the waitlist was in the wrong order" is not a bug report if the order was
 * random. So:
 *
 *  - **No `Math.random`.** The draft's wheel is the only randomness in the
 *    write paths this file touches, and {@link openLot} takes every player by
 *    name, so the wheel never spins. (`src/lib/random-teams.ts` is the shape
 *    this repo uses for injected randomness; nothing here needs it, because
 *    naming the player is both deterministic *and* what an `admin_pick` draft
 *    does.)
 *  - **No bare `new Date()`.** Every instant is an offset from one pinned base,
 *    {@link FixtureClock.now}, and every write that accepts a `now` is handed
 *    one. See {@link pinNow} for what the base is and why it is not a constant.
 *
 * ### What is not stable, and why that is the right trade
 *
 * Row **ids** are uuids minted by Postgres (`uuid … defaultRandom()`), so they
 * differ every run. Pinning them would mean inserting events, applications,
 * teams and lots directly with chosen ids — abandoning the whole point above.
 * So the ids move, and every handle the sweep needs instead is stable by
 * construction: a member is their `discord_id` (what `/dev-login` keys on) and
 * their `handle` (what `/players/[handle]` keys on); an event is its `slug`
 * (what `/events/[slug]` keys on); a season, a team, a poll and a suggestion
 * are their names. A sweep note should cite those, never a uuid.
 *
 * ## Every query is wrapped
 *
 * An unguarded PGlite rejection throws an error whose stack walks back into the
 * bundled WASM chunk — thousands of characters of minified JavaScript, which is
 * what a terminal full of noise and no diagnosis looks like. {@link step} wraps
 * every call that touches the database, and {@link FixtureError} prints the
 * Postgres sentence and the label of the step that produced it, with no stack.
 */

import { sql } from "drizzle-orm";
import { type Database, createDatabase, driverFor, profileFields, users } from "@/db";
import {
  addCountingEvent,
  createChampionship,
  setChampionshipStatus,
} from "@/lib/championships";
import { setPlacements } from "@/lib/championship-results";
import {
  awardLot,
  discardLot,
  moveToReserve,
  openLot,
  placeBid,
  setCaptains,
  setDraftPool,
  setTeams,
  voidLot,
} from "@/lib/draft";
import {
  applyToEvent,
  createEvent,
  publishEvent,
  setApplicationStatus,
  setConfirmation,
  setEventDays,
  setEventQuestions,
  updateEvent,
  waiveEntryRule,
  withdrawApplication,
} from "@/lib/events";
import {
  applyToHost,
  approveHostApplication,
  declineHostApplication,
} from "@/lib/hosting";
import { ensureHandles } from "@/lib/players";
import { saveProfileSection } from "@/lib/profile";
import { closePoll, createPoll, votePoll } from "@/lib/polls";
import { addSuggestion, setSuggestionStatus, voteSuggestion } from "@/lib/suggestions";

/* ------------------------------------------------------------------ */
/* Failing legibly                                                    */
/* ------------------------------------------------------------------ */

/**
 * A step that did not work, as one sentence.
 *
 * Carries no stack on purpose. The two things worth knowing are which step
 * failed and what Postgres (or the application) said about it; the stack of a
 * PGlite rejection is the WASM bundle, and printing it buries both.
 */
class FixtureError extends Error {
  constructor(label: string, cause: unknown) {
    super(`${label}: ${explain(cause)}`);
    this.name = "FixtureError";
  }
}

/** The longest message worth printing before it stops being a message. */
const MESSAGE_MAX = 400;

/**
 * The readable part of whatever was thrown.
 *
 * drizzle re-throws with a generic "Failed query: …" and hangs the real
 * Postgres error off `cause`, so the chain is walked and every message in it
 * kept — the same reasoning as `expectRejection` in
 * `src/db/__tests__/helpers.ts`. Each one is cut at its first newline, because
 * a PGlite message's second line onwards is the bundle.
 */
function explain(cause: unknown): string {
  if (typeof cause === "string") return clip(cause);

  const seen: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const error = current as { message?: string; detail?: string; cause?: unknown };
    if (error.message) seen.push(clip(error.message));
    if (error.detail) seen.push(clip(error.detail));
    current = error.cause;
  }
  return seen.length > 0 ? [...new Set(seen)].join(" / ") : "no message";
}

function clip(text: string): string {
  const line = text.split("\n", 1)[0].trim();
  return line.length > MESSAGE_MAX ? `${line.slice(0, MESSAGE_MAX)}…` : line;
}

/**
 * Run one database step, or fail with a sentence naming it.
 *
 * Every call in this file that reaches the database goes through here. That is
 * the whole of the error handling and it is deliberately the only shape: a
 * `try`/`catch` per call site would be forty of them, and the fortieth would be
 * the one somebody forgot.
 */
async function step<T>(label: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw error instanceof FixtureError ? error : new FixtureError(label, error);
  }
}

/** What every mutation in `src/lib` returns: a value, or a sentence. */
type Outcome<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * The value, or stop.
 *
 * A refused write means the fixture asked the application for a state it
 * refuses to produce, and carrying on would leave a half-built world that looks
 * like the application's fault. So it is fatal, with the application's own
 * sentence attached.
 */
async function want<T>(label: string, work: () => Promise<Outcome<T>>): Promise<T> {
  const result = await step(label, work);
  if (!result.ok) throw new FixtureError(label, result.error);
  return result.data;
}

/* ------------------------------------------------------------------ */
/* The pinned clock                                                   */
/* ------------------------------------------------------------------ */

/** Offsets, in milliseconds. */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * One instant, and everything measured from it.
 *
 * `at(+7 * DAY)` is "a week after the fixture's now" and `at(-3 * DAY)` is
 * three days before, so "starts in a week" and "sign-ups closed on Tuesday"
 * stay true of the data however long after the run somebody looks at it.
 */
type FixtureClock = { now: Date; at: (offset: number) => Date };

/**
 * The base instant: **midnight UTC of the day the fixture runs**, or whatever
 * `QA_FIXTURE_NOW` names.
 *
 * ## Why not a hard-coded constant
 *
 * Because the brief has two requirements that pull against each other, and
 * only one resolution satisfies both. "Deterministic" wants a fixed base.
 * "'Starts in 7 days' stays true whenever it runs" wants a base that tracks the
 * calendar — a constant pinned to some day in 2026 would have every "upcoming"
 * event in the past by next month, and the sign-up windows that are open *now*
 * would be shut, which is most of the states the sweep is here to walk.
 *
 * Truncating to the UTC day is the resolution: there is exactly one `new Date()`
 * in this file, it is read once, and the time of day is thrown away. Two runs on
 * the same UTC day therefore produce identical instants, which is the
 * determinism that matters — a sweep and its re-run happen the same day, and a
 * finding is reproduced by re-running the fixture, not by waiting a week.
 *
 * ## Reproducing a run from another day
 *
 * `QA_FIXTURE_NOW=2026-06-01T00:00:00Z` pins the base exactly. A sweep note
 * that needs to be re-walked months later should record the base the run
 * printed, and pass it back. That is the escape hatch that makes the truncation
 * safe rather than merely convenient.
 */
function pinNow(): FixtureClock {
  const raw = (process.env.QA_FIXTURE_NOW ?? "").trim();
  let base: Date;
  if (raw) {
    base = new Date(raw);
    if (Number.isNaN(base.getTime())) {
      throw new FixtureError("QA_FIXTURE_NOW", `"${raw}" is not an instant.`);
    }
  } else {
    const wall = new Date();
    base = new Date(
      Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), 0, 0, 0, 0)
    );
  }
  const fixed = base.getTime();
  return { now: new Date(fixed), at: (offset: number) => new Date(fixed + offset) };
}

/* ------------------------------------------------------------------ */
/* The guard, and the wipe                                            */
/* ------------------------------------------------------------------ */

/**
 * The four tables `src/db/seed.ts` owns and this fixture must not touch.
 *
 * None of them holds a foreign key into anything this file truncates — they
 * reference each other (`heroes` and `profile_fields` point at `games`) and
 * nothing else — so `truncate … cascade` over the rest cannot reach them.
 * Checked against `src/db/schema.ts` rather than assumed, because `cascade`
 * follows references *inward*, and a future reference table carrying a
 * `created_by` into `users` would quietly join the wipe.
 */
const KEEP = ["games", "heroes", "profile_fields", "settings"] as const;

/**
 * Refuse to do any of this to anything but the local file-backed PGlite.
 *
 * `driverFor()` is the same function `src/db/index.ts` uses to pick a driver and
 * `src/db/migrate.ts` uses to pick a migrator, so this asks the question that
 * actually decided which database is open — not the shape of the command line.
 * The target is printed before anything happens, in the wording `migrate.ts`
 * prints, so a run can be read back and checked.
 */
function assertLocalPglite(): void {
  const kind = driverFor();
  const target = kind === "neon" ? "Neon (DATABASE_URL)" : "local PGlite (./data/pg)";
  console.log(`QA fixture target: ${target}`);
  if (kind !== "pglite") {
    throw new FixtureError(
      "target",
      "This fixture truncates tables and will only run against the local PGlite " +
        "database. DATABASE_URL is set, so src/db/index.ts would open Neon. " +
        'Re-run with DATABASE_URL="".'
    );
  }
}

/** Rows out of a raw statement, whichever shape the driver hands back. */
async function query<T>(label: string, statement: ReturnType<typeof sql.raw>): Promise<T[]> {
  return step(label, async () => {
    const result = (await db.execute(statement)) as unknown;
    if (Array.isArray(result)) return result as T[];
    const rows = (result as { rows?: unknown }).rows;
    return (Array.isArray(rows) ? rows : []) as T[];
  });
}

/**
 * Empty every table this fixture owns.
 *
 * The list is read from `information_schema` rather than written out, so a
 * table added by migration 0032 is cleared without anybody having to remember
 * this file. One `truncate` for all of them, because `cascade` and a single
 * statement together make foreign-key order irrelevant — and `restart identity`
 * so a re-run's sequences start where the first run's did.
 */
async function wipe(): Promise<number> {
  const rows = await query<{ table_name: string }>(
    "list tables",
    sql.raw(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE'
       order by table_name`
    )
  );
  const doomed = rows
    .map((row) => row.table_name)
    .filter((name) => !KEEP.includes(name as (typeof KEEP)[number]));

  if (doomed.length === 0) return 0;
  const list = doomed.map((name) => `public."${name}"`).join(", ");
  await query("truncate fixture tables", sql.raw(`truncate ${list} restart identity cascade`));
  return doomed.length;
}

/* ------------------------------------------------------------------ */
/* The personas                                                       */
/* ------------------------------------------------------------------ */

/**
 * One member, as `/dev-login` and `/players/[handle]` see them.
 *
 * `discordId` is the load-bearing field: `DEV_LOGIN_DISCORD_ID` names it, so
 * these strings are how a sweep chooses who to be. They are kept exactly as the
 * lost sweep used them — `qa-oskar`, `qa-imani`, `qa-zola` — so the notes from
 * that afternoon still describe the right people. None of them is a digit
 * string, so none can collide with a real Discord snowflake.
 */
type Persona = {
  discordId: string;
  displayName: string;
  isAdmin: boolean;
  /** What a sweep uses them for. Printed with the summary. */
  purpose: string;
};

/**
 * Fifteen members: two admins, one host who is deliberately not an admin, and
 * twelve ordinary ones.
 *
 * **`qa-oskar` is a host and not an admin, and that is the point of him.** The
 * lost sweep found a real bug on exactly that pairing — a screen that asked
 * "may you manage this event" where it meant "are you an admin" — and the only
 * way to ask that question is to have somebody who is one and not the other.
 * `canManageEvent` in `src/lib/hosting.ts` is the rule under test.
 *
 * Twelve ordinary members rather than ten, because the draft wants two captains
 * and a pool that exactly fills two rosters, and a pool that happens to fit is
 * worth more than a pool with spare bodies in it: it reaches the
 * "every roster is full" refusal `openLot` makes.
 */
const PERSONAS: readonly Persona[] = [
  {
    discordId: "qa-oskar",
    displayName: "QA Oskar",
    isAdmin: false,
    purpose: "Host of /events/qa-draft-oskar-night, NOT an admin — host-vs-admin permissions",
  },
  {
    discordId: "qa-imani",
    displayName: "QA Imani",
    isAdmin: true,
    purpose: "Admin — created most events, decided most applications, ran the draft",
  },
  {
    discordId: "qa-zola",
    displayName: "QA Zola",
    isAdmin: true,
    purpose: "Second admin — the other side of a two-admin disagreement, declined a host application",
  },
  { discordId: "qa-ana", displayName: "QA Ana", isAdmin: false, purpose: "Captain of QA Alpha; has a pending host application" },
  { discordId: "qa-ben", displayName: "QA Ben", isAdmin: false, purpose: "Captain of QA Bravo; has a declined host application" },
  { discordId: "qa-chidi", displayName: "QA Chidi", isAdmin: false, purpose: "Drafted to QA Alpha; said 'in' on the capped event" },
  {
    discordId: "qa-dara",
    displayName: "QA Dara",
    isAdmin: false,
    purpose:
      "Drafted to QA Bravo; said 'not coming' on the capped event, so her seat was freed and qa-elif promoted",
  },
  {
    discordId: "qa-elif",
    displayName: "QA Elif",
    isAdmin: false,
    purpose:
      "Drafted to QA Alpha; holds an entry waiver; promoted off the capped event's waitlist by qa-dara dropping out",
  },
  { discordId: "qa-finn", displayName: "QA Finn", isAdmin: false, purpose: "Drafted to QA Bravo; withdrew from an open event" },
  { discordId: "qa-gita", displayName: "QA Gita", isAdmin: false, purpose: "Discarded from the draft; declined on an open event" },
  { discordId: "qa-hugo", displayName: "QA Hugo", isAdmin: false, purpose: "Sent to the reserve pool, then bought from it" },
  { discordId: "qa-iris", displayName: "QA Iris", isAdmin: false, purpose: "Her award was voided — back in the pool, money refunded" },
  { discordId: "qa-jonas", displayName: "QA Jonas", isAdmin: false, purpose: "On the block right now — the one open lot" },
  { discordId: "qa-kaia", displayName: "QA Kaia", isAdmin: false, purpose: "Waitlisted on the capped event; first in the queue" },
  { discordId: "qa-liang", displayName: "QA Liang", isAdmin: false, purpose: "Waitlisted on the capped event; still in the draft pool" },
];

/** Everybody who is not an admin and not the host. */
const MEMBERS = PERSONAS.filter((persona) => !persona.isAdmin && persona.discordId !== "qa-oskar");

/** Member ids by discord id, filled by {@link plantMembers}. */
const ids = new Map<string, string>();

function id(discordId: string): string {
  const found = ids.get(discordId);
  if (!found) throw new FixtureError("persona", `no member for ${discordId}`);
  return found;
}

/**
 * The only direct write in this file.
 *
 * There is no sign-up function to call: a `users` row is created by Auth.js's
 * Discord callback (`src/lib/auth.ts`), which needs Discord. So these are
 * inserted in the shape `makeUser` in `src/db/__tests__/helpers.ts` uses —
 * minus its `Math.random` suffix, which is exactly the kind of run-to-run drift
 * this fixture may not have. `isAdmin` is set here rather than through the
 * allowlist for the same reason the row is: there is nothing to call.
 *
 * `handle` is left for {@link ensureHandles}, the real function, so the
 * `/players/[handle]` segments are derived by the code under test rather than
 * guessed at here.
 */
async function plantMembers(clock: FixtureClock): Promise<Map<string, string>> {
  const planted = await step("insert members", () =>
    db
      .insert(users)
      .values(
        PERSONAS.map((persona, index) => ({
          discordId: persona.discordId,
          displayName: persona.displayName,
          name: persona.displayName,
          email: `${persona.discordId}@qa.example.test`,
          isAdmin: persona.isAdmin,
          // Spread over the fortnight before the pinned now, oldest first, so
          // "newest members" lists have something to sort and the order is the
          // order of PERSONAS rather than of whatever the insert returned.
          createdAt: clock.at(-(PERSONAS.length - index) * DAY),
          lastSeenAt: clock.at(-index * HOUR),
        }))
      )
      .returning({ id: users.id, discordId: users.discordId })
  );

  for (const row of planted) if (row.discordId) ids.set(row.discordId, row.id);
  return step("derive handles", () => ensureHandles([...ids.values()], db));
}

/* ------------------------------------------------------------------ */
/* The catalogue, the profiles, and one event helper                  */
/* ------------------------------------------------------------------ */

/**
 * The seeded catalogue, read rather than restated.
 *
 * The ladder and the role options are read out of `games` and `profile_fields`
 * instead of being imported from `src/db/seed.ts`, because what this fixture
 * has to satisfy is **this deployment's** catalogue: an admin who has edited a
 * ladder (R-214 / UC-40 lets them) would otherwise get a fixture whose ranks no
 * longer parse, and the failure would look like a bug in `parseProfileValue`.
 */
type Catalogue = {
  rivals: string;
  /** `profile_fields.id` by key. */
  fields: Map<string, string>;
  /** `games.rank_ladder` for rivals, lowest first. */
  ladder: string[];
  /** The option values of the rivals `roles` multiselect. */
  roleValues: string[];
};

async function readCatalogue(): Promise<Catalogue> {
  const games = await query<{ id: string; rank_ladder: unknown }>(
    "read rivals game",
    sql.raw(`select id, rank_ladder from games where key = 'rivals' limit 1`)
  );
  if (games.length === 0) {
    throw new FixtureError("read rivals game", "no `rivals` game — run `npm run db:seed` first");
  }

  const rows = await step("read profile fields", () =>
    db
      .select({ id: profileFields.id, key: profileFields.key, options: profileFields.options })
      .from(profileFields)
  );

  const ladder = asStrings(games[0].rank_ladder);
  if (ladder.length === 0) {
    throw new FixtureError("read rivals game", "the rivals rank ladder is empty");
  }

  const roles = rows.find((row) => row.key === "roles");
  const roleValues = (roles?.options ?? []).map((option) => option.value);

  return {
    rivals: games[0].id,
    fields: new Map(rows.map((row) => [row.key, row.id])),
    ladder,
    roleValues,
  };
}

/** A jsonb array of strings, as whichever shape the driver handed back. */
function asStrings(value: unknown): string[] {
  const raw = typeof value === "string" ? safeJson(value) : value;
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Fill every member's profile before anybody applies to anything.
 *
 * Not optional and not decoration. `askedDetails` asks for the **global**
 * required details plus the event's game's, whatever questions the event
 * carries — so on this deployment every rivals event demands `ign`, `rank` and
 * `roles`, and every event at all demands `voice`. A fixture that skipped this
 * would get "This event needs a few details from your profile first." on the
 * first `applyToEvent` and nothing else, which is the rule working rather than
 * a problem to route around.
 *
 * `saveProfileSection` is the real write (UC-04), one call per section, so the
 * `confirmed_at` stamps and the completeness arithmetic are the ones the
 * profile page produces.
 *
 * The values are indexed, never random: member *i* gets ladder entry
 * `i mod ladder.length` and a role set that cycles through the three. Spread
 * across the whole ladder on purpose — a rank gate is only interesting against
 * members on both sides of it.
 */
async function fillProfiles(catalogue: Catalogue): Promise<number> {
  const voice = catalogue.fields.get("voice");
  const ign = catalogue.fields.get("ign");
  const rank = catalogue.fields.get("rank");
  const roles = catalogue.fields.get("roles");

  let saved = 0;
  for (const [index, persona] of PERSONAS.entries()) {
    const who = id(persona.discordId);

    if (voice) {
      await save(`profile ${persona.discordId}: global`, who, null, {
        // Two thirds say yes, deterministically, so a filter on it has both sides.
        [voice]: index % 3 !== 2,
      });
      saved += 1;
    }

    const patch: Record<string, unknown> = {};
    if (ign) patch[ign] = `${persona.displayName.replace(/\s+/g, "")}#${1000 + index}`;
    if (rank) patch[rank] = catalogue.ladder[index % catalogue.ladder.length];
    if (roles && catalogue.roleValues.length > 0) {
      patch[roles] = [
        catalogue.roleValues[index % catalogue.roleValues.length],
        catalogue.roleValues[(index + 1) % catalogue.roleValues.length],
      ];
    }
    if (Object.keys(patch).length > 0) {
      await save(`profile ${persona.discordId}: rivals`, who, catalogue.rivals, patch);
      saved += 1;
    }
  }
  return saved;
}

/**
 * `saveProfileSection`, failing loudly.
 *
 * Its refusal is `{ errors }` keyed by field with no single `error` sentence,
 * so it does not fit {@link want}'s shape and gets its own unwrapping rather
 * than a cast that would hide a real refusal.
 */
async function save(
  label: string,
  userId: string,
  gameId: string | null,
  patch: Record<string, unknown>
): Promise<void> {
  const result = await step(label, () => saveProfileSection(userId, gameId, patch, db));
  if (!result.ok) {
    const said = Object.entries(result.errors)
      .map(([field, message]) => `${field}: ${message}`)
      .join("; ");
    throw new FixtureError(label, said || "refused with no message");
  }
}

/**
 * An event with its days written and its ids in hand.
 *
 * Two calls rather than `createEvent({ days })` on purpose: availability is
 * keyed by `event_days.id`, and `createEvent` returns the event's derived dates
 * but not the day rows. `setEventDays` returns the rows, so going through it
 * always is one path instead of two.
 */
type Built = { id: string; slug: string; dayIds: string[] };

async function build(
  label: string,
  input: Parameters<typeof createEvent>[0],
  days: Array<{ startsAt?: Date | null; label?: string }>
): Promise<Built> {
  const event = await want(`${label}: create`, () => createEvent({ ...input, days: [] }, db));
  const written =
    days.length === 0
      ? { days: [] as Array<{ id: string }> }
      : await want(`${label}: days`, () => setEventDays(event.id, days, db));
  return { id: event.id, slug: event.slug, dayIds: written.days.map((day) => day.id) };
}

/* ------------------------------------------------------------------ */
/* The build                                                          */
/* ------------------------------------------------------------------ */

/** What the run reports, so the counts in a sweep note come from the run. */
type Summary = {
  base: string;
  tablesCleared: number;
  handles: Map<string, string>;
  slugs: Record<string, string>;
};

async function buildFixture(clock: FixtureClock): Promise<Summary> {
  const tablesCleared = await wipe();
  const handles = await plantMembers(clock);
  const catalogue = await readCatalogue();
  const fields = catalogue.fields;
  const rivals = catalogue.rivals;
  await fillProfiles(catalogue);

  const imani = id("qa-imani");
  const zola = id("qa-zola");
  const oskar = id("qa-oskar");
  const slugs: Record<string, string> = {};

  /* ---------------------------------------------------------------- */
  /* 1. draft, hosted by qa-oskar, and with no dates at all           */
  /* ---------------------------------------------------------------- */

  /*
   * The host grant is written by approving a host application and by nothing
   * else — `src/lib/hosting.ts` exports no add-a-host helper, deliberately
   * (R-86 / UC-21), and the one in `src/db/__tests__/helpers.ts` is a test
   * fixture. So this walks UC-21 in order: Oskar applies, an admin builds the
   * event from the application, and the approval lands on that event. The grant
   * is therefore the one the site can actually produce.
   */
  const oskarApplication = await want("oskar: host application", () =>
    applyToHost(
      oskar,
      {
        title: "QA Oskar's Draft Night",
        gameName: "Marvel Rivals",
        gameId: rivals,
        summary:
          "A QA fixture event hosted by somebody who is a host and not an admin. " +
          "Every host-versus-admin permission question is asked against this one.",
        format: "Two teams, bid draft",
        expectedPlayers: 12,
        proposedWhen: "A Saturday, times to be agreed",
        playerInfoNeeded: "Rank, preferred roles, and whether voice chat is fine.",
      },
      db
    )
  );

  const oskarNight = await build(
    "oskar night",
    {
      title: "QA Oskar's Draft Night",
      slug: "qa-draft-oskar-night",
      type: "tournament",
      gameId: rivals,
      createdBy: imani,
      description:
        "Draft status, no dates, no sign-up window. Hosted by qa-oskar, who is NOT an admin.",
      config: { draft: true, teams: 2 },
    },
    // No days, and no window. This is the "nothing agreed yet" end of UC-08:
    // the event exists, the host can edit it, and it cannot be published.
    []
  );
  slugs["draft, host-owned, no dates"] = oskarNight.slug;

  await want("oskar: approve host application", () =>
    approveHostApplication(
      oskarApplication.id,
      imani,
      { eventId: oskarNight.id, note: "Yours. Set the dates when you have them." },
      db
    )
  );

  /* ---------------------------------------------------------------- */
  /* 2. draft, mid-setup, with profile-linked questions               */
  /* ---------------------------------------------------------------- */

  const inSetup = await build(
    "in setup",
    {
      title: "QA Draft In Setup",
      slug: "qa-draft-admin-setup",
      type: "tournament",
      gameId: rivals,
      createdBy: imani,
      capacity: 16,
      signupOpensAt: clock.at(-2 * DAY),
      signupClosesAt: clock.at(9 * DAY),
      description: "Draft status with everything filled in — the publish button should work.",
    },
    [
      { startsAt: clock.at(10 * DAY + 18 * HOUR), label: "Group stage" },
      { startsAt: clock.at(11 * DAY + 18 * HOUR), label: "Playoffs" },
    ]
  );
  slugs["draft, ready to publish"] = inSetup.slug;

  await want("in setup: questions", () =>
    setEventQuestions(
      inSetup.id,
      [
        {
          label: "Current competitive rank",
          type: "rank",
          required: true,
          profileFieldId: fields.get("rank") ?? null,
        },
        {
          label: "Happy to use voice chat",
          type: "bool",
          required: true,
          profileFieldId: fields.get("voice") ?? null,
        },
        { label: "Anything we should know?", type: "text", required: false },
      ],
      db
    )
  );

  /* ---------------------------------------------------------------- */
  /* 3. published, sign-ups open right now                            */
  /* ---------------------------------------------------------------- */

  const open = await build(
    "open signups",
    {
      title: "QA Signups Open Now",
      slug: "qa-open-signups",
      type: "scrim",
      gameId: rivals,
      createdBy: imani,
      signupOpensAt: clock.at(-2 * DAY),
      signupClosesAt: clock.at(6 * DAY),
      description: "Uncapped, sign-ups open, starts in a week. The ordinary happy path.",
    },
    [{ startsAt: clock.at(7 * DAY + 19 * HOUR), label: "Match night" }]
  );
  slugs["published, signups open"] = open.slug;
  await want("open signups: publish", () => publishEvent(open.id, db));

  /*
   * The event's own questions — not linked to a profile field, so their answers
   * live on the application (`applications.answers`) rather than on the member.
   * The ids come back from the write, because an answer is keyed by
   * `event_questions.id` and ids are minted by Postgres: there is nothing to
   * hard-code and nothing to look up afterwards.
   */
  const openQuestions = await want("open signups: questions", () =>
    setEventQuestions(
      open.id,
      [
        { label: "In-game name", type: "text", required: true },
        {
          label: "Preferred side",
          type: "select",
          required: false,
          options: [
            { value: "attack", label: "Attack" },
            { value: "defend", label: "Defend" },
          ],
        },
      ],
      db
    )
  );
  const openIgn = openQuestions.questions[0].id;
  const openSide = openQuestions.questions[1].id;
  const SIDES = ["attack", "defend"] as const;

  /** What one member writes on the open event's form. Indexed, never random. */
  const openAnswers = (who: string, index: number): Record<string, unknown> => ({
    [openIgn]: `${who.replace("qa-", "")}#${1000 + index}`,
    [openSide]: SIDES[index % SIDES.length],
  });
  /*
   * Applications in four of the five states, on one event, so a single screen
   * shows the whole decision surface. The fifth — pending — needs an approval
   * event, which is §5 below.
   *
   * Every `applyToEvent` is handed `now`, and every one of these instants is
   * inside the event's window and before its first day: `applicationsOpen`
   * refuses otherwise, which is the rule rather than an inconvenience. The
   * offsets also stagger the arrivals, so "first come" has a real order and the
   * waitlist below has a real queue.
   */
  const openApplicants = ["qa-ana", "qa-ben", "qa-chidi", "qa-dara", "qa-elif"];
  for (const [index, who] of openApplicants.entries()) {
    await want(`open signups: ${who} applies`, () =>
      applyToEvent(
        open.id,
        id(who),
        {
          now: clock.at(-(2 * DAY) + index * HOUR),
          availability: open.dayIds[0] ? { [open.dayIds[0]]: "yes" } : {},
          answers: openAnswers(who, index),
        },
        db
      )
    );
  }

  await want("open signups: finn applies", () =>
    applyToEvent(
      open.id,
      id("qa-finn"),
      { now: clock.at(-(2 * DAY) + 6 * HOUR), answers: openAnswers("qa-finn", 5) },
      db
    )
  );
  await want("open signups: finn withdraws", () =>
    withdrawApplication(open.id, id("qa-finn"), db)
  );

  const gita = await want("open signups: gita applies", () =>
    applyToEvent(
      open.id,
      id("qa-gita"),
      { now: clock.at(-(2 * DAY) + 7 * HOUR), answers: openAnswers("qa-gita", 6) },
      db
    )
  );
  await want("open signups: gita declined", () =>
    setApplicationStatus(
      gita.id,
      "declined",
      { decidedBy: zola, note: "Fixture: declined so the declined branch has a row.", now: clock.at(-DAY) },
      db
    )
  );

  const hugoOpen = await want("open signups: hugo applies", () =>
    applyToEvent(
      open.id,
      id("qa-hugo"),
      { now: clock.at(-(2 * DAY) + 8 * HOUR), answers: openAnswers("qa-hugo", 7) },
      db
    )
  );
  await want("open signups: hugo waitlisted", () =>
    setApplicationStatus(
      hugoOpen.id,
      "waitlisted",
      { decidedBy: imani, note: "Fixture: waitlisted on an uncapped event, by hand.", now: clock.at(-DAY) },
      db
    )
  );

  // A waiver on an event with no gate on it: the row an admin writes when they
  // have decided somebody is in regardless (UC-13 / R-?), and a state the
  // waivers screen needs something to render.
  await want("open signups: waive entry for elif", () =>
    waiveEntryRule(open.id, id("qa-elif"), "enter", { by: imani, now: clock.at(-DAY) }, db)
  );

  /* ---------------------------------------------------------------- */
  /* 4. published, at capacity, with a waitlist                       */
  /* ---------------------------------------------------------------- */

  const capped = await build(
    "capped",
    {
      title: "QA Capped With Waitlist",
      slug: "qa-capped-waitlist",
      type: "tournament",
      gameId: rivals,
      createdBy: imani,
      capacity: 4,
      signupOpensAt: clock.at(-3 * DAY),
      signupClosesAt: clock.at(13 * DAY),
      description:
        "Four seats, all taken, three more queueing. This is the event the over-cap accept flow is tested on.",
    },
    [{ startsAt: clock.at(14 * DAY + 18 * HOUR), label: "Finals day" }]
  );
  slugs["published, at capacity + waitlist"] = capped.slug;
  await want("capped: publish", () => publishEvent(capped.id, db));

  /*
   * Two questions linked to profile fields, so the details half of
   * `applyToEvent` is exercised: the answers below are written to
   * `profile_values` by `commitDetails`, not to the application. It is the one
   * path in the member flow that writes outside its own tables, and a sweep
   * that never walks it never checks that a member's profile really filled in.
   */
  await want("capped: questions", () =>
    setEventQuestions(
      capped.id,
      [
        {
          label: "Current competitive rank",
          type: "rank",
          required: true,
          profileFieldId: fields.get("rank") ?? null,
        },
        {
          label: "Happy to use voice chat",
          type: "bool",
          required: true,
          profileFieldId: fields.get("voice") ?? null,
        },
      ],
      db
    )
  );

  /*
   * Seven applicants into four seats. The first four take them (first come,
   * R-27), the last three are queued in arrival order — which is why each one
   * gets its own hour. `kaia` and `liang` are the two the personas list calls
   * out as waitlisted, and they are last on purpose.
   */
  const cappedQueue = ["qa-ana", "qa-ben", "qa-chidi", "qa-dara", "qa-elif", "qa-kaia", "qa-liang"];
  const cappedApplications = new Map<string, string>();
  for (const [index, who] of cappedQueue.entries()) {
    /*
     * Each applicant sends a *new* rank and vouches for the rest unchanged —
     * the two halves of UC-12 3 / R-49. The rank they send is one rung up the
     * ladder from the one `fillProfiles` stored, so `commitDetails` really
     * writes (a no-op patch would exercise nothing), and the ids they confirm
     * get `confirmed_at` stamped without a write.
     */
    const details: Record<string, unknown> = {};
    const rankField = fields.get("rank");
    if (rankField) {
      const stored = PERSONAS.findIndex((persona) => persona.discordId === who);
      details[rankField] = catalogue.ladder[(stored + 1) % catalogue.ladder.length];
    }
    const confirmed = ["voice", "ign", "roles"]
      .map((key) => fields.get(key))
      .filter((fieldId): fieldId is string => Boolean(fieldId));

    const application = await want(`capped: ${who} applies`, () =>
      applyToEvent(
        capped.id,
        id(who),
        {
          now: clock.at(-(3 * DAY) + index * HOUR),
          details,
          confirmed,
          availability: capped.dayIds[0] ? { [capped.dayIds[0]]: index < 4 ? "yes" : "maybe" } : {},
        },
        db
      )
    );
    cappedApplications.set(who, application.id);
  }

  /*
   * Two of the four seated members answer the "are you coming" question, in
   * both directions.
   *
   * **Saying "out" is not just a flag**, and the resulting counts look wrong
   * until you know it: a "not coming" goes through `freeSeat`, exactly as a
   * withdrawal does, so `qa-dara`'s application ends up **withdrawn** and
   * `qa-elif` is promoted off the waitlist into the seat she left. That is
   * UC-14 6 — the seat a drop frees goes to the next in line — and it is one of
   * the more valuable states in this fixture, because it is a promotion that
   * nobody decided. The event is still at capacity afterwards, which is the
   * point: four accepted, two queueing, and one of the four got there by
   * somebody else's change of mind.
   */
  await want("capped: chidi confirms in", () =>
    setConfirmation(cappedApplications.get("qa-chidi") as string, "in", { now: clock.at(-DAY) }, db)
  );
  await want("capped: dara confirms out", () =>
    setConfirmation(cappedApplications.get("qa-dara") as string, "out", { now: clock.at(-DAY) }, db)
  );

  /* ---------------------------------------------------------------- */
  /* 5. published, approval mode — where `pending` lives              */
  /* ---------------------------------------------------------------- */

  const approval = await build(
    "approval",
    {
      title: "QA Approval Mode",
      slug: "qa-approval-mode",
      type: "showmatch",
      gameId: rivals,
      createdBy: zola,
      capacity: 8,
      signupOpensAt: clock.at(-DAY),
      signupClosesAt: clock.at(20 * DAY),
      description:
        "entryMode: approval. Applications land pending and wait for a manager — R-27, UC-12.",
      config: { entryMode: "approval" },
    },
    [{ startsAt: clock.at(21 * DAY + 18 * HOUR), label: "Show match" }]
  );
  slugs["published, approval mode"] = approval.slug;
  await want("approval: publish", () => publishEvent(approval.id, db));

  const approvalQueue = ["qa-finn", "qa-gita", "qa-hugo", "qa-iris", "qa-jonas", "qa-kaia"];
  const approvalApplications = new Map<string, string>();
  for (const [index, who] of approvalQueue.entries()) {
    const application = await want(`approval: ${who} applies`, () =>
      applyToEvent(approval.id, id(who), { now: clock.at(-DAY + index * HOUR) }, db)
    );
    approvalApplications.set(who, application.id);
  }

  // Four left pending; one accepted and one declined, so the screen shows a
  // decided row next to the undecided ones.
  await want("approval: jonas accepted", () =>
    setApplicationStatus(
      approvalApplications.get("qa-jonas") as string,
      "accepted",
      { decidedBy: zola, now: clock.at(-6 * HOUR) },
      db
    )
  );
  await want("approval: kaia declined", () =>
    setApplicationStatus(
      approvalApplications.get("qa-kaia") as string,
      "declined",
      { decidedBy: zola, note: "Fixture: declined on an approval event.", now: clock.at(-6 * HOUR) },
      db
    )
  );

  /* ---------------------------------------------------------------- */
  /* 6. published, and then the dates taken away                      */
  /* ---------------------------------------------------------------- */

  /*
   * UC-09 2 will not publish an event with no day, so the only way to reach a
   * *published* event with no dates is to publish a dated one and then clear
   * the dates — which is what a manager does when a venue falls through. It is
   * the state UC-13 7a is about, and it is reached here the same way
   * `events.test.ts` reaches it.
   */
  const undated = await build(
    "undated",
    {
      title: "QA Published Without Dates",
      slug: "qa-undated-published",
      type: "social",
      createdBy: imani,
      signupOpensAt: clock.at(-DAY),
      signupClosesAt: clock.at(27 * DAY),
      description: "Published, then the dates were taken away. Times to be agreed.",
    },
    [{ startsAt: clock.at(28 * DAY + 18 * HOUR), label: "Some evening" }]
  );
  slugs["published, no dates at all"] = undated.slug;
  await want("undated: publish", () => publishEvent(undated.id, db));
  await want("undated: clear the dates", () =>
    setEventDays(undated.id, [{ startsAt: null, label: "Times to be agreed" }], db)
  );

  /* ---------------------------------------------------------------- */
  /* 7. live, with the draft room half-run                            */
  /* ---------------------------------------------------------------- */

  const draftRoom = await build(
    "draft room",
    {
      title: "QA Live Draft Room",
      slug: "qa-live-draft-room",
      type: "tournament",
      gameId: rivals,
      createdBy: imani,
      signupOpensAt: clock.at(-10 * DAY),
      signupClosesAt: clock.at(-2 * DAY),
      description: "Running now. Two teams, a pool, and lots in every one of the five states.",
      config: { draft: true, teams: 2 },
    },
    [{ startsAt: clock.at(-HOUR), label: "Draft and matches" }]
  );
  slugs["live, draft under way"] = draftRoom.slug;
  await want("draft room: publish", () => publishEvent(draftRoom.id, db));

  // Twelve accepted applicants: two become captains, ten fill the pool, and
  // two rosters of six take exactly those twelve. Applied before the event went
  // live, because `applicationsOpen` shuts on `live` (R-?, UC-12).
  for (const [index, member] of MEMBERS.entries()) {
    await want(`draft room: ${member.discordId} applies`, () =>
      applyToEvent(
        draftRoom.id,
        id(member.discordId),
        { now: clock.at(-(9 * DAY) + index * HOUR) },
        db
      )
    );
  }
  await want("draft room: go live", () =>
    updateEvent(draftRoom.id, { status: "live", from: "published" }, db)
  );

  const teams = await want("draft room: teams", () =>
    setTeams(
      draftRoom.id,
      [
        { name: "QA Alpha", seed: 1 },
        { name: "QA Bravo", seed: 2 },
      ],
      db
    )
  );
  const [alpha, bravo] = teams.teams;

  await want("draft room: captains", () =>
    setCaptains(
      draftRoom.id,
      [
        { teamId: alpha.id, userId: id("qa-ana") },
        { teamId: bravo.id, userId: id("qa-ben") },
      ],
      db
    )
  );

  // Seeded from the accepted applications, minus the captains — `setDraftPool`'s
  // own rule (§14), so the pool is the one the admin screen would build.
  await want("draft room: pool", () => setDraftPool(draftRoom.id, {}, db));

  /*
   * Every lot is opened on a **named** player. That is both the determinism
   * (`openLot`'s wheel is the one source of randomness in these write paths,
   * and naming the player never reaches it) and a real mode of the product —
   * `selectionMode: "admin_pick"` requires exactly this call.
   *
   * The order matters in one respect: at most one lot may be open per event
   * (`draft_lots_one_open_per_event`), so the lot left open is opened last.
   */
  type Settled = { who: string; team: string; price: number };
  const bought: Settled[] = [
    { who: "qa-chidi", team: alpha.id, price: 300 },
    { who: "qa-dara", team: bravo.id, price: 250 },
    { who: "qa-elif", team: alpha.id, price: 150 },
    { who: "qa-finn", team: bravo.id, price: 100 },
  ];
  for (const [index, sale] of bought.entries()) {
    const at = clock.at(-(2 * HOUR) + index * 300_000);
    const lot = await want(`draft: open ${sale.who}`, () =>
      openLot(draftRoom.id, { userId: id(sale.who), openedBy: imani, now: at }, db)
    );
    await want(`draft: bid on ${sale.who}`, () =>
      placeBid(lot.id, sale.team, sale.price, { now: at }, db)
    );
    await want(`draft: award ${sale.who}`, () =>
      awardLot(lot.id, sale.team, { closedBy: imani, now: at }, db)
    );
  }

  // Discarded: nobody wanted them (UC-16).
  const gitaLot = await want("draft: open gita", () =>
    openLot(draftRoom.id, { userId: id("qa-gita"), openedBy: imani, now: clock.at(-100 * 60_000) }, db)
  );
  await want("draft: discard gita", () =>
    discardLot(gitaLot.id, { closedBy: imani, now: clock.at(-99 * 60_000) }, db)
  );

  // Reserved, and then bought off the reserve wheel — two lots for one player,
  // which is the shape R-144's comeback limit counts.
  const hugoFirst = await want("draft: open hugo", () =>
    openLot(draftRoom.id, { userId: id("qa-hugo"), openedBy: imani, now: clock.at(-95 * 60_000) }, db)
  );
  await want("draft: hugo to reserve", () =>
    moveToReserve(hugoFirst.id, { closedBy: imani, now: clock.at(-94 * 60_000) }, db)
  );
  const hugoSecond = await want("draft: reopen hugo from reserve", () =>
    openLot(
      draftRoom.id,
      { userId: id("qa-hugo"), kind: "reserve", openedBy: imani, now: clock.at(-80 * 60_000) },
      db
    )
  );
  await want("draft: bid on hugo", () =>
    placeBid(hugoSecond.id, bravo.id, 75, { now: clock.at(-80 * 60_000) }, db)
  );
  await want("draft: award hugo", () =>
    awardLot(hugoSecond.id, bravo.id, { closedBy: imani, now: clock.at(-79 * 60_000) }, db)
  );

  // Voided: awarded, then undone. The lot stays for the record, the money goes
  // back, and the player returns to the pool — the undo a sweep should check at
  // the data layer rather than by reading the screen.
  const irisLot = await want("draft: open iris", () =>
    openLot(draftRoom.id, { userId: id("qa-iris"), openedBy: imani, now: clock.at(-70 * 60_000) }, db)
  );
  await want("draft: bid on iris", () =>
    placeBid(irisLot.id, alpha.id, 200, { now: clock.at(-70 * 60_000) }, db)
  );
  await want("draft: award iris", () =>
    awardLot(irisLot.id, alpha.id, { closedBy: imani, now: clock.at(-69 * 60_000) }, db)
  );
  await want("draft: void iris", () =>
    voidLot(irisLot.id, { voidedBy: imani, now: clock.at(-60 * 60_000) }, db)
  );

  // And one on the block right now, left open, so the draft room has something
  // live to render and the "settle that lot first" refusal has something to
  // refuse against.
  await want("draft: open jonas and leave him there", () =>
    openLot(draftRoom.id, { userId: id("qa-jonas"), openedBy: imani, now: clock.at(-5 * 60_000) }, db)
  );

  /* ---------------------------------------------------------------- */
  /* 8-10. complete events, and the seasons they count towards        */
  /* ---------------------------------------------------------------- */

  /**
   * A finished event with accepted applicants, built in the past.
   *
   * Everything happens while it is `published` — applications, decisions — and
   * only then does it walk `published → live → complete`. That is forced rather
   * than chosen: `lockRefusal` shuts every write on a complete or cancelled
   * event (R-39 / UC-09 6b), so a fixture that completed the event first could
   * not have put anybody in it. Which is the rule working.
   */
  async function finishedEvent(
    title: string,
    slug: string,
    who: readonly string[],
    startedDaysAgo: number
  ): Promise<{ id: string; slug: string; accepted: string[] }> {
    const event = await build(
      `${slug}`,
      {
        title,
        slug,
        type: "tournament",
        gameId: rivals,
        createdBy: imani,
        signupOpensAt: clock.at(-(startedDaysAgo + 14) * DAY),
        signupClosesAt: clock.at(-(startedDaysAgo + 1) * DAY),
        description: "A finished event, kept for the record.",
      },
      [{ startsAt: clock.at(-startedDaysAgo * DAY + 18 * HOUR), label: "Match day" }]
    );
    await want(`${slug}: publish`, () => publishEvent(event.id, db));

    const accepted: string[] = [];
    for (const [index, discordId] of who.entries()) {
      const application = await want(`${slug}: ${discordId} applies`, () =>
        applyToEvent(
          event.id,
          id(discordId),
          { now: clock.at(-(startedDaysAgo + 10) * DAY + index * HOUR) },
          db
        )
      );
      accepted.push(application.id);
    }

    await want(`${slug}: go live`, () =>
      updateEvent(event.id, { status: "live", from: "published" }, db)
    );
    await want(`${slug}: complete`, () =>
      updateEvent(event.id, { status: "complete", from: "live" }, db)
    );
    return { id: event.id, slug: event.slug, accepted };
  }

  const scored = await finishedEvent(
    "QA Complete And Scored",
    "qa-complete-scored",
    ["qa-ana", "qa-ben", "qa-chidi", "qa-dara", "qa-elif", "qa-finn"],
    21
  );
  slugs["complete, result recorded"] = scored.slug;

  const unscored = await finishedEvent(
    "QA Complete Unscored",
    "qa-complete-unscored",
    ["qa-gita", "qa-hugo", "qa-iris"],
    14
  );
  slugs["complete, counts but has no result"] = unscored.slug;

  const archived = await finishedEvent(
    "QA Complete Archived Season",
    "qa-complete-archive",
    ["qa-jonas", "qa-kaia", "qa-liang"],
    60
  );
  slugs["complete, in a closed season"] = archived.slug;

  /*
   * Three seasons, one in each status.
   *
   * `createChampionship` starts them hidden, which is the only status it
   * produces, so `published` and `closed` are reached through
   * `setChampionshipStatus` — the lifecycle in
   * `CHAMPIONSHIP_STATUS_FLOW`, walked rather than written over. The closed one
   * is closed *after* its result is recorded, because a closed season refuses
   * every write (UC-35 2b) including the one that would score it.
   */
  const live = await want("season live: create", () =>
    createChampionship(
      {
        name: "QA Season Published",
        createdBy: imani,
        description: "The season a sweep should be reading standings off.",
        runsFrom: monthOf(clock.at(-60 * DAY)),
        runsTo: monthOf(clock.at(60 * DAY)),
        pointsTable: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1],
        participationPoints: 1,
        countBest: null,
      },
      db
    )
  );
  await want("season live: publish", () =>
    setChampionshipStatus(live.id, "hidden", "published", {}, db)
  );
  await want("season live: add the scored event", () =>
    addCountingEvent(live.id, scored.id, db)
  );
  await want("season live: add the unscored event", () =>
    addCountingEvent(live.id, unscored.id, db)
  );

  /*
   * A finishing order on the scored event. The ids are *participant* ids, and
   * on an event with no teams that is the member's user id (`ParticipantRow`),
   * which is why these are `id(...)` and not application ids. Two members share
   * second place, so the tie branch of `scoreChampionship` has something to
   * score and third place is deliberately empty (UC-33 3a).
   */
  await want("season live: record places", () =>
    setPlacements(
      scored.id,
      [
        { id: id("qa-ana"), position: 1 },
        { id: id("qa-ben"), position: 2 },
        { id: id("qa-chidi"), position: 2 },
        { id: id("qa-dara"), position: 4 },
        { id: id("qa-elif"), position: 5 },
      ],
      db
    )
  );

  await want("season hidden: create", () =>
    createChampionship(
      {
        name: "QA Season Hidden",
        createdBy: zola,
        description: "Drafted and not published. Members must not see this one.",
        pointsTable: [20, 15, 10, 5],
        participationPoints: 0,
      },
      db
    )
  );

  const closed = await want("season closed: create", () =>
    createChampionship(
      {
        name: "QA Season Closed",
        createdBy: imani,
        description: "Finished. Every write on it should be refused until it is reopened.",
        runsFrom: monthOf(clock.at(-120 * DAY)),
        runsTo: monthOf(clock.at(-40 * DAY)),
        pointsTable: [30, 20, 10],
        participationPoints: 2,
      },
      db
    )
  );
  await want("season closed: publish", () =>
    setChampionshipStatus(closed.id, "hidden", "published", {}, db)
  );
  await want("season closed: add its event", () =>
    addCountingEvent(closed.id, archived.id, db)
  );
  await want("season closed: record places", () =>
    setPlacements(
      archived.id,
      [
        { id: id("qa-jonas"), position: 1 },
        { id: id("qa-kaia"), position: 2 },
        { id: id("qa-liang"), position: 3 },
      ],
      db
    )
  );
  await want("season closed: close it", () =>
    setChampionshipStatus(closed.id, "published", "closed", {}, db)
  );

  /* ---------------------------------------------------------------- */
  /* 11. cancelled                                                    */
  /* ---------------------------------------------------------------- */

  /*
   * Cancelled with people in it, which is the only interesting kind: "the
   * applications stay for the record" (the `event_status` enum's own words) is
   * a claim about a cancelled event that *had* applicants, and an empty
   * cancelled event cannot falsify it.
   */
  const cancelled = await build(
    "cancelled",
    {
      title: "QA Cancelled Night",
      slug: "qa-cancelled-night",
      type: "scrim",
      gameId: rivals,
      createdBy: imani,
      capacity: 6,
      signupOpensAt: clock.at(-8 * DAY),
      signupClosesAt: clock.at(2 * DAY),
      description: "Called off. The applications stay for the record.",
    },
    [{ startsAt: clock.at(3 * DAY + 19 * HOUR), label: "Match night" }]
  );
  slugs.cancelled = cancelled.slug;
  await want("cancelled: publish", () => publishEvent(cancelled.id, db));

  for (const [index, who] of ["qa-ana", "qa-chidi", "qa-gita", "qa-iris"].entries()) {
    await want(`cancelled: ${who} applies`, () =>
      applyToEvent(cancelled.id, id(who), { now: clock.at(-(7 * DAY) + index * HOUR) }, db)
    );
  }
  await want("cancelled: call it off", () =>
    updateEvent(cancelled.id, { status: "cancelled", from: "published" }, db)
  );

  /* ---------------------------------------------------------------- */
  /* Polls, suggestions, host applications                            */
  /* ---------------------------------------------------------------- */

  const openPoll = await want("poll open: create", () =>
    createPoll(
      imani,
      {
        question: "Which night suits the next tournament?",
        detail: "Pick every night you could make. QA fixture poll — open, multiple choice.",
        multiple: true,
        closesAt: clock.at(10 * DAY),
        options: [
          { label: "Friday" },
          { label: "Saturday" },
          { label: "Sunday" },
          { label: "Any weekday" },
        ],
      },
      db,
      clock.now
    )
  );
  const openPollOptions = await query<{ id: string; label: string }>(
    "poll open: read options",
    sql.raw(`select id, label from poll_options where poll_id = '${openPoll.id}' order by sort`)
  );
  // Deterministic votes: member i votes for option (i mod options). Multiple
  // choice, so the first two also tick a second box.
  for (const [index, member] of MEMBERS.entries()) {
    const choice = openPollOptions[index % openPollOptions.length];
    await want(`poll open: ${member.discordId} votes`, () =>
      votePoll(openPoll.id, id(member.discordId), choice.id, db, clock.now)
    );
    if (index < 2) {
      const second = openPollOptions[(index + 1) % openPollOptions.length];
      await want(`poll open: ${member.discordId} votes again`, () =>
        votePoll(openPoll.id, id(member.discordId), second.id, db, clock.now)
      );
    }
  }

  const shutPoll = await want("poll closed: create", () =>
    createPoll(
      zola,
      {
        question: "Did the last tournament format work?",
        detail: "QA fixture poll — closed, single choice.",
        multiple: false,
        closesAt: clock.at(DAY),
        options: [{ label: "Yes, keep it" }, { label: "No, change it" }],
      },
      db,
      clock.now
    )
  );
  const shutPollOptions = await query<{ id: string }>(
    "poll closed: read options",
    sql.raw(`select id from poll_options where poll_id = '${shutPoll.id}' order by sort`)
  );
  for (const [index, member] of MEMBERS.slice(0, 7).entries()) {
    await want(`poll closed: ${member.discordId} votes`, () =>
      votePoll(
        shutPoll.id,
        id(member.discordId),
        shutPollOptions[index % shutPollOptions.length].id,
        db,
        clock.now
      )
    );
  }
  // Closed by moving the deadline back behind the pinned now, which is what
  // `closePoll` does — the poll is closed because its `closesAt` has passed,
  // and there is no second notion of closed to get out of step with it.
  await want("poll closed: close it", () => closePoll(shutPoll.id, clock.at(-HOUR), db));

  const suggestions: Array<{ by: string; title: string; detail: string; game: string | null }> = [
    {
      by: "qa-ana",
      title: "A Jackbox night for the people who do not play Rivals",
      detail:
        "Half the server does not own Marvel Rivals. One evening a month on something everybody has would get them in the door.",
      game: "Jackbox",
    },
    {
      by: "qa-chidi",
      title: "Run the draft an hour before the matches, not on the night",
      detail:
        "The draft runs long and then everybody is tired before the first match. Splitting them would help.",
      game: "Marvel Rivals",
    },
    {
      by: "qa-hugo",
      title: "Publish the standings after every event, not at the end of the season",
      detail: "Nobody knows where they are until the season closes, which is most of the fun gone.",
      game: null,
    },
  ];
  const suggestionIds: string[] = [];
  for (const entry of suggestions) {
    const made = await want(`suggestion: ${entry.by}`, () =>
      addSuggestion(
        id(entry.by),
        { title: entry.title, detail: entry.detail, gameName: entry.game },
        db
      )
    );
    suggestionIds.push(made.id);
  }

  /*
   * A tally with both signs in it, so `score` is a real subtraction rather than
   * a count.
   *
   * **The author is skipped**, and that is not tidiness. `addSuggestion`
   * already counts the suggester as wanting it (R-164 / UC-22 E2), and
   * `voteSuggestion` treats the same value sent twice as taking the vote back —
   * clicking the lit arrow un-lights it. So a loop over every member would
   * silently *remove* the author's own like, and the fixture's tally would be
   * one short of what it says it is, for a reason nobody reading it would see.
   */
  for (const [index, member] of MEMBERS.entries()) {
    if (member.discordId === suggestions[0].by) continue;
    const value: 1 | -1 = index < 9 ? 1 : -1;
    await want(`suggestion vote: ${member.discordId}`, () =>
      voteSuggestion(suggestionIds[0], id(member.discordId), value, db)
    );
  }
  for (const member of MEMBERS.slice(0, 5)) {
    if (member.discordId === suggestions[1].by) continue;
    await want(`suggestion vote 2: ${member.discordId}`, () =>
      voteSuggestion(suggestionIds[1], id(member.discordId), 1, db)
    );
  }
  await want("suggestion: mark one planned", () =>
    setSuggestionStatus(suggestionIds[1], "planned", db)
  );
  await want("suggestion: mark one declined", () =>
    setSuggestionStatus(suggestionIds[2], "declined", db)
  );

  /*
   * A host application waiting on an admin — the pending state UC-21 starts
   * from. It has to come from somebody other than Oskar:
   * `host_applications_one_pending_per_user` allows one at a time, and his is
   * already approved.
   */
  await want("host application: pending", () =>
    applyToHost(
      id("qa-ana"),
      {
        title: "QA Jackbox Evening",
        gameName: "Jackbox",
        summary:
          "A low-effort evening for the people who do not own Rivals. I would run it monthly, " +
          "six to ten players, no ranks and no draft.",
        format: "Party games, no teams",
        expectedPlayers: 10,
        proposedWhen: "A Thursday, 8pm",
        playerInfoNeeded: "Just whether they can hear and be heard.",
      },
      db
    )
  );

  // And one that was turned down, so the decided branch has a row too.
  const refused = await want("host application: to decline", () =>
    applyToHost(
      id("qa-ben"),
      {
        title: "QA Twenty-Four Hour Marathon",
        gameName: "Marvel Rivals",
        summary:
          "A full day and night of back-to-back matches with no breaks. I have not worked out " +
          "the format yet but I think it would be memorable.",
        format: "Unclear",
        expectedPlayers: 60,
        proposedWhen: "Whenever",
        playerInfoNeeded: "Rank and stamina.",
      },
      db
    )
  );
  await want("host application: decline it", () =>
    declineHostApplication(
      refused.id,
      zola,
      "Too big for a first event — come back with something for a dozen people.",
      db
    )
  );

  return {
    base: clock.now.toISOString(),
    tablesCleared,
    handles,
    slugs,
  };
}

/** `"YYYY-MM"`, which is how a season stores a month. */
function monthOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Counting what was built                                            */
/* ------------------------------------------------------------------ */

/**
 * The fixture's own census, read back out of the database.
 *
 * Printed rather than asserted. An assertion here would be this file checking
 * its own arithmetic; what a sweep needs is the real figures, read at the data
 * layer after the writes committed, so a note can quote them and the next run
 * can be compared against them.
 */
async function census(): Promise<string[]> {
  const lines: string[] = [];

  const one = async (label: string, statement: string): Promise<void> => {
    const rows = await query<{ n: number }>(label, sql.raw(statement));
    lines.push(`${label}: ${rows[0]?.n ?? 0}`);
  };

  const grouped = async (label: string, statement: string): Promise<void> => {
    const rows = await query<{ k: string | null; n: number }>(label, sql.raw(statement));
    const parts = rows.map((row) => `${row.k ?? "(none)"}=${row.n}`);
    lines.push(`${label}: ${parts.join(" ")} (total ${rows.reduce((sum, row) => sum + Number(row.n), 0)})`);
  };

  await one("users", `select count(*)::int as n from users`);
  await one("admins", `select count(*)::int as n from users where is_admin`);
  await grouped(
    "events by status",
    `select status::text as k, count(*)::int as n from events group by status order by status`
  );
  await grouped(
    "applications by status",
    `select status::text as k, count(*)::int as n from applications group by status order by status`
  );
  await grouped(
    "draft lots by status",
    `select status::text as k, count(*)::int as n from draft_lots group by status order by status`
  );
  await grouped(
    "championships by status",
    `select status::text as k, count(*)::int as n from championships group by status order by status`
  );
  await grouped(
    "host applications by status",
    `select status::text as k, count(*)::int as n from host_applications group by status order by status`
  );
  await grouped(
    "suggestions by status",
    `select status::text as k, count(*)::int as n from event_suggestions group by status order by status`
  );
  await one("event hosts", `select count(*)::int as n from event_hosts`);
  await one("event days", `select count(*)::int as n from event_days`);
  await one("event questions", `select count(*)::int as n from event_questions`);
  await one("availability rows", `select count(*)::int as n from availability`);
  await one("confirmations", `select count(*)::int as n from confirmations`);
  await one("entry waivers", `select count(*)::int as n from entry_waivers`);
  await one("profile values", `select count(*)::int as n from profile_values`);
  await one("teams", `select count(*)::int as n from teams`);
  await one("team members", `select count(*)::int as n from team_members`);
  await one("draft pool entries", `select count(*)::int as n from draft_pool_entries`);
  await one("draft bids", `select count(*)::int as n from draft_bids`);
  await one("championship events", `select count(*)::int as n from championship_events`);
  await one("championship placements", `select count(*)::int as n from championship_placements`);
  await one("polls", `select count(*)::int as n from polls`);
  await one("poll votes", `select count(*)::int as n from poll_votes`);
  await one("suggestion votes", `select count(*)::int as n from suggestion_votes`);

  return lines;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                        */
/* ------------------------------------------------------------------ */

/**
 * The handle, built explicitly rather than taken from the `db` proxy.
 *
 * `createDatabase({ url: "" })` cannot resolve to Neon — `driverFor("")` is
 * `pglite` — so the handle this file writes through is pinned to the local data
 * directory by construction, on top of {@link assertLocalPglite}'s check on the
 * environment. Two locks on the same door, because the thing behind it is the
 * production database.
 */
const db: Database = createDatabase({ url: "" });

async function main(): Promise<void> {
  assertLocalPglite();

  const clock = pinNow();
  console.log(`Pinned now: ${clock.now.toISOString()} (override with QA_FIXTURE_NOW)`);

  const summary = await buildFixture(clock);
  console.log(`Cleared ${summary.tablesCleared} fixture tables, kept ${KEEP.join(", ")}.`);

  console.log("\nPersonas — DEV_LOGIN_DISCORD_ID=<discord id> to sign in as one:");
  for (const persona of PERSONAS) {
    const handle = summary.handles.get(id(persona.discordId)) ?? "(no handle)";
    const flag = persona.isAdmin ? "admin" : "member";
    console.log(`  ${persona.discordId.padEnd(10)} /players/${handle.padEnd(10)} ${flag.padEnd(7)} ${persona.purpose}`);
  }

  console.log("\nEvents:");
  for (const [what, slug] of Object.entries(summary.slugs)) {
    console.log(`  /events/${slug.padEnd(24)} ${what}`);
  }

  console.log("\nCounts, read back from the database:");
  for (const line of await census()) console.log(`  ${line}`);

  console.log("\nFixture built. Re-run the same command to rebuild it from scratch.");
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof FixtureError ? error.message : explain(error));
    process.exit(1);
  }
);
