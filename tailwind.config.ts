import type { Config } from "tailwindcss";

/**
 * The palette is the Union Jack and nothing else: blue, red, white, on a
 * blue-black ground. See the note at the top of `src/app/globals.css`.
 *
 * `gold`, `ember` and `signal` are the names forty components already use. They
 * now hold union blue, union red and a cool near-white, so the whole site
 * re-skins without touching a component. Prefer `union`, `flare` and `hot` in
 * anything new — same colours, honest names.
 */
const UNION_BLUE = "#4d7fff";
const UNION_DEEP = "#1c4fdb";
const UNION_RED = "#ff2d4f";
const HOT = "#ffffff";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#04060f",
        panel: "#090e1d",
        raised: "#0f1830",
        hair: "#1e2b52",
        chalk: "#eaf0ff",
        muted: "#7b89b4",

        union: UNION_BLUE,
        "union-deep": UNION_DEEP,
        flare: UNION_RED,
        hot: HOT,

        gold: UNION_BLUE,
        ember: UNION_RED,
        signal: "#cfe0ff",
      },
      fontFamily: {
        display: ["var(--font-display)", "sans-serif"],
        wordmark: ["var(--font-wordmark)", "var(--font-display)", "sans-serif"],
        body: ["var(--font-body)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
      boxShadow: {
        union: "0 0 24px -6px rgba(77, 127, 255, 0.75)",
        flare: "0 0 24px -6px rgba(255, 45, 79, 0.7)",
      },
    },
  },
  plugins: [],
};

export default config;
