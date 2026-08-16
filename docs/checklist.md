# Build checklist

Companion to [platform-plan.md](./platform-plan.md). The plan says *what and why*; this
file tracks *what is done*. Updated at the end of each phase.

Legend: `[x]` done · `[ ]` not started · `[~]` in progress · `[!]` blocked

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

**Blocked on you:** `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID`,
`ADMIN_DISCORD_IDS`, `DATABASE_URL`. Everything above can be built and tested against
PGlite without them; only the live sign-in flow needs the real values.

**Known dev-only gotcha:** `next dev` runs route handlers in a different process from page
renders, and PGlite lives inside whichever process opened it — so a row written by an
`/api/*` route is invisible to pages until the server restarts. Anything that writes to
Postgres and expects a page to see it must be a server action, not a route handler. Neon
makes the problem disappear, since then there is one real database.

## Phase 2 — events and applications `[ ]`

- [ ] Events, event days, event templates
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
