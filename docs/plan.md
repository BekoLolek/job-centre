# Implementation Plan - Job Centre Events (full redo)

**Tier:** 3 Project
**Requirements:** `docs/requirements.md` (112) · **Use cases:** `docs/use-cases.md` (27)
**Domain model:** `docs/domain-model.md` · **Diagrams:** `docs/diagrams/` · **Decisions:** `docs/decisions/001-003`
**Gate 2 approved 2026-09-17:** deploy fix pushed; spec amendments approved; every feature proposed for deletion kept as a requirement (R-113 to R-169); dev login kept.

## Approach

Rebuild in place (Decision 001). A gap audit walked every use-case line against the code:
the stack satisfies the spec, but rules do not. So each task brings one use case (or one
cross-cutting concern) to spec, rewrites the tests that currently pin the wrong behaviour,
and deletes what no requirement asks for. Security and data-integrity fixes go first;
design consistency last, because it touches every file and should land on settled behaviour.
Section H (kept features) runs after E and before F.

**Every task:** tests first from the use-case steps it names; then `npm run typecheck`,
`npm test`, `npm run build:only` (never `npm run build` locally). No lint runs because the repo
has no ESLint config (see Risks). `.env.local` keeps `DATABASE_URL` blank and `DEV_LOGIN`
commented. One commit per task.

**Already done (Tier 1):** `fd0c3bf` daily reminder cron - pushed and deployed 2026-09-17, ending eighteen days of failed deploys (Decision 003).

## Requirements that need no task

The audit found these fully met, with tests, so no task names them. Their tests stay as the
guard: R-12, R-14, R-21, R-23, R-30, R-42, R-44, R-48, R-51, R-56, R-57, R-70, R-92, R-93, R-94,
R-106 (by `fd0c3bf`), R-112. R-43 is met except for listing each day on the overview, which
Task 12 adds. R-113 to R-169 (kept at Gate 2) are pinned by Tasks 33-35, or by the task
that already rewrites their area.

## Spec amendments proposed

Approved 2026-09-17 and applied to `use-cases.md`. The audit found places where the existing
behaviour is simpler than the use case I wrote and still satisfies the requirement:

| Use case line | Written | Proposed | Why |
|---|---|---|---|
| UC-16 6b | Tie rule from settings | Manager picks among the tied bids; the room is shown it was a tie | R-66 says nothing about ties; a setting nobody asked for |
| UC-17 outcome | Captain may raise until close | Sealed: one bid. Open: raise until close | That is what sealed bidding means |
| UC-18 step 6 | Concurrency and breaks per day | Per event | R-76 does not say per day; one control instead of four |
| UC-15 6a | Duplicate names get a suffix | Automatic names get a suffix; a typed duplicate is refused | Silently renaming what someone typed is worse |
| UC-12 2a / UC-14 3b | Manager waives on an application | Manager waives for a member on the event, before or after applying | A below-rank member is refused before an application can exist |
| UC-06 7b | Overlapping ranges rejected | Overlapping ranges merged; end-before-start rejected | Merging loses nothing |
| UC-04 4a | Missing required detail blocks the profile save | Profile saves partially; the application requires it | Lets people fill a profile in over time |

---

## A. Security and integrity

### Task 1: Scope every host-reachable action to the verified event

- **Serves:** R-86 / UC-21 5a
- **Files:** `src/app/admin/events/format-actions.ts`, `src/app/admin/events/actions.ts` (`decideApplicationAction`), `src/lib/session-guards.ts`, new `src/app/admin/events/__tests__/host-scope.test.ts`
- **Do:** after `requireManagerOfChild` resolves a child's event, use that resolved id for every later read (`formatFor`, `matchIdsFor`) and every `recordAudit`; delete the browser-supplied `eventId` argument from those actions. Remove `loadFormatAction` (dead, callable endpoint).
- **Acceptance criteria:**
  - [ ] A host of event A calling each of the five format actions with a match of A and `eventId` of B gets A's data only and writes audit rows tagged A
  - [ ] A host of A acting on a match of B is refused, nothing written
  - [ ] Application decision audit rows carry the verified event id
  - [ ] Tests call the actions (with a mocked session), not only the permission helper
- **Explicitly not in this task:** host access to the draft room (Task 2)
- **Depends on:** none

### Task 2: Hosts can see and run their own event everywhere a manager can

- **Serves:** R-32, R-86 / UC-08 2, UC-11 1a, UC-16, UC-21 5
- **Files:** `src/app/events/[slug]/page.tsx`, `src/app/events/[slug]/draft/page.tsx`, `src/lib/draft.ts` (`viewerFor`), `src/lib/room.ts`, `src/components/draft/DraftRoom.tsx`
- **Do:** replace `isAdmin` checks on these surfaces with `canManageEvent`; manager role in the draft room for hosts of that event.
- **Acceptance criteria:**
  - [ ] Host sees their unpublished event page and draft room; another member gets not found
  - [ ] Host gets the draft console and can open, award, discard, reserve, void
  - [ ] Host of A gets the watcher view on B's draft
- **Depends on:** Task 1

### Task 3: Event lifecycle exactly as drawn

- **Serves:** R-33 to R-38 / UC-09 1-6, 1a, 5a, 6a, 2a, 3a
- **Files:** `src/lib/events-policy.ts`, `src/lib/events.ts`, `src/components/admin/events/readiness.ts`, `src/components/admin/events/EventStatusControls.tsx`, `src/components/admin/events/BasicsTab.tsx`, `src/components/admin/events/PublishTab.tsx`, `src/app/admin/events/actions.ts`, tests `events-policy.test.ts`, `events.test.ts`
- **Do:** transition map = `diagrams/event-state.md` only (drop published→complete, live→published, cancelled→draft/published). Publish refused without name, at least one day with a start time, and a sign-up window - on every path, including the status control. Reopen goes complete→running and writes an `event.reopened` audit entry. One status control (`EventStatusControls`, gaining "Mark running" and "Cancel"); remove the BasicsTab chips and stale copy.
- **Acceptance criteria:**
  - [ ] Each allowed transition works; each other pair is refused (table-driven test over all 25 pairs)
  - [ ] Publish with a missing requirement lists what is missing and stays unpublished
  - [ ] Reopen button works and the audit names who reopened
  - [ ] Cancelled is terminal
- **Depends on:** none

### Task 4: A finished event refuses every change

- **Serves:** R-39 / UC-09 6b, UC-13 3b, UC-14 4a
- **Files:** `src/lib/archive-policy.ts`, `src/lib/events.ts` (`updateEvent`, `setEventDays`, `decideApplication`, `withdrawApplication`, `setAvailability`, `setConfirmation`), `archive-lock.test.ts`
- **Do:** one `lockRefusal` check at the top of every write that belongs to an event; message "This event is finished - reopen it to change it". Rewrite the tests that assert partial locking.
- **Acceptance criteria:**
  - [ ] Every event-owned write on a complete event is refused and writes nothing (one test per write)
  - [ ] After reopen, the same writes succeed
- **Depends on:** Task 3

### Task 5: A Discord DM is sent once per notification

- **Serves:** R-105 / UC-25 outcome, 2c, 9a
- **Files:** `src/lib/notifications.ts`, `src/db/schema.ts` (+ migration `notification_dm_claims`), `notifications.test.ts`, `migrations.test.ts`
- **Do:** before sending, insert `(user, dedupeKey)` into `notification_dm_claims` with `onConflictDoNothing ... returning`; DM only the rows returned. Works for members with the in-site bell off. Fix the comment that claims otherwise.
- **Acceptance criteria:**
  - [ ] With a stubbed sender and token, calling `notify` twice with the same key sends one DM per opted-in member
  - [ ] Two reminder runs inside the 36 h window send one DM
  - [ ] A member with in-site off and DM on gets one DM, no in-site row
- **Explicitly not in this task:** retries of failed DMs (UC-25 2d: none)
- **Depends on:** none. **Until this ships, do not set `DISCORD_BOT_TOKEN`.**

### Task 6: Announcements say what they do

- **Serves:** R-107, R-108, R-111 / UC-26 3a, 4a, 4b, UC-27 2, 5a
- **Files:** `src/lib/discord.ts`, `src/lib/announce.ts`, `src/app/admin/settings/page.tsx`, `src/components/admin/AnnouncementSettings.tsx`, `src/app/admin/settings/actions.ts`, `src/lib/admin-dashboard.ts`, `announce.test.ts`
- **Do:** settings status reads the resolved webhook (settings, then env); decision announcements read the row before checking the matching switch; announce declined too; failures carry the event id and appear on the admin home; settings save validates every field before writing any; a way to clear the site address.
- **Acceptance criteria:**
  - [ ] Webhook saved in settings shows as configured
  - [ ] Accepted switched off, waitlisted on: a waitlist decision posts
  - [ ] A failed post appears on the admin home and under that event in the audit log
  - [ ] Valid webhook + invalid address saves nothing
- **Depends on:** none

### Task 36: Close the remaining lock races (found in Task 4 review)

- **Serves:** R-39 / UC-09 6b
- **Files:** `src/lib/draft.ts` (`setTeams`, `setCaptains`, `setDraftConfig`, `setDraftPool`, `setPoolKind`, `clearBid`), `src/lib/events.ts` (`setEventDays`, `setEventQuestions`), `src/lib/format.ts` (`clearMatch`), `src/lib/__tests__/archive-lock.test.ts`
- **Do:** these writes check the finished-event lock with a plain read, not under the event row lock, so a write that reads `live` just before completion can commit just after. Read the event with `lockEvent(tx, …)` inside the write's transaction, as `applyToEvent` does. `clearMatch` runs two separate transactions, so completion landing between them leaves `setWinnerOverride` committed when `recordGames` refuses; make it one transaction.
- **Acceptance criteria:**
  - [ ] Each listed write guards and writes inside one transaction holding the event row lock
  - [ ] `clearMatch` either clears everything or nothing when the event is completed mid-call (explicitly sequenced test, no timing luck)
  - [ ] Existing lock table still passes
- **Depends on:** Task 4. Runs with Section D (it touches the draft and format files those tasks change).

### Task 38c: `.field` silently beats the utilities on every input (found in Task 31a)

- **Serves:** the Constraints in `docs/requirements.md`; every form control in the app
- **Files:** `src/app/globals.css` (`.field`), and whatever call sites the change exposes
- **Do:** `.field` sets `width: 100%` and is defined after `@tailwind utilities` at equal specificity, so it beats any `w-*`, `p*-` or `text-*` utility written on the element itself. Measured: a `Select` carrying `w-[11rem]` renders 1010px; `TimeSelect`'s `w-auto py-1.5 text-13` loses all three (1010px wide, 14px, 8px padding); `SuggestionBox`'s status select is the same. Every author who has written a utility on a field since has had it silently discarded, and the workaround is a wrapper per call site. Fix it at the source - most likely `.field` dropping its `width` (and the padding and size it hard-codes) so utilities win as they do everywhere else - then remove the wrappers the old behaviour forced.
- **Acceptance criteria:**
  - [ ] A utility written on a `Field`/`Select`/`Textarea` takes effect, measured before and after on at least three call sites
  - [ ] No control changes its rendered size where no utility was written
  - [ ] The `AvailabilityPanel` wrapper added in Task 31a is removed if it becomes unnecessary
- **Depends on:** Task 31a

### Task 38b: Checkbox tap targets on a phone (found in Task 31a)

- **Serves:** the Constraints in `docs/requirements.md` ("usable on a phone at ~400px")
- **Files:** `src/components/ui/Checkbox.tsx`, its call sites
- **Do:** the checkbox input renders 16x16, well under the 44px touch guideline. It is what the hand-rolled controls already rendered, so Task 31a neither caused nor worsened it, but `/me/notifications` is a member-facing page people open on a phone. Give the control a real hit area - a `<label>` wrapping the cell, or padding on the input - without changing the rendered box.
- **Acceptance criteria:**
  - [ ] Every checkbox's hit area is at least 44x44 at 375px, measured
  - [ ] The drawn box is unchanged
  - [ ] Keyboard behaviour and the focus ring are unchanged
- **Depends on:** Task 31a

### Task 37: Make the file-backed migration test reliable (found in Task 7 review)

- **Serves:** the test gate itself (no requirement)
- **Files:** `src/db/__tests__/migrations.test.ts`
- **Do:** "the file-backed local database - creates its directory, migrates, and survives a reopen" failed once under a full parallel run and passed alone and on every rerun. It boots two file-backed WASM Postgres instances in an `mkdtemp` directory, replays every migration into each and deletes the tree, inside a 30s budget, while a dozen vitest workers do similar work; on Windows that is where a timeout or a data-dir file-handle contention appears. Give it a budget that matches what it does, or isolate it from the parallel pool.
- **Acceptance criteria:**
  - [ ] The test passes in ten consecutive full-suite runs
  - [ ] It still asserts a real reopen (a row written before the close is read after it)
- **Depends on:** none. Do it before the suite is used as a release gate at Gate 3.

## I. Championship (R-171 to R-198)

Added 2026-09-20. A season of two to four events a month across different games, with one
running score. Runs alongside the rest: it touches `src/lib/championship*`, its own routes
and its own tables, so only the nav item and the event editor overlap anything else.

**The rule that shapes it:** a standing is never stored. Points are worked out from recorded
places on every read, so correcting a place re-scores the season - the same rule that makes
bracket corrections safe (R-79).

### Task 38: Score a season

- **Serves:** R-172, R-173, R-176, R-177, R-180, R-181, R-182 / UC-33, UC-34
- **Files:** new `src/lib/championship-policy.ts` (pure) and its tests; `src/db/schema.ts` (+ migration: `championships`, `championship_events`, `championship_placements`)
- **Do:** the schema from `docs/domain-model.md`, and the pure scoring function: placements (member or team) + points table + weight + participation points + optional best-N -> ordered standings, with the tie rule (points, then most firsts, then most seconds, ...). A team's place scores for every member. Nothing stored but the placements.
- **Acceptance criteria:**
  - [ ] Team placement scores every member; a member placed twice (directly and via a team) is rejected
  - [ ] Shared position gives both the same points and leaves the next position empty
  - [ ] Weight and per-event table override apply; participation points scale with weight
  - [ ] best-N keeps each member's best results only
  - [ ] Tie rule ordered exactly as specified, and level players shown level
  - [ ] Correcting a placement changes the standings with nothing stale left behind
- **Depends on:** none

### Task 39: Set up and run a season

- **Serves:** R-171, R-189, R-190, R-191, R-196 / UC-31, UC-35
- **Files:** `src/lib/championships.ts`, `src/app/admin/championships/**`, `src/components/admin/ChampionshipEditor.tsx`, tests
- **Do:** create, edit, publish, unpublish, close, reopen per `diagrams/championship-state.md`; the points table and participation points editor with UC-31's validation (a place never worth less than the one below it); the lock on a closed season; audit entries naming who.
- **Acceptance criteria:** each transition and each refusal tested; closing with a counting event unscored asks for confirmation
- **Depends on:** Task 38

### Task 40: Decide which events count

- **Serves:** R-174, R-175, R-176, R-177 / UC-32
- **Files:** `src/lib/championships.ts`, the event editor (a Championship section), `src/app/admin/events/actions.ts`
- **Do:** add or remove an event, set its weight, optionally give it its own table. An event belongs to at most one championship, enforced in the database.
- **Acceptance criteria:** adding an event already in another season is refused and names it; removing re-scores; weight of 0 or less refused
- **Depends on:** Task 39

### Task 41: Record where everyone finished

- **Serves:** R-178, R-179, R-195 / UC-33
- **Files:** `src/lib/championships.ts`, `src/components/admin/PlacementEditor.tsx`, `src/app/admin/championships/actions.ts`, `src/lib/admin-dashboard.ts`
- **Do:** list who took part (teams if the event had them, else accepted applicants), put them in order, save; correct later; unscored counting events appear on the admin home.
- **Acceptance criteria:** UC-33's five error flows; a correction re-scores; refused while the season is closed
- **Depends on:** Task 40

### Task 42: The season, in public

- **Serves:** R-183 to R-188, R-192, R-194, R-196 / UC-34, UC-35
- **Files:** new `src/app/championship/**` and `src/app/championship/[slug]/**`, `src/components/championship/*`, `src/components/AppHeader.tsx`
- **Do:** the standings (top three prominently, then the table), a player's points game by game, movement at the last event, events counted and still to come, the scoring rules, the viewer's own row marked, past seasons. Its own navigation item, visibly a cut above the others (the user asked for it) while staying inside the design system - no new palette, no new type scale.
- **Acceptance criteria:** UC-34's alternate flows; nothing shown when no season is published; no horizontal scroll at 375px; verified in the browser
- **Depends on:** Task 41, Task 30 (the page shell)

### Task 43: Tell people about it

- **Serves:** R-193, R-197, R-198 / UC-36
- **Files:** `src/lib/notify-policy.ts`, `src/lib/notify-events.ts`, `src/lib/announce.ts`, `src/lib/discord.ts`, `src/lib/players.ts`, `src/app/players/[handle]/page.tsx`
- **Do:** a `standings_changed` notification kind (switchable, off-by-default like the rest of the optional ones), a Discord announcement of the new top of the table, and a player's seasons on their profile.
- **Acceptance criteria:** notified only to members who played that event; announcement respects its switch and a missing webhook; profile shows seasons and final positions
- **Depends on:** Task 42

## B. Applications

### Task 7: Approval entry mode

- **Serves:** R-27, R-170 / UC-08 6a, E6, UC-12 7b, E3, UC-14 2-4
- **Files:** `src/db/schema.ts` (+ migration: `pending` enum value, `config.entryMode`), `src/lib/events-policy.ts`, `src/lib/events.ts`, `src/components/admin/events/BasicsTab.tsx`, `src/components/admin/events/ApplicantsTab.tsx`, `src/components/admin/TemplatesManager.tsx`, `src/app/me/events/page.tsx`, tests
- **Do:** add `entryMode: first_come | approval` (migration maps existing events to first_come). Approval: apply stores `pending`; manager accepts/waitlists/declines per `diagrams/application-state.md`. The existing `config.waitlist` switch stays for first-come events (R-170, kept): off means the event closes when full.
- **Acceptance criteria:**
  - [ ] UC-12 7b: approval event stores pending, member sees "Awaiting review"
  - [ ] Pending → accepted/waitlisted/declined; pending → withdrawn by applicant
  - [ ] Existing events behave exactly as before (first come, waitlist)
- **Depends on:** Task 4

### Task 8: Freed seats always go to the next in line

- **Serves:** R-54, R-55, R-58, R-100 / UC-12 8, UC-13 3a, 5a, UC-14 3a, 5-6
- **Files:** `src/lib/events.ts`, `src/app/apply/actions.ts`, `src/app/me/events/actions.ts`, `src/app/admin/events/actions.ts`, `src/components/admin/events/ApplicantsTab.tsx`, `src/components/me/MyEventCard.tsx`, `events.test.ts`
- **Do:** one `freeSeat` rule used by withdraw, decline, waitlist-from-accepted and "not coming": promote the earliest waitlisted in the same transaction and notify both. Applying notifies and audits. Accepting over the cap asks for confirmation first.
- **Acceptance criteria:**
  - [ ] Each of the four ways a seat frees promotes the earliest waitlisted, notified (rewrite `events.test.ts:1102`)
  - [ ] "Not coming" frees the seat
  - [ ] Over-cap accept needs a confirmed second call; cap unchanged
- **Depends on:** Task 7

### Task 9: Entry-rule waivers

- **Serves:** R-28, R-29, R-50, R-59 / UC-12 2a, UC-14 3b, UC-15 3a
- **Files:** `src/db/schema.ts` (+ migration `entry_waivers`), `src/lib/events.ts`, `src/lib/draft.ts` (`setCaptains`), `src/components/admin/events/ApplicantsTab.tsx`, `src/components/admin/events/CaptainsTab.tsx`, `src/app/events/[slug]/apply/page.tsx`
- **Do:** manager waives a rule for a member on an event (amendment above). Apply checks enter-rule unless waived; `setCaptains` checks the captain rule server-side unless waived; the CaptainsTab override writes a waiver.
- **Acceptance criteria:**
  - [ ] Below-rank member: refused before questions; after a waiver, can apply
  - [ ] Below-captain-rank captain refused by the server unless waived; waiver audited
  - [ ] Apply page shows both rules and whether the member meets them
- **Depends on:** Task 7

### Task 10: Applicants change answers; profile stays the source

- **Serves:** R-49, R-52, R-53, R-60, R-11 / UC-12 2, 2b, 3a, UC-13 1-4, 4a, UC-04 4
- **Files:** `src/lib/events.ts`, `src/lib/profile.ts`, `src/db/schema.ts` (+ migration `profile_values.confirmed_at`), `src/app/events/[slug]/apply/page.tsx`, `src/components/apply/ApplyForm.tsx`, `src/app/me/page.tsx`, `src/components/me/MyEventCard.tsx`
- **Do:** apply page shows the full profile for the game; edits are written to the profile and stamp `confirmed_at`; missing required details asked inline. Active applicants can edit answers while sign-ups are open (refused after; withdraw still allowed). Dashboard lists open applications with status/position and a to-do for questions changed since answering.
- **Acceptance criteria:**
  - [ ] Each listed use-case line has a test
  - [ ] Editing after close refused; withdraw after close allowed
- **Depends on:** Task 8

## C. Setup, identity, profiles

### Task 11: Event setup validation and auditing

- **Serves:** R-24 to R-26, R-98, R-99 / UC-08 4, 10, 10b, 10c
- **Files:** `src/lib/events.ts`, `src/app/admin/events/actions.ts`, `src/components/admin/events/BasicsTab.tsx`, `events.test.ts`
- **Do:** sign-ups close no later than the first day's start; days ordered and non-overlapping; cap at least 2 (constraint migration after checking live rows); every setup save audited; change/question notifications only when published and something changed.
- **Acceptance criteria:**
  - [ ] Each 10c rule refused with its named message; nothing saved
  - [ ] Unpublished saves notify nobody
- **Depends on:** Task 3

### Task 12: Event dates come from its days

- **Serves:** R-24, R-40, R-41, R-97 / UC-10, UC-11 2, UC-25 9
- **Files:** `src/lib/events.ts` (`listEvents`, summaries), `src/lib/notifications.ts`, `src/app/page.tsx`, `src/app/events/[slug]/page.tsx`, `src/components/admin/events/BasicsTab.tsx`, `src/db/schema.ts` (+ migration dropping `starts_at`/`ends_at` in a follow-up commit)
- **Do:** start = first day's start; end = last day's; overview lists every day. Backfill a day from `starts_at` for any event that has none, then stop reading and drop the columns. Reminders to accepted seats only.
- **Acceptance criteria:**
  - [ ] Listings, hub, reminders order and filter by derived dates (existing tests pass unchanged in meaning)
  - [ ] Migration backfill test: an event with only `starts_at` gains a day
- **Depends on:** Task 11

### Task 13: Unsaved changes and templates from an event

- **Serves:** R-22, R-31 / UC-08 9a, 10a
- **Files:** `src/components/admin/events/UnsavedChanges.tsx`, `src/components/admin/events/EventEditor.tsx`, `src/lib/admin-templates.ts`, `src/components/admin/TemplatesManager.tsx`
- **Do:** lock also covers back/forward (popstate) and programmatic navigation; "Save as template" in the editor (admin only) capturing days, cap, rules, questions, format. The templates page keeps all its features (UC-28, pinned in Task 35).
- **Acceptance criteria:**
  - [ ] Browser back with unsaved edits shows the bar and stays
  - [ ] Template from an event reproduces its setup on a new event
- **Depends on:** Task 12

### Task 14: Game catalogue keeps members' answers

- **Serves:** R-08 to R-10 / UC-03 1a, 3b, 5a
- **Files:** `src/lib/admin-games.ts`, `src/db/schema.ts` (+ migration `profile_fields.retired_at`), `src/components/admin/LadderEditor.tsx`, `src/components/admin/GamesManager.tsx`, `admin-games.test.ts`, `profile.test.ts`
- **Do:** retire a detail instead of deleting (answers kept, not asked); editing a detail never clears answers; names unique on rename; reordering a ladder lists events whose rank rules it affects before saving.
- **Acceptance criteria:** each line above tested; `profile.test.ts:411` rewritten to assert answers survive
- **Depends on:** none

### Task 15: Sign-in and admin access to spec

- **Serves:** R-01 to R-07, R-140, R-141 / UC-01 3a, 4c, 6, 8, UC-02 4a, 5, 5a, E3, UC-29
- **Files:** `src/app/signin/page.tsx`, `src/lib/session-guards.ts`, `src/components/SessionNav.tsx`, `src/lib/admin-allowlist.ts`, `src/lib/admin-users.ts`, `src/app/admin/users/actions.ts`, `src/components/admin/UsersManager.tsx`
- **Do:** return to the starting page after sign-in and sign-out; distinct cancelled / Discord-unreachable messages; the members screen's revoke becomes the permanent bar; bar refuses self and last admin inside one transaction, counts admins correctly for non-admin targets; "End sessions" for a member; turning the gate off warns before saving.
- **Acceptance criteria:** each line tested at action level; revoked admin with `ADMIN_DISCORD_IDS` still set stays non-admin
- **Depends on:** none

### Task 16: Availability rules and a correct grid

- **Serves:** R-15 to R-20 / UC-06 7b, 7c, UC-07 1, 4a
- **Files:** `src/lib/availability.ts`, `src/lib/availability-resolve.ts`, `src/components/profile/AvailabilityPanel.tsx`, `src/components/admin/AvailabilityGrid.tsx`, `src/components/admin/AdminNav.tsx`
- **Do:** overlapping ranges merged (amendment), end-before-start refused with the range named (client no longer silently moves it), past dates refused; grid slots built from instants so clock-change weeks neither duplicate nor lose a slot; admin nav links Availability and Host queue.
- **Acceptance criteria:** spring-forward and fall-back week tests on the grid output; each validation tested
- **Depends on:** none

### Task 17: Player profile shows what the spec lists

- **Serves:** R-13 / UC-05 2
- **Files:** `src/lib/players.ts`, `src/app/players/[handle]/page.tsx`, `src/components/ui/Avatar.tsx`
- **Do:** exclude cancelled events; Avatar renders the Discord image with initials fallback. Draft prices stay (R-151).
- **Acceptance criteria:** tests for the statuses listed and for prices shown (UC-05 E1)
- **Depends on:** none

## D. Teams, draft, format, results

### Task 18: Forming teams by hand

- **Serves:** R-61 to R-63 / UC-15 1-6, 4a, 6a
- **Files:** `src/lib/draft.ts`, `src/db/schema.ts` (+ migration `teams.name_is_custom`), `src/app/admin/events/draft-actions.ts`, `src/components/admin/events/TeamsTab.tsx`
- **Do:** set team count 2-8 in one action; place and move accepted players onto rosters by hand; `name_is_custom` replaces the "Team N"/previous-captain regex (migration infers it once from current names).
- **Acceptance criteria:** each UC-15 line tested; a team typed as "Team 3" keeps its name when the captain changes
- **Depends on:** Task 9

### Task 19: Draft rules enforced

- **Serves:** R-64 to R-69, R-144 / UC-16 1a, 6, 6b, 7a, 8, 8a, E2, UC-17 outcome
- **Files:** `src/lib/draft.ts`, `src/lib/draft-policy.ts`, `src/app/events/[slug]/draft/actions.ts`, `src/components/draft/AdminConsole.tsx`, `src/components/draft/DraftRoom.tsx`, `draft.test.ts`, `draft-policy.test.ts`
- **Do:** all rules lock when the first lot opens; award only to the highest bid (tie: manager picks among tied, shown to the room); undo targets the most recent award; next player falls through to reserve automatically; opening a lot refused when every roster is full; a reserved player comes back at most the configured number of times (today the setting is saved but never read).
- **Acceptance criteria:** each line tested, including a watcher payload that shows a tie
- **Depends on:** Task 2

### Task 20: Kept draft settings do what they say

- **Serves:** R-143, R-145 to R-150 / UC-16 E1, E3-E7, UC-26 E1
- **Files:** `src/lib/draft.ts`, `src/lib/draft-policy.ts`, `src/components/admin/events/DraftTab.tsx`, `src/components/draft/AdminConsole.tsx`, `src/lib/discord.ts`, `draft.test.ts`, `draft-policy.test.ts`
- **Do:** tests through the library for each: bids after the time limit refused on the server, minimum bid, roster-fill switch, clearing one or all bids (audited), pool moves refused after the first lot, the all-bid indicator, and a draft-sale announcement; fix what they expose.
- **Acceptance criteria:** every flow listed has a passing test
- **Depends on:** Task 19

### Task 21: The format follows the teams on the server

- **Serves:** R-71 to R-76, R-157, R-161, R-162 / UC-18 2, 2a, 5, 7a, 9, 9a, E6, swiss, UC-15 E1, UC-19 E2
- **Files:** `src/lib/format.ts`, `src/lib/bracket.ts`, `src/lib/format-policy.ts`, `src/db/schema.ts` (+ migration `stages.out_of_date_since`), `src/app/admin/events/format-actions.ts`, `src/app/admin/events/draft-actions.ts`, `src/components/admin/events/FormatTab.tsx`, `src/components/admin/events/ScheduleTab.tsx`
- **Do:** regenerate untouched stages inside the same server action that changes teams or stage settings (the client effect goes); stages with results or moved times get `out_of_date_since`; "Rebuild anyway" lists what will be cleared and does it. Valid team-count range per kind with a named message instead of clamping. Warn when a day runs past midnight. Generate later swiss rounds as earlier rounds finish. A hand-moved start time marks its stage hand-edited; removing teams and changing stages list what they clear before confirming (the existing previews, now tested).
- **Acceptance criteria:** each line tested; changing teams with the Format tab never opened leaves matches current
- **Depends on:** Task 18

### Task 22: Results to spec

- **Serves:** R-78 to R-82, R-159 / UC-19 pre1, 2a, 2b, 3a, 4a, E4
- **Files:** `src/lib/format.ts`, `src/lib/format-resolve.ts`, `src/components/admin/events/ResultsTab.tsx`, `format-db.test.ts`
- **Do:** refuse recording until both slots resolve; reject invalid scores with a message (rewrite the "ignores a negative score" test); flag a later match whose team changed and which had maps recorded; tests for re-toss and its refusal. An even series ending level waits for the manager's decision (kept, now tested).
- **Acceptance criteria:** each line tested
- **Depends on:** Task 21

## E. Hosting, community, notifications

### Task 23: Host applications end to end

- **Serves:** R-83 to R-86, R-109 / UC-20 3a, 3b, UC-21 2, 3, 3a, UC-27 2
- **Files:** `src/lib/hosting.ts`, `src/db/schema.ts` (+ migration: unique pending index), `src/app/admin/host/*`, `src/components/admin/HostQueue.tsx`, `src/components/host/HostApplyForm.tsx`, `src/lib/admin-dashboard.ts`
- **Do:** "Create event from this application" prefills name, game and questions; approve links an existing event; decline requires a reason; per-field errors; one pending enforced in the database; pending host applications on the admin home; remove the co-host helpers (used only by tests; hosting is one grant per event). Expected players and summary stay (R-167, R-168, UC-20 E1).
- **Acceptance criteria:** each line tested
- **Depends on:** Task 2

### Task 24: Suggestions to spec

- **Serves:** R-87 to R-90, R-163 to R-165 / UC-22 1, 1a, 3b, 4, 5, E1-E3
- **Files:** `src/lib/suggestions.ts`, `src/app/suggestions/*`, `src/components/suggestions/SuggestionBox.tsx`, migration dropping `event_id` (never written)
- **Do:** rank by support; description required; server length checks, including the game name (`GAME_MAX`); status change errors shown; sign-in link on vote; deleting your own suggestion asks to confirm. The author's like and the game name stay.
- **Depends on:** none

### Task 25: Polls to spec

- **Serves:** R-91, R-95, R-166 / UC-23 1, 1a, 4, 5b, E1
- **Files:** `src/lib/polls.ts`, `src/app/polls/actions.ts`, `src/components/polls/PollList.tsx`, migration making `closes_at` required
- **Do:** closing time required and in the future; edit preview counts votes affected by rewording and by switching to single choice; save waits for a successful preview; confirm before delete; `poll.deleted` audit action; server length check on detail.
- **Depends on:** none

### Task 26: Notification list and links

- **Serves:** R-96 to R-104 / UC-25 4-5
- **Files:** `src/lib/notifications.ts`, `src/lib/notify-events.ts`, `src/components/me/NotificationList.tsx`, `src/app/me/notifications/page.tsx`
- **Do:** notifications about an event link to the event; paging past 30.
- **Depends on:** Task 12

### Task 27: Running events refresh themselves

- **Serves:** R-45 to R-47, R-77 / UC-11 outcome, 8a (Decision 002)
- **Files:** new `src/components/events/LiveRefresh.tsx`, `src/app/events/[slug]/page.tsx`, `src/components/format/labels.ts`, `src/components/format/MatchCard.tsx`
- **Do:** `router.refresh()` every 10 s while status is running and the tab is visible; unresolved slots say where they come from ("Winner of Upper semi 1").
- **Acceptance criteria:** refresh starts and stops with status and visibility (component test with fake timers); label test
- **Depends on:** none

### Task 28: Audit log filter

- **Serves:** R-110 / UC-27 3
- **Files:** `src/app/admin/audit/page.tsx`, `src/lib/audit.ts`
- **Do:** event filter covers all events; an unknown id says so instead of showing everything.
- **Depends on:** Task 1

## F. Design: same direction, one system

### Task 29: One source for tokens

- **Serves:** Constraints (readable contrast, reduced motion) and every page
- **Files:** `src/app/globals.css`, `tailwind.config.ts`, every file using `gold`, `ember`, `signal`
- **Do:** Tailwind reads colours from the CSS variables (one palette source). Rename aliases to their meaning: `gold`→`union`, `ember`→`flare`, and a real `success` token (today `signal` means success but renders grey). Named type steps replace the 143 arbitrary sizes (11/12/13/14/16/20/28/40); one overlay scale; ad-hoc hex in CSS becomes tokens.
- **Acceptance criteria:** no `text-[Npx]`, `bg-white/[...]` or hex in `src/**/*.tsx` except `Wheel.tsx`; contrast check of every text token against its ground ≥ 4.5:1
- **Depends on:** none (lands after C-E to avoid conflicts)

### Task 30: One page shell

- **Files:** new `src/components/ui/PageHeader.tsx`, `src/components/ui/Page.tsx`, every `src/app/**/page.tsx`, `src/components/AppHeader.tsx`, `src/components/admin/AdminNav.tsx`
- **Do:** one header (eyebrow, title, intro, optional aside) and three widths (reading 880 / standard 1200 / wide 1400) sharing the header's gutters; admin pages all use AdminNav with the same section label.
- **Acceptance criteria:** every page uses `Page` + `PageHeader`; no other `max-w-[...]` on `<main>`; verified at 400 px and desktop
- **Depends on:** Task 29

### Task 31: Primitives everywhere (three commits: community + me, admin, event editor)

- **Files:** listed per bypass in the audit - `SuggestionBox`, `PollList`, `NotificationList`, `ServerSettings`, `AvailabilityGrid`, `AvailabilityPanel`, `HostQueue`, `HostApplyForm`, `AdminAllowlist`, `FormatTab`, `ResultsTab`, `ScheduleTab`, `ApplicantsTab`, `UnsavedChanges`, `admin/audit/page.tsx`; new `src/components/ui/Checkbox.tsx`
- **Do:** replace raw selects, checkboxes, `btn` classes, hand-made cards, chips, empty states and `className="eyebrow"` with the primitives; add Checkbox (five uses).
- **Acceptance criteria:** no raw `<select`, `type="checkbox"`, `className="btn`, `className="eyebrow"` outside `components/ui`
- **Depends on:** Task 30

## G. Deletions

### Task 32: Remove dead code and stale comments

- **Serves:** traceability
- **Files:** `src/lib/admin-games.ts`, `src/lib/availability-resolve.ts`, `src/lib/format-resolve.ts`, `src/components/admin/events/SaveRow.tsx`, `src/components/admin/events/UnsavedChanges.tsx`, `src/components/ui/Section.tsx`, `src/components/ui/index.ts`, `src/app/globals.css`, `src/db/schema.ts`, and the files carrying stale comments
- **Do:** delete `activeGameCount`, `EMPTY_ANSWER`, `blankGames`, `InlineSaveRow`, `useIsDirty`, `SectionList`, `.roundel` and the unused `*Relations` objects. Fix comments that point at `session.ts`, `/login`, `TournamentBoard`, `postAnnouncement` or platform-plan section numbers, citing R and UC ids instead. No feature is removed: at Gate 2 every feature was kept (R-113 to R-169), and dev login stays as developer tooling (R-142).
- **Acceptance criteria:** suite, typecheck, build green; each removed name absent from `src`
- **Depends on:** the task that last touches each file

## H. Kept features (R-113 to R-169)

Runs after E and before F. The audit read these features but did not walk their flows, so
each task writes a test per extension flow in `use-cases.md` and fixes whatever those tests
expose. Kept features in an area another task already rewrites are pinned there instead:
R-140 and R-141 in Task 15, R-144 in Task 19, R-143 and R-145 to R-150 in Task 20, R-157,
R-161 and R-162 in Task 21, R-159 in Task 22, R-167 and R-168 in Task 23, R-163 to R-165 in
Task 24, R-166 in Task 25, and R-151 in Task 17.

### Task 33: Kept event, application and member features

- **Serves:** R-113 to R-124, R-134 to R-139, R-142 / UC-02 E1, E2, UC-06 E1, UC-08 E1-E5, UC-11 E1, UC-12 E1, E2, UC-13 E1, E2, UC-14 E1-E3, UC-30
- **Files:** `src/lib/events.ts`, `src/components/admin/events/BasicsTab.tsx`, `src/components/admin/events/readiness.ts`, `src/app/events/[slug]/page.tsx`, `src/app/events/[slug]/apply/page.tsx`, `src/app/me/page.tsx`, `src/components/admin/events/ApplicantsTab.tsx`, `src/lib/availability.ts`, `src/components/admin/AvailabilityGrid.tsx`, `src/lib/admin-users.ts`, `src/lib/admin-allowlist.ts`, `src/lib/dev-login.ts`, tests beside each
- **Do:** a test for each flow listed. Gaps already suspected: web address validation with a named reason (UC-08 E2a), date-override notes in the admin slot list (UC-06 E1), developer sign-in refused whenever `DATABASE_URL` is set (UC-30 1a). Also: the dev-login banner is `fixed bottom-0 z-50` and 45px tall, so it covers the unsaved-changes bar's Save and Discard buttons — they cannot be clicked while developer sign-in is on (found in Task 7's browser check). Lift the bar above the banner, or the banner out of its way.
- **Acceptance criteria:** every flow listed has a passing test
- **Depends on:** Task 10, Task 16

### Task 34: Kept format and result features

- **Serves:** R-152 to R-156, R-158, R-160 / UC-18 E1-E5, UC-19 E1, E3
- **Files:** `src/lib/format-policy.ts`, `src/lib/format.ts`, `src/lib/format-schedule.ts`, `src/components/admin/events/FormatTab.tsx`, `src/components/admin/events/ScheduleTab.tsx`, `src/components/admin/events/ResultsTab.tsx`, tests
- **Do:** tests for modes per map, series length per bracket and per match, double round robin, moving a block to another day, seeds, and recorded durations feeding the day's schedule; fix what they expose.
- **Acceptance criteria:** every flow listed has a passing test
- **Depends on:** Task 22

### Task 35: Kept templates, games and admin-home features

- **Serves:** R-22, R-125 to R-133, R-169 / UC-28, UC-03 E1-E3, UC-27 E1
- **Files:** `src/lib/admin-templates.ts`, `src/components/admin/TemplatesManager.tsx`, `src/lib/admin-games.ts`, `src/components/admin/GamesManager.tsx`, `src/lib/admin-dashboard.ts`, tests
- **Do:** tests for UC-28's steps and flows (including deleting a used template keeping its events), every-game details, hiding and ordering games, and the admin home's extra attention items; fix what they expose.
- **Acceptance criteria:** every flow listed has a passing test
- **Depends on:** Task 13, Task 14

---

## Verification

Per task: the commands above, with real output reported. At the end of each section (A-G):
walk that section's use cases by hand against a local PGlite build with dev login (if kept),
in the Browser pane, reporting DOM reads and computed styles (screenshots do not render in
this environment). Before any production push: the Phase 8 launch checklist (Gate 3).

## Risks

| Risk | Likelihood | What we do about it |
|---|---|---|
| A Vercel build runs migrations against Neon; a bad migration breaks production | Medium | Additive-first migrations; drops in a later commit; each migration tested on PGlite from a copy of the current schema; `npm run build` never run locally |
| Dropping a column that holds live data (event start/end, suggestion event link) | Low | Each drop first counts non-null rows via a read-only script the user runs against Neon; drop only when empty or approved |
| Tests pinning wrong behaviour get "fixed" to pass | Medium | Every rewritten assertion cites the use-case line it now follows in the commit message |
| Setting `DISCORD_BOT_TOKEN` before Task 5 double-DMs members | Low if noted | Stated in Task 5 and at Gate 2 |
| Design tasks conflict with behaviour tasks | High if interleaved | Section F starts after E |
| No lint in the repo | Certain | Out of plan unless requested; typecheck + tests + build are the gate |
| Polling live pages costs Neon compute | Low | Only while running and visible (Decision 002) |
