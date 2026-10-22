/**
 * `/suggestions` — the suggestion box, public to read.
 *
 * One of the two pages on this site a signed-out person can see anything on,
 * and deliberately so. The count is the point: somebody deciding what to run
 * next wants to see that eleven people want a REPO night, and the eleven want
 * to see it too. Hiding that behind a sign-in would make the list useless to
 * exactly the people it is meant to persuade.
 *
 * Voting still needs an account — see `src/lib/suggestions.ts`.
 */

import AppHeader from "@/components/AppHeader";
import SuggestionBox from "@/components/suggestions/SuggestionBox";
import { Page, PageHeader, Section } from "@/components/ui";
import { getCurrentUser } from "@/lib/session-guards";
import { listSuggestions } from "@/lib/suggestions";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Suggestions · Job Centre Events",
};

export default async function SuggestionsPage() {
  const user = await getCurrentUser();
  const suggestions = await listSuggestions(user?.id ?? null);

  const wanted = suggestions.filter((row) => row.status === "open").length;

  return (
    <div className="min-h-screen">
      <AppHeader />

      {/* `reading`: one column of suggestions, each a line of text and a vote. */}
      <Page width="reading" className="space-y-6">
        <PageHeader
          eyebrow="Job Centre · Suggestions"
          title="What should we run?"
          intro="Anything the community fancies playing. Vote on the ones you would turn up to — the count is what an organiser looks at when they are deciding what to put on next, so an idea with nobody behind it is genuinely useful information too."
        />

        <Section
          first
          icon="list"
          title={wanted > 0 ? `${wanted} open` : "The box"}
          description="Sorted by how many people want it. Things already run or ruled out drop to the bottom."
        >
          <SuggestionBox
            initial={suggestions}
            signedIn={Boolean(user)}
            isAdmin={Boolean(user?.isAdmin)}
            viewerId={user?.id ?? null}
          />
        </Section>
      </Page>
    </div>
  );
}
