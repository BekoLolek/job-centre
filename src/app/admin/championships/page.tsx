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
import {
  EmptyState,
  Page,
  PageHeader,
  Section,
  SectionList,
  StatTile,
  StatusPill,
} from "@/components/ui";
import { seasonMonths } from "@/lib/championship-policy";
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

export default async function AdminChampionshipsPage() {
  await requireAdmin();
  const seasons = await listChampionships();

  const published = seasons.filter((season) => season.status === "published").length;
  const finished = seasons.filter((season) => season.status === "closed").length;

  return (
    <div className="min-h-screen">
      <AppHeader admin>
        <AdminNav />
      </AppHeader>

      {/* `standard`: a create form and a list of seasons, one line each. */}
      <Page className="space-y-6">
        <PageHeader
          /* `Seasons` is what `ADMIN_SECTIONS` calls this link in the bar. */
          eyebrow="Admin · Seasons"
          title="Championships"
          intro="A season of events across different games, with one running score. Set the points table up in private, publish it when it is ready, and close it when the last event has been scored — a finished season keeps its page for good."
          aside={
            <>
              <StatTile label="Running" value={published} />
              <StatTile
                label="Finished"
                value={finished}
                valueClassName={finished > 0 ? "text-body" : "text-muted"}
              />
            </>
          }
        />

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
                  const when = seasonMonths(season.runsFrom, season.runsTo);
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
