/**
 * "1 question", "3 questions" — the counted-noun label, said properly.
 *
 * Small, but it earns its place: these counts appear a dozen times across the
 * admin screen, and "1 questions · 1 answers" is the kind of thing that quietly
 * makes a page look unfinished.
 *
 * @param one the singular noun; the plural defaults to `one + "s"`.
 */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
