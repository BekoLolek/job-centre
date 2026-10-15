import { describe, expect, it } from "vitest";
import type { ProfileValue } from "@/db/schema";
import { type DetailRowLike, detailWrites } from "../writes";

/*
 * What one tap on the apply form writes to the profile (R-49 / UC-12 3).
 *
 * `confirmed_at` is "when the member last said this answer is right", and
 * `schema.ts` names the only screen allowed to write it: "the apply page sets
 * it when the member taps *that is all still right*". A stamp nobody gave is
 * therefore not a small inaccuracy — it is the column saying the member
 * re-checked an answer they never looked at, and `confirmed_at > updated_at`
 * is exactly the comparison a manager makes before trusting somebody's rank.
 *
 * The form could not be driven in this harness (no DOM, nothing to click), and
 * the rule was a loop inside its submit handler — which is how it came to build
 * `confirming` for every answered detail whatever the member had done, on a
 * path that does not even require the tap (`mode: "edit"` is not gated on
 * `confirmed`; R-53 / UC-13 3 says they came back to change one answer). So the
 * rule moved to `detailWrites` and the tests are here.
 */

const ANSWERED: DetailRowLike[] = [
  { id: "detail-rank", value: "Diamond II" },
  { id: "detail-role", value: ["vanguard"] },
];

/** The blank the member has never answered, and the one they just cleared. */
const WITH_BLANKS: DetailRowLike[] = [
  ...ANSWERED,
  { id: "detail-notes", value: null },
  { id: "detail-cleared", value: [] as ProfileValue },
];

const valuesOf = (details: readonly DetailRowLike[]): Record<string, ProfileValue> =>
  Object.fromEntries(details.map((detail) => [detail.id, detail.value]));

describe("what the apply form writes when nothing was touched", () => {
  it("stamps every answered detail once the member confirms", () => {
    // The three taps, second one: they read the block and said it is right.
    const { details, confirming } = detailWrites({
      details: WITH_BLANKS,
      values: valuesOf(WITH_BLANKS),
      touched: {},
      confirmed: true,
    });

    expect(details).toEqual({});
    expect(confirming).toEqual(["detail-rank", "detail-role"]);
  });

  it("stamps nothing at all until they do", () => {
    /*
     * The assertion this file exists for. Editing an application is not gated
     * on the confirm button, so an ungated `confirming` turns "Save changes"
     * after flipping one day chip into a fresh confirmation of the member's
     * whole profile for that game — a stamp nobody gave, contradicting both
     * R-49 and the docblock on `profile_values.confirmed_at`.
     */
    const { details, confirming } = detailWrites({
      details: WITH_BLANKS,
      values: valuesOf(WITH_BLANKS),
      touched: {},
      confirmed: false,
    });

    expect(confirming).toEqual([]);
    expect(details).toEqual({});
  });

  it("never stamps a blank, confirmed or not", () => {
    // There is no answer to vouch for, and `commitDetails` has no row to
    // stamp: confirming is a statement about an answer that exists.
    for (const confirmed of [true, false]) {
      expect(
        detailWrites({
          details: [
            { id: "detail-notes", value: null },
            { id: "detail-cleared", value: [] as ProfileValue },
          ],
          values: { "detail-notes": null, "detail-cleared": [] },
          touched: {},
          confirmed,
        }).confirming
      ).toEqual([]);
    }
  });
});

describe("what it writes when the member changed something", () => {
  it("saves what they touched and stamps the rest", () => {
    /*
     * UC-12 3a saves the edit; touching an answer is a stronger form of
     * checking it than pressing the button, so the form sets `confirmed` on
     * the first change and the untouched answers are vouched for with it. The
     * edited one is *saved*, not stamped — `commitDetails` stamps it as part
     * of writing it, because saving an answer is asserting it.
     */
    const { details, confirming } = detailWrites({
      details: ANSWERED,
      values: { "detail-rank": "Diamond I", "detail-role": ["vanguard"] },
      touched: { "detail-rank": true },
      confirmed: true,
    });

    expect(details).toEqual({ "detail-rank": "Diamond I" });
    expect(confirming).toEqual(["detail-role"]);
  });

  it("sends a cleared answer as a blank rather than leaving it out", () => {
    // `checkDetails` reads a blank as "delete the row"; leaving it out of the
    // payload would mean "do not touch it", and the member who just emptied
    // the box would find it exactly as it was.
    const { details, confirming } = detailWrites({
      details: ANSWERED,
      values: { "detail-rank": null, "detail-role": ["vanguard"] },
      touched: { "detail-rank": true },
      confirmed: true,
    });

    expect(details).toEqual({ "detail-rank": null });
    expect(confirming).toEqual(["detail-role"]);
  });

  it("writes a touched detail even when nothing was confirmed", () => {
    // The gate is on the stamp, never on the save: a value the member typed is
    // theirs whatever they did or did not press afterwards.
    const { details, confirming } = detailWrites({
      details: ANSWERED,
      values: { "detail-rank": "Diamond I", "detail-role": ["vanguard"] },
      touched: { "detail-rank": true },
      confirmed: false,
    });

    expect(details).toEqual({ "detail-rank": "Diamond I" });
    expect(confirming).toEqual([]);
  });
});
