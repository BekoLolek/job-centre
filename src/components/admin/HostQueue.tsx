"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, Badge, Button, EmptyState, Field, cx, plural } from "@/components/ui";
import type { HostApplication } from "@/lib/hosting";
import {
  approveHostApplicationAction,
  declineHostApplicationAction,
} from "@/app/host/actions";

/**
 * The queue of people who want to run something.
 *
 * Approving creates a draft event and hands it to them. What it deliberately
 * does *not* do is create the game or the questions: the application says what
 * they need, and an admin reads it and sets the game up on `/admin/games` if it
 * is not there already. Guessing a game catalogue from free text is how you end
 * up with three spellings of the same game.
 *
 * So the "what I need to know about each player" answer is shown at full size
 * rather than folded away — it is the thing the admin is about to act on, not
 * background.
 */

export default function HostQueue({ applications }: { applications: HostApplication[] }) {
  const pending = applications.filter((row) => row.status === "pending");
  const decided = applications.filter((row) => row.status !== "pending");

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        {pending.length === 0 ? (
          <EmptyState>
            Nothing waiting. Applications arrive from <code className="num">/host</code>, which
            any member can reach.
          </EmptyState>
        ) : (
          pending.map((application) => (
            <Card key={application.id} application={application} />
          ))
        )}
      </div>

      {decided.length > 0 && (
        <div className="space-y-2">
          <span className="eyebrow">Already decided</span>
          <div className="divide-y divide-hair/60">
            {decided.map((application) => (
              <div
                key={application.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3"
              >
                <span className="text-[14px] text-body">{application.title}</span>
                <Badge tone={application.status === "approved" ? "signal" : "ember"}>
                  {application.status}
                </Badge>
                <span className="text-[12.5px] text-dim">
                  {application.by?.name ?? "somebody"} · {application.gameName}
                </span>
                {application.eventId && (
                  <Link
                    href={`/admin/events/${application.eventId}`}
                    className="text-[12.5px] text-union underline underline-offset-4"
                  >
                    the event
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ application }: { application: HostApplication }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (which: "approve" | "decline") => {
    setBusy(which);
    setError(null);
    try {
      const result =
        which === "approve"
          ? await approveHostApplicationAction(application.id, note)
          : await declineHostApplicationAction(application.id, note);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (which === "approve" && "data" in result && result.data) {
        router.push(`/admin/events/${result.data.eventId}`);
        return;
      }
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="rounded-xl bg-panel px-5 py-4">
      {error && <Alert className="mb-3">{error}</Alert>}

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[17px] text-chalk">{application.title}</h3>
        <Badge tone="gold">{application.gameName}</Badge>
        {application.gameId ? (
          <Badge tone="signal">Game already set up</Badge>
        ) : (
          <Badge tone="ember">Game not in the catalogue</Badge>
        )}
      </div>

      <p className="mt-1 text-[12.5px] text-dim">
        {application.by?.name ?? "Somebody"}
        {application.expectedPlayers ? ` · ${plural(application.expectedPlayers, "player")}` : ""}
        {application.format ? ` · ${application.format}` : ""}
        {application.proposedWhen ? ` · ${application.proposedWhen}` : ""}
      </p>

      <p className="mt-3 max-w-2xl whitespace-pre-wrap text-[13.5px] leading-relaxed text-body">
        {application.summary}
      </p>

      {/* The part the admin has to act on before approving. */}
      <div className="mt-4 rounded-lg bg-white/[0.03] px-4 py-3">
        <span className="eyebrow">What they need from each player</span>
        <p className="mt-1.5 max-w-2xl whitespace-pre-wrap text-[13.5px] leading-relaxed text-chalk">
          {application.playerInfoNeeded}
        </p>
        <p className="mt-2 text-[12.5px] leading-relaxed text-dim">
          Turn this into the event&rsquo;s questions after approving — Setup → Questions on the
          event, and{" "}
          <Link href="/admin/games" className="text-union underline underline-offset-4">
            Games
          </Link>{" "}
          first if the game is not in the catalogue yet.
        </p>
      </div>

      <div className="mt-4 space-y-3">
        <Field
          label="Note to them"
          placeholder="Optional — shown to the applicant either way"
          value={note}
          maxLength={500}
          onChange={(input) => setNote(input.target.value)}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="gold"
            disabled={busy !== null}
            onClick={() => void run("approve")}
          >
            {busy === "approve" ? "Approving…" : "Approve and create the event"}
          </Button>
          <Button
            variant="ember"
            disabled={busy !== null}
            onClick={() => void run("decline")}
          >
            {busy === "decline" ? "Declining…" : "Decline"}
          </Button>
          <span className={cx("text-[12.5px] text-dim")}>
            Approving makes a draft event and hands it to them. It does not publish anything.
          </span>
        </div>
      </div>
    </section>
  );
}
