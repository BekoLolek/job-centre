import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_ROUNDS } from "@/lib/round-scoring";
import { type TestDatabase, freshDatabase } from "./helpers";

/**
 * The one place the literal in drizzle/0033 and the constant the panel
 * validates with can be compared (docs/plan.md Task 86's last criterion).
 *
 * `event_round_scores_round_range` says `32` as a literal because a CHECK
 * constraint cannot import a constant; `MAX_ROUNDS` in `src/lib/round-scoring.ts`
 * is the number every screen and policy function uses. If the two drift the
 * failure is silent and one-sided — a panel allowing 40 rounds would have the
 * 33rd save refused with a constraint name, and nothing else in the suite would
 * say why. `hero_hands_nine_distinct_per_role` has the same test for the same
 * reason (`hero-hands-constraints.test.ts`).
 *
 * Read out of `information_schema` rather than asserted as arithmetic: the
 * point is the number the live constraint is enforcing, not the number this
 * file believes somebody wrote.
 */

let ctx: TestDatabase;

beforeAll(async () => {
  ctx = await freshDatabase();
});

afterAll(async () => {
  await ctx.close();
});

describe("the round cap", () => {
  it("is the number the table's CHECK clause carries", async () => {
    const result = await ctx.client.query<{ check_clause: string }>(
      `select check_clause from information_schema.check_constraints
         where constraint_name = 'event_round_scores_round_range'`
    );
    expect(result.rows).toHaveLength(1);
    // Postgres stores `between 1 and 32` as `>= 1 and <= 32`, so the upper
    // bound is read as a comparison rather than as the words the migration used.
    expect(result.rows[0].check_clause).toContain(`<= ${MAX_ROUNDS}`);
  });
});
