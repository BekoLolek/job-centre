import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0a0b0c",
        panel: "#121417",
        raised: "#181b1f",
        hair: "#262b31",
        chalk: "#f1ede4",
        muted: "#8b9199",
        gold: "#e3b23c",
        ember: "#ff4d1c",
        signal: "#3ddc84",
      },
      fontFamily: {
        display: ["var(--font-display)", "sans-serif"],
        body: ["var(--font-body)", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
