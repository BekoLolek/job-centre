# Build checklist

Companion to [platform-plan.md](./platform-plan.md). The plan says *what and why*; this
file tracks *what is done*. Updated at the end of each phase.

Legend: `[x]` done · `[ ]` not started · `[~]` in progress · `[!]` blocked

---

# Setup by hand

Things only you can do — accounts, credentials, external services. Nothing is blocked on
these today; the whole build runs locally on PGlite without them. They are what turn a
local build into a site other people can sign into.

Work top to bottom. Each value goes into `.env.local` (already created, keys already
present, just fill in the blanks).

## A. Discord application `[ ]`

Gives the site its login. No bot, no permissions, no hosting — just OAuth.

- [ ] **A1.** Go to <https://discord.com/developers/applications> and sign in.
- [ ] **A2.** **New Application** (top right) → name it `Job Centre Events` → accept the
      terms → **Create**.
- [ ] **A3.** Left sidebar → **OAuth2**. Copy **Client ID** into `DISCORD_CLIENT_ID`.
- [ ] **A4.** Same page → **Client Secret** → **Reset Secret** → confirm → copy it into
      `DISCORD_CLIENT_SECRET`. It is shown **once**; if you lose it, reset again.
- [ ] **A5.** Same page → **Redirects** → **Add Redirect** → paste exactly:

      http://localhost:3400/api/auth/callback/discord

      Then **Save Changes** at the bottom. The path matters — a trailing slash or a
      different port and Discord refuses the login with a mismatch error.
- [ ] **A6.** Optional polish: **General Information** → give it an icon and description.
      That is what members see on the "authorise" screen.

Nothing needs installing to a server. Do **not** create a Bot for this.

## B. Discord IDs `[ ]`

Two 18–19 digit numbers. Both need Developer Mode.

- [ ] **B1.** In the Discord app: **User Settings** (cog, bottom-left) → **Advanced** →
      turn on **Developer Mode**.
- [ ] **B2.** Right-click the **Job Centre server icon** in the left rail → **Copy Server
      ID** → paste into `DISCORD_GUILD_ID`. This is the server whose members are allowed
      to sign in.
- [ ] **B3.** Right-click **your own name** in any message or the member list → **Copy
      User ID** → paste into `ADMIN_DISCORD_IDS`. Comma-separate if you want more than one
      admin: `123...,456...`.

This is what makes you admin on first sign-in. Without it nobody can reach `/admin`.

## C. Database — Neon `[ ]`

Free, no card. Skip this entirely while developing locally; only a deployment needs it.

- [ ] **C1.** <https://neon.tech> → **Sign up** (signing in with GitHub is quickest).
- [ ] **C2.** **Create project**. Name it `job-centre`. For region pick the one nearest
      you — **Europe (Frankfurt)** for CEST. Postgres version: leave the default.
- [ ] **C3.** On the project dashboard find **Connection string**. Make sure the toggle
      says **Pooled connection** — the host contains `-pooler`. Serverless needs the
      pooled one.
- [ ] **C4.** Paste it into `DATABASE_URL`. It looks like:

      postgresql://user:pass@ep-something-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require

- [ ] **C5.** Optional but recommended: **Branches** → **Create branch** → name it `dev`.
      A branch is a full copy with its own connection string, so local work never touches
      what the community is using. Use the `dev` string locally and the main one on Vercel.

**Alternative:** if you would rather not manage it, Vercel's **Storage** tab has a Neon
integration that creates the database and injects `DATABASE_URL` into the deployment for
you. Same product, fewer steps, but no separate `dev` branch unless you add one.

## D. Wire it up locally `[ ]`

- [ ] **D1.** Fill the blanks in `.env.local` from A–C. `AUTH_SECRET` is already generated.
- [ ] **D2.** Apply the schema and seed the starting data:

      npm run db:migrate
      npm run db:seed

- [ ] **D3.** `npm run dev`, open <http://localhost:3400/signin>, and sign in with Discord.
      You should land back on the site as an admin.
- [ ] **D4.** Sanity checks: `/admin/games` loads, and signing in from an account that is
      **not** in the server is refused with "you're not in the Job Centre server".

## E. Deploy to Vercel `[ ]`

- [ ] **E1.** <https://vercel.com/new> → **Import** `BekoLolek/job-centre`.
- [ ] **E2.** Leave Framework (Next.js) and Root Directory (`./`) alone — the repo root
      *is* the app.
- [ ] **E3.** Before the first deploy, add these under **Environment Variables**:

      | Variable | Value |
      | --- | --- |
      | `DATABASE_URL` | the Neon pooled string |
      | `DISCORD_CLIENT_ID` | from A3 |
      | `DISCORD_CLIENT_SECRET` | from A4 |
      | `DISCORD_GUILD_ID` | from B2 |
      | `ADMIN_DISCORD_IDS` | from B3 |
      | `AUTH_SECRET` | a fresh one — see below |

      Generate a production `AUTH_SECRET` rather than reusing the local one:

      node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

- [ ] **E4.** **Do not set `AUTH_URL` on Vercel.** Auth.js works the host out from the
      deployment; a hardcoded value is the usual cause of a broken callback.
- [ ] **E5.** **Do not set `DEV_LOGIN` on Vercel.** It cannot work there anyway, but do not
      plant it.
- [ ] **E6.** Deploy. Note the URL, something like `job-centre.vercel.app`.
- [ ] **E7.** Back in Discord (A5), add a second redirect:

      https://your-project.vercel.app/api/auth/callback/discord

- [ ] **E8.** Run the migration against Neon once — easiest is locally with `DATABASE_URL`
      temporarily pointed at the production string:

      npm run db:migrate
      npm run db:seed

- [ ] **E9.** Sign in on the live URL and confirm you are admin.

## F. Later, when you want them `[ ]`

- [ ] **F1.** **Custom domain** — Vercel → project → **Settings** → **Domains**. Then add a
      third redirect URI in Discord for it. Nothing in the code changes.
- [ ] **F2.** **Discord announcements** (Phase 5) — in Discord: **Server Settings** →
      **Integrations** → **Webhooks** → **New Webhook** → pick the channel → **Copy Webhook
      URL** → set as `DISCORD_WEBHOOK_URL`.
- [ ] **F3.** **Upstash Redis** — only if you want the *old* draft board working on the
      deployment before Phase 3 ports it onto Postgres. Vercel → **Storage** → **Upstash for
      Redis**. Once Phase 3 lands this is not needed at all.

## Common failures

| Symptom | Cause |
| --- | --- |
| "Invalid OAuth2 redirect_uri" | The redirect in A5/E7 does not match character for character, including the port and `/api/auth/callback/discord`. |
| Signed in but not admin | `ADMIN_DISCORD_IDS` was blank at first sign-in. Fill it in and sign out and back in — it is applied on every sign-in. |
| Everyone rejected at sign-in | `DISCORD_GUILD_ID` is wrong or blank. The gate fails closed on purpose. |
| Callback fails only in production | `AUTH_URL` is set on Vercel. Delete it. |
| Local login works, live one does not | The production `AUTH_SECRET` is missing, or the migration in E8 was never run. |

---

## Phase 0 — foundations `[x]` complete

- [x] Vitest, with the timezone pinned so results are deterministic
- [x] 236 unit tests over `src/lib` — schedule engine, bracket resolution, standings and
      tiebreaks, per-role redaction, session signing, auth
- [x] Fix: auto-fill re-anchoring the whole day to an already-played match
- [x] Fix: `autoSchedule` silently discarding its `timing` argument
- [x] `src/components/ui/` extracted — Panel, Button, Field/Select/Textarea, Table, Tabs,
      Badge, StatusPill, Eyebrow, EmptyState, StatTile, Avatar, Alert
- [x] Adopted across the existing boards with no visual change
- [x] Rebrand to Job Centre Events
- [x] Repo renamed to `job-centre`

## Phase 1 — identity `[x]` complete (bar the live Discord credentials)

- [x] Postgres schema in Drizzle: users, games, profile fields and values, settings
- [x] Local development and tests on PGlite, so no cloud account is needed to build
- [x] Migrations and a seed (Marvel Rivals with its 23-rank ladder, Jackbox without one)
- [x] Auth.js with the Discord provider — database sessions, `identify guilds` scopes
- [x] Guild gate — sign-in restricted to members of the Job Centre server, with the guild
      id and the on/off switch read from `settings` so admin can change both later
- [x] First admin seeded from `ADMIN_DISCORD_IDS` — applied on first sign-in as well as by
      the seed, and only ever grants the flag, never removes it
- [x] `/signin` and `getCurrentUser` / `requireUser` / `requireAdmin` for the pages to come
- [x] `/me/profile` — per-game profile, click-first inputs: pill rows, toggle chips, a
      two-tap rank picker over the 23-rank ladder, steppers, and free text only where the
      field type genuinely is text. Each section saves itself; no page-wide submit
- [x] `/admin/games` — define a game and the questions it asks: create, rename, reorder,
      activate/deactivate; edit the rank ladder; add, retype, reorder and delete questions,
      with the number of answers an edit or delete would destroy shown first
- [x] Development sign-in (`/dev-login`), so the pages above could be built and driven in a
      browser before the Discord app exists. Requires `NODE_ENV=development` **and**
      `DEV_LOGIN=1`; unreachable from a deployment, and loudly banner-ed while live
- [x] Session-aware navigation — Profile for members, Admin as well for admins
- [x] Legacy password login left running alongside, so the draft board keeps working

**Waiting on the manual setup above** (sections A–D). Everything here is built and tested
against PGlite without it; only a real sign-in needs the credentials.

**Known dev-only gotcha:** `next dev` runs route handlers in a different process from page
renders, and PGlite lives inside whichever process opened it — so a row written by an
`/api/*` route is invisible to pages until the server restarts. Anything that writes to
Postgres and expects a page to see it must be a server action, not a route handler. Neon
makes the problem disappear, since then there is one real database.

## Phase 2 — events and applications `[~]` in progress

- [~] Events, event days, event templates
- [ ] Application form builder (admin)
- [ ] Click-first application flow — prefilled from the profile, one submit
- [ ] First-come with a waitlist, automatic promotion on withdrawal
- [ ] Rank gates: minimum rank to enter, minimum rank to captain
- [ ] Availability per day, attendance confirmation
- [ ] Public hub, events list, event page, archive

## Phase 3 — teams and the draft `[ ]`

- [ ] Teams, 2–8 per event
- [ ] Admin picks captains from accepted applicants; a captain fills a roster slot
- [ ] Draft configuration: balances, bidding style, reserve pool, roster limits
- [ ] Port the draft room onto the database
- [ ] Draft as immutable lots and bids, so prices survive forever

## Phase 4 — the format engine `[ ]`

- [ ] Bracket generation for 2–8 teams with byes
- [ ] Formats: single elim, double elim, round robin, group into playoff
- [ ] Series length per stage and per round
- [ ] Map and mode rules per series
- [ ] Multi-day scheduling, up to 4 days
- [ ] Port the results board and scheduler onto the new model

## Phase 5 — polish `[ ]`

- [ ] Discord webhook announcements
- [ ] Public player profiles
- [ ] Admin dashboard
- [ ] Audit log
- [ ] Event archive — nothing destructive, ever

---

## Held — decided against building for now

These are recorded so they are not lost, but are deliberately not in any phase yet.

- [ ] **Map ban / pick** — the team that does not ban first picks the map from what remains.
      Wants feedback from the group before it is designed properly. See plan §8.4.
- [ ] **Rank thresholds are provisional** — Platinum 3 to enter, Diamond 2 to captain, both
      still up for discussion. The *mechanism* is in Phase 2; the *numbers* are settings, so
      changing your mind later costs nothing.

---

## Standing rules

- Every phase ends deployable. No half-migrated states.
- The test suite goes green before a phase is called done.
- Nothing destructive: no feature may erase a completed event's results or draft prices.
- Signups are clicks, not typing. Free text only where genuinely unavoidable.
