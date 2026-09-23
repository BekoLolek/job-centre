import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Avatar from "../Avatar";
import NavMenu from "@/components/NavMenu";

/*
 * The avatar is decoration (plan Task 46).
 *
 * The defect these tests pin was found by walking the accessibility tree of the
 * championship standings: every row came out as "FDFaro Delgado", because the
 * fallback initials are real text and nothing hid them. The same doubling ran
 * through the draft room, the rosters, the applicant lists and the profiles.
 *
 * So what is asserted here is the *accessible text* — what assistive tech is
 * left with — not the markup that produces it. `accessibleText` below is the
 * smallest reader that can tell the two apart; `renderToStaticMarkup` is how
 * the rest of the suite renders a component in the node environment (see
 * `championship/__tests__/past-seasons.test.ts`), the suite has no DOM.
 */

/** Elements that never have a closing tag, so they never open a subtree. */
const VOID = new Set(["img", "br", "hr", "input", "source", "meta", "link", "area"]);

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;

/**
 * What an `<img>` that is still in the tree announces (HTML-AAM).
 *
 * A non-empty `alt` is the name. An empty `alt` makes the image presentational
 * and silent — *but only when nothing else labels it*, and a `title` does: it
 * becomes the accessible name instead. That last clause is the whole reason
 * `alt=""` was not on its own a fix for the picture branch, so the reader has
 * to know it or the test for that branch proves nothing.
 */
function imageName(attrs: string): string {
  const alt = /\salt="([^"]*)"/.exec(attrs)?.[1];
  if (alt) return alt;
  if (alt === undefined) return ""; // No alt at all: not this component's shape.
  return /\stitle="([^"]*)"/.exec(attrs)?.[1] ?? "";
}

/**
 * Elements an `aria-label` actually sticks to.
 *
 * ARIA 1.2 prohibits naming `role=generic` — what a bare `<span>` or `<div>`
 * is — and browsers differ on whether they drop such a label or keep it, so a
 * label there is not a name anyone can count on. Modelled rather than ignored,
 * because the account menu's unread dot is exactly that shape: an empty span
 * whose count reaches a reader only if it is given a role that can carry one.
 */
const NAMEABLE = new Set(["img", "a", "button", "input", "select", "textarea"]);

function labelOf(name: string, attrs: string): string {
  if (!NAMEABLE.has(name) && !/\srole="[^"]+"/.test(attrs)) return "";
  return /\saria-label="([^"]+)"/.exec(attrs)?.[1] ?? "";
}

/**
 * Everything a screen reader would be left to announce from a fragment.
 *
 * Two things take an element and its subtree out: `aria-hidden`, and the bare
 * Tailwind `hidden` class. `hidden` is `display:none`, which is the one piece
 * of CSS that changes what is announced rather than how it looks, and it is
 * modelled here because a responsive `hidden sm:block` name is *not* a name on
 * a phone — the distinction the account menu turns on. A prefixed `sm:hidden`
 * is left alone: this reads the page at its narrowest, before any breakpoint
 * has taken effect.
 *
 * **Which is why the class is matched whole**, at both ends, rather than as a
 * word. `\bhidden\b` treats `-` and `:` as boundaries, so it swallowed
 * `overflow-hidden` — which sits on half the scrolling wrappers on the site —
 * along with `sm:hidden` and `md:hidden`. That error runs in the dangerous
 * direction: a reader that hides too much announces less than the browser
 * does, so a future wrapper with `overflow-hidden` around an avatar would
 * blank the subtree under it and let a genuine doubled name pass as a green
 * test. `the reader these tests are written with` pins all three.
 *
 * Surviving text is concatenated with no separator, so the defect reads here
 * exactly as it read in the browser: `FDFaro Delgado`. A name taken from an
 * attribute is spaced instead — it is announced as its own thing rather than
 * run together with the text beside it, and it is not the sort of doubling
 * this file exists to catch.
 */
function accessibleText(markup: string): string {
  const out: string[] = [];
  let cursor = 0;
  let depth = 0;
  let hiddenFrom: number | null = null;
  let match: RegExpExecArray | null;

  TAG.lastIndex = 0;
  while ((match = TAG.exec(markup)) !== null) {
    const [full, slash, rawName, attrs, selfSlash] = match;
    if (hiddenFrom === null) out.push(markup.slice(cursor, match.index));
    cursor = match.index + full.length;

    const name = rawName.toLowerCase();
    const empty = selfSlash === "/" || VOID.has(name);
    const hides =
      /\saria-hidden="true"/.test(attrs) ||
      /\sclass="(?:[^"]*\s)?hidden(?:\s[^"]*)?"/.test(attrs);
    const label = hides ? "" : labelOf(name, attrs);

    if (slash === "/") {
      depth -= 1;
      if (hiddenFrom === depth) hiddenFrom = null;
      continue;
    }
    if (empty) {
      if (hiddenFrom === null && !hides) {
        if (label) out.push(` ${label} `);
        else if (name === "img") out.push(imageName(attrs));
      }
      continue;
    }
    if (hiddenFrom === null && label) out.push(` ${label} `);
    // A label replaces whatever the element contains, so from here down the
    // subtree is as silent as a hidden one.
    if (hiddenFrom === null && (hides || label)) hiddenFrom = depth;
    depth += 1;
  }
  if (hiddenFrom === null) out.push(markup.slice(cursor));

  return out.join("").replace(/\s+/g, " ").trim();
}

const NAME = "Faro Delgado";
const PICTURE = "https://cdn.example.test/faro.png";

/** A standings row in miniature: the avatar, then the name printed beside it. */
function row(src?: string): string {
  return renderToStaticMarkup(
    createElement(
      "li",
      null,
      createElement(Avatar, { name: NAME, src, size: "sm" }),
      createElement("span", null, NAME)
    )
  );
}

describe("the reader these tests are written with", () => {
  it("would have reported the defect as the browser did", () => {
    // Without this the rest of the file could pass on a reader that sees
    // nothing at all. An unhidden pair of initials must still come out wrong.
    expect(accessibleText(`<li><span>FD</span><span>${NAME}</span></li>`)).toBe(
      `FD${NAME}`
    );
  });

  it("takes out a bare `hidden`, and nothing that merely contains the word", () => {
    // `\bhidden\b` matched all three of these, because `-` and `:` are word
    // boundaries. `overflow-hidden` is the one that would have done damage:
    // it is on scrolling wrappers all over the site, and a reader that read it
    // as `display:none` would blank the subtree under it — so a row that did
    // announce "FDFaro Delgado" would come back empty and pass.
    expect(accessibleText(`<span class="hidden">${NAME}</span>`)).toBe("");
    expect(accessibleText(`<div class="flex hidden sm:block">${NAME}</div>`)).toBe("");
    expect(accessibleText(`<span class="overflow-hidden">${NAME}</span>`)).toBe(NAME);
    expect(accessibleText(`<span class="sm:hidden">${NAME}</span>`)).toBe(NAME);
    expect(accessibleText(`<span class="md:hidden">${NAME}</span>`)).toBe(NAME);
  });

  it("reads a label only off something a label can name", () => {
    // ARIA 1.2 forbids naming `role=generic`, so a labelled bare span is a
    // count that may or may not be announced. With a role it is a name, and
    // it replaces the element's contents rather than joining them.
    expect(accessibleText('<span aria-label="3 unread"></span>')).toBe("");
    expect(accessibleText('<span role="img" aria-label="3 unread"></span>')).toBe("3 unread");
    expect(accessibleText('<button aria-label="Close">x</button>')).toBe("Close");
  });

  it("announces an image by its alt, and says nothing for a bare empty one", () => {
    expect(accessibleText('<img src="x" alt="A cat"/>')).toBe("A cat");
    expect(accessibleText('<img src="x" alt=""/>')).toBe("");
  });

  it("knows a title names an image that an empty alt alone would not silence", () => {
    // The picture branch's exact shape before `aria-hidden`.
    expect(accessibleText(`<img src="x" alt="" title="${NAME}"/>`)).toBe(NAME);
  });
});

describe("an avatar with no image", () => {
  it("contributes nothing to the accessible text of its row", () => {
    expect(accessibleText(row())).toBe(NAME);
    // The symptom, named: two letters announced before every name.
    expect(accessibleText(row())).not.toBe(`FD${NAME}`);
    expect(accessibleText(row())).not.toMatch(/FD/);
  });

  it("still draws the initials for the people who can see them", () => {
    // Hidden from assistive tech, not removed: the disc is the whole point.
    expect(row()).toContain(">FD<");
  });

  it("keeps the hover title out of the tree as well", () => {
    // `title` on a rendered element is an accessible name of last resort, so
    // hiding only the text would have left the name to leak through here.
    expect(row()).toContain(`title="${NAME}"`);
    expect(accessibleText(row())).toBe(NAME);
  });
});

describe("an avatar with an image", () => {
  it("does not repeat the name printed next to it", () => {
    expect(accessibleText(row(PICTURE))).toBe(NAME);
  });

  it("is a decorative image, so its alt is empty", () => {
    expect(row(PICTURE)).toContain('alt=""');
  });

  it("does not let its title stand in as the name either", () => {
    // An `<img>` with an empty `alt` *and* a `title` is not presentational —
    // the title becomes its accessible name. That is the same defect in the
    // other branch, and it is why `alt=""` alone was not the fix.
    expect(row(PICTURE)).toContain(`title="${NAME}"`);
    expect(accessibleText(row(PICTURE))).toBe(NAME);
  });
});

describe("the account menu, the one control an avatar could be alone in", () => {
  /*
   * Every other call site prints the name beside the avatar unconditionally.
   * This one prints it only from `sm` up, so before Task 46 the initials were
   * the button's entire accessible name on a phone — and `aria-hidden` cannot
   * be made responsive. The name is `sr-only` below `sm` instead, which this
   * asserts by reading the button rather than its classes.
   */
  function nav(unread = 0): string {
    return renderToStaticMarkup(
      createElement(NavMenu, {
        user: {
          displayName: NAME,
          name: null,
          handle: "faro",
          avatarUrl: null,
          isAdmin: false,
        },
        unread,
        signOut: async () => {},
      })
    );
  }

  it("is named at the narrowest width, where nothing prints the name on screen", () => {
    expect(accessibleText(nav())).toBe(NAME);
  });

  it("is not named by the initials", () => {
    expect(accessibleText(nav())).not.toMatch(/FD/);
  });

  it("announces the unread count, and still names the button once", () => {
    // Before this the dot's `aria-label` sat on a bare span, so `nav(3)` and
    // `nav(0)` were the same string and this test could not fail for the
    // reason it gave. The count reaches a reader because that span carries a
    // role that can be named: take `role="img"` off it in `NavMenu` and this
    // drops back to `Faro Delgado`.
    expect(accessibleText(nav(3))).toBe(`3 unread ${NAME}`);
    expect(accessibleText(nav(0))).toBe(NAME);
  });
});
