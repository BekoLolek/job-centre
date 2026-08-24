/**
 * `/signin` — the Discord sign-in page (docs/platform-plan.md §3.2).
 *
 * Four states, all rendered server-side:
 *
 *  1. **Not configured** — no Discord app yet, so the button would go nowhere.
 *     Says so plainly and lists the variables that are still blank.
 *  2. **Ready** — one button, one scope prompt, one redirect.
 *  3. **Already signed in** — who you are, and a way out.
 *  4. **Rejected** — most importantly "you are not in the server", which is a
 *     normal outcome of a correctly working gate rather than an error, and is
 *     explained as such.
 *
 * The legacy `/login` page (captain passwords, the draft board) is a separate
 * page and is not touched by any of this.
 */

import { Alert, Avatar, Badge, Button, Eyebrow, Panel } from "@/components/ui";
import { SIGN_IN_ERRORS, discordConfigStatus } from "@/lib/auth-policy";
import { signIn, signOut } from "@/lib/auth";
import { getCurrentUser } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sign in · Job Centre Events",
};

type Explanation = { tone: "ember" | "gold"; title: string; body: string };

/**
 * What went wrong, in words a member can act on. Covers our own codes from
 * `auth-policy` plus the ones Auth.js appends to `?error=` itself.
 */
const EXPLANATIONS: Record<string, Explanation> = {
  [SIGN_IN_ERRORS.notInGuild]: {
    tone: "ember",
    title: "You're not in the Job Centre Discord server",
    body:
      "Your Discord account signed in fine, but membership of the Job Centre server is " +
      "required to use the site. Join the server, then try again — no need to sign up " +
      "for anything here separately.",
  },
  [SIGN_IN_ERRORS.gateMisconfigured]: {
    tone: "gold",
    title: "The guild check isn't pointed at a server yet",
    body:
      "Sign-in is restricted to one Discord server, but no server has been chosen. " +
      "Nobody can sign in until an admin sets one. This is a configuration problem, " +
      "not something you did.",
  },
  [SIGN_IN_ERRORS.guildLookupFailed]: {
    tone: "ember",
    title: "Discord wouldn't tell us which servers you're in",
    body:
      "The membership check could not be completed — usually a temporary Discord " +
      "problem, or the 'guilds' permission being declined on the consent screen. " +
      "Try again in a moment and accept both permissions.",
  },
  [SIGN_IN_ERRORS.adminOnly]: {
    tone: "gold",
    title: "That page is admin-only",
    body: "You're signed in, but your account doesn't have the admin flag.",
  },
  AccessDenied: {
    tone: "ember",
    title: "Sign-in was refused",
    body: "Your account isn't allowed in. If you've just joined the server, try again.",
  },
  Configuration: {
    tone: "gold",
    title: "Sign-in could not complete",
    body:
      "Auth.js reports a configuration error. It means one of two things, and the second " +
      "is the likelier one after a deploy: either the Discord client id, secret, " +
      "AUTH_SECRET or redirect URI is wrong for this host — or the database schema is " +
      "behind the code and something the sign-in writes does not exist yet. Auth.js " +
      "cannot tell those apart, so it reports both as this. Run npm run db:migrate " +
      "against the deployed database before touching the credentials.",
  },
  OAuthAccountNotLinked: {
    tone: "gold",
    title: "That account is already linked to someone else",
    body: "Sign in with the Discord account you used the first time.",
  },
  Verification: {
    tone: "gold",
    title: "That link has expired",
    body: "Start the sign-in again.",
  },
};

function explain(code: string | undefined): Explanation | null {
  if (!code) return null;
  return (
    EXPLANATIONS[code] ?? {
      tone: "ember",
      title: "Sign-in didn't complete",
      body: `Discord sent back an unexpected result (${code}). Try again.`,
    }
  );
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawError = params.error;
  const problem = explain(Array.isArray(rawError) ? rawError[0] : rawError);

  const status = discordConfigStatus();
  const user = status.configured ? await getCurrentUser() : null;

  async function startSignIn() {
    "use server";
    await signIn("discord", { redirectTo: "/" });
  }

  async function endSession() {
    "use server";
    await signOut({ redirectTo: "/signin" });
  }

  return (
    <main className="min-h-screen grid lg:grid-cols-[1.15fr_1fr]">
      <section className="relative hidden lg:flex flex-col justify-between p-12 border-r border-hair overflow-hidden">
        <Eyebrow className="rise">Members · Discord sign-in</Eyebrow>

        <div className="relative">
          <h1 className="wordmark leading-[1.02] tracking-tight">
            <span className="block text-[clamp(2rem,5.2vw,4.6rem)] rise">Job Centre</span>
            <span
              className="block text-[clamp(2rem,5.2vw,4.6rem)] text-union rise"
              style={{ animationDelay: "90ms" }}
            >
              EVENTS
            </span>
          </h1>
          <p
            className="mt-6 max-w-md text-muted leading-relaxed rise"
            style={{ animationDelay: "180ms" }}
          >
            One account, taken straight from Discord. Your name, your avatar, your
            server membership — no password to lose, no form to fill in twice.
          </p>
        </div>

        <Eyebrow className="flex items-center gap-3 rise" style={{ animationDelay: "260ms" }}>
          <span className="inline-block h-2 w-2 rounded-full bg-signal live-dot" />
          Job Centre members only
        </Eyebrow>

        <div className="pointer-events-none absolute -right-24 top-1/2 -translate-y-1/2 h-[520px] w-[520px] rounded-full border border-hair hatch opacity-40" />
        <div className="pointer-events-none absolute -right-10 top-1/2 -translate-y-1/2 h-[340px] w-[340px] rounded-full border border-hair opacity-30" />
      </section>

      <section className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-sm rise">
          <div className="lg:hidden mb-10">
            <h1 className="font-display text-6xl leading-[0.85]">
              JOB CENTRE
              <span className="block text-gold">Events</span>
            </h1>
          </div>

          <Eyebrow className="mb-6">Sign in</Eyebrow>

          {problem && (
            <Alert tone={problem.tone} className="mb-6">
              <span className="block font-medium">{problem.title}</span>
              <span className="mt-1 block opacity-90">{problem.body}</span>
            </Alert>
          )}

          {!status.configured ? (
            <NotConfigured missing={status.missing} />
          ) : user ? (
            <SignedIn
              name={user.displayName ?? user.name ?? "Member"}
              isAdmin={user.isAdmin}
              endSession={endSession}
            />
          ) : (
            <Ready startSignIn={startSignIn} />
          )}
        </div>
      </section>
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* States                                                             */
/* ------------------------------------------------------------------ */

/** No Discord application exists yet. The button is not offered at all. */
function NotConfigured({ missing }: { missing: string[] }) {
  return (
    <>
      <Alert tone="gold" className="mb-6">
        <span className="block font-medium">Discord sign-in is not configured yet</span>
        <span className="mt-1 block opacity-90">
          The site is running, but no Discord application has been set up, so there is
          nothing to sign in to.
        </span>
      </Alert>

      <Panel padding="md" className="mb-6">
        <Eyebrow className="mb-3">Waiting on</Eyebrow>
        <ul className="space-y-2 text-sm">
          {missing.map((name) => (
            <li key={name} className="flex items-center gap-2 font-mono text-xs text-muted">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-ember" />
              {name}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-muted leading-relaxed">
          Create an application at discord.com/developers, register the redirect URI
          <span className="font-mono text-chalk/70"> /api/auth/callback/discord </span>
          for this host, then put the values in <span className="font-mono">.env.local</span>
          and restart. Nothing else has to change.
        </p>
      </Panel>

      <Button href="/" className="w-full">
        Back to the site
      </Button>

      <p className="mt-8 text-xs text-muted leading-relaxed">
        Discord is the only way in. There are no passwords to hand out and none to lose.
      </p>
    </>
  );
}

/** Configured and signed out — the actual sign-in button. */
function Ready({ startSignIn }: { startSignIn: () => Promise<void> }) {
  return (
    <>
      <p className="mb-6 text-sm text-muted leading-relaxed">
        Sign in with the Discord account you use in the Job Centre server. You&apos;ll be
        asked to share your username, avatar and the list of servers you&apos;re in — the
        last one is how membership is checked, and nothing else is read.
      </p>

      <form action={startSignIn}>
        <Button variant="gold" className="w-full">
          Continue with Discord
        </Button>
      </form>

      <p className="mt-8 text-xs text-muted leading-relaxed">
        Not in the server yet? Ask for an invite first — sign-in is restricted to members.
      </p>
    </>
  );
}

/** Already signed in. */
function SignedIn({
  name,
  isAdmin,
  endSession,
}: {
  name: string;
  isAdmin: boolean;
  endSession: () => Promise<void>;
}) {
  return (
    <>
      <Panel padding="md" className="mb-6">
        <div className="flex items-center gap-3">
          <Avatar name={name} size="lg" />
          <div className="min-w-0">
            <div className="truncate font-medium">{name}</div>
            <div className="mt-1 flex items-center gap-2">
              <Badge tone="signal">Signed in</Badge>
              {isAdmin && <Badge tone="gold">Admin</Badge>}
            </div>
          </div>
        </div>
      </Panel>

      <Button href="/" variant="gold" className="mb-3 w-full">
        Continue
      </Button>

      <form action={endSession}>
        <Button className="w-full">Sign out</Button>
      </form>
    </>
  );
}
