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
  - [x] A host of event A calling each of the five format actions with a match of A and `eventId` of B gets A's data only and writes audit rows tagged A
  - [x] A host of A acting on a match of B is refused, nothing written
  - [x] Application decision audit rows carry the verified event id
  - [x] Tests call the actions (with a mocked session), not only the permission helper
- **Explicitly not in this task:** host access to the draft room (Task 2)
- **Depends on:** none
- **Left over:** `setApplicantAvailabilityAction` (`src/app/admin/events/actions.ts`) still takes a third `eventId: string` parameter that is **never read** - the body uses `scope` throughout (`refresh(scope)`, `eventId: scope`) - and `src/components/admin/events/ApplicantsTab.tsx:799` still passes it. The Do line said to delete the browser-supplied `eventId` argument from these actions, and this one survived. Harmless today, and the docblock says it is not trusted, but it is a live argument that looks authoritative and is not. Worth removing in Task 32's sweep.

### Task 2: Hosts can see and run their own event everywhere a manager can

- **Serves:** R-32, R-86 / UC-08 2, UC-11 1a, UC-16, UC-21 5
- **Files:** `src/app/events/[slug]/page.tsx`, `src/app/events/[slug]/draft/page.tsx`, `src/lib/draft.ts` (`viewerFor`), `src/lib/room.ts`, `src/components/draft/DraftRoom.tsx`
- **Do:** replace `isAdmin` checks on these surfaces with `canManageEvent`; manager role in the draft room for hosts of that event.
- **Acceptance criteria:**
  - [x] Host sees their unpublished event page and draft room; another member gets not found
  - [x] Host gets the draft console and can open, award, discard, reserve, void
  - [x] Host of A gets the watcher view on B's draft
- **Depends on:** Task 1

### Task 3: Event lifecycle exactly as drawn

- **Serves:** R-33 to R-38 / UC-09 1-6, 1a, 5a, 6a, 2a, 3a
- **Files:** `src/lib/events-policy.ts`, `src/lib/events.ts`, `src/components/admin/events/readiness.ts`, `src/components/admin/events/EventStatusControls.tsx`, `src/components/admin/events/BasicsTab.tsx`, `src/components/admin/events/PublishTab.tsx`, `src/app/admin/events/actions.ts`, tests `events-policy.test.ts`, `events.test.ts`
- **Do:** transition map = `diagrams/event-state.md` only (drop published→complete, live→published, cancelled→draft/published). Publish refused without name, at least one day with a start time, and a sign-up window - on every path, including the status control. Reopen goes complete→running and writes an `event.reopened` audit entry. One status control (`EventStatusControls`, gaining "Mark running" and "Cancel"); remove the BasicsTab chips and stale copy.
- **Acceptance criteria:**
  - [x] Each allowed transition works; each other pair is refused (table-driven test over all 25 pairs)
  - [x] Publish with a missing requirement lists what is missing and stays unpublished
  - [x] Reopen button works and the audit names who reopened
  - [x] Cancelled is terminal
- **Depends on:** none

### Task 4: A finished event refuses every change

- **Serves:** R-39 / UC-09 6b, UC-13 3b, UC-14 4a
- **Files:** `src/lib/archive-policy.ts`, `src/lib/events.ts` (`updateEvent`, `setEventDays`, `decideApplication`, `withdrawApplication`, `setAvailability`, `setConfirmation`), `archive-lock.test.ts`
- **Do:** one `lockRefusal` check at the top of every write that belongs to an event; message "This event is finished - reopen it to change it". Rewrite the tests that assert partial locking.
- **Acceptance criteria:**
  - [x] Every event-owned write on a complete event is refused and writes nothing (one test per write)
  - [x] After reopen, the same writes succeed
- **Depends on:** Task 3

### Task 5: A Discord DM is sent once per notification

- **Serves:** R-105 / UC-25 outcome, 2c, 9a
- **Files:** `src/lib/notifications.ts`, `src/db/schema.ts` (+ migration `notification_dm_claims`), `notifications.test.ts`, `migrations.test.ts`
- **Do:** before sending, insert `(user, dedupeKey)` into `notification_dm_claims` with `onConflictDoNothing ... returning`; DM only the rows returned. Works for members with the in-site bell off. Fix the comment that claims otherwise.
- **Acceptance criteria:**
  - [x] With a stubbed sender and token, calling `notify` twice with the same key sends one DM per opted-in member
  - [x] Two reminder runs inside the 36 h window send one DM
  - [x] A member with in-site off and DM on gets one DM, no in-site row
- **Explicitly not in this task:** retries of failed DMs (UC-25 2d: none)
- **Depends on:** none. **Until this ships, do not set `DISCORD_BOT_TOKEN`.**

### Task 6: Announcements say what they do

- **Serves:** R-107, R-108, R-111 / UC-26 3a, 4a, 4b, UC-27 2, 5a
- **Files:** `src/lib/discord.ts`, `src/lib/announce.ts`, `src/app/admin/settings/page.tsx`, `src/components/admin/AnnouncementSettings.tsx`, `src/app/admin/settings/actions.ts`, `src/lib/admin-dashboard.ts`, `announce.test.ts`
- **Do:** settings status reads the resolved webhook (settings, then env); decision announcements read the row before checking the matching switch; announce declined too; failures carry the event id and appear on the admin home; settings save validates every field before writing any; a way to clear the site address.
- **Acceptance criteria:**
  - [x] Webhook saved in settings shows as configured
  - [x] Accepted switched off, waitlisted on: a waitlist decision posts
  - [x] A failed post appears on the admin home and under that event in the audit log
  - [x] Valid webhook + invalid address saves nothing
- **Depends on:** none

### Task 36: Close the remaining lock races (found in Task 4 review)

- **Serves:** R-39 / UC-09 6b
- **Files:** `src/lib/draft.ts` (`setTeams`, `setCaptains`, `setDraftConfig`, `setDraftPool`, `setPoolKind`, `clearBid`), `src/lib/events.ts` (`setEventDays`, `setEventQuestions`), `src/lib/format.ts` (`clearMatch`), `src/lib/__tests__/archive-lock.test.ts`
- **Do:** these writes check the finished-event lock with a plain read, not under the event row lock, so a write that reads `live` just before completion can commit just after. Read the event with `lockEvent(tx, …)` inside the write's transaction, as `applyToEvent` does. `clearMatch` runs two separate transactions, so completion landing between them leaves `setWinnerOverride` committed when `recordGames` refuses; make it one transaction.
- **Acceptance criteria:**
  - [x] Each listed write guards and writes inside one transaction holding the event row lock
  - [x] `clearMatch` either clears everything or nothing when the event is completed mid-call (explicitly sequenced test, no timing luck)
  - [x] Existing lock table still passes
- **Depends on:** Task 4. Runs with Section D (it touches the draft and format files those tasks change).
- **Left over:** two follow-ups, both recorded as tasks of their own — **Task 56** and **Task 57**. The work itself:
  All nine writes the Files line names now take `lockEvent(tx, …)` inside one transaction and decide on reads taken under it. Two of the nine — `setTeams` and `setCaptains` — Task 18 had already moved; they are in `archive-lock.test.ts`'s `LOCK_FIRST` table anyway, so they stay moved. The other seven (`setDraftConfig`, `setDraftPool`, `setPoolKind`, `clearBid`, `setEventDays`, `setEventQuestions`, `clearMatch`) are the ones this task moved. `clearBid` needed a second read moved as well as the status: an award committing while it queued for the lock settles the lot, and clearing a bid off a settled lot rewrites what the winner paid, so "is this lot still open" is asked after the lock too.
  `clearMatch` was two transactions — `setWinnerOverride` then `recordGames`, each taking the lock and making the refusal again — and is now one. That needed the two engines split: `overrideIn` and `recordGamesIn` in `src/lib/format.ts` are those functions' bodies with the lock and the refusal lifted out, so the public pair and `clearMatch` reach the same code under one lock instead of three.
  **The `HalfCleared` throw is a deliberate decision and not a tidy-up.** Nothing in this repo calls `tx.rollback()`, and drizzle *commits* a transaction whose callback returns rather than throws — so a refusal returned from `recordGamesIn` after `overrideIn` had already dropped the override would have been a refusal reported over a committed half-clear, which is the exact defect the single transaction was meant to remove. Those refusals are therefore thrown as a module-private `HalfCleared`, which rolls the transaction back, and turned back into the same sentence at the function boundary. It is the one place in `format.ts` that rolls back, and the one place that needed to.
  The test device is `completing(eventId, { sql, when })` in `archive-lock.test.ts`: the event is marked complete either side of the one statement matching `sql`, sequenced rather than raced, because the window is one statement wide and a test that had to *win* a race would pass by luck. It flattens the write's transaction, which it has to — PGlite is a single connection and a statement issued inside an open transaction on it waits for a transaction that is waiting for it — so it does not exercise the rollback, and each test asserts outright that nothing was written instead. It also reports whether it fired, because a pattern aimed at a statement that is no longer issued otherwise leaves the test passing on a run with no completion in it (proved: a pattern matching nothing passed).
  **What it handed on.** Task 56: `reflipMatch` decides `if (!match)` on a whole-row read taken *before* `lockEvent` and never re-reads, and `waiveEntryRule`/`revokeEntryWaiver` have exactly the plain-read-then-write shape this task describes but were not on its list — found while walking the module, out of scope here. Task 57: the `HalfCleared` reasoning above is the second independent sighting of "a refusal returned from a transaction commits" (Task 22 was the first, in `recordGames`), and a rule found twice and written down nowhere is the thing to fix.
  Also corrected while here, because `LOCK_FIRST`'s prose claimed it and it was not true: there was **no** lock-ordering assertion for `recordGames` anywhere, and replacing its `lockEvent` with the plain `readEvent` beside it left all 3409 tests green. `format-db.test.ts` has one now ("reads the event with its row lock, and reads it first"), mutation-proved as the only test in the suite that fails on that swap.

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
  - [x] Every checkbox's hit area is at least 44x44 at 375px, measured
  - [x] The drawn box is unchanged
  - [x] Keyboard behaviour and the focus ring are unchanged
- **Depends on:** Task 31a
- **Left over:** nothing, but the gap was not the measurement. Two raw native checkboxes were still outside `components/ui` - `ResultsTab.tsx` (eyebrow-sized, so genuinely under the floor) and `ServerSettings.tsx` (clearing 44px only by accident, with no `min-h-11` guaranteeing it) - and the sweep written to catch exactly that could not see them, because `callSites()` matched only `<Checkbox` elements. A sweep keyed to the fixed form cannot report the unfixed form. Both are converted and the matcher now also finds raw `type="checkbox"` outside `components/ui`. The keyboard criterion also had nothing holding it: swapping the native input for `<div role="checkbox">` with identical classes passed every assertion while the space bar stopped working, so the markup is now asserted to be a real checkbox input.

### Task 37: Make the file-backed migration test reliable (found in Task 7 review)

- **Serves:** the test gate itself (no requirement)
- **Files:** `src/db/__tests__/migrations.test.ts`
- **Do:** "the file-backed local database - creates its directory, migrates, and survives a reopen" failed once under a full parallel run and passed alone and on every rerun. It boots two file-backed WASM Postgres instances in an `mkdtemp` directory, replays every migration into each and deletes the tree, inside a 30s budget, while a dozen vitest workers do similar work; on Windows that is where a timeout or a data-dir file-handle contention appears. Give it a budget that matches what it does, or isolate it from the parallel pool.
- **Acceptance criteria:**
  - [x] The test passes in ten consecutive full-suite runs
  - [x] It still asserts a real reopen (a row written before the close is read after it)
- **Depends on:** none. Do it before the suite is used as a release gate at Gate 3.

### Task 44: Cite the one-championship-per-event rule correctly (found in Task 42 review)

- **Serves:** the docs themselves (no requirement - that is the point)
- **Files:** `src/lib/championships.ts:358`, `src/lib/championships.ts:772`, `src/db/schema.ts:2016`, `src/components/admin/events/ChampionshipTab.tsx:48`, `src/db/__tests__/championship-constraints.test.ts:10`, `src/lib/__tests__/championship-events.test.ts:281`, `docs/use-cases.md:1140`
- **Do:** seven places cite **R-196** for "an event belongs to at most one championship" (the unique index `championship_events_event_uniq`). R-196 is the scoring-rules requirement and has nothing to do with it. The rule genuinely has no numbered requirement - it lives in `docs/requirements.md:319` under Constraints, and the behaviour is `UC-32 1a`. Replace the citation in all seven with `UC-32 1a` and a pointer to the constraint. Comment and doc text only; no behaviour changes.
- **Acceptance criteria:**
  - [x] `grep -rn "R-196" src/ docs/` returns only the scoring-rules uses
  - [x] The test suite is untouched and still green (nothing but comments moved)
- **Depends on:** none.

### Task 49: Two admins can still hand one event to two hosts (found in Task 23)

- **Serves:** R-86 / UC-21 5a
- **Files:** `src/db/schema.ts` (+ migration on `event_hosts`), `src/lib/hosting.ts`, tests
- **Do:** Task 23 made `approveHostApplication` re-read the event inside its transaction and refuse one somebody else already hosts, which closes the ordinary case. It is still a read-then-insert: two admins approving two different applications onto the same event in the same instant can both pass the read. The database should refuse the second - a unique constraint on `event_hosts.event_id`. That needs its own duplicate-row decision against production rows nobody has inspected (an event with two host rows today must be resolved before the constraint can be created, the same way Task 23's 0018 had to withdraw duplicate pending applications), which is why it was not folded into that task.
- **Acceptance criteria:**
  - [x] Two simultaneous approvals onto one event: exactly one wins, proven with the sequencing helpers
  - [x] The migration states what it does with an event that already has two hosts, and why
  - [x] `requireEventManager` still admits the one host it kept
- **Depends on:** Task 23.
- **Left over:** nothing, and it needs recording because this task's work is in the tree too — `drizzle/0025_event_host_one_per_event.sql` creates `event_hosts_one_host_per_event`, `src/lib/hosting.ts` turns its rejection back into `ALREADY_HOSTED` — the same sentence the in-transaction read produces, so the two approvals differ in timing and in nothing else, and the duplicate-row decision the task was held back for is taken in the migration: **the earlier grant survives** (`granted_at` ascending, `user_id` breaking the tie), because a host grant is a permission somebody has been *using* rather than an intention — the opposite of drizzle/0018's choice, for the reason 0025 states. The loser is told, in a `host_decision` notification that cannot be muted, and the admins are told in an audit line against the event (R-110 / UC-27 3). `src/db/__tests__/helpers.ts`'s `makeHost` had to narrow its `onConflictDoNothing` to the primary key, because a bare one now forgives the new index as well — a fixture that hides the rule it is set up under is worse than one that fails.
  What came out of it is **Task 55**: proving the gap by deleting the `uniqueIndex(...)` line from `schema.ts` alone left the whole suite green. That probe also left a stray `0026` file, its snapshot and a journal entry, which had to be removed by hand — hence Task 55's criterion that the guard clean up after itself.

### Task 48: The audit filter pays for seat counts it throws away (found in Task 28 review)

- **Serves:** R-110 / UC-27 3
- **Files:** `src/lib/events.ts`, `src/app/admin/audit/page.tsx`
- **Do:** `/admin/audit` calls `listEvents()` to fill its `<select>` and to resolve the filter, but `listEvents` groups a count over the whole `applications` table to build seat summaries the dropdown discards. The page is `force-dynamic`, so that runs on every render, including the unknown-filter branch that reads no rows at all. Add a narrow `listEventOptions()` returning `{id, title}` and call that instead.
- **Acceptance criteria:**
  - [x] `/admin/audit` no longer reads `applications`
  - [x] The filter still lists every event, and an unknown id still says so
- **Depends on:** nothing, but it edits `src/lib/events.ts`, so it must not run beside a task that owns that file.

### Task 47: The question dialog still says answers will be cleared (found in Task 14)

- **Serves:** R-09 / UC-03 5a
- **Files:** `src/components/admin/QuestionDialog.tsx`, `src/components/admin/QuestionList.tsx`
- **Do:** Task 14 made retiring a question keep every answer, and made editing one stop stranding them - but those two files were outside its scope, so `QuestionDialog`'s confirmation still warns that answers "will be cleared". It now means the opposite of what happens. Rewrite the copy, and move the retire control onto the question row where it belongs, instead of the separate panel Task 14 had to put it in.
- **Acceptance criteria:**
  - [x] No copy in the admin games screens claims an answer is destroyed by retiring or editing a question
  - [x] Retire and restore are reachable from the question row
- **Depends on:** Task 14.

### Task 45: A decided series stops listing games nobody will play (found in the browser sweep)

- **Serves:** R-79 / the bracket and results pages
- **Files:** `src/components/format/MatchCard.tsx` (the "Side and map" list, ~lines 138-157), its tests
- **Do:** the card prints one side-and-map row per game of the series, "including games that have not been played, which are precisely the ones the answer is still needed for". That holds while a series is live and is false once it is decided: a Bo3 won 2-0 still prints `G3 - Voss Vanguard picks the side · Bergstrom Brigade picks the map` in the future tense, styled exactly like the played games, on an event that finished a month ago. Next to it a genuinely live semi prints the same shape, so a reader cannot tell a finished series from an unfinished one. Once the match has a winner, drop the unplayed rows (or mark them "not needed" - pick one and say why in the docblock). A drawn decider waiting on `winner_override_id` is *not* decided and must keep its rows.
- **Acceptance criteria:**
  - [x] A Bo3 won 2-0 lists G1 and G2 only
  - [x] A live Bo3 at 1-0 still lists G2 and G3 in the future tense
  - [x] A series frozen on a drawn decider keeps every row
  - [x] Proven by mutation: restoring the old behaviour fails a test
- **Depends on:** none.

### Task 46: Avatar initials are read aloud before every name (found in the browser sweep)

- **Serves:** accessibility of every roster, table and profile
- **Files:** `src/components/ui/Avatar.tsx`, its tests
- **Do:** when there is no image the avatar renders the member's initials as text, and nothing hides them from assistive tech - so a screen reader announces every name twice over, as "FD Faro Delgado", in the standings, the draft room, the rosters and the profiles. The name is always printed beside the avatar, so the initials are decoration: mark them `aria-hidden`. Check whether an avatar *with* an image has an `alt` that repeats the adjacent name for the same reason.
- **Acceptance criteria:**
  - [x] An imageless avatar contributes nothing to the accessible name of its row
  - [x] An avatar with an image does not repeat the adjacent name
- **Depends on:** none.
- **Left over:** nothing outstanding, but the fix reached a file this task never claimed. `aria-hidden` cannot be made responsive, so `src/components/NavMenu.tsx` needed its own treatment: `role="img"`/`aria-label` on the unread dot (:138-139) and `sr-only ... sm:not-sr-only` on the name (:151). Tested at `src/components/__tests__/avatar.test.ts:224-264`. Recorded because the Files line above does not mention it.

### Task 50: Drop the two dead date columns, and the index that only reads them (found in Task 12 review)

- **Serves:** R-24 / UC-11 2 — the follow-up Task 12 names in its Files line
- **Files:** `src/db/schema.ts` (`events.startsAt`, `events.endsAt`, `events_status_starts_at_idx`), new migration, `src/db/__tests__/migrations.test.ts`
- **Do:** Task 12 stopped reading `events.starts_at`/`ends_at` and drizzle/0020 backfilled a day row from them, so nothing reads or writes either column. Drop both. **Drop `events_status_starts_at_idx` with them:** it indexes `(status, starts_at)`, and now that an event's dates are its days' there is nothing left that filters or orders by that column — the hub's "what is on, soonest first" sorts in TypeScript over `readDatesFor`, so the index is two columns of write cost for a query nobody makes. What the listings actually ask for is status alone, so replace it with an index on `status` if the plans show one is wanted; measure before adding it rather than keeping this one by default. The drop also needs the live rows looked at first (Risks: "Dropping a column that holds live data"): count the events whose `starts_at` disagrees with their first dated day, and decide per row — 0020 deliberately left a partially dated event's day list alone, and an `ends_at` that was never a day's start was never backfilled at all.
- **Acceptance criteria:**
  - [x] `grep -rn "starts_at\|ends_at" src/ drizzle/` shows no reference to the `events` columns outside the migrations that made and dropped them
  - [x] The migration test replays the backfill and the drop in order and still proves the backfilled day survives
  - [x] `EventRow` no longer carries a `startsAt`/`endsAt` that is not derived, so `withDates` and `withKnownDates` can go
  - [ ] Whatever index replaces it is justified by a query in the code, named in the docblock
- **Depends on:** Task 12.
- **Left over:** the measurement. **No index replaces `events_status_starts_at_idx`**, which is the fourth criterion answered by declining to add one: `DATABASE_URL` is blank in this working copy by design, so nothing here can `EXPLAIN` the one selective read (`listEvents({ status: "live" })`), and this task asked for a replacement to be measured rather than inherited. `src/db/schema.ts` records the query to run when the table is large enough for the answer to differ; that is the one thing still owed, and it needs production.
  Two things found in review of the migration itself. **drizzle/0026's guard refused a deploy on a supported state.** It raised an exception for any event with `starts_at` set and no dated day, on the claim that drizzle/0020 made that impossible — but a day's time can be cleared *after* 0020 ran: `setEventDays` writes `startsAt: day.startsAt ?? null`, `dayListProblem` asks for neither a time nor a minimum day count, and an undated day list is the documented "times to be agreed" state (UC-08 E3). So a legacy event whose manager cleared its day times, or deleted its days, between the two deploys halted the deploy and every migration behind it — and the HINT's remedy ("give them a dated `event_days` row") would have **re-dated an event somebody deliberately un-dated**, handing it back a card date, a place in "what is coming up", a countdown and an answer deadline. It is a `RAISE NOTICE` now, and the audit insert was extended to cover the shape (`OR (starts_at IS NOT NULL AND NOT EXISTS (dated day))`), so the instant is written down either way — which was the whole of what the refusal was for. Both shapes are replayed from 0000 in `migrations.test.ts`.
  And **the first criterion was weaker than the rule it stood for**, the same way Task 51's was: it greps for `starts_at|ends_at`, so it cannot see a comment that writes the columns in camelCase. `src/lib/discord.ts` still claimed "the two date columns are dead (see `events.startsAt` in `src/db/schema.ts`) … they are null" — a symbol that no longer exists, describing columns that are gone rather than null. Its twin in `discord.test.ts` was updated and this one was missed. The assertion per behaviour is the criterion that holds; the grep is a convenience.

### Task 52: A template carries the whole setup (left over from Task 13)

- **Serves:** R-22 / UC-08 10a, UC-28 3a
- **Files:** `src/db/schema.ts` (+ migration on `event_templates`), `src/lib/admin-templates.ts`, `src/lib/events.ts` (`createEvent`), `src/app/admin/events/actions.ts` (`createEventAction`), `src/components/admin/events/EventEditor.tsx` (`TEMPLATE_OMITS`), tests
- **Do:** Task 13 captures the type, the game, `config` (so format, entry mode and the waitlist switch) and the questions, and proves they reproduce. It does **not** capture the days, the capacity or the two rank thresholds, and could not: those are columns on `events`, not keys in `config`, so `createEvent` reads them from its own input and never from the template. The only migration-free route - stashing them in `event_templates.config.setup` - is a trap, because `createEvent` copies `config` wholesale, so every event made from such a template would carry a dead second copy of its own capacity alongside the column. That is a stored duplicate of a derived fact, which this project does not do.
  So: give `event_templates` real columns for them, teach `createEvent` to apply a template's setup where its input is silent, and shorten `TEMPLATE_OMITS` to what is genuinely left behind. Task 13 pinned the current promise in a test (`leaves the days, the cap and the rank thresholds behind, as TEMPLATE_OMITS says`) - that test is the one to rewrite, and it names itself as such.
- **Acceptance criteria:**
  - [x] A template made from an event reproduces its days, capacity and both rank thresholds on a new event
  - [x] `TEMPLATE_OMITS` lists only what is still left behind, and the editor and `/admin/templates` print the same list
  - [x] Nothing is stored twice: a new event's capacity lives in its column and nowhere else
  - [x] The migration states what it does with templates that predate the columns
- **Depends on:** Task 13. Needs a migration and `src/lib/events.ts`, so it must not run beside a task holding either.
- **Left over:** nothing. Four columns on `event_templates` (drizzle/0027), inert on every existing row by construction - the three nullables default to NULL and `days` to `'[]'`, and in each case that *is* the old behaviour, so an old template keeps producing the events it produced yesterday. No backfill, and deliberately no attempt to reconstruct a template's setup from the events it made: `events.created_from_template_id` would make that possible and it would be a guess about intent stored as a fact. The rank-threshold check moved to `rankGateProblem` in `src/lib/events-policy.ts` so a *template* cannot store "Diamond" against a game whose ladder stops at Gold - otherwise the refusal arrives at the wrong end, against the wrong person, on a setup they did not just type. `createEvent`'s three checks now read `days`, `capacity` and `next` **after** the template is folded in, so nothing from a template skips a rule and no rule moved to after the insert to let one through.

### Task 51: One rule for what a day is called (found in Task 12 review)

- **Serves:** UC-08 E3 / the overview, the schedule, the apply form and `/me/events`
- **Files:** `src/app/events/[slug]/ScheduleTab.tsx:222`, `src/components/apply/ApplyForm.tsx:378`, `src/components/me/MyEventCard.tsx:344`, their tests
- **Do:** `dayName` in `src/lib/events-policy.ts` is the rule — the manager's label, or "Day N" — and the day-sequence refusals name days with it, so a refusal and the page agree. Task 12's new overview panel calls it. These three still have their own copy, and it is a *different* rule: `label ?? \`Day N\`` renders a whitespace-only label as a blank where `dayName` renders "Day 1", because `??` only catches null. Call `dayName` from all three. Note they number from `day.dayIndex` rather than the array index, which is the better input — `dayName` takes an index, so pass `day.dayIndex` and keep that behaviour.
- **Acceptance criteria:**
  - [ ] `grep -rn "Day \${" src/components src/app` finds no fallback outside `dayName`
  - [x] A day labelled `"   "` is called "Day 1" on all four surfaces
  - [x] A labelled day is unchanged on all four
- **Depends on:** Task 12.
- **Left over:** nothing. The overview panel's input was the array position and is now `day.dayIndex`, like every other surface (`src/app/events/[slug]/page.tsx`), and a **fifth** surface turned up with both of the original defects — the applicant drawer's day rows in `src/components/admin/events/ApplicantsTab.tsx`, which carried the weak `??` *and* the array position. Both are ported, and the drawer is now one more block in `src/components/__tests__/day-names.test.ts`. Note why the fifth one was missed: the first criterion above greps for `Day ${`, and that surface wrote the number as JSX (`Day {index + 1}`), so the criterion was weaker than the rule it stood for. The assertion per surface is the criterion that holds; the grep is a convenience.
- **Left over (second pass):** the fourth surface the Do line names - the public event overview - had no blank-label test; reverting it to `label ?? \`Day N\`` left the suite green. Now covered. The first criterion stays **unticked on purpose**: the grep returns four hits, none of them a `label ??` fallback, so the rule holds while the literal grep does not read clean - and a fifth surface was originally missed because it wrote the number as JSX, which the grep cannot see either. The per-surface assertion is the criterion that holds. `DaysTab.tsx` was left alone deliberately: it is the editor where the label is *typed*, so a positional heading is correct there, and it is outside this task's Files line.

### Task 53: Two admins can still make two templates with one name (found in Task 10/35 review)

- **Serves:** R-125 / UC-28 4a
- **Files:** `src/db/schema.ts` (`event_templates.name`, + migration), `src/lib/admin-templates.ts` (`nameTaken`, `freeName`, `takenNames`), tests
- **Do:** UC-28 4a refuses a typed name another template already has, and `createTemplate` and `updateTemplate` both enforce it — by reading every name, lowercasing, and comparing. There is no unique index behind that read, so it is advisory: two admins creating "Rivals cup" in the same instant both pass `nameTaken` and both insert, and `freeName`'s "copy", "copy 2" suffixing has the same race. The database should refuse the second — a unique index on `lower(name)`, which is also the comparison the code makes (`takenNames` folds case, so a plain index on `name` would not match the rule it is enforcing).
  Not done in Task 10's review batch because it needs a migration and a duplicate-row decision against production rows nobody can inspect from here: two templates whose names differ only by case, or by collapsed whitespace, must be resolved before the index can be created, exactly as Task 23's 0018 had to withdraw duplicate pending applications first. Deciding that against a live table is the task.
- **Acceptance criteria:**
  - [x] Two simultaneous creates of one name: exactly one wins, proven with the sequencing helpers in `src/lib/__tests__/events-concurrency.test.ts`
  - [x] The refusal the loser gets is `nameClash`'s sentence, not a database error
  - [x] `freeName`'s suffixing retries on a lost race rather than failing the duplicate
  - [x] The migration states what it does with templates that already share a name, and why
  - [ ] `cleanTemplateName`'s space-collapsing and the index agree on what "the same name" means
- **Depends on:** Task 13, Task 35. Needs a migration, so it must not run beside another that holds one.
- **Left over:** one documented divergence, which is why the last criterion is unticked. The index expression is **not** `lower(name)` as this entry originally said: `cleanTemplateName` collapses whitespace and `takenNames` collapses again, so `lower(name)` alone would admit "Rivals  cup" beside "Rivals cup" - the index would be *weaker* than the rule it exists to enforce. It folds the same way the code does, with `[[:space:]]` rather than `\s` (equivalent here, but `\s` silently folds the **letter s** if `standard_conforming_strings` is ever `off`, which would build a working index on a different meaning of "the same name" in a file that can never be changed again). What remains: Postgres folds ASCII whitespace only, JavaScript's `\s` includes U+00A0, so a name separated by a non-breaking space is a duplicate to the code and distinct to the database. The **code is the stricter side**, which is the safe direction - it refuses before the index is consulted, so the gap costs a race window on an input nobody types and can never surface a raw database error in place of UC-28 4a's sentence. Closing it would mean restating JavaScript's whitespace set by hand in an index expression that cannot be changed without reindexing production. The loser of a pre-existing clash is **renamed**, not deleted (0025) or deactivated: a template is a starting point with a label on it, the conflict is entirely in the label, and `events.created_from_template_id` is `on delete set null` so a delete would blank the provenance of every event made from it.

### Task 54: A stale draft pool can still seat somebody who is not accepted (found in Task 18/33 review)

- **Serves:** R-61, R-62, R-66 / UC-15 outcome, UC-16 7, and the same rule as Tasks 8, 14 and 19 — a decision about a seat has to reach everything built on top of it
- **Files:** `src/lib/draft.ts` (`openLot`, `awardLot`, and the pool reads behind them), `src/lib/__tests__/draft.test.ts`
- **Do:** `setDraftPool` snapshots the accepted applicants into `draft_pool_entries`, and nothing invalidates that snapshot afterwards. `openLot` and `awardLot` never re-read application status, so: accept somebody, pool them, then decline, waitlist or withdraw them, then open their lot and award it — and a team pays real money for a seat the event has already taken away, with a withdrawn member left sitting on a team roster that the draft room, the rosters on the event page and the format all read as real. It is the same shape as the bug Task 8 fixed one layer up: a status change that other tables were not told about.
  Re-read acceptance **inside the award transaction**, with the event row already locked, exactly as `placeOnRoster`'s `rosterGuard` does today (which is why hand placement is clean and this is not). Awarding to somebody no longer accepted is a refusal naming them, not a silent skip — the room is watching, and a lot that quietly does nothing is worse than one that says why. Decide at the same time what `openLot` should do about an entry that has gone stale: refusing to open it is the honest answer, and the pool read the room sees should not be offering them either.
  Left for its own task rather than folded into Task 18: Task 18 owns forming teams by hand, this is the draft room's award path (Task 19's area), and the fix needs a decision about the stale pool entries themselves — whether a status change prunes the pool eagerly or the award path alone holds the line. Eager pruning is tempting and is the trap: it would mean a decline silently rewriting a pool the manager built, which is the kind of quiet change this project refuses elsewhere.
- **Acceptance criteria:**
  - [x] Accept → pool → decline, then award: refused, naming the person, with no `team_members` row and no balance moved
  - [x] The same for waitlisted and for withdrawn, since all three are "not accepted" and only one of them is the member's own doing
  - [x] Opening a lot on a pooled player who is no longer accepted is refused too, so the room is never shown a lot that cannot be awarded
  - [x] A member who was accepted all along is unaffected: the existing award tests still pass untouched
  - [x] Nothing is stored to make this work — acceptance is re-read, never copied onto the pool entry
- **Depends on:** Task 19. Touches `src/lib/draft.ts`, so it must not run beside Task 18 or Task 19.
- **Left over:** nothing. The decision the task asked for went the way it predicted: **a status change prunes nothing**, the pool entry stays exactly as the manager built it, and the award path holds the line — `openLot` refuses a named player who is no longer accepted and leaves them off the wheel otherwise, `awardLot` refuses on the row it is about to write with the event already locked, and `getDraftSnapshot`'s pool read filters by the same question so the room is never shown a lot that cannot settle.
  Three things tidied in review. The citation was wrong on all three of those paths: they cited **R-61, R-62**, which are hand-set rosters and captains; the requirement about this path is **R-66** ("award a player to the winning bid, discard them or send them to the reserve pool, so that every lot is settled"), with UC-16 pre1 — "pool is the accepted non-captains" — being the invariant the re-read restores. R-61 and R-62 are kept where the shared rule is the point, which is that a bought seat and a hand-placed seat are the same roster row. The acceptance read also existed in **four byte-equivalent copies** in one file: the new `acceptedAmong` and `seatStatus` helpers, plus inline queries in `setCaptains` and `placeOnRoster` that were literally those two functions written out; both call sites now call the helper. And `noSeatPhrase` fell through to "has no application for this event" for any unlisted status — true of a missing row and of nothing else, so a sixth member on `application_status` would have produced a confidently wrong sentence. It is an exhaustive switch with a `never` arm, and `accepted` is excluded from its parameter type rather than given a sentence it has no honest one for.

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
  - [x] Tie rule ordered exactly as specified, and level players shown level
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
  - [x] Existing events behave exactly as before (first come, waitlist)
- **Depends on:** Task 4

### Task 8: Freed seats always go to the next in line

- **Serves:** R-54, R-55, R-58, R-100 / UC-12 8, UC-13 3a, 5a, UC-14 3a, 5-6
- **Files:** `src/lib/events.ts`, `src/app/apply/actions.ts`, `src/app/me/events/actions.ts`, `src/app/admin/events/actions.ts`, `src/components/admin/events/ApplicantsTab.tsx`, `src/components/me/MyEventCard.tsx`, `events.test.ts`
- **Do:** one `freeSeat` rule used by withdraw, decline, waitlist-from-accepted and "not coming": promote the earliest waitlisted in the same transaction and notify both. Applying notifies and audits. Accepting over the cap asks for confirmation first.
- **Acceptance criteria:**
  - [x] Each of the four ways a seat frees promotes the earliest waitlisted, notified (rewrite `events.test.ts:1102`)
  - [x] "Not coming" frees the seat
  - [x] Over-cap accept needs a confirmed second call; cap unchanged
- **Depends on:** Task 7
- **Left over:** nothing. The promotion half was strongly held all along (full-queue `toEqual` on all four paths), but the **notification** half was unheld on the two member-driven ones: deleting either `tellThePromoted(...)` call in `src/app/me/events/actions.ts` left the suite green while a withdrawal or an "I can't make it" promoted the next person and never told them. Every file importing that module mocked it away. Now covered by `src/app/me/events/__tests__/promotion-notice.test.ts`; the mutation kills four tests across both call sites.

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
  - [x] Each 10c rule refused with its named message; nothing saved
  - [ ] Unpublished saves notify nobody
- **Depends on:** Task 3

### Task 12: Event dates come from its days

- **Serves:** R-24, R-40, R-41, R-97 / UC-10, UC-11 2, UC-25 9
- **Files:** `src/lib/events.ts` (`listEvents`, summaries), `src/lib/notifications.ts`, `src/app/page.tsx`, `src/app/events/[slug]/page.tsx`, `src/components/admin/events/BasicsTab.tsx`, `src/db/schema.ts` (+ migration dropping `starts_at`/`ends_at`, and the index that only reads them, in a follow-up commit — Task 50)
- **Do:** start = first day's start; end = last day's; overview lists every day. Backfill a day from `starts_at` for any event that has none, then stop reading and drop the columns. Reminders to accepted seats only.
- **Acceptance criteria:**
  - [ ] Listings, hub, reminders order and filter by derived dates (existing tests pass unchanged in meaning)
  - [x] Migration backfill test: an event with only `starts_at` gains a day
- **Depends on:** Task 11

### Task 13: Unsaved changes and templates from an event

- **Serves:** R-22, R-31 / UC-08 9a, 10a
- **Files:** `src/components/admin/events/UnsavedChanges.tsx`, `src/components/admin/events/EventEditor.tsx`, `src/lib/admin-templates.ts`, `src/components/admin/TemplatesManager.tsx`
- **Do:** lock also covers back/forward (popstate) and programmatic navigation; "Save as template" in the editor (admin only) capturing days, cap, rules, questions, format. The templates page keeps all its features (UC-28, pinned in Task 35).
- **Acceptance criteria:**
  - [x] Browser back with unsaved edits shows the bar and stays
  - [x] Template from an event reproduces its setup on a new event
- **Depends on:** Task 12
- **Left over:** the template captures the type, the game, `config` (so format, entry mode and the waitlist switch) and the questions, but **not** the days, the capacity or the two rank thresholds - those are columns on `events` rather than keys in `config`, so `createEvent` reads them from its own input and never from the template. `src/lib/__tests__/admin-templates.test.ts:1034-1060` pins that absence deliberately (`expect(next.capacity).toBeNull()` and both rank thresholds), so the gap is recorded in a test rather than forgotten - but it was recorded nowhere a reader of this plan would find it, and was traceable only through Task 52's header. **Closed by Task 52**, which gave `event_templates` real columns for all four; that test now asserts they reproduce instead of asserting they are left behind.

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
- **Left over:** nothing, and that is the correction — **every line above landed inside Task 34's commit**, not this one, so the plan read as though Task 22 were still open while the work was sitting in the tree. Line by line, in `src/lib/format.ts`, `src/lib/format-policy.ts` and `src/lib/__tests__/format-db.test.ts`: `unresolvedSlotRefusal` refuses a score against a slot that has not resolved (R-78 / UC-19 pre1), with the deliberate exemption for a patch that only takes something away; `scoreRefusal` and `seriesRefusal` replace `score()`'s **clamp** with sentences (UC-19 4a, 5a) — a negative, a fraction, a word and a number in the millions all used to resolve to "whatever is stored now" while the write reported success, and the named test is rewritten as six; `flagsBetween` reports a later match whose team changed and which has maps on it, from a score, an override and a clear alike (R-79 / UC-19 3a); the side choice before a series and the refusal after one are tested (R-80, R-81 / UC-19 2a, 2b); and a level even series waiting for the manager is tested as four cases (R-159 / UC-19 E4). Why it was recorded late: Task 34's Serves line is R-152 to R-156, R-158, R-160, none of which is any of the above, so nothing in Task 34's own criteria would have noticed it carrying another task's work. A commit that serves two tasks has to say both, which is what this note and Task 34's now do.

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
- **Left over:** two raw checkboxes were missed, and the sweep written to catch that cannot see them. `src/components/admin/events/ResultsTab.tsx:903` and `src/components/admin/ServerSettings.tsx:99` both still carry a raw `type="checkbox"`, and both files are named in the Files line above; `ResultsTab.tsx:902` still carries `className="eyebrow"`. So the acceptance criterion above is **not met**, and nothing noticed, because `callSites()` in `src/components/ui/__tests__/checkbox-hit-area.test.ts` matches only `<Checkbox` elements - it counts the converted call sites and is blind to an unconverted one. There are 4 `<Checkbox` uses against the five this task planned. Note the shape of the miss: a sweep keyed to the *fixed* form cannot report the *unfixed* form. **Closed by Task 38b**: both are converted and `callSites()` now also matches raw `type="checkbox"` outside `components/ui`, so an unconverted control can no longer hide from it. The criterion above also bans `className="eyebrow"` outside `components/ui` and **that half is still open** — `ResultsTab.tsx` carries three more (`:315`, `:574`, `:831`), none of them the checkbox label that Task 38b fixed. Left for Task 32's sweep.

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
- **Also found since, in this task's files:**
  - `BasicsTab.tsx` still offers a hidden game when creating an event, labelled "(hidden)". UC-03 E2 says hiding a game "stops offering it for new events" (found in Task 35, which owns the games library but not this screen).
  - The dev-login banner overlap above is **done** - Task 13 lifted the unsaved-changes bar to `z-[60]`. Nothing left to do there, and it is unverified in a browser.
- **Depends on:** Task 10, Task 16

### Task 34: Kept format and result features

- **Serves:** R-152 to R-156, R-158, R-160 / UC-18 E1-E5, UC-19 E1, E3
- **Files:** `src/lib/format-policy.ts`, `src/lib/format.ts`, `src/lib/format-schedule.ts`, `src/components/admin/events/FormatTab.tsx`, `src/components/admin/events/ScheduleTab.tsx`, `src/components/admin/events/ResultsTab.tsx`, tests
- **Do:** tests for modes per map, series length per bracket and per match, double round robin, moving a block to another day, seeds, and recorded durations feeding the day's schedule; fix what they expose.
- **Acceptance criteria:** every flow listed has a passing test
- **Depends on:** Task 22
- **Left over:** nothing of its own, and three fixes the tests exposed. **`bestOfFor`'s precedence was wrong** (R-154 / UC-18 E2): the order was slot, round, half, and round numbers restart in each half — so a manager who set "round 1 Bo5" to lengthen the opening bracket tie also lengthened every group's first round, straight through the `bestOfByBracket: { rr: 1 }` that a group stage is given to keep table games Bo1. The half wins now. **`seedOrderFrom` ignored a partial seeding** (R-160 / UC-18 E5): it demanded every team have a number before it honoured one, so seeding the top two of four produced a bracket in list order with nothing on screen to say the numbers had been dropped; it is now the one reader of `teams.seed`, and the numbers that are there rank the teams. **A recorded mode and a planned mode could be two strings** (R-152, R-153 / UC-19 E1): `normaliseModeName` is the one spelling both go through.
  Two things landed **outside the Serves line above** and are recorded here rather than left to be rediscovered. R-157 / UC-19 E2's mark: `setMatchSchedule` marked its stage hand-edited on every save, because `recordGamesAction` posts `scheduledAt` whether or not anybody touched it — so recording a scoreline claimed somebody had moved a start time, which `stageTouchOf`, `StageClearing` and `MatchesState` all then repeated. An instruction that lands on the stored instant now writes nothing. That is Task 21's acceptance line, not this task's. And the whole of **Task 22** (see its own note): this commit holds every line of it.
  Also fixed in review, and worth the note because the criterion above could not have caught either: the header table in `format-policy.ts` named `bestOfByRound` for the one row only `bestOfByBracket` can express — the precedence fix made the table say the opposite of the code; and `setTeams` stored `seed: team.seed ?? null` with no validation at all, so `0`, a negative and a fraction all ranked ahead of seed 1 through the very function this task fixed. It has a named refusal now, in `balanceStart`'s style, and duplicate seeds stay allowed because that is a tested decision. "Every flow listed has a passing test" says nothing about whether the docblocks around those flows cite the right ids, which is the same weakness Task 51's grep criterion had.

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

### Task 55: Nothing notices when the schema and the migrations disagree (found in Task 49)

- **Serves:** the deploy itself (no requirement)
- **Files:** `src/db/__tests__/migrations.test.ts` or a new guard beside it
- **Do:** `src/db/schema.ts` is the *input* drizzle-kit generates from; `drizzle/*.sql` is what actually runs. Nothing checks they still agree. Task 49 proved the gap by deleting its `uniqueIndex(...)` line from `schema.ts` alone: the whole suite stayed green, while `npx drizzle-kit generate` would then have emitted `DROP INDEX "event_hosts_one_host_per_event"` - so the next person to generate a migration silently drops a constraint that is protecting production. The same hole covers every index, constraint, default and column type in the file, ~20 indexes among them.
  The guard is "generating from the current schema produces no diff": run drizzle-kit's generate into a scratch directory and fail if it emits anything. Check whether drizzle-kit has a `--check`-style flag before shelling out to a full generate, and make sure the test cleans up after itself - Task 49's probe left a stray `0026` file, its snapshot and a journal entry, which it had to remove by hand.
- **Acceptance criteria:**
  - [x] Deleting any constraint line from `schema.ts` fails the suite
  - [x] The guard leaves no files behind, and does not need the network or a database
  - [x] It names what drifted, not just that something did
- **Depends on:** nothing. Do it before Gate 3, because a silent constraint drop is a production defect that no other test in this repo can see.
- **Left over:** nothing. The guard is `src/db/__tests__/schema-drift.test.ts`, and it does **not** shell out to a generate. There is no `--check`-style flag on `drizzle-kit generate` in 0.31.10 — the subcommands are `generate`, `migrate`, `introspect`, `push`, `studio`, `up`, `check`, `drop` and `export`, and `check` only validates the migration folder against itself while `export` dumps the schema from empty rather than diffing it. But `drizzle-kit/api` exports the two halves `generate` is built from: `generateDrizzleJson(schemaModule)` serialises `schema.ts` the way a snapshot is serialised, and `generateMigration(prev, cur)` diffs two snapshots into SQL. So the guard reads the newest snapshot named in `drizzle/meta/_journal.json`, diffs the live schema against it in memory, and asserts the result is empty — no scratch directory, no subprocess, nothing written on either the passing or the failing path, and so nothing to clean up (the cleanup leak the Do note warns about cannot happen). It also never consults `drizzle.config.ts` or a connection: verified by running it with `DATABASE_URL` pointed at an unreachable host, which it ignored and passed in 970ms. It costs ~45ms of test time plus ~800ms of import, absorbed by the `app` project's parallel pool — 131 files / 3386 tests at 62.75s became 132 / 3388 at 63.41s — so it did not need a vitest project of its own.
  Mutation-proved by deleting one line of `schema.ts` at a time and reading the real failure: the `uniqueIndex` from Task 49 printed `DROP INDEX "event_hosts_one_host_per_event";`, a `.notNull()` printed `ALTER TABLE "profile_fields" ALTER COLUMN "required" DROP NOT NULL;`, a `.default(false)` printed `ALTER TABLE "users" ALTER COLUMN "is_admin" DROP DEFAULT;`, and `check("events_capacity_positive", ...)` printed `ALTER TABLE "events" DROP CONSTRAINT "events_capacity_positive";` — the SQL the next `db:generate` would have written, which is what makes the failure actionable rather than a hunt.
  A second test in the file checks the chain itself: the journal's indexes run 0..n without a gap, every entry it names has both a `.sql` file and a snapshot on disk, and `drizzle/` holds no `.sql` the journal does not list. That is the shape of Task 49's leak (a stray `0026`, its snapshot and a journal entry, removed by hand), and nothing else in the repo would notice it — `applyMigrations` reads the journal, so a file the journal has lost simply never runs. Both halves were mutation-proved too, by adding a stray `drizzle/0027_stray_probe.sql` and by removing a real migration file, each restored byte-identically afterwards.

### Task 56: Two writes still decide before the lock (found in Task 36)

- **Serves:** R-39, R-77 / UC-09 6b, UC-18 9
- **Files:** `src/lib/format.ts` (`reflipMatch`), `src/lib/events.ts` (`waiveEntryRule`, `revokeEntryWaiver`), their tests
- **Do:** Task 36 closed the nine writes its own entry named and found two more it was not asked to touch.
  `reflipMatch` does a bare `select()` of the whole match row **before** `lockEvent` and decides `if (!match)` on it, then never re-reads - precisely what `setWinnerOverride`'s docblock says it was closed against ("an existence check taken before the wait left the `update` below hitting no rows at all and this function answering `ok`"). Its archive refusal and its `played` check *are* under the lock, so this is not an R-39 hole; it is the regeneration case, UC-18 9.
  `waiveEntryRule` and `revokeEntryWaiver` have exactly the shape Task 36 describes - plain `readEvent`, no transaction, then an insert or delete - but were not on its list.
  Note `updateEvent` and `publishEvent` also read the status plainly and are **not** holes: they guard the move with a compare-and-set on `events.status`, a different mechanism.
- **Acceptance criteria:**
  - [ ] Each takes `lockEvent` first, then every deciding read, then the write
  - [ ] A statement-order test per write, in the `logging()` style, because PGlite serialises one connection and a plain read is indistinguishable from a locking one by behaviour alone
  - [ ] `archive-lock.test.ts`'s `LOCK_FIRST` prose updated to say they are covered
- **Depends on:** Task 36.

### Task 57: A refusal returned from a transaction commits (found twice)

- **Serves:** every write in the app (no single requirement - it is the shape of the bug)
- **Files:** audit across `src/lib/*.ts`; tests beside whatever it finds
- **Do:** nothing in this repo calls `tx.rollback()`, and drizzle commits a transaction whose callback **returns** rather than throws. So any write that validates as it goes and returns a refusal partway through has already committed everything it wrote before that point. It has been found twice independently and was a real defect both times: `recordGames` committed the games it had validated while telling the manager nothing was stored (Task 22), and `clearMatch` would have dropped a winner override and then refused the games over a committed half-clear (Task 36). Task 22 fixed its case by staging every write until after every check; Task 36 fixed its by throwing a module-private error and catching it at the function boundary. Both are right; neither is written down as the rule.
  Walk every `database.transaction(...)` in `src/lib/` and classify it: decides everything before its first write (safe), stages and writes once (safe), or writes-then-can-refuse (a bug). Fix the third kind, and write the rule down where the next person will meet it.
  **Keep the rule and a crash apart, because the docblocks did not.** A transaction whose every `fail()` precedes its first write is in the safe class, and a *crash* after a write — a constraint error, an exhausted loop bound — is not this bug at all: the transaction closes and rolls it back, which is the mechanism working. `setEventDays` and `setEventQuestions` in `src/lib/events.ts` were both described as protecting against "a refusal — or a crash — partway down" the renumbering loop, and the refusal half was never reachable: every `fail` in `setEventDays` is at :1879/:1881/:1887/:1894 and its first write at :1914; every `fail` in `setEventQuestions` is at :2084/:2086/:2088/:2173 and its first write at :2179. Both docblocks now say what is actually protected. So the audit's job is to find a refusal *after* a write — not every write inside a transaction that can go wrong.
  **And look for writes with no transaction at all**, because a walk of `database.transaction(...)` call sites will not find them. `createEvent` (`src/lib/events.ts:1442`, `:1447`) is one: it inserts the event row and *then* calls `setEventQuestions` and `setEventDays` on the bare handle, returning `fail` if either refuses. Its own docblock at :1405 says the opposite — "Every refusal before the insert … UC-08 10c says *nothing saved*" — and the refusal is reachable: a template whose `profileFieldKey` resolves to a field whose type has since changed makes `setEventQuestions` refuse, and the caller is told the event was not created over a committed event row. Same class of bug, different cause, and invisible to the obvious grep.
- **Acceptance criteria:**
  - [ ] Every `transaction` callback in `src/lib/` is classified, with the list in the report
  - [ ] Writes that are *not* in a transaction but call a function that can refuse are found too, `createEvent` among them
  - [ ] Each writes-then-refuses case is fixed and has a test proving nothing is committed on the refusal
  - [ ] The rule is stated once, somewhere a writer will see it before their first `tx.` call, and it distinguishes a returned refusal from a throw
- **Depends on:** nothing, but it touches many files, so run it when no other task holds them.

### Task 58: Six copies of one sequencing helper (found in Task 36 review)

- **Serves:** no requirement — test infrastructure
- **Files:** `src/lib/__tests__/format-db.test.ts`, `draft.test.ts`, `events.test.ts`, `format-sync.test.ts`, `admin-users.test.ts`, `championship-results.test.ts`, new `src/db/__tests__/helpers.ts`
- **Do:** `committingAfter` is **byte-identical** in six test files. That is three strikes twice over, and one `db` parameter extracts it cleanly.
  Task 36's review asked for a wider extraction than this and was wrong to: there are **twelve** sequencing helpers across eleven files, and they are not variations of one idea. `committingAfter` does **not** flatten the transaction — it runs `between`, then opens a real `target.transaction(run)`, firing at `BEGIN`. `insertingAfter` (three hand-written copies, in `hosting.test.ts`, `championship-events.test.ts` and `waivers.test.ts`) flattens and hardcodes one builder chain, and the three differ by chain shape (`.values().onConflictDoNothing()`, `.select().returning()`, `.values().onConflictDoNothing().returning()`). `completing` flattens, proxies all four builders recursively, is aimed by a regex over `toSQL()`, and hardcodes its action. Parameterising "where the interruption fires" across those three means a configurable proxy framework harder to read than any of them — so **extract only the six identical `committingAfter`s** and leave the rest.
- **Acceptance criteria:**
  - [ ] One `committingAfter`, imported by all six files, each behaving as before
  - [ ] The other six helpers are left alone, and a comment says why
  - [ ] No test changes what it asserts
- **Depends on:** nothing, but it edits six test files, so run it when no other task holds them. Deferred from Task 36's review as a cosmetic win not worth risking a 132-file baseline mid-task.

## Plan hygiene

A reconciliation of every acceptance criterion against the tree (2026-10-22, at commit `8ef5347`) found the checkboxes had drifted badly: **94 of 100 were unticked**, and 47 of those were met — several by mutation-resistant tests. They are now ticked. Two lessons worth keeping:

- **A criterion written as a grep is weaker than the rule it stands for.** Task 51's `grep -rn "Day \${"` reads clean of `label ??` fallbacks while four hits remain, and a fifth surface was missed entirely because it wrote the number as JSX (`Day {index + 1}`). The per-surface assertion is the criterion that holds; the grep is a convenience. Task 44's criterion has the same shape and nothing holds it — a future edit could reintroduce `R-196` and no test would fail.
- **Tasks 39-43 and Task 31 state their acceptance criteria as prose rather than checkboxes, so no sweep can see them.** Task 31's is **not met** (see its Left over note) and went unnoticed for exactly that reason. Future tasks use checkboxes.

Still open and **not** closable from this repo: Task 50's last criterion asks whether an index on `events.status` is wanted, which needs `EXPLAIN` against production rows. `DATABASE_URL` is blank here by design. The query to run is recorded at `src/db/schema.ts:1091-1116`.
