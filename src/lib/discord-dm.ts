/**
 * Direct messages to a member on Discord.
 *
 * ## Why this is not the webhook
 *
 * The announcements this site already sends go to a *channel*, through a
 * webhook URL — a single secret, no application, no permissions. A direct
 * message cannot work that way. Discord will only deliver one from a **bot**,
 * which means a bot application, its own token, and the bot being in the same
 * server as the person. There is no webhook shortcut and there is no way to
 * make one; it is a different API with a different credential.
 *
 * So this whole module is inert until `DISCORD_BOT_TOKEN` exists, exactly as
 * announcements are inert without a webhook. Nothing throws, nothing warns on
 * every request, and no caller branches — there is simply nowhere to send.
 *
 * ## What "sent" is worth
 *
 * Not much, and the screen says so. Discord silently refuses a DM when the
 * recipient has "allow direct messages from server members" switched off,
 * which is a per-server privacy setting most people never look at and some
 * communities turn off by default. A `false` from here means we could not
 * deliver; a `true` means Discord accepted it, which is not quite the same as
 * somebody reading it. That is the ceiling of what any bot can promise.
 */

const API = "https://discord.com/api/v10";
const TIMEOUT_MS = 5_000;

export type DirectMessage = {
  title: string;
  body: string | null;
  /** A path on this site. Made absolute against the configured origin. */
  href: string | null;
  /** The notification's dedupe key, for the log line only. */
  key: string;
};

export type DmEnv = {
  DISCORD_BOT_TOKEN?: string;
};

/** The token, or `null` — which switches the whole feature off. */
export function botToken(env: DmEnv = process.env as DmEnv): string | null {
  const raw = (env.DISCORD_BOT_TOKEN ?? "").trim();
  return raw.length > 0 ? raw : null;
}

/** Whether direct messages can be sent at all, for the preferences screen. */
export function directMessagesConfigured(env: DmEnv = process.env as DmEnv): boolean {
  return botToken(env) !== null;
}

/**
 * Open a DM channel with somebody and post to it.
 *
 * Two calls, because Discord has no "message this user" endpoint: you ask for
 * a channel with them and then post to the channel. The channel is reused by
 * Discord, so asking again is cheap and there is nothing worth caching here.
 *
 * Never throws. A member's notification is already on the site by the time
 * this runs, and a Discord outage is not a reason to fail anything.
 */
export async function sendDirectMessage(
  discordId: string,
  message: DirectMessage,
  env: DmEnv = process.env as DmEnv
): Promise<boolean> {
  const token = botToken(env);
  if (!token) return false;

  try {
    const channel = await fetch(`${API}/users/@me/channels`, {
      method: "POST",
      headers: {
        authorization: `Bot ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ recipient_id: discordId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });

    if (!channel.ok) {
      // 403 here is the ordinary case, not an error: they do not accept DMs.
      console.error(
        `[discord-dm] could not open a channel (${channel.status}) for ${message.key}`
      );
      return false;
    }

    const { id } = (await channel.json()) as { id?: string };
    if (!id) return false;

    const posted = await fetch(`${API}/channels/${id}/messages`, {
      method: "POST",
      headers: {
        authorization: `Bot ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ content: render(message) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });

    if (!posted.ok) {
      console.error(`[discord-dm] ${posted.status} sending ${message.key}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[discord-dm] could not reach Discord", error);
    return false;
  }
}

/**
 * The message body.
 *
 * Plain text rather than an embed. An embed in a DM from a bot reads as
 * marketing; a sentence and a link reads as somebody telling you something,
 * which is what this is.
 */
export function render(message: DirectMessage, origin?: string | null): string {
  const lines = [`**${message.title}**`];
  if (message.body) lines.push(message.body);
  if (message.href) {
    lines.push(origin ? `${origin}${message.href}` : message.href);
  }
  return lines.join("\n");
}
