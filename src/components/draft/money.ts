/**
 * Money, said the same way everywhere.
 *
 * `n.toLocaleString("en-US")` is currently copy-pasted into five components
 * (`BidPanel`, `CaptainsRail`, `ObserverPanel`, `AdminControls`, `DraftBoard`).
 * It is one line, which is exactly why it drifted: the moment one of them adds
 * a currency symbol or drops the separator, the same balance reads two ways on
 * one screen. So it lives here, and both the admin's setup and the live room
 * import it rather than retyping it.
 *
 * The locale is pinned rather than left to the browser on purpose. A figure
 * formatted by the server and the same figure formatted by the client have to
 * agree character for character or React reports a hydration mismatch, and the
 * server's locale is whatever the host happens to be set to.
 */

/** `1000` → `"1,000"`. Fractions are not money here; every price is a whole number. */
export function formatMoney(amount: number): string {
  return Math.trunc(amount).toLocaleString("en-US");
}

/**
 * A signed figure, for a change rather than a total — `"+250"`, `"−40"`.
 *
 * Uses a real minus sign (U+2212) rather than a hyphen, because the numerals
 * are tabular and a hyphen is not: a column of hyphen-minus figures does not
 * line up with a column of plus ones.
 */
export function formatDelta(amount: number): string {
  const rounded = Math.trunc(amount);
  if (rounded < 0) return `−${formatMoney(-rounded)}`;
  return `+${formatMoney(rounded)}`;
}
