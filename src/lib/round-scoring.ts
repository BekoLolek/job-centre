/**
 * What a round-scored night's table says (docs/decisions/006-round-scored-events.md;
 * UC-46 1, 2, 2a / R-228, R-231, R-232, R-238).
 *
 * Pure, in the same sense as `./championship-policy`: plain data in, plain data
 * out, no database handle, no clock, and **no imports at all**. That is not
 * tidiness. Decision 006 says a round score is a recorded fact while a total
 * never is, so the night's ranking is a *function* of the rows, re-run on every
 * read — and the module that is that function has to be loadable by the screen
 * typing a round as well as by the season reading it, which rules out anything
 * that drags `@/db` in behind it.
 *
 * Four rules the obvious implementation gets wrong, which is why this is a
 * module of its own rather than a reduce in the page:
 *
 *  1. **A blank round is that round's worst recorded score, not zero** (R-228).
 *     In a low-wins event a zero is the best mark on the board, so `?? 0` hands
 *     the night to whoever skipped a round. "Worst" is worst *among the players
 *     who scored that round* — a blank means "finished behind everyone who
 *     played", and who played is a fact about the round, not about the night.
 *     A round nobody scored is therefore a label with nothing under it and
 *     contributes nothing to anybody. Worst in the night was considered and
 *     rejected: a 20-player placing round and a 5-player one do not share a
 *     scale, and borrowing the big round's last place would invent a penalty
 *     nobody in the small round received.
 *
 *  2. **A bonus is points in the player's favour**, so with low-wins it
 *     subtracts (Constraints). Adding in both directions turns every reward
 *     into a penalty for half the games on the site.
 *
 *  3. **Equal totals share a place and the next is skipped** — 1, 1, 3. That is
 *     the shape the bracket's placements already produce, and the shape
 *     `placementValue` in `./championship-policy` already pays correctly:
 *     `pointsTable[position - 1]` pays the first row twice and the second row
 *     to nobody. 1, 1, 2 would silently pay the second row to the third player.
 *
 *  4. **A player with no score in any round is not placed.** They took part and
 *     played nothing, which is not a finishing place; the season gives them the
 *     taking-part points through UC-33 3b's existing path. Decision 006 makes
 *     the absence of a row the only representation of "did not play", so this
 *     module takes rows and nothing else — a participant list would be a second
 *     place for that player to come from, and the one they could be ranked last
 *     from.
 */

/**
 * The most rounds a night may have.
 *
 * Defined here and nowhere else in code. The migration that creates
 * `event_round_scores` carries the same number as a literal in its CHECK
 * clause, because a CHECK cannot import a constant; the test in
 * `src/db/__tests__/round-scoring-max-rounds.test.ts` reads that clause out of
 * `information_schema` and compares it with this, so the two cannot drift apart
 * in silence. Thirty-two is well past any night this community will run and
 * still small enough that a screen rendering one box per round has nothing to
 * think about.
 */
export const MAX_ROUNDS = 32;

/* ------------------------------------------------------------------ */
/* What goes in                                                       */
/* ------------------------------------------------------------------ */

/**
 * How a night scores — the two facts about the setup the ranking reads.
 *
 * Structural rather than the stored config's type, for the reason `TopRow` in
 * `./championship-policy` is: the ranking needs which way a round is won and
 * what each bonus is worth, and a caller holding the whole setup fits without
 * this module importing where that setup lives.
 */
export type RoundSetup = {
  /** True when the lower score takes a round (a placing game); false when the higher one does (a points game). */
  lowWins: boolean;
  /** What each bonus is worth, keyed as the awards on a score row are. */
  bonuses: readonly { key: string; value: number }[];
};

/**
 * One player's recorded score in one round — the fields of an
 * `event_round_scores` row the ranking reads, named as the row names them so a
 * selected row is one without a mapping step.
 */
export type RoundScoreRow = {
  /** 1-based. A label, not an array index: the rounds scored need not be consecutive. */
  roundIndex: number;
  userId: string;
  score: number;
  /** How many times each bonus was earned in this round, by key. */
  bonuses: Readonly<Record<string, number>>;
};

/* ------------------------------------------------------------------ */
/* What comes out                                                     */
/* ------------------------------------------------------------------ */

/** One player's place in the night. Derived on every read, never stored. */
export type RoundRank = {
  userId: string;
  /** 1-based. Equal totals share one, and the next is then empty. */
  position: number;
  /** Every round added up, blanks included, plus bonuses in the player's favour. */
  total: number;
};

/* ------------------------------------------------------------------ */
/* The rules                                                          */
/* ------------------------------------------------------------------ */

/** The worst score anybody recorded in each round that has one. */
function worstByRound(setup: RoundSetup, rows: readonly RoundScoreRow[]): Map<number, number> {
  const worst = new Map<number, number>();
  for (const row of rows) {
    const current = worst.get(row.roundIndex);
    if (current === undefined) {
      worst.set(row.roundIndex, row.score);
      continue;
    }
    worst.set(
      row.roundIndex,
      setup.lowWins ? Math.max(current, row.score) : Math.min(current, row.score)
    );
  }
  return worst;
}

/** What a player's awards are worth before the sign — count times value, every round. */
function bonusPoints(setup: RoundSetup, rows: readonly RoundScoreRow[]): number {
  const valueOf = new Map(setup.bonuses.map((bonus) => [bonus.key, bonus.value]));
  let points = 0;
  for (const row of rows) {
    for (const [key, count] of Object.entries(row.bonuses)) {
      // A key the setup no longer defines is worth nothing. UC-44 4d refuses
      // deleting an awarded bonus, so this should not arise; but the public
      // page reads this, so it stays total rather than throwing.
      points += (valueOf.get(key) ?? 0) * count;
    }
  }
  return points;
}

/**
 * The night's table, best total first.
 *
 * Takes the setup and the score rows, and nothing else: no database handle and
 * no participant list, so the screen previewing an unsaved round and the season
 * reading the saved ones run the identical arithmetic. Players appear iff they
 * have a score in at least one round, in the order they first appear in `rows`
 * where the totals do not separate them.
 */
export function rankRounds(setup: RoundSetup, rows: readonly RoundScoreRow[]): RoundRank[] {
  const worst = worstByRound(setup, rows);

  const rowsByPlayer = new Map<string, RoundScoreRow[]>();
  for (const row of rows) {
    const own = rowsByPlayer.get(row.userId);
    if (own) own.push(row);
    else rowsByPlayer.set(row.userId, [row]);
  }

  const ranks: RoundRank[] = [];
  for (const [userId, own] of rowsByPlayer) {
    const scored = new Map(own.map((row) => [row.roundIndex, row.score]));
    let total = 0;
    for (const [round, worstScore] of worst) {
      total += scored.get(round) ?? worstScore;
    }
    const bonus = bonusPoints(setup, own);
    total += setup.lowWins ? -bonus : bonus;
    ranks.push({ userId, position: 0, total });
  }

  ranks.sort((x, y) => (setup.lowWins ? x.total - y.total : y.total - x.total));

  // 1, 1, 3 — the same shape as a shared finishing place, for the same reason.
  let position = 0;
  for (let i = 0; i < ranks.length; i += 1) {
    const tied = i > 0 && ranks[i - 1].total === ranks[i].total;
    if (!tied) position = i + 1;
    ranks[i].position = position;
  }

  return ranks;
}
