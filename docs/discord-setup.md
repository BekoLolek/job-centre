# Discord announcements — what has to be configured, and where

## Short answer: a webhook, which you already have

**A webhook does everything, including `@role` and `@everyone`.** No bot, and no bot token,
is required for any of it.

| What you want | What it needs |
|---|---|
| Post to the channel | the **webhook** already in admin settings |
| `@everyone` | the webhook alone — it has no id, it is a flag on the payload |
| `@role` | the webhook alone, given the role's numeric id |
| A **dropdown** of your roles rather than pasting an id | a bot token — convenience only |

The one real constraint is that Discord needs the numeric form for a role ping —
`<@&123456789…>`, not `@Members`, which renders as grey text and pings nobody. You can get that
yourself: Discord → Settings → Advanced → **Developer Mode**, then right-click the role →
**Copy Role ID**. Paste it in and the webhook pings it identically.

So the bot token buys a picker, not a capability. It is worth setting eventually because a
mistyped id silently pings nobody, but **nothing is blocked without it** and the screen says so
rather than failing.

And "bot" in the sense of a *hosted, always-on process connected to Discord's gateway* is not
needed at all, and is out of scope in `docs/requirements.md`. The site makes outbound HTTP calls
and never listens for anything.

---

The announcement features (R-201 to R-208, Tasks 59 to 64) are built to stay **inert until
configured**, the same way `src/lib/discord-dm.ts` is inert until it has a bot token. Nothing
below breaks the site by being absent; each one disables a feature and says so on screen.

This file exists because three of these are secrets that cannot be set from the code, and the
Constraints in `docs/requirements.md` say secrets never reach the browser, the settings screen
or the audit log. They are set by hand, once.

## 1. The webhook — already working

Set in the admin settings screen, stored in `settings` under `discord.webhook`, shown **masked**.
This is what posts to the channel, and it is what the seven existing announcements already use.
Nothing to do unless you are moving channels.

A webhook posts *as* a webhook, not as a bot user. That is deliberate and is why the
"no hosted bot process" line in `docs/requirements.md`'s Out of scope still holds: the site
makes outbound HTTP calls and never connects to Discord's gateway or listens for anything.

## 2. `DISCORD_BOT_TOKEN` — needed for the role picker, and already used for DMs

**Where:** Vercel project → Settings → Environment Variables. Not in `.env.local`, and never
committed.

**Why it is needed:** a role mention on Discord is `<@&123456789…>`, the role's numeric id.
Typing `@Members` into a message renders as grey text and pings nobody. A webhook cannot list
the server's roles, so the only way to offer a picker is one authenticated read:
`GET /guilds/{guild_id}/roles` with a bot token.

**What the bot needs:** to be a member of the server. No privileged gateway intents, no
permissions beyond reading the role list, and no process running anywhere.

**Without it:** the role picker is replaced by a "paste a role id" box and the screen says why.
Everything else works, including `@everyone`, which needs no id.

## 3. The guild id — nothing to set

**Already stored, and already editable by you.** `settings` holds it under `auth.guild_id`
(`src/db/schema.ts`), because the sign-in gate needs it and R-03 says an admin must be able to
change which server gates sign-in without a developer. It is on the admin settings screen.

Task 61 reads **that** rather than introducing a `DISCORD_GUILD_ID` environment variable, for
the reason the schema comment already gives: the guild id is an admin setting, not a constant.
Adding an env var for the same fact would mean two sources of truth that disagree the first time
you move servers — and the one you could edit would be the one that did not take effect.

So this is one fewer thing to configure than it first looked.

## 4. `CRON_SECRET` — needed for the two timed reminders

**Where:** two places, and they must match.
- Vercel → Environment Variables (it is probably already set — `/api/cron/reminders` fails
  closed without it today).
- GitHub → repo Settings → Secrets and variables → Actions → New repository secret.

**Why GitHub too:** Vercel Hobby runs a cron job **at most once a day**, which
`docs/requirements.md` carries as a constraint and `vercel.json` shows as `0 12 * * *`. A daily
run at noon cannot fire a reminder two hours before an 8pm event. So a GitHub Actions workflow
pings the same endpoint every 15 minutes, and the Vercel daily run stays as a backstop.

The endpoint already refuses every request without the secret, which is what makes a public URL
safe to ping on a schedule.

**Without it:** the workflow's calls are refused and the timed reminders never fire. The
announcements that post on an event (published, signups open, decisions, results) are unaffected
— they are not scheduled.

## What is *not* needed

- No bot hosting, no always-on process, no gateway connection, no slash commands. Direct
  messages are sent, never received (`docs/requirements.md`, Out of scope).
- No Vercel upgrade. The GitHub Actions workflow is the free path to sub-daily scheduling.
- No new OAuth scopes on the existing Discord application.

## The one thing to know about mentions

Interpolated values — a member's display name, an event title — are rendered into the **embed**,
and Discord does not parse mentions inside an embed at all. The mention line is built solely
from the wording you save, and `allowed_mentions` names the exact role ids that wording used.

That is not a detail: it is the reason a member can rename themselves `@everyone` without being
able to make the site ping the server. `src/lib/announce.ts` carried
`allowed_mentions: { parse: [] }` precisely because that hole existed before mentions were
possible at all. If you ever edit that payload by hand, keep the split.
