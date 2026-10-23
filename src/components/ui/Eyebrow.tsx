import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/**
 * The small quiet label that titles blocks across the site.
 *
 * `.eyebrow` deliberately declares no `color` — a label has no colour, the
 * thing it labels does — so this component supplies `text-dim` as the default.
 * Pass any `text-*` colour to change it; the default is **dropped** when you
 * do, rather than left to argue with yours in the cascade.
 *
 * That last clause is Task 69, and it is the whole reason this file has more
 * than one line in it. Both classes are single classes at 0-1-0, so the browser
 * breaks the tie on *emitted* order — and Tailwind emits the colour utilities
 * **alphabetically**, not in the order an author wrote them (`cx` is a plain
 * join with no dedupe, so it cannot help). While the default was hard-coded
 * beside `.eyebrow`, `text-dim` beat everything from `text-body` to
 * `text-chalk/80` and lost to `text-flare` and everything after it: the
 * docblock's promise held for half the palette and failed silently for the
 * other half, and 11 call sites asking for a chalk tone rendered dim.
 * `eyebrow-colour.test.ts` resolves that cascade out of the compiled
 * stylesheet, so this cannot quietly come back.
 */

/**
 * Does this class list already name a colour?
 *
 * The base name of every colour in `tailwind.config.ts`, and `\b` carries the
 * variants: `text-union-hi`, `text-flare-pale` and `text-success-tint-15` all
 * match through `union`, `flare` and `success`, because the `-` after the base
 * name is a word boundary. The sizes (`text-12`, `text-hero`) and Tailwind's
 * own `text-right`/`text-balance`/`text-ellipsis` deliberately do not match —
 * writing one of those is not writing a colour, and the default must survive
 * it. The overlay tokens are left out on purpose: one of them used as a text
 * colour is a 4%-opacity glyph, and `design-tokens.test.ts` bans that utility
 * outright — accommodating a class the suite refuses would only add an
 * alternative here that nothing could ever exercise.
 *
 * The list is checked against the theme rather than trusted — the guard test
 * walks every colour the config defines and fails if one of them is missing
 * here, and fails too if a font-size step is ever named after a colour.
 */
const NAMES_A_COLOUR =
  /\btext-(?:body|chalk|dim|edge|flare|hair|hot|ink|muted|panel|raised|success|sunken|union)\b/;

type EyebrowTag = "div" | "span" | "p" | "h1" | "h2" | "h3" | "h4";

export type EyebrowProps = {
  /** Element to render — `div` by default; use `span` inline, `h2`/`h3` for headings. */
  as?: EyebrowTag;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "className" | "children">;

export default function Eyebrow({ as: Tag = "div", className, children, ...rest }: EyebrowProps) {
  // Written before `className` so a call site that names no colour renders the
  // byte-for-byte class list it rendered before this fix.
  const fallback = className && NAMES_A_COLOUR.test(className) ? undefined : "text-dim";
  return (
    <Tag className={cx("eyebrow", fallback, className)} {...rest}>
      {children}
    </Tag>
  );
}
