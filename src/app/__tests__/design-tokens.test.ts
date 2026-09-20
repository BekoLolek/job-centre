import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The design system has one palette, one type scale, one overlay scale and one
 * radius scale, and they all live in `globals.css`. Nothing here renders
 * anything — these are the invariants that let the rest of the site be styled
 * without a second opinion about what "13px" or "union" means.
 *
 * This file exists because the mess it guards against came back four times:
 * a hex typed into a component, a `text-[12.5px]` because 12 felt small, a
 * `bg-white/[0.055]` that nobody can tell from `[0.05]`. Every one of those is
 * cheap to add and expensive to find later, so they fail here instead.
 *
 * The contrast half of the file measures **alpha as well as opaque**. An
 * earlier version checked only the flat tokens, and that gap is what let
 * `text-union/80` (3.83:1), `text-dim/60` (2.63:1) and `text-muted/70`
 * (4.14:1) ship: every one of them is a token that passes on its own, faded to
 * a value that does not.
 */

const ROOT = path.resolve(__dirname, "../../..");
const GLOBALS = path.join(ROOT, "src/app/globals.css");

/*
 * `.ts` as well as `.tsx`: `board.ts`, `labels.ts` and `story.ts` all author
 * Tailwind class strings and were invisible to the walker while it matched
 * `.tsx` alone.
 */
function sourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // This file quotes the patterns it bans, so it cannot scan itself.
      else if (/\.tsx?$/.test(entry.name) && full !== __filename) out.push(full);
    }
  })(path.join(ROOT, "src"));
  return out;
}

function relative(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

/** Canvas and SVG drawing code cannot take a Tailwind class, so it keeps its hex. */
const HEX_EXEMPT = ["components/Wheel.tsx"];

const BANNED: { name: string; pattern: RegExp; exempt?: string[] }[] = [
  { name: "arbitrary font size (use text-11 … text-48)", pattern: /text-\[[^\]]*(px|rem|em|clamp)/ },
  {
    // Widened from `bg-white/` — `bg-union/[0.14]` is the same defect in a
    // different hue, and two of them survived the first sweep.
    name: "ad-hoc alpha (use a standard step, or an opaque *-tint token)",
    pattern: /\b(?:bg|text|border|ring|divide|outline|fill|stroke)-[a-z0-9-]+\/\[/,
  },
  { name: "ad-hoc white overlay (use bg-overlay-1…3)", pattern: /bg-white\// },
  {
    /*
     * The tints go through `token()`, so Tailwind compiles `bg-union-tint-15/40`
     * into a translucent fill — putting the surface underneath back into the
     * colour, which is the one thing these tokens exist to prevent. The config
     * cannot refuse the modifier; this can.
     */
    name: "alpha on an opaque tint (the fill must not vary with the surface)",
    pattern: /-(?:union|flare|success)-tint(?:-1[05])?\//,
  },
  {
    /*
     * The overlays fail the opposite way. They are plain `var()`, so a
     * modifier does not compile at all: `bg-overlay-2/50` emits no rule and
     * the background silently disappears. `text-overlay-1` does compile, and
     * is a glyph at 4% opacity.
     */
    name: "alpha on an overlay (emits nothing), or an overlay used as text",
    pattern: /-overlay-[123]\/|\btext-overlay-/,
  },
  { name: "ad-hoc radius (use rounded / rounded-lg / rounded-full)", pattern: /rounded-\[/ },
  { name: "raw hex colour (use a palette token)", pattern: /#[0-9a-fA-F]{3,8}\b/, exempt: HEX_EXEMPT },
  {
    name: "retired colour alias gold/ember/signal (use union/flare/success)",
    pattern: /\b(?:text|bg|border|ring|fill|stroke|from|via|to|divide|outline|decoration|accent|caret|placeholder)-(?:gold|ember|signal)\b/,
  },
];

describe("design tokens", () => {
  it.each(BANNED)("no $name in src", ({ pattern, exempt = [] }) => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const rel = relative(file);
      if (exempt.some((e) => rel.endsWith(e))) continue;
      for (const [i, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
        if (pattern.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the whole palette in globals.css, and nowhere else", () => {
    const config = fs.readFileSync(path.join(ROOT, "tailwind.config.ts"), "utf8");
    expect(config.match(/#[0-9a-fA-F]{3,8}\b/g)).toBeNull();

    // Every colour and every radius in the theme has to point back at `:root`.
    const block = config.slice(config.indexOf("colors: {"), config.indexOf("fontFamily: {"));
    const values = [...block.matchAll(/:\s*(token\("[a-z0-9-]+"\)|"[^"]+")/g)].map((m) => m[1]);
    expect(values.length).toBeGreaterThan(20);
    expect(values.filter((v) => !v.startsWith("token(") && !v.includes("var(--"))).toEqual([]);

    const radii = config.slice(config.indexOf("borderRadius: {"), config.indexOf("extend: {"));
    expect([...radii.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]).filter((v) => v !== "0")).toEqual([
      "var(--r)",
      "var(--r-lg)",
      "var(--r-full)",
    ]);

    const colours = palette();

    /*
     * `token("x")` compiles to `rgb(var(--x-rgb) / …)`. If `--x-rgb` does not
     * exist the utility still emits, referencing nothing, and the element
     * renders with no colour at all — the one way this scheme fails silently.
     */
    const named = [...config.matchAll(/token\("([a-z0-9-]+)"\)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(20);
    expect(named.filter((name) => !colours[name])).toEqual([]);

    /*
     * The six tints are hand-written triplets, so nothing but this stops them
     * going stale: change `--union-rgb` and `--union-tint-15-rgb` would still
     * describe the old blue, and the badge would quietly stop matching the
     * hue it is named after. Recompute each one from its hue and the ground.
     */
    for (const hue of ["union", "flare", "success"]) {
      for (const pct of [10, 15]) {
        const derived = composite(colours[hue], colours.ink, pct / 100).map(Math.round);
        expect(colours[`${hue}-tint-${pct}`], `--${hue}-tint-${pct}-rgb`).toEqual(derived);
      }
    }
  });
});

/* --------------------------------------------------------------------- */
/* Contrast                                                              */
/* --------------------------------------------------------------------- */

type RGB = [number, number, number];

/** `--name-rgb: 10 11 14;` → `[10, 11, 14]`, read from the one palette source. */
function palette(): Record<string, RGB> {
  const css = fs.readFileSync(GLOBALS, "utf8");
  const out: Record<string, RGB> = {};
  for (const [, name, r, g, b] of css.matchAll(
    /--([a-z0-9-]+)-rgb:\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3});/g
  )) {
    out[name] = [Number(r), Number(g), Number(b)];
  }
  return out;
}

function relativeLuminance([r, g, b]: RGB): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(fg: RGB, bg: RGB): number {
  const [light, dark] = [relativeLuminance(fg), relativeLuminance(bg)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/** Alpha compositing — what a translucent colour actually becomes on a ground. */
function composite(fg: RGB, bg: RGB, alpha: number): RGB {
  return [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as RGB;
}

const AA = 4.5;

/*
 * The four surfaces text can land on: the page, a field, a panel, and the
 * raised face of a button or a bordered row.
 *
 * `raised` is the brightest of them, so it is the hardest ground there is, and
 * every text token has to clear it whether or not anything currently pairs the
 * two. That last clause is the point. `dim` used to be #7c8089, which is
 * 4.97:1 on the page and 4.40:1 on `raised`; the site passed only because none
 * of the raised boxes happened to contain quiet text. A token that is safe by
 * coincidence fails the moment someone writes the obvious markup, so `dim` was
 * moved to #82868f and the list below is deliberately the whole ladder.
 *
 * `raised-hi` is not here: it exists only as `.btn:hover`, which sets its own
 * colour to chalk in the same rule. That pairing is asserted on its own below.
 */
const GROUNDS = ["ink", "sunken", "panel", "raised"];

/** Every token the site paints text with. */
const TEXT_TOKENS = [
  "chalk",
  "body",
  "muted",
  "dim",
  "union",
  "union-pale",
  "flare",
  "flare-pale",
  "flare-soft",
  // `.btn-flare:hover` swaps the label to this; nothing writes it as a class,
  // so only the unconditional floor above ever measures it.
  "flare-soft-hi",
  "success",
  "hot",
];

/** One line in, the text utilities it writes out. Separate so it is testable. */
export function scanText(line: string): { token: string; alpha: number }[] {
  const out: { token: string; alpha: number }[] = [];
  for (const [, token, pct] of line.matchAll(/\btext-([a-z0-9-]+?)(?:\/(\d{1,3}))?(?![\w/-])/g)) {
    if (!TEXT_TOKENS.includes(token)) continue;
    out.push({ token, alpha: pct === undefined ? 1 : Number(pct) / 100 });
  }
  return out;
}

/**
 * Every `text-<token>` and `text-<token>/<alpha>` actually written in the
 * source, so the check follows the code rather than a list somebody remembered
 * to update.
 */
function textUtilities(): { token: string; alpha: number; where: string[] }[] {
  const found = new Map<string, { token: string; alpha: number; where: string[] }>();
  for (const file of sourceFiles()) {
    const rel = relative(file);
    for (const [i, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
      for (const { token, alpha } of scanText(line)) {
        const key = `${token}/${alpha}`;
        const entry = found.get(key) ?? { token, alpha, where: [] };
        entry.where.push(`${rel}:${i + 1}`);
        found.set(key, entry);
      }
    }
  }
  return [...found.values()].sort((a, b) => a.token.localeCompare(b.token) || b.alpha - a.alpha);
}

/**
 * Class strings that set a background and a foreground together — a badge, a
 * pill, an alert, a selected filter. These are the pairings the ground check
 * cannot see, because the text is not sitting on a surface, it is sitting on
 * whatever the same element just painted.
 *
 * A limitation worth writing down: this reads one element at a time, so a bar
 * painted by one element under text painted by another (the poll option) is
 * not caught here and has to be reasoned about by hand.
 */
function pairedUtilities(colours: Record<string, RGB>): {
  bg: string;
  bgAlpha: number;
  text: string;
  textAlpha: number;
  where: string;
}[] {
  const out = [];
  const bgRe = /\bbg-([a-z0-9-]+?)(?:\/(\d{1,3}))?(?![\w/-])/;
  const textRe = /\btext-([a-z0-9-]+?)(?:\/(\d{1,3}))?(?![\w/-])/;
  for (const file of sourceFiles()) {
    const rel = relative(file);
    for (const [i, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
      for (const [, body] of line.matchAll(/"([^"]*\bbg-[^"]*)"/g)) {
        const bg = bgRe.exec(body);
        const text = textRe.exec(body);
        if (!bg || !text) continue;
        if (!colours[bg[1]] || !TEXT_TOKENS.includes(text[1])) continue;
        out.push({
          bg: bg[1],
          bgAlpha: bg[2] === undefined ? 1 : Number(bg[2]) / 100,
          text: text[1],
          textAlpha: text[2] === undefined ? 1 : Number(text[2]) / 100,
          where: `${rel}:${i + 1}`,
        });
      }
    }
  }
  return out;
}

describe("contrast", () => {
  const colours = palette();

  it("reads the palette out of globals.css", () => {
    expect(Object.keys(colours).length).toBeGreaterThan(20);
  });

  it("has a scanner that finds plain and faded utilities", () => {
    // Against a fixture, so this stays a test of the scanner rather than of
    // which utilities the site currently happens to use. Deleting the last
    // `text-chalk/70` is a refactor in the direction this task pushes; it
    // must not fail a test about whether the parser works.
    const found = scanText('cx("text-muted", on && "text-chalk/70", "text-[13px]", "text-nonsense")');
    expect(found).toEqual([
      { token: "muted", alpha: 1 },
      { token: "chalk", alpha: 0.7 },
    ]);

    expect(textUtilities().length).toBeGreaterThan(10);
  });

  /*
   * The floor, and it is deliberately not driven by usage.
   *
   * The loop below only measures what the source happens to write today, which
   * is the right way to catch a faded utility but the wrong way to hold a
   * palette: `union-pale`, `flare-pale` and `flare-soft` are painted as text
   * from CSS rather than from a Tailwind class — `.btn-flare`'s label, and the
   * stops of the wordmark gradient — so a usage scan cannot see them at all,
   * and a token nobody has written yet is exactly the one that will be written
   * badly. This is the same principle that moved `dim`: a step earns its place
   * in the ladder by clearing AA everywhere, not by being used carefully.
   */
  it.each(TEXT_TOKENS)("%s clears 4.5:1 on all four grounds, used or not", (name) => {
    for (const ground of GROUNDS) {
      const ratio = contrast(colours[name], colours[ground]);
      expect(
        Number(ratio.toFixed(2)),
        `${name} on ${ground} is ${ratio.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it("clears 4.5:1 for every text utility in the source, on every ground", () => {
    const failures: string[] = [];
    for (const { token, alpha, where } of textUtilities()) {
      for (const ground of GROUNDS) {
        const fg = composite(colours[token], colours[ground], alpha);
        const ratio = contrast(fg, colours[ground]);
        if (ratio < AA) {
          const name = alpha === 1 ? `text-${token}` : `text-${token}/${alpha * 100}`;
          failures.push(
            `${name} on ${ground} is ${ratio.toFixed(2)}:1 (${where.length} sites, e.g. ${where[0]})`
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("clears 4.5:1 for every background/foreground pair written on one element", () => {
    const failures: string[] = [];
    for (const pair of pairedUtilities(colours)) {
      for (const ground of GROUNDS) {
        const bg = composite(colours[pair.bg], colours[ground], pair.bgAlpha);
        const fg = composite(colours[pair.text], bg, pair.textAlpha);
        const ratio = contrast(fg, bg);
        if (ratio < AA) {
          failures.push(
            `${pair.where}: text-${pair.text} on bg-${pair.bg} over ${ground} is ${ratio.toFixed(2)}:1`
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps a filled button readable, where hot or chalk is always the text", () => {
    for (const fill of ["union-deep", "union-hi", "raised-hi"]) {
      const ratio = contrast(colours.hot, colours[fill]);
      expect(
        Number(ratio.toFixed(2)),
        `hot on ${fill} is ${ratio.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(AA);
    }
    // `.btn:hover` fills with `raised-hi` and switches its label to chalk.
    expect(contrast(colours.chalk, colours["raised-hi"])).toBeGreaterThanOrEqual(AA);
  });
});
