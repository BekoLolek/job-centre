import { cx } from "./cx";

/** Use to stand a team or person next to their name — initials on a hairline disc. */

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
  size?: AvatarSize;
  className?: string;
};

export default function Avatar({ name, size = "md", className }: AvatarProps) {
  return (
    <span
      title={name}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-hair bg-raised font-mono uppercase tracking-wider text-muted",
        SIZE[size],
        className
      )}
    >
      {initials(name)}
    </span>
  );
}
