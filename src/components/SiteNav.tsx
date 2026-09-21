import SiteNavLinks from "./SiteNavLinks";
import { currentSeason } from "@/lib/championship-season";

/**
 * The site links in the top bar, and the one question that decides how many
 * there are.
 *
 * **The championship item exists only while a season is published** (UC-34 1a).
 * Not greyed out, not linking to an empty page — absent, because a navigation
 * item is a promise that there is something at the other end of it, and before
 * the first season is published there is not. A hidden season does not count:
 * it is an admin's draft, and R-189 says a visitor must not learn it exists,
 * which includes learning it from the shape of the top bar.
 *
 * So this is a server component that asks, and the row itself is
 * `SiteNavLinks` — a client one, because which item is *current* is a question
 * about the URL in the browser. The split is the whole reason this file is two
 * lines: the rule about what exists is the server's, the rule about where you
 * are is the client's, and neither has to know the other's answer.
 *
 * `AppHeader` renders this on every page, so the query would otherwise run on
 * every page. It is one indexed row off `championships_status_idx`, and the
 * alternative — threading *the rule* through `AppHeader` from thirty-odd routes
 * — would put it in thirty-odd places instead of this one. On the pages that
 * ask more than once in a request, `currentSeason` is memoized per request and
 * the extra asks cost nothing; see the note at the top of
 * `@/lib/championship-season`.
 *
 * ## Except under `/admin`, where the answer is thrown away
 *
 * `SiteNavLinks` renders nothing at all on an admin route — the bar has no room
 * for two navs — so eleven admin pages were paying for a row that was never
 * drawn. `admin` is how the page says it is one of those, and it is a *hint,
 * not the rule*: the rule is still `SiteNavLinks`', decided from the path in
 * the browser. Getting the hint wrong on an admin page costs nothing, because
 * the links are not rendered either way; leaving it off costs the query, which
 * is what it cost before.
 */
export default async function SiteNav({
  /** True on `/admin` routes, where the links stand down and nobody needs the answer. */
  admin = false,
}: {
  admin?: boolean;
}) {
  const championship = admin ? false : (await currentSeason()) !== null;
  return <SiteNavLinks championship={championship} />;
}
