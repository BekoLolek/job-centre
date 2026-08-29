"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, Badge, Button, EmptyState, cx, plural } from "@/components/ui";
import LocalTime from "@/components/format/LocalTime";
import type { NotificationKind } from "@/db/schema";
import type { Notification } from "@/lib/notifications";
import {
  type KindSpec,
  type NotificationChannels,
} from "@/lib/notify-policy";
import {
  markAllReadAction,
  markReadAction,
  setNotificationPrefAction,
} from "@/app/me/notification-actions";

/**
 * What the site has told you, and what you would rather it did not.
 *
 * The list and the switches on one screen on purpose. The moment somebody
 * wants to turn a notification off is the moment they are looking at one they
 * did not want, and making them hunt for a settings page is how a mute button
 * goes unused and an integration gets muted at the Discord end instead.
 */

export default function NotificationList({
  initial,
  prefs,
  discordAvailable,
  hasDiscordAccount,
}: {
  initial: Notification[];
  prefs: Array<KindSpec & { channels: NotificationChannels }>;
  /** Whether a bot token exists at all — see `discord-dm.ts`. */
  discordAvailable: boolean;
  hasDiscordAccount: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  const unread = rows.filter((row) => row.readAt === null).length;

  const readOne = async (id: string) => {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, readAt: new Date() } : row))
    );
    await markReadAction(id);
    router.refresh();
  };

  const readAll = async () => {
    setRows((current) => current.map((row) => ({ ...row, readAt: row.readAt ?? new Date() })));
    await markAllReadAction();
    router.refresh();
  };

  return (
    <div className="space-y-8">
      {error && <Alert>{error}</Alert>}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={unread > 0 ? "gold" : undefined}>
            {unread > 0 ? `${plural(unread, "unread")}` : "All caught up"}
          </Badge>
          {unread > 0 && (
            <Button size="sm" onClick={() => void readAll()}>
              Mark all read
            </Button>
          )}
        </div>

        {rows.length === 0 ? (
          <EmptyState>
            Nothing yet. New events, changes to things you applied to, and the day before
            something you have a seat at all land here.
          </EmptyState>
        ) : (
          <div className="divide-y divide-hair/60">
            {rows.map((row) => (
              <Row key={row.id} row={row} onRead={() => void readOne(row.id)} />
            ))}
          </div>
        )}
      </div>

      <Prefs
        prefs={prefs}
        discordAvailable={discordAvailable}
        hasDiscordAccount={hasDiscordAccount}
        onError={setError}
      />
    </div>
  );
}

function Row({ row, onRead }: { row: Notification; onRead: () => void }) {
  const unread = row.readAt === null;

  const body = (
    <div className="flex min-w-0 flex-1 gap-3">
      {/* The unread mark. A dot rather than bold text: bold changes the
          measure of the line, so a list half-read looks ragged. */}
      <span
        aria-hidden
        className={cx(
          "mt-2 h-1.5 w-1.5 shrink-0 rounded-full",
          unread ? "bg-union" : "bg-transparent"
        )}
      />
      <div className="min-w-0 flex-1">
        <p className={cx("text-[14.5px]", unread ? "text-chalk" : "text-body")}>{row.title}</p>
        {row.body && (
          <p className="mt-0.5 max-w-2xl text-[13px] leading-relaxed text-muted">{row.body}</p>
        )}
        <p className="mt-1 text-[12px] text-dim">
          <LocalTime at={row.createdAt.toISOString()} />
        </p>
      </div>
    </div>
  );

  return (
    <div className="flex items-start gap-3 py-4">
      {row.href ? (
        <Link
          href={row.href}
          onClick={onRead}
          className="-mx-3 flex min-w-0 flex-1 rounded-lg px-3 py-1 transition-colors hover:bg-white/[0.04]"
        >
          {body}
        </Link>
      ) : (
        body
      )}
      {unread && (
        <Button size="sm" onClick={onRead}>
          Mark read
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The switches                                                       */
/* ------------------------------------------------------------------ */

function Prefs({
  prefs,
  discordAvailable,
  hasDiscordAccount,
  onError,
}: {
  prefs: Array<KindSpec & { channels: NotificationChannels }>;
  discordAvailable: boolean;
  hasDiscordAccount: boolean;
  onError: (message: string | null) => void;
}) {
  const [state, setState] = useState(
    () => new Map(prefs.map((spec) => [spec.kind, spec.channels]))
  );
  const [busy, setBusy] = useState<NotificationKind | null>(null);

  const flip = async (
    kind: NotificationKind,
    channel: "inApp" | "discord",
    value: boolean
  ) => {
    const was = state.get(kind) ?? { inApp: true, discord: false };
    const next = { ...was, [channel]: value };

    setBusy(kind);
    onError(null);
    setState((current) => new Map(current).set(kind, next));
    try {
      const result = await setNotificationPrefAction(kind, next);
      if (!result.ok) {
        setState((current) => new Map(current).set(kind, was));
        onError(result.error);
      }
    } catch {
      setState((current) => new Map(current).set(kind, was));
      onError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[20px] text-chalk">What you hear about</h2>
        <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-muted">
          Everything is on here and off on Discord to start with. A dot on this page is
          something you find when you come looking; a direct message arrives whether you
          wanted it or not, which is not a thing to opt somebody into on their behalf.
        </p>
      </div>

      {!discordAvailable && (
        <Alert>
          <span className="block font-medium">Direct messages are not switched on</span>
          <span className="mt-1 block opacity-90">
            They need a Discord bot, which is a different thing from the webhook the site
            already posts announcements with — there is no way to send a DM through a
            webhook. Until an admin adds one, the Discord column here does nothing.
          </span>
        </Alert>
      )}

      {discordAvailable && !hasDiscordAccount && (
        <Alert>
          Your account has no Discord id on it, so there is nowhere to send a direct message.
          Signing in through Discord once fixes that.
        </Alert>
      )}

      <div className="overflow-hidden rounded-xl bg-panel">
        <div className="flex items-center gap-4 border-b border-hair px-5 py-2.5">
          <span className="eyebrow flex-1">Notification</span>
          <span className="eyebrow w-[4.5rem] text-center">Here</span>
          <span className="eyebrow w-[4.5rem] text-center">Discord</span>
        </div>

        {prefs.map((spec) => {
          const channels = state.get(spec.kind) ?? spec.channels;
          return (
            <div
              key={spec.kind}
              className="flex flex-wrap items-center gap-4 border-t border-hair px-5 py-3.5 first:border-t-0"
            >
              <div className="min-w-[12rem] flex-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-[14px] text-chalk">{spec.label}</span>
                  <Badge>{spec.audience}</Badge>
                </div>
                <p className="mt-0.5 max-w-xl text-[12.5px] leading-relaxed text-muted">
                  {spec.blurb}
                </p>
              </div>

              <div className="w-[4.5rem] text-center">
                {spec.fixed ? (
                  <span
                    className="text-[12px] text-dim"
                    title="This is the reply to something you asked for, so it cannot be switched off."
                  >
                    Always
                  </span>
                ) : (
                  <input
                    type="checkbox"
                    aria-label={`${spec.label} here`}
                    className="h-4 w-4 accent-union"
                    checked={channels.inApp}
                    disabled={busy === spec.kind}
                    onChange={(input) => void flip(spec.kind, "inApp", input.target.checked)}
                  />
                )}
              </div>

              <div className="w-[4.5rem] text-center">
                <input
                  type="checkbox"
                  aria-label={`${spec.label} on Discord`}
                  className="h-4 w-4 accent-union"
                  checked={channels.discord}
                  disabled={busy === spec.kind || !discordAvailable}
                  onChange={(input) => void flip(spec.kind, "discord", input.target.checked)}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
