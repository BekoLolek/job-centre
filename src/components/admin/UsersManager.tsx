"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { LocalTime } from "@/components/format";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  ChoiceChip,
  ChoiceRow,
  EmptyState,
  Eyebrow,
  Field,
  Modal,
  Section,
  Textarea,
  cx,
  plural,
} from "@/components/ui";
import type { AdminUserView, AdminUsersView } from "@/lib/admin-users";
// The pure half, deliberately: `@/lib/admin-users` builds every Drizzle table
// at import time and a client bundle has no use for any of it.
import { NOTE_MAX, revokeRefusal } from "@/lib/admin-users-policy";
import {
  addUserNoteAction,
  grantAdminAction,
  listUserNotesAction,
  revokeAdminAction,
} from "@/app/admin/users/actions";

/**
 * `/admin/users`, client side.
 *
 * ## Where the data lives
 *
 * Nowhere here. Every mutation is a server action that revalidates the page and
 * this component refreshes afterwards, so what is on screen is the rows as
 * Postgres has them rather than a client copy drifting from them. The only
 * local state is what is half-typed: a search box, a filter, an open notes
 * dialog.
 *
 * ## Why the refusal appears twice
 *
 * `revokeRefusal` is imported and run here as well as on the server. That is
 * not a second copy of the rule — it is the same pure function — and it is what
 * lets the button be disabled *with the reason next to it* rather than offering
 * a click that comes back with an error. The server still decides: this
 * component's admin count is as old as the last page load, and two admins
 * demoting each other at the same instant is exactly the case a client-side
 * count would get wrong.
 */

type Filter = "all" | "admins";

export default function UsersManager({
  view,
  currentUserId,
}: {
  view: AdminUsersView;
  currentUserId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [notesFor, setNotesFor] = useState<AdminUserView | null>(null);

  const shown = useMemo(() => {
    const wanted = search.trim().toLowerCase();
    return view.users.filter((row) => {
      if (filter === "admins" && !row.isAdmin) return false;
      if (!wanted) return true;
      return (
        row.displayName.toLowerCase().includes(wanted) ||
        (row.handle ?? "").toLowerCase().includes(wanted)
      );
    });
  }, [view.users, search, filter]);

  const run = (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? "That did not work.");
      else router.refresh();
    });
  };

  const allowlisted = view.users.filter((row) => row.fromAllowlist);

  return (
    <div>
      {error && <Alert className="mb-6">{error}</Alert>}

      {/* --- What the environment variable still does ---------------- */}
      <Section
        first
        icon="shield"
        title="Before you revoke anybody"
        description="What the environment variable still does, and who it currently names."
        className="rise"
      >
        <p className="text-sm leading-relaxed text-muted">
          <code className="font-mono text-chalk">ADMIN_DISCORD_IDS</code> grants the admin
          flag on <strong className="text-chalk">every sign-in</strong>, and only ever
          grants it. Revoking somebody named there works — and then comes back the next
          time they sign in. That is deliberate: the allowlist is the bootstrap that gets
          the first admin in, and a database row able to override it would mean a
          locked-out deployment could not be rescued. To demote one of them for good,
          remove the id from the variable as well.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Eyebrow as="span">On the allowlist</Eyebrow>
          {allowlisted.length === 0 && view.pendingAllowlist.length === 0 ? (
            <span className="text-xs text-muted">Nobody — the variable is empty.</span>
          ) : (
            <>
              {allowlisted.map((row) => (
                <Badge key={row.id} tone="gold">
                  {row.displayName}
                </Badge>
              ))}
              {view.pendingAllowlist.map((id) => (
                <Badge key={id} title="Named in the variable, but has never signed in">
                  {id} · never signed in
                </Badge>
              ))}
            </>
          )}
        </div>
      </Section>

      {/* --- Search and filter -------------------------------------- */}
      <Section
        icon="people"
        title="Members"
        description="Everybody who has ever signed in with Discord. Grant or revoke admin here, and keep notes only admins ever see."
      >
        <div className="flex flex-wrap items-end gap-4 pb-5">
          <Field
            label="Search"
            hint="Name or handle."
            value={search}
            maxLength={60}
            placeholder="beko"
            wrapperClassName="flex-1 min-w-[14rem]"
            onChange={(event) => setSearch(event.target.value)}
          />
          <ChoiceRow>
            <ChoiceChip selected={filter === "all"} onClick={() => setFilter("all")}>
              Everyone ({view.total})
            </ChoiceChip>
            <ChoiceChip selected={filter === "admins"} onClick={() => setFilter("admins")}>
              Admins ({view.admins})
            </ChoiceChip>
          </ChoiceRow>
        </div>

        <div className="divide-y divide-hair/60">
          {shown.length === 0 ? (
            <div className="py-6">
              <EmptyState>
                {view.total === 0
                  ? "Nobody has signed in yet. The first person to sign in with Discord appears here."
                  : "No member matches that."}
              </EmptyState>
            </div>
          ) : (
            shown.map((row) => (
              <MemberRow
                key={row.id}
                member={row}
                isSelf={row.id === currentUserId}
                refusal={
                  row.isAdmin
                    ? revokeRefusal({
                        actorId: currentUserId,
                        targetId: row.id,
                        adminCount: view.admins,
                      })
                    : null
                }
                busy={pending}
                onGrant={() => run(() => grantAdminAction(row.id))}
                onRevoke={() => run(() => revokeAdminAction(row.id))}
                onNotes={() => setNotesFor(row)}
              />
            ))
          )}
        </div>
      </Section>

      <NotesDialog
        member={notesFor}
        onClose={() => {
          setNotesFor(null);
          router.refresh();
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One member                                                         */
/* ------------------------------------------------------------------ */

function MemberRow({
  member,
  isSelf,
  refusal,
  busy,
  onGrant,
  onRevoke,
  onNotes,
}: {
  member: AdminUserView;
  isSelf: boolean;
  /** Why revoking is refused, or null. Straight from the shared pure rule. */
  refusal: string | null;
  busy: boolean;
  onGrant: () => void;
  onRevoke: () => void;
  onNotes: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 py-5">
      {member.avatarUrl ? (
        // A plain <img>, as on /me/profile: next/image would want the Discord
        // CDN in a remotePatterns allowlist for a 128px avatar already shown at
        // exactly its own size.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={member.avatarUrl}
          alt=""
          width={40}
          height={40}
          className="h-10 w-10 shrink-0 rounded-full border border-hair"
        />
      ) : (
        <Avatar name={member.displayName} size="lg" />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-display text-lg leading-none tracking-wide">
            {member.displayName}
          </span>
          {member.isAdmin && <Badge tone="gold">Admin</Badge>}
          {isSelf && <Badge>You</Badge>}
          {member.fromAllowlist && (
            <Badge
              tone="signal"
              title="Named in ADMIN_DISCORD_IDS — the flag is re-granted on every sign-in"
            >
              Allowlisted
            </Badge>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {member.handle ? (
            <Link href={`/players/${member.handle}`} className="link font-mono">
              @{member.handle}
            </Link>
          ) : (
            <span className="font-mono text-muted/60">no handle yet</span>
          )}
          <span>
            Joined <LocalTime at={member.createdAt.toISOString()} format="day" />
          </span>
          <span>
            {member.lastSeenAt ? (
              <>
                Last seen <LocalTime at={member.lastSeenAt.toISOString()} format="when" />
              </>
            ) : (
              "Never signed in"
            )}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Badge tone={member.eventsPlayed > 0 ? "signal" : "default"}>
          {plural(member.eventsPlayed, "event")}
        </Badge>
        <Button size="sm" disabled={busy} onClick={onNotes}>
          Notes{member.notes > 0 ? ` (${member.notes})` : ""}
        </Button>
        {member.isAdmin ? (
          <span className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ember"
              disabled={busy || refusal !== null}
              title={refusal ?? undefined}
              onClick={onRevoke}
            >
              Revoke admin
            </Button>
          </span>
        ) : (
          <Button size="sm" variant="gold" disabled={busy} onClick={onGrant}>
            Make admin
          </Button>
        )}
      </div>

      {member.isAdmin && refusal && (
        <p className={cx("w-full text-xs leading-relaxed text-ember/80")}>{refusal}</p>
      )}
      {member.isAdmin && !refusal && member.fromAllowlist && (
        <p className="w-full text-xs leading-relaxed text-muted">
          Revoking works, but ADMIN_DISCORD_IDS re-grants it the next time they sign in.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Notes                                                              */
/* ------------------------------------------------------------------ */

type NoteRow = {
  id: string;
  body: string;
  createdAt: Date;
  authorName: string | null;
  authorHandle: string | null;
};

/**
 * One member's notes, loaded when the dialog opens rather than with the page.
 *
 * The list read is cheap and the bodies are not wanted until somebody asks for
 * them — and more to the point, admin-only free text should not be sitting in
 * the HTML of a page that merely lists members.
 */
function NotesDialog({
  member,
  onClose,
}: {
  member: AdminUserView | null;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [notes, setNotes] = useState<NoteRow[] | null>(null);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);

  const memberId = member?.id ?? null;

  // Loaded when the dialog opens, and again when it is pointed at somebody
  // else. `cancelled` is what stops a slow read for one member landing in the
  // dialog after it has already been reopened on another.
  useEffect(() => {
    if (!memberId) return;
    let cancelled = false;
    setNotes(null);
    setBody("");
    setError(null);
    void listUserNotesAction(memberId).then((rows) => {
      if (!cancelled) setNotes(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [memberId]);

  const save = () => {
    if (!member) return;
    const text = body.trim();
    if (!text) return;
    setError(null);
    startTransition(async () => {
      const result = await addUserNoteAction(member.id, text);
      if (!result.ok) return setError(result.error);
      setBody("");
      setNotes(await listUserNotesAction(member.id));
    });
  };

  return (
    <Modal
      open={member !== null}
      onClose={onClose}
      title={member ? `Notes on ${member.displayName}` : "Notes"}
      eyebrow="Admin only — never shown publicly"
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="gold" disabled={pending || !body.trim()} onClick={save}>
            Add note
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Textarea
          label="New note"
          hint={`Up to ${NOTE_MAX} characters. Notes cannot be edited or deleted afterwards.`}
          value={body}
          maxLength={NOTE_MAX}
          rows={3}
          onChange={(event) => setBody(event.target.value)}
        />
        {error && <Alert>{error}</Alert>}

        <div className="space-y-3 border-t border-hair pt-4">
          <Eyebrow>
            {notes === null ? "Loading" : plural(notes.length, "note")}
          </Eyebrow>
          {notes !== null && notes.length === 0 && (
            <EmptyState size="sm">
              Nothing written down about this member yet.
            </EmptyState>
          )}
          {notes?.map((note) => (
            <article key={note.id} className="rounded-xl border border-hair bg-raised/40 p-3">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{note.body}</p>
              <p className="mt-2 text-xs text-muted">
                {note.authorName ?? "Somebody"}
                {" · "}
                <LocalTime at={new Date(note.createdAt).toISOString()} format="when" />
              </p>
            </article>
          ))}
        </div>
      </div>
    </Modal>
  );
}
