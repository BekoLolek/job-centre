/**
 * Reading a rendered `MyEventCard`, for the two files that assert about one.
 *
 * `attendance-lock.test.ts` and `answers-lock.test.ts` hold three deadlines
 * apart — the attendance answer (R-200, UC-13 7), the answers (UC-13 4a), and
 * withdrawing, which closes on neither (R-54, UC-13 4a / E3). Each file
 * asserts that the way out survives its own lock, so each needs the same
 * question answered: **is the withdraw control actually on the card?**
 *
 * They answered it twice, and one of the two answers was wrong — which is why
 * this file exists rather than a second copy of the helper.
 *
 * Plain string functions over markup the test files render themselves, so the
 * component import, and the mocks it needs, stay in the test file.
 */

/** The rendered card as a reader sees it: no tags, no HTML entities. */
export function readable(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|\s+/g, " ");
}

/**
 * Is the withdraw **control** on the card?
 *
 * Not `readable(markup).includes("Withdraw")`, which is the trap this helper
 * exists to avoid and which both files fell into in turn: the card's own copy
 * says "Withdrawing still works" a few lines above the button, so the naive
 * assertion passes with the button gone. It reads as the strongest test in the
 * file and cannot fail — `attendance-lock.test.ts` only ever failed open
 * because its fixture left `answersEditable` true.
 *
 * So this looks for the button element *and* for the sentence that belongs to
 * the withdraw block alone — the one that says what withdrawing costs, which
 * differs per status — and both have to be there.
 */
export function offersWithdraw(markup: string): boolean {
  const hasButton = /<button[^>]*>Withdraw<\/button>/.test(markup);
  const text = readable(markup);
  const hasItsOwnCopy =
    text.includes("this just frees the seat") ||
    text.includes("takes your seat the moment you withdraw") ||
    text.includes("You would leave the queue") ||
    text.includes("off the organisers' list");
  return hasButton && hasItsOwnCopy;
}
