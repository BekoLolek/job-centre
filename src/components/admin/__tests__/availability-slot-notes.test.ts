import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SlotTally } from "@/lib/availability-resolve";
import { SlotDetail } from "../AvailabilityGrid";

/**
 * UC-07 6's slot list, which is where UC-06 E1's note has to end up (R-134).
 *
 * > **E1.** At step 6, member adds a note ("away at a wedding") — System
 * > stores it with the override and shows it to **admins in UC-07's slot
 * > list**.
 *
 * `src/lib/__tests__/availability-notes.test.ts` takes the note as far as the
 * `SlotTally`; this is the last few inches, and they are the ones that were
 * missing — the data was never there, so neither was the panel markup to show
 * it. Rendered rather than grepped: a test that searched the source for
 * "cannot make it" would pass on the comment that explains it.
 *
 * `SlotDetail` is the panel under the grid, split out of `AvailabilityGrid`
 * because the hovered state is otherwise unreachable without a DOM, and this
 * suite has no DOM (vitest, node environment, by project rule).
 */

function slot(over: Partial<SlotTally> = {}): SlotTally {
  return {
    // Wednesday 26 August 2026, 19:00–19:30 UTC.
    from: Date.UTC(2026, 7, 26, 19, 0),
    to: Date.UTC(2026, 7, 26, 19, 30),
    yes: [],
    maybe: [],
    notes: [],
    ...over,
  };
}

/** The panel as an admin reads it: no tags, no entities. */
function text(over: Partial<SlotTally> = {}): string {
  return renderToStaticMarkup(
    createElement(SlotDetail, { slot: slot(over), day: "Wed 26", zone: "UTC" })
  )
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

describe("the slot list", () => {
  it("says when the slot is and who is free in it", () => {
    const rendered = text({ yes: ["Ana"], maybe: ["Bo"] });
    expect(rendered).toContain("Wed 26 19:00 – 19:30");
    expect(rendered).toContain("1 free");
    expect(rendered).toContain("Ana");
    expect(rendered).toContain("Bo");
  });

  it("says nobody when nobody is free", () => {
    expect(text()).toContain("Nobody.");
  });
});

describe("UC-06 E1: a date override's note", () => {
  it("shows the member and what they wrote", () => {
    const rendered = text({
      notes: [{ name: "Bea", note: "away at a wedding", state: "no" }],
    });

    expect(rendered).toContain("Bea");
    expect(rendered).toContain("away at a wedding");
  });

  it("shows it even when the member is in neither name list", () => {
    // E1's own example is a refusal, which puts nobody in `yes` or `maybe` —
    // so a panel that only rendered names rendered nothing at all. The slot
    // still has to read "Nobody." *and* the reason.
    const rendered = text({
      notes: [{ name: "Bea", note: "away at a wedding", state: "no" }],
    });

    expect(rendered).toContain("Nobody.");
    expect(rendered).toContain("away at a wedding");
  });

  it("reads a refusal and an offer differently", () => {
    expect(text({ notes: [{ name: "Bea", note: "wedding", state: "no" }] })).toContain(
      "Bea cannot make it: wedding"
    );
    expect(
      text({ yes: ["Dee"], notes: [{ name: "Dee", note: "day off", state: "yes" }] })
    ).toContain("Dee said: day off");
  });

  it("lists everybody who has something to say about the slot", () => {
    const rendered = text({
      notes: [
        { name: "Bea", note: "wedding", state: "no" },
        { name: "Cass", note: "on call", state: "no" },
      ],
    });

    expect(rendered).toContain("Bea cannot make it: wedding");
    expect(rendered).toContain("Cass cannot make it: on call");
  });

  it("adds nothing to a slot nobody wrote a note on", () => {
    // So the four above are not passing on markup that is always rendered.
    const rendered = text({ yes: ["Ana"] });
    expect(rendered).not.toContain("cannot make it");
    expect(rendered).toContain("Ana");
  });
});
