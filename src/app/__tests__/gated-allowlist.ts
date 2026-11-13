/**
 * The entry points `every-action-is-gated.test.ts` is told to treat differently.
 *
 * The sweep's rule is that every server action, every admin page and every API
 * route handler awaits a guard **that refuses** - `requireUser`, `requireAdmin`,
 * `requireEventManager`, `requireManagerOfChild` - before it does anything
 * else. Two lists stand beside that rule, and both are the same kind of thing:
 * a call site that does not fit, **and a sentence saying why that is right**,
 * not why it is convenient.
 *
 * `site` is the path from the repository root, `#`, and the function's name.
 *
 * **Adding to either list is a decision, not a fix.** The test pins both
 * lengths, refuses an entry without a real reason, and refuses an entry that no
 * longer excuses anything - so neither list can grow quietly or rot.
 */

/**
 * A site with no session guard at all. The reason says what stops a stranger
 * instead.
 *
 * `opensWith` is what the sweep can still hold such a site to: the calls,
 * `return`s and `throw`s its body must begin with, in order. It is how "its
 * gate is `devLoginEnabled()` on the first line" stops being a sentence and
 * becomes something that fails when the line goes. It pins that the substitute
 * gate is *there and first*; it cannot tell whether the condition around it
 * still means what it did.
 */
export type GateException = {
  site: string;
  reason: string;
  opensWith?: readonly string[];
};

export const GATE_EXCEPTIONS: readonly GateException[] = [
  /* ---- Signing in and out: there is no session to demand yet, or no harm in lacking one ---- */
  {
    site: "src/app/signin/page.tsx#startSignIn",
    reason:
      "Starting the Discord sign-in is the one thing a signed-out visitor must be able to do; " +
      "it hands off to Auth.js and writes nothing itself.",
  },
  {
    site: "src/app/signin/page.tsx#endSession",
    reason:
      "Signing out acts only on the caller's own session cookie, so a caller without one has nothing to end.",
  },
  {
    site: "src/components/SessionNav.tsx#endSession",
    reason:
      "The header's sign-out: as the sign-in page's, it acts only on the caller's own session cookie.",
  },
  {
    site: "src/app/dev-login/actions.ts#devSignInAction",
    reason:
      "It is how a development session comes to exist, so it cannot require one. Its gate is " +
      "devLoginEnabled() on its first line, which 404s outside development.",
    opensWith: ["devLoginEnabled", "notFound"],
  },
  {
    site: "src/app/dev-login/actions.ts#devSignOutAction",
    reason:
      "Ends only the session named by the caller's own cookie, behind the same devLoginEnabled() 404 as the sign-in.",
    opensWith: ["devLoginEnabled", "notFound"],
  },

  /* ---- Route handlers that authenticate some other way ---- */
  {
    site: "src/app/api/cron/reminders/route.ts#GET",
    reason:
      "Called by a scheduler, not a member: it compares the Authorization header against CRON_SECRET " +
      "and refuses everything when the secret is unset.",
    // Read the secret, refuse if there is none; read the header, refuse if it does not match.
    opensWith: [
      '(process.env.CRON_SECRET??"").trim',
      "NextResponse.json",
      "return",
      "request.headers.get",
      "NextResponse.json",
      "return",
    ],
  },
  {
    site: "src/app/api/auth/[...nextauth]/route.ts#GET",
    reason:
      "Auth.js's own handler, re-exported from src/lib/auth. It is what creates sessions, and there is no body here to gate.",
  },
  {
    site: "src/app/api/auth/[...nextauth]/route.ts#POST",
    reason:
      "Auth.js's own handler, re-exported from src/lib/auth. It is what creates sessions, and there is no body here to gate.",
  },
];

/**
 * The only sites that may be gated by `getCurrentUser`.
 *
 * `getCurrentUser` is not a guard in the sense the other four are: it answers
 * "who is this" and returns `null` for a stranger, so awaiting it first proves
 * nothing about who gets through. An action that swapped `requireAdmin` for it
 * would be public and would look gated.
 *
 * So it counts only here, where the reason says what refuses instead - and
 * **never on an admin entry point**: the sweep refuses it under
 * `src/app/admin` whether or not the site is listed.
 */
export type IdentifiedOnly = { site: string; reason: string };

export const IDENTIFY_ONLY_SITES: readonly IdentifiedOnly[] = [
  {
    site: "src/app/events/[slug]/draft/actions.ts#loadRoomAction",
    reason:
      "Public by design - a signed-out visitor may watch a draft. What a viewer may see is decided " +
      "per viewer by loadRoom and closedTo in room.ts, which are handed the user or null.",
  },
  {
    site: "src/app/events/[slug]/draw/actions.ts#drawAction",
    reason:
      "Returns its one refusal sentence on the next line when there is no user, rather than " +
      "redirecting: the caller is a screen mid-reveal, and a redirect is not an answer it can show.",
  },
];
