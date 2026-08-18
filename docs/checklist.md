# Build checklist

Companion to [platform-plan.md](./platform-plan.md). The plan says *what and why*; this
file tracks *what is done*. Updated at the end of each phase.

**Status: every phase built.** Phases 0 to 5 are complete against 1549 tests. What is
left is not code — it is the by-hand setup below: a Discord application, a Neon
connection string, and a Vercel deploy. Until those exist the site runs locally on
PGlite with `/dev-login` standing in for Discord, which is how all six phases were
built and driven.

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
- [ ] **F2.** **Discord announcements** — in Discord: **Server Settings** →
      **Integrations** → **Webhooks** → **New Webhook** → pick the channel → **Copy Webhook
      URL** → set as `DISCORD_WEBHOOK_URL`. The code is built and tested (Phase 5); this
      is the one value it needs. Until it is set the whole feature is an inert no-op and
      `/admin/settings` says so. Once it is, that page is where you choose which of the
      five announcements actually fire.
- [x] **F3.** ~~Upstash Redis~~ — not needed. The draft board that wanted it was retired
      in Phase 4; the draft lives in Postgres like everything else.

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

## Phase 2 — events and applications `[x]` complete

- [x] Events, event days, event templates
- [x] Application form builder (admin) — `/admin/events/[id]`, tab per concern
- [x] Click-first application flow — prefilled from the profile, one submit. A
      returning member with a filled-in profile applies in **three taps**:
      confirm the prefilled answers, "I can make every day", submit. Two if they
      have applied to that event before, since their availability is kept
- [x] First-come with a waitlist, automatic promotion on withdrawal — the member
      sees what withdrawing costs ("2 people waiting — the first takes your seat")
      before they confirm it
- [x] Rank gates: minimum rank to enter, minimum rank to captain. The entry rule
      is shown *before* the form, never after it
- [x] Availability per day, attendance confirmation — day chips on `/me/events`,
      saved on the tap
- [x] Public hub, events list, event page, archive — `/`, `/events`,
      `/events/[slug]`, plus `/me` and `/me/events` for members. Nothing public
      needs a session; the invitation to sign in appears at the point of applying
- [x] The tournament board moved from `/` to `/board`, unchanged, and the hub
      links to it

745 tests. The board, the draft and the schedule are untouched beyond their route.

## Phase 3 — teams and the draft `[x]` complete

- [x] Teams, 2–8 per event
- [x] Admin picks captains from accepted applicants; a captain fills a roster slot
- [x] Draft configuration: balances, bidding style, reserve pool, roster limits
- [x] Port the draft room onto the database
- [x] Draft as immutable lots and bids, so prices survive forever

This was still ticked `[~]` when Phase 5 started, which was simply stale: Phase 4
was built on top of it and the live room, the lots, the bids and the config have
been running since. Corrected rather than done.

## Phase 4 — the format engine `[x]` complete

- [x] Schema: `stages`, `matches`, `match_games`, with `source_a` / `source_b`
- [x] Bracket generation for 2–8 teams with byes — `src/lib/bracket.ts`
- [x] Formats: single elim, double elim, round robin, group into playoff, plus
      Swiss round 1 and its pairing rule
- [x] Series length per stage, per half, per round and per slot
- [x] Map and mode rules per series length, as data
- [x] Bronze options and the bracket reset, defaulting off
- [x] Resolve-on-read generalised — `src/lib/format-resolve.ts`
- [x] Multi-day scheduling, up to 4 days, with `concurrentLobbies` a setting
- [x] Proof that the generated 4-team double elimination was the hardcoded one, slot for
      slot and minute for minute. That test compared the two implementations directly, so
      it retired with the old one — its deletion is the evidence it did its job
- [x] Admin Format, Schedule and Results tabs
- [x] Public Teams, Schedule, Bracket and Results tabs
- [x] Fix: `suppressHydrationWarning` left the server's clock in the DOM, so every time on
      the site would have rendered in the deployment's zone (UTC on Vercel) under a heading
      claiming the reader's. It suppresses the warning *and* the correction
- [x] Legacy retired: `state.ts`, `tournament.ts`, `storage.ts`, `types.ts`, `useDraft.ts`,
      `session.ts`, `users.ts`, the `/board`, `/draft` and `/login` routes, the old API
      routes, and the five legacy components. `Wheel.tsx` and `time.ts` survive
- [x] Discord is now the only way in — the env-var password accounts are gone

## Phase 5 — polish `[x]` complete

- [x] **Discord webhook announcements** — `src/lib/announce.ts` builds the
      messages as pure functions, `src/lib/discord.ts` posts them. Five kinds:
      an event published, an application accepted, an application waitlisted, a
      draft lot sold, a result recorded. Which of them fire is an admin setting
      (`discord.announcements`), edited at `/admin/settings`, defaulting to
      everything except the waitlist one — a full event would post one of those
      per applicant
- [x] **It cannot fail the action that triggered it.** `announce*` returns
      `void`, not a promise, so nothing can await it; the work runs in Next's
      `after()`, so the response is already sent before the `fetch` starts; and
      every path is inside a `try`. A missing, malformed or dead webhook is a
      no-op. With `DISCORD_WEBHOOK_URL` unset the whole feature never even reads
      a setting
- [x] **The failure is visible.** A failed post writes `announcement.failed` to
      the audit log with the status code and the reason, as well as a console
      line — so it is findable at `/admin/audit` by somebody who was not
      watching the server
- [x] **Public player profiles** — `/players/[handle]`, no login. Events played,
      the team they were on, what they were bought for, and where they finished.
      `users.handle` is derived from the Discord name once and never recomputed,
      so a rename cannot break a link that has been posted. Linked from every
      roster (one component, so the public Teams tab, the admin's Teams tab and
      the live room all get it) and from the draft's lot history
- [x] **Nothing a member would be surprised is public.** Application answers are
      never read by that module; declined and withdrawn applications are not
      listed; nothing about a draft event appears at all. Prices and results are
      already public on the event page
- [x] **Admin dashboard** — `/admin`, what needs attention: applicants the cap
      queued and nobody has decided, teams without a captain, a lot on the block,
      a series that needs a winner, matches with no time, an event ready to
      publish. Every line links to the exact tab that fixes it, which is why the
      editor now reads `?tab=`. Every count is derived, so a line disappears when
      the thing is done
- [x] **Audit log** — an `audit_log` table and `recordAudit`, called from the
      action layer and nowhere else: the actions are the trust boundary and the
      only layer that knows who is acting. Readable at `/admin/audit`, newest
      first, filterable by event. Append-only — there is no update or delete path
      anywhere
- [x] **Nothing destructive, ever — enforced rather than promised.** A finished
      event is read-only. `src/lib/archive-policy.ts` is the single rule and
      `src/lib/__tests__/archive-lock.test.ts` is the evidence: every write that
      could erase a completed event's results, rosters or draft prices is
      attempted against a finished event, refused, and the data checked to still
      be there afterwards
- [x] Fix: `clearMatchAction` — the site's most destructive operation — was
      *composed* in the action file out of `setWinnerOverride` + `recordGames`,
      which meant it reached both writes without passing through any rule about
      the operation itself. It is now `clearMatch` in `src/lib/format.ts`, where
      the refusal can be attached to it
- [x] Fix: a team's `balanceStart` could be rewritten after lots had been
      awarded. Every remaining balance is derived from it, so moving it silently
      changed what every past lot appeared to have cost. Refused once a lot has
      been awarded, on any event

**1549 tests** — 101 new ones over Phase 5, of which the twenty in
`archive-lock.test.ts` are the ones the standing rule rests on.

---

## Side and map choice `[x]` complete

The rule that came back from the group, and the one that replaced the map veto that used
to sit under **Held**. See plan §8.4.

- [x] **One team picks the side, the other picks the map — and they swap every
      game.** For every game of a match one team chooses attack or defence and
      the other chooses the map. A coin decides who starts with the side choice;
      in a Bo3 that is A, then B, then A, with the map going the other way each
      time. A Bo1 is one flip and one game
- [x] **One value stored, everything else derived.** `matches.first_side_choice`
      is `a` or `b` and is written once, by a coin toss, when the stage's matches
      are generated. `sideChooserFor(firstSideChoice, gameIndex)` in
      `src/lib/format-policy.ts` — beside `modesFor`, with the other per-game
      derivations — is the whole of the rest, and `mapChooserFor` is the other
      slot. A per-game copy would be a second copy that can disagree with itself
      after an edit, which is the same argument that keeps a slot's teams in
      `source_a` and a team's balance off `teams`
- [x] **A slot, not a team id.** A bracket slot has no teams when its matches are
      generated, so a team id is a value nobody could write yet. It resolves into
      a team on read, which is why a card can say "Upper final winner picks the
      side" before that final has been played
- [x] **The coin can be corrected.** `reflipMatch` tosses again, or hands the
      side choice to a named slot for the toss somebody watched land the other
      way. Refused on a finished event through `src/lib/archive-policy.ts`, and
      refused once any game of that series has been played — the whole series was
      played under that coin, and moving it would silently re-attribute every map
      in it. Clear the series first, as with any other recorded mistake
- [x] **What was actually chosen is a note, not the rule.**
      `match_games.side_chosen` (`attack` / `defence`, nullable) is editable next
      to the map in the admin's Results editor. Leaving it blank changes nothing
      about who chose what
- [x] **Shown per game** on the match card (public bracket and admin alike), on
      the public Results tab, and in the admin's Results editor — with the
      re-flip control on the same card

**1582 tests** — 33 new ones in `src/lib/__tests__/side-choice.test.ts`: the swap across
Bo1, Bo3, Bo5 and Bo7, that the map chooser is always the other team, that the assignment
is stable across reads and does not move when the results around it do, and both re-flip
refusals with the coin checked to be untouched afterwards.

---

## Held — decided against building for now

These are recorded so they are not lost, but are deliberately not in any phase yet.

The **map ban / pick** idea that used to sit here has left: it was settled rather than
built. See *Side and map choice* above and plan §8.4 — the group landed on the side/map
swap instead, which gives both teams agency every game without a map pool, a ban sequence
or a live veto surface.

- [ ] **Rank thresholds are provisional** — Platinum 3 to enter, Diamond 2 to captain, both
      still up for discussion. The *mechanism* is in Phase 2; the *numbers* are settings, so
      changing your mind later costs nothing.

---

## Standing rules

- Every phase ends deployable. No half-migrated states.
- The test suite goes green before a phase is called done.
- Nothing destructive: no feature may erase a completed event's results or draft prices.
  Enforced as of Phase 5 rather than promised — `src/lib/archive-policy.ts` is the rule,
  `src/lib/__tests__/archive-lock.test.ts` is the proof, and a new destructive write
  should add a case to both.
- Signups are clicks, not typing. Free text only where genuinely unavoidable.
