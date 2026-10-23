/**
 * Sides nobody chose — the arithmetic half of UC-41 (R-216).
 *
 * No database and no React, for the reason `heroes-policy.ts` is separate from
 * the draw page: the only interesting thing here is whether the shuffle is
 * uniform and whether the sizes add up, and both are answerable with numbers
 * on a desk. The write lives in `assignRandomTeams` in `src/lib/draft.ts`.
 *
 * ## Randomness is injected, never called
 *
 * Nothing in this file reaches for `Math.random`. A function that does cannot
 * be tested — "it looked random" is not evidence — so the source arrives as a
 * parameter and the action layer is the one place that passes the real one.
 * `random-teams.test.ts` hands it a known sequence and asserts the exact
 * assignment that comes out, and enumerates the whole output space of a
 * three-player shuffle to prove every player can reach every seat.
 */

import { MAX_TEAMS, MIN_TEAMS } from "@/lib/draft-policy";

/* ------------------------------------------------------------------ */
/* The shuffle                                                        */
/* ------------------------------------------------------------------ */

/**
 * A uniform shuffle — Fisher-Yates, walked from the back.
 *
 * `random()` is read as a number in `[0, 1)`, which is `Math.random`'s
 * contract and what every seeded generator in the tests produces.
 *
 * ## The off-by-one this spells out on purpose
 *
 * The swap partner is drawn from `0 .. index` **inclusive**, which is why the
 * multiplier is `index + 1` and not `index`. With `index` the element at
 * `index` can never be chosen as its own partner, so position `index` can only
 * ever be filled from below it: the last element can never stay where it is,
 * the first can never move to the end, and a third of the permutations become
 * unreachable. Nothing about the output *looks* wrong — it is still shuffled,
 * still different every run — which is exactly why it survives review and why
 * `random-teams.test.ts` enumerates all six permutations of three players
 * rather than eyeballing one.
 *
 * The loop stops at `index > 0` rather than `index >= 0` because position 0
 * has no partner left to draw from: `0 .. 0` is itself, so the final iteration
 * would burn a number off the generator to swap an element with itself. That
 * matters here beyond tidiness — a test that predicts an exact assignment from
 * a known sequence is predicting how many numbers get consumed.
 */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const partner = Math.floor(random() * (index + 1));
    [out[index], out[partner]] = [out[partner], out[index]];
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* How many teams, and how big                                        */
/* ------------------------------------------------------------------ */

export type TeamPlan = {
  /** How many teams these people make. */
  teams: number;
  /** How many players each team gets, in team order, biggest first. */
  sizes: number[];
  /**
   * 1-based positions of the teams that came out below `teamSize` — what
   * UC-41 4a puts on the screen *before* anything is saved.
   */
  short: number[];
};

export type TeamPlanResult =
  | { ok: true; plan: TeamPlan }
  | { ok: false; error: string };

/**
 * How `people` players divide into teams of `teamSize`, or why they cannot.
 *
 * ## An uneven count is spread, not dumped on the last team (UC-41 4a)
 *
 * The team count is `ceil(people / teamSize)`, so **everybody gets a seat** —
 * a floor would leave the remainder off the teams altogether, which is not a
 * shuffle of "the accepted participants" but a shuffle of most of them.
 *
 * The shortfall is then dealt round-robin rather than left on one team. 16
 * players at six a side is three teams, and the naive answer is `6, 6, 4`:
 * one team two players light while the others are full, which on the night is
 * the team that cannot field a comp. This gives `6, 5, 5`. The rule is one
 * extra player per team until the remainder runs out, so no two teams ever
 * differ by more than one, and `short` names the ones below `teamSize` so the
 * screen can say which they are before the admin commits.
 *
 * ## Both refusals name both numbers
 *
 * **Fewer people than one team needs** (UC-41 4b) is refused with the count
 * and the team size in the sentence, because "not enough players" leaves the
 * admin to work out how many more they need.
 *
 * **One team's worth exactly** is refused too, and this is the case the
 * use-case does not spell out: six players at 6v6 is `ceil(6 / 6) = 1` team,
 * which is not a side, it is everybody standing on the same half of the map.
 * `setTeamCount` would refuse it anyway — an event takes between
 * {@link MIN_TEAMS} and {@link MAX_TEAMS} teams — but it would refuse it after
 * the shuffle had been promised, with its own sentence about team counts and
 * nothing about the format. Refusing here means the screen can say what is
 * actually wrong.
 *
 * The ceiling is the same bound from the other end: nine teams' worth of
 * people cannot be stored, so it is refused before anything is written rather
 * than discovered by `setTeamCount` halfway through.
 */
export function planTeams(people: number, teamSize: number): TeamPlanResult {
  if (!Number.isInteger(teamSize) || teamSize < 1) {
    return { ok: false, error: "A team has to hold at least one player." };
  }
  if (!Number.isInteger(people) || people < 0) {
    return { ok: false, error: "That is not a number of players." };
  }

  if (people < teamSize) {
    return {
      ok: false,
      error: `Only ${people} ${people === 1 ? "player is" : "players are"} accepted, and one team of ${teamSize} needs ${teamSize}. Accept more on the Applicants tab.`,
    };
  }

  const teams = Math.ceil(people / teamSize);

  // Reachable only at `people === teamSize` — anything larger rounds up to two
  // teams, anything smaller was refused above — so one more player is always
  // exactly what is missing, and the sentence can say so.
  if (teams < MIN_TEAMS) {
    return {
      ok: false,
      error: `${people} players at ${teamSize} a team makes one team, and an event needs at least ${MIN_TEAMS}. Accept one more and there are two sides.`,
    };
  }
  if (teams > MAX_TEAMS) {
    return {
      ok: false,
      error: `${people} players at ${teamSize} a team would make ${teams} teams, and an event can have at most ${MAX_TEAMS}.`,
    };
  }

  // Spread round-robin: the first `spare` teams carry one extra, so the
  // biggest and smallest team differ by at most one.
  const base = Math.floor(people / teams);
  const spare = people % teams;
  const sizes = Array.from({ length: teams }, (_, index) =>
    index < spare ? base + 1 : base
  );

  return {
    ok: true,
    plan: {
      teams,
      sizes,
      short: sizes
        .map((size, index) => (size < teamSize ? index + 1 : 0))
        .filter((position) => position > 0),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Dealing the people out                                             */
/* ------------------------------------------------------------------ */

/**
 * Shuffle these players and cut them into the plan's teams.
 *
 * One shuffle and then straight slices, rather than dealing one at a time
 * round the table: both are uniform, and a single shuffle is the one whose
 * output a test can predict from a known sequence of numbers without
 * re-deriving the dealing order.
 *
 * The plan's sizes sum to `userIds.length` by construction, so the last slice
 * is exactly the tail and nobody is dropped. The assertion guards the one way
 * that could stop being true — a caller pairing a plan with a different list
 * of people than it was made for — because the failure is otherwise a silently
 * short roster.
 */
export function dealTeams(
  userIds: readonly string[],
  plan: TeamPlan,
  random: () => number
): string[][] {
  const total = plan.sizes.reduce((sum, size) => sum + size, 0);
  if (total !== userIds.length) {
    throw new Error(
      `That plan is for ${total} players and ${userIds.length} were handed to it.`
    );
  }

  const order = shuffled(userIds, random);
  const out: string[][] = [];
  let taken = 0;
  for (const size of plan.sizes) {
    out.push(order.slice(taken, taken + size));
    taken += size;
  }
  return out;
}
