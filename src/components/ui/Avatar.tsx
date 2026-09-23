"use client";

import { useState } from "react";
import { cx } from "./cx";

/**
 * Use to stand a team or person next to their name — their picture when there
 * is one, otherwise initials on a hairline disc.
 *
 * The picture is a plain `<img>`, as on /me/profile: next/image would want the
 * Discord CDN in a remotePatterns allowlist for a 128px avatar. A picture that
 * fails to load falls back to the initials rather than a broken-image icon.
 *
 * **Decoration, in both branches** (plan Task 46). An avatar is only ever set
 * beside the name it stands for, so whatever it contributes to the accessible
 * tree is the name said a second time. The initials branch is the loud one —
 * they are real text, so a championship row announced as "FD Faro Delgado",
 * and the same doubling ran through the draft room, every roster, the
 * applicant lists and the player profiles. The picture branch already carried
 * `alt=""`, but not harmlessly: an `<img>` with an empty `alt` *and* a `title`
 * is not mapped to presentation — the `title` becomes its accessible name, so
 * that branch said the name twice as well. `aria-hidden` settles both, because
 * it drops the element and its subtree whatever `alt`, `title` or text is on
 * it. The `title` stays: it is a hover affordance for sighted readers and no
 * longer reaches assistive tech.
 *
 * This is unconditional rather than a `decorative` prop because every call site
 * was checked and every one of them prints the name: the accepted-roster list
 * (/events/[slug]), /me, /me/profile, /players/[handle], /signin, the admin
 * applicant table and members list, the championship podium and standings, the
 * draft's PlayerChip, and NavMenu. NavMenu was the one that had to move: its
 * name was `hidden sm:block`, i.e. `display:none` and so out of the tree below
 * the `sm` breakpoint, which would have left the account button with no name at
 * all on a phone. `aria-hidden` cannot be made responsive, so the name there is
 * `sr-only` below `sm` instead — the label belongs to the button, not to the
 * decoration inside it. Any future call site that shows an avatar *alone* owes
 * its control a label for the same reason.
 */

export type AvatarSize = "sm" | "md" | "lg";

const SIZE: Record<AvatarSize, string> = {
  sm: "h-6 w-6 text-11",
  md: "h-8 w-8 text-11",
  lg: "h-10 w-10 text-12",
};

/** First letter of the first two words, so "Team lolek" reads as TL. */
function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("");
}

export type AvatarProps = {
  name: string;
  /** Image URL, e.g. the member's Discord avatar. Initials when absent or broken. */
  src?: string | null;
  size?: AvatarSize;
  className?: string;
};

export default function Avatar({ name, src, size = "md", className }: AvatarProps) {
  const [failed, setFailed] = useState<string | null>(null);

  if (src && failed !== src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        aria-hidden
        title={name}
        onError={() => setFailed(src)}
        // Both are needed. `onError` catches a failure after hydration, but the
        // page is server-rendered, so the browser may have requested — and
        // failed — the image before React attached that listener, and an
        // `error` event neither bubbles nor gets replayed. The ref asks the
        // element itself: finished loading with no pixels means it is broken.
        ref={(node) => {
          if (node?.complete && node.naturalWidth === 0) setFailed(src);
        }}
        className={cx("shrink-0 rounded-full border border-hair bg-raised", SIZE[size], className)}
      />
    );
  }

  return (
    <span
      aria-hidden
      title={name}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-hair bg-raised font-mono uppercase text-muted",
        SIZE[size],
        className
      )}
    >
      {initials(name)}
    </span>
  );
}
