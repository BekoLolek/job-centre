"use client";

/**
 * The five Discord announcement switches (§14, checklist.md F2).
 *
 * A toggle per kind, saved together. They are saved together because the
 * setting *is* one row — one key holding an object — and five independent
 * writes to one row is five chances for two tabs to disagree about what the
 * other four are.
 *
 * The panel says whether a webhook is configured at all, because the single
 * most confusing state this feature can be in is "every switch is on and
 * nothing is posting". That is not a failure, it is `DISCORD_WEBHOOK_URL` being
 * unset, and the screen should say so rather than let somebody spend an evening
 * looking for a bug.
 */

import { useState, useTransition } from "react";
import type { AnnouncementSettings as Settings, AnnouncementSpec } from "@/lib/announce";
import { Alert, Button, Eyebrow, Panel, Toggle, cx } from "@/components/ui";
import { saveAnnouncementSettingsAction } from "@/app/admin/settings/actions";

export type AnnouncementSettingsProps = {
  specs: readonly AnnouncementSpec[];
  saved: Settings;
  /** Whether `DISCORD_WEBHOOK_URL` is set. Resolved on the server; never the value. */
  configured: boolean;
};

export default function AnnouncementSettings({
  specs,
  saved,
  configured,
}: AnnouncementSettingsProps) {
  const [value, setValue] = useState<Settings>(saved);
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dirty = specs.some((spec) => value[spec.kind] !== saved[spec.kind]);

  const save = () => {
    setNote(null);
    setError(null);
    start(async () => {
      const result = await saveAnnouncementSettingsAction({ ...value });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Adopt what was *stored*, not what was sent — the same rule the draft
      // config tab follows. A normaliser that dropped something has to be
      // visible on screen rather than only in the database.
      setValue(result.data.settings);
      setNote("Saved.");
    });
  };

  return (
    <Panel as="section" className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <Eyebrow>Discord announcements</Eyebrow>
        <Eyebrow as="span" className={configured ? "text-signal" : "text-muted"}>
          {configured ? "Webhook configured" : "No webhook — nothing will post"}
        </Eyebrow>
      </div>

      {!configured && (
        <Alert tone="gold">
          <code>DISCORD_WEBHOOK_URL</code> is not set, so every switch below is inert. Get
          one from <strong>Server Settings → Integrations → Webhooks → New Webhook</strong>,
          pick the channel, copy the URL, and put it in <code>.env.local</code>. Nothing
          else changes — with the variable unset the whole feature is a no-op, exactly as
          blank Discord credentials are on the sign-in page.
        </Alert>
      )}

      <ul className="divide-y divide-hair/60">
        {specs.map((spec) => (
          <li
            key={spec.kind}
            className="flex flex-wrap items-start gap-x-6 gap-y-3 py-4 first:pt-0"
          >
            <div className="min-w-0 flex-1">
              <div
                className={cx(
                  "text-sm",
                  value[spec.kind] ? "text-chalk" : "text-muted"
                )}
              >
                {spec.label}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted">{spec.detail}</p>
            </div>

            <Toggle
              className="shrink-0"
              value={value[spec.kind]}
              yesLabel="On"
              noLabel="Off"
              disabled={pending}
              // `Toggle` clears to `null` when the lit side is tapped again,
              // which is right for a profile question nobody has answered and
              // wrong here: a switch is on or off. Null is read as off.
              onChange={(next) =>
                setValue((current) => ({ ...current, [spec.kind]: next === true }))
              }
            />
          </li>
        ))}
      </ul>

      {error && <Alert tone="ember">{error}</Alert>}

      <div className="flex flex-wrap items-center gap-3 border-t border-hair pt-4">
        <Button variant="gold" size="sm" onClick={save} disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {note && !dirty && <Eyebrow as="span" className="text-signal">{note}</Eyebrow>}
        {dirty && <Eyebrow as="span">Unsaved</Eyebrow>}
      </div>
    </Panel>
  );
}
