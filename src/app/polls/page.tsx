/**
 * `/polls` — what the community was asked, and what it said.
 *
 * Public to read, like the suggestion box. The counts and the names are the
 * feature, so hiding them behind a sign-in would leave the page saying nothing
 * to exactly the people a poll is meant to inform.
 *
 * Voting needs an account. Posting needs an admin.
 */

import AppHeader from "@/components/AppHeader";
import PollList from "@/components/polls/PollList";
import { Page, PageHeader, Section } from "@/components/ui";
import { listPolls } from "@/lib/polls";
import { getCurrentUser } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Polls · Job Centre Events",
};

export default async function PollsPage() {
  const user = await getCurrentUser();
  const polls = await listPolls(user?.id ?? null);

  const open = polls.filter((poll) => !poll.closed).length;

  return (
    <div className="min-h-screen">
      <AppHeader />

      {/* `reading`: one column of poll questions and their options. */}
      <Page width="reading" className="space-y-6">
        <PageHeader
          eyebrow="Job Centre · Polls"
          title="Polls"
          intro={
            <>
              Open, like Discord&rsquo;s: the counts are public and so is who voted for what.
              That is deliberate — a poll about which night suits is answered far better by
              &ldquo;Thursday: Ada, Bo, Cy&rdquo; than by &ldquo;Thursday: 3&rdquo;, because
              the next question is always who. Vote accordingly.
            </>
          }
        />

        <Section
          first
          icon="list"
          title={open > 0 ? `${open} open` : "Polls"}
          description="Open ones first. A closed poll keeps its result exactly as it was — it cannot be edited afterwards."
        >
          <PollList
            polls={polls}
            signedIn={Boolean(user)}
            isAdmin={Boolean(user?.isAdmin)}
          />
        </Section>
      </Page>
    </div>
  );
}
