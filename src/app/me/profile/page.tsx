/**
 * `/me/profile` — the member profile (docs/platform-plan.md §4, §7).
 *
 * The page that finally kills the Google Form. Everything a member used to
 * retype for every single event — rank, roles, in-game name, which Jackbox
 * packs they own — is answered once here and kept, so applying to the next
 * event becomes "check this is still right, tap the days you can make".
 *
 * Two halves:
 *
 *  1. **Identity**, read-only, straight from Discord. Nothing to edit — the
 *     avatar and the name are Discord's, refreshed on every sign-in.
 *  2. **A section per active game**, each rendering that game's admin-defined
 *     `profileFields` in `sort` order, plus the global section for questions
 *     asked of everybody. Every one of them saves itself; see
 *     `ProfileSection`.
 *
 * The page is a server component: it reads the rows and hands each section to a
 * client component that owns only its own inputs. Nothing about the question
 * set is hardcoded here, which is the entire point of §14 — an admin adding
 * "REPO" with two questions changes this page without touching it.
 */

import AppHeader from "@/components/AppHeader";
import ProfileSection from "@/components/profile/ProfileSection";
import { Alert, Avatar, Badge, Eyebrow, Panel, Section, StatTile } from "@/components/ui";
import { loadProfile } from "@/lib/profile";
import { requireUser } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Your profile · Job Centre Events",
};

export default async function ProfilePage() {
  const user = await requireUser();
  const profile = await loadProfile(user.id);

  const name = user.displayName ?? user.name ?? "Member";
  const memberSince = user.createdAt.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const answered = profile.sections.reduce(
    (total, section) => total + section.completeness.answered,
    0
  );
  const required = profile.sections.reduce(
    (total, section) => total + section.completeness.required,
    0
  );

  return (
    <div className="min-h-screen">
      <AppHeader section="Profile" />

      <main className="mx-auto max-w-[900px] space-y-6 px-4 py-8 sm:px-6">
        {/* --- Identity, read-only ---------------------------------- */}
        <Panel as="header" className="rise">
          <div className="flex flex-wrap items-center gap-5">
            {user.avatarUrl ? (
              // A plain <img>: next/image would want the Discord CDN in a
              // remotePatterns allowlist for a 128px avatar that is already
              // exactly the size it is displayed at.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.avatarUrl}
                alt=""
                width={72}
                height={72}
                className="h-[72px] w-[72px] shrink-0 rounded-full border border-hair"
              />
            ) : (
              <Avatar name={name} size="lg" className="h-16 w-16 text-base" />
            )}

            <div className="min-w-0">
              <Eyebrow className="mb-1">Your Discord identity</Eyebrow>
              <h1 className="font-display text-4xl leading-none">{name}</h1>
              <p className="mt-2 text-xs text-muted">
                Member since {memberSince}
                {user.isAdmin && (
                  <>
                    {" · "}
                    <Badge tone="gold">Admin</Badge>
                  </>
                )}
              </p>
            </div>

            {required > 0 && (
              <StatTile
                className="ml-auto text-right"
                label="Answered"
                value={`${answered}/${required}`}
                valueClassName={answered === required ? "text-signal" : "text-gold"}
              />
            )}
          </div>

          <p className="mt-5 border-t border-hair pt-4 text-xs leading-relaxed text-muted">
            Your name and avatar come from Discord and refresh every time you sign in, so
            there is nothing to edit here. Everything below is yours, saved as you tap it,
            and it pre-fills the application form for every event — you should never have
            to type your rank into a Google Form again.
          </p>
        </Panel>

        {/* --- The questions ---------------------------------------- */}
        {profile.empty ? (
          <Section
            icon="clipboard"
            title="Nothing to fill in yet"
            description="No games have any questions attached yet, so there is nothing to answer."
          >
            <p className="text-sm leading-relaxed text-muted">
              {user.isAdmin ? (
                <>
                  You are an admin — add a game and its questions under{" "}
                  <a href="/admin/games" className="text-gold underline underline-offset-4">
                    Admin → Games
                  </a>
                  , and they will appear here straight away.
                </>
              ) : (
                "An admin sets these up; check back once they have."
              )}
            </p>
          </Section>
        ) : (
          <div>
            {profile.untouched && (
              <Alert tone="gold" className="mb-2">
                <span className="block font-medium">You haven&apos;t answered anything yet</span>
                <span className="mt-1 block opacity-90">
                  Tap your way through the sections below — every answer saves on its own,
                  there is no submit button, and you can come back and change any of it
                  whenever you like.
                </span>
              </Alert>
            )}

            {profile.sections.map((section) => (
              <ProfileSection key={section.key} section={section} />
            ))}
          </div>
        )}

        <p className="pb-4 text-center text-xs text-muted">
          Answers are stored per game, so a Jackbox night never asks for your Rivals rank.
        </p>
      </main>
    </div>
  );
}
