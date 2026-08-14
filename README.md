# Tournament Draft

A four-team Marvel Rivals tournament in two halves: an auction draft to pick the rosters,
then a results board tracking the round robin and double-elimination bracket.

| Route | Access | What it is |
| --- | --- | --- |
| `/` | Public, no login | Read-only overview: up next, standings, fixtures, bracket |
| `/draft` | Captains, admin, observer | The live auction draft board |
| `/draft/schedule` | Admin only | Results and schedule entry |
| `/login` | — | Sign-in |

The root board is read-only for everyone, including the admin — it just gains a link
across to `/draft/schedule`. Captains and the observer who try that URL are sent back to
the public board.

## Tournament format

- **Round robin** — every team plays every other once, a single convoy/convergence map.
  Draws are allowed. 3 points a win, 1 a draw. Ties break on a mini-league among the level
  teams, then map differential, then maps won; the admin can override the seeds outright.
- **Double elimination** — seeds 1v4 and 2v3 in the upper semis. Every series is Bo3 with
  games 1–2 on convoy/convergence and the decider on domination.
- **Lower final doubles as the bronze match** (Bo3). Its loser is 3rd, its winner goes to
  the grand final. Lower round 1's loser is 4th.
- **Grand final** is Bo5 — four convoy/convergence maps and a domination decider. No
  bracket reset: the lower-bracket team wins the title outright.

The bracket fills itself in as results land. Slots that are still waiting show where their
team will come from — *Seed 1*, *Upper semi 2 loser*, *Lower round 1 winner* — rather than a
blank. If a series ends level (a drawn decider), the board flags it as *needs a winner* and
waits for the admin to pick one.

### Admin controls at `/draft/schedule`

Every match card gains a **Record result** panel: scheduled start,
duration in minutes, and per game a map name, a referee and both scores. Typing a score
marks that game as played. Referees are per game, so a Bo3 can have a different one each
map; the match header lists them, and each game is attributed individually only when a
series had more than one. Below the bracket:

- **Schedule** — set the four lengths that drive everything (convoy/convergence map,
  domination map, break between games in a series, break between series), give each day a
  start time, and it walks both days block by block. Matches that run in parallel share a
  start time, so a block lasts as long as its slowest series. A live preview shows every
  block's clock time and both day totals before you commit; *Save lengths only* stores the
  timings without touching existing start times. Defaults are 30 / 15 / 5 / 10 minutes.
- **Seeding** — override the computed seeds when the tiebreakers leave teams level.
- The schedule keeps itself honest as the day runs — see below.
- **Reset tournament** — clears results, schedule and seeds. Rosters are untouched.

### The schedule re-flows itself

Recording a result stamps the match as finished at that moment, and fills in its duration
from the scheduled start if you left the field blank. Type a duration yourself and that
wins — useful for entering a match after the fact.

Matches in a block run in parallel, so the block is only over once the *slowest* of them
finishes: if one team is done in 26 minutes and the other in 31, the break starts at 31.
Every later block that day then shifts with it, using recorded finishes where they exist
and planned lengths where they don't. Running early pulls the day forward just the same.

Days are independent — day 1 overrunning never moves day 2, which keeps its own start
time. Clearing a result puts the day back on its planned estimate, and a match that has
already been played keeps the slot it actually ran in even if you re-run the auto-fill.

### Time zones

Start times are stored as absolute instants (UTC) and rendered in each viewer's own zone,
detected from their browser — a match entered as 18:00 CEST shows as 17:00 to someone in
the UK and 12:00 on the US east coast. The board states which zone it is showing, and the
admin panel states which zone you are typing in, so nothing is ambiguous. Durations are
plain minutes, so the auto-fill stays correct across a daylight-saving change.

## The draft

Live auction-draft board. One shared wheel of players, four captains placing sealed bids,
one admin running the room.

## How a lot works

1. **Admin spins** the wheel. Every browser animates the same spin off the same server
   timestamp, so all five people see it land at the same moment on the same name.
2. **Bidding opens** automatically when the wheel stops. Each captain types a whole number
   up to their balance and submits. A green check appears next to their team — the amount
   stays hidden.
3. **Admin resolves** the lot, three possible outcomes:
   - **Award** to a captain: that captain's bid is deducted, the player joins their roster,
     and the winning amount becomes public in the results feed. Losing bids are never shown.
   - **Take off the list**: player is removed entirely, nobody pays.
   - **Move to reserve wheel**: player goes into a second wheel only the admin can see.
     Switch the active wheel to *Reserve* later to draft those players with the same flow.

`Undo` reverses the last resolved lot (refunds the money, puts the player back).

## Accounts

Six accounts, all set through env vars — there is no sign-up:

| Role | Env vars | Sees |
| --- | --- | --- |
| Admin | `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Everything, including live bid amounts and the reserve wheel |
| Captain 1–4 | `CAPTAIN{n}_USERNAME`, `CAPTAIN{n}_PASSWORD` | Wheel, balances, who has bid, own bid, winning amounts |
| Observer | `OBSERVER_USERNAME`, `OBSERVER_PASSWORD` | Same as a captain minus the bid box — read-only |

Dev defaults when the env vars are unset: `admin/admin`, `observer/watch`, and
`captain1/draft1` … `captain4/draft4`. Set real values before you deploy.

**Team names come from the login name.** A captain who signs in as `lolek` is
`Team lolek` on the board, in the results feed and in the admin panel. Rename a team by
changing `CAPTAIN{n}_USERNAME` — it takes effect on the next request, no reset needed.

## Local development

```bash
npm install
cp .env.example .env.local   # optional — defaults work out of the box
npm run dev
```

State is written to `./data/draft.json` (gitignored) when no Redis env vars are present.

## Deploying to Vercel

1. Push the repo and import it in Vercel.
2. Storage → add the **Upstash for Redis** integration. It injects `KV_REST_API_URL` and
   `KV_REST_API_TOKEN`; `src/lib/storage.ts` picks them up automatically. Writes take a
   short-lived lock so two simultaneous bids can't clobber each other.
3. Add the account env vars plus `SESSION_SECRET` (a long random string) and optionally
   `DEFAULT_BALANCE`.
4. Deploy.

Without Redis on Vercel the app still boots, but serverless instances don't share a
filesystem — captains would each see their own copy of the draft. Add the integration.

## Admin setup panel

Right-hand rail, **Setup** tab:

- **Player pool** — paste one name per line, then *Add* (append) or *Replace* (swap the
  whole main wheel). Names already drafted or held in reserve are skipped. *Load current
  pool* pulls the live list back into the box for editing.
- **Starting balances** — set each team's balance at any time. Team names are read-only
  here; they follow the captain's login name.
- **Reset draft** — clears rosters, bids and history, returns every player to the main
  wheel and restores `DEFAULT_BALANCE`.

The **Pools** tab lists the main and reserve wheels; hover a row to remove a player.

## Notes

- Bids are whole numbers from `0` up to and including the captain's full balance — bidding
  everything is allowed. A bid of `0` is effectively a pass.
- A captain's bid locks once submitted; the admin can clear it (per-team or all) to reopen.
- The admin can award before all four bids are in — useful if someone drops out.

## Stack

Next.js 15 (App Router) · TypeScript · Tailwind · Upstash Redis or local JSON.
