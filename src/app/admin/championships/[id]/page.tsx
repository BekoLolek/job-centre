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
import { Button, Page, PageHeader } from "@/components/ui";
import { getChampionship, listCountingEvents } from "@/lib/championships";
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

  const counting = await listCountingEvents(season.id);

  return (
    <div className="min-h-screen">
      <AppHeader admin>
        <AdminNav />
      </AppHeader>

      {/* `standard`: the points-table editor, two `min-w-[10rem]` fields wide. */}
      <Page className="space-y-6">
        <PageHeader
          eyebrow="Admin · Seasons"
          title={season.name}
          aside={
            <Button size="sm" href="/admin/championships">
              All seasons
            </Button>
          }
        />

        <ChampionshipEditor
          counting={counting}
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
