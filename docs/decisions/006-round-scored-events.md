# Decision 006: How a round-scored solo event is stored, and who owns its finishing order

**Date:** 2026-10-24
**Status:** Accepted at Gate 2 (R-224 to R-238 / UC-44 to UC-46)

## Context

A Popsauce or Fall Guys night has no teams, no bracket and no matches. R-219 already promised
that "a solo event still has a running order and a winner", but there was nowhere to record the
winner: the Results step of a solo event renders one empty state, and the only place a solo
finishing order could be typed is the championship panel, which exists only when the event
counts towards a season.

Two structural choices have to be made before anything is built, and both of them collide with
rules this repo already holds.

---

## Decision 1: round scores are rows in a new table, with bonuses on the row

### The collision

`src/db/schema.ts:2699` says, in the championship section: **"There is no `points` column anywhere
below this comment."** Points are worked out from recorded places on every read. A per-round score
would be the first stored numeric input in that subsystem, so the principle has to be read
carefully rather than obeyed by reflex.

### Options

| | A: a table, `event_round_scores` | B: a jsonb blob in `events.config` | C: two tables, scores and bonus awards |
|---|---|---|---|
| **Shape** | one row per (event, round, player); bonuses a jsonb column on the row | the whole night under one config key | a scores table plus an awards table keyed (event, round, player, bonus) |
| **Pros** | - The row is the unit the screen saves<br>- `unique(event, round, player)` makes "scored twice" impossible<br>- Two managers saving one round collide on real rows | - No migration | - Awards queryable on their own |
| **Cons** | - A migration | - **A round save becomes a read-modify-write of the whole event config**, which is the lost-update race the repo avoids everywhere else<br>- `updateEvent` merges one level deep, so a nested write is a rewrite of the key<br>- Unbounded growth in a column read on every event page | - An award can exist with no score behind it, which UC-45 3c says must be impossible<br>- Two writes per round, so decision 004 applies where one write would do |

### Decision

**A.** The principle in the schema is that **a derived value is never stored** — not that no number
is ever stored. A round score is a *recorded fact*: a person typed it, exactly as a person types a
match's maps into `match_games`. What stays derived is everything worked out from it — a player's
total, the night's ranking, the championship places, the season standings. Nothing stores a total,
and correcting a round re-scores every one of those on the next read.

The repo's own argument for `championships.points_table` being jsonb is *"one ordered list saved
whole by one form, never queried a row at a time"*. Round scores are the opposite: many facts, read
per event, written per round, and contended by two managers at the same keyboard moment.

**Bonuses are a jsonb column on the score row** (`Record<bonusKey, count>`), not a second table.
A bonus award has no meaning apart from the round it was earned in, and UC-45 3c makes that a
refusal: a player left blank for a round cannot have earned something in it. With bonuses on the
row, **absence of a row is the only representation of "did not play"**, so that refusal is
impossible to violate rather than policed by a guard somebody can forget. `score` is therefore
`not null` — a blank is no row at all.

### Consequences

- One migration, one new table, and `migrations.test.ts`'s hardcoded table count moves (Task 75's
  note says that count is the thing a new table breaks silently).
- Bonus *counts* cannot be constrained by a CHECK inside jsonb, so a count below 1 is refused by the
  policy function shared between the panel and the action — stated, because a CHECK is otherwise
  this project's preference.
- Scores are whole numbers. A decimal score is out of scope; a feat measured in fractions of a
  second is a bonus (R-229).

---

## Decision 2: for a round-scored event, the table is the only authority for the finishing order

### The collision

`setPlacements` (`src/lib/championship-results.ts:448`) is today the single authority for a
championship finishing order: the order sent *is* the order, and the old rows go. There is no diff
and no second path, and `countingEventInput` was written so that there is "exactly one of it". If a
round-scored event also derived its places from its rounds, one fact would have two writers —
precisely the hazard that design avoids.

### Options

| | A: the table wins | B: the table proposes, the manager confirms | C: the manager's order wins, rounds are decoration |
|---|---|---|---|
| **Shape** | places derived from the rounds on every read; the hand editor refuses for such an event | derived order written into `championship_placements` by an explicit action, with a staleness warning when the rounds move afterwards | rounds are recorded but the season reads only the typed order |
| **Pros** | - One authority, nothing stored twice, nothing can go stale<br>- Matches "nothing stores a total"<br>- A correction to a round moves the standings with no second step | - Keeps `setPlacements` the only writer<br>- Allows an override for a disputed night | - No change to the championship path at all |
| **Cons** | - **No manual override**: a contested result is fixed by editing the round, not by dragging a player<br>- `countingEventInput` grows a branch | - Re-introduces a stored copy that can disagree with its source, which is the `outOfDateSince` problem the bracket already has<br>- Two screens, one fact | - The night's table and the season can disagree, which R-236 exists to prevent |

### Decision

**A**, chosen by the user at Gate 1 after the trade-off was put to them in these terms. For a
round-scored event the places come from `rankRounds`, and `setPlacements` refuses, pointing at the
Results tab. The hand-typed order stays exactly as it is for every event that is not round-scored.

The cost is accepted and is worth writing down plainly: **there is no way to drag a player to first
place.** A wrong result is fixed where it was entered — in the round — which is the honest place,
and the only place that keeps the night's table and the season's table telling one story.

### Consequences

- `countingEventInput` branches on whether the event is round-scored. That branch is the one place
  the two worlds meet, so it carries the reasoning.
- A shared place is produced by the derived order, and `placementValue` already pays both players
  the same row and skips the next (verified: `pointsTable[position - 1] ?? participationPoints`).
  R-238 is therefore about the *derivation* producing the tie, not about the scoring honouring it.
- An event switched to round-scored after a hand-typed order was saved leaves those rows in place
  and ignored. Nothing on the record is hard-deleted (Constraints), but dead-and-ignored rows are
  worse than either alternative, so **Task 91 must decide and state what happens to them** rather
  than letting the branch quietly shadow them.
- A player with no score in any round is **not placed**. They took part and played nothing, which is
  not a finishing place, so the season gives them the taking-part points through the path UC-33 3b
  already uses.
