# Decision 004: A refusal returned from a transaction commits

**Date:** 2026-10-22
**Status:** Accepted (Task 57)
**Applies to:** every `database.transaction(...)` in `src/lib/`, and every write that calls
something which can refuse

## The rule

**Inside a transaction callback, decide everything before you write anything. If you cannot,
`throw` the refusal instead of returning it.**

Nothing in this repo calls `tx.rollback()`, and drizzle **commits** a transaction whose
callback *returns* rather than throws. So this:

```ts
return database.transaction(async (tx) => {
  await tx.delete(stages).where(/* … */);        // written
  if (somethingIsWrong) return fail("Nothing was changed.");   // ← and committed
});
```

writes the delete, commits it, and hands the caller a sentence saying it did not. The refusal
is the lie; the transaction did exactly what it was told.

## A returned refusal is not a throw

This is the distinction the rule turns on, and two docblocks in `events.ts` got it wrong
before they were corrected:

- **A returned refusal commits.** `return fail(…)`, `return { ok: false, … }` — the callback
  completes normally, so drizzle issues `COMMIT`. Everything written before that line is
  durable. This is the bug.
- **A throw rolls back.** Any exception out of the callback makes drizzle issue `ROLLBACK`
  (and `ROLLBACK TO SAVEPOINT` for a nested one). So a *crash* after a write — a constraint
  violation, an exhausted loop bound, a broken invariant — **is not this bug**. The
  transaction undoes it, which is the mechanism working as designed. Do not "fix" a crash
  path by catching it and returning a refusal: that converts a correct rollback into this
  defect.

So the audit question is narrow: **is there a refusal *after* a write?** Not "can anything go
wrong after a write".

## The three safe shapes

A transaction callback is safe when it is one of these:

1. **Decides everything before its first write.** Every `fail()` precedes every `tx.insert` /
   `tx.update` / `tx.delete` / `tx.execute`. This is most of `src/lib`, and it is the shape to
   aim for.
2. **Stages, then writes.** Validation builds the rows it *would* write, refuses off the staged
   result, and only then writes them. `recordGames` in `src/lib/format.ts` is the worked
   example (Task 22): two explicit passes, the second of which cannot refuse.
3. **Writes once, and the refusal is that write's own zero-row result.** A compare-and-set —
   `update … where id = $1 and status = 'open'` then `if (!row) return fail(…)` — refuses
   because the statement matched nothing, so there is nothing to roll back. `awardLot`,
   `discardLot`, `moveToReserve`, `updateEvent` and `publishEvent` all work this way. The
   guarded write has to be the **first** write for this to hold: `voidLotIn` had the same
   compare-and-set *last*, behind a roster delete and a pool insert, and that was a real bug.

## When none of them fit: throw

Sometimes the refusal genuinely belongs to a callee that cannot be asked until after a write,
and restating its rules in the caller would mean two copies of a validation. Then the refusal
is thrown as a **module-private error class** and turned back into the same sentence at the
function boundary — never escaping as an exception:

```ts
class HalfCleared extends Error {
  constructor(readonly refusal: string) { super(refusal); this.name = "HalfCleared"; }
}

export async function clearMatch(/* … */) {
  try {
    return await database.transaction(async (tx) => {
      /* … */
      if (!recorded.ok) throw new HalfCleared(recorded.error);
      /* … */
    });
  } catch (error) {
    if (error instanceof HalfCleared) return fail(error.refusal);
    throw error;
  }
}
```

The two in the tree are `HalfCleared` in `src/lib/format.ts` (`clearMatch`, Task 36) and
`NothingSaved` in `src/lib/events.ts` (`createEvent`, Task 57). Prefer staging; reach for a
throw when the refusal is not yours to make.

## And a write with no transaction at all is the same bug

A grep of `database.transaction(` will not find it. `createEvent` inserted the event row on the
bare handle and *then* called `setEventQuestions` and `setEventDays`, returning their refusals
— so UC-08 10c's "nothing saved" was false for both paths, with no transaction to roll back.
If a function writes and then calls anything that can refuse, it needs a transaction around
both, and then this rule.

## Why it is written here

It was found twice independently and was a real defect both times — `recordGames` (Task 22)
and `clearMatch` (Task 36) — and a rule found twice and written down nowhere is the thing to
fix. It is not in `AGENTS.md` because `next dev` rewrites that file.

## How it is held

`format-db.test.ts`, `archive-lock.test.ts`, `events.test.ts` and `draft.test.ts` each assert,
for the writes that had this bug, that the refusal leaves the earlier rows exactly as they
were — not merely that it answers `ok: false`, which the buggy version also did.

The closing section's half of it — a pair of calls with no transaction around them — is held
one layer up, in the action tests, because that is where the pair is: the
`beforeRemoval`/`BeforeRemoval` hook in `src/lib/draft.ts` exists so that the release a team
write needs first happens *inside* that write's transaction rather than ahead of it.
`random-teams-actions.test.ts` (Task 78) and `format-follows-teams.test.ts` (Task 79) assert,
for each of the three actions that remove a team, that a refused save leaves the generated
matches still naming their teams.
