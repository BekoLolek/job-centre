"use client";

/**
 * The Discord announcement switches (§14, checklist.md F2).
 *
 * A toggle per kind, saved together. They are saved together because the
 * setting *is* one row — one key holding an object — and a write per switch to
 * one row is that many chances for two tabs to disagree about the others.
 *
 * The panel says whether a webhook is configured at all, because the single
 * most confusing state this feature can be in is "every switch is on and
 * nothing is posting". That is not a failure, it is no webhook being set —
 * neither on this screen nor in the deployment — and the screen should say so
 * rather than let somebody spend an evening looking for a bug.
 */

import { useState, useTransition } from "react";
import type { AnnouncementSettings as Settings, AnnouncementSpec } from "@/lib/announce";
import { Alert, Button, Eyebrow, Section, Toggle, cx } from "@/components/ui";
import { saveAnnouncementSettingsAction } from "@/app/admin/settings/actions";

export type AnnouncementSettingsProps = {
  specs: readonly AnnouncementSpec[];
  saved: Settings;
  /** Whether a webhook is in force, from settings or the deployment. Never the value. */
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
    <Section
      first
      icon="settings"
      title="Discord announcements"
      description="Which moments get posted into the channel. They all save together, because the setting is one row."
      aside={
        <Eyebrow as="span" className={configured ? "text-signal" : "text-muted"}>
          {configured ? "Webhook configured" : "No webhook — nothing will post"}
        </Eyebrow>
      }
      className="space-y-5"
    >
      {!configured && (
        <Alert tone="gold">
          No webhook is set, so every switch below is inert. Get one from{" "}
          <strong>Server Settings → Integrations → Webhooks → New Webhook</strong> in
          Discord, pick the channel, copy the URL, and paste it under{" "}
          <strong>Where announcements go</strong> below. Until then the whole feature is a
          no-op, exactly as blank Discord credentials are on the sign-in page.
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
    </Section>
  );
}
