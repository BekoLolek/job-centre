import type { Config } from "tailwindcss";

/**
 * The theme. It defines no values of its own.
 *
 * Every colour lives in `src/app/globals.css` as RGB channels (`--union-rgb`
 * and friends) and every radius as `--r` / `--r-lg` / `--r-full`. This file only points at
 * them, so the palette cannot drift between the stylesheet and the utilities —
 * which is exactly what had happened: the same eleven hex values were written
 * out twice, and three of the names lied about what they rendered (`gold` was
 * blue, `ember` was red, `signal` was body grey and meant "success").
 *
 * Channels rather than hex because Tailwind's alpha modifiers need them:
 * `bg-union/15` compiles to `rgb(var(--union-rgb) / 0.15)`. A plain
 * `var(--union)` would silently render `bg-union/15` fully opaque.
 */

/** A palette entry that honours `bg-x/40`, reading its channels from `:root`. */
const token = (name: string) => `rgb(var(--${name}-rgb) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    /*
     * Replaced, not extended. Tailwind's own scales are what let 143 arbitrary
     * `text-[12.5px]`s and five radii in through the side door; if a value is
     * not on the list below it should not compile.
     */
    fontSize: {
      /*
       * Named steps in pixels, because a t-shirt scale that runs from 11px to
       * 48px stops meaning anything. Line heights match what the site already
       * rendered, so the sweep off the arbitrary sizes did not move any text.
       *
       * 11 micro labels · 12 eyebrows and meta · 13 dense UI and buttons ·
       * 14 default UI text · 16 lead and card titles · 20 h3 · 24 figures and
       * small h2 · 30 h2 · 36 page h1 · 48 hero.
       */
      11: ["11px", { lineHeight: "16px" }],
      12: ["12px", { lineHeight: "16px" }],
      13: ["13px", { lineHeight: "20px" }],
      14: ["14px", { lineHeight: "20px" }],
      16: ["16px", { lineHeight: "24px" }],
      20: ["20px", { lineHeight: "28px" }],
      24: ["24px", { lineHeight: "32px" }],
      30: ["30px", { lineHeight: "36px" }],
      36: ["36px", { lineHeight: "40px" }],
      48: ["48px", { lineHeight: "1" }],
      /*
       * Two fluid steps, for the two places that genuinely need one: the
       * sign-in wordmark and the name on the draft stage. Both have to survive
       * a 400px viewport and a 2000px one, which no fixed step does.
       */
      hero: ["clamp(2rem, 5.2vw, 4.6rem)", { lineHeight: "1" }],
      stage: ["clamp(2rem, 6vw, 4rem)", { lineHeight: "1" }],
    },
    /*
     * One radius does almost everything. Vercel uses 6px on 119 elements of a
     * single page; a scale of five radii is five decisions nobody asked for.
     * `full` is for pills and dots, and nothing else.
     */
    borderRadius: {
      none: "0",
      DEFAULT: "var(--r)",
      lg: "var(--r-lg)",
      full: "var(--r-full)",
    },
    extend: {
      colors: {
        /* Ground and surfaces. Only `panel` and `raised` are ever filled. */
        ink: token("ink"),
        sunken: token("sunken"),
        panel: token("panel"),
        raised: token("raised"),
        "raised-hi": token("raised-hi"),
        hair: token("hair"),
        "hair-hi": token("hair-hi"),
        edge: token("edge"),
        "edge-hi": token("edge-hi"),

        /* The type ladder, brightest first. */
        chalk: token("chalk"),
        body: token("body"),
        muted: token("muted"),
        dim: token("dim"),

        /* The flag, and the only two hues on the page. */
        union: token("union"),
        "union-deep": token("union-deep"),
        "union-hi": token("union-hi"),
        "union-pale": token("union-pale"),
        flare: token("flare"),
        "flare-deep": token("flare-deep"),
        "flare-pale": token("flare-pale"),
        "flare-soft": token("flare-soft"),
        hot: token("hot"),

        /* The third semantic colour: saved, confirmed, published, bid in. */
        success: token("success"),

        /*
         * The opaque chip fills, in two strengths: `-tint-10` is the alert and
         * the selected filter, `-tint-15` the badge and the status pill. The
         * number is the percentage of the hue they were mixed from.
         *
         * These go through `token()` like everything else, so Tailwind will
         * happily compile `bg-union-tint-15/40` — and that would put the fill
         * straight back on the surface under it, which is the single thing
         * these tokens exist to prevent. The modifier is accepted and must not
         * be used; the guard fails the build's tests if one appears.
         */
        "union-tint-10": token("union-tint-10"),
        "flare-tint-10": token("flare-tint-10"),
        "success-tint-10": token("success-tint-10"),
        "union-tint-15": token("union-tint-15"),
        "flare-tint-15": token("flare-tint-15"),
        "success-tint-15": token("success-tint-15"),

        /*
         * The overlay scale — white over the ground, three steps. 1 is a hover
         * wash, 2 a resting tint, 3 a pressed or selected fill.
         *
         * These are plain `var()` rather than `token()`, so they carry their
         * own alpha and Tailwind cannot fold a modifier into them: it drops
         * `bg-overlay-2/50` on the floor and emits no rule at all, which loses
         * the background silently. They are also legal as `text-overlay-1`,
         * which would be a 4%-opacity glyph. Both are banned in the guard.
         */
        "overlay-1": "var(--overlay-1)",
        "overlay-2": "var(--overlay-2)",
        "overlay-3": "var(--overlay-3)",
      },
      fontFamily: {
        /* `display` is the same family as body copy — see `src/app/fonts.ts`. */
        display: ["var(--font-body)", "system-ui", "sans-serif"],
        wordmark: ["var(--font-wordmark)", "system-ui", "sans-serif"],
        body: ["var(--font-body)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
      boxShadow: {
        lift: "0 16px 40px -24px rgb(0 0 0 / 0.9)",
        /*
         * The rule under a menu, drawn as an inset shadow rather than a border.
         *
         * A border sits outside the padding box, so an underlined tab has to be
         * pulled 1px down with a negative margin to cover it — and a negative
         * margin inside a horizontally scrollable box makes the browser add a
         * *vertical* scrollbar, because `overflow-x: auto` promotes the other
         * axis to `auto` too. An inset shadow paints inside the box, so the
         * tab's own underline covers it with no negative margin anywhere.
         */
        rail: "inset 0 -1px 0 var(--hair)",
      },
    },
  },
  plugins: [],
};

export default config;
