import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENTS,
  type AnnouncementKind,
  eventPublishedMessage,
  eventStartingSoonMessage,
  signupsClosingSoonMessage,
  signupsOpenMessage,
  standingsMessage,
} from "@/lib/announce";
import {
  MANUAL_ANNOUNCEMENT_KINDS,
  MANUAL_ANNOUNCEMENT_NAMES,
  MANUAL_REFUSALS,
  type ManualAnnouncementKind,
  alreadyPostedWarning,
  failedNote,
  isManualAnnouncementKind,
  manualAnnouncementDetail,
  manualPostRefusal,
  manualPostStep,
  manualPostSummary,
  offeredManualKinds,
  postedNote,
  switchedOffNote,
} from "@/lib/announce-manual";

/**
 * Posting one of an event's announcements by hand — the decisions, with no
 * database and no request (R-221 to R-223 / UC-43).
 *
 * ## Why so much of this file is `toBe` on whole sentences
 *
 * Because the thing most likely to be wrong is *which* sentence. Two of the
 * mutations that escaped this plan were of exactly that shape: a `toContain`
 * satisfied by a renamed label, and a refusal assertion satisfied by a
 * **different** refusal that happened to contain the same phrase — on a confirm
 * flow like this one. A substring of a sentence is not the sentence, so every
 * refusal and every notice below is asserted whole and against a literal
 * written out here, not against the constant it came from. Asserting
 * `MANUAL_REFUSALS.noDatedDay` equals `MANUAL_REFUSALS.noDatedDay` would pass
 * whatever either of them says.
 *
 * ## And why the confirm flow is tested here at all
 *
 * The suite runs in vitest's `node` environment: no DOM, no jsdom, no
 * testing-library, nothing to click. The state "already posted, now asking" is
 * reachable on the screen only by pressing a button, so {@link manualPostStep}
 * exists as a pure function and `PublishTab`'s handler does nothing but obey
 * it. The decision is asserted here, directly; what the markup does with each
 * answer is asserted in `publish-tab-announcements.test.ts`. Neither file
 * pretends to click.
 */

/* --------------------------------------------------------------------- */
/* Which five, and which five not                                        */
/* --------------------------------------------------------------------- */

/**
 * The other five, named rather than counted (R-221).
 *
 * Each is about **one application, one draft lot or one match**, and its
 * announcer takes that row's id — so a button on an event screen would have to
 * ask which one, which is a different feature. Written out so that a new kind
 * added to `ANNOUNCEMENTS` has to be put in one list or the other, rather than
 * silently defaulting to "not offered" and quietly never getting a button.
 */
const ABOUT_ONE_THING: readonly AnnouncementKind[] = [
  "application_accepted",
  "application_waitlisted",
  "application_declined",
  "draft_lot_sold",
  "match_result",
];

describe("the five kinds a button can post (R-221)", () => {
  it("is the five whose announcer takes an event, in the order they happen", () => {
    expect(MANUAL_ANNOUNCEMENT_KINDS).toEqual([
      "event_published",
      "signups_open",
      "signups_closing_soon",
      "event_starting_soon",
      "standings_changed",
    ]);
  });

  it("accounts for every kind the site has, so a new one cannot be forgotten", () => {
    // Both directions over one source of truth: every kind is either offered by
    // hand or is one of the five about a single row, and nothing is in both.
    const all = ANNOUNCEMENTS.map((spec) => spec.kind);
    expect([...all].sort()).toEqual([...MANUAL_ANNOUNCEMENT_KINDS, ...ABOUT_ONE_THING].sort());
    expect(ABOUT_ONE_THING.filter((kind) => isManualAnnouncementKind(kind))).toEqual([]);
  });

  it("recognises the five and refuses everything else, because the kind arrives from a browser", () => {
    for (const kind of MANUAL_ANNOUNCEMENT_KINDS) {
      expect(isManualAnnouncementKind(kind), kind).toBe(true);
    }
    for (const kind of ABOUT_ONE_THING) {
      expect(isManualAnnouncementKind(kind), kind).toBe(false);
    }
    expect(isManualAnnouncementKind("")).toBe(false);
    expect(isManualAnnouncementKind("event_published ")).toBe(false);
    expect(isManualAnnouncementKind("standings")).toBe(false);
  });
});

describe("what each button is called", () => {
  /**
   * The name on the button **is** the footer the channel shows.
   *
   * Held against the real builders rather than asserted as a list of strings,
   * because the failure this is written for is drift: a footer reworded in
   * `announce.ts` would leave an admin pressing "Closing soon" and finding a
   * post footed something else, and a test that only compared the map to itself
   * would never know. One of this plan's escaped mutations was a renamed label
   * that a `toContain` still accepted.
   */
  const FOOTER: Record<ManualAnnouncementKind, string | undefined> = {
    event_published: eventPublishedMessage({ title: "t", slug: "s" }).embeds[0].footer?.text,
    signups_open: signupsOpenMessage({ title: "t", slug: "s" }).embeds[0].footer?.text,
    signups_closing_soon: signupsClosingSoonMessage({
      title: "t",
      slug: "s",
      closes: "<t:1:R>",
      full: false,
    }).embeds[0].footer?.text,
    event_starting_soon: eventStartingSoonMessage({ title: "t", slug: "s", starts: "<t:1:F>" })
      .embeds[0].footer?.text,
    standings_changed: standingsMessage({
      seasonName: "s",
      slug: "s",
      eventTitle: "t",
      top: { rows: [], lead: "unknown" },
    }).embeds[0].footer?.text,
  };

  it("matches the footer the post itself carries, for all five", () => {
    for (const kind of MANUAL_ANNOUNCEMENT_KINDS) {
      // The footer is read off a built message, so neither side of this is a
      // constant this file wrote down.
      expect(FOOTER[kind], kind).toBe(MANUAL_ANNOUNCEMENT_NAMES[kind]);
    }
    // And the five names really are five different words, so a map that had
    // collapsed to one value could not satisfy the loop above.
    expect(new Set(Object.values(MANUAL_ANNOUNCEMENT_NAMES)).size).toBe(5);
  });

  it("says what the post would contain, taken from the settings vocabulary", () => {
    for (const kind of MANUAL_ANNOUNCEMENT_KINDS) {
      const spec = ANNOUNCEMENTS.find((one) => one.kind === kind);
      expect(manualAnnouncementDetail(kind), kind).toBe(spec?.detail);
      expect(manualAnnouncementDetail(kind).length, kind).toBeGreaterThan(20);
    }
  });
});

/* --------------------------------------------------------------------- */
/* What is offered (UC-43 2b)                                            */
/* --------------------------------------------------------------------- */

describe("which kinds an event is offered (UC-43 2b)", () => {
  it("offers all five for an event in a championship", () => {
    expect(offeredManualKinds({ inChampionship: true })).toEqual([
      "event_published",
      "signups_open",
      "signups_closing_soon",
      "event_starting_soon",
      "standings_changed",
    ]);
  });

  it("does not offer standings at all for an event in no championship", () => {
    /*
     * The whole list, not `not.toContain`. "Standings is absent" is also true of
     * an empty list and of a list that lost the other four, and either of those
     * is a panel with nothing in it — which is how this criterion passes
     * vacuously.
     */
    expect(offeredManualKinds({ inChampionship: false })).toEqual([
      "event_published",
      "signups_open",
      "signups_closing_soon",
      "event_starting_soon",
    ]);
  });
});

/* --------------------------------------------------------------------- */
/* What is refused (UC-43 3b, 4a)                                        */
/* --------------------------------------------------------------------- */

const DATED = new Date("2026-11-06T20:00:00.000Z");
const CLOSES = new Date("2026-11-05T20:00:00.000Z");

/** An event with everything a message could need. */
const WHOLE = { startsAt: DATED, signupClosesAt: CLOSES, inChampionship: true };

describe("a message that cannot be built honestly is refused by name (UC-43 4a)", () => {
  it("refuses starting-soon for an event with no dated day", () => {
    expect(manualPostRefusal("event_starting_soon", { ...WHOLE, startsAt: null })).toBe(
      "This event has no dated day, so there is no start time to announce. " +
        "Give it a day on the Days tab first."
    );
  });

  it("refuses closing-soon for an event with no closing time", () => {
    expect(manualPostRefusal("signups_closing_soon", { ...WHOLE, signupClosesAt: null })).toBe(
      "This event has no closing time, so there is nothing to count down to. " +
        "Set one on the Setup tab first."
    );
  });

  it("refuses standings for an event in no championship, for the endpoint's sake", () => {
    // Not offered on the screen at all (above). This is the answer to a call
    // that did not come from the screen, and it is a different sentence from
    // either of the two above — the Task 78 failure was a refusal assertion
    // satisfied by a different refusal.
    expect(manualPostRefusal("standings_changed", { ...WHOLE, inChampionship: false })).toBe(
      "This event counts towards no championship, so there is no table to announce."
    );
  });

  it("names the thing to fill in, and each refusal is its own sentence", () => {
    const refusals = Object.values(MANUAL_REFUSALS);
    expect(new Set(refusals).size, "two refusals read the same").toBe(refusals.length);
    for (const refusal of refusals) {
      expect(refusal.endsWith("."), refusal).toBe(true);
    }
  });

  it("refuses nothing for an event that has the facts, over all five kinds", () => {
    /*
     * The other half, and the one that stops the three above from being a
     * function that refuses everything. Asserted per kind rather than as a
     * count, because "nothing is refused" has to be true of each.
     */
    for (const kind of MANUAL_ANNOUNCEMENT_KINDS) {
      expect(manualPostRefusal(kind, WHOLE), kind).toBeNull();
    }
  });

  it("refuses the other three kinds nothing for a missing day or closing time", () => {
    // A published post for an event with no dated day is fine: the compiled copy
    // drops the field, and `{starts}` has declared words for exactly that case.
    // Only the two *about* a time are refused.
    for (const kind of ["event_published", "signups_open", "standings_changed"] as const) {
      expect(manualPostRefusal(kind, { ...WHOLE, startsAt: null }), kind).toBeNull();
      expect(manualPostRefusal(kind, { ...WHOLE, signupClosesAt: null }), kind).toBeNull();
    }
  });

  it("says what is missing when there is nowhere to post (UC-43 3b)", () => {
    expect(MANUAL_REFUSALS.noWebhook).toBe(
      "No Discord webhook is configured, so nothing would be posted. " +
        "Set one on the Settings screen first."
    );
  });
});

/* --------------------------------------------------------------------- */
/* What the screen says (R-222, R-223)                                   */
/* --------------------------------------------------------------------- */

describe("a switched-off kind is said, not refused (R-223 / UC-43 2a)", () => {
  it("says the switch is off and that this button posts anyway", () => {
    expect(switchedOffNote("signups_closing_soon")).toBe(
      "“Closing soon” is switched off, so nothing posts it on its own. " +
        "This button posts it anyway."
    );
  });

  it("names the kind it is about, for every one of the five", () => {
    for (const kind of MANUAL_ANNOUNCEMENT_KINDS) {
      expect(switchedOffNote(kind), kind).toContain(`“${MANUAL_ANNOUNCEMENT_NAMES[kind]}”`);
    }
    // Five different sentences, so the loop above is not passing over one.
    expect(new Set(MANUAL_ANNOUNCEMENT_KINDS.map(switchedOffNote)).size).toBe(5);
  });
});

describe("an already-posted kind warns with when, and asks (R-222 / UC-43 3a)", () => {
  it("says when it went and asks rather than refusing", () => {
    expect(alreadyPostedWarning("event_starting_soon", "Fri 6 Nov · 18:00")).toBe(
      "The “Starting soon” announcement for this event already went out: " +
        "Fri 6 Nov · 18:00. Post it again?"
    );
  });

  it("is a question, and is in none of the refusals", () => {
    /*
     * The distinction R-222 turns on. A warning that read like a refusal would
     * satisfy a looser test either way round, so: this sentence asks, and it is
     * not one of the sentences that mean "no".
     */
    const warning = alreadyPostedWarning("event_published", "Sat 7 Nov · 09:00");
    expect(warning.endsWith("Post it again?")).toBe(true);
    expect(Object.values(MANUAL_REFUSALS)).not.toContain(warning);
  });

  it("carries the instant it was handed, rather than one of its own", () => {
    // The reader's zone is the browser's to decide, so this takes rendered text
    // and puts it in a sentence. A function that formatted a date itself would
    // be choosing somebody else's clock.
    expect(alreadyPostedWarning("signups_open", "whenever")).toContain(": whenever. ");
  });
});

describe("what the screen says afterwards", () => {
  it("says it is in the channel, and that the scheduler will not repeat it", () => {
    expect(postedNote("signups_closing_soon", true)).toBe(
      "Posted. “Closing soon” is in the channel, and the scheduler will not post it again."
    );
  });

  it("claims nothing about the scheduler when the claim was already somebody else's", () => {
    expect(postedNote("signups_closing_soon", false)).toBe(
      "Posted. “Closing soon” is in the channel."
    );
  });

  it("does not say posted when Discord refused it (UC-43 5a)", () => {
    const note = failedNote("Discord answered 500.");
    expect(note).toBe(
      "Discord refused the post: Discord answered 500. " +
        "Nothing reached the channel, and the failure is in the audit log."
    );
    // The assertion that matters: the screen must not report success. Checked
    // on the word rather than on the sentence, because any rewording that
    // reintroduced it would be the defect.
    expect(note.toLowerCase()).not.toContain("posted");
  });

  it("names who posted it in the audit sentence (UC-43 5)", () => {
    expect(manualPostSummary("event_published", "Rivals Winter Cup", "Marta")).toBe(
      "Marta posted the “New event” announcement for “Rivals Winter Cup” by hand."
    );
  });
});

/* --------------------------------------------------------------------- */
/* The one decision a press makes                                        */
/* --------------------------------------------------------------------- */

describe("what pressing a button does (UC-43 3, 3a, 3b, 4a)", () => {
  const POSTED = new Date("2026-11-01T19:00:00.000Z");

  /**
   * Every combination, with its answer written out.
   *
   * Sixteen rows rather than four tests, because what this function gets wrong
   * is a *precedence*: an install with no webhook being asked to confirm a
   * repost that could not happen, or a refused kind posting because it had
   * already been posted once. Those only show up where two conditions are true
   * at the same time.
   */
  it.each([
    [{ webhook: true, refusal: null, postedAt: null, confirmed: false }, "post"],
    [{ webhook: true, refusal: null, postedAt: null, confirmed: true }, "post"],
    [{ webhook: true, refusal: null, postedAt: POSTED, confirmed: false }, "confirm"],
    [{ webhook: true, refusal: null, postedAt: POSTED, confirmed: true }, "post"],
    [{ webhook: true, refusal: "no day", postedAt: null, confirmed: false }, "refused"],
    [{ webhook: true, refusal: "no day", postedAt: null, confirmed: true }, "refused"],
    [{ webhook: true, refusal: "no day", postedAt: POSTED, confirmed: false }, "refused"],
    [{ webhook: true, refusal: "no day", postedAt: POSTED, confirmed: true }, "refused"],
    [{ webhook: false, refusal: null, postedAt: null, confirmed: false }, "refused"],
    [{ webhook: false, refusal: null, postedAt: null, confirmed: true }, "refused"],
    [{ webhook: false, refusal: null, postedAt: POSTED, confirmed: false }, "refused"],
    [{ webhook: false, refusal: null, postedAt: POSTED, confirmed: true }, "refused"],
    [{ webhook: false, refusal: "no day", postedAt: null, confirmed: false }, "refused"],
    [{ webhook: false, refusal: "no day", postedAt: null, confirmed: true }, "refused"],
    [{ webhook: false, refusal: "no day", postedAt: POSTED, confirmed: false }, "refused"],
    [{ webhook: false, refusal: "no day", postedAt: POSTED, confirmed: true }, "refused"],
  ] as const)("%o is %s", (input, want) => {
    expect(
      manualPostStep(
        { refusal: input.refusal, postedAt: input.postedAt },
        { webhook: input.webhook, confirmed: input.confirmed }
      )
    ).toBe(want);
  });

  it("reaches all three answers, so none of the rows above is unreachable", () => {
    // A function that answered "refused" to everything would satisfy twelve of
    // the sixteen rows, which is most of them.
    const answers = new Set([
      manualPostStep({ refusal: null, postedAt: null }, { webhook: true, confirmed: false }),
      manualPostStep({ refusal: null, postedAt: POSTED }, { webhook: true, confirmed: false }),
      manualPostStep({ refusal: "x", postedAt: null }, { webhook: true, confirmed: false }),
    ]);
    expect([...answers].sort()).toEqual(["confirm", "post", "refused"]);
  });
});
