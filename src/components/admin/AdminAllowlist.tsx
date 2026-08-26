"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Field, cx, plural } from "@/components/ui";
import type { AllowlistRow } from "@/lib/admin-allowlist";
import { allowAdminAction, barAdminAction } from "@/app/admin/users/actions";

/**
 * Who gets to be an admin, named by Discord id rather than by account.
 *
 * The members list below promotes people who already exist. This is for the
 * two cases it cannot reach:
 *
 *  - **Somebody who has never signed in.** There is no account to promote, so
 *    promoting the account cannot be the mechanism. Name the id and the flag
 *    is waiting for them when they arrive.
 *  - **Somebody who must not come back.** Demoting an account used to be
 *    undone on their next sign-in, silently, because `ADMIN_DISCORD_IDS`
 *    re-asserted itself every time. Barring the id is the version of remove
 *    that sticks.
 *
 * Two different removals, and the difference matters enough to be two buttons:
 * **Bar** is a permanent no that outranks the environment variable, and
 * **Forget** drops the row so the environment decides again. One is for
 * removing a person, the other for undoing a typo.
 */

export default function AdminAllowlist({
  rows,
  envIds,
}: {
  rows: AllowlistRow[];
  /** Ids still named in ADMIN_DISCORD_IDS, so the screen can say so. */
  envIds: string[];
}) {
  const router = useRouter();
  const [discordId, setDiscordId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const run = async (key: string, go: () => Promise<{ ok: boolean; said?: string; error?: string }>) => {
    setBusy(key);
    setError(null);
    setSaid(null);
    try {
      const result = await go();
      if (!result.ok) {
        setError(result.error ?? "That did not work.");
        return;
      }
      setSaid(result.said ?? "Done.");
      setDiscordId("");
      setNote("");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(null);
    }
  };

  const listed = new Set(rows.map((row) => row.discordId));
  // Ids the environment still promotes that this list has never heard of. They
  // work, but nobody can see them here, which is the state this replaces.
  const unlisted = envIds.filter((id) => !listed.has(id));

  const allowed = rows.filter((row) => row.allowed);
  const barred = rows.filter((row) => !row.allowed);

  return (
    <div className="space-y-5">
      {error && <Alert>{error}</Alert>}
      {said && <Alert tone="signal">{said}</Alert>}

      {/* --- Add ---------------------------------------------------- */}
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Discord id"
          placeholder="000000000000000000"
          value={discordId}
          maxLength={24}
          wrapperClassName="w-[14rem]"
          onChange={(input) => setDiscordId(input.target.value)}
        />
        <Field
          label="Note"
          placeholder="Optional — why, for whoever reads this later"
          value={note}
          maxLength={200}
          wrapperClassName="min-w-[14rem] flex-1"
          onChange={(input) => setNote(input.target.value)}
        />
        <Button
          variant="gold"
          className="mb-1"
          disabled={busy !== null || discordId.trim().length === 0}
          onClick={() => void run("add", () => allowAdminAction({ discordId, note }))}
        >
          {busy === "add" ? "Adding…" : "Add"}
        </Button>
      </div>

      <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
        With Developer Mode on in Discord, right-click somebody and choose{" "}
        <span className="text-chalk">Copy User ID</span>. They do not need an account here
        yet — the flag is applied the first time they sign in.
      </p>

      {/* --- The list ------------------------------------------------ */}
      {rows.length === 0 ? (
        <p className="text-[13px] text-muted">
          Nobody listed. Admins currently come from{" "}
          <code className="num text-dim">ADMIN_DISCORD_IDS</code> alone.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl bg-panel">
          {[...allowed, ...barred].map((row) => (
            <Row
              key={row.discordId}
              row={row}
              busy={busy}
              inEnv={envIds.includes(row.discordId)}
              onBar={() => void run(row.discordId, () => barAdminAction({ discordId: row.discordId }))}
              onForget={() =>
                void run(row.discordId, () =>
                  barAdminAction({ discordId: row.discordId, forget: true })
                )
              }
              onAllow={() => void run(row.discordId, () => allowAdminAction({ discordId: row.discordId }))}
            />
          ))}
        </div>
      )}

      {unlisted.length > 0 && (
        <Alert tone="gold">
          <span className="block font-medium">
            {plural(unlisted.length, "id")} in ADMIN_DISCORD_IDS not listed above
          </span>
          <span className="mt-1 block opacity-90">
            {unlisted.join(", ")} — they still become admins on sign-in, from the deployment.
            Add them here to manage them from this screen, or bar them to stop it.
          </span>
        </Alert>
      )}
    </div>
  );
}

function Row({
  row,
  busy,
  inEnv,
  onBar,
  onForget,
  onAllow,
}: {
  row: AllowlistRow;
  busy: string | null;
  inEnv: boolean;
  onBar: () => void;
  onForget: () => void;
  onAllow: () => void;
}) {
  const working = busy === row.discordId;

  return (
    <div
      className={cx(
        "flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hair px-5 py-3.5 first:border-t-0",
        !row.allowed && "opacity-70"
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[14px] text-chalk">
            {row.account?.name ?? "Not signed in yet"}
          </span>
          <code className="num text-[12px] text-dim">{row.discordId}</code>
          {row.allowed ? (
            <Badge tone="gold">Admin on sign-in</Badge>
          ) : (
            <Badge tone="ember">Barred</Badge>
          )}
          {row.account?.isAdmin && <Badge tone="signal">Admin now</Badge>}
          {inEnv && <Badge>Also in the deployment</Badge>}
        </div>
        {row.note && <p className="mt-1 text-[12.5px] text-muted">{row.note}</p>}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {row.allowed ? (
          <Button size="sm" variant="ember" disabled={working} onClick={onBar}>
            {working ? "…" : "Bar"}
          </Button>
        ) : (
          <Button size="sm" disabled={working} onClick={onAllow}>
            Allow again
          </Button>
        )}
        <Button
          size="sm"
          disabled={working}
          onClick={onForget}
          title={
            inEnv
              ? "Drops the row. This id is in ADMIN_DISCORD_IDS, so it would become an admin again on sign-in."
              : "Drops the row and forgets the id."
          }
        >
          Forget
        </Button>
      </div>
    </div>
  );
}
