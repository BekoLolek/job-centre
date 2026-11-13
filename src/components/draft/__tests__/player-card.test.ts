import fs from "node:fs";
import path from "node:path";
import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, expectTypeOf, it } from "vitest";
import PlayerCard, { NO_RANK } from "../PlayerCard";
import type { PlayerCardProps } from "../PlayerCard";

/*
 * R-258: a player, on a card — name, picture, current rank, preferred roles —
 * so an admin sorting people can balance the sides without opening a profile.
 *
 * The card renders and does nothing else. What moves it around is another
 * component's business, and the last block here is what holds that line: one
 * test over the prop type (which `npm run typecheck` reads, not vitest) and
 * two over the markup (which vitest reads).
 *
 * The name's initials ("FD") appear nowhere in the name, the rank or the roles
 * below, so finding them means the fallback drew them and nothing else did.
 */

const PICTURE = "https://cdn.discordapp.com/avatars/114960173/a1b2c3.png";

/** One player, fully answered. Every test states only what it changes. */
function card(over: Partial<PlayerCardProps> = {}): string {
  return renderToStaticMarkup(
    createElement(PlayerCard, {
      name: "Faro Delgado",
      avatarUrl: PICTURE,
      rank: "Diamond 2",
      roles: ["Vanguard", "Strategist"],
      ...over,
    })
  );
}

describe("PlayerCard", () => {
  it("prints the name", () => {
    expect(card()).toContain(">Faro Delgado<");
  });

  it("draws the picture it is handed, and no initials", () => {
    const html = card();
    expect(html).toContain(`<img src="${PICTURE}"`);
    expect(html).not.toContain(">FD<");
  });

  it("draws initials for a member with no picture", () => {
    const html = card({ avatarUrl: null });
    expect(html).not.toContain("<img");
    expect(html).toContain(">FD<");
  });

  it("prints the rank, and does not say there is none", () => {
    const html = card();
    expect(html).toContain(">Diamond 2<");
    expect(html).not.toContain(NO_RANK);
  });

  it("prints every role, in the order it was handed them", () => {
    const html = card({ roles: ["Vanguard", "Strategist", "Duelist"] });
    const at = ["Vanguard", "Strategist", "Duelist"].map((role) => html.indexOf(`>${role}<`));
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(Math.min(...at)).toBeGreaterThan(-1);
  });
});

/*
 * `NO_RANK` is the one string the card and the Captains tab both print, so
 * there is no second spelling here to compare it with: the tab imports it.
 */
describe("a player with no rank", () => {
  it("says so in the words the Captains tab uses", () => {
    expect(card({ rank: null })).toContain(`>${NO_RANK}<`);
  });

  /*
   * The tab has no render assertion of its own, and cannot have one here: its
   * no-rank badge is inside the override `Modal`, which is closed on first
   * render and opens only from a click handler, so `renderToStaticMarkup`
   * never reaches it. What can be held without a browser is that the words
   * are written once — a screen that typed them again instead of importing
   * `NO_RANK` makes this two. It counts a phrase and knows nothing about the
   * markup around it. Case-sensitive: the captain picker's " · no rank
   * recorded", mid-sentence in an `<option>`, is a different string.
   */
  it("is said in words that are written once in the source, so no screen has its own copy", () => {
    const src = path.resolve(__dirname, "../../..");
    const written: string[] = [];
    (function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(full);
        } else if (/.tsx?$/.test(entry.name)) {
          const count = fs.readFileSync(full, "utf8").split(NO_RANK).length - 1;
          for (let n = 0; n < count; n += 1) written.push(path.relative(src, full).split(path.sep).join("/"));
        }
      }
    })(src);

    expect(written).toEqual(["components/draft/PlayerCard.tsx"]);
  });
});

/*
 * `roles` has two empties and they are different facts (`ApplicantView.roles`):
 * `null` is a game with no roles question, `[]` is a player who answered
 * nothing. Every card below comes from the one fixture and differs in `roles`
 * alone, so any difference in the markup is that difference. The first two
 * tests are the pair: the line is absent from one and present in the other.
 */
describe("the two ways of having no roles", () => {
  it("draws no roles line for a game with no roles question, where a player who answered nothing gets one", () => {
    const noQuestion = card({ roles: null });
    expect(noQuestion).not.toContain(">Roles<");
    expect(noQuestion).not.toContain("No roles chosen");
  });

  it("says a player who answered nothing chose no roles", () => {
    const noAnswer = card({ roles: [] });
    expect(noAnswer).toContain(">Roles<");
    expect(noAnswer).toContain(">No roles chosen<");
  });

  it("does not say it about a player who answered", () => {
    const answered = card({ roles: ["Vanguard"] });
    expect(answered).toContain(">Roles<");
    expect(answered).not.toContain("No roles chosen");
  });

  it("still prints the rank when there is no roles line", () => {
    expect(card({ roles: null })).toContain(">Diamond 2<");
  });
});

describe("what the card is not", () => {
  /*
   * Read by `tsc`, not by vitest: at runtime this line cannot fail. A prop
   * added to the card — `actions`, `onClick`, `draggable`, `className` — fails
   * `npm run typecheck` here, which is the point at which somebody has to
   * decide the card and whatever moves it are still two things.
   */
  it("takes a name, a picture, a rank and roles, and no other prop", () => {
    expectTypeOf<keyof PlayerCardProps>().toEqualTypeOf<"name" | "avatarUrl" | "rank" | "roles">();
  });

  /* The same line held at runtime: handed a handler anyway, it drops it. */
  it("ignores an action, a drag handle or a slot it is handed anyway", () => {
    const Loose = PlayerCard as ComponentType<Record<string, unknown>>;
    const base = { name: "Faro Delgado", avatarUrl: PICTURE, rank: "Diamond 2", roles: ["Vanguard"] };
    const hostile = renderToStaticMarkup(
      createElement(Loose, {
        ...base,
        draggable: true,
        tabIndex: 0,
        role: "button",
        href: "/players/faro",
        className: "cursor-grab",
        actions: createElement("button", null, "Move"),
        children: createElement("button", null, "Remove"),
      })
    );
    expect(hostile).toBe(renderToStaticMarkup(createElement(Loose, base)));
  });

  /*
   * The 44px floor applies to controls. The card has none, in any branch of
   * its own, so there is nothing on it to measure — and this is what fails
   * when that stops being true.
   */
  it.each([
    ["answered in full", {}],
    ["no rank", { rank: null }],
    ["no roles answered", { roles: [] }],
  ] satisfies [string, Partial<PlayerCardProps>][])("contains no control: %s", (_state, over) => {
    expect(card(over)).not.toMatch(
      /<(?:button|a|input|select|textarea|summary|label)\b|tabindex|draggable|role="(?:button|link)"/i
    );
  });
});
