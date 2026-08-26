"use client";

import { useState } from "react";
import { Alert, Badge, Button, Field, Icon, Section, cx } from "@/components/ui";
import {
  saveGuildGateAction,
  saveIntegrationsAction,
} from "@/app/admin/settings/actions";

/**
 * The configuration an admin may change without a deploy.
 *
 * Everything here already lived in an environment variable, and every one of
 * them still does — the settings table *overrides* the environment rather than
 * replacing it. That order is what makes this safe to ship: an install that
 * has never opened this screen behaves exactly as it did, a database that
 * cannot be read falls back to the deployment, and clearing a field here is an
 * absence of opinion rather than an instruction to switch the feature off.
 *
 * ## What is not here, and will not be
 *
 * `DISCORD_CLIENT_SECRET`, `AUTH_SECRET` and `DATABASE_URL` are credentials
 * for the application itself. A screen that could edit them could also *read*
 * them back, and an admin account is not the same trust level as access to the
 * Vercel project — that is the whole reason the two are separate. They stay
 * deploy-time only, and the screen says so rather than leaving somebody to
 * hunt for a field that does not exist.
 *
 * The admin list is not here either, because it already has a better home:
 * `/admin/users` promotes and demotes real accounts, which is a more useful
 * thing than a textarea of Discord ids that only takes effect on next sign-in.
 */

export type ServerSettingsProps = {
  gate: { enabled: boolean; guildId: string; source: "settings" | "env" | "none" };
  integrations: {
    /** Masked. The real value never leaves the server. */
    webhook: string | null;
    origin: string | null;
    source: { webhook: "settings" | "env" | "none"; origin: "settings" | "env" | "none" };
  };
  /** Present so the screen can name the deploy-time values without showing them. */
  deployTime: { clientId: boolean; clientSecret: boolean; authSecret: boolean; database: boolean };
};

export default function ServerSettings({ gate, integrations, deployTime }: ServerSettingsProps) {
  return (
    <>
      <GuildGate gate={gate} />
      <Integrations integrations={integrations} />
      <DeployTime deployTime={deployTime} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Who may sign in                                                    */
/* ------------------------------------------------------------------ */

function GuildGate({ gate }: { gate: ServerSettingsProps["gate"] }) {
  const [enabled, setEnabled] = useState(gate.enabled);
  const [guildId, setGuildId] = useState(gate.guildId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const dirty = enabled !== gate.enabled || guildId.trim() !== gate.guildId;
  const changingServer = guildId.trim() !== gate.guildId && guildId.trim().length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await saveGuildGateAction({ enabled, guildId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNote("Saved. It applies to the next sign-in.");
    } catch {
      setError("Could not reach the server. Nothing was saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      icon="shield"
      title="Who may sign in"
      description="Sign-in can be restricted to members of one Discord server. Everything else about an account — admin, profile, applications — is decided here, not there."
    >
      <div className="space-y-5">
        {error && <Alert>{error}</Alert>}

        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(input) => setEnabled(input.target.checked)}
            className="mt-1 h-4 w-4 shrink-0 accent-union"
          />
          <span className="min-w-0">
            <span className="block text-[14px] text-chalk">
              Only members of the server below may sign in
            </span>
            <span className="mt-0.5 block text-[13px] leading-relaxed text-muted">
              Checked, this fails closed: if Discord will not say whether somebody is a
              member, they are refused.
            </span>
          </span>
        </label>

        {!enabled && (
          <Alert tone="ember">
            <span className="block font-medium">Anyone with a Discord account could sign in</span>
            <span className="mt-1 block opacity-90">
              Not just people in your server — anybody, from anywhere. They would land on the
              hub as an ordinary member and could apply to open events. Leave this on unless
              you are deliberately running something public.
            </span>
          </Alert>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="Discord server id"
            placeholder="000000000000000000"
            value={guildId}
            inputMode="numeric"
            maxLength={20}
            wrapperClassName="w-[16rem]"
            onChange={(input) => setGuildId(input.target.value.replace(/\D/g, ""))}
          />
          <SourceBadge source={gate.source} />
        </div>

        <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
          With Developer Mode on in Discord, right-click the server and choose{" "}
          <span className="text-chalk">Copy Server ID</span>. Leave this blank to fall back
          to <code className="num text-dim">DISCORD_GUILD_ID</code> from the deployment.
        </p>

        {changingServer && (
          <Alert tone="gold">
            <span className="block font-medium">Changing the server locks out everyone not in the new one</span>
            <span className="mt-1 block opacity-90">
              Existing sessions keep working — nobody is thrown out mid-draft — but the next
              sign-in is checked against the new server. Make sure you are in it yourself,
              or you will not be able to get back in.
            </span>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button variant="gold" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
          {note && <span className="text-[13px] text-signal">{note}</span>}
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Integrations                                                       */
/* ------------------------------------------------------------------ */

function Integrations({ integrations }: { integrations: ServerSettingsProps["integrations"] }) {
  const [webhook, setWebhook] = useState("");
  const [origin, setOrigin] = useState(integrations.origin ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [masked, setMasked] = useState(integrations.webhook);

  const dirty = webhook.trim().length > 0 || origin.trim() !== (integrations.origin ?? "");

  const run = async (input: Parameters<typeof saveIntegrationsAction>[0], said: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await saveIntegrationsAction(input);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMasked(result.data.webhook);
      setOrigin(result.data.origin ?? "");
      setWebhook("");
      setNote(said);
    } catch {
      setError("Could not reach the server. Nothing was saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      icon="spark"
      title="Where announcements go"
      description="The channel the site posts to, and the address it links back to. Both fall back to the deployment when blank."
    >
      <div className="space-y-6">
        {error && <Alert>{error}</Alert>}

        {/* --- Webhook ------------------------------------------------ */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[14px] text-chalk">Discord webhook</span>
            <SourceBadge source={integrations.source.webhook} />
          </div>

          {masked ? (
            <p className="num text-[12.5px] text-muted">{masked}</p>
          ) : (
            <p className="text-[13px] text-muted">
              Nothing set. Announcements are switched off entirely until there is one.
            </p>
          )}

          <div className="flex flex-wrap items-end gap-3">
            <Field
              label="Replace with"
              type="password"
              placeholder="https://discord.com/api/webhooks/…"
              value={webhook}
              wrapperClassName="min-w-[18rem] flex-1"
              onChange={(input) => setWebhook(input.target.value)}
            />
            {masked && (
              <Button
                variant="ember"
                className="mb-1"
                disabled={busy}
                onClick={() => void run({ clearWebhook: true }, "Webhook cleared.")}
              >
                Clear
              </Button>
            )}
          </div>

          <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
            Only ever shown with its token hidden — anybody holding the full URL can post to
            that channel as the webhook, so the site does not hand it back out. Make one in
            Discord under <span className="text-chalk">Server Settings → Integrations →
            Webhooks</span>.
          </p>
        </div>

        {/* --- Site address ------------------------------------------- */}
        <div className="space-y-3 border-t border-hair pt-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[14px] text-chalk">Site address</span>
            <SourceBadge source={integrations.source.origin} />
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <Field
              label="Address"
              placeholder="https://jobcentre.vercel.app"
              value={origin}
              wrapperClassName="min-w-[18rem] flex-1"
              onChange={(input) => setOrigin(input.target.value)}
            />
          </div>

          <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
            Where the links inside an announcement point. Get this wrong and nothing breaks
            loudly — the messages still send, they just link somewhere that is not the site.
            Worth checking after any change of domain.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="gold"
            disabled={busy || !dirty}
            onClick={() =>
              void run(
                { webhookUrl: webhook || undefined, siteOrigin: origin || undefined },
                "Saved."
              )
            }
          >
            {busy ? "Saving…" : "Save"}
          </Button>
          {note && <span className="text-[13px] text-signal">{note}</span>}
        </div>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* The rest                                                           */
/* ------------------------------------------------------------------ */

function DeployTime({ deployTime }: { deployTime: ServerSettingsProps["deployTime"] }) {
  const rows: Array<{ name: string; set: boolean; why: string }> = [
    {
      name: "DISCORD_CLIENT_ID",
      set: deployTime.clientId,
      why: "Identifies the Discord application. Paired with the secret, so they change together.",
    },
    {
      name: "DISCORD_CLIENT_SECRET",
      set: deployTime.clientSecret,
      why: "Signs in as your Discord application. Anybody holding it can.",
    },
    {
      name: "AUTH_SECRET",
      set: deployTime.authSecret,
      why: "Signs every session. Changing it signs everybody out.",
    },
    {
      name: "DATABASE_URL",
      set: deployTime.database,
      why: "Full read and write access to everything on this site.",
    },
  ];

  return (
    <Section
      icon="settings"
      title="Set where the site is deployed"
      description="These four are credentials for the application itself, so they are not editable here — a screen that could change them could read them back, and an admin account is not the same thing as access to the deployment."
    >
      <div className="overflow-hidden rounded-xl bg-panel">
        {rows.map((row) => (
          <div
            key={row.name}
            className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-hair px-5 py-3.5 first:border-t-0"
          >
            <code className="num w-[15rem] shrink-0 text-[12.5px] text-chalk">{row.name}</code>
            <span
              className={cx(
                "shrink-0 rounded px-2 py-0.5 text-[11.5px]",
                row.set ? "bg-union/15 text-union" : "bg-flare/15 text-flare"
              )}
            >
              {row.set ? "Set" : "Missing"}
            </span>
            <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">
              {row.why}
            </span>
          </div>
        ))}
      </div>

      <p className="mt-4 flex items-start gap-2 text-[13px] leading-relaxed text-muted">
        <Icon name="people" className="relative top-[3px] shrink-0 text-dim" />
        <span>
          Admins are not on this list either — they live on{" "}
          <a href="/admin/users" className="text-union underline underline-offset-4">
            Members
          </a>
          , where you promote a real account rather than a Discord id that only takes effect
          the next time they sign in.
        </span>
      </p>
    </Section>
  );
}

/** Where the value in force actually came from. */
function SourceBadge({ source }: { source: "settings" | "env" | "none" }) {
  if (source === "none") return <Badge tone="ember">Not set</Badge>;
  return source === "settings" ? (
    <Badge tone="gold">Set here</Badge>
  ) : (
    <Badge>From the deployment</Badge>
  );
}
