# Platform plan

Turning the single-purpose Marvel Rivals draft board into a community event platform:
Discord login, customisable events with applications, player profiles, and a much more
configurable tournament engine.

**Status: in build.** The open questions in §13 are answered; §15 tracks progress and what
is still needed from outside the repo.

The product is **Job Centre Events**. The repo is `BekoLolek/job-centre`.

---

## 1. What this replaced

Retired in Phase 4, once everything it did existed on Postgres. Kept here because the
reasoning still explains why the current design looks the way it does.

| Piece | Was | Became |
| --- | --- | --- |
| Auth | 6 accounts from env vars, signed cookie | Discord, guild-gated |
| Storage | One JSON blob in Upstash Redis or a local file | Postgres via Drizzle; PGlite locally |
| Tournament | One hardcoded 4-team double elim | Generated brackets, 2–8 teams, four formats |
| Draft | One wheel, 4 fixed captains, fixed rules | Lots and bids as rows; the admin picks captains |
| Pages | `/`, `/draft`, `/draft/schedule`, `/login` | Public hub, member and admin areas |

Three things were carried forward deliberately, because they solve problems the bigger
version hits harder, not less:

1. **Results resolve on read.** Bracket slots are derived from earlier results every time
   rather than written down, so correcting an old score re-propagates everything. The
   hardcoded six-slot table became generated `sourceA`/`sourceB` references; a parity test
   held both implementations side by side until the old one was deleted.
2. **The schedule re-flows from actual finish times.** Blocks end when their slowest match
   ends; later blocks that day shift automatically. Now over four days and any format.
3. **The visual language.** Anton / Familjen Grotesk / Azeret Mono on near-black with
   amber, ember and signal accents. It reads as a broadcast board, which is the point.

The wheel itself survives untouched: `src/components/Wheel.tsx` is the same component,
which is why the spin payload shape was kept identical through every rewrite.

---

## 2. Scope

**Public, no login**
- Hub: what's running right now, what's next, recent results
- Event pages: description, format, teams, schedule, bracket, results
- Event history / archive

**Members, Discord login**
- Profile with per-game persistent data (what used to live in Google Forms)
- Apply to events through a form the admin designed
- Availability per day/slot, and attendance confirmation closer to the date
- See own applications and their status

**Signing up must be clicks, not typing.** The Google Forms flow died of friction: the same
answers retyped every event, in prose, unvalidated. The replacement rule is that every
question is a choice — select, multi-select, toggle, stepper, rank picker, availability
chips — and free text appears only where it genuinely cannot be avoided (an in-game name,
an optional "anything else"). A returning player's application should be: check the
prefilled profile is still right, tap the days you can make, submit.

**Admin**
- Create events from templates: Rivals tournament, casual 6v6, Jackbox, REPO, anything
- Design the application form per event
- Review applicants, accept/waitlist/decline
- Choose captains, configure and run the bid draft
- Configure format: 2–8 teams, bracket shape, series lengths, map/mode rules
- Schedule across up to 4 days, with the live re-flow behaviour
- Record results: scores, maps, referees, times

---

## 3. Architectural decisions

Each of these has a recommendation. They are the load-bearing choices; the rest of the
plan assumes them.

### 3.1 Database — Neon Postgres + Drizzle ORM

The blob model is already awkward with one event. With many events, users, applications and
per-event teams it stops working: no querying, no partial updates, one lock for everything.

Neon is the Postgres option in Vercel's marketplace, serverless, free tier, and the
connection details are injected the same way Upstash's are today. **Drizzle** over Prisma:
TypeScript-native schema, no engine binary, no cold-start penalty, and migrations are plain
SQL you can read.

Redis does not disappear — it stays useful for the one thing it is good at here: the live
draft's hot state and a distributed lock during bidding. Optional; Postgres alone is fine
at this scale.

### 3.2 Auth — Auth.js (NextAuth v5) with the Discord provider

Discord login gives identity for free: a stable user id, display name, avatar. It also
removes the whole password-distribution problem.

- Session strategy: database sessions, so an admin can revoke access.
- Admin is a flag on the user row, seeded from a `ADMIN_DISCORD_IDS` env allowlist so the
  first admin can exist before there is an admin UI.
- **Guild-gated.** Sign-in requires membership of a configured Discord guild — the provider
  requests the `guilds` scope and anyone outside the server is rejected. The guild id and
  the gate itself are admin settings, not constants, so it can be relaxed or pointed at a
  different server without a deploy.
- Captains and participants are ordinary users with per-event roles, not accounts.

### 3.3 Keep one Next.js app

Public, member and admin areas are three route groups in one app, not three deployments.
Shared design system, shared types, one database, one deploy.

```
src/app/
  (public)/      no auth
  (member)/      requires a session
  (admin)/       requires an admin session
  api/
```

### 3.4 Data freshness

Polling everywhere at 1–4s does not scale to a busy public page. Tier it:

| Surface | Strategy |
| --- | --- |
| Live draft | Poll ~1s (or Redis pub/sub + SSE later) |
| Live match board, schedule | Poll ~5s |
| Event pages, profiles, history | Server-rendered, revalidate on mutation |
| Admin forms | Fetch on demand, no polling |

---

## 4. Information architecture

```
PUBLIC
/                         hub — live now, next up, recent results
/events                   all events, filterable, with a past/upcoming toggle
/events/[slug]            event overview: what, when, who, status
/events/[slug]/teams      rosters, captains, balances spent
/events/[slug]/schedule   day-by-day running order
/events/[slug]/bracket    bracket + standings
/events/[slug]/results    every match and game played
/players/[handle]         public profile: events played, teams, honours

MEMBER
/me                       dashboard: my next event, open applications, to-dos
/me/profile               identity + per-game profile data
/me/events                applications and their status, availability, confirmations
/events/[slug]/apply      the application form for this event
/events/[slug]/draft      the live draft room (captains bid, everyone else watches)

ADMIN
/admin                    what needs attention: pending applications, unscheduled matches
/admin/events             list + create
/admin/events/new         pick a template, then basics
/admin/events/[id]        tabbed editor (see §6.3)
/admin/templates          reusable event templates and their form + format defaults
/admin/users              members, admin flags, notes
```

Navigation: one top bar everywhere. Public links on the left, session menu on the right;
signed-in members get **My events**, admins get an extra **Admin** link. The admin area
adds a left sidebar for the sections above. No hamburger menus on desktop.

---

## 5. Visual system

Keep the existing language and formalise it so it survives twenty new pages.

**Tokens** (already largely in `globals.css` / `tailwind.config.ts`)

| Token | Use |
| --- | --- |
| `ink` `#0a0b0c` | Page ground |
| `panel` `#121417` / `raised` `#181b1f` | Surfaces |
| `hair` `#262b31` | Hairlines, the workhorse border |
| `chalk` `#f1ede4` | Primary text |
| `muted` `#8b9199` | Secondary text |
| `gold` `#e3b23c` | Money, winners, primary action |
| `ember` `#ff4d1c` | Live, destructive, urgent |
| `signal` `#3ddc84` | Confirmed, submitted, healthy |

**Type**: Anton for display (headings, team names, big numbers), Familjen Grotesk for body,
Azeret Mono for anything numeric or label-like (the `eyebrow` and `num` classes).

**Components to extract** into `src/components/ui/` — currently these patterns are copy-pasted
across the draft and tournament components:

`Panel` · `Button` (gold / ember / ghost) · `Field` (input, select, textarea, with label and
error) · `Table` · `Badge` · `Tabs` · `Modal` · `Toast` · `EmptyState` · `Avatar` ·
`StatTile` · `Countdown`

**New patterns the bigger site needs**

- **Event card** — banner strip, title, type badge, date range, status pill, signup counter.
  Used on the hub, the events list and the admin list.
- **Status pill** — `Draft` `Applications open` `Applications closed` `Live` `Complete`
  `Cancelled`, each with a fixed colour so status is readable at a glance.
- **Bracket canvas** — the current three-stacked-blocks layout does not survive 8 teams. A
  horizontally scrolling column layout with connector lines, one column per round, upper
  and lower bracket stacked. Must degrade to a vertical list on mobile.
- **Day tabs** — schedule split by day, since events can run four days.
- **Form builder** — admin side: drag to reorder questions, pick a type, mark required.

**Layout rules**: one content column, max 1400px, 24px gutters. Cards in a responsive grid
(1 / 2 / 3 columns). Sticky headers only for the top bar and the live-draft ticker. Dark
only — no light theme, it would fight the broadcast look for no benefit.

---

## 6. Page layouts

### 6.1 Public hub `/`

1. **Live now** — full-width panel, only when something is running. Current match, score,
   next up, link into the live board. This is the only thing that autoplays/polls.
2. **Next up** — the closest upcoming event, large card, countdown, and either an
   *Apply* button, an *Applications close in…* line, or *Applications closed*.
3. **Upcoming** — grid of event cards.
4. **Recent results** — last handful of completed events, each with its podium.
5. **History link** — into the archive.

When nothing is live, section 1 disappears and 2 becomes the hero. When nothing at all is
scheduled, the hero becomes a short "nothing on right now" panel with the archive below —
never an empty page.

### 6.2 Event page `/events/[slug]`

Header: title, type badge, status pill, date range, and the primary action for the current
viewer (Apply / Withdraw / You're in / Sign in to apply).

Then tabs: **Overview** · **Teams** · **Schedule** · **Bracket** · **Results**. Tabs only
appear once they have content — a Jackbox night never shows a bracket tab.

Overview holds the description, format summary in plain words ("8 teams, double elim, Bo3,
grand final Bo5, four days"), and the participant list.

### 6.3 Admin event editor `/admin/events/[id]`

Tabbed, saving each tab independently, with a publish gate:

| Tab | Contents |
| --- | --- |
| **Basics** | Title, slug, type, description, banner, signup window, visibility |
| **Form** | Application question builder |
| **Applicants** | Table with filters, bulk accept/waitlist/decline, answers inline |
| **Teams** | Team count (2–8), names, choose captains from accepted applicants |
| **Draft** | Draft rules, player pool, run the draft |
| **Format** | Bracket shape, series lengths, map/mode rules, bronze and reset options |
| **Schedule** | Days, start times, concurrent lobbies, auto-fill, live re-flow |
| **Results** | The match cards as they are today, scores/maps/referees/times |
| **Publish** | Checklist of what's missing, then make it public |

A **preview as public** toggle on every tab, so you can see what everyone else sees.

---

## 7. Data model

Postgres. `id` is a uuid unless noted; timestamps are `timestamptz`, always absolute
instants — the timezone lesson from the current build applies everywhere.

**Identity**

| Table | Key columns |
| --- | --- |
| `users` | `discord_id` unique, `username`, `display_name`, `avatar_url`, `is_admin`, `created_at`, `last_seen_at` |
| `sessions` | Auth.js managed |
| `user_notes` | admin-only free text about a member |

**Profiles**

| Table | Key columns |
| --- | --- |
| `games` | `key` unique, `name`, `sort`, `is_active`, `rank_ladder` jsonb — an ordered list of ranks, lowest first. Empty for games without ranks, like Jackbox. |
| `profile_fields` | `game_id` (null means a global field), `key`, `label`, `type`, `options` jsonb, `required`, `sort` |
| `profile_values` | `user_id`, `field_id`, `value` jsonb, `updated_at` — unique on (user, field) |

`type` is deliberately click-first: `select`, `multiselect`, `rank`, `bool`, `number`, and
`text` only as a last resort. A `rank` field reads its options from the game's
`rank_ladder`, which is what makes the entry thresholds in §8.3 a comparison of two
positions rather than string-matching someone's typed guess at their own rank.

Admin-defined fields, so "what's your rank", "preferred role", "in-game name" are data, not
code. They persist across events and pre-fill application forms, which is exactly what the
Google Forms flow could never do.

**Events**

| Table | Key columns |
| --- | --- |
| `event_templates` | `name`, `type`, default `config` jsonb, default questions |
| `events` | `slug` unique, `title`, `type`, `status`, `description`, `banner_url`, `signup_opens_at`, `signup_closes_at`, `starts_at`, `ends_at`, `config` jsonb, `created_by` |
| `event_days` | `event_id`, `day_index` (0–3), `starts_at`, `label` |
| `event_questions` | `event_id`, `key`, `label`, `type`, `options`, `required`, `sort` |
| `applications` | `event_id`, `user_id`, `status` (applied/accepted/waitlisted/declined/withdrawn), `answers` jsonb, `submitted_at`, `decided_at`, `decided_by` — unique on (event, user) |
| `availability` | `application_id`, `event_day_id`, `state` (yes/maybe/no), `note` |
| `confirmations` | `application_id`, `confirmed_at`, `state` (in/out) |

**Teams and draft**

| Table | Key columns |
| --- | --- |
| `teams` | `event_id`, `name`, `captain_user_id`, `seed`, `balance_start`, `balance_left`, `sort` |
| `team_members` | `team_id`, `user_id`, `price`, `acquired_at`, `is_captain` |
| `draft_pools` | `event_id`, `kind` (main/reserve), ordered `user_ids` |
| `draft_lots` | `event_id`, `player_user_id`, `status`, `opened_at`, `closed_at`, `winner_team_id`, `price` |
| `draft_bids` | `lot_id`, `team_id`, `amount`, `placed_at` — unique on (lot, team) |

Modelling the draft as *lots* rather than one mutable blob means history, undo and audit come
for free, and a mis-click is a row to delete rather than a state to reconstruct.

**Competition**

| Table | Key columns |
| --- | --- |
| `stages` | `event_id`, `kind` (round_robin / single_elim / double_elim / swiss), `sort`, `config` jsonb |
| `matches` | `stage_id`, `slot` (e.g. `ubsf1`, `rr-1-4`), `round`, `phase`, `best_of`, `team_a_id`, `team_b_id`, `source_a`, `source_b`, `scheduled_at`, `finished_at`, `duration_min`, `winner_override_id` |
| `games` | `match_id`, `index`, `mode`, `map`, `referee`, `score_a`, `score_b`, `played` |

`source_a` / `source_b` describe where a slot's team comes from (`seed:1`, `winner:ubsf1`,
`loser:ubf`). That is what makes resolve-on-read work for any bracket shape, and what powers
the placeholder labels already on the board.

---

## 8. Event types and the format engine

### 8.1 Event types

An event type is a **capability set**, not a hardcoded page:

| Type | Teams? | Draft? | Bracket? | Notes |
| --- | --- | --- | --- | --- |
| Rivals tournament | Yes, 2–8 | Optional | Yes | The full machine |
| Casual 6v6 | Yes, 2 | Optional | No | Just a roster and a time |
| Jackbox | No | No | No | Signup + availability only |
| REPO | No | No | No | Same |
| Custom | Configurable | Configurable | Configurable | Escape hatch |

The event page renders only the tabs the capability set enables. Adding a type later should
mean adding a template row, not a code branch.

### 8.2 Bracket generation, 2–8 teams

Given a team count and a format, generate matches with `source` references — no hand-written
bracket per size.

- **Single elimination**: next power of two, byes to the top seeds. 5 teams → seeds 1–3 get
  a bye into the quarters.
- **Double elimination**: standard upper/lower construction for 2–8. Losers drop into the
  lower round matching their exit round.
- **Round robin**: every pair once (or twice), scheduled into rounds so nobody plays twice
  in a round — the current 4-team pairing is the n=4 case of a standard circle rotation.
- **Group → playoff**: round robin, then top N into a bracket.

Series length is configurable per stage *and* per round, so "everything Bo3, grand final
Bo5" is data. Same for map/mode rules: an ordered list per series length, e.g.
`[convoy, convoy, domination]`, with a configurable map pool per mode.

Options that are currently hardcoded and become settings: bronze match (none / lower final
doubles as bronze / separate match), bracket reset on/off, and round-robin points and
tiebreakers.

### 8.3 Entry requirements

Two thresholds, both per event, both optional:

- **Minimum rank to enter** — provisionally Platinum 3.
- **Minimum rank to captain** — provisionally Diamond 2.

Neither number is settled, which is precisely why they are settings rather than constants.
They work because rank is structured data: each game carries an ordered `rankLadder`, a
player's rank is a picker on their profile rather than a typed string, and eligibility is
therefore a comparison of two positions in that list. The application form can then say
"you need Platinum 3 for this one" before someone wastes their time, and the captain
dropdown can grey out anyone below the captain threshold.

Two things to get right when it is built:

- Ranks drift. A stored rank is a claim made on some past date, so the signup step should
  show it back and ask "still right?" rather than trusting it silently.
- An admin override must exist. Gates are guidance, not a wall — sometimes you want the
  Gold player who is filling in for a mate.

### 8.4 Map selection — proposed, not decided

**Held pending feedback from the group. Not in any phase.**

The idea: teams alternate bans from the mode's map pool, and whichever team did *not* ban
first picks the map from what remains. It trades away pure randomness for agency, and it
gives the second banner something back for going second.

If it goes ahead, the shape is roughly: a map pool per mode attached to the game, a veto
sequence per series length (`ban, ban, pick` for a Bo3 decider; longer for a Bo5), a rule
for who bans first (higher seed, or a coin flip), and the recorded map per game becoming
the output of the veto rather than something the admin types in afterwards.

Worth deciding before building: does the veto happen live in the app — which means another
real-time surface, like the draft room — or offline in Discord with the admin recording the
result? The offline version is a fraction of the work and probably where to start.

### 8.5 What carries over

`resolveMatches` already does the right thing — it just needs its hardcoded six-slot table
replaced by generated slots. `standingsFor`, the mini-league tiebreak, and the drawn-series
"needs a winner" flag are all format-agnostic already.

---

## 9. Draft v2

Today: four fixed captains, one wheel, sealed bids, admin awards.

Configurable per event:

- **Captains** — admin picks any accepted applicants, one per team. A captain can be in the
  draft pool or not (their choice of model — worth deciding).
- **Balances** — uniform, or per captain (handicapping).
- **Selection** — wheel, admin picks the next player, or a fixed order.
- **Bidding** — sealed (today) or open with a minimum increment; a bid timer, optional.
- **Reserve pool** — on/off, plus how many rounds it holds.
- **Roster limits** — target size, and whether a captain must keep enough balance to fill
  their roster (blind-bid protection).
- **Visibility** — who sees amounts, and when.

The wheel component survives as-is; it already handles arbitrary pool sizes and radial
labels.

---

## 10. Scheduling v2

Generalise what exists:

- **Up to 4 days**, each with its own start time. Days remain independent — one overrunning
  never moves another.
- **Concurrent lobbies** becomes a setting (currently an implicit 2). It determines how many
  matches share a start time, which drives the whole block plan.
- **Blocks** are generated from the format rather than a hardcoded phase list.
- The **live re-flow** logic stays exactly as built: a block ends when its slowest match
  finishes, the break runs from there, everything later that day shifts.
- The **preview** (per-block clock windows plus day totals) extends to four days.

---

## 11. Permissions

| Action | Public | Member | Applicant | Captain | Admin |
| --- | --- | --- | --- | --- | --- |
| View published events, results, brackets | ✓ | ✓ | ✓ | ✓ | ✓ |
| View draft events | | | | | ✓ |
| Apply to an event | | ✓ | | | |
| Set own availability / confirm | | | ✓ | ✓ | |
| Watch the live draft | ✓ | ✓ | ✓ | ✓ | ✓ |
| Place a bid | | | | ✓ | |
| See bid amounts before a lot settles | | | | | ✓ |
| Record results, run the draft, edit events | | | | | ✓ |

---

## 12. Build phases

Each phase should end deployable, not half-migrated.

**Phase 0 — foundations**
Repo structure, route groups, extract the `ui/` component library from what exists, keep the
current board working against the old storage.

**Phase 1 — identity**
Neon + Drizzle, Auth.js with Discord, `users`, admin allowlist, `/me/profile`, admin-defined
profile fields. Retire the env-var accounts.

**Phase 2 — events and applications**
Events, templates, the form builder, applications, availability, confirmations. Public hub,
events list, event page, archive. This is the phase that replaces Google Forms.

**Phase 3 — teams and draft**
Teams, captains chosen by admin, draft configuration, port the draft room onto the new
tables.

**Phase 4 — format engine**
Bracket generation for 2–8 teams, configurable stages and series, port the results board and
the scheduler onto it. Multi-day.

**Phase 5 — polish**
Discord webhook announcements, public player profiles, admin dashboard, an audit log.

Phases 1 and 2 are the ones that change how the community actually uses the thing. Phase 4
is the largest chunk of code but the least risky, because the logic it generalises is
already written and tested.

---

## 13. Open questions

Answers to these change the plan, so worth settling before Phase 1.

1. **Guild-gated login?** Restrict sign-in to members of a specific Discord server, or let
   anyone with a Discord account in? (Recommend: guild-gated.): Guild gated, can be changed and customized in admin
2. **Are captains also draftable?** Does a captain occupy a roster slot, or sit outside the
   pool entirely?: they do the drafting so they are already in the team
3. **Applications: approval or open?** Should the default be admin-approved, or first-come
   with a cap and a waitlist? Both are supportable; which is the default?: first come with waitlist
4. **Profile data scope.** Per game (`rivals`, `jackbox`) or one flat profile? Per game is
   more work but stops a Jackbox night asking for your Rivals rank.: per game. As an admin I want to be able to add a new game and say what I want info I want from players
5. **Does an event need a real name/brand for the site itself?** The header currently says
   "Marvel Rivals Tournament", which stops making sense once it hosts Jackbox nights.: Discord server name is Job Centre, so lets call it Job Centre Events
6. **Discord notifications** — announce new events, application decisions and match results
   to a channel via webhook? Cheap to add, high value.: good to have an integration
7. **Repo**: keep pushing to `tournament-draft`, or start a new repo with a name that fits?
   The folder is now `Job Centre/Website`, which suggests a rename is due.: keep repo, but rename it to Job Centre

---

## 14. Consequences of the answers

Folding §13 back into the design:

- **Guild-gated sign-in**, configurable in admin — see §3.2. Adds a `settings` table (or a
  single-row config) for the guild id and the gate toggle.
- **Captains occupy a roster slot.** A captain is a `team_members` row with
  `is_captain = true` and `price = 0`; they never enter the draft pool. Roster-size limits
  and any "keep enough balance to fill your roster" rule must count the captain.
- **First-come with a waitlist** is the default application mode. `applications.status`
  gains an ordering rule: accepted until the cap is reached, then `waitlisted` in
  submission order, with automatic promotion when someone withdraws. Admin approval stays
  available as a per-event switch.
- **Per-game profiles, with admin-defined games.** `profile_fields.game_id` is not an enum —
  it points at a `games` table the admin can add rows to. Creating "Jackbox" and giving it
  three questions is a UI action, not a migration.
- **Discord notifications** are in scope (Phase 5): new event published, application
  accepted/waitlisted, match result recorded. Outgoing webhook, no bot to host.

## 15. Progress and prerequisites

Tracked in detail in [checklist.md](./checklist.md); the summary lives here.

**Phase 0 — done.** Vitest with 236 tests over the existing logic, `src/components/ui/`
extracted, rebrand to Job Centre Events, repo renamed to `job-centre`. The suite caught two
real scheduling bugs, both fixed with regression tests.

**Phase 1 — done bar the credentials.** Schema, migrations, Discord auth with the guild
gate, `/me/profile` and `/admin/games`. Local development and tests run on PGlite (Postgres
compiled to WASM), so the whole phase was built and tested without a cloud account; the same
schema points at Neon in production by setting one variable. A development-only sign-in
(`/dev-login`, gated on `NODE_ENV=development` **and** `DEV_LOGIN=1`) stands in for Discord
until the application below exists.

**Phase 2 — done.** Events, days, questions and the admin editor; then the public side and
the member flow: the hub, `/events`, `/events/[slug]`, `/events/[slug]/apply`, `/me` and
`/me/events`. The old tournament board moved to `/board` unchanged. The application is the
part that mattered: prefilled from the profile, confirmed in one tap, availability as day
chips, one submit — three taps for a returning member, and the rank gate is shown before the
form rather than after it. Waitlisting, automatic promotion on withdrawal, availability and
attendance confirmation are all live.

**Still needed from outside the repo** — only the live sign-in flow depends on these:
1. A **Discord application**: client id, client secret, and the guild id to gate against.
   Register the redirect URI for `http://localhost:3400`, and for the Vercel URL once it
   exists. No custom domain for now.
2. A **Neon connection string** as `DATABASE_URL`. Absent it, everything falls back to
   PGlite on disk, which is fine for development but not for a deployment.
