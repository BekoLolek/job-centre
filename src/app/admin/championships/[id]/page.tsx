/**
 * `/admin/championships/[id]` — one season's editor (UC-31, UC-35).
 *
 * One read builds the whole screen and one save writes it back, because a
 * season's identity and its scoring rules are one decision rather than a
 * fortnight's worth of separate ones — see the note in `ChampionshipEditor`.
 *
 * Nothing here decides anything. What the editor may do with a closed season,
 * and what a points table may look like, are `src/lib/championship-policy.ts`'s
 * and are asked again by the write.
 */

import { notFound } from "next/navigation";
import AppHeader from "@/components/AppHeader";
import AdminNav from "@/components/admin/AdminNav";
import ChampionshipEditor from "@/components/admin/ChampionshipEditor";
import { Button, Eyebrow, Page } from "@/components/ui";
import { getChampionship } from "@/lib/championships";
import { requireAdmin } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const season = await getChampionship(id);
  return { title: season ? `${season.name} · Admin` : "Championship · Admin" };
}

export default async function AdminChampionshipPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;

  const season = await getChampionship(id);
  if (!season) notFound();

  return (
    <div className="min-h-screen">
      <AppHeader>
        <AdminNav />
      </AppHeader>

      <Page className="space-y-6">
        <header className="flex flex-wrap items-end gap-6">
          <div className="min-w-0">
            <Eyebrow className="mb-2">Admin · Championships</Eyebrow>
            <h1 className="font-display text-36 leading-none">{season.name}</h1>
          </div>
          <Button size="sm" href="/admin/championships" className="ml-auto">
            All seasons
          </Button>
        </header>

        <ChampionshipEditor
          view={{
            id: season.id,
            name: season.name,
            description: season.description,
            status: season.status,
            runsFrom: season.runsFrom,
            runsTo: season.runsTo,
            pointsTable: season.pointsTable,
            participationPoints: season.participationPoints,
            countBest: season.countBest,
          }}
        />
      </Page>
    </div>
  );
}
