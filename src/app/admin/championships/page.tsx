/**
 * `/admin/championships` — every season, including the hidden ones (UC-31 2).
 *
 * The list half of Task 39's "list + editor". Hidden seasons are the point:
 * this is the only read in the codebase that returns them, and an admin has
 * nothing to work on until they can see one.
 *
 * Guarded by `requireAdmin()`, which sends a signed-in non-admin to `/signin`
 * with `?error=admin-only` rather than to a 403.
 */

import Link from "next/link";
import AppHeader from "@/components/AppHeader";
import AdminNav from "@/components/admin/AdminNav";
import { EmptyState, Eyebrow, Page, Section, SectionList, StatTile, StatusPill } from "@/components/ui";
import { listChampionships } from "@/lib/championships";
import { requireAdmin } from "@/lib/session-guards";
import NewChampionship from "./NewChampionship";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Championships · Job Centre Events",
};

/** A season's status in the pill vocabulary the rest of the admin already uses. */
const PILL = {
  hidden: { tone: "draft", label: "Hidden" },
  published: { tone: "open", label: "Published" },
  closed: { tone: "complete", label: "Finished" },
} as const;

/** "March 2026 to November 2026", or nothing while the months are undecided. */
function months(from: string | null, to: string | null): string | null {
  const month = (value: string) =>
    new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  if (from && to) return `${month(from)} to ${month(to)}`;
  if (from) return `From ${month(from)}`;
  if (to) return `Until ${month(to)}`;
  return null;
}

export default async function AdminChampionshipsPage() {
  await requireAdmin();
  const seasons = await listChampionships();

  const published = seasons.filter((season) => season.status === "published").length;
  const finished = seasons.filter((season) => season.status === "closed").length;

  return (
    <div className="min-h-screen">
      <AppHeader>
        <AdminNav />
      </AppHeader>

      <Page className="space-y-6">
        <header className="flex flex-wrap items-end gap-6">
          <div>
            <Eyebrow className="mb-2">Admin · Championships</Eyebrow>
            <h1 className="font-display text-36 leading-none">Championships</h1>
            <p className="mt-3 max-w-xl text-14 leading-relaxed text-muted">
              A season of events across different games, with one running score. Set the
              points table up in private, publish it when it is ready, and close it when the
              last event has been scored — a finished season keeps its page for good.
            </p>
          </div>

          <div className="ml-auto flex gap-8">
            <StatTile label="Running" value={published} />
            <StatTile
              label="Finished"
              value={finished}
              valueClassName={finished > 0 ? "text-body" : "text-muted"}
            />
          </div>
        </header>

        <SectionList>
          <NewChampionship />

          <Section icon="list" title="Every season" description="Newest first.">
            {seasons.length === 0 ? (
              <EmptyState>
                No seasons yet. Start one above — nobody sees it until you publish it.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-hair">
                {seasons.map((season) => {
                  const pill = PILL[season.status];
                  const when = months(season.runsFrom, season.runsTo);
                  return (
                    <li key={season.id}>
                      <Link
                        href={`/admin/championships/${season.id}`}
                        className="flex flex-wrap items-center gap-x-4 gap-y-1 py-4 transition-colors hover:text-chalk"
                      >
                        <span className="min-w-0 flex-1 text-16 text-chalk">{season.name}</span>
                        {when && <span className="text-13 text-muted">{when}</span>}
                        <span className="text-13 text-muted">
                          {season.pointsTable.length} places
                        </span>
                        <StatusPill status={pill.tone} label={pill.label} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>
        </SectionList>
      </Page>
    </div>
  );
}
