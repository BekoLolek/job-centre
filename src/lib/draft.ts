/**
 * Teams and the draft — the part that talks to Postgres.
 *
 * The rules live in `./draft-policy`, which has no database handle and is
 * tested exhaustively. This module is the trust boundary and the transaction
 * boundary, exactly as `./events` is for applications.
 *
 * ## Nothing here believes the request
 *
 * Team ids, captain choices, pool members and bid amounts are re-read from the
 * database on every write. A bid naming a team from another event is refused
 * outright rather than ignored; a captain who is not an accepted applicant is
 * refused with a sentence saying so. Quietly dropping either produces a draft
 * that looks right and is not, and a draft that is wrong about money is a draft
 * nobody trusts again.
 *
 * That goes for the draft pool too, which is the one place it did not. The pool
 * is a snapshot of the accepted applicants, taken once and never invalidated,
 * so `openLot` and `awardLot` re-read acceptance rather than trusting the entry
 * in front of them (see `acceptedAmong`). Nothing is stored to make that work.
 *
 * ## Bidding and awarding are one transaction each, and they have to be
 *
 * "Read the balance, check the cap, write the row" is a race with a window in
 * the middle of it. Two awards of the same lot both read the same balance and
 * both spend it; two bids merged into one document lose whichever landed first.
 * So every mutation that touches money takes the event's row lock
 * (`select … for update`) and does its reading *and* its writing inside it. The
 * lock is on the event rather than the table, so two drafts never queue behind
 * each other.
 *
 * `src/lib/__tests__/draft-concurrency.test.ts` fires the overlapping calls and
 * asserts the outcome — and, to prove the harness can actually produce the bug,
 * runs a deliberately naive implementation of each alongside and watches it
 * fail. One of those controls is the *old* storage model, a bids blob rewritten
 * whole, which is precisely why this schema is rows.
 *
 * ## What is deliberately not stored
 *
 * A team's remaining balance. It is derived from the awarded lots on every
 * read (`balanceFor`), so it cannot disagree with the history — which matters
 * most at the one moment a stored copy would be wrong, immediately after an
 * undo. See the note at the top of `./draft-policy`.
 */

import { randomInt } from "node:crypto";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import {
  type ApplicationStatus,
  type Database,
  type DraftBid,
  type DraftLot,
  type DraftLotStatus,
  type DraftPoolEntry,
  type DraftPoolKind,
  type DraftSpin,
  type EventRow,
  type Team,
  type TeamMember,
  applications,
  db as defaultDb,
  draftBids,
  draftConfigs,
  draftLots,
  draftPoolEntries,
  events,
  teamMembers,
  teams,
  users,
} from "@/db";
import { canManageEvent } from "@/lib/hosting";
import {
  type AwardedLotView,
  type DraftCompletion,
  type DraftConfig,
  type DraftPhase,
  type DraftRole,
  type DraftSnapshot,
  type DraftView,
  type DraftViewer,
  type LotResolution,
  type OpenLot,
  type PoolPlayer,
  type RosterState,
  type SettledLot,
  type TeamMemberView,
  type TeamStanding,
  MAX_TEAMS,
  MIN_TEAMS,
  SPIN_DURATION_MS,
  SPIN_TURNS,
  awardableTeamIds,
  balanceFor,
  bidsCloseAt,
  canPlaceBid,
  changedRules,
  draftComplete,
  draftConfigFrom,
  maxBidFor,
  mayComeBackAgain,
  reserveComebacksLeft,
  redactDraft,
  resolveLot,
  rosterState,
} from "./draft-policy";
import { lockRefusal } from "./archive-policy";
// `gatesFor` rather than a second ladder-and-ranks read of its own: the captain
// rule here has to give the same answer as the applicant list and the apply page.
import { type EventResult, gatesFor } from "./events";

/* ------------------------------------------------------------------ */
/* Results                                                            */
/* ------------------------------------------------------------------ */

/**
 * The same discriminated result `./events` returns, and deliberately the same
 * type rather than a twin of it: the callers are forms, and a form wants one
 * shape to branch on however many modules it talks to.
 */
export type DraftResult<T = null> = EventResult<T>;

function fail(error: string, errors?: Record<string, string>): {
  ok: false;
  error: string;
  errors?: Record<string, string>;
} {
  return errors ? { ok: false, error, errors } : { ok: false, error };
}

function withData<T>(data: T): DraftResult<T> {
  return { ok: true, data };
}

const NAME_MAX = 60;

function cleanText(raw: unknown, max: number): string {
  return typeof raw === "string" ? raw.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

/* ------------------------------------------------------------------ */
/* Small shared reads                                                 */
/* ------------------------------------------------------------------ */

async function readEvent(database: Database, eventId: string): Promise<EventRow | null> {
  const [row] = await database.select().from(events).where(eq(events.id, eventId)).limit(1);
  return row ?? null;
}

/**
 * Read the event **and take its row lock**, so everything that follows in this
 * transaction is the only thing spending this draft's money.
 */
async function lockEvent(database: Database, eventId: string): Promise<EventRow | null> {
  const [row] = await database
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .for("update")
    .limit(1);
  return row ?? null;
}

async function readConfig(database: Database, eventId: string): Promise<DraftConfig> {
  const [row] = await database
    .select()
    .from(draftConfigs)
    .where(eq(draftConfigs.eventId, eventId))
    .limit(1);
  return draftConfigFrom(row ?? null);
}

async function readTeams(database: Database, eventId: string): Promise<Team[]> {
  return database
    .select()
    .from(teams)
    .where(eq(teams.eventId, eventId))
    .orderBy(asc(teams.sort), asc(teams.createdAt));
}

async function readMembers(database: Database, eventId: string): Promise<TeamMember[]> {
  return database
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.eventId, eventId))
    .orderBy(desc(teamMembers.isCaptain), asc(teamMembers.acquiredAt));
}

async function readPool(database: Database, eventId: string): Promise<DraftPoolEntry[]> {
  return database
    .select()
    .from(draftPoolEntries)
    .where(eq(draftPoolEntries.eventId, eventId))
    .orderBy(asc(draftPoolEntries.sort), asc(draftPoolEntries.addedAt));
}

/**
 * Which of these players still hold an accepted place at the event.
 *
 * The draft pool is a snapshot the manager built (`setDraftPool`), and an
 * application's status moves on afterwards without it. So every path that is
 * about to *act* on a pool entry asks this instead of believing the entry —
 * `openLot`, the draft console's own pool read, and `setCaptains` picking from
 * "the accepted applicants" (R-62 / UC-15 3), which is the same question about
 * a list of people and so the same read.
 *
 * {@link seatStatus} is this question about one person, and it is the one to
 * call where the *answer* has to be named back ("is on the waitlist now"): a
 * set of accepted ids cannot say which of the four other things somebody is.
 *
 * Nothing is written back. A pool entry carries no copy of a status, because a
 * copy is the bug: it would be right at the moment it was taken and wrong from
 * the next decision onwards.
 */
async function acceptedAmong(
  database: Database,
  eventId: string,
  userIds: readonly string[]
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await database
    .select({ userId: applications.userId })
    .from(applications)
    .where(
      and(
        eq(applications.eventId, eventId),
        eq(applications.status, "accepted"),
        inArray(applications.userId, [...userIds])
      )
    );
  return new Set(rows.map((row) => row.userId));
}

/**
 * Where one player's application stands now, or null if they have none.
 *
 * One row by construction — `applications_event_user_uniq` — so the status is
 * the answer and not the first of several. `placeOnRoster` and `awardLot` both
 * ask it of the row they are about to write, which is the only place it can be
 * asked and still be true when the write lands.
 */
async function seatStatus(
  database: Database,
  eventId: string,
  userId: string
): Promise<ApplicationStatus | null> {
  const [row] = await database
    .select({ status: applications.status })
    .from(applications)
    .where(and(eq(applications.eventId, eventId), eq(applications.userId, userId)))
    .limit(1);
  return row?.status ?? null;
}

/** What to call somebody in a refusal about them. */
async function displayNameOf(database: Database, userId: string): Promise<string> {
  const [row] = await database
    .select({ displayName: users.displayName, name: users.name, handle: users.handle })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.displayName ?? row?.name ?? row?.handle ?? "That player";
}

/** Every application status except the one that holds a seat. */
type NoSeatStatus = Exclude<ApplicationStatus, "accepted">;

/**
 * Why this player has no seat, in the manager's words — the first half of the
 * refusals below.
 *
 * All four of these are "not accepted" and only one of them is the member's
 * own doing, so the sentence says which: a manager who declined somebody and a
 * manager looking at a member who pulled out at midnight are owed different
 * sentences, and "not accepted" would be the same unhelpful word for both.
 *
 * ## Exhaustive, with `accepted` kept out of the type
 *
 * This was a chain of `if`s falling through to "has no application for this
 * event" — which is true of a missing row and of nothing else. Every status
 * `application_status` has today is covered, so the fall-through is unreachable
 * today; a sixth member added to the enum would reach it and get a confidently
 * wrong sentence about somebody whose application the site had just learnt a
 * new word for. The switch makes tsc the guard instead: a new member fails the
 * `never` arm at compile time, which is the last moment anybody can still
 * decide what to say about it.
 *
 * `accepted` is excluded from the parameter rather than given a sentence,
 * because there is no sentence to give it: both callers have already
 * established that the seat is not held, and a phrase for "they do hold one"
 * could only ever be glued on to "…so there is no seat to sell". Excluding it
 * is what makes each caller read the status once and branch on it.
 */
function noSeatPhrase(name: string, status: NoSeatStatus | null): string {
  switch (status) {
    // No application row at all.
    case null:
      return `${name} has no application for this event`;
    case "declined":
      return `${name}'s application has been declined`;
    case "waitlisted":
      return `${name} is on the waitlist now`;
    case "withdrawn":
      return `${name} has withdrawn from the event`;
    case "pending":
      return `${name}'s application is back under review`;
    default: {
      const unhandled: never = status;
      throw new Error(`No sentence for application status ${String(unhandled)}`);
    }
  }
}

async function readLots(database: Database, eventId: string): Promise<DraftLot[]> {
  return database
    .select()
    .from(draftLots)
    .where(eq(draftLots.eventId, eventId))
    .orderBy(desc(draftLots.openedAt), desc(draftLots.id));
}

async function readOpenLot(database: Database, eventId: string): Promise<DraftLot | null> {
  const [row] = await database
    .select()
    .from(draftLots)
    .where(and(eq(draftLots.eventId, eventId), eq(draftLots.status, "open")))
    .limit(1);
  return row ?? null;
}

async function readBids(database: Database, lotId: string): Promise<DraftBid[]> {
  return database
    .select()
    .from(draftBids)
    .where(eq(draftBids.lotId, lotId))
    .orderBy(asc(draftBids.placedAt));
}

function asMemberViews(rows: readonly TeamMember[]): TeamMemberView[] {
  return rows.map((row) => ({
    teamId: row.teamId,
    userId: row.userId,
    price: row.price,
    isCaptain: row.isCaptain,
  }));
}

function asLotViews(rows: readonly DraftLot[]): AwardedLotView[] {
  return rows.map((row) => ({
    status: row.status,
    winnerTeamId: row.winnerTeamId,
    price: row.price,
  }));
}

/**
 * Has a lot ever been opened for this event? — UC-16 1a and E6a's moment.
 *
 * "Ever", not "is one open now" and not "has one been awarded": a lot that was
 * opened and then cancelled still happened in front of the room, and the
 * refusal is about the room having seen the rules it was bidding under. A
 * voided row counts for exactly that reason.
 */
async function draftHasBegun(database: Database, eventId: string): Promise<boolean> {
  const [row] = await database
    .select({ id: draftLots.id })
    .from(draftLots)
    .where(eq(draftLots.eventId, eventId))
    .limit(1);
  return row !== undefined;
}

/**
 * How many times this player has been put up *from the reserve pool* — the
 * count R-144 caps.
 *
 * Voided lots do not count. An undo is the admin saying the lot did not
 * happen, and a comeback the room never had should not be one the player has
 * spent.
 */
function reserveTurnsUsed(lots: readonly DraftLot[], userId: string): number {
  let used = 0;
  for (const lot of lots) {
    if (lot.playerUserId !== userId) continue;
    if (lot.fromKind !== "reserve") continue;
    if (lot.status === "voided") continue;
    used += 1;
  }
  return used;
}

/** The next `sort` at the back of one pool. */
function nextSort(entries: readonly DraftPoolEntry[], kind: DraftPoolKind): number {
  let highest = -1;
  for (const entry of entries) {
    if (entry.kind !== kind) continue;
    if (entry.sort > highest) highest = entry.sort;
  }
  return highest + 1;
}

/* ------------------------------------------------------------------ */
/* Teams                                                              */
/* ------------------------------------------------------------------ */

export type TeamInput = {
  /** Present for a team that already exists; absent creates one. */
  id?: string;
  name: string;
  seed?: number | null;
  /** Only read when the config's balance mode is `per_team`. */
  balanceStart?: number;
};

export type SetTeamsResult = {
  teams: Team[];
  /** Teams the list dropped. */
  removed: number;
};

/**
 * Delete these teams, or say why not — the one rule shared by every path that
 * removes one (`setTeams`'s list, `setTeamCount`'s lower figure).
 *
 * Returns a refusal sentence, or `null` once the rows are gone. A team that has
 * won lots is not removed: checklist.md's standing rule is that nothing is
 * destructive, and a roster with prices on it is a completed part of the
 * record. Two callers meant two copies of that, and the copy that drifts is the
 * one that lets a draft's prices vanish.
 */
async function removeTeamsIn(tx: Database, doomed: readonly Team[]): Promise<string | null> {
  if (doomed.length === 0) return null;

  const ids = doomed.map((team) => team.id);
  const lots = await tx
    .select({ winnerTeamId: draftLots.winnerTeamId })
    .from(draftLots)
    .where(inArray(draftLots.winnerTeamId, ids));

  if (lots.length > 0) {
    const held = new Set(lots.map((row) => row.winnerTeamId));
    const named = doomed
      .filter((team) => held.has(team.id))
      .map((team) => team.name)
      .join(", ");
    return `${named} has already drafted players, so removing the team would erase what they paid. Void those lots first.`;
  }

  await tx.delete(teams).where(inArray(teams.id, ids));
  return null;
}

/**
 * Write the whole team list for an event.
 *
 * The list is authoritative: a team whose id is absent is removed — unless it
 * has a draft history, in which case the write is refused rather than quietly
 * shredding somebody's roster and the prices they paid. checklist.md's standing
 * rule is that nothing is destructive, and a team that has won lots is a
 * completed part of the record.
 *
 * The **maximum** of eight teams (§8.1) is enforced here; the minimum of two is
 * not, because an admin types the names one at a time and being told "you need
 * two teams" while typing the first one is the sort of validation that makes
 * people stop using a form. Two is a publish-time question.
 *
 * Balances follow the config: under `uniform` every team starts on the event's
 * default and any per-team number in the input is ignored, because a mode that
 * says the balances are equal and a form that says otherwise is a
 * disagreement, and the mode should win.
 *
 * Seeds are a rank and are checked as one — a whole number, 1 or more, or
 * nothing at all. Duplicates are allowed on purpose; see the check for which
 * shapes are refused and why they are different in kind.
 *
 * ## This is also where a name becomes the manager's
 *
 * `teams.name_is_custom` records who wrote a name, because it cannot be read
 * back off the characters afterwards (see the column's docblock). This write is
 * the manager's name box, so the rule is the plainest one available: **a name
 * that arrives different from the stored one was typed**, and from then on
 * nothing overwrites it. A name that arrives unchanged leaves the flag exactly
 * as it was, so saving seeds or balances does not quietly adopt a placeholder
 * `setTeamCount` wrote and `setCaptains` is still entitled to replace.
 *
 * The one case it cannot see is a manager retyping, character for character,
 * the placeholder that was already there — indistinguishable from not touching
 * the field, because nothing arrived that differs from what is stored. They
 * get the automatic rename they would have got anyway, and typing any other
 * name is what claims it.
 */
export async function setTeams(
  eventId: string,
  input: readonly TeamInput[],
  database: Database = defaultDb
): Promise<DraftResult<SetTeamsResult>> {
  if (input.length > MAX_TEAMS) {
    return fail(`An event can have at most ${MAX_TEAMS} teams.`);
  }

  return database.transaction(async (tx) => {
    // The row lock, for the reason the money writes take it: this rewrites
    // `teams` and deletes `team_members` through the cascade, and
    // `placeOnRoster`, `setCaptains` and the award path all write the same two
    // tables. Serialising them on the event is what stops two managers' reads
    // of "which teams exist" both being acted on.
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const config = await readConfig(tx, eventId);
    const existing = await readTeams(tx, eventId);

    const locked = lockRefusal(event);
    if (locked) return fail(locked);
    const byExistingId = new Map(existing.map((team) => [team.id, team]));

    const errors: Record<string, string> = {};
    const cleaned: Array<{
      id: string;
      name: string;
      seed: number | null;
      balanceStart: number;
      sort: number;
      /** True when this save is what made the name the manager's own. */
      nameIsCustom: boolean;
    }> = [];
    const names = new Set<string>();

    for (const [index, team] of input.entries()) {
      const at = team.id ?? `new-${index}`;

      if (team.id && !byExistingId.has(team.id)) {
        errors[at] = "That team belongs to a different event.";
        continue;
      }
      const stored = team.id ? byExistingId.get(team.id) : undefined;

      const name = cleanText(team.name, NAME_MAX);
      if (!name) {
        errors[at] = "Give the team a name.";
        continue;
      }
      // UC-15 6a's second half, and the half the Gate-2 amendment settled:
      // **a typed duplicate is refused.** Only a name the site generated gets
      // a distinguishing suffix (`setTeamCount`, `setCaptains`); silently
      // renaming what somebody typed is worse than telling them.
      //
      // Folded case, and so stricter than `teams_event_name_uniq` — which is
      // `unique(event_id, name)` over plain `text` and would take "alpha"
      // beside "Alpha". Deliberately: the refusal is about two names a reader
      // cannot tell apart, not about what the index happens to allow.
      if (names.has(name.toLowerCase())) {
        errors[at] = "Two teams cannot share a name.";
        continue;
      }
      names.add(name.toLowerCase());

      const wanted =
        config.balanceMode === "per_team"
          ? (team.balanceStart ?? config.defaultBalance)
          : config.defaultBalance;
      if (!Number.isInteger(wanted) || wanted < 0) {
        errors[at] = "A starting balance has to be a whole number, and not negative.";
        continue;
      }

      /*
       * A seed is a rank, and `seedOrderFrom` sorts on the number exactly as it
       * is typed — so `0` and `-3` rank *ahead* of seed 1, and `1.5` lands
       * between two teams the bracket is meant to put side by side, in both
       * cases with nothing on any screen to say why the bracket came out that
       * way (R-160 / UC-18 E5).
       *
       * Duplicates are **not** refused, and that is a decision rather than an
       * omission: two teams sharing a seed keep list order, which is pinned by a
       * test, because a half-finished seeding is a real state a manager passes
       * through while typing. `0`, a negative and a fraction are not states
       * anybody passes through — a rank below the first rank is not a weaker
       * answer to "which seed is this", it is a different question.
       */
      const seed = team.seed ?? null;
      if (seed !== null && (!Number.isInteger(seed) || seed < 1)) {
        errors[at] = "A seed has to be a whole number, 1 or more.";
        continue;
      }

      cleaned.push({
        id: team.id ?? "",
        name,
        seed,
        balanceStart: wanted,
        sort: index,
        // A new row's name was typed into the box that created it. An existing
        // row's was typed only if it differs from what is stored — see the
        // docblock. Fails to `true`, the direction that never rewrites a name.
        nameIsCustom: stored === undefined || name !== stored.name,
      });
    }

    if (Object.keys(errors).length > 0) {
      return fail("Some of those teams need another look.", errors);
    }

    const keeping = new Set(cleaned.map((team) => team.id).filter(Boolean));
    const doomed = existing.filter((team) => !keeping.has(team.id));

    /*
     * A starting balance is not a label. Every remaining balance on the site is
     * derived — `balanceFor` is `balanceStart` minus the awarded lots, which is
     * exactly why there is no `balance_left` column — so moving a team's
     * starting figure after they have bought somebody silently rewrites what
     * every past lot appears to have cost them. That is the standing rule's
     * "erase a draft's prices" by another route, and it is refused for the same
     * reason removing the team is.
     *
     * **Asked before `removeTeamsIn`, not after it**, and that ordering is the
     * rule in docs/decisions/004-refusals-inside-transactions.md rather than a
     * preference. `removeTeamsIn` deletes, and a refusal returned from a
     * transaction callback commits what came before it — so one save that
     * dropped a team *and* moved a surviving team's balance used to delete the
     * team, cascade its roster away, commit the lot, and then answer with this
     * sentence. The removal is refused by whether the *doomed* teams hold lots;
     * this is refused by whether anybody does. Two different questions, so
     * neither one covered the other.
     */
    const started = await tx
      .select({ id: draftLots.id })
      .from(draftLots)
      .where(and(eq(draftLots.eventId, eventId), eq(draftLots.status, "awarded")))
      .limit(1);

    if (started.length > 0) {
      const byId = new Map(existing.map((team) => [team.id, team]));
      const moved = cleaned.filter(
        (team) => team.id && byId.get(team.id)?.balanceStart !== team.balanceStart
      );
      if (moved.length > 0) {
        return fail(
          `${moved.map((team) => team.name).join(", ")} has already bid in this draft, so the starting balance cannot change now — every price paid would be measured against a different number.`
        );
      }
    }

    const refusal = await removeTeamsIn(tx, doomed);
    if (refusal) return fail(refusal);

    // Names are unique per event, so swapping two of them in place trips the
    // constraint halfway through a perfectly legal rewrite. Parking every
    // survivor on a name nobody can type sidesteps it without dropping rows —
    // the same two-pass `setEventQuestions` uses for question keys.
    for (const team of existing) {
      if (!keeping.has(team.id)) continue;
      await tx
        .update(teams)
        .set({ name: `tmp-${team.id}` })
        .where(eq(teams.id, team.id));
    }

    for (const team of cleaned) {
      const values = {
        name: team.name,
        seed: team.seed,
        balanceStart: team.balanceStart,
        sort: team.sort,
      };
      if (team.id) {
        // `name_is_custom` is only ever *set*, never cleared, and only by a
        // save that changed the name. Writing `false` back on an unchanged
        // name would hand a placeholder's licence to a name somebody typed
        // three saves ago.
        await tx
          .update(teams)
          .set(team.nameIsCustom ? { ...values, nameIsCustom: true } : values)
          .where(eq(teams.id, team.id));
      } else {
        await tx.insert(teams).values({ eventId, ...values, nameIsCustom: true });
      }
    }

    return withData({ teams: await readTeams(tx, eventId), removed: doomed.length });
  });
}

export type SetTeamCountResult = {
  teams: Team[];
  /** Teams this call created. */
  added: number;
  /** Teams it removed. */
  removed: number;
};

/**
 * The next free "Team <n>" for an event — the placeholder, and UC-15 6a's
 * suffix for a generated name.
 *
 * A placeholder's distinguishing mark *is* its number, so a clash is settled by
 * moving on to the next one rather than by inventing "Team 3 (2)": an event
 * whose third team is called "Team 3" because somebody typed it gets "Team 4"
 * for the one after, which is the name a manager would have reached for anyway.
 * `taken` is compared case-insensitively, which is **stricter than the
 * database**: `teams_event_name_uniq` is `unique(event_id, name)` over plain
 * `text`, so Postgres would happily hold "team 3" beside "Team 3". That is the
 * reason for folding case here rather than an excuse — two names a reader
 * cannot tell apart are two names an admin has to untangle by hand, and a
 * generated name is the one kind nobody chose. So the site declines to write
 * the second and moves on to the next number.
 *
 * The ceiling is `MAX_TEAMS` numbers past the last candidate, which cannot be
 * exhausted: at most eight teams exist, so at most eight numbers are taken.
 */
function nextPlaceholderName(taken: Set<string>, from: number): string {
  for (let n = Math.max(1, from); n <= from + MAX_TEAMS; n += 1) {
    const candidate = `Team ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  // Unreachable with at most `MAX_TEAMS` rows, and a thrown error in a
  // transaction would be worse than a name nobody loves.
  return `Team ${from}`;
}

/**
 * How many teams this event has — UC-15 steps 1 and 2, in one write.
 *
 * ## Why a count is its own action
 *
 * `setTeams` takes the whole list and is the right shape for *editing* teams:
 * names, seeds, balances, and a removal expressed by leaving a row out. It is
 * the wrong shape for "make it four", which is the first thing a manager does
 * and the only thing UC-15 1 asks for. Done through the list it takes two
 * steps — the screen invents four rows, then posts them — and the invented
 * rows carry invented *names*, which is precisely how the old placeholder
 * reached `setTeams` looking exactly like something a manager had typed. A
 * count writes the placeholders itself, so it is the one path that can
 * truthfully record `name_is_custom = false` (R-63 / UC-15 4).
 *
 * ## Both ends of 2–8 are enforced here, unlike `setTeams`
 *
 * `setTeams` deliberately does not hold the minimum, because an admin types
 * names one at a time and being told "you need two teams" while typing the
 * first is the validation that makes people stop using a form. A count is not
 * typed one team at a time: it is one number, chosen in full, so "between two
 * and eight" is answerable the moment it arrives (§8.1).
 *
 * ## Lowering it removes from the end, and may be refused
 *
 * The teams that go are the last by `sort` — the order the Teams tab shows and
 * the manager reorders — and they go through `removeTeamsIn`, so a team that
 * has won lots refuses the whole call rather than having its prices erased.
 * What a removal costs is reported *before* the write by
 * `previewTeamCountAction`, because by the time this returns the rosters are
 * gone (R-161 / UC-15 E1).
 */
export async function setTeamCount(
  eventId: string,
  count: number,
  database: Database = defaultDb
): Promise<DraftResult<SetTeamCountResult>> {
  if (!Number.isInteger(count) || count < MIN_TEAMS || count > MAX_TEAMS) {
    return fail(`An event needs between ${MIN_TEAMS} and ${MAX_TEAMS} teams.`);
  }

  return database.transaction(async (tx) => {
    // Locked, not merely read: `placeOnRoster` and the award path write
    // `team_members`, and the cascade from a deleted team takes those rows with
    // it. Two managers setting a count at once, or a count landing as a lot is
    // awarded, serialise on this row.
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    const config = await readConfig(tx, eventId);
    const existing = await readTeams(tx, eventId);

    if (count === existing.length) {
      return withData({ teams: existing, added: 0, removed: 0 });
    }

    if (count < existing.length) {
      const doomed = existing.slice(count);
      const refusal = await removeTeamsIn(tx, doomed);
      if (refusal) return fail(refusal);
      return withData({
        teams: await readTeams(tx, eventId),
        added: 0,
        removed: doomed.length,
      });
    }

    const taken = new Set(existing.map((team) => team.name.trim().toLowerCase()));
    for (let index = existing.length; index < count; index += 1) {
      const name = nextPlaceholderName(taken, index + 1);
      taken.add(name.toLowerCase());
      await tx.insert(teams).values({
        eventId,
        name,
        // The whole point of this path: the site wrote this name, so the site
        // may replace it when a captain is chosen (UC-15 4).
        nameIsCustom: false,
        seed: index + 1,
        balanceStart: config.defaultBalance,
        sort: index,
      });
    }

    return withData({
      teams: await readTeams(tx, eventId),
      added: count - existing.length,
      removed: 0,
    });
  });
}

export type CaptainInput = {
  teamId: string;
  /** Null clears the captaincy and frees the roster slot. */
  userId: string | null;
};

export type SetCaptainsResult = {
  teams: Team[];
  members: TeamMember[];
};

/**
 * Choose who leads each team.
 *
 * §14 settles what a captain *is*: a `team_members` row with `is_captain` true
 * and `price` 0, occupying a roster slot, never in the draft pool. So this
 * writes two things at once — the column on `teams` and the roster row — and
 * pulls the new captain out of the pool if they were sitting in it.
 *
 * A captain must be an **accepted applicant**. That is not a wall: §8.3's
 * override lives one layer up, in `setApplicationStatus`, so an admin who wants
 * somebody unusual to captain accepts them first and the intent is recorded
 * where it belongs rather than as a silent exception here.
 *
 * They must also clear the event's **captain rank rule** (R-59 / UC-15 3a),
 * and that check is in this transaction rather than in the screen that offers
 * the picker. The override for it is the same shape as the one above: an
 * `entry_waivers` row, written by a manager, audited by the action that writes
 * it — not a flag on the request, which is all a client-side confirmation
 * amounts to once you remember the action is a public endpoint.
 *
 * The whole assignment is applied in two passes because one person cannot lead
 * two teams: swapping two captains has to clear both before setting either, or
 * the unique constraint fires halfway through a legal change.
 */
export async function setCaptains(
  eventId: string,
  input: readonly CaptainInput[],
  database: Database = defaultDb
): Promise<DraftResult<SetCaptainsResult>> {
  return database.transaction(async (tx) => {
    // The row lock, for the reason `setTeams` and `placeOnRoster` take it:
    // this writes `team_members` as well as `teams`, and it is the same roster
    // the hand-placement path and the award path write.
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const eventTeams = await readTeams(tx, eventId);

    const locked = lockRefusal(event);
    if (locked) return fail(locked);
    const byId = new Map(eventTeams.map((team) => [team.id, team]));

    const errors: Record<string, string> = {};
    const wanted = new Map<string, string | null>();
    const claimed = new Set<string>();

    for (const assignment of input) {
      if (!byId.has(assignment.teamId)) {
        errors[assignment.teamId] = "That team belongs to a different event.";
        continue;
      }
      if (wanted.has(assignment.teamId)) {
        errors[assignment.teamId] = "That team is named twice.";
        continue;
      }
      if (assignment.userId !== null && claimed.has(assignment.userId)) {
        errors[assignment.teamId] = "One person cannot captain two teams.";
        continue;
      }
      if (assignment.userId !== null) claimed.add(assignment.userId);
      wanted.set(assignment.teamId, assignment.userId);
    }

    const userIds = [...claimed];
    if (userIds.length > 0) {
      // The one acceptance read, the same one the award path makes.
      const ok = await acceptedAmong(tx, eventId, userIds);

      const alreadyDrafted = await tx
        .select({
          userId: teamMembers.userId,
          teamId: teamMembers.teamId,
          isCaptain: teamMembers.isCaptain,
        })
        .from(teamMembers)
        .where(
          and(eq(teamMembers.eventId, eventId), inArray(teamMembers.userId, userIds))
        );
      // A captaincy this write is about to clear is not "already drafted": two
      // captains exchanging teams would otherwise each block the other.
      const reassigned = new Set(wanted.keys());
      const drafted = new Map(
        alreadyDrafted
          .filter((row) => !(row.isCaptain && reassigned.has(row.teamId)))
          .map((row) => [row.userId, row.teamId])
      );

      /*
       * UC-15 3a / R-59: the captain rank rule, enforced **here**.
       *
       * It used to be enforced nowhere. The Captains tab asked the manager to
       * confirm a below-bar pick and then sent the same payload either way, so
       * the rule was a dialog in one client — and a server action is a public
       * POST (see the Next.js server-actions guide's security notes), so
       * anything that skipped the dialog skipped the rule. The gate is now
       * read from the database on every write, and the only thing that opens it
       * is an `entry_waivers` row: a decision somebody took, recorded against
       * event + member + rule, and audited by the action that writes it.
       *
       * `meetsCaptainRule` rather than `canCaptain` deliberately — see its
       * docblock in events-policy. These candidates are accepted applicants, so
       * the *entry* rule has already been settled by whoever accepted them, and
       * folding it in again would refuse captains over a bar nobody is holding.
       */
      const gates = await gatesFor(tx, event, userIds);

      for (const [teamId, userId] of wanted) {
        if (userId === null) continue;
        if (!ok.has(userId)) {
          errors[teamId] =
            "A captain has to be an accepted applicant. Accept them on the Applicants tab first.";
          continue;
        }
        // No gate is a refusal, not a pass. `gatesFor` returns one per accepted
        // applicant and `ok` above has already established they are one, so a
        // missing gate is unreachable today — but the shape has to be the one
        // that fails closed, because the alternative is a rule that a lost row
        // switches off rather than a captain who has to be re-picked.
        const gate = gates.get(userId);
        if (!gate || !gate.eligibility.meetsCaptainRule) {
          errors[teamId] = `This event asks for ${
            event.minRankToCaptain ?? "a minimum rank"
          } to captain and they are ${
            gate?.rank ?? "unranked"
          }. Confirm the override to record a waiver for them, or pick somebody else.`;
          continue;
        }
        const on = drafted.get(userId);
        if (on !== undefined && on !== teamId) {
          errors[teamId] = "That player has already been drafted by another team.";
        }
      }
    }

    if (Object.keys(errors).length > 0) {
      return fail("Some of those captains need another look.", errors);
    }

    const touched = [...wanted.keys()];
    if (touched.length === 0) {
      return withData({
        teams: eventTeams,
        members: await readMembers(tx, eventId),
      });
    }

    /*
     * Names for the auto-title. Only the incoming captains are needed now:
     * whether a team's name is ours to replace is a column on the row
     * (`name_is_custom`), so the *previous* captain's display name — which
     * used to be one of the three things the old guess compared against — is
     * no longer read at all.
     */
    const nameIds = new Set<string>(claimed);
    const nameOf = new Map<string, string>();
    if (nameIds.size > 0) {
      const rows = await tx
        .select({
          id: users.id,
          displayName: users.displayName,
          name: users.name,
          handle: users.handle,
        })
        .from(users)
        .where(inArray(users.id, [...nameIds]));
      for (const row of rows) {
        nameOf.set(row.id, row.displayName ?? row.name ?? row.handle ?? "Captain");
      }
    }

    // Pass one: clear. Both the column and the roster row, so a captaincy that
    // moves does not leave the old holder occupying a slot on the old team.
    await tx
      .update(teams)
      .set({ captainUserId: null })
      .where(inArray(teams.id, touched));
    await tx
      .delete(teamMembers)
      .where(and(inArray(teamMembers.teamId, touched), eq(teamMembers.isCaptain, true)));

    /*
     * "Team Bob", unless somebody has said otherwise (R-63 / UC-15 4, 4a).
     *
     * A team is named before anyone knows who will lead it, so the name it
     * starts with is a placeholder — "Team 3", written by `setTeamCount`. Once
     * a captain is set that placeholder becomes their name, because that is
     * what everybody in the Discord will call the team anyway.
     *
     * **What decides it is `name_is_custom`, not the name.** It used to be the
     * name: empty, or `/^team\s+\d+$/i`, or equal to the previous captain's
     * auto name. That read a value to answer a question about where the value
     * came from, and the two are not the same question — so a manager who
     * typed "Team 3" had it silently rewritten at the next captain change
     * (UC-15 4a, and Task 18's acceptance criterion). The flag is written by
     * whoever wrote the name, which is the only place the answer exists.
     */
    const autoName = (person: string) => `Team ${person}`;
    const taken = new Set(
      eventTeams
        .filter((team) => !wanted.has(team.id))
        .map((team) => team.name.trim().toLowerCase())
    );

    // Pass two: set.
    for (const [teamId, userId] of wanted) {
      if (userId === null) continue;
      await tx.update(teams).set({ captainUserId: userId }).where(eq(teams.id, teamId));

      const team = byId.get(teamId);
      const current = team?.name.trim() ?? "";

      // `team === undefined` is unreachable — every id in `wanted` was checked
      // against `byId` above — and the shape still has to fail closed, because
      // the failure that matters is overwriting a name nobody asked us to.
      if (team !== undefined && !team.nameIsCustom) {
        const person = nameOf.get(userId);
        let proposed = person ? autoName(person) : current;
        // UC-15 6a: a *generated* name that clashes gets a distinguishing
        // suffix. Two captains answering to the same display name is an
        // ordinary Discord Tuesday, and a duplicate team name is something an
        // admin would then have to untangle by hand.
        if (proposed && taken.has(proposed.toLowerCase())) {
          proposed = `${proposed} (${team.seed ?? teamId.slice(0, 4)})`;
        }
        if (proposed && proposed !== current) {
          // The name stays ours: still generated, so the next captain change
          // follows the captaincy too (UC-15 4a's complement).
          await tx.update(teams).set({ name: proposed }).where(eq(teams.id, teamId));
          taken.add(proposed.toLowerCase());
        }
      }
      await tx
        .insert(teamMembers)
        .values({ teamId, eventId, userId, price: 0, isCaptain: true, lotId: null })
        .onConflictDoUpdate({
          target: [teamMembers.teamId, teamMembers.userId],
          set: { isCaptain: true, price: 0, lotId: null },
        });
      // §14: a captain never enters the pool.
      await tx
        .delete(draftPoolEntries)
        .where(
          and(eq(draftPoolEntries.eventId, eventId), eq(draftPoolEntries.userId, userId))
        );
    }

    return withData({
      teams: await readTeams(tx, eventId),
      members: await readMembers(tx, eventId),
    });
  });
}

/* ------------------------------------------------------------------ */
/* Rosters by hand (UC-15 5, 6)                                       */
/* ------------------------------------------------------------------ */

/**
 * Which event a team belongs to.
 *
 * The same shape as the resolvers in `src/lib/event-scope.ts`, and here for the
 * same reason its docblock gives: **authorise on the row you are about to
 * write, never on an id beside it.** `placeOnRoster` is keyed on a team, so the
 * action resolves the event *from that team* and never trusts an `eventId` the
 * browser sent alongside it — otherwise a host satisfies the guard with their
 * own event and names somebody else's team in the write.
 *
 * It lives here rather than in `event-scope.ts` because `teams` is this
 * module's table; the rule is the imported one.
 */
export async function eventIdOfTeam(
  teamId: string,
  database: Database = defaultDb
): Promise<string | null> {
  const [row] = await database
    .select({ eventId: teams.eventId })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1);
  return row?.eventId ?? null;
}

export type RosterPlacement = {
  /** The row as it now stands, or `null` once they are off every roster. */
  member: TeamMember | null;
  /** The team they were on before this call, if any. */
  fromTeamId: string | null;
  /** The team they are on after it, or `null`. */
  toTeamId: string | null;
};

/**
 * Everything a hand placement has to be true of before a row is written, read
 * inside the caller's transaction and with the event already locked.
 *
 * Shared by `placeOnRoster` and `removeFromRoster` so that the two cannot
 * disagree about what a captain is or about who the draft owns. Returns the
 * member row this player already has (possibly `null`), or a refusal.
 */
async function rosterGuard(
  tx: Database,
  event: EventRow,
  userId: string
): Promise<{ ok: true; member: TeamMember | null } | { ok: false; error: string }> {
  const locked = lockRefusal(event);
  if (locked) return { ok: false, error: locked };

  /*
   * Once the draft has started, rosters belong to it.
   *
   * **No use-case line says this in so many words**, and it used to cite UC-15
   * 5a, which does not: 5a is the *manager* skipping step 5 because the event
   * uses a draft ("players are placed by UC-16"), an instruction to a person
   * rather than a refusal by the server. The rule this enforces is the one
   * UC-16 6-7 implies by owning what a roster is from the first lot onwards: a
   * seat is won and paid for there, and the way to take one back is the undo
   * UC-16 7a gives — void the lot, which is what the sentence below asks for
   * (R-66, R-67). Hand placement is R-61's "events without a draft", and this
   * is where the two stop overlapping.
   *
   * "Has ever opened a lot", the same question `setDraftConfig` asks for
   * UC-16 1a — not "is a lot open now". A hand placement between two lots is
   * still a seat appearing in a draft the room is watching, and it moves
   * `rosterState`, which is what every remaining bid is checked against. Before
   * the first lot it is ordinary setup: `setDraftPool` leaves anybody already
   * on a roster out of the pool, so a pre-placed player is simply not for sale.
   */
  if (await draftHasBegun(tx, event.id)) {
    return {
      ok: false,
      error:
        "The draft has started, so rosters are filled in the draft room. Void the lots first if a roster has to be changed by hand.",
    };
  }

  const [member] = await tx
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.eventId, event.id), eq(teamMembers.userId, userId)))
    .limit(1);

  if (member === undefined) return { ok: true, member: null };

  // §14: a captain is a roster row, but it is `teams.captain_user_id` that
  // makes them one. Moving the row on its own would leave a team led by
  // somebody sitting on another roster, so the captaincy is changed where it
  // is stored (UC-15 3).
  if (member.isCaptain) {
    return {
      ok: false,
      error: "They captain this team. Change the captain on the Captains tab instead.",
    };
  }

  // A row with a lot behind it is a price somebody paid. Unreachable while the
  // refusal above holds — a lot cannot exist without the draft having begun —
  // and kept because it is the invariant, not the consequence: it is what makes
  // "nothing destructive" true of this path even if the gate above ever moves.
  if (member.lotId !== null || member.price > 0) {
    return {
      ok: false,
      error:
        "They were won in the draft, so moving them by hand would erase what was paid. Void that lot first.",
    };
  }

  return { ok: true, member };
}

/**
 * Put an accepted player on a roster, or move them to another one — UC-15 5.
 *
 * ## Only accepted players, checked against the row being written
 *
 * A roster place is a seat at the event. A waitlisted or declined member on one
 * is a seat given away by the back door — they were never accepted, so nothing
 * on the Applicants tab says they are playing, and every count on the site that
 * reads rosters would then disagree with the one that reads applications.
 *
 * So acceptance is re-read here, inside the transaction, on the event the
 * *team* belongs to. UC-15 5's "the remaining players" are what is left of the
 * accepted applicants that step 3 drew the captains from, and R-61 asks for
 * those rosters to be settable by hand — not for a side door into the event.
 * It is the same wall `setCaptains` holds for R-62's "from the accepted
 * applicants", and the override is the same one: accept them on the Applicants
 * tab, where accepting somebody unusual is recorded as a decision rather than
 * smuggled in as a roster row.
 *
 * ## One row, moved, never deleted and re-inserted
 *
 * A move is an `update` of `team_id` on the row the player already has. Two
 * managers moving the same player at once therefore cannot duplicate them —
 * `team_members_event_user_uniq` would refuse the second insert anyway, but the
 * second manager would have had to *handle* that refusal, and a delete-then-
 * insert pair has a window in the middle where the player is on no roster at
 * all. With the event's row lock taken first, the second call simply reads the
 * row the first one wrote and moves it again: one row throughout, and the last
 * manager's choice wins, which is what two people clicking means.
 *
 * ## What it does not do
 *
 * It does not touch the draft pool except to take the player out of it, for the
 * reason `setDraftPool` does the same: somebody on a roster is not still for
 * sale. Taking them *off* a roster does not put them back in the pool —
 * re-seeding is its own action, and inventing a pool entry here would decide
 * something the manager has not been asked.
 */
export async function placeOnRoster(
  eventId: string,
  userId: string,
  teamId: string,
  database: Database = defaultDb
): Promise<DraftResult<RosterPlacement>> {
  return database.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    // Nothing here believes the request: the team is re-read with the event id
    // in the predicate, so a team from another event is refused rather than
    // written to.
    const [team] = await tx
      .select()
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.eventId, eventId)))
      .limit(1);
    if (!team) return fail("That team is not in this event.");

    const guard = await rosterGuard(tx, event, userId);
    if (!guard.ok) return fail(guard.error);

    // The same read the award path makes on the row it is about to write.
    if ((await seatStatus(tx, eventId, userId)) !== "accepted") {
      return fail(
        "Only an accepted applicant can be put on a roster. Accept them on the Applicants tab first."
      );
    }

    // Already there. Not an error: it is what the loser of a race between two
    // managers choosing the same team asked for, and what a double-clicked
    // button asks for twice.
    if (guard.member && guard.member.teamId === teamId) {
      return withData({ member: guard.member, fromTeamId: teamId, toTeamId: teamId });
    }

    const config = await readConfig(tx, eventId);
    const members = await readMembers(tx, eventId);
    // R-64's roster size, with the captain counted in it (§14).
    const roster = rosterState(team, asMemberViews(members), config);
    if (roster.full) {
      return fail(
        `${team.name}'s roster is full — ${roster.size} of ${roster.target}. Take somebody off it first, or raise the roster size on the Draft tab.`
      );
    }

    const [written] = guard.member
      ? await tx
          .update(teamMembers)
          .set({ teamId })
          .where(eq(teamMembers.id, guard.member.id))
          .returning()
      : await tx
          .insert(teamMembers)
          .values({ teamId, eventId, userId, price: 0, isCaptain: false, lotId: null })
          .returning();

    await tx
      .delete(draftPoolEntries)
      .where(and(eq(draftPoolEntries.eventId, eventId), eq(draftPoolEntries.userId, userId)));

    return withData({
      member: written,
      fromTeamId: guard.member?.teamId ?? null,
      toTeamId: teamId,
    });
  });
}

/**
 * Take a player off a roster — the other half of UC-15 5.
 *
 * `teamId` is the team the manager is looking at, and it has to match the row:
 * a stale screen asking to remove somebody from a team they have since been
 * moved off would otherwise take them off whichever roster they are on now.
 * The same guard as `placeOnRoster`, so a captain and a drafted player are
 * refused here too.
 */
export async function removeFromRoster(
  eventId: string,
  userId: string,
  teamId: string,
  database: Database = defaultDb
): Promise<DraftResult<RosterPlacement>> {
  return database.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const guard = await rosterGuard(tx, event, userId);
    if (!guard.ok) return fail(guard.error);
    if (!guard.member) return fail("They are not on a roster.");
    if (guard.member.teamId !== teamId) {
      return fail("They have already been moved off that team. Reload and try again.");
    }

    await tx.delete(teamMembers).where(eq(teamMembers.id, guard.member.id));

    return withData({ member: null, fromTeamId: teamId, toTeamId: null });
  });
}

/* ------------------------------------------------------------------ */
/* Configuration                                                      */
/* ------------------------------------------------------------------ */

/**
 * The rules in the admin's words, for the refusal UC-16 1a produces.
 *
 * A message naming `bidTimerSeconds` is a message written for whoever wrote
 * the schema. These are the labels the Draft tab puts on the same controls, so
 * the sentence points at something the reader can see on their screen.
 */
const RULE_LABELS: Record<keyof DraftConfig, string> = {
  balanceMode: "the balance mode",
  defaultBalance: "the starting balance",
  biddingMode: "sealed or open bidding",
  minBid: "the minimum bid",
  minIncrement: "the bid increment",
  bidTimerSeconds: "the bid timer",
  selectionMode: "who goes up next",
  reserveEnabled: "the reserve pool",
  reserveRounds: "the reserve rounds",
  rosterTarget: "the roster size",
  mustFillRoster: "the roster-fill protection",
  bidVisibility: "who sees bids",
};

export type SetDraftConfigResult = {
  config: DraftConfig;
  /** Teams whose starting balance the change rewrote. */
  rebalanced: number;
};

/** The rules for this event, or the defaults when it has never been configured. */
export async function getDraftConfig(
  eventId: string,
  database: Database = defaultDb
): Promise<DraftConfig> {
  return readConfig(database, eventId);
}

/**
 * Write the draft rules. Only the keys present in `patch` change.
 *
 * One side effect is deliberate and worth knowing about: under a `uniform`
 * balance mode, changing the default balance rewrites every team's starting
 * balance, because a mode that says "everybody has the same" and a set of teams
 * that disagree is not a state worth being able to reach. It refuses to do so
 * **once a lot has been awarded**, since moving the starting line mid-draft
 * would silently rewrite what every team can still afford.
 *
 * ## The rules lock when the first lot opens (UC-16 1a)
 *
 * Not when the first lot is *awarded*, which is where the refusals above stop,
 * and not when the draft is created. The moment a name goes up on the wheel,
 * captains are deciding what to offer against a published set of rules — a
 * minimum bid, a timer, a must-fill switch, a roster size — and every one of
 * those changes what a bid means. Moving them underneath a live room is not a
 * correction, it is a different draft.
 *
 * So every key of `DraftConfig` is frozen from the first `openLot`, and the
 * refusal names the settings that would have moved rather than saying no in
 * general. A save that changes nothing still goes through: the admin screen
 * posts the whole form back, and refusing an identical re-save would tell an
 * admin the draft is broken when they have done nothing at all.
 */
export async function setDraftConfig(
  eventId: string,
  patch: Partial<DraftConfig>,
  database: Database = defaultDb
): Promise<DraftResult<SetDraftConfigResult>> {
  return database.transaction(async (tx) => {
    // The row lock before the status that decides, for the reason `setTeams`
    // takes it: a plain read of `status` is answered from a snapshot taken
    // before this transaction queued, so an admin marking the event finished
    // while it waited committed *after* the read and *before* these writes —
    // and the rules of a finished draft moved anyway (R-39 / UC-09 6b).
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const current = await readConfig(tx, eventId);

    const locked = lockRefusal(event);
    if (locked) return fail(locked);
    const next = draftConfigFrom({ ...current, ...patch });

    const awarded = await tx
      .select({ id: draftLots.id })
      .from(draftLots)
      .where(and(eq(draftLots.eventId, eventId), eq(draftLots.status, "awarded")))
      .limit(1);
    const started = awarded.length > 0;

    if (started && next.rosterTarget < current.rosterTarget) {
      return fail(
        "The draft has already awarded players, so the roster size cannot be lowered now."
      );
    }

    // UC-16 1a. Checked after the sentence above so that the commonest mistake
    // — reaching for the roster size mid-draft — still gets the answer that
    // says what is wrong with *that* rather than a list.
    const moved = changedRules(current, next);
    if (moved.length > 0 && (await draftHasBegun(tx, eventId))) {
      return fail(
        `The draft has already started, so its rules are fixed. ${moved
          .map((key) => RULE_LABELS[key])
          .join(", ")} cannot change now — captains have been bidding under the ones on the board.`
      );
    }

    await tx
      .insert(draftConfigs)
      .values({ eventId, ...next, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: draftConfigs.eventId,
        set: { ...next, updatedAt: new Date() },
      });

    let rebalanced = 0;
    if (next.balanceMode === "uniform" && !started) {
      const stale = await tx
        .select({ id: teams.id })
        .from(teams)
        .where(and(eq(teams.eventId, eventId), ne(teams.balanceStart, next.defaultBalance)));
      if (stale.length > 0) {
        await tx
          .update(teams)
          .set({ balanceStart: next.defaultBalance })
          .where(
            inArray(
              teams.id,
              stale.map((team) => team.id)
            )
          );
        rebalanced = stale.length;
      }
    }

    return withData({ config: next, rebalanced });
  });
}

/* ------------------------------------------------------------------ */
/* The pool                                                           */
/* ------------------------------------------------------------------ */

export type SetDraftPoolInput = {
  /**
   * The exact list. Absent seeds it from the event's accepted applications, in
   * the order they applied — which is what the admin screen does on first open.
   */
  userIds?: readonly string[];
  /** Leave anybody already sitting in the reserve pool where they are. */
  keepReserve?: boolean;
};

export type SetDraftPoolResult = {
  main: number;
  reserve: number;
  added: string[];
  removed: string[];
};

/**
 * Write the draft pool.
 *
 * Seeded from the accepted applications and **excluding captains and anyone
 * already on a roster** — §14's rule that a captain never enters the pool, plus
 * the obvious one that a player already bought is not still for sale.
 *
 * Existing rows are kept rather than replaced, so somebody who has been moved
 * to the reserve pool stays there across a reseed (`keepReserve`, on by
 * default). Anyone on the block right now cannot be removed: settle their lot
 * first, or the open lot would point at a player who is no longer in the draft.
 */
export async function setDraftPool(
  eventId: string,
  input: SetDraftPoolInput = {},
  database: Database = defaultDb
): Promise<DraftResult<SetDraftPoolResult>> {
  return database.transaction(async (tx) => {
    // Locked before the status is read, the rule the rest of this module
    // follows: this deletes pool entries and inserts others, and a plain read
    // of `status` cannot see a completion that commits while the transaction
    // queues for the lock (R-39 / UC-09 6b).
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const members = await readMembers(tx, eventId);

    const locked = lockRefusal(event);
    if (locked) return fail(locked);
    const drafted = new Set(members.map((member) => member.userId));

    let candidates: string[];
    if (input.userIds) {
      const seen = new Set<string>();
      candidates = [];
      for (const userId of input.userIds) {
        if (seen.has(userId)) continue;
        seen.add(userId);
        candidates.push(userId);
      }

      const known = await tx
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, candidates.length > 0 ? candidates : [eventId]));
      const knownIds = new Set(known.map((row) => row.id));
      const stranger = candidates.find((userId) => !knownIds.has(userId));
      if (stranger) return fail("We do not have an account for one of those players.");
    } else {
      const accepted = await tx
        .select({ userId: applications.userId })
        .from(applications)
        .where(and(eq(applications.eventId, eventId), eq(applications.status, "accepted")))
        .orderBy(asc(applications.submittedAt), asc(applications.id));
      candidates = accepted.map((row) => row.userId);
    }

    const target = candidates.filter((userId) => !drafted.has(userId));
    const targetSet = new Set(target);

    const existing = await readPool(tx, eventId);
    const existingByUser = new Map(existing.map((entry) => [entry.userId, entry]));

    const openLot = await readOpenLot(tx, eventId);
    if (openLot && !targetSet.has(openLot.playerUserId) && existingByUser.has(openLot.playerUserId)) {
      return fail("Somebody is on the block. Settle that lot before changing the pool.");
    }

    const removed = existing
      .filter((entry) => !targetSet.has(entry.userId))
      .map((entry) => entry.userId);
    if (removed.length > 0) {
      await tx
        .delete(draftPoolEntries)
        .where(
          and(
            eq(draftPoolEntries.eventId, eventId),
            inArray(draftPoolEntries.userId, removed)
          )
        );
    }

    const keepReserve = input.keepReserve !== false;
    const added: string[] = [];
    let mainSort = 0;

    for (const userId of target) {
      const entry = existingByUser.get(userId);
      const kind: DraftPoolKind = entry && keepReserve ? entry.kind : "main";
      if (entry) {
        await tx
          .update(draftPoolEntries)
          .set({ kind, sort: kind === "main" ? mainSort : entry.sort })
          .where(eq(draftPoolEntries.id, entry.id));
      } else {
        await tx.insert(draftPoolEntries).values({ eventId, userId, kind: "main", sort: mainSort });
        added.push(userId);
      }
      if (kind === "main") mainSort += 1;
    }

    const written = await readPool(tx, eventId);
    return withData({
      main: written.filter((entry) => entry.kind === "main").length,
      reserve: written.filter((entry) => entry.kind === "reserve").length,
      added,
      removed,
    });
  });
}

/**
 * The pool as it stands, both halves, in wheel order.
 *
 * **As the manager left it**, including anybody whose application has since
 * moved on. This is the read behind the Draft tab's pool editor, and that
 * screen is where the manager fixes a pool — hiding a row from the person who
 * put it there would mean their next save silently dropped it, which is the
 * eager pruning this fix deliberately refuses. The draft *room* is the other
 * side of that coin: `getDraftSnapshot` leaves a stale entry out of the wheel,
 * because there the pool is a list of lots to open.
 */
export async function getDraftPool(
  eventId: string,
  database: Database = defaultDb
): Promise<{ main: PoolPlayer[]; reserve: PoolPlayer[] }> {
  const rows = await readPool(database, eventId);
  const asPlayer = (entry: DraftPoolEntry): PoolPlayer => ({
    userId: entry.userId,
    kind: entry.kind,
    sort: entry.sort,
  });
  return {
    main: rows.filter((entry) => entry.kind === "main").map(asPlayer),
    reserve: rows.filter((entry) => entry.kind === "reserve").map(asPlayer),
  };
}

/**
 * Move one player between the main and reserve pools before the draft reaches
 * them — the admin deciding up front that somebody is held over.
 *
 * This is deliberately not the same act as `moveToReserve`, which closes an open
 * lot and belongs in the history because it happened *during* the draft, in
 * front of everyone. Setting up the pool beforehand is bookkeeping and should
 * leave no lot behind; composing the two would record a spin that never
 * happened and cost two transactions to undo.
 *
 * A no-op when the player is already in that pool. Refuses anyone who has
 * already been drafted, since their place is a roster row, not a pool entry.
 *
 * ## "Before the draft" is meant literally (R-148 / UC-16 E6a)
 *
 * R-148 is the manager moving players between the pools *before the draft*, and
 * E6a says the same move after the first lot has opened is refused. That is not
 * bureaucracy: the wheel everyone is looking at is the main pool, the reserve
 * pool is the promise that the cheap names come round again, and silently
 * moving somebody between the two mid-draft changes who is still for sale
 * without a lot to show for it. During the draft there is a way to do this that
 * leaves a trace — put them up and hold them over (`moveToReserve`), which is
 * UC-16 6a and appears in the history.
 */
export async function setPoolKind(
  eventId: string,
  userId: string,
  kind: DraftPoolKind,
  database: Database = defaultDb
): Promise<DraftResult<{ main: PoolPlayer[]; reserve: PoolPlayer[]; moved: boolean }>> {
  return database.transaction(async (tx) => {
    // The lock first, then the status, then the write — `setDraftPool`'s
    // reasoning, about the same two tables (R-39 / UC-09 6b).
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const entries = await readPool(tx, eventId);

    const locked = lockRefusal(event);
    if (locked) return fail(locked);
    const entry = entries.find((row) => row.userId === userId);
    if (!entry) {
      const [member] = await tx
        .select()
        .from(teamMembers)
        .where(and(eq(teamMembers.eventId, eventId), eq(teamMembers.userId, userId)))
        .limit(1);
      return fail(
        member
          ? "That player is already on a team. Undo the lot that put them there first."
          : "That player is not in this draft's pool."
      );
    }

    if (entry.kind !== kind) {
      if (await draftHasBegun(tx, eventId)) {
        return fail(
          "The draft has started, so the pools are fixed. Put them up and hold them over to the reserve pool instead — that way the room sees it."
        );
      }
      await tx
        .update(draftPoolEntries)
        .set({ kind, sort: nextSort(entries, kind) })
        .where(eq(draftPoolEntries.id, entry.id));
    }

    const pool = await getDraftPool(eventId, tx);
    return withData({ ...pool, moved: entry.kind !== kind });
  });
}

/* ------------------------------------------------------------------ */
/* Lots                                                               */
/* ------------------------------------------------------------------ */

export type OpenLotInput = {
  /** Put this player up. Absent, the wheel picks one from `kind`. */
  userId?: string;
  /** Which pool to draw from. Absent: main while it has anyone, else reserve. */
  kind?: DraftPoolKind;
  openedBy?: string | null;
  now?: Date;
  /**
   * Where the wheel lands, injected so a test can pin a spin. Defaults to
   * `crypto.randomInt`, which is the same source the current board uses.
   */
  pick?: (length: number) => number;
};

/** Where the wheel lands. `crypto.randomInt`, as the current board uses. */
function defaultPick(length: number): number {
  return randomInt(0, length);
}

/**
 * Put a player on the block.
 *
 * The player **stays in the pool** until the lot settles, exactly as the
 * current board leaves them on the wheel until the admin awards or discards
 * them: an abandoned lot then costs nothing to unwind.
 *
 * A spin is recorded in full — the pool as it stood, the landing index, the
 * start instant, the duration and the turn count — which is what lets every
 * browser draw the same wheel at the same angle, and lets one that opens late
 * replay it rather than guess.
 *
 * Only one lot may be open per event. That is checked here *and* enforced by a
 * partial unique index, because two admins clicking spin at the same moment is
 * a race no screen can see.
 *
 * ## Three refusals the wheel used not to have
 *
 * **Every roster full** (UC-16 8). The draft ends when the rosters are full or
 * the pool is empty; opening a lot once every seat is taken puts a name on the
 * board that nobody may bid on — `canPlaceBid` refuses every captain with
 * `roster_full` — and the only way out is to cancel it. `draftComplete` already
 * knows the answer, so the wheel asks it before it turns.
 *
 * **The reserve pool's comeback limit** (R-144 / UC-16 E2). A player who has
 * had their configured number of turns on the second wheel is out of the draft,
 * so they are not a candidate for it. Named explicitly they get a sentence
 * saying so; left to the wheel they are simply not on it, which is what the
 * room sees too.
 *
 * **A seat the event has taken away** (R-66 / UC-16 pre1, 7).
 * The pool is a snapshot of the accepted applicants and nothing invalidates
 * it, so a player declined, waitlisted or withdrawn after it was seeded is
 * still sitting in it. They are not for sale: `awardLot` refuses to seat them,
 * so opening the lot could only ever end in a refusal in front of the room.
 * The same two shapes as the comeback limit — named, a sentence saying which
 * of the three it is; left to the wheel, off it.
 */
export async function openLot(
  eventId: string,
  input: OpenLotInput = {},
  database: Database = defaultDb
): Promise<DraftResult<DraftLot>> {
  const now = input.now ?? new Date();

  return database.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");

    const already = await readOpenLot(tx, eventId);

    const locked = lockRefusal(event);
    if (locked) return fail(locked);
    if (already) return fail("Somebody is already on the block. Settle that lot first.");

    const config = await readConfig(tx, eventId);
    const pool = await readPool(tx, eventId);
    /*
     * The pool, minus anybody the event has since let go (R-66 / UC-16 pre1,
     * 7).
     *
     * Read here, inside the lock, never stored: the entries themselves are
     * left exactly as the manager built them. Pruning them on a decline is the
     * tempting fix and the wrong one — a decline would then silently rewrite a
     * pool somebody else assembled, and this project refuses that kind of
     * quiet change everywhere else. So the pool keeps the row and this read
     * decides what is for sale.
     *
     * Everything below the split works off `live`: the wheel, the fall-through
     * from the main pool to the reserve, and the "is the draft over" question.
     * A main pool holding nothing but stale entries is empty as far as all
     * three are concerned, which is the truth — there is nobody in it anybody
     * may bid on.
     */
    const stillAccepted = await acceptedAmong(tx, eventId, pool.map((entry) => entry.userId));
    const live = pool.filter((entry) => stillAccepted.has(entry.userId));
    const main = live.filter((entry) => entry.kind === "main");
    const reserve = live.filter((entry) => entry.kind === "reserve");

    // UC-16 8: the draft is over when every roster is full, so there is nothing
    // to put up. Asked of the real rosters rather than of a counter, because a
    // voided award frees a seat and the count would not know.
    const teamRows = await readTeams(tx, eventId);
    const memberViews = asMemberViews(await readMembers(tx, eventId));
    const completion = draftComplete(
      { main: main.length, reserve: reserve.length },
      teamRows.map((team) => ({
        id: team.id,
        members: memberViews.filter((member) => member.teamId === team.id),
      })),
      config
    );
    if (completion.reason === "rosters_full" || completion.reason === "both") {
      return fail("Every roster is full, so there is nobody left to bid on them.");
    }

    const kind: DraftPoolKind =
      input.kind ?? (main.length > 0 ? "main" : config.reserveEnabled ? "reserve" : "main");
    if (kind === "reserve" && !config.reserveEnabled) {
      return fail("The reserve pool is switched off for this event.");
    }

    // R-144: on the reserve wheel, anybody out of comebacks is out of the draft
    // and off the wheel. The main wheel is untouched — the limit counts turns
    // taken *from* the reserve pool, and a first appearance is not one.
    const lotsSoFar = kind === "reserve" ? await readLots(tx, eventId) : [];
    const candidates = (kind === "main" ? main : reserve).filter(
      (entry) =>
        kind === "main" || mayComeBackAgain(reserveTurnsUsed(lotsSoFar, entry.userId), config)
    );
    let index: number;
    if (input.userId) {
      // Asked before "is the pool empty", so a named player who is out of
      // comebacks is told *that* rather than that the wheel has run out —
      // which is the same sentence for two quite different situations.
      index = candidates.findIndex((entry) => entry.userId === input.userId);
      if (index === -1) {
        /*
         * Named, pooled, and no longer accepted. Told *that*, rather than that
         * they are not in the pool — they are, the manager can see them on the
         * Draft tab, and "not in that pool" would send somebody looking for a
         * row that is sitting there.
         *
         * Refusing to open it at all is the honest answer (UC-16 4, 7): the
         * room would otherwise be shown a lot nobody may win, because the award
         * below cannot settle it, and a lot that cannot be awarded wastes the
         * one thing a draft room has — everybody's attention.
         */
        const named = input.userId;
        if (pool.some((entry) => entry.userId === named)) {
          // Asked of the row rather than of `stillAccepted`, which is the same
          // answer from the same transaction under the same lock — but it is
          // the status itself that the sentence has to name, and reading it
          // once is what lets `noSeatPhrase` refuse to be handed `accepted`.
          const seat = await seatStatus(tx, eventId, named);
          if (seat !== "accepted") {
            const phrase = noSeatPhrase(await displayNameOf(tx, named), seat);
            return fail(
              `${phrase}, so there is no seat to bid on. Accept them again on the Applicants tab, or take them out of the pool.`
            );
          }
        }
        const spent =
          kind === "reserve" && reserve.some((entry) => entry.userId === input.userId);
        return fail(
          spent
            ? `That player has already come back ${config.reserveRounds === 1 ? "once" : `${config.reserveRounds} times`}, which is all this draft allows.`
            : "That player is not in that pool."
        );
      }
    } else if (candidates.length === 0) {
      return fail("That pool is empty.");
    } else if (config.selectionMode === "fixed_order") {
      index = 0;
    } else if (config.selectionMode === "admin_pick") {
      return fail("This draft is set to admin picks, so name the player.");
    } else {
      const pick = input.pick ?? defaultPick;
      index = pick(candidates.length);
      if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
        return fail("The wheel landed outside the pool, which should be impossible.");
      }
    }

    const chosen = candidates[index];
    const spin: DraftSpin | null =
      config.selectionMode === "wheel" && !input.userId
        ? {
            pool: candidates.map((entry) => entry.userId),
            targetIndex: index,
            startedAt: now.getTime(),
            durationMs: SPIN_DURATION_MS,
            turns: SPIN_TURNS,
          }
        : null;

    const [lot] = await tx
      .insert(draftLots)
      .values({
        eventId,
        playerUserId: chosen.userId,
        status: "open",
        fromKind: kind,
        openedAt: now,
        openedBy: input.openedBy ?? null,
        spin,
      })
      .returning();

    return withData(lot);
  });
}

export type PlaceBidResult = {
  bid: DraftBid;
  /** The team's balance, unchanged — a bid is a promise, not a payment. */
  balance: number;
  /** Their cap, so the panel can show what is left to play with. */
  max: number;
};

/**
 * A captain's bid on the open lot.
 *
 * Everything this decides — the balance, the roster, the standing bid, the cap
 * — is read inside the event's row lock and written inside it too. Splitting
 * those apart is how two overlapping bids end up merged into one, or how a bid
 * gets checked against a balance that changed while it was being checked.
 *
 * A sealed bid is final: the unique index on (lot, team) means a double-clicked
 * submit cannot produce two, and the check above it means the second click gets
 * a sentence rather than a constraint violation. Open bidding raises the same
 * row, so "what did they bid" never needs a max over a history.
 */
export async function placeBid(
  lotId: string,
  teamId: string,
  amount: number,
  options: { now?: Date } = {},
  database: Database = defaultDb
): Promise<DraftResult<PlaceBidResult>> {
  const now = options.now ?? new Date();

  return database.transaction(async (tx) => {
    const [peek] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!peek) return fail("That lot no longer exists.");

    const event = await lockEvent(tx, peek.eventId);
    if (!event) return fail("That event no longer exists.");

    // Re-read inside the lock: between the peek and the lock somebody else's
    // transaction may have awarded it.
    const [lot] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!lot) return fail("That lot no longer exists.");
    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    const [team] = await tx
      .select()
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.eventId, lot.eventId)))
      .limit(1);
    if (!team) return fail("That team is not in this draft.");

    const config = await readConfig(tx, lot.eventId);
    const members = await readMembers(tx, lot.eventId);
    const lots = await readLots(tx, lot.eventId);
    const bids = await readBids(tx, lotId);

    const balance = balanceFor(team, asLotViews(lots));
    const roster = rosterState(team, asMemberViews(members), config);

    const check = canPlaceBid(
      { id: team.id, balance },
      amount,
      {
        status: lot.status,
        openedAt: lot.openedAt,
        // The timer runs from when the wheel stops, so the spin has to travel too.
        spin: lot.spin,
        bids: bids.map((bid) => ({ teamId: bid.teamId, amount: bid.amount })),
      },
      config,
      roster,
      now
    );
    if (!check.ok) return fail(check.message);

    const [written] = await tx
      .insert(draftBids)
      .values({ lotId, teamId, amount, placedAt: now })
      .onConflictDoUpdate({
        target: [draftBids.lotId, draftBids.teamId],
        set: { amount, placedAt: now },
      })
      .returning();

    return withData({ bid: written, balance, max: check.max });
  });
}

/**
 * Take a bid back off a lot. Admin only — a captain's bid is their word.
 *
 * ## Every deciding read is taken after the lock
 *
 * The first select asks one question — which event is this — because the lock
 * has to be named before it can be taken, and `clearBids` beneath this is the
 * same shape. Both of the things this function decides on come from under the
 * lock: the event's status, and the lot's.
 *
 * It deletes a row, so it needs the same refusal as the rest: an open lot can
 * outlive the moment an admin marked the event finished, and a bid is
 * somebody's word. Read before the lock, that status is answered from a
 * snapshot taken before this transaction queued — so a completion committing
 * while it waited was invisible, and the bid went anyway (R-39 / UC-09 6b).
 * The lot's own status is under the lock for the matching reason: an award
 * committing in that window settles the lot, and clearing a bid off a settled
 * lot rewrites what the winner paid.
 */
export async function clearBid(
  lotId: string,
  teamId: string,
  database: Database = defaultDb
): Promise<DraftResult<{ cleared: boolean }>> {
  return database.transaction(async (tx) => {
    const [peek] = await tx
      .select({ id: draftLots.id, eventId: draftLots.eventId })
      .from(draftLots)
      .where(eq(draftLots.id, lotId))
      .limit(1);
    if (!peek) return fail("That lot no longer exists.");

    const event = await lockEvent(tx, peek.eventId);
    if (!event) return fail("That event no longer exists.");

    const [lot] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!lot) return fail("That lot no longer exists.");
    if (lot.status !== "open") return fail("That lot has already settled.");
    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    const removed = await tx
      .delete(draftBids)
      .where(and(eq(draftBids.lotId, lotId), eq(draftBids.teamId, teamId)))
      .returning({ id: draftBids.id });

    return withData({ cleared: removed.length > 0 });
  });
}

/**
 * Take **every** bid off the open lot — the other half of R-147, UC-16 E5.
 *
 * One statement inside one transaction rather than a loop of `clearBid` calls.
 * A loop is a sequence of separate transactions, so a bid placed between two of
 * them survives a command whose whole point is that none do, and the room is
 * left with one bid on a lot the manager believes is clear. The same lock the
 * rest of this module takes is what makes "all of them" mean all of them.
 *
 * The count comes back so the console can say what happened: "3 bids cleared"
 * and "there was nothing to clear" are different pieces of news, and a manager
 * who pressed the button by mistake wants to be told which.
 */
export async function clearBids(
  lotId: string,
  database: Database = defaultDb
): Promise<DraftResult<{ cleared: number }>> {
  return database.transaction(async (tx) => {
    const [peek] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!peek) return fail("That lot no longer exists.");

    const event = await lockEvent(tx, peek.eventId);
    if (!event) return fail("That event no longer exists.");

    const [lot] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!lot) return fail("That lot no longer exists.");
    if (lot.status !== "open") return fail("That lot has already settled.");
    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    const removed = await tx
      .delete(draftBids)
      .where(eq(draftBids.lotId, lotId))
      .returning({ id: draftBids.id });

    return withData({ cleared: removed.length });
  });
}

export type AwardLotResult = {
  lot: DraftLot;
  member: TeamMember;
  /** What the winning team has left afterwards. */
  balance: number;
};

/**
 * Give the player to a team at their bid.
 *
 * The price is the team's own bid, never a number the caller supplies: an
 * admin who wants a different figure should clear the bid and have it placed
 * again, so the amount on the record is always one a captain actually offered.
 * Breaking a tie is therefore naming the team, which is exactly what
 * `resolveLot` asks an admin to do.
 *
 * ## And only to the highest (UC-16 6)
 *
 * "Awards it to the highest bid" is the use case's step 7, not a default. Until
 * now the only check was that the named team had bid *at all*, so a mis-aimed
 * click on a console listing every bidder sold a player to the team that
 * offered least — for their own lower bid, in front of a room that had watched
 * somebody else win. `awardableTeamIds` is the same answer the console uses to
 * decide which buttons to offer, asked again here because the console is not
 * the authority and a stale payload is one click behind the bids.
 *
 * The exception is the only one UC-16 gives: on a tie (6b) every tied team is
 * awardable and the manager picks. That is discretion between equal offers, not
 * discretion about the price.
 *
 * Deducting exactly once is not enforced by arithmetic here — nothing is
 * decremented. The lot *is* the deduction, and `balanceFor` sums the awarded
 * ones. Two concurrent awards of the same lot cannot both land because the
 * second finds it already settled, inside the same lock.
 *
 * ## And only to somebody who still has a seat (R-66 / UC-16 pre1, 7)
 *
 * This is where the stale pool stops. `setDraftPool` snapshots the accepted
 * applicants, and nothing invalidates that snapshot: accept somebody, pool
 * them, then decline, waitlist or withdraw them, and their entry is still
 * there. Until now this path never asked, so a team paid real money for a seat
 * the event had already taken away and a withdrawn member sat on a roster that
 * the draft room, the event page and the format all read as real. It is the
 * same shape as the bug one layer up that `placeOnRoster` was closed against —
 * a status change that the other tables were never told about — and it is
 * closed the same way: re-read acceptance on the row about to be written, with
 * the event already locked. It is the same roster in both, which is where R-61
 * and R-62 come in: a seat bought here and a seat placed by hand have to answer
 * to one rule about who may hold one.
 *
 * The refusal **names them**, and says which of the three it is. The room is
 * watching a lot that will not settle, and a button that quietly does nothing
 * is worse than one that says why — the manager's way out is to accept them
 * again on the Applicants tab, where an unusual decision is recorded as a
 * decision, or to discard the lot.
 */
export async function awardLot(
  lotId: string,
  teamId: string,
  options: { closedBy?: string | null; now?: Date } = {},
  database: Database = defaultDb
): Promise<DraftResult<AwardLotResult>> {
  const now = options.now ?? new Date();

  return database.transaction(async (tx) => {
    const [peek] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!peek) return fail("That lot no longer exists.");

    const event = await lockEvent(tx, peek.eventId);
    if (!event) return fail("That event no longer exists.");

    const [lot] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!lot) return fail("That lot no longer exists.");
    if (lot.status !== "open") return fail("That lot has already settled.");
    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    /*
     * Do they still have a seat? — asked here, now, inside the lock.
     *
     * The pool entry this lot came from was written by `setDraftPool` and
     * nothing has told it that the application moved on. The lock above is
     * what makes this read worth anything: `setApplicationStatus` and
     * `withdrawApplication` take the same event row, so a decision either
     * committed before this transaction began and is in front of us, or waits
     * until after it — there is no window where the answer changes underneath
     * the write.
     *
     * Before the team, the bid and the price, because this is a fact about the
     * lot rather than about the request: the money has nowhere to go whoever
     * asks and whatever they bid.
     */
    const seat = await seatStatus(tx, lot.eventId, lot.playerUserId);
    if (seat !== "accepted") {
      const phrase = noSeatPhrase(await displayNameOf(tx, lot.playerUserId), seat);
      return fail(
        `${phrase}, so there is no seat to sell. Accept them again on the Applicants tab, or discard this lot.`
      );
    }

    const [team] = await tx
      .select()
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.eventId, lot.eventId)))
      .limit(1);
    if (!team) return fail("That team is not in this draft.");

    const bids = await readBids(tx, lotId);
    const bid = bids.find((row) => row.teamId === teamId);
    if (!bid) return fail(`${team.name} has not bid on this player.`);

    // Read inside the lock with the bids, so a raise that landed while the
    // console was rendering is counted rather than argued with.
    const resolution = resolveLot(bids.map((row) => ({ teamId: row.teamId, amount: row.amount })));
    if (!awardableTeamIds(resolution).includes(teamId)) {
      const top = resolution.kind === "none" ? 0 : resolution.amount;
      return fail(
        `${team.name} bid ${bid.amount}, and ${top} is the highest bid on this lot. A lot goes to the highest bid — clear the others first if that is not what you want.`
      );
    }

    const config = await readConfig(tx, lot.eventId);
    const members = await readMembers(tx, lot.eventId);
    const lots = await readLots(tx, lot.eventId);

    if (members.some((member) => member.userId === lot.playerUserId)) {
      return fail("That player has already been drafted.");
    }

    const balance = balanceFor(team, asLotViews(lots));
    const roster = rosterState(team, asMemberViews(members), config);

    if (roster.slotsLeft <= 0) return fail(`${team.name}'s roster is already full.`);
    if (bid.amount > balance) {
      return fail(`${team.name} cannot cover that bid — they have ${balance}.`);
    }
    const cap = maxBidFor({ balance }, config, roster);
    if (bid.amount > cap) {
      return fail(
        `${team.name} can spend at most ${cap} here and still fill their roster.`
      );
    }

    const [awarded] = await tx
      .update(draftLots)
      .set({
        status: "awarded",
        winnerTeamId: teamId,
        price: bid.amount,
        closedAt: now,
        closedBy: options.closedBy ?? null,
      })
      .where(and(eq(draftLots.id, lotId), eq(draftLots.status, "open")))
      .returning();
    if (!awarded) return fail("That lot settled while you were looking at it.");

    const [member] = await tx
      .insert(teamMembers)
      .values({
        teamId,
        eventId: lot.eventId,
        userId: lot.playerUserId,
        price: bid.amount,
        acquiredAt: now,
        isCaptain: false,
        lotId,
      })
      .returning();

    await tx
      .delete(draftPoolEntries)
      .where(
        and(
          eq(draftPoolEntries.eventId, lot.eventId),
          eq(draftPoolEntries.userId, lot.playerUserId)
        )
      );

    return withData({ lot: awarded, member, balance: balance - bid.amount });
  });
}

/** Take the player out of the draft entirely. Nobody wanted them, or a misclick. */
export async function discardLot(
  lotId: string,
  options: { closedBy?: string | null; now?: Date } = {},
  database: Database = defaultDb
): Promise<DraftResult<DraftLot>> {
  const now = options.now ?? new Date();

  return database.transaction(async (tx) => {
    const [peek] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!peek) return fail("That lot no longer exists.");
    const event = await lockEvent(tx, peek.eventId);
    if (!event) return fail("That event no longer exists.");

    const [lot] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!lot) return fail("That lot no longer exists.");
    if (lot.status !== "open") return fail("That lot has already settled.");
    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    const [closed] = await tx
      .update(draftLots)
      .set({ status: "discarded", closedAt: now, closedBy: options.closedBy ?? null })
      .where(and(eq(draftLots.id, lotId), eq(draftLots.status, "open")))
      .returning();
    if (!closed) return fail("That lot settled while you were looking at it.");

    await tx
      .delete(draftPoolEntries)
      .where(
        and(
          eq(draftPoolEntries.eventId, lot.eventId),
          eq(draftPoolEntries.userId, lot.playerUserId)
        )
      );

    return withData(closed);
  });
}

export type MoveToReserveResult = {
  lot: DraftLot;
  /**
   * False when this was the player's last allowed turn: the lot is recorded as
   * `reserved` either way, but they do not go back into the pool.
   */
  returnedToPool: boolean;
  /** How many more turns they have after this one. Null is unlimited. */
  comebacksLeft: number | null;
};

/**
 * Send the player round again later.
 *
 * They go to the back of the reserve pool rather than out of the draft, which
 * is the point of the second wheel: the names that went for nothing the first
 * time get another chance once the money is spent.
 *
 * ## How many times is a setting, not an assumption (R-144 / UC-16 E2)
 *
 * This used to refuse outright when the lot already came *from* the reserve
 * pool — "that player is already in the reserve pool" — which made "comes back
 * exactly once" a fact of the code. R-144 replaces that assumption with a
 * number the manager sets, and a number that can be two is a number this has to
 * be able to act on, so the refusal is now the count rather than the pool.
 *
 * When the turns run out the lot is still `reserved` — that is what the manager
 * did, and rewriting it as a discard would put words in their mouth — but the
 * player does not go back on the wheel. E2's "then is out of the draft", said
 * in the only way the pool can say it. The result says which happened so the
 * console can tell the room.
 */
export async function moveToReserve(
  lotId: string,
  options: { closedBy?: string | null; now?: Date } = {},
  database: Database = defaultDb
): Promise<DraftResult<MoveToReserveResult>> {
  const now = options.now ?? new Date();

  return database.transaction(async (tx) => {
    const [peek] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!peek) return fail("That lot no longer exists.");
    const event = await lockEvent(tx, peek.eventId);
    if (!event) return fail("That event no longer exists.");

    const [lot] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!lot) return fail("That lot no longer exists.");
    if (lot.status !== "open") return fail("That lot has already settled.");
    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    const config = await readConfig(tx, lot.eventId);
    if (!config.reserveEnabled) return fail("The reserve pool is switched off for this event.");

    /*
     * Counted *including this lot*, which is the whole arithmetic of E2.
     *
     * A lot drawn from the main wheel is the player's nought-th turn on the
     * reserve one, so holding them over sends them for turn number one. A lot
     * already drawn from the reserve pool was turn number `used`, and holding
     * them over again asks for turn `used + 1`. So the question at this point
     * is always "do they have a turn left after the one they have just had",
     * and `used` already counts the lot in front of us because `readLots`
     * includes it.
     */
    const used = reserveTurnsUsed(await readLots(tx, lot.eventId), lot.playerUserId);
    const returnedToPool = mayComeBackAgain(used, config);
    const left = returnedToPool ? reserveComebacksLeft(used, config) : 0;

    const [closed] = await tx
      .update(draftLots)
      .set({ status: "reserved", closedAt: now, closedBy: options.closedBy ?? null })
      .where(and(eq(draftLots.id, lotId), eq(draftLots.status, "open")))
      .returning();
    if (!closed) return fail("That lot settled while you were looking at it.");

    if (returnedToPool) {
      const pool = await readPool(tx, lot.eventId);
      await tx
        .insert(draftPoolEntries)
        .values({
          eventId: lot.eventId,
          userId: lot.playerUserId,
          kind: "reserve",
          sort: nextSort(pool, "reserve"),
        })
        .onConflictDoUpdate({
          target: [draftPoolEntries.eventId, draftPoolEntries.userId],
          set: { kind: "reserve", sort: nextSort(pool, "reserve") },
        });
    } else {
      // Out of the draft. The pool entry goes, so the counts the room and
      // `draftComplete` read stay honest about who is still for sale.
      await tx
        .delete(draftPoolEntries)
        .where(
          and(
            eq(draftPoolEntries.eventId, lot.eventId),
            eq(draftPoolEntries.userId, lot.playerUserId)
          )
        );
    }

    return withData({ lot: closed, returnedToPool, comebacksLeft: left });
  });
}

export type VoidLotResult = {
  lot: DraftLot;
  /** The balance the winning team gets back. Null when nothing was awarded. */
  refunded: number | null;
  /** Where the player was put back. Null when they stayed where they were. */
  returnedTo: DraftPoolKind | null;
};

/**
 * Undo a lot.
 *
 * The row is **not deleted**. Its winner and its price stay exactly as they
 * were and the status becomes `voided`, so the history can say what was undone
 * and by whom — checklist.md's standing rule is that nothing is destructive,
 * and "the price is gone and so is any record there was one" is the worst
 * possible reading of an undo.
 *
 * Everything derived then simply ignores it: `balanceFor` skips voided lots, so
 * the money comes back without a single number being written, which is the
 * whole reason the remaining balance is not a column. The roster row goes,
 * because a roster is a set of people rather than a history, and the player
 * returns to the pool they were drawn from.
 *
 * Voiding an *open* lot is the current board's "cancel": the player never left
 * the pool, so nothing needs putting back.
 */
export async function voidLot(
  lotId: string,
  options: { voidedBy?: string | null; now?: Date } = {},
  database: Database = defaultDb
): Promise<DraftResult<VoidLotResult>> {
  const now = options.now ?? new Date();

  return database.transaction(async (tx) => {
    const [peek] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!peek) return fail("That lot no longer exists.");
    const event = await lockEvent(tx, peek.eventId);
    if (!event) return fail("That event no longer exists.");

    const [lot] = await tx.select().from(draftLots).where(eq(draftLots.id, lotId)).limit(1);
    if (!lot) return fail("That lot no longer exists.");
    if (lot.status === "voided") return fail("That lot has already been voided.");
    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    return voidLotIn(tx, lot, now, options.voidedBy ?? null);
  });
}

/**
 * The undo itself, with the event already locked and the lot already read.
 *
 * Shared by `voidLot` and `voidLastLot` so that the one-button undo can choose
 * its target inside the same transaction that voids it. Everything it touches
 * is in `lot.eventId`, so a caller that locked a different event would be
 * authorising on an id beside the row it writes — which is why the lot is
 * passed in rather than an id, and why neither caller re-resolves it.
 *
 * ## The compare-and-set comes first, because it is the one thing that refuses
 *
 * It used to come last: the roster row was deleted and the player put back in
 * the pool, and *then* the lot was moved to `voided` with
 * `where status <> 'voided'` and a refusal returned if that matched no rows.
 * A refusal returned from a transaction callback commits what came before it
 * (docs/decisions/004-refusals-inside-transactions.md), so that branch handed
 * back "nothing happened" over a committed roster deletion and a committed
 * pool entry — the player off the team, back on the wheel, and the lot still
 * reading `awarded`. UC-16 7a's undo restores the balance *and* the roster; a
 * half undo restores neither honestly.
 *
 * Doing the guarded write first makes the refusal a write that matched no rows,
 * which is nothing to roll back, and leaves the two rows that follow it
 * unconditional. Both callers already check the status under the event's row
 * lock, so this is the belt to their braces rather than the only guard — but a
 * guard whose failure path is wrong is worse than no guard, because it reads
 * like one.
 */
async function voidLotIn(
  tx: Database,
  lot: DraftLot,
  now: Date,
  voidedBy: string | null
): Promise<DraftResult<VoidLotResult>> {
  const refunded = lot.status === "awarded" ? (lot.price ?? 0) : null;

  const [voided] = await tx
    .update(draftLots)
    .set({ status: "voided", voidedAt: now, voidedBy })
    .where(and(eq(draftLots.id, lot.id), ne(draftLots.status, "voided")))
    .returning();
  if (!voided) return fail("That lot was voided while you were looking at it.");

  if (lot.status === "awarded") {
    await tx.delete(teamMembers).where(eq(teamMembers.lotId, lot.id));
  }

  let returnedTo: DraftPoolKind | null = null;
  if (lot.status === "awarded" || lot.status === "discarded" || lot.status === "reserved") {
    const pool = await readPool(tx, lot.eventId);
    returnedTo = lot.fromKind;
    await tx
      .insert(draftPoolEntries)
      .values({
        eventId: lot.eventId,
        userId: lot.playerUserId,
        kind: returnedTo,
        sort: nextSort(pool, returnedTo),
      })
      .onConflictDoUpdate({
        target: [draftPoolEntries.eventId, draftPoolEntries.userId],
        set: { kind: returnedTo, sort: nextSort(pool, returnedTo) },
      });
  }

  return withData({ lot: voided, refunded, returnedTo });
}

/**
 * Undo the most recent lot — the admin's one-button undo (UC-16 7a).
 *
 * ## Which lot, and why the question is not as easy as it looks
 *
 * An **open** lot wins, because it is newer than anything settled and undoing
 * it is the room's "cancel": nothing has been paid, so nothing is given back.
 * Otherwise it is the most recently *settled* lot, and the key is `closedAt`
 * rather than `openedAt`. Those agree while lots run one at a time, which they
 * do — but `closedAt` is the moment the thing being undone actually happened,
 * and an undo aimed by when a lot *started* is aimed at the wrong fact. Where
 * two lots settled in the same instant an `awarded` one wins, because 7a is
 * about undoing an award and a discard is the cheaper mistake to leave standing.
 *
 * ## The target is chosen inside the lock, not before it
 *
 * This is the bug worth naming, because it is invisible from the outside. The
 * old version read "the last lot" on the default handle and *then* called
 * `voidLot`, which opened its own transaction and took the event's row lock —
 * so between choosing and voiding, a second manager could award another lot.
 * The undo then reversed the award before last: money back to the wrong team,
 * the wrong player returned to the pool, and a history that reads as if the
 * newest award is still standing. Two managers on a draft console is not an
 * exotic setup; it is what a laptop and a phone look like.
 *
 * So the whole of it — lock the event, pick the target, void it — happens in
 * one transaction, which is the same rule `placeBid` and `awardLot` follow and
 * for the same reason. `voidLot`'s body is shared rather than copied.
 */
export async function voidLastLot(
  eventId: string,
  options: { voidedBy?: string | null; now?: Date } = {},
  database: Database = defaultDb
): Promise<DraftResult<VoidLotResult>> {
  const now = options.now ?? new Date();

  return database.transaction(async (tx) => {
    const event = await lockEvent(tx, eventId);
    if (!event) return fail("That event no longer exists.");
    const locked = lockRefusal(event);
    if (locked) return fail(locked);

    const candidates = await tx
      .select()
      .from(draftLots)
      .where(and(eq(draftLots.eventId, eventId), ne(draftLots.status, "voided")));

    const last = mostRecentUndoable(candidates);
    if (!last) return fail("There is nothing to undo.");

    return voidLotIn(tx, last, now, options.voidedBy ?? null);
  });
}

/**
 * The lot an undo lands on, given every lot that has not already been undone.
 *
 * Picked in JavaScript rather than in `order by` so the three rules above can
 * be written as the three rules they are, and so the awarded-beats-discarded
 * tiebreak does not have to be spelled as a `case` expression.
 */
function mostRecentUndoable(lots: readonly DraftLot[]): DraftLot | null {
  let best: DraftLot | null = null;
  for (const lot of lots) {
    if (best === null || undoRank(lot) > undoRank(best)) best = lot;
  }
  return best;
}

/** Bigger is newer. An open lot sorts above every settled one. */
function undoRank(lot: DraftLot): number {
  if (lot.status === "open") return Number.MAX_SAFE_INTEGER;
  const settled = (lot.closedAt ?? lot.openedAt).getTime();
  // A half-millisecond nudge, so an award edges out a discard that settled in
  // the same instant without being able to overtake anything genuinely later.
  return settled * 2 + (lot.status === "awarded" ? 1 : 0);
}

/* ------------------------------------------------------------------ */
/* Reads                                                              */
/* ------------------------------------------------------------------ */

export type TeamWithRoster = Team & {
  members: TeamMember[];
  /** Derived from the awarded lots, never stored. */
  balance: number;
  roster: RosterState;
};

/** Every team with its roster, balance and how many slots are left. */
export async function getTeams(
  eventId: string,
  database: Database = defaultDb
): Promise<TeamWithRoster[]> {
  const [config, rows, members, lots] = await Promise.all([
    readConfig(database, eventId),
    readTeams(database, eventId),
    readMembers(database, eventId),
    readLots(database, eventId),
  ]);
  const memberViews = asMemberViews(members);
  const lotViews = asLotViews(lots);

  return rows.map((team) => ({
    ...team,
    members: members.filter((member) => member.teamId === team.id),
    balance: balanceFor(team, lotViews),
    roster: rosterState(team, memberViews, config),
  }));
}

/** Every lot ever opened for this event, newest first. */
export async function getDraftHistory(
  eventId: string,
  database: Database = defaultDb
): Promise<DraftLot[]> {
  return readLots(database, eventId);
}

/** Enough of a lot to write a sentence about it. */
export type LotLabel = {
  lotId: string;
  eventId: string;
  eventTitle: string;
  player: string;
  playerUserId: string;
  /** Null for a lot nobody won — discarded, reserved, or still open. */
  team: string | null;
  price: number | null;
  status: DraftLotStatus;
};

/**
 * One lot, named — the player, the team and the price, in one read.
 *
 * The audit log's reason for existing, in this corner of the site: a price
 * written as a sentence at the moment it was paid survives a team being
 * renamed and a member leaving the server, which two ids and a join do not.
 * Left-joined on the team, because a discarded lot has no winner and is still
 * worth a line.
 */
export async function describeLot(
  lotId: string,
  database: Database = defaultDb
): Promise<LotLabel | null> {
  const [row] = await database
    .select({
      lotId: draftLots.id,
      eventId: draftLots.eventId,
      eventTitle: events.title,
      displayName: users.displayName,
      name: users.name,
      playerUserId: draftLots.playerUserId,
      team: teams.name,
      price: draftLots.price,
      status: draftLots.status,
    })
    .from(draftLots)
    .innerJoin(events, eq(draftLots.eventId, events.id))
    .innerJoin(users, eq(draftLots.playerUserId, users.id))
    .leftJoin(teams, eq(draftLots.winnerTeamId, teams.id))
    .where(eq(draftLots.id, lotId))
    .limit(1);

  if (!row) return null;
  return {
    lotId: row.lotId,
    eventId: row.eventId,
    eventTitle: row.eventTitle,
    player: row.displayName ?? row.name ?? "A player",
    playerUserId: row.playerUserId,
    team: row.team,
    price: row.price,
    status: row.status,
  };
}

/** Who won the open lot, or that it is tied. Admin-facing; never redacted. */
export async function getOpenLotResolution(
  eventId: string,
  database: Database = defaultDb
): Promise<LotResolution | null> {
  const lot = await readOpenLot(database, eventId);
  if (!lot) return null;
  const bids = await readBids(database, lot.id);
  return resolveLot(bids.map((bid) => ({ teamId: bid.teamId, amount: bid.amount })));
}

/**
 * The whole draft, unredacted.
 *
 * Nothing renders this directly — `getDraftView` puts it through
 * `redactDraft` first. It is separate because the redaction is a pure function
 * and deserves to be tested as one, over a snapshot a test can build by hand.
 */
export async function getDraftSnapshot(
  eventId: string,
  options: { now?: Date } = {},
  database: Database = defaultDb
): Promise<DraftSnapshot | null> {
  const event = await readEvent(database, eventId);
  if (!event) return null;

  const now = (options.now ?? new Date()).getTime();
  const [config, teamRows, memberRows, lotRows, poolRows] = await Promise.all([
    readConfig(database, eventId),
    readTeams(database, eventId),
    readMembers(database, eventId),
    readLots(database, eventId),
    readPool(database, eventId),
  ]);

  const memberViews = asMemberViews(memberRows);
  const lotViews = asLotViews(lotRows);
  const openRow = lotRows.find((lot) => lot.status === "open") ?? null;
  const bidRows = openRow ? await readBids(database, openRow.id) : [];

  const standings: TeamStanding[] = teamRows.map((team) => {
    const balance = balanceFor(team, lotViews);
    const roster = rosterState(team, memberViews, config);
    const bid = bidRows.find((row) => row.teamId === team.id) ?? null;
    return {
      id: team.id,
      name: team.name,
      captainUserId: team.captainUserId,
      balanceStart: team.balanceStart,
      seed: team.seed,
      sort: team.sort,
      balance,
      roster,
      members: memberViews.filter((member) => member.teamId === team.id),
      maxBid: maxBidFor({ balance }, config, roster),
      bid: bid ? bid.amount : null,
    };
  });

  /*
   * The wheel the room bids from, minus anybody the event has let go — the
   * same read `openLot` makes, so the console is never offering a lot that
   * `openLot` would refuse to open and `awardLot` would refuse to settle.
   *
   * Filtered, not pruned. The row stays in `draft_pool_entries` exactly as the
   * manager built it, and `getDraftPool` — the pool editor's read — still
   * shows it to them.
   */
  const stillAccepted = await acceptedAmong(
    database,
    eventId,
    poolRows.map((entry) => entry.userId)
  );
  const livePool = poolRows.filter((entry) => stillAccepted.has(entry.userId));
  const main = livePool.filter((entry) => entry.kind === "main");
  const reserve = livePool.filter((entry) => entry.kind === "reserve");
  const asPlayer = (entry: DraftPoolEntry): PoolPlayer => ({
    userId: entry.userId,
    kind: entry.kind,
    sort: entry.sort,
  });

  const lot: OpenLot | null = openRow
    ? {
        id: openRow.id,
        playerUserId: openRow.playerUserId,
        fromKind: openRow.fromKind,
        openedAt: openRow.openedAt.getTime(),
        spin: openRow.spin ?? null,
        bids: bidRows.map((bid) => ({
          teamId: bid.teamId,
          amount: bid.amount,
          placedAt: bid.placedAt.getTime(),
        })),
        /*
         * `bidsCloseAt`, not `openedAt + timer` — R-143 / UC-16 E1.
         *
         * The two disagree by the length of the spin, and the room believed the
         * wrong one: the countdown started the moment the lot opened while the
         * server's `biddingOpen` starts it when the wheel stops. On a 20 second
         * timer that is a clock running out six and a half seconds early, so a
         * captain watched it hit zero and stopped bidding while the server was
         * still taking bids. The policy owns the answer; this asks it.
         */
        endsAt:
          bidsCloseAt(
            { status: openRow.status, openedAt: openRow.openedAt, spin: openRow.spin, bids: [] },
            config
          )?.getTime() ?? null,
      }
    : null;

  const history: SettledLot[] = lotRows
    .filter((row) => row.status !== "open")
    .map((row) => ({
      id: row.id,
      playerUserId: row.playerUserId,
      status: row.status,
      fromKind: row.fromKind,
      winnerTeamId: row.winnerTeamId,
      price: row.price,
      closedAt: row.closedAt ? row.closedAt.getTime() : null,
      voidedAt: row.voidedAt ? row.voidedAt.getTime() : null,
    }));

  const completion: DraftCompletion = draftComplete(
    { main: main.length, reserve: reserve.length },
    teamRows.map((team) => ({
      id: team.id,
      members: memberViews.filter((member) => member.teamId === team.id),
    })),
    config
  );

  return {
    now,
    config,
    teams: standings,
    lot,
    history,
    pools: { main: main.map(asPlayer), reserve: reserve.map(asPlayer) },
    activeKind:
      openRow?.fromKind ??
      (main.length > 0 || !config.reserveEnabled ? "main" : "reserve"),
    completion,
  };
}

export type PlayerCard = {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  /**
   * Their `/players/[handle]` segment, or null when they have not been given
   * one yet. Read, never assigned: this view is what the room polls once a
   * second, and `ensureHandles` writes.
   */
  handle: string | null;
};

/** A draft room, redacted for one viewer, with the names to render the ids. */
export type DraftRoomView = DraftView & {
  eventId: string;
  /** Everyone the view mentions, keyed by user id. */
  players: Record<string, PlayerCard>;
};

/**
 * Work out what this viewer is to this draft.
 *
 * Managing this event beats everything — an admin, or a host of this one event,
 * gets the console; a host of some other event is nobody special here. Then
 * captaincy, then being in it at all. Somebody signed in who is not part of this
 * event is an observer, and so is somebody signed out — §11 puts the whole room
 * in the same row for watching.
 */
export async function viewerFor(
  eventId: string,
  userId: string | null,
  isAdmin: boolean,
  database: Database = defaultDb
): Promise<DraftViewer> {
  if (!userId) return { role: "observer", userId: null, teamId: null };
  if (await canManageEvent({ id: userId, isAdmin }, eventId, database)) {
    return { role: "admin", userId, teamId: null };
  }

  const [captained] = await database
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.eventId, eventId), eq(teams.captainUserId, userId)))
    .limit(1);
  if (captained) return { role: "captain", userId, teamId: captained.id };

  const [onARoster] = await database
    .select({ id: teamMembers.id })
    .from(teamMembers)
    .where(and(eq(teamMembers.eventId, eventId), eq(teamMembers.userId, userId)))
    .limit(1);
  if (onARoster) return { role: "player", userId, teamId: null };

  const [inPool] = await database
    .select({ id: draftPoolEntries.id })
    .from(draftPoolEntries)
    .where(and(eq(draftPoolEntries.eventId, eventId), eq(draftPoolEntries.userId, userId)))
    .limit(1);
  if (inPool) return { role: "player", userId, teamId: null };

  return { role: "observer", userId, teamId: null };
}

/**
 * The draft as one particular viewer is allowed to see it.
 *
 * The redaction itself is `redactDraft`, a pure function over the snapshot;
 * this only fetches, and then looks up the display names for every id the
 * redacted view still mentions — never for one it hid, or the payload would
 * quietly leak the name of the player the wheel has not landed on yet.
 */
export async function getDraftView(
  eventId: string,
  viewer: DraftViewer,
  options: { now?: Date } = {},
  database: Database = defaultDb
): Promise<DraftRoomView | null> {
  const snapshot = await getDraftSnapshot(eventId, options, database);
  if (!snapshot) return null;

  const view = redactDraft(snapshot, viewer);

  const mentioned = new Set<string>();
  for (const team of view.teams) {
    if (team.captainUserId) mentioned.add(team.captainUserId);
    for (const member of team.members) mentioned.add(member.userId);
  }
  for (const entry of view.activePool) mentioned.add(entry.userId);
  for (const entry of view.mainPool ?? []) mentioned.add(entry.userId);
  for (const entry of view.reservePool ?? []) mentioned.add(entry.userId);
  for (const settled of view.history) mentioned.add(settled.playerUserId);
  if (view.lot?.playerUserId) mentioned.add(view.lot.playerUserId);
  if (view.you.userId) mentioned.add(view.you.userId);

  const players: Record<string, PlayerCard> = {};
  if (mentioned.size > 0) {
    const rows = await database
      .select({
        id: users.id,
        displayName: users.displayName,
        name: users.name,
        avatarUrl: users.avatarUrl,
        handle: users.handle,
      })
      .from(users)
      .where(inArray(users.id, [...mentioned]));
    for (const row of rows) {
      players[row.id] = {
        id: row.id,
        displayName: row.displayName ?? row.name ?? "Unknown player",
        avatarUrl: row.avatarUrl,
        handle: row.handle,
      };
    }
  }

  return { ...view, eventId, players };
}

/** Re-exported so a caller needs one import to render a draft. */
export type { DraftPhase, DraftRole, DraftViewer, DraftView };

/**
 * Players accepted into the event who are in neither a roster nor the pool.
 *
 * The Draft tab's "who is missing" line: somebody accepted after the pool was
 * seeded shows up here rather than silently never being drafted.
 */
export async function getUnpooledApplicants(
  eventId: string,
  database: Database = defaultDb
): Promise<string[]> {
  const accepted = await database
    .select({ userId: applications.userId })
    .from(applications)
    .where(and(eq(applications.eventId, eventId), eq(applications.status, "accepted")))
    .orderBy(asc(applications.submittedAt));

  const [members, pool] = await Promise.all([
    readMembers(database, eventId),
    readPool(database, eventId),
  ]);
  const placed = new Set([
    ...members.map((member) => member.userId),
    ...pool.map((entry) => entry.userId),
  ]);

  return accepted.map((row) => row.userId).filter((userId) => !placed.has(userId));
}

/**
 * Players who were discarded and never came back — the other half of the
 * accounting, so a screen can say why the numbers do not add up.
 */
export async function getDiscardedPlayers(
  eventId: string,
  database: Database = defaultDb
): Promise<string[]> {
  const lots = await readLots(database, eventId);
  const [members, pool] = await Promise.all([
    readMembers(database, eventId),
    readPool(database, eventId),
  ]);
  const placed = new Set([
    ...members.map((member) => member.userId),
    ...pool.map((entry) => entry.userId),
  ]);

  const out: string[] = [];
  const seen = new Set<string>();
  for (const lot of lots) {
    if (lot.status !== "discarded") continue;
    if (placed.has(lot.playerUserId) || seen.has(lot.playerUserId)) continue;
    seen.add(lot.playerUserId);
    out.push(lot.playerUserId);
  }
  return out;
}
