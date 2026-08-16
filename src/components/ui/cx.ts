/** Joins class names, dropping anything falsy — the whole of our "utility" toolkit. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
