import { Inter, JetBrains_Mono, Michroma } from "next/font/google";

/**
 * One typeface, plus two specialists.
 *
 * The site used four faces at once — an angular display face for headings, a
 * wide engineered one for the wordmark, a grotesque for body copy and a mono
 * for figures. Measuring three sites that do this well (start.gg, Linear,
 * Vercel) turned up the same answer at all three: **one family, everywhere.**
 * Character comes from the colour, the spacing and the wordmark, not from
 * giving every role its own font. Four faces on one page is what made this
 * read as a games template rather than as a product.
 *
 * `Inter` is that family. It was drawn for interface text, it holds up from
 * 11px to 36px, and its weights are close enough together that 400 next to 600
 * reads as emphasis instead of as two different fonts.
 *
 * `Michroma` survives for exactly one string — the wordmark in the top bar —
 * so the site still has a signature. It appears once per page and nowhere else.
 *
 * `JetBrains Mono` carries figures: money, scores, timers, seeds. A mono is not
 * decoration here, it is what keeps a column of numbers in line.
 */

export const sans = Inter({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

export const wordmark = Michroma({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-wordmark",
  display: "swap",
});

export const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

/**
 * `--font-display` is kept, pointing at the same family as body copy. Fifty-odd
 * components ask for `font-display`; they now get Inter, and the weight and
 * tracking that make a heading a heading come from the `.font-display` rule in
 * `globals.css` instead of from a second typeface.
 */
export const fontVariables = `${sans.variable} ${wordmark.variable} ${mono.variable}`;
