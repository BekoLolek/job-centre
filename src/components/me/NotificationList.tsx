"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Panel,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeadCell,
  TableRow,
  cx,
  plural,
} from "@/components/ui";
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
    <div>
      {error && <Alert className="mb-8">{error}</Alert>}

      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={unread > 0 ? "union" : undefined}>
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
        <p className={cx("text-14", unread ? "text-chalk" : "text-body")}>{row.title}</p>
        {row.body && (
          <p className="mt-0.5 max-w-2xl text-13 leading-relaxed text-muted">{row.body}</p>
        )}
        <p className="mt-1 text-12 text-dim">
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
          className="-mx-3 flex min-w-0 flex-1 rounded px-3 py-1 transition-colors hover:bg-overlay-1"
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

/**
 * The two switch columns, which are the same width for the same reason: wide
 * enough for the word "Discord" at eyebrow size, and no wider, so the rest of
 * the row goes to the label. Change it once.
 */
const SWITCH_COL = "w-[4.5rem]";

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
    <Section
      title="What you hear about"
      description="Everything is on here and off on Discord to start with. A dot on this page is something you find when you come looking; a direct message arrives whether you wanted it or not, which is not a thing to opt somebody into on their behalf."
    >
      <div className="space-y-4">
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
            Your account has no Discord id on it, so there is nowhere to send a direct
            message. Signing in through Discord once fixes that.
          </Alert>
        )}

        {/*
         * No `min-w-` on the table, unlike the standings and the applicants
         * grid. Those are wide by nature — a column per day, a column per
         * result — and scrolling one sideways on a phone is the honest answer.
         * This is three columns, two of them 72px switches, and the third
         * wraps: it fits a 375px screen with room to spare, and making
         * somebody scroll sideways to reach a row of switches would be worse
         * than the stacked list it replaced. The `overflow-x-auto` stays as
         * the safety net it is everywhere else, and never fires at this width.
         */}
        <Panel tone="wash" padding="none" className="overflow-x-auto overflow-y-hidden">
          <Table>
            <TableHead>
              <TableHeadCell>Notification</TableHeadCell>
              <TableHeadCell align="center" className={SWITCH_COL}>
                Here
              </TableHeadCell>
              <TableHeadCell align="center" className={SWITCH_COL}>
                Discord
              </TableHeadCell>
            </TableHead>
            <TableBody>
              {prefs.map((spec) => {
                const channels = state.get(spec.kind) ?? spec.channels;
                return (
                  <TableRow key={spec.kind}>
                    <TableCell>
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-14 text-chalk">{spec.label}</span>
                        <Badge>{spec.audience}</Badge>
                      </div>
                      <p className="mt-0.5 max-w-xl text-13 leading-relaxed text-muted">
                        {spec.blurb}
                      </p>
                    </TableCell>

                    <TableCell align="center" className={SWITCH_COL}>
                      {spec.fixed ? (
                        <span
                          className="text-12 text-dim"
                          title="This is the reply to something you asked for, so it cannot be switched off."
                        >
                          Always
                        </span>
                      ) : (
                        <Checkbox
                          aria-label={`${spec.label} here`}
                          checked={channels.inApp}
                          disabled={busy === spec.kind}
                          onChange={(value) => void flip(spec.kind, "inApp", value)}
                        />
                      )}
                    </TableCell>

                    <TableCell align="center" className={SWITCH_COL}>
                      <Checkbox
                        aria-label={`${spec.label} on Discord`}
                        checked={channels.discord}
                        disabled={busy === spec.kind || !discordAvailable}
                        onChange={(value) => void flip(spec.kind, "discord", value)}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Panel>
      </div>
    </Section>
  );
}
