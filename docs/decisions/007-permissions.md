# 007. Permissions: a vocabulary beside the admin flag

**Status:** Draft - awaiting the owner's sign-off on the vocabulary (Gate 1, 2026-11-13).

## Context

Authority on this site is `users.is_admin`, a single switch, plus two event-scoped grants
(`event_hosts`, `teams.captain_user_id`). The owner wants to trust named people with named
things - creating events, posting announcements, deleting - without making them admins.

Three facts shape the decision more than anything else:

1. **There is no central seam.** About 105 call sites gate themselves, one guard call per action
   or page. Whatever is built must be enforceable at each of them, and provably so.
2. **`is_admin` is load-bearing in ways beyond permission.** It is seeded from an env var,
   pre-authorised and permanently barred through `admin_allowlist`, protected by a last-admin
   rule and a self-demotion rule, and short-circuits `canManageEvent`. It is also how the first
   admin of a fresh database exists at all.
3. **The repo already classifies destructive actions** - the `DESTRUCTIVE` set in
   `src/lib/audit.ts` - and uses that classification only to colour a row in the audit log.

## Options

**A. Replace the flag with permissions.** One mechanism, no special case. Rejected: the
bootstrap, the allowlist bar and the last-admin rule all assume a flag, and a database whose
permission rows are wrong would have nobody able to fix it.

**B. Roles with fixed bundles, one role per person.** Simple to explain and to store. Rejected by
the owner: one person is always the exception, and a role per exception is not a role.

**C. Stored roles with per-person overrides, inherited live.** A person holds a role and a set of
exceptions; editing a role changes everyone who holds it. Rejected: it makes a three-state
question of every power (inherited, granted, denied), and an edit to a role silently widens
authority for people nobody was thinking about - which is the specific failure a permission
system exists to prevent.

**D. Presets that fill a per-person list. (Chosen.)** What is stored is one list of powers per
person. A preset is named in code and applying it marks the powers it names; from that moment the
list is the person's own. Editing a preset later changes nobody. The owner chose this shape
("roles as presets, plus per-person overrides").

## Decision

- **The admin flag stays exactly as it is**, a superuser above the vocabulary. Every check is
  "admin, or holds this power".
- **A power is a name from a stated vocabulary**, stored as text rather than a Postgres enum, so
  that adding one is not a migration - the convention `audit_log.action` and `events.type`
  already follow.
- **One new table**, `user_permissions`: the member, the power, who granted it, when. A row is
  the whole grant. No jsonb: every piece of authority on this site today is a typed column or its
  own table, and this follows.
- **Presets live in code**, beside the vocabulary that defines the powers.
- **Granting is not a power.** Only the admin flag reaches the granting screen, so no holder of
  these powers can grant a power from this vocabulary, or the admin flag, to anybody.
- **One power confers authority of a different kind, and pretending otherwise would be the bug.**
  `hosts.approve` approves an application to host, and that writes an `event_hosts` row - which
  the schema itself describes as "within this event the holder can do what an admin can".
  Worse, `approveInside` has no check that the decider is not the applicant, so without one a
  `hosts.approve` holder could apply to host and approve themselves. That was harmless while only
  admins could approve, because an admin already has everything; it stops being harmless the
  moment the power is grantable. **Task 126 refuses self-approval.** The claim this record
  originally made - "no escalation path to reason about" - was false, and it was found by review
  of Task 123 rather than by writing it down carefully enough.
- **An event host's grant is untouched** and stays whole.
- **The destructive set gets teeth**: the actions the audit log already calls destructive require
  a power of their own, in addition to the power over that area.
- **A sweep test proves no action was left ungated**, because 105 self-gating call sites cannot
  be audited by reading them once.

## Consequences

- Every admin-gated action changes its first line, and the sweep is what makes that safe.
- A member with some powers needs an admin area that admits them, so `/admin` and the nav stop
  being "admin only" and become "anybody with anything".
- A preset that is edited later leaves earlier grants alone. That is deliberate, and it means a
  preset is documentation of a usual case rather than a live group.
- Revoking a power takes effect on the member's next request, because the guards re-read the
  stored row rather than trusting the session - the same reason `is_admin` already behaves that
  way.
