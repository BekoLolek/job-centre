import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HeroRole } from "@/db";
import type { TeamFormat } from "@/lib/events-policy";
import HandReveal, { RoleColumn } from "../HandReveal";
import {
  REDUCED_MOTION_QUERY,
  REVEAL_INTERVAL_MS,
  type RevealCard,
  groupsOf,
  revealProgress,
  revealView,
} from "../reveal";

/**
 * The reveal: nine cards turning about a second apart, and nothing else
 * (R-211, R-212, R-213 / UC-39 2, 4, 6, 6a, 7a).
 *
 * ## What this file cannot do, said before anything it can
 *
 * The suite runs in vitest's `node` environment — **no jsdom, no
 * testing-library** — so there is no DOM here, no `window.matchMedia`, no
 * layout and no way to click a button. Every state after the first click is
 * therefore unreachable by rendering, and so is every state that depends on a
 * media query.
 *
 * What is done about that is the thing Task 64 did with `draftBody`,
 * `editorStatus` and `withRole`, and it is said out loud rather than hidden
 * behind a test that *looks* like it clicks: the decision is an exported pure
 * function and the test calls it directly. `revealView` is handed the state a
 * click would have produced — a hand, a tick count, a media query answer — and
 * asked what the screen is. Nothing below claims to have pressed anything, and
 * nothing below measures a pixel, because neither is measurable from here.
 *
 * The two things that are genuinely rendered are the two states reachable from
 * props alone: a player who has not drawn, and a player who already holds a
 * hand (UC-39 6a). Those are real renders of the real component.
 *
 * ## The claim that matters most here
 *
 * **The reveal cannot decide anything.** `revealView` is given a list and an
 * integer and the only thing it can return is how much of that list is
 * visible — so the set of nine is asserted to be *identical* at every count
 * from none turned to all turned, which is what "the animation only uncovers"
 * means in a form that can fail. And the pre-draw render is asserted to carry
 * **no hero name at all**, because a pool in the browser is a reroll one
 * refresh away.
 */

/* ------------------------------------------------------------------ */
/* Fixtures                                                           */
/* ------------------------------------------------------------------ */

const ROLES: readonly HeroRole[] = ["Vanguard", "Duelist", "Strategist"];

/**
 * A hand in deal order: three Vanguards, three Duelists, three Strategists.
 *
 * `Deadpool` sits in two role-sets on purpose, with **one id**. That is legal
 * and correct — the three draws are three draws from three pools, and a hero
 * holding several roles can come out of two of them — and it is the case a key
 * built from `id` alone collides on.
 */
const HAND: RevealCard[] = [
  { id: "v1", name: "Doctor Strange", role: "Vanguard" },
  { id: "dp", name: "Deadpool", role: "Vanguard" },
  { id: "v3", name: "Groot", role: "Vanguard" },
  { id: "d1", name: "Iron Fist", role: "Duelist" },
  { id: "dp", name: "Deadpool", role: "Duelist" },
  { id: "d3", name: "Psylocke", role: "Duelist" },
  { id: "s1", name: "Loki", role: "Strategist" },
  { id: "s2", name: "Mantis", role: "Strategist" },
  { id: "s3", name: "Jeff the Land Shark", role: "Strategist" },
];

const FORMAT: TeamFormat = { format: "6v6", teamSize: 6, comp: "2-2-2" };

function state(over: {
  cards?: RevealCard[] | null;
  ticks?: number;
  reducedMotion?: boolean;
  alreadyHeld?: boolean;
}) {
  return {
    cards: over.cards === undefined ? HAND : over.cards,
    ticks: over.ticks ?? 0,
    reducedMotion: over.reducedMotion ?? false,
    alreadyHeld: over.alreadyHeld ?? false,
  };
}

/** Every name on the screen, in the order the markup puts them. */
function namesOf(view: ReturnType<typeof revealView>): string[] {
  return view.groups.flatMap((group) => group.slots.map((slot) => slot.name));
}

/* ------------------------------------------------------------------ */
/* groupsOf — the hand as three roles                                 */
/* ------------------------------------------------------------------ */

describe("grouping the hand by role (UC-39 6)", () => {
  it("makes one group per role, in the order the server dealt them", () => {
    const groups = groupsOf(HAND, 9);
    expect(groups.map((group) => group.role)).toEqual(["Vanguard", "Duelist", "Strategist"]);
  });

  it("keeps every card, in deal order, inside its role", () => {
    const groups = groupsOf(HAND, 9);
    expect(groups.map((group) => group.slots.map((slot) => slot.name))).toEqual([
      ["Doctor Strange", "Deadpool", "Groot"],
      ["Iron Fist", "Deadpool", "Psylocke"],
      ["Loki", "Mantis", "Jeff the Land Shark"],
    ]);
    // And the deal index is the position in the whole hand, not in the role —
    // which is what makes "the first four turned" mean the first four dealt.
    expect(groups.flatMap((group) => group.slots.map((slot) => slot.index))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it("gives a multi-role hero two slots that a key can tell apart", () => {
    const slots = groupsOf(HAND, 9).flatMap((group) => group.slots);
    const deadpool = slots.filter((slot) => slot.name === "Deadpool");
    expect(deadpool).toHaveLength(2);
    // The same hero, so the same id — and two distinct keys all the same.
    expect(new Set(deadpool.map((slot) => slot.id)).size).toBe(1);
    expect(new Set(slots.map((slot) => `${slot.role}-${slot.id}`)).size).toBe(9);
  });

  it("turns exactly the first n, at every n", () => {
    for (let faceUp = 0; faceUp <= 9; faceUp++) {
      const slots = groupsOf(HAND, faceUp).flatMap((group) => group.slots);
      expect(
        slots.filter((slot) => slot.faceUp).map((slot) => slot.index),
        `faceUp ${faceUp}`
      ).toEqual([...Array(faceUp).keys()]);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The reveal decides nothing (R-212)                                 */
/* ------------------------------------------------------------------ */

describe("the reveal is presentation only (R-212)", () => {
  /**
   * The claim, in the only form that can fail: the nine on the screen are the
   * same nine, in the same order, whether none of them have turned or all of
   * them have. A reveal that *chose* anything — a hero, an order, whether a
   * card is dealt at all — would differ somewhere across these ten counts.
   */
  it("shows the same nine, in the same order, at every count", () => {
    const whole = namesOf(revealView(state({ ticks: 9 })));
    expect(whole).toHaveLength(9);
    for (let ticks = 0; ticks <= 12; ticks++) {
      expect(namesOf(revealView(state({ ticks }))), `ticks ${ticks}`).toEqual(whole);
    }
  });

  it("uncovers one more per tick, and never more than there are", () => {
    expect(revealView(state({ ticks: 0 })).faceUp).toBe(0);
    expect(revealView(state({ ticks: 1 })).faceUp).toBe(1);
    expect(revealView(state({ ticks: 4 })).faceUp).toBe(4);
    expect(revealView(state({ ticks: 9 })).faceUp).toBe(9);
    // A timer that outran the hand must not report ten of nine.
    expect(revealView(state({ ticks: 50 })).faceUp).toBe(9);
  });

  it("never turns a card back over", () => {
    // Not reachable through the component, which only ever increments — but a
    // clamp that only guarded one end is the classic half-fix.
    expect(revealView(state({ ticks: -3 })).faceUp).toBe(0);
  });

  it("takes the total off the hand rather than from a nine written down", () => {
    const five = HAND.slice(0, 5);
    expect(revealView(state({ cards: five, ticks: 99 })).total).toBe(5);
    expect(revealView(state({ cards: five, ticks: 99 })).faceUp).toBe(5);
  });

  it("shows nothing at all before anything is dealt", () => {
    const view = revealView(state({ cards: null, ticks: 7 }));
    expect(view).toEqual({
      faceUp: 0,
      total: 0,
      revealing: false,
      complete: false,
      narrate: false,
      groups: [],
    });
  });

  it("stops the timer once the last card has turned", () => {
    expect(revealView(state({ ticks: 8 })).revealing).toBe(true);
    expect(revealView(state({ ticks: 9 })).revealing).toBe(false);
    expect(revealView(state({ ticks: 9 })).complete).toBe(true);
  });

  it("deals about a second apart, which is what R-213 asks for", () => {
    expect(REVEAL_INTERVAL_MS).toBe(1000);
  });
});

/* ------------------------------------------------------------------ */
/* Reduced motion (the Constraints)                                   */
/* ------------------------------------------------------------------ */

describe("reduced motion shows the hand", () => {
  /**
   * The Constraints require `prefers-reduced-motion` to be respected, and a
   * nine-step reveal on a timer is exactly what it exists for. CSS cannot
   * answer this one: `globals.css` already stops `.stamp` easing, but the
   * stepping is a `setInterval`, so without this the hand would still take nine
   * seconds to arrive with the easing removed.
   */
  it("shows every card at once, with no ticks at all", () => {
    const view = revealView(state({ ticks: 0, reducedMotion: true }));
    expect(view.faceUp).toBe(9);
    expect(view.complete).toBe(true);
    expect(namesOf(view)).toHaveLength(9);
    expect(view.groups.every((group) => group.slots.every((slot) => slot.faceUp))).toBe(true);
  });

  it("never starts the timer, rather than starting one and hiding it", () => {
    // `revealing` is what the component's effect returns early on, so false
    // here is the interval never being created. A reveal that ran invisibly
    // would still be a reveal, and would still take nine seconds to finish.
    expect(revealView(state({ ticks: 0, reducedMotion: true })).revealing).toBe(false);
  });

  it("reads no commentary to somebody who asked for less movement", () => {
    expect(revealView(state({ reducedMotion: true })).narrate).toBe(false);
    expect(revealProgress(revealView(state({ reducedMotion: true })))).toBeNull();
  });

  it("names the query the browser is actually asked", () => {
    expect(REDUCED_MOTION_QUERY).toBe("(prefers-reduced-motion: reduce)");
  });
});

/* ------------------------------------------------------------------ */
/* A hand already held (UC-39 3a, 6a)                                 */
/* ------------------------------------------------------------------ */

describe("a hand already held does not play out again (UC-39 3a, 6a)", () => {
  it("is shown whole, with no reveal and no timer", () => {
    const view = revealView(state({ ticks: 0, alreadyHeld: true }));
    expect(view.faceUp).toBe(9);
    expect(view.complete).toBe(true);
    expect(view.revealing).toBe(false);
    expect(view.narrate).toBe(false);
  });

  it("is the difference between a fresh deal and a second click", () => {
    // Same state in every other respect. `alreadyHeld` is `dealFor`'s answer
    // and the only thing separating "here are your nine" from "you already had
    // these" — which is why it is passed through rather than re-derived.
    expect(revealView(state({ ticks: 0, alreadyHeld: false })).faceUp).toBe(0);
    expect(revealView(state({ ticks: 0, alreadyHeld: true })).faceUp).toBe(9);
  });
});

/* ------------------------------------------------------------------ */
/* The narrated count                                                 */
/* ------------------------------------------------------------------ */

describe("the line a live region reads", () => {
  it("counts up while the cards turn", () => {
    expect(revealProgress(revealView(state({ ticks: 4 })))).toBe("4 of 9 turned.");
  });

  it("says so once they have all turned", () => {
    expect(revealProgress(revealView(state({ ticks: 9 })))).toBe("That is your hand.");
  });

  it("says nothing when there was no reveal to narrate", () => {
    expect(revealProgress(revealView(state({ cards: null })))).toBeNull();
    expect(revealProgress(revealView(state({ alreadyHeld: true })))).toBeNull();
  });

  it("counts the hand it was given rather than saying nine", () => {
    const five = HAND.slice(0, 5);
    expect(revealProgress(revealView(state({ cards: five, ticks: 2 })))).toBe("2 of 5 turned.");
  });
});

/* ------------------------------------------------------------------ */
/* The component, in the two states props can reach                   */
/* ------------------------------------------------------------------ */

function reveal(initialHand: RevealCard[] | null): string {
  return renderToStaticMarkup(
    createElement(HandReveal, {
      initialHand,
      format: FORMAT,
      roles: ROLES,
      perRole: 3,
      draw: async () => {
        throw new Error("the render must not deal");
      },
    })
  );
}

/**
 * The role headings, in the order the markup puts them.
 *
 * Read off the `<h3>`s rather than by looking for the words in the text, which
 * was the first version of this and was wrong: the comp sentence above the hand
 * says "a team that fields three Duelists is not refused", so `indexOf`
 * found "Duelist" in the prose and reported the columns out of order. A test
 * satisfied — or broken — by neighbouring copy is the `toContain("Withdraw")`
 * shape this project keeps catching, and it fails in both directions.
 */
function roleHeadings(markup: string): string[] {
  return [...markup.matchAll(/<h3[^>]*>([^<]*)<\/h3>/g)].map((match) => match[1]);
}

/** The cards that have not turned: an `<li>` hidden from assistive technology. */
function faceDownCards(markup: string): number {
  return [...markup.matchAll(/<li[^>]*aria-hidden="true"/g)].length;
}

/** The markup as words: no tags, no entities. */
function words(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|\s+/g, " ")
    .trim();
}

describe("before the click (UC-39 2)", () => {
  const markup = reveal(null);
  const text = words(markup);

  /**
   * The sharpest assertion in this file. A pre-draw screen carrying a pool
   * would be a reveal that could deal, and the pool is what a reroll is made
   * of — so **no hero name reaches the browser** before a hand is stored.
   *
   * Asserted against the hand's own names rather than against a regex for
   * "looks like a hero", because those nine are precisely the strings that
   * would be there if the payload carried them.
   */
  it("carries no hero at all, because nothing has been dealt", () => {
    for (const card of HAND) expect(text, card.name).not.toContain(card.name);
  });

  it("offers one click for all nine", () => {
    expect(text).toContain("Draw my 9");
    expect(markup).toContain("<button");
  });

  it("states the comp the admin chose, and that it is not enforced (UC-39 7a)", () => {
    expect(text).toContain("6v6 states a 2-2-2 comp");
    expect(text).toContain("The comp is stated, never enforced");
    expect(text).toContain("a team that fields three Duelists is not refused");
  });

  it("says the draw happens once before the button rather than after it", () => {
    /*
     * The ordering, not just the presence. UC-39 2 puts the warning at step 2
     * and the click at step 3, and "there is no reroll" learned after you have
     * clicked is not a warning, it is a receipt. Compared as positions in the
     * markup, which is the reading order.
     */
    const warning = markup.indexOf("The draw happens once");
    const button = markup.indexOf("<button");
    expect(warning).toBeGreaterThanOrEqual(0);
    expect(button).toBeGreaterThanOrEqual(0);
    expect(warning).toBeLessThan(button);
  });

  it("says what a hand is, from the roles and the count it was given", () => {
    expect(text).toContain("3 in each of 3 roles, so 9 in a hand");
  });

  it("narrates nothing, because nothing is turning", () => {
    expect(text).not.toContain("turned");
  });
});

describe("a hand the player already holds (UC-39 6a)", () => {
  const markup = reveal(HAND);
  const text = words(markup);

  it("shows all nine", () => {
    for (const card of HAND) expect(text, card.name).toContain(card.name);
  });

  it("groups them by role, each role named, in deal order", () => {
    expect(roleHeadings(markup)).toEqual(["Vanguard", "Duelist", "Strategist"]);
  });

  it("offers no button to draw again", () => {
    expect(markup).not.toContain("<button");
    expect(text).not.toContain("Draw my");
  });

  it("says the draw already happened rather than warning about a click", () => {
    expect(text).toContain("The draw happened once");
    expect(text).not.toContain("The draw happens once");
  });

  it("leaves no card face-down, so nothing is hidden behind an animation", () => {
    expect(faceDownCards(markup)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Mid-reveal, rendered rather than claimed                           */
/* ------------------------------------------------------------------ */

/**
 * The card markup at a step of the reveal nothing here can click to.
 *
 * `RoleColumn` is exported for this, and the group it is handed comes from the
 * real `groupsOf` — so what is rendered below is a real role column at a real
 * count, not a fixture shaped like one.
 */
describe("a column part-way through the reveal", () => {
  function column(faceUp: number): string {
    const group = groupsOf(HAND, faceUp).find((candidate) => candidate.role === "Vanguard");
    if (!group) throw new Error("no Vanguard group");
    return renderToStaticMarkup(createElement(RoleColumn, { group }));
  }

  it("holds its full height from the first card, so the layout does not jump", () => {
    // Three slots at every count, turned or not. A column that rendered only
    // the turned ones would grow under the player as the hand filled in.
    for (let faceUp = 0; faceUp <= 3; faceUp++) {
      expect([...column(faceUp).matchAll(/<li/g)], `faceUp ${faceUp}`).toHaveLength(3);
    }
  });

  it("names only the cards that have turned", () => {
    expect(words(column(0))).not.toContain("Doctor Strange");
    expect(words(column(1))).toContain("Doctor Strange");
    expect(words(column(1))).not.toContain("Deadpool");
    expect(words(column(2))).toContain("Deadpool");
  });

  it("hides an unturned card from assistive technology rather than reading a dash", () => {
    // And this is the positive case for `faceDownCards`: a helper that found
    // nothing everywhere would have reported the finished hand clean for ever.
    expect(faceDownCards(column(0))).toBe(3);
    expect(faceDownCards(column(1))).toBe(2);
    expect(faceDownCards(column(3))).toBe(0);
  });

  it("animates only the card that has just landed, with the shared class", () => {
    // `.stamp` is `globals.css`'s own, and its `prefers-reduced-motion` block
    // already switches it off — so the easing is handled where every other
    // animation on the site is handled, and only the stepping needed deciding
    // here.
    expect([...column(2).matchAll(/stamp/g)]).toHaveLength(2);
    expect(column(0)).not.toContain("stamp");
  });
});
