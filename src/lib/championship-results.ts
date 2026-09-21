/**
 * Where everyone finished — the part that talks to Postgres (UC-33).
 *
 * Split from `./championships` rather than added to it, because the two answer
 * different questions and change for different reasons. That module owns the
 * season and which events count towards it: an admin's objects, edited on
 * `/admin/championships`. This one owns one event's finishing order, which a
 * *host* records on their own event's editor and which changes whenever
 * anything about teams, applications or placements does. The only thing they
 * share is the lock, and that lives in `./championship-policy` where both can
 * reach it.
 *
 * The dependency runs one way and there is no cycle: everything here asks
 * `championshipOfEvent` which event is in which season, and nothing over there
 * asks about a place.
 *
 * ## Nothing derived is stored
 *
 * Only places are written. The participant list is read fresh on every call
 * and never written down — exactly as a bracket slot's teams are re-derived on
 * every read — which is what makes a roster change after the fact re-score by
 * itself, and what makes a correction (UC-33 4a) nothing more than replacing
 * rows. There is no total anywhere that could go stale, because there is no
 * total.
 */

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  type Database,
  applications,
  championshipEvents,
  championshipPlacements,
  championships,
  db as defaultDb,
  teamMembers,
  teams,
  users,
} from "@/db";
import {
  type CountingEventInput,
  type PlacementInput,
  championshipLockRefusal,
  duplicateMemberIn,
  positionProblem,
} from "./championship-policy";
import {
  type ChampionshipResult,
  type CountingEvent,
  type EventChampionship,
  NOT_COUNTING,
  championshipOfEvent,
  fail,
} from "./championships";
import { UNKNOWN_PLAYER, displayNamesFor } from "./players";

/* ------------------------------------------------------------------ */
/* Shapes                                                             */
/* ------------------------------------------------------------------ */

/**
 * One row of the finishing order an admin types over: a team, or an accepted
 * applicant.
 *
 * `id` is whatever the place is recorded against — the team's id or the
 * member's user id — so the editor sends back exactly what it was given and
 * nothing has to agree about which of the two a payload meant.
 */
export type ParticipantRow = {
  id: string;
  name: string;
  /** Everybody this row's place scores for (R-180). One person, unless it is a team. */
  members: Array<{ userId: string; name: string }>;
};

/** Everyone who took part in one event (UC-33 2). */
export type EventParticipants = {
  /** True when the event had teams, and a place is therefore a team's (UC-33 2a). */
  teamed: boolean;
  rows: ParticipantRow[];
};

/** One place as it is stored — `ParticipantRow.id`, and which column holds it. */
export type RecordedPlacement = {
  id: string;
  position: number;
  kind: "team" | "member";
  /**
   * The team's or the member's name **now**.
   *
   * Read rather than stored, and read here rather than looked up against the
   * participant list, because the two can disagree: somebody who finished
   * third and has since withdrawn is no longer a participant, and the editor
   * still has to be able to show their place rather than quietly drop it.
   */
  name: string;
};

/** One line of an order being saved. */
export type PlacementEntry = {
  /** A team's id when the event had teams, a member's user id otherwise. */
  id: string;
  /** 1 or more. Two entries may share one, and the next is then empty (UC-33 3a). */
  position: number;
};

/** What a saved order gives back: the counting row it landed on, and the order. */
export type RecordedResult = {
  counting: EventChampionship;
  placements: RecordedPlacement[];
};

const NOT_IN_EVENT =
  "One of those places is for somebody who did not take part in this event.";

/** UC-33 3c, as a sentence naming whoever is doubled. */
function twiceIn(name: string): string {
  return `${name} is in that order twice. Somebody finishes in one place.`;
}

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

/**
 * Who took part in one event — the teams if it had them, otherwise the accepted
 * applicants (UC-33 2).
 *
 * **Teams win outright when there are any.** An event that drafted rosters
 * finished as teams, and R-180 makes a team's place score for every member, so
 * an accepted applicant nobody drafted is not a second kind of participant
 * sitting alongside them — they are somebody who did not end up playing. The
 * two lists are therefore exclusive rather than merged, which is also what
 * makes a placement's subject unambiguous.
 */
export async function eventParticipants(
  eventId: string,
  database: Database = defaultDb
): Promise<EventParticipants> {
  const byEvent = await participantsFor([eventId], database);
  return byEvent.get(eventId) ?? EMPTY_PARTICIPANTS;
}

/** What an event nobody entered has: no teams, and nobody in them. */
const EMPTY_PARTICIPANTS: EventParticipants = { teamed: false, rows: [] };

/**
 * {@link eventParticipants} for a list of events, in a fixed number of reads.
 *
 * The singular is a call to this one, so which of the two lists wins is decided
 * in a single place. The plural exists because the public championship page
 * asks the question for every event of every finished season at once
 * (`finishedSeasons`), and asking one event at a time made a footer cost
 * hundreds of round trips.
 *
 * Three reads whatever the length of the list, with the grouping done in
 * memory — the same trade `seasonEvents` makes, for the same reason: this is
 * tens of rows, not thousands.
 */
export async function participantsFor(
  eventIds: readonly string[],
  database: Database = defaultDb
): Promise<Map<string, EventParticipants>> {
  const ids = [...new Set(eventIds)];
  const out = new Map<string, EventParticipants>();
  if (ids.length === 0) return out;

  const [teamRows, roster, accepted] = await Promise.all([
    database
      .select({ id: teams.id, eventId: teams.eventId, name: teams.name })
      .from(teams)
      .where(inArray(teams.eventId, ids))
      .orderBy(asc(teams.sort), asc(teams.createdAt)),
    database
      .select({
        teamId: teamMembers.teamId,
        eventId: teamMembers.eventId,
        userId: teamMembers.userId,
      })
      .from(teamMembers)
      .where(inArray(teamMembers.eventId, ids))
      // The captain fills a roster slot (§14), so they are an ordinary row
      // here and lead the list they are on.
      .orderBy(desc(teamMembers.isCaptain), asc(teamMembers.acquiredAt)),
    database
      .select({ eventId: applications.eventId, userId: applications.userId })
      .from(applications)
      .where(
        and(inArray(applications.eventId, ids), eq(applications.status, "accepted"))
      ),
  ]);

  const names = await displayNamesFor(
    [...roster.map((row) => row.userId), ...accepted.map((row) => row.userId)],
    database
  );

  for (const eventId of ids) {
    const eventTeams = teamRows.filter((row) => row.eventId === eventId);

    if (eventTeams.length > 0) {
      const eventRoster = roster.filter((row) => row.eventId === eventId);
      out.set(eventId, {
        teamed: true,
        rows: eventTeams.map((team) => ({
          id: team.id,
          name: team.name,
          members: eventRoster
            .filter((row) => row.teamId === team.id)
            .map((row) => ({
              userId: row.userId,
              name: names.get(row.userId) ?? UNKNOWN_PLAYER,
            })),
        })),
      });
      continue;
    }

    const rows = accepted
      .filter((row) => row.eventId === eventId)
      .map((row) => {
        const name = names.get(row.userId) ?? UNKNOWN_PLAYER;
        return { id: row.userId, name, members: [{ userId: row.userId, name }] };
      });
    rows.sort((x, y) => x.name.localeCompare(y.name));

    out.set(eventId, { teamed: false, rows });
  }

  return out;
}

/** The order recorded for one event, best finish first. */
export async function listPlacements(
  eventId: string,
  database: Database = defaultDb
): Promise<RecordedPlacement[]> {
  const byEvent = await placementsFor([eventId], database);
  return byEvent.get(eventId) ?? [];
}

/**
 * {@link listPlacements} for a list of events, in one read.
 *
 * Every id asked about gets an entry, empty when nothing has been recorded on
 * it: "no order yet" and "not asked about" are different answers, and the line
 * between a counted event and one still to come is drawn on the first of them.
 */
export async function placementsFor(
  eventIds: readonly string[],
  database: Database = defaultDb
): Promise<Map<string, RecordedPlacement[]>> {
  const ids = [...new Set(eventIds)];
  const out = new Map<string, RecordedPlacement[]>(ids.map((id) => [id, []]));
  if (ids.length === 0) return out;

  const rows = await database
    .select({
      eventId: championshipEvents.eventId,
      position: championshipPlacements.position,
      userId: championshipPlacements.userId,
      teamId: championshipPlacements.teamId,
      teamName: teams.name,
      displayName: users.displayName,
      userName: users.name,
    })
    .from(championshipPlacements)
    .innerJoin(
      championshipEvents,
      eq(championshipEvents.id, championshipPlacements.championshipEventId)
    )
    .leftJoin(teams, eq(teams.id, championshipPlacements.teamId))
    .leftJoin(users, eq(users.id, championshipPlacements.userId))
    .where(inArray(championshipEvents.eventId, ids))
    .orderBy(asc(championshipPlacements.position));

  for (const row of rows) {
    // `championship_placements_one_subject` guarantees exactly one of the two.
    out.get(row.eventId)?.push({
      id: row.teamId ?? row.userId ?? "",
      position: row.position,
      kind: row.teamId ? ("team" as const) : ("member" as const),
      name: row.teamName ?? row.displayName ?? row.userName ?? UNKNOWN_PLAYER,
    });
  }

  return out;
}

/**
 * One event's stored result in the shape `scoreChampionship` takes, or `null`
 * when the event counts towards nothing.
 *
 * **This is the mapping, and there must be exactly one of it.** Everything a
 * season is worth is a function of these five fields, so a second copy — in a
 * test, on a page, anywhere — is a second copy that can drift from the one the
 * standings are actually built from while every assertion keeps passing. The
 * public season page (Task 42) reads a season by calling this once per
 * counting event and handing the list to `scoreChampionship`.
 *
 * {@link scoringInputsFor} is that same mapping over many events at once. Both
 * end at {@link countingEventInput}, which is the one function that knows the
 * shape — "exactly one of it" is a statement about that function, not about how
 * many ways there are to read the rows it is given.
 *
 * The participant list is what UC-33 3b rides on: everybody who took part and
 * is in no placement scores the taking-part points.
 *
 * `places` is for the caller that has already read the order and is about to
 * need it for something else. The public page prints who won each night beside
 * the standings it scored them into, and reading the same rows twice — once
 * here, once for the winners — is a query per counted event for nothing.
 * Passing them in is not a second opinion about the order: it is the same rows,
 * on their way to both uses.
 */
export async function scoringInputFor(
  eventId: string,
  database: Database = defaultDb,
  places?: readonly RecordedPlacement[]
): Promise<CountingEventInput | null> {
  const counting = await championshipOfEvent(eventId, database);
  if (!counting) return null;

  const [participants, order] = await Promise.all([
    eventParticipants(eventId, database),
    places ?? listPlacements(eventId, database),
  ]);

  return countingEventInput(counting, participants, order);
}

/**
 * {@link scoringInputFor} for a whole set of counting events — one season's, or
 * every finished season's at once — in a fixed number of reads.
 *
 * Takes the counting rows rather than event ids because the caller that wants
 * many of these has already read them: that is how it knows which events they
 * are, and re-reading them here would be the same row fetched twice with a
 * chance of disagreeing about the weight in between.
 *
 * An event with nothing recorded on it still gets an entry, with an empty
 * `placements`. Whether that means "has not counted yet" is the caller's to
 * decide, and `seasonPage` is where it is decided.
 */
export async function scoringInputsFor(
  counting: readonly CountingEvent[],
  database: Database = defaultDb
): Promise<Map<string, CountingEventInput>> {
  const eventIds = counting.map((row) => row.eventId);
  const [participants, places] = await Promise.all([
    participantsFor(eventIds, database),
    placementsFor(eventIds, database),
  ]);

  return new Map(
    counting.map((row) => [
      row.eventId,
      countingEventInput(
        row,
        participants.get(row.eventId) ?? EMPTY_PARTICIPANTS,
        places.get(row.eventId) ?? []
      ),
    ])
  );
}

/**
 * The mapping itself: one counting row, who took part in it and what was
 * recorded on it, as the five fields the arithmetic takes.
 *
 * Pure, and the only place that shape is written down — see the note on
 * {@link scoringInputFor} for why there must be exactly one of it.
 */
function countingEventInput(
  counting: Pick<CountingEvent, "eventId" | "weight" | "pointsTable">,
  participants: EventParticipants,
  places: readonly RecordedPlacement[]
): CountingEventInput {
  return {
    id: counting.eventId,
    weight: counting.weight,
    pointsTable: counting.pointsTable,
    placements: subjectsFor(participants, places),
    participants: participants.rows.flatMap((row) =>
      row.members.map((member) => member.userId)
    ),
  };
}

/**
 * Each place as the thing it scores for — one member, or a team and everybody
 * on it (R-180).
 *
 * A subject the participant list no longer holds still gets one: a team with
 * an empty roster, or the member themselves. Leaving it out would drop a place
 * somebody holds, and would hide a duplicate rather than find one.
 */
function subjectsFor(
  participants: EventParticipants,
  places: readonly RecordedPlacement[]
): PlacementInput[] {
  const known = new Map(participants.rows.map((row) => [row.id, row]));
  return places.map((place) => ({
    position: place.position,
    subject:
      place.kind === "team"
        ? {
            kind: "team",
            teamId: place.id,
            memberIds: known.get(place.id)?.members.map((member) => member.userId) ?? [],
          }
        : { kind: "member", userId: place.id },
  }));
}

/* ------------------------------------------------------------------ */
/* Writing                                                            */
/* ------------------------------------------------------------------ */

/**
 * Record where everyone finished, replacing whatever was there (UC-33 3-4, 4a).
 *
 * ## The correction is the same call
 *
 * There is no separate edit path and no diff: the order sent *is* the order,
 * and the old rows go. That is the whole of UC-33 4a — a season stores no
 * total, so re-scoring is nothing more than the next read finding different
 * places. A correction therefore cannot leave a stale figure behind, because
 * there was never a figure to go stale.
 *
 * ## Who may appear in it
 *
 * Anybody in the participant list, plus anybody already recorded. The second
 * half is not laxity: somebody who finished third and has since withdrawn, or
 * been dropped from a roster, still *took part*, and UC-33 3d refuses the
 * player who was never in the event rather than the one who has since left it.
 * Without it, an admin correcting one typo would silently delete the place of
 * everybody who had moved on since — the sort of quiet destruction this
 * codebase refuses everywhere else.
 *
 * ## Refused while the season is finished
 *
 * UC-33 1a, asked with the message every other write uses. The event's own
 * status is deliberately *not* asked: UC-33 1b says a complete event may still
 * have its championship result recorded, because the result belongs to the
 * season rather than to the event's own record (UC-09 6b locks that, and this
 * is not part of it).
 */
export async function setPlacements(
  eventId: string,
  order: PlacementEntry[],
  database: Database = defaultDb
): Promise<ChampionshipResult<RecordedResult>> {
  const current = await championshipOfEvent(eventId, database);
  if (!current) return fail(NOT_COUNTING);

  const locked = championshipLockRefusal(current.season);
  if (locked) return fail(locked);

  const participants = await eventParticipants(eventId, database);
  const known = new Map(participants.rows.map((row) => [row.id, row]));
  const recorded = new Map(
    (await listPlacements(eventId, database)).map((row) => [row.id, row])
  );

  const entries: RecordedPlacement[] = [];
  const seen = new Set<string>();
  let doubled: string | null = null;

  for (const entry of order) {
    const problem = positionProblem(entry.position);
    if (problem) return fail(problem);

    const row = known.get(entry.id);
    const already = recorded.get(entry.id);
    const kind = row ? (participants.teamed ? "team" : "member") : already?.kind;
    if (!kind) return fail(NOT_IN_EVENT);

    // Kept rather than returned at once, so a member doubled through a team is
    // named by `duplicateMemberIn` below in preference to the row's own name.
    if (seen.has(entry.id) && doubled === null) doubled = row?.name ?? UNKNOWN_PLAYER;
    seen.add(entry.id);

    entries.push({
      id: entry.id,
      position: entry.position,
      kind,
      name: row?.name ?? already?.name ?? UNKNOWN_PLAYER,
    });
  }

  /*
   * UC-33 3c. The rule spans the two columns — a member placed directly *and*
   * through a team is one member placed twice — so the database cannot state
   * it and `duplicateMemberIn` does. It also catches the ordinary form, one
   * team or one player listed twice, and names the person rather than the row.
   */
  const twice = duplicateMemberIn(subjectsFor(participants, entries));
  if (twice) {
    const names = await displayNamesFor([twice], database);
    return fail(twiceIn(names.get(twice) ?? UNKNOWN_PLAYER));
  }
  // The one duplicate it cannot see: a team with nobody on it puts no member
  // into the order at all.
  if (doubled !== null) return fail(twiceIn(doubled));

  return database.transaction(async (tx) => {
    /*
     * The lock as the write itself sees it. `championship_placements` cannot
     * name a status in its own `where`, and the check above is ten statements
     * old, so both rows this write depends on are taken for update first: the
     * counting row, which `removeCountingEvent` may have deleted, and the
     * season, which may have been closed. Taking them in that order — child,
     * then parent — is the order every other write here reaches them in.
     */
    const [countingRow] = await tx
      .select({
        id: championshipEvents.id,
        championshipId: championshipEvents.championshipId,
      })
      .from(championshipEvents)
      .where(eq(championshipEvents.eventId, eventId))
      .for("update")
      .limit(1);
    if (!countingRow) return fail(NOT_COUNTING);

    const [season] = await tx
      .select({ status: championships.status })
      .from(championships)
      .where(eq(championships.id, countingRow.championshipId))
      .for("update")
      .limit(1);
    if (!season) return fail("That championship no longer exists.");

    const shut = championshipLockRefusal(season);
    if (shut) return fail(shut);

    await tx
      .delete(championshipPlacements)
      .where(eq(championshipPlacements.championshipEventId, countingRow.id));

    if (entries.length > 0) {
      await tx.insert(championshipPlacements).values(
        entries.map((entry) => ({
          championshipEventId: countingRow.id,
          position: entry.position,
          userId: entry.kind === "member" ? entry.id : null,
          teamId: entry.kind === "team" ? entry.id : null,
        }))
      );
    }

    return {
      ok: true,
      data: {
        counting: current,
        placements: [...entries].sort((x, y) => x.position - y.position),
      },
    };
  });
}
