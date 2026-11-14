import AdminNavLinks from "./AdminNavLinks";
import { sectionsFor } from "./sections";
import { holderFor } from "@/lib/permissions";
import { getCurrentUser } from "@/lib/session-guards";

/**
 * The admin bar, and the one question that decides what is in it (R-265 /
 * UC-56 2): what do the signed-in member's powers reach?
 *
 * A server component that asks, around a client one that draws - `SiteNav` and
 * `SiteNavLinks` over again, and for the reason given there: the rule about
 * what exists is the server's, the rule about where you are is the browser's.
 * Asking here rather than in each page keeps the rule in one place instead of
 * threading it through thirteen `<AdminNav />`s, any one of which could forget.
 *
 * The powers are read on this request (`holderFor`), so a section stops being
 * drawn on the first page load after its power is taken away (UC-56 3b).
 *
 * ## It is not what keeps anybody out
 *
 * `getCurrentUser` identifies and refuses nobody, which is right for a row of
 * links and would be wrong for anything else. Every page this bar is drawn on
 * has already awaited a guard of its own before rendering it, and every page
 * it links to does the same. A link that is not drawn is a courtesy to a
 * holder who would only be turned away; the page turning them away is the
 * protection. See `sections.ts`.
 *
 * Every one of these also lives in the account menu, which is where they are
 * reachable from on a narrow screen — the row hides below `lg` rather than
 * collapsing into a hamburger, per §4. `NavMenu` filters its entries through
 * the same `sectionsFor`, and `__tests__/holder-nav.test.ts` pins the two
 * lists to each other.
 */
export default async function AdminNav({ className }: { className?: string }) {
  const user = await getCurrentUser();
  if (!user) return null;
  return <AdminNavLinks sections={sectionsFor(await holderFor(user))} className={className} />;
}
