/**
 * The Hands sheet, decided before it is drawn (R-240, R-241, R-243 / UC-47 2,
 * 3, 4, 2a, 3a, 4a).
 *
 * A manager opens the Hands tab to answer one question — *has everyone
 * drawn?* — and this module is that answer as plain data: which rows the tab
 * shows, in what order, and what each one says. The tab then does nothing but
 * draw what {@link handSheet} returns.
 *
 * ## Why this is a function rather than a few lines in the tab
 *
 * For the reason `standingOn` in `src/components/admin/events/tabs.ts` and
 * `roundScoringLosses` in `src/lib/events-policy.ts` are: the same lines
 * inside the component could not be mutation-proved in a node suite with
 * nothing to click, and these lines decide what a manager believes about who
 * has drawn. A sheet that quietly filtered an undrawn seat out, or dropped the
 * hand of somebody who withdrew, would read as a clean night — so each of
 * those is pulled out here and asserted directly, with the mutation named in
 * the test built to die to it.
 *
 * ## No value imports, on purpose
 *
 * The tab is a `"use client"` panel and the page that feeds it is a server
 * file, so this module is read by both sides. `client-boundary.test.ts` says
 * why that is a runtime contract and not a type: a value crossing it fails on
 * the deployed page and nothing else catches it. Every import here is
 * `import type` — erased before either runtime sees it — and
 * `hands-sheet.test.ts` asserts that on the file's text, the way the boundary
 * sweep does. In particular `@/lib/hero-hands` is named only for
 * {@link StoredHand}; a value from it would carry `@/db` into the browser.
 *
 * ## The hands arrive as a record keyed by user id
 *
 * {@link SheetHands} is declared here rather than imported, the way
 * `src/app/events/[slug]/draw/draw.ts` declares `StoredHandReader` to
 * `hero-hands.ts`'s published contract: the per-event read (`handsFor`) is
 * being written alongside this, and this module should depend on the one fact
 * it needs — a hand per user id — rather than on that function's signature.
 * A record because that is how every keyed-by-id thing in `ApplicantView`
 * arrives (`availability`, `answerConfirmedAt`), and because the page will
 * hand it to a client panel as a prop, which a `Map` does not survive.
 *
 * ## It takes the whole application list and finds the seats itself
 *
 * `handSheet` takes `getApplicationsForEvent`'s rows as they come and keeps
 * only the accepted ones as seats, rather than asking the caller to filter
 * first. Two reasons, and either alone would do:
 *
 *  1. "A pending application is not a seat" is then a rule *this* module
 *     holds and the suite can break — the same line `holdsSeat` in `draw.ts`
 *     draws, in the same words, and for the same reason: a pending row is a
 *     decision somebody has yet to take and a waitlisted one is a queue place.
 *     A caller-side filter would be a rule nobody here could prove.
 *  2. The rows that are *not* seats are what names a former holder (UC-47
 *     3a). Withdrawing keeps the application row with `status: "withdrawn"`
 *     (`withdrawApplication` in `events.ts`), so the withdrawn player's
 *     `member` is right there in the list — and a caller that filtered to
 *     accepted before calling would have thrown away the only thing that can
 *     put a name on the row.
 *
 * ## Ordering is the caller's, and nothing here re-sorts
 *
 * Seats keep the order they arrive in, which is `getApplicationsForEvent`'s —
 * accepted first, then by submission time — so the Hands tab reads in the same
 * order as the Applicants tab beside it rather than inventing a second
 * ordering nobody asked for. Former holders come after every seat, in the
 * order their hands arrive. `hands-sheet.test.ts` hands in seats in an order
 * that is neither alphabetical nor by whether they have drawn, so any sort
 * moves somebody and dies.
 *
 * ## What this module does not do
 *
 * It does not format `dealtAt` — that is a `Date`, and the screen formats it
 * in the viewer's zone. It does not reorder the nine within a hand: a
 * {@link StoredHand}'s `heroes` is built by `hero-hands.ts` in `HERO_ROLES`
 * order, three to a role, which is the order the cards turned in (R-241), and
 * the record is carried through untouched. It does not deal, clear or reroll
 * (R-212: the draw happens once and stands), and it does not look across
 * events.
 */

import type { ApplicantView } from "@/lib/events";
import type { StoredHand } from "@/lib/hero-hands";

/**
 * One application as the sheet needs it: whose, whether it is a seat, and the
 * member to put a name to the row. `ApplicantView` satisfies it; the other
 * forty fields are nothing a row shows.
 */
export type SheetApplicant = Pick<ApplicantView, "userId" | "status" | "member">;

/** Every stored hand for one event, keyed by user id. See the module note. */
export type SheetHands = Readonly<Record<string, StoredHand>>;

/** A seat: who holds it, and the nine they hold — or null when they have not drawn (UC-47 3). */
export type SeatRow = {
  userId: string;
  member: SheetApplicant["member"];
  hand: StoredHand | null;
};

/**
 * A hand whose holder no longer holds a seat (UC-47 3a). `member` is null when
 * the user has no application row at all to name them from — which nothing on
 * the site produces, since withdrawing keeps the row, but a sheet read from a
 * table should not throw over a row it did not expect.
 */
export type FormerRow = {
  userId: string;
  member: SheetApplicant["member"] | null;
  hand: StoredHand;
};

/**
 * The whole tab, as data.
 *
 * `kind` is the one of three sentences the screen opens with (UC-47 2a, 4a),
 * decided here rather than derived from `seats.length` and `drawn` in the
 * component, for the reason the module note gives. Every other field means
 * the same thing in every state — `seats` is empty under `no_seats`, `drawn`
 * is zero under `nobody_drawn`, `former` may hold rows under any of the three
 * — so this is one shape rather than a union: there is no field a state must
 * not read.
 */
export type HandSheet = {
  /** UC-47 4a: nothing is accepted, so there is no sheet to draw — only what `former` holds. */
  kind: "no_seats" | "nobody_drawn" | "drawing";
  /** UC-47 2: every seat, in the order it arrived. */
  seats: SeatRow[];
  /** UC-47 3a: after every seat, in the order the hands arrived. */
  former: FormerRow[];
  /** UC-47 4: how many of `seats` have drawn. Hands in `former` are not counted. */
  drawn: number;
};

/**
 * The rows the Hands tab draws, from the applications as the Applicants tab
 * lists them and every hand stored for the event.
 *
 * A seat is an accepted application (the module note says why this is decided
 * here). The drawn count covers seats only: a withdrawn player's hand is a
 * record, not a seat that has drawn.
 */
export function handSheet(applicants: readonly SheetApplicant[], hands: SheetHands): HandSheet {
  const seats: SeatRow[] = applicants
    .filter((applicant) => applicant.status === "accepted")
    .map((applicant) => ({
      userId: applicant.userId,
      member: applicant.member,
      hand: hands[applicant.userId] ?? null,
    }));

  const seated = new Set(seats.map((row) => row.userId));
  const former: FormerRow[] = Object.entries(hands)
    .filter(([userId]) => !seated.has(userId))
    .map(([userId, hand]) => ({
      userId,
      member: applicants.find((applicant) => applicant.userId === userId)?.member ?? null,
      hand,
    }));

  const drawn = seats.filter((row) => row.hand !== null).length;

  const kind = seats.length === 0 ? "no_seats" : drawn === 0 ? "nobody_drawn" : "drawing";

  return { kind, seats, former, drawn };
}
