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
import { Eyebrow, StatTile } from "@/components/ui";
import { loadAdminGames } from "@/lib/admin-games";
import { requireAdmin } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Games and questions · Job Centre Events",
};

export default async function AdminGamesPage() {
  await requireAdmin();
  const view = await loadAdminGames();

  const questions =
    view.globalFields.length +
    view.games.reduce((total, game) => total + game.fields.length, 0);
  const answers =
    view.globalAnswers + view.games.reduce((total, game) => total + game.answers, 0);
  const active = view.games.filter((game) => game.isActive).length;

  return (
    <div className="min-h-screen">
      <AppHeader section="ADMIN">
        <AdminNav />
      </AppHeader>

      <main className="mx-auto max-w-[1000px] space-y-6 px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-end gap-6">
          <div>
            <Eyebrow className="mb-2">Admin · Profiles</Eyebrow>
            <h1 className="font-display text-4xl leading-none">
              GAMES &amp; QUESTIONS
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
              Every question a member is asked lives here. Add a game, give it the questions
              you want answered, and it appears on everyone&apos;s profile straight away —
              that answer then pre-fills every application, which is the bit Google Forms
              could never do.
            </p>
          </div>

          <div className="ml-auto flex gap-8">
            <StatTile label="Games" value={`${active}/${view.games.length}`} />
            <StatTile label="Questions" value={questions} />
            <StatTile
              label="Answers"
              value={answers}
              valueClassName={answers > 0 ? "text-signal" : "text-muted"}
            />
          </div>
        </header>

        <GamesManager view={view} />

        <p className="pb-4 text-center text-xs text-muted">
          Reordering here reorders the member&apos;s profile. Deactivating hides a game
          without losing a single answer.
        </p>
      </main>
    </div>
  );
}
