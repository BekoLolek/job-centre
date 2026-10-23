/**
 * `/signin` — the Discord sign-in page (R-01, R-02, R-06 / UC-01).
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
 * There is no second sign-in page. `/login` — the old captain-password login
 * the single-purpose draft board ran on — was retired with that board and does
 * not exist. The only other way into a session is `/dev-login`, which is
 * developer tooling (R-142 / UC-30) and answers not found unless the site is
 * running locally against the local database.
 */

import { Alert, Avatar, Badge, Button, Eyebrow, Panel } from "@/components/ui";
import { SIGN_IN_ERRORS, discordConfigStatus } from "@/lib/auth-policy";
import { signIn, signOut } from "@/lib/auth";
import { getCurrentUser, returnPathFromRequest, safeReturnPath } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sign in · Job Centre Events",
};

type Explanation = { tone: "flare" | "union"; title: string; body: string };

/**
 * Cancelled, and unreachable. Two outcomes, two sentences (UC-01 3a, 4c).
 *
 * They used to read the same, because every Auth.js code that was not one of
 * ours fell through to "Discord sent back an unexpected result (X)". That is
 * the wrong answer to both: somebody who pressed Cancel is told the site is
 * broken, and somebody who hit a Discord outage is given nothing to act on.
 *
 * The codes they hang off are Auth.js's, and worth writing down because they
 * are not obvious from the outside (`@auth/core/errors.js`):
 *
 *  - Declining at Discord's consent screen comes back on the redirect as
 *    `error=access_denied`, which `@auth/core` turns into an
 *    `OAuthCallbackError` — one of the eight types it is willing to name on
 *    the client, so it arrives as `?error=OAuthCallbackError`.
 *  - A network failure during the token exchange is *not* client-safe: it is
 *    wrapped in a `CallbackRouteError` and reported as `Configuration`, which
 *    is why that entry stays about deployment mistakes. The Discord outage we
 *    can actually recognise is the one in our own guild check, which produces
 *    `guild-lookup-failed` from `evaluateGuildGate`.
 */
const CANCELLED: Explanation = {
  tone: "union",
  title: "Sign-in cancelled",
  body:
    "You came back from Discord without authorising the site, so nothing was stored — " +
    "no account, no session. Start again whenever you like. If you did not cancel, " +
    "Discord refused the request; try once more.",
};

const UNREACHABLE: Explanation = {
  tone: "flare",
  title: "Discord did not answer, try again",
  body:
    "We could not reach Discord to check your account, so you have not been signed in " +
    "and nothing was stored. This is almost always a passing Discord problem — or the " +
    "'servers' permission being declined on the consent screen. Try again in a moment " +
    "and accept both permissions.",
};

/**
 * What went wrong, in words a member can act on. Covers our own codes from
 * `auth-policy` plus the ones Auth.js appends to `?error=` itself.
 */
const EXPLANATIONS: Record<string, Explanation> = {
  [SIGN_IN_ERRORS.notInGuild]: {
    tone: "flare",
    title: "You're not in the Job Centre Discord server",
    body:
      "Your Discord account signed in fine, but membership of the Job Centre server is " +
      "required to use the site. Join the server, then try again — no need to sign up " +
      "for anything here separately.",
  },
  [SIGN_IN_ERRORS.gateMisconfigured]: {
    tone: "union",
    title: "The guild check isn't pointed at a server yet",
    body:
      "Sign-in is restricted to one Discord server, but no server has been chosen. " +
      "Nobody can sign in until an admin sets one. This is a configuration problem, " +
      "not something you did.",
  },
  [SIGN_IN_ERRORS.guildLookupFailed]: UNREACHABLE,
  [SIGN_IN_ERRORS.adminOnly]: {
    tone: "union",
    title: "That page is admin-only",
    body: "You're signed in, but your account doesn't have the admin flag.",
  },
  // Discord's own `access_denied`, and the wrapper Auth.js reports it as.
  OAuthCallbackError: CANCELLED,
  access_denied: CANCELLED,
  // A sign-in that never got as far as Discord's consent screen.
  OAuthSignInError: UNREACHABLE,
  // Discord answered the profile request with something unreadable.
  OAuthProfileParseError: UNREACHABLE,
  AccessDenied: {
    tone: "flare",
    title: "Sign-in was refused",
    body: "Your account isn't allowed in. If you've just joined the server, try again.",
  },
  /*
   * Auth.js's catch-all, not a diagnosis.
   *
   * `node_modules/@auth/core/index.js:131` reads
   * `const type = isClientSafeErrorType ? error.type : "Configuration"` — so
   * every error it is not willing to name in public arrives here: a failed
   * database write, a bad credential, a provider that misbehaved. The old copy
   * here guessed between two of those and told the reader to run a migration,
   * which is wrong advice for most of the cases that reach it, and is not a
   * sentence a member can act on anyway.
   *
   * So: say that it is ours, not theirs, and stop. Auth.js already writes the
   * real cause to the server log itself — `[auth][error]`, `[auth][cause]` and
   * `[auth][details]`, which is how the Discord issuer bug in `src/lib/auth.ts`
   * was found — and that log, not this page, is what an admin reads.
   */
  Configuration: {
    tone: "flare",
    title: "Something went wrong at our end",
    body:
      "Sign-in could not be completed, and it is not something you did — nothing was " +
      "stored and you have not been signed in. Please try again in a moment. If it " +
      "keeps happening, tell an admin: the site has written down what went wrong.",
  },
  OAuthAccountNotLinked: {
    tone: "union",
    title: "That account is already linked to someone else",
    body: "Sign in with the Discord account you used the first time.",
  },
  Verification: {
    tone: "union",
    title: "That link has expired",
    body: "Start the sign-in again.",
  },
};

function explain(code: string | undefined): Explanation | null {
  if (!code) return null;
  return (
    EXPLANATIONS[code] ?? {
      tone: "flare",
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

  /*
   * The page they started from (UC-01 6, 8).
   *
   * `?from=` is what the guards put there when they sent somebody here from a
   * page they asked for. The `Referer` is the fallback and covers the ordinary
   * route in: they were reading something, they pressed "Sign in" in the
   * header, and that header link carries no state of its own.
   *
   * Both are browser-supplied and both go through `safeReturnPath`, so the
   * worst either can do is name another page on this site. `/` when neither
   * says anything usable.
   */
  const from =
    safeReturnPath(Array.isArray(params.from) ? params.from[0] : params.from) ??
    (await returnPathFromRequest()) ??
    "/";

  async function startSignIn() {
    "use server";
    await signIn("discord", { redirectTo: from });
  }

  async function endSession() {
    "use server";
    await signOut({ redirectTo: from });
  }

  return (
    <main className="min-h-screen grid lg:grid-cols-[1.15fr_1fr]">
      <section className="relative hidden lg:flex flex-col justify-between p-12 border-r border-hair overflow-hidden">
        <Eyebrow className="rise">Members · Discord sign-in</Eyebrow>

        <div className="relative">
          {/*
            One line, the same mark as the header's. `rise` sits on the `<h1>`
            and the drift on the `<span>` because both are `animation` on one
            element and the later rule in `globals.css` would simply win.
          */}
          <h1 className="wordmark leading-[1.02] tracking-tight rise">
            <span className="block text-hero wordmark-accent">Job Centre</span>
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
          <span className="inline-block h-2 w-2 rounded-full bg-success live-dot" />
          Job Centre members only
        </Eyebrow>

        <div className="pointer-events-none absolute -right-24 top-1/2 -translate-y-1/2 h-[520px] w-[520px] rounded-full border border-hair hatch opacity-40" />
        <div className="pointer-events-none absolute -right-10 top-1/2 -translate-y-1/2 h-[340px] w-[340px] rounded-full border border-hair opacity-30" />
      </section>

      <section className="flex items-center justify-center p-6 sm:p-12">
        <div className="w-full max-w-sm rise">
          <div className="lg:hidden mb-10">
            {/* The same mark again, at the one fixed step this block used. */}
            <h1 className="wordmark leading-[0.85] tracking-tight">
              <span className="block text-48 wordmark-accent">Job Centre</span>
            </h1>
          </div>

          <Eyebrow className="mb-6">Sign in</Eyebrow>

          {problem && (
            <Alert tone={problem.tone} standing className="mb-6">
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
              from={from}
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
      <Alert tone="union" standing className="mb-6">
        <span className="block font-medium">Discord sign-in is not configured yet</span>
        <span className="mt-1 block opacity-90">
          The site is running, but no Discord application has been set up, so there is
          nothing to sign in to.
        </span>
      </Alert>

      <Panel padding="md" className="mb-6">
        <Eyebrow className="mb-3">Waiting on</Eyebrow>
        <ul className="space-y-2 text-14">
          {missing.map((name) => (
            <li key={name} className="flex items-center gap-2 font-mono text-12 text-muted">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-flare" />
              {name}
            </li>
          ))}
        </ul>
        <p className="mt-4 text-12 text-muted leading-relaxed">
          Create an application at discord.com/developers, register the redirect URI
          <span className="font-mono text-chalk/70"> /api/auth/callback/discord </span>
          for this host, then put the values in <span className="font-mono">.env.local</span>
          and restart. Nothing else has to change.
        </p>
      </Panel>

      <Button href="/" className="w-full">
        Back to the site
      </Button>

      <p className="mt-8 text-12 text-muted leading-relaxed">
        Discord is the only way in. There are no passwords to hand out and none to lose.
      </p>
    </>
  );
}

/** Configured and signed out — the actual sign-in button. */
function Ready({ startSignIn }: { startSignIn: () => Promise<void> }) {
  return (
    <>
      <p className="mb-6 text-14 text-muted leading-relaxed">
        Sign in with the Discord account you use in the Job Centre server. You&apos;ll be
        asked to share your username, avatar and the list of servers you&apos;re in — the
        last one is how membership is checked, and nothing else is read.
      </p>

      <form action={startSignIn}>
        <Button variant="union" className="w-full">
          Continue with Discord
        </Button>
      </form>

      <p className="mt-8 text-12 text-muted leading-relaxed">
        Not in the server yet? Ask for an invite first — sign-in is restricted to members.
      </p>
    </>
  );
}

/** Already signed in. */
function SignedIn({
  name,
  isAdmin,
  from,
  endSession,
}: {
  name: string;
  isAdmin: boolean;
  /** Where "Continue" goes: the page they started from, already sanitised. */
  from: string;
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
              <Badge tone="success">Signed in</Badge>
              {isAdmin && <Badge tone="union">Admin</Badge>}
            </div>
          </div>
        </div>
      </Panel>

      <Button href={from} variant="union" className="mb-3 w-full">
        Continue
      </Button>

      <form action={endSession}>
        <Button className="w-full">Sign out</Button>
      </form>
    </>
  );
}
