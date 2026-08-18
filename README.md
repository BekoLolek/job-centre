# Job Centre Events

The events site for the Job Centre Discord. It runs whatever the community runs — Marvel
Rivals tournaments, casual 6v6, Jackbox nights, REPO — from sign-ups through to a bracket
and a permanent record of who won and what they cost.

You sign in with Discord. There are no passwords to hand out.

## Routes

| Route | Access | What it is |
| --- | --- | --- |
| `/` | Public | Hub: live now, next up, recent results |
| `/events`, `/events/[slug]` | Public | Every event; teams, schedule, bracket and results as tabs |
| `/events/[slug]/apply` | Members | The application form |
| `/events/[slug]/draft` | Public to watch, captains bid | The live auction draft room |
| `/players/[handle]` | Public | A player: events, teams, what they went for, what they won |
| `/me`, `/me/profile`, `/me/events` | Members | Your profile, applications, availability |
| `/admin` | Admin | What needs attention tonight; every line links to the fix |
| `/admin/events`, `/admin/games` | Admin | Everything that creates or records |
| `/admin/audit`, `/admin/settings` | Admin | Who did what; which announcements fire |
| `/signin` | — | Discord sign-in |

## How an event works

1. **Create it** from the admin editor: basics, days, an application form, entry rules.
   Adding a new *kind* of event is a template row, not a code change.
2. **People apply.** Questions can be linked to their profile, so a returning member
   applies in three taps and types nothing. Places are first come, with a waitlist that
   promotes automatically when somebody withdraws.
3. **Rank gates**, if you want them: a minimum to enter and a minimum to captain, compared
   against a position in that game's rank ladder rather than a typed string. They are
   guidance — an admin can accept someone below the bar deliberately.
4. **Pick captains and draft.** 2–8 teams. Captains bid; only the admin sees the amounts
   until a lot settles, and then only the winning price becomes public. Every lot and bid
   is a row, so the prices survive forever.
5. **Generate the bracket.** Single elim, double elim, round robin, or groups into a
   playoff, for any team count from 2 to 8, with byes falling where they should. Series
   lengths, map and mode sequences, bronze handling and the bracket reset are all settings.
6. **Schedule it** across up to four days. Give each day a start time and it works out the
   running order; record a result and the rest of that day re-flows from when the match
   actually finished.
7. **Record results** — maps, referees, scores, times. Nothing is ever deleted.
8. **Finish it**, and it becomes read-only. A `complete` event refuses every write that
   could erase a result, a roster or a price — no regenerating its bracket, no clearing
   its results, no re-seeding its draft pool. The way back is one status change, and it
   is in the audit log. See `src/lib/archive-policy.ts`.

## Times

Every instant is stored in UTC and rendered in the reader's own timezone, which the page
states. **Never format an instant in a server component** — the server does not know the
reader's zone, and `suppressHydrationWarning` will not save you: it leaves the server's
string in the DOM while React believes it holds the client's. Use `LocalTime`
(`src/components/format/`) or `EventDateRange` (`src/components/events/`), both of which
re-key on mount.

## Development

```bash
npm install
npm run dev          # http://localhost:3400
npm test             # 1549 tests
npm run typecheck
```

With no `DATABASE_URL` the app runs on **PGlite** — real Postgres compiled to WebAssembly,
persisted in `./data/pg` — so nothing external is needed to develop or test. Set
`DATABASE_URL` and it switches to Neon with no other change.

```bash
npm run db:migrate   # apply ./drizzle
npm run db:seed      # games, profile fields, guild-gate settings
npm run db:studio
```

### Migrations run on build

`npm run build` applies pending migrations before `next build`, so a deploy can never
serve code against a schema that is behind it. That failure is worse than it sounds: Auth.js
collapses any adapter error into a generic "configuration" message, so a missing column
reads as "check your client id and secret" and sends you looking in the wrong place. A bad
migration now fails the deploy instead, before anyone is served.

**This means a local `npm run build` migrates whatever `DATABASE_URL` points at.** If that
is production, the build applies pending migrations to production. Use `npm run build:only`
to compile without touching a database.

Discord sign-in needs a real application; see `docs/checklist.md` for the by-hand setup.
Without it, `/dev-login` mints a real session locally — it requires `NODE_ENV=development`
**and** `DEV_LOGIN=1`, and cannot exist in a deployment.

## Layout

```
src/app/          routes: public, member, admin
src/components/   ui/ (the kit) · events/ · draft/ · format/ · profile/ · admin/
src/db/           Drizzle schema, driver, migrations, seed
src/lib/          the rules: events, draft, bracket, format, auth, profiles
docs/             platform-plan.md (what and why) · checklist.md (what is done)
```

Business rules live in `src/lib` as pure functions with the data layer beside them.
Components display; they never decide. If a page computes what a captain may bid, that is
a bug.

Two things belong in the action layer and nowhere else, because it is the only layer that
knows *who is acting*: the audit log's inserts (`recordAudit`) and the Discord
announcements (`announce*`). Both run only after the library has said `ok`, and neither
can fail the thing it describes — the announcers return `void` and do their work after the
response has gone out.

## Announcements

Optional. Set `DISCORD_WEBHOOK_URL` and pick which of the five kinds fire at
`/admin/settings`. Unset, the whole feature is an inert no-op that never even reads a
setting. A post that fails is written to `/admin/audit` rather than swallowed, and can
never affect the action that triggered it.
