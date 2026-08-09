# Tournament Draft

Live auction-draft board for a four-team tournament. One shared wheel of players, four
captains placing sealed bids, one admin running the room.

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

Five accounts, all set through env vars — there is no sign-up:

| Role | Env vars |
| --- | --- |
| Admin | `ADMIN_USERNAME`, `ADMIN_PASSWORD` |
| Captain 1–4 | `CAPTAIN{n}_USERNAME`, `CAPTAIN{n}_PASSWORD`, `CAPTAIN{n}_NAME` |

Without env vars the dev defaults are `admin/admin` and `captain1/draft1` … `captain4/draft4`.
Set real values before you deploy.

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
- **Teams & balances** — rename teams and set starting balances at any time.
- **Reset draft** — clears rosters, bids and history, returns every player to the main
  wheel and restores `DEFAULT_BALANCE`. Team names are kept.

The **Pools** tab lists the main and reserve wheels; hover a row to remove a player.

## Notes

- Bids are whole numbers from `0` up to and including the captain's full balance — bidding
  everything is allowed. A bid of `0` is effectively a pass.
- A captain's bid locks once submitted; the admin can clear it (per-team or all) to reopen.
- The admin can award before all four bids are in — useful if someone drops out.

## Stack

Next.js 15 (App Router) · TypeScript · Tailwind · Upstash Redis or local JSON.
