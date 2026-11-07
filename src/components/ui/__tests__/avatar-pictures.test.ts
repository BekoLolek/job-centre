import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Avatar from "../Avatar";

/**
 * Every avatar on the site is handed the picture Discord already gave us
 * (R-252).
 *
 * ## Why a sweep and not eleven tests
 *
 * `users.avatar_url` has been filled on every sign-in since the first one, and
 * every player payload has carried it since the draft was built. `Avatar` has
 * drawn a `src` since Task 46. And still eight of eleven call sites drew
 * initials, because each of them was written as `<Avatar name={…} />` and
 * nothing anywhere said that was incomplete. A test per site would have pinned
 * the eight that were fixed and said nothing about the ninth written next
 * month — the defect was never *which* site forgot, it was that forgetting was
 * free. So this reads the source: every `<Avatar` and every `<PlayerChip`
 * opening tag in `src/**` has to hand over a picture, and a new call site is
 * in the sweep the moment it is written.
 *
 * ## What counts as handing one over
 *
 * The attribute has to be there, and its value has to be one of two things:
 * something that names a picture (`avatarUrl`, `playerAvatar(…)` — the only
 * lawful sources of one on this site, every payload spells it that way), or
 * the literal `{null}`, which is a site saying out loud that nothing has a
 * picture here. `src={undefined}`, `src={profile.name}` and `src={""}` all
 * fail: the first draws initials by accident, the other two draw a broken
 * image until `onError` catches it.
 *
 * ## Why the walker skips comments
 *
 * The attribute text is found with the same brace-and-quote counter as
 * `field-ordering.test.ts`, with one addition: it steps over line comments and
 * block comments. `RosterList` already explains its `href` in a `//` comment inside
 * the `<PlayerChip` tag, and that comment has an apostrophe in it, which a
 * plain quote tracker would take as the start of a string and swallow the
 * rest of the file into. Better to read the comment than to forbid it.
 */

const ROOT = path.resolve(__dirname, "../../../..");

function sourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx")) out.push(full);
    }
  })(path.join(ROOT, "src"));
  return out;
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

/** The attribute text of one JSX opening tag, from just after its name. */
function attributesAt(source: string, from: number): string | null {
  let depth = 0;
  let quote = "";
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      if (i === -1) return null;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i);
      if (i === -1) return null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return source.slice(from, source[i - 1] === "/" ? i - 1 : i);
  }
  return null;
}

/** The braced expression that starts at `from`, braces included, or null. */
function expressionAt(text: string, from: number): string | null {
  if (text[from] !== "{") return null;
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") depth -= 1;
    if (depth === 0) return text.slice(from, i + 1);
  }
  return null;
}

type CallSite = { where: string; attrs: string };

/** Every `<Tag` opening tag in `src/**`, except inside the component's own file and the tests. */
function callSites(tag: string, own: string): CallSite[] {
  const out: CallSite[] = [];
  for (const file of sourceFiles()) {
    const rel = relative(file);
    if (rel === own || rel.includes("/__tests__/")) continue;
    const source = fs.readFileSync(file, "utf8");
    const lineAt = (index: number) => source.slice(0, index).split("\n").length;
    for (const match of source.matchAll(new RegExp(`<${tag}[\\s\\n/>]`, "g"))) {
      const attrs = attributesAt(source, match.index + match[0].length - 1);
      expect(attrs, `${rel}:${lineAt(match.index)} <${tag}> never closes its tag`).not.toBeNull();
      out.push({ where: `${rel}:${lineAt(match.index)}`, attrs: attrs! });
    }
  }
  return out;
}

/** The value a call site hands to `prop`, or null when it hands nothing. */
function valueOf(attrs: string, prop: string): string | null {
  const found = new RegExp(`(^|\\s)${prop}=`).exec(attrs);
  if (!found) return null;
  const start = found.index + found[0].length;
  return expressionAt(attrs, start) ?? attrs.slice(start).split(/\s/)[0];
}

/** What a site may say: a picture by its name, or `null` out loud. */
function handsOverAPicture(value: string | null): boolean {
  return value !== null && (value === "{null}" || /avatar/i.test(value));
}

const AVATARS = callSites("Avatar", "src/components/ui/Avatar.tsx");
const CHIPS = callSites("PlayerChip", "src/components/draft/PlayerChip.tsx");

describe("the sweep itself", () => {
  /*
   * The floors. A sweep that matched nothing would pass silently, so the corpus
   * is asserted to be real before anything is concluded from it: eleven
   * avatars and seven chips were counted by hand when this was written.
   */
  it("finds every avatar and every chip on the site", () => {
    expect(AVATARS.length).toBeGreaterThanOrEqual(11);
    expect(CHIPS.length).toBeGreaterThanOrEqual(7);
  });

  it("reads a tag whose attributes run over several lines", () => {
    const podium = AVATARS.find((site) => site.where.startsWith("src/components/championship/Podium.tsx"));
    expect(podium, "the podium's avatar is in the sweep").toBeDefined();
    expect(valueOf(podium!.attrs, "src")).toBe("{player.avatarUrl}");
  });

  it("reads past a comment inside the tag", () => {
    const attrs = attributesAt(
      `<PlayerChip\n  name="x"\n  // the owner's note\n  avatarUrl={playerAvatar(players, id)}\n/>`,
      "<PlayerChip".length
    );
    expect(attrs).not.toBeNull();
    expect(valueOf(attrs!, "avatarUrl")).toBe("{playerAvatar(players, id)}");
  });

  it("tells a picture from a name, and lets a site say null", () => {
    expect(handsOverAPicture("{row.member.avatarUrl}")).toBe(true);
    expect(handsOverAPicture("{playerAvatar(players, member.userId)}")).toBe(true);
    expect(handsOverAPicture("{null}")).toBe(true);
    expect(handsOverAPicture("{row.member.displayName}")).toBe(false);
    expect(handsOverAPicture("{undefined}")).toBe(false);
    expect(handsOverAPicture(null)).toBe(false);
  });
});

describe("every call site hands over a picture", () => {
  it.each(AVATARS)("$where passes <Avatar> a src", ({ attrs }) => {
    expect(handsOverAPicture(valueOf(attrs, "src"))).toBe(true);
  });

  it.each(CHIPS)("$where passes <PlayerChip> an avatarUrl", ({ attrs }) => {
    expect(handsOverAPicture(valueOf(attrs, "avatarUrl"))).toBe(true);
  });
});

/*
 * The fallback, pinned so that wiring pictures in cannot have cost it. The
 * suite has no DOM (see `avatar.test.ts`), so the image-error path is pinned
 * at the one level available here: the handlers are on the element. That a
 * broken URL draws initials on a real screen is the browser's to show.
 */
describe("the fallback the sweep relies on", () => {
  const render = (src: string | null) =>
    renderToStaticMarkup(createElement(Avatar, { name: "Faro Delgado", src }));

  it("draws initials for a member with no picture", () => {
    expect(render(null)).toContain(">FD<");
    expect(render(null)).not.toContain("<img");
  });

  it("draws the picture, and no initials, for a member with one", () => {
    const html = render("https://cdn.discordapp.com/avatars/1/a.png");
    expect(html).toContain('<img src="https://cdn.discordapp.com/avatars/1/a.png"');
    expect(html).not.toContain(">FD<");
  });

  it("still catches a picture that fails to load, before and after hydration", () => {
    const source = fs.readFileSync(path.join(ROOT, "src/components/ui/Avatar.tsx"), "utf8");
    expect(source).toMatch(/onError=\{\(\) => setFailed\(src\)\}/);
    expect(source).toMatch(/node\?\.complete && node\.naturalWidth === 0\) setFailed\(src\)/);
  });
});
