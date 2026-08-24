import type { Config } from "tailwindcss";

/**
 * The palette.
 *
 * The ground is near-neutral, not blue. That is the single biggest change in
 * this pass. Three well-designed dark products were measured before writing it
 * — Linear sits on `#08090a`, Vercel on `#000` — and both keep their greys
 * neutral so the one accent colour is the only hue on the page. This site had a
 * blue-black ground, blue-tinted greys and a blue accent, which is why nothing
 * read as accented: everything was already blue.
 *
 * Text is a ladder of four, not a pair. `chalk → body → muted → dim` is the order you read them
 * in. Every step is measured against the ground: muted is 7.3:1, dim 4.9:1,
 * body 12:1. Nothing on the site is allowed below 4.5:1.
 *
 * `union` and `flare` are the flag, and they are the only hues here. Blue is
 * interactive and current; red is live and destructive. Reserving them is what
 * makes them mean something — the old build used blue for icons, headings,
 * rules and borders, so a blue button said nothing.
 */

const GROUND = "#0a0b0e";
const UNION = "#4d7fff";
const UNION_DEEP = "#1c4fdb";
const FLARE = "#ff2d4f";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        /* Ground and surfaces. Only `panel` and `raised` are ever filled. */
        ink: GROUND,
        panel: "#101216",
        raised: "#181a1f",
        hair: "#23252b",

        /* The type ladder, brightest first. */
        chalk: "#f4f5f7",
        body: "#c9ccd3",
        muted: "#9aa0a9",
        dim: "#7c8089",

        union: UNION,
        "union-deep": UNION_DEEP,
        flare: FLARE,
        hot: "#ffffff",

        /* The names forty components already use, pointed at the new ladder. */
        gold: UNION,
        ember: FLARE,
        signal: "#c9ccd3",
      },
      fontFamily: {
        /* `display` is the same family as body copy — see `src/app/fonts.ts`. */
        display: ["var(--font-body)", "system-ui", "sans-serif"],
        wordmark: ["var(--font-wordmark)", "system-ui", "sans-serif"],
        body: ["var(--font-body)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
      /*
       * One radius does almost everything. Vercel uses 6px on 119 elements of a
       * single page; a scale of five radii is five decisions nobody asked for.
       */
      borderRadius: {
        DEFAULT: "6px",
      },
      boxShadow: {
        lift: "0 16px 40px -24px rgba(0, 0, 0, 0.9)",
      },
    },
  },
  plugins: [],
};

export default config;
