/**
 * `/dev-login` — the development sign-in escape hatch.
 *
 * **404 unless `NODE_ENV=development` and `DEV_LOGIN=1`**, both. See
 * `src/lib/dev-login.ts` for why that combination cannot be true in a
 * deployment: `next build` and `next start` — which is what Vercel runs — always
 * set `NODE_ENV=production`, so this page does not exist there even if someone
 * pastes `DEV_LOGIN=1` into the dashboard.
 *
 * It exists because the Discord application does not exist yet (checklist.md,
 * "Blocked on you"), so without it `/me/profile` and `/admin/games` could be
 * written but never opened. What it mints is a real Auth.js **database
 * session** — an actual `sessions` row whose token goes in the cookie Auth.js
 * reads — so every guard downstream behaves exactly as it will in production.
 * The only step skipped is the OAuth handshake.
 *
 * A button rather than a link that acts on sight: signing in is a state change,
 * and even a development tool should not do one because something linked to it.
 */

import { notFound } from "next/navigation";
import { devSignInAction, devSignOutAction } from "./actions";
import { Alert, Badge, Button, Eyebrow, Panel } from "@/components/ui";
import { DEV_LOGIN_DISCORD_ID, devLoginConfig, devLoginEnabled } from "@/lib/dev-login";
import { getCurrentUser } from "@/lib/session-guards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Development sign-in · Job Centre Events",
};

export default async function DevLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!devLoginEnabled()) notFound();

  const params = await searchParams;
  const rawTo = params.to;
  const to = (Array.isArray(rawTo) ? rawTo[0] : rawTo) ?? "/me/profile";

  const config = devLoginConfig();
  const user = await getCurrentUser();

  return (
    <main className="mx-auto flex min-h-screen max-w-lg items-center px-4 py-16">
      <div className="w-full space-y-5 rise">
        <Eyebrow>Development only</Eyebrow>
        <h1 className="font-display text-4xl leading-none tracking-wide">
          DEVELOPMENT SIGN-IN
        </h1>

        <Alert tone="ember">
          <span className="block font-medium">This is not a real sign-in</span>
          <span className="mt-1 block opacity-90">
            There is no Discord application configured yet, so this mints a session for a
            local user instead. It works only when <code>NODE_ENV=development</code> and{" "}
            <code>DEV_LOGIN=1</code> — both — which is why a deployment cannot reach this
            page at all. Turn it off in <code>.env.local</code> once Discord sign-in works.
          </span>
        </Alert>

        <Panel padding="md">
          <Eyebrow className="mb-3">Who you will be</Eyebrow>
          <dl className="space-y-2 text-sm">
            <Row label="Discord id">
              <span className="font-mono text-xs">{config.discordId}</span>
              {config.discordId === DEV_LOGIN_DISCORD_ID && (
                <span className="ml-2 text-xs text-muted">(obviously fake by design)</span>
              )}
            </Row>
            <Row label="Name">{config.displayName}</Row>
            <Row label="Admin">
              {config.isAdmin ? (
                <Badge tone="gold">Yes — DEV_LOGIN_ADMIN=1</Badge>
              ) : (
                <Badge>No — set DEV_LOGIN_ADMIN=1 for /admin/games</Badge>
              )}
            </Row>
          </dl>
        </Panel>

        {user ? (
          <Panel padding="md">
            <Eyebrow className="mb-3">Already signed in</Eyebrow>
            <p className="mb-4 text-sm text-muted">
              You are signed in as <span className="text-chalk">{user.displayName}</span>
              {user.isAdmin ? " (admin)" : " (not an admin)"}. Signing in again picks up a
              changed <code>DEV_LOGIN_ADMIN</code>.
            </p>
            <div className="flex flex-wrap gap-2">
              <form action={devSignInAction}>
                <input type="hidden" name="to" value={to} />
                <Button variant="gold" size="sm">
                  Sign in again
                </Button>
              </form>
              <form action={devSignOutAction}>
                <Button variant="ember" size="sm">
                  End dev session
                </Button>
              </form>
              <Button href={to} size="sm">
                Continue to {to}
              </Button>
            </div>
          </Panel>
        ) : (
          <form action={devSignInAction} className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="to" value={to} />
            <Button variant="gold">Sign in as the development user</Button>
            <span className="eyebrow">Lands on {to}</span>
          </form>
        )}
      </div>
    </main>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <dt className="eyebrow w-24 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}
