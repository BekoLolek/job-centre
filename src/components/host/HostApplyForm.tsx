"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, Badge, Button, Field, Select, cx } from "@/components/ui";
import type { HostApplication } from "@/lib/hosting";
import {
  applyToHostAction,
  withdrawHostApplicationAction,
} from "@/app/host/actions";

/**
 * "I would like to run an event."
 *
 * The form asks for more than an intention on purpose. Approving one means an
 * admin creates the event, attaches a game and writes the questions applicants
 * will answer — so if the form does not carry the game and the questions,
 * approving it is the *start* of a conversation rather than the end of one, and
 * a conversation in Discord is what this site exists to replace.
 *
 * Hence the two required fields nobody expects: what game, and what you need to
 * know about each player. Everything else is optional, because everything else
 * the host can fill in themselves once they have the event.
 */

const GAME_HINT =
  "The game as people call it. If we already run it an admin will match it up; if not, they will add it.";

export default function HostApplyForm({
  mine,
  games,
}: {
  mine: HostApplication[];
  /** Games this site already knows, so the common case is a dropdown. */
  games: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const pending = mine.find((row) => row.status === "pending") ?? null;

  const [title, setTitle] = useState("");
  const [gameId, setGameId] = useState("");
  const [gameName, setGameName] = useState("");
  const [summary, setSummary] = useState("");
  const [format, setFormat] = useState("");
  const [expected, setExpected] = useState("");
  const [when, setWhen] = useState("");
  const [playerInfo, setPlayerInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = games.find((game) => game.id === gameId) ?? null;
  const effectiveGameName = chosen ? chosen.name : gameName;

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await applyToHostAction({
        title,
        gameName: effectiveGameName,
        gameId: chosen?.id ?? null,
        summary,
        format,
        expectedPlayers: expected ? Number(expected) : null,
        proposedWhen: when,
        playerInfoNeeded: playerInfo,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server. Nothing was sent.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      {error && <Alert>{error}</Alert>}

      {mine.length > 0 && (
        <div className="space-y-3">
          {mine.map((application) => (
            <MineRow
              key={application.id}
              application={application}
              onWithdraw={async () => {
                const result = await withdrawHostApplicationAction(application.id);
                if (!result.ok) setError(result.error);
                router.refresh();
              }}
            />
          ))}
        </div>
      )}

      {pending ? (
        <Alert tone="gold">
          <span className="block font-medium">You have one waiting</span>
          <span className="mt-1 block opacity-90">
            An admin will look at it. Withdraw it above if you would rather send a different
            one — you can only have one in the queue at a time, so that an admin looking at
            the list is looking at decisions rather than at drafts.
          </span>
        </Alert>
      ) : (
        <div className="space-y-4">
          <Field
            label="What is the event?"
            placeholder="Friday REPO night"
            value={title}
            maxLength={120}
            onChange={(input) => setTitle(input.target.value)}
          />

          <div className="flex flex-wrap items-end gap-3">
            <Select
              label="Game"
              value={gameId}
              wrapperClassName="min-w-[14rem] flex-1"
              onChange={(input) => setGameId(input.target.value)}
            >
              <option value="">Something else…</option>
              {games.map((game) => (
                <option key={game.id} value={game.id}>
                  {game.name}
                </option>
              ))}
            </Select>
            {!chosen && (
              <Field
                label="Which game"
                placeholder="REPO"
                value={gameName}
                maxLength={80}
                wrapperClassName="min-w-[12rem] flex-1"
                onChange={(input) => setGameName(input.target.value)}
              />
            )}
          </div>
          <p className="text-[13px] leading-relaxed text-muted">{GAME_HINT}</p>

          <Field
            label="What happens"
            placeholder="Six of us, a few rounds, prizes for whoever survives longest. Two hours tops."
            value={summary}
            maxLength={2000}
            onChange={(input) => setSummary(input.target.value)}
          />

          <div className="flex flex-wrap items-end gap-3">
            <Field
              label="How it runs"
              placeholder="Optional — bracket, casual, league"
              value={format}
              maxLength={200}
              wrapperClassName="min-w-[12rem] flex-1"
              onChange={(input) => setFormat(input.target.value)}
            />
            <Field
              label="Players"
              placeholder="Optional"
              value={expected}
              inputMode="numeric"
              wrapperClassName="w-[7rem]"
              onChange={(input) => setExpected(input.target.value.replace(/\D/g, ""))}
            />
            <Field
              label="When"
              placeholder="Optional — a weekend in March"
              value={when}
              maxLength={200}
              wrapperClassName="min-w-[12rem] flex-1"
              onChange={(input) => setWhen(input.target.value)}
            />
          </div>

          <div className="rounded-xl bg-panel px-5 py-4">
            <Field
              label="What do you need to know about each player?"
              placeholder="Their in-game name, and whether they own the DLC."
              value={playerInfo}
              maxLength={1000}
              onChange={(input) => setPlayerInfo(input.target.value)}
            />
            <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-muted">
              This becomes the sign-up questions. Rank, role, in-game name, which packs they
              own — whatever you would otherwise have to ask forty people individually. An
              admin turns it into the form before handing the event over.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="gold"
              disabled={busy || !title.trim() || !effectiveGameName.trim() || !playerInfo.trim()}
              onClick={() => void send()}
            >
              {busy ? "Sending…" : "Send it"}
            </Button>
            <span className="text-[12.5px] text-dim">
              An admin sets the event up, then it is yours to run.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

const STATUS_TONE: Record<HostApplication["status"], "gold" | "signal" | "ember" | undefined> = {
  pending: "gold",
  approved: "signal",
  declined: "ember",
  withdrawn: undefined,
};

function MineRow({
  application,
  onWithdraw,
}: {
  application: HostApplication;
  onWithdraw: () => void;
}) {
  return (
    <div
      className={cx(
        "rounded-xl bg-panel px-5 py-4",
        application.status === "withdrawn" && "opacity-60"
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[15px] text-chalk">{application.title}</span>
        <Badge tone={STATUS_TONE[application.status]}>{application.status}</Badge>
        <Badge>{application.gameName}</Badge>
      </div>

      {application.decisionNote && (
        <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-muted">
          {application.decisionNote}
        </p>
      )}

      {application.status === "approved" && application.eventId && (
        <p className="mt-2 text-[13.5px] text-signal">
          It is yours to run —{" "}
          <Link
            href={`/admin/events/${application.eventId}`}
            className="text-union underline underline-offset-4"
          >
            open the event
          </Link>
          . Everything an admin can do to it, you can.
        </p>
      )}

      {application.status === "pending" && (
        <div className="mt-3">
          <Button size="sm" variant="ember" onClick={onWithdraw}>
            Withdraw
          </Button>
        </div>
      )}
    </div>
  );
}
