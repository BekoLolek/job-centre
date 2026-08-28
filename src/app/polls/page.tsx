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
import { Eyebrow, Section } from "@/components/ui";
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
      <AppHeader section="Polls" />

      <main className="mx-auto max-w-[860px] px-4 py-8 sm:px-6">
        <header className="mb-2">
          <Eyebrow className="mb-2">Job Centre · Polls</Eyebrow>
          <h1 className="text-4xl">Polls</h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            Open, like Discord&rsquo;s: the counts are public and so is who voted for what.
            That is deliberate — a poll about which night suits is answered far better by
            &ldquo;Thursday: Ada, Bo, Cy&rdquo; than by &ldquo;Thursday: 3&rdquo;, because the
            next question is always who. Vote accordingly.
          </p>
        </header>

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
      </main>
    </div>
  );
}
