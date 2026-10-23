/**
 * `/admin/games` — where the admin decides what gets asked
 * (docs/platform-plan.md §13 Q4, §14).
 *
 * The answer to "as an admin I want to add a new game and say what info I want
 * from players". Everything here writes rows: a game is a row, a question is a
 * row, a rank ladder is a jsonb array on the game. Nothing about adding REPO
 * and asking two questions about it touches code, which is the whole reason
 * `profile_fields.game_id` points at a table instead of being an enum.
 *
 * Guarded by `requireAdmin()`, which sends a signed-in non-admin to `/signin`
 * with `?error=admin-only` rather than to a 403 — they are not being asked to
 * authenticate again, they are being told the page is not theirs.
 */

import AppHeader from "@/components/AppHeader";
import AdminNav from "@/components/admin/AdminNav";
import GamesManager from "@/components/admin/GamesManager";
import { Page, PageHeader, StatTile } from "@/components/ui";
import { loadAdminGames } from "@/lib/admin-games";
import { listHeroesByGame } from "@/lib/heroes";
import { requireAdmin } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Games and questions · Job Centre Events",
};

export default async function AdminGamesPage() {
  await requireAdmin();
  /*
   * Two reads, in parallel. The hero rows are a second table rather than part
   * of `AdminGamesView` because `loadAdminGames` belongs to the questions half
   * of this screen and the heroes belong to the draw (R-214 / UC-40); keeping
   * them apart means the hero screen can be read and tested without the answer
   * counts, and neither loader grew a column for the other.
   */
  const [view, heroesByGame] = await Promise.all([loadAdminGames(), listHeroesByGame()]);

  const questions =
    view.globalFields.length +
    view.games.reduce((total, game) => total + game.fields.length, 0);
  const answers =
    view.globalAnswers + view.games.reduce((total, game) => total + game.answers, 0);
  const active = view.games.filter((game) => game.isActive).length;

  return (
    <div className="min-h-screen">
      <AppHeader admin>
        <AdminNav />
      </AppHeader>

      {/* `standard`: a list of games, each with its questions under it. */}
      <Page className="space-y-6">
        <PageHeader
          eyebrow="Admin · Games"
          /*
           * Sentence case. It was the only uppercase `<h1>` on the site, and
           * `globals.css` is explicit that the wordmark is the one drawn mark
           * and nothing else on the page shouts.
           */
          title="Games and questions"
          intro={
            <>
              Every question a member is asked lives here. Add a game, give it the questions
              you want answered, and it appears on everyone&apos;s profile straight away —
              that answer then pre-fills every application, which is the bit Google Forms
              could never do.
            </>
          }
          aside={
            <>
              <StatTile label="Games" value={`${active}/${view.games.length}`} />
              <StatTile label="Questions" value={questions} />
              <StatTile
                label="Answers"
                value={answers}
                valueClassName={answers > 0 ? "text-body" : "text-muted"}
              />
            </>
          }
        />

        <GamesManager view={view} heroesByGame={heroesByGame} />

        <p className="pb-4 text-center text-12 text-muted">
          Reordering here reorders the member&apos;s profile. Deactivating hides a game
          without losing a single answer.
        </p>
      </Page>
    </div>
  );
}
