/**
 * How a season scores (docs/domain-model.md — Championship, CountingEvent,
 * Placement, Standing; docs/diagrams/championship-state.md "How a season is
 * scored").
 *
 * Pure, in the same sense as `./format-policy`: plain data in, plain data out,
 * no database handle, no clock. That is not tidiness — it is the whole reason
 * a correction cannot leave a stale total behind. A standing is a *function* of
 * the recorded places, so re-running `scoreChampionship` over corrected
 * placements is the entire correction path (R-179), exactly as a bracket slot's
 * teams are re-derived on every read rather than written down (§1.1, §8.5).
 *
 * Nothing here knows what a championship's status is. Whether a place may be
 * recorded at all is the `closed` lock, which belongs to the write path; a
 * closed season is scored the same way as an open one.
 *
 * ## Two rules this module decides, because the domain model does not
 *
 *  1. **A place beyond the end of the table is worth the taking-part points**,
 *     not zero. UC-31 4 defines those points as "what taking part is worth, for
 *     anyone who played but finished outside the table", which is precisely
 *     this case; and since the participation points may never exceed the last
 *     row of the table, treating the table as flooring out at that value keeps
 *     it non-increasing all the way down. Zero would mean finishing 11th of 40
 *     scored *less* than not being ranked at all, which is the one shape a
 *     finishing order must never have.
 *  2. **A member who somehow appears twice in one event's order is counted
 *     once, at their best result.** The editor refuses to save such an order
 *     (`duplicateMemberIn`, UC-33 3c) and the database refuses the direct form
 *     of it, but a member joining a placed team *after* the fact can still
 *     produce it. Scoring is read by the public page, so it stays total: it
 *     takes the result worth the most and never adds two.
 */

/** UC-31 3's table, and the default a new championship is created with. */
export const DEFAULT_POINTS_TABLE = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

/* ------------------------------------------------------------------ */
/* What goes in                                                       */
/* ------------------------------------------------------------------ */

/** A championship's scoring rules — the `championships` row, without its identity. */
export type ChampionshipScoring = {
  /** Position 1 first. Never rises as the position falls. */
  pointsTable: number[];
  /** What taking part is worth. Also the floor beyond the end of the table. */
  participationPoints: number;
  /** Count only each member's best this many results. Null counts them all. */
  countBest: number | null;
};

/** Who finished somewhere: one member, or one team and everybody on it. */
export type PlacementSubject =
  | { kind: "member"; userId: string }
  | { kind: "team"; teamId: string; memberIds: string[] };

export type PlacementInput = {
  /** 1 or more. Two subjects may share one, and the next is then empty. */
  position: number;
  subject: PlacementSubject;
};

/** One event counting towards the season — a `championship_events` row plus its order. */
export type CountingEventInput = {
  /** Whatever the caller identifies the event by; echoed into every result. */
  id: string;
  /** Above 0. Multiplies every value this event produces. */
  weight: number;
  /** Used instead of the championship's when it has any rows. */
  pointsTable?: number[] | null;
  placements: PlacementInput[];
  /** Everyone who took part. Those not placed score the participation points. */
  participants: string[];
};

/* ------------------------------------------------------------------ */
/* What comes out                                                     */
/* ------------------------------------------------------------------ */

/** One member's result in one counting event. R-184's "game by game". */
export type SeasonResult = {
  eventId: string;
  /** Null for somebody who took part and was not placed. */
  position: number | null;
  /** The team whose place this was, when the place was a team's. */
  teamId: string | null;
  points: number;
  /** False when `countBest` left it out of the total. */
  counted: boolean;
};

/** A member's place in the season. Derived on every read, never stored. */
export type ChampionshipStanding = {
  userId: string;
  /** 1-based. Members still level after the tie rule share one, and the next is empty. */
  position: number;
  /** Counted points only. */
  points: number;
  /** `places[0]` is firsts, `places[1]` seconds … over the counted results. */
  places: number[];
  /** Every result, in the order the events were given — dropped ones included. */
  results: SeasonResult[];
  /** How many results count, of how many played (UC-34 2d). */
  counted: number;
  played: number;
  /** True when somebody else holds the same position. */
  level: boolean;
};

/* ------------------------------------------------------------------ */
/* The rules                                                          */
/* ------------------------------------------------------------------ */

/**
 * What one finishing place is worth, before the weight.
 *
 * See the note at the top of the file for why a place past the end of the
 * table falls through to the taking-part points rather than to zero.
 */
function placementValue(
  position: number,
  pointsTable: number[],
  participationPoints: number
): number {
  return pointsTable[position - 1] ?? participationPoints;
}

/** Every member a placement scores for. A team's place scores for all of them (R-180). */
function membersOf(subject: PlacementSubject): string[] {
  return subject.kind === "member" ? [subject.userId] : subject.memberIds;
}

/**
 * The first member who appears twice in one event's finishing order, whether
 * directly or through a team, or null when nobody does.
 *
 * UC-33 3c: the editor rejects such an order rather than saving it. The
 * database cannot state this rule itself — team membership changes after the
 * fact — which is why it lives here and why scoring stays total without it.
 */
export function duplicateMemberIn(event: CountingEventInput): string | null {
  const seen = new Set<string>();
  for (const placement of event.placements) {
    for (const userId of membersOf(placement.subject)) {
      if (seen.has(userId)) return userId;
      seen.add(userId);
    }
  }
  return null;
}

/** Every member's result in one counting event, keyed by member. */
function resultsForEvent(
  event: CountingEventInput,
  scoring: ChampionshipScoring
): Map<string, SeasonResult> {
  const table = event.pointsTable?.length ? event.pointsTable : scoring.pointsTable;
  const out = new Map<string, SeasonResult>();

  for (const placement of event.placements) {
    const points =
      placementValue(placement.position, table, scoring.participationPoints) * event.weight;
    for (const userId of membersOf(placement.subject)) {
      const existing = out.get(userId);
      if (existing && existing.points >= points) continue;
      out.set(userId, {
        eventId: event.id,
        position: placement.position,
        teamId: placement.subject.kind === "team" ? placement.subject.teamId : null,
        points,
        counted: true,
      });
    }
  }

  for (const userId of event.participants) {
    if (out.has(userId)) continue;
    out.set(userId, {
      eventId: event.id,
      position: null,
      teamId: null,
      points: scoring.participationPoints * event.weight,
      counted: true,
    });
  }

  return out;
}

/**
 * Which of a member's results count.
 *
 * Best by points, and between two worth the same the better finish, so the
 * choice does not depend on the order the events happen to arrive in.
 */
function applyCountBest(results: SeasonResult[], countBest: number | null): void {
  if (countBest === null || results.length <= countBest) return;

  const ranked = [...results].sort(
    (x, y) => y.points - x.points || (x.position ?? Infinity) - (y.position ?? Infinity)
  );
  const kept = new Set(ranked.slice(0, countBest));
  for (const result of results) result.counted = kept.has(result);
}

/** How many firsts, seconds, thirds … a member has among their counted results. */
function placesOf(results: SeasonResult[]): number[] {
  const counts: number[] = [];
  for (const result of results) {
    if (!result.counted || result.position === null) continue;
    const index = result.position - 1;
    for (let i = counts.length; i <= index; i += 1) counts[i] = 0;
    counts[index] += 1;
  }
  return counts;
}

/**
 * Refuse input the arithmetic below cannot represent, before any of it runs.
 *
 * Both columns forbid these already (`championship_placements_position_positive`
 * and `championships_count_best_positive`), but the preview caller this module
 * exists to serve — an order being typed, not yet saved — has no database to
 * refuse it. Without the guard neither one fails: a position of 0 reads off the
 * front of the points table and lands on the taking-part points, and a position
 * of -1 makes `placesOf` write a NaN-valued `"-1"` property onto the `places`
 * array, which is invisible in JSON and skipped by the tiebreak loop, so the
 * place is silently lost. A `countBest` of 0 keeps nothing, so everybody scores
 * zero and everybody is level first.
 *
 * A fractional position is the same defect wearing a different hat — `counts[0.5]`
 * is a property, not an element — so it is refused here too.
 *
 * These are programmer errors, not user input: by the time data reaches this
 * module it has been through a form or a column. Hence a throw rather than a
 * clamp, which would hide the bug behind a plausible-looking table.
 */
function assertScorable(scoring: ChampionshipScoring, events: CountingEventInput[]): void {
  if (scoring.countBest !== null && (!Number.isInteger(scoring.countBest) || scoring.countBest < 1)) {
    throw new Error(
      `countBest must be a whole number of 1 or more, or null to count everything; got ${scoring.countBest}.`
    );
  }
  for (const event of events) {
    for (const placement of event.placements) {
      if (!Number.isInteger(placement.position) || placement.position < 1) {
        throw new Error(
          `A finishing position must be a whole number of 1 or more; event ${event.id} has ${placement.position}.`
        );
      }
    }
  }
}

/**
 * Points, then most firsts, then most seconds, and so on (R-181). Zero means
 * genuinely level — there is no further tiebreak, by design: the domain model
 * says such members are shown level rather than separated by something
 * arbitrary like a name.
 */
function compareStandings(x: ChampionshipStanding, y: ChampionshipStanding): number {
  if (y.points !== x.points) return y.points - x.points;
  const depth = Math.max(x.places.length, y.places.length);
  for (let i = 0; i < depth; i += 1) {
    const delta = (y.places[i] ?? 0) - (x.places[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * The season's standings, in order.
 *
 * Takes the scoring rules and the counting events, and nothing else: no
 * database handle and no ids beyond the ones the caller chose, so the caller
 * that reads the placements and the caller that previews an unsaved order run
 * the identical arithmetic. Members appear iff they placed in, or took part in,
 * at least one counting event.
 */
export function scoreChampionship(
  scoring: ChampionshipScoring,
  events: CountingEventInput[]
): ChampionshipStanding[] {
  assertScorable(scoring, events);

  const byMember = new Map<string, SeasonResult[]>();
  for (const event of events) {
    for (const [userId, result] of resultsForEvent(event, scoring)) {
      const results = byMember.get(userId);
      if (results) results.push(result);
      else byMember.set(userId, [result]);
    }
  }

  const rows: ChampionshipStanding[] = [];
  for (const [userId, results] of byMember) {
    applyCountBest(results, scoring.countBest);
    const counted = results.filter((result) => result.counted);
    rows.push({
      userId,
      position: 0,
      points: counted.reduce((sum, result) => sum + result.points, 0),
      places: placesOf(results),
      results,
      counted: counted.length,
      played: results.length,
      level: false,
    });
  }

  rows.sort(compareStandings);

  // 1, 1, 3 — the same shape as a shared finishing place, for the same reason.
  let position = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const tied = i > 0 && compareStandings(rows[i - 1], rows[i]) === 0;
    if (!tied) position = i + 1;
    rows[i].position = position;
    rows[i].level = tied;
    if (tied) rows[i - 1].level = true;
  }

  return rows;
}
