import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/**
 * The small quiet label that titles blocks across the site.
 *
 * `.eyebrow` deliberately declares no `color` — a label has no colour, the
 * thing it labels does — so this component supplies `text-dim` as the default.
 * Pass any `text-*` colour to change it; the default is **dropped** when you
 * do, rather than left to argue with yours in the cascade. Pass
 * `text-inherit` for a label that should take the colour of whatever it sits
 * in — a row that is already tinted, an `Alert` whose tone is chosen at
 * runtime — which is the design rule above said out loud rather than left to
 * the absence of a class.
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
 * it. The overlay tokens are in the list even though `design-tokens.test.ts`
 * bans them as text — refusing a class is that file's job, and leaving one out
 * here would not refuse it, it would render it dim.
 *
 * `inherit`, `current` and `transparent` are here as well, and they are not
 * palette tokens: they are the three colourless keywords Tailwind keeps, and
 * `text-inherit` is how a label says it takes its colour from its context.
 * Without them the component would add `text-dim` beside a `text-inherit` and
 * the winner would be the alphabet again — which happens to favour `inherit`,
 * and a fix that works by luck of spelling is the defect this file is about.
 *
 * The list is checked against the theme rather than trusted — the guard test
 * walks every colour the config defines, and every `text-*` rule the build
 * really emits, and fails if one of them is missing here. It fails too if a
 * font-size step is ever named after a colour.
 */
export const NAMES_A_COLOUR =
  /\btext-(?:body|chalk|current|dim|edge|flare|hair|hot|inherit|ink|muted|overlay|panel|raised|success|sunken|transparent|union)\b/;

/**
 * `dt` and `button` are here for what they are, not as a convenience.
 *
 * A `dt` *is* the label of the `dd` beside it, which is this component's whole
 * job; four of the site's definition lists were writing `.eyebrow` by hand for
 * exactly that. And `button` is the dismiss control on an `Alert` — an eyebrow
 * that happens to be pressable. Both were on Task 69's list of sites the
 * component could not express.
 */
type EyebrowTag = "div" | "span" | "p" | "dt" | "button" | "h1" | "h2" | "h3" | "h4";

export type EyebrowProps = {
  /**
   * Element to render — `div` by default; `span` inline, `dt` in a definition
   * list, `button` for a pressable label, `h2`/`h3` for headings.
   */
  as?: EyebrowTag;
  className?: string;
  children?: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "className" | "children">;

export default function Eyebrow({ as: Tag = "div", className, children, ...rest }: EyebrowProps) {
  // Written before `className` so a call site that names no colour renders the
  // byte-for-byte class list it rendered before this fix.
  const fallback = className && NAMES_A_COLOUR.test(className) ? undefined : "text-dim";
  return (
    <Tag
      // A `<button>` with no `type` submits the form it is standing in, and an
      // eyebrow is a label — it is never the thing that submits. Written here
      // rather than asked of every call site, because the default is the bug.
      type={Tag === "button" ? "button" : undefined}
      className={cx("eyebrow", fallback, className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}
