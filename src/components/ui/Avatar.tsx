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
 */

export type AvatarSize = "sm" | "md" | "lg";

const SIZE: Record<AvatarSize, string> = {
  sm: "h-6 w-6 text-[9px]",
  md: "h-8 w-8 text-[10px]",
  lg: "h-10 w-10 text-xs",
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
