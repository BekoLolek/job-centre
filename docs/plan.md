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
  - [x] A utility written on a `Field`/`Select`/`Textarea` takes effect, measured before and after on at least three call sites
  - [x] No control changes its rendered size where no utility was written
  - [x] The `AvailabilityPanel` wrapper added in Task 31a is removed if it becomes unnecessary
- **Depends on:** Task 31a
- **Left over:** the mechanism, and a pattern bigger than this task. The fix is `@layer components` around `.field` rather than deleting its `width`/`padding`/`font-size`: **the ordering was the bug, not the declarations**, and criterion 2 needs something to go on supplying the default. Tailwind hoists a `components` layer to the `@tailwind components` position on line 2, so the equal-specificity tie breaks the ordinary way round. Defaults-as-utilities on the components was considered and rejected — `cx` is a string join, so the winner would be decided by Tailwind's emitted sort order rather than by the author, which is the trap `page-width.test.ts` and `checkbox-hit-area.test.ts` both already name; `:where(.field)` drops to 0-0-0 and would lose `color`/`font-family` to Preflight's unlayered `input {}`; a *native* `@layer` fails because Tailwind v3 emits Preflight unlayered and unlayered beats layered at any specificity. The directive has a cost worth remembering: Tailwind tree-shakes the `components` layer, so a selector added to that block whose class never appears in `src/**` is silently not emitted — all five `.field` rules are now pinned by name against that.
  **107 controls sit on the `.field` surface. 19 were losing a declaration** and now get it, 9 write only properties `.field` never claimed, and **79 write no `className` at all** — those 79 are what criterion 2 actually rests on, and their expected values are written out literally rather than read back from `.field`, so deleting a declaration fails instead of agreeing with itself.
  **The gap again was not the measurement.** These are `renderToStaticMarkup` tests in a node environment, so the pixel figures (1010px, 14px, 8px) are the browser's and the new file says so out loud; what it pins is the resolved cascade that produced them, compiled from the real stylesheet in **both** the layered and the unlayered form, so `BEFORE` is byte-for-byte the cascade that shipped. The genuine near-miss was Task 31's lesson arriving from the other side: the first matcher took every string literal containing a `field` token and swallowed the English sentence at `TemplateQuestionList.tsx:128` as a twelve-class call site. It **passed** — none of those words is a class, so it resolved to the defaults — inventing a thirteenth control that does not exist. Narrowing to `className="…"` fixed it and opened the opposite hole, so there is now a guard accounting for every remaining `field`-bearing literal against a one-entry allowlist.
  **`.btn` has the identical defect and was deliberately not fixed** — rightly, because moving it changes rendering at every button call site that writes a utility and none had been measured. Measuring found the pattern is in **nine** unlayered rules, and that `.num` is eight times `.btn`'s size (24 call sites, not 3). That is Task 65.

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
- **Acceptance criteria:** *(were prose, which is why no sweep could see them — see Plan hygiene)*
  - [x] Every page uses `Page` + `PageHeader`
  - [x] No other `max-w-[...]` on `<main>`
  - [x] Verified at 400 px and desktop
- **Depends on:** Task 29
- **Left over:** the third criterion was verified in a real browser, but **not against the live routes**. `DATABASE_URL` is blank here by design and migrating production is forbidden, so no route can render; what was measured at 400px and 1512px is the real `Page` and `PageHeader` over the stylesheet Tailwind compiles from the real `globals.css`, on a static server rather than `next dev`. That settles the *shell* — three caps exact at 880/1200/1400, 16px gutters, the bar and `<main>` sharing one left edge, no horizontal scroll, nothing spilling the column — and says **nothing about the content inside those columns on a phone**. The applicants table, the availability grid, the schedule and bracket tabs and the draft stage are all still unmeasured at 400px, and `/me/profile` at `reading` leaves the 44rem availability grid only 128px of slack. Those belong to the browser sweep, once a database is available.
  **Four routes do not render `PageHeader` in their own `page.tsx`** — they hand it, with their `<Page>`, to `Season.tsx`, `EventEditor.tsx` and `DraftRoom.tsx`, because each one's title, state and figures are derived from data the component already holds and copying that up into the route would be a second place for it to disagree. That is a delegation, not an exemption, and `page-header.test.ts`'s `DELEGATES` map follows each pointer both ways.
  **Three presentation changes are visible and were made deliberately, not inherited.** `/`'s `<h1>` is now the page rather than whichever event is next (the hero title became an `<h2>`, which is also the right outline for a screen reader and stops the heading changing when the calendar does). Every page title is `text-36`, so `/events/[slug]` and `/` dropped from 48 and the draft room rose from 24 — the most arguable call here, made because "one header" means one step, and that page's prominence comes from its banner and countdown rather than its type size. And the pill rows on the two event pages and the editor moved from above the eyebrow to under the title. Also `GAMES & QUESTIONS` → `Games and questions`: it was the only uppercase `<h1>` on the site, against `globals.css`'s rule that the wordmark is the one drawn mark.
  **`PageHeader` has no `className`, on purpose** — a header its call sites can nudge drifts back to thirty headers. It also does not take a `card`/`panel` prop: `Panel` is flat by default here, so the six `<Panel as="header">` headers were merely *inset* from the column their content starts in, which is the one alignment the shell exists to hold. Dropping the wrapper was the fix.
  **`AdminNav` was missing from exactly two admin pages** — `/admin/availability` and `/admin/host` — which are precisely the two that UC-07 1 and UC-21 1 tell an admin to open. Added.
  **A thirteenth mutation escaped, and it was found by running the old test against new code.** `page-width.test.ts`'s bars assertion was `expect(source).toContain("PAGE_SHELL")`, and after the draft room moved to `pageShell("wide")` it stayed green **because a comment in the file mentioned `PAGE_SHELL`** — the same shape as the `toContain("Withdraw")` satisfied by neighbouring prose, and the same shape as the `recordGames` lock whose docblock claimed a test that did not exist. It now requires the shell to be imported *and* named inside a `className`, neither of which prose can satisfy. A near-miss in the new sweep went the same way: `/<PageHeader\b([\s\S]*?)\/>/` stops at the first `/>`, which on five call sites is an `<EventSeats … />` inside `intro`, so every `className` passed *into* a header read as one *on* it; replaced with a brace-depth scanner.
  Making the draft room `wide` closes the arithmetic that forced its two-column layout — 320 + 24 + 560 + 24 + 340 = 1268 now fits inside 1352 — so a third column is possible again above 1400px. It was deliberately not taken: that is a decision for somebody who has watched a draft on a wide screen, not a side-effect of a width token.

### Task 31: Primitives everywhere (three commits: community + me, admin, event editor)

- **Files:** listed per bypass in the audit - `SuggestionBox`, `PollList`, `NotificationList`, `ServerSettings`, `AvailabilityGrid`, `AvailabilityPanel`, `HostQueue`, `HostApplyForm`, `AdminAllowlist`, `FormatTab`, `ResultsTab`, `ScheduleTab`, `ApplicantsTab`, `UnsavedChanges`, `admin/audit/page.tsx`; new `src/components/ui/Checkbox.tsx`
- **Do:** replace raw selects, checkboxes, `btn` classes, hand-made cards, chips, empty states and `className="eyebrow"` with the primitives; add Checkbox (five uses).
- **Acceptance criteria:** no raw `<select`, `type="checkbox"`, `className="btn`, `className="eyebrow"` outside `components/ui`
- **Depends on:** Task 30
- **Left over:** two raw checkboxes were missed, and the sweep written to catch that cannot see them. `src/components/admin/events/ResultsTab.tsx:903` and `src/components/admin/ServerSettings.tsx:99` both still carry a raw `type="checkbox"`, and both files are named in the Files line above; `ResultsTab.tsx:902` still carries `className="eyebrow"`. So the acceptance criterion above is **not met**, and nothing noticed, because `callSites()` in `src/components/ui/__tests__/checkbox-hit-area.test.ts` matches only `<Checkbox` elements - it counts the converted call sites and is blind to an unconverted one. There are 4 `<Checkbox` uses against the five this task planned. Note the shape of the miss: a sweep keyed to the *fixed* form cannot report the *unfixed* form. **Closed by Task 38b**: both are converted and `callSites()` now also matches raw `type="checkbox"` outside `components/ui`, so an unconverted control can no longer hide from it. The criterion above also bans `className="eyebrow"` outside `components/ui` and **that half is still open** — and far wider than first recorded here. This note originally said "three more, in `ResultsTab.tsx`", which was a measurement error: the grep that produced it was truncated with `head -3`, so a limit on the *output* was read as the size of the problem. The real figure is **58 uses across 34 files**, five of them in `ResultsTab.tsx`. Worth keeping as the plainest instance of a rule this plan keeps relearning — a convenience grep is not a criterion, and here it under-reported by a factor of nineteen.
  Two of the 58 sit in files Task 30 edited without closing (`src/app/admin/audit/page.tsx:213`, `src/app/admin/page.tsx:221`) and were left alone deliberately: `<Eyebrow>` adds `text-dim` where the bare class inherits its colour, so every one of the 58 is a colour decision rather than a rename, which is why this cannot be a mechanical sweep. Left for Task 32.

## G. Deletions

### Task 32: Remove dead code and stale comments

- **Serves:** traceability
- **Files:** `src/lib/admin-games.ts`, `src/lib/availability-resolve.ts`, `src/lib/format-resolve.ts`, `src/components/admin/events/SaveRow.tsx`, `src/components/admin/events/UnsavedChanges.tsx`, `src/components/ui/Section.tsx`, `src/components/ui/index.ts`, `src/app/globals.css`, `src/db/schema.ts`, and the files carrying stale comments
- **Do:** delete `activeGameCount`, `EMPTY_ANSWER`, `blankGames`, `InlineSaveRow`, `useIsDirty`, `SectionList`, `.roundel` and the unused `*Relations` objects. Fix comments that point at `session.ts`, `/login`, `TournamentBoard`, `postAnnouncement` or platform-plan section numbers, citing R and UC ids instead. No feature is removed: at Gate 2 every feature was kept (R-113 to R-169), and dev login stays as developer tooling (R-142).
- **Acceptance criteria:** *(were prose — see Plan hygiene)*
  - [ ] Suite, typecheck and build green
  - [ ] Each removed name absent from `src`, asserted by a sweep that reads the names off a list rather than matching the deletions
  - [ ] The stale comments named above cite R and UC ids instead
  - [ ] `className="eyebrow"` outside `components/ui` is resolved — **58 uses across 34 files**, each a colour decision rather than a rename, because `<Eyebrow>` adds `text-dim` where the bare class inherits (Task 31's open half)
  - [ ] `setApplicantAvailabilityAction`'s unread third `eventId` parameter is gone, and its caller stops passing it (Task 1's leftover)
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

- **Serves:** R-39 / UC-09 6b, UC-18 9 — *R-77 was cited here and is wrong: `docs/requirements.md:144` is about later matches shifting when earlier ones finish late, which is re-flow, and `reflipMatch` moves nobody's start time while the two waivers have no schedule at all.*
- **Files:** `src/lib/format.ts` (`reflipMatch`), `src/lib/events.ts` (`waiveEntryRule`, `revokeEntryWaiver`), their tests
- **Do:** Task 36 closed the nine writes its own entry named and found two more it was not asked to touch.
  `reflipMatch` does a bare `select()` of the whole match row **before** `lockEvent` and decides `if (!match)` on it, then never re-reads - precisely what `setWinnerOverride`'s docblock says it was closed against ("an existence check taken before the wait left the `update` below hitting no rows at all and this function answering `ok`"). Its archive refusal and its `played` check *are* under the lock, so this is not an R-39 hole; it is the regeneration case, UC-18 9.
  `waiveEntryRule` and `revokeEntryWaiver` have exactly the shape Task 36 describes - plain `readEvent`, no transaction, then an insert or delete - but were not on its list.
  Note `updateEvent` and `publishEvent` also read the status plainly and are **not** holes: they guard the move with a compare-and-set on `events.status`, a different mechanism.
- **Acceptance criteria:**
  - [x] Each takes `lockEvent` first, then every deciding read, then the write
  - [x] A statement-order test per write, in the `logging()` style, because PGlite serialises one connection and a plain read is indistinguishable from a locking one by behaviour alone
  - [x] `archive-lock.test.ts`'s `LOCK_FIRST` prose updated to say they are covered
- **Depends on:** Task 36.
- **Left over:** nothing. All three writes take `lockEvent` first. `reflipMatch`'s first select was narrowed to `{id, eventId}` — the lock has to be named before it can be taken — and the existence decision moved to a re-read under the lock; its archive refusal and its `played` check were always under it, so UC-18 9's regeneration was the only hole. `waiveEntryRule` and `revokeEntryWaiver` had no transaction at all and are now one each, with the status read off the locked row. Three statement-order tests: `reflipMatch`'s in `format-db.test.ts` beside its engine, the two waivers as `LOCK_FIRST` rows so each also gets the sequenced completion-in-the-window test. Mutation-proved four ways, each the only failure in its file — and **mutations 3 and 4 were caught by `completing`'s `fired()`, not by the census**, because a write that never issues `for update` never lets the completion fire. That assertion was added in Task 36's review fix and earned its keep twice here.
  **Two pieces of false prose corrected.** `format-db.test.ts` claimed "the lock-ordering rule `recordGames` and `reflipMatch` already follow" — false for `reflipMatch`, and the same class of claim that cost `recordGames` its only test in Task 36. A second copy sat in `format.ts`'s `setWinnerOverride` docblock and is now true rather than removed. `LOCK_FIRST`'s prose names the test holding each claim, and says why: a claim in that docblock is worth nothing unless it names one.
  **Also corrected:** `setEventDays`' docblock asserted that a transaction opened inside an open one "would wait for itself". Measured false with a throwaway probe — drizzle runs a nested `transaction` as a **savepoint** on the same session, and an outer throw rolls the inner write back. What does deadlock on PGlite's single connection is a second `db.transaction` on the *handle* while one is open, which is why `archive-lock.test.ts`'s `completing` flattens. Task 57's `createEvent` fix depends on the savepoint behaviour.

### Task 57: A refusal returned from a transaction commits (found twice)

- **Serves:** every write in the app (no single requirement - it is the shape of the bug)
- **Files:** audit across `src/lib/*.ts`; tests beside whatever it finds
- **Do:** nothing in this repo calls `tx.rollback()`, and drizzle commits a transaction whose callback **returns** rather than throws. So any write that validates as it goes and returns a refusal partway through has already committed everything it wrote before that point. It has been found twice independently and was a real defect both times: `recordGames` committed the games it had validated while telling the manager nothing was stored (Task 22), and `clearMatch` would have dropped a winner override and then refused the games over a committed half-clear (Task 36). Task 22 fixed its case by staging every write until after every check; Task 36 fixed its by throwing a module-private error and catching it at the function boundary. Both are right; neither is written down as the rule.
  Walk every `database.transaction(...)` in `src/lib/` and classify it: decides everything before its first write (safe), stages and writes once (safe), or writes-then-can-refuse (a bug). Fix the third kind, and write the rule down where the next person will meet it.
  **Keep the rule and a crash apart, because the docblocks did not.** A transaction whose every `fail()` precedes its first write is in the safe class, and a *crash* after a write — a constraint error, an exhausted loop bound — is not this bug at all: the transaction closes and rolls it back, which is the mechanism working. `setEventDays` and `setEventQuestions` in `src/lib/events.ts` were both described as protecting against "a refusal — or a crash — partway down" the renumbering loop, and the refusal half was never reachable: every `fail` in `setEventDays` is at :1879/:1881/:1887/:1894 and its first write at :1914; every `fail` in `setEventQuestions` is at :2084/:2086/:2088/:2173 and its first write at :2179. Both docblocks now say what is actually protected. So the audit's job is to find a refusal *after* a write — not every write inside a transaction that can go wrong.
  **And look for writes with no transaction at all**, because a walk of `database.transaction(...)` call sites will not find them. `createEvent` (`src/lib/events.ts:1442`, `:1447`) is one: it inserts the event row and *then* calls `setEventQuestions` and `setEventDays` on the bare handle, returning `fail` if either refuses. Its own docblock at :1405 says the opposite — "Every refusal before the insert … UC-08 10c says *nothing saved*" — and the refusal is reachable: a template whose `profileFieldKey` resolves to a field whose type has since changed makes `setEventQuestions` refuse, and the caller is told the event was not created over a committed event row. Same class of bug, different cause, and invisible to the obvious grep.
- **Acceptance criteria:**
  - [x] Every `transaction` callback in `src/lib/` is classified, with the list in the report
  - [x] Writes that are *not* in a transaction but call a function that can refuse are found too, `createEvent` among them
  - [x] Each writes-then-refuses case is fixed and has a test proving nothing is committed on the refusal
  - [x] The rule is stated once, somewhere a writer will see it before their first `tx.` call, and it distinguishes a returned refusal from a throw
- **Depends on:** nothing, but it touches many files, so run it when no other task holds them.
- **Left over:** nothing, and four corrections to this entry's own framing. **48** `database.transaction(` call sites at baseline, not 49 — `src/lib/events.ts:38` is a sentence in a docblock, not a call. 51 now. 44 were already safe; the four bugs were `setStages`, `setTeams`, `voidLotIn` (reached from both `voidLot` and `voidLastLot`) and `createEvent`. The full classification is in the task report.
  **Two of the four are invisible to the walk this entry prescribed.** `setTeams`' delete lives inside `removeTeamsIn`, so a scan for the first `tx.` write puts the refusal in the wrong place; `voidLotIn` is a helper and not a call site at all. Finding them needs a **transitive closure over every function in `src/lib` that writes** — 722 functions scanned — treating a call to one as a write. And three refusal spellings are in use: `fail(…)`, `{ ok: false as const }` and `{ ...nothing, problem }`, so a grep for the first misses `polls.ts`, `suggestions.ts` and `hosting.ts` entirely.
  **A fourth safe shape, which this entry did not name:** a compare-and-set whose refusal is its own zero-row result. `awardLot`, `discardLot`, `moveToReserve`, `updateEvent` and `publishEvent` all read as writes-then-refuse and are not — **provided the guarded write is the first write**, which is exactly where `voidLotIn` went wrong.
  Fix shapes, chosen per case: `setStages` and `setTeams` by **ordering/staging**, because both refusals are their own; `voidLotIn` by moving its **compare-and-set first**, turning the refusal into a write that matched no rows; `createEvent` by **throwing** a module-private `NothingSaved` (carrying `errors` as well as the sentence), because its two remaining refusals belong to `setEventQuestions` and `setEventDays` and neither can be asked before the event row exists — staging would mean two copies of a validation that has to be right for edits.
  The rule is `docs/decisions/004-refusals-inside-transactions.md`, with a four-sentence version and the failing snippet in **`src/db/index.ts`'s module docblock** — the file every writer imports `Database` from, so it is met before a first `tx.` call rather than filed where nobody looks. **Mutation 9 proves the premise empirically in this repo:** keeping the transaction but *returning* the refusal instead of throwing still commits the event row.
  Collateral, outside `src/lib`: `insertingAfter` in `src/app/admin/events/__tests__/waivers.test.ts` had to be taught to flatten the transaction, because the insert it aims at moved onto the `tx` and the proxy started intercepting the *audit* insert instead — a different builder chain, which threw inside `recordAudit`'s own catch and failed the test on an empty audit log rather than on anything about two managers. That is Task 58's observation about those six helpers, arriving early, and it pushes `insertingAfter`'s three copies further apart.

### Task 58: Six copies of one sequencing helper (found in Task 36 review)

- **Serves:** no requirement — test infrastructure
- **Files:** `src/lib/__tests__/format-db.test.ts`, `draft.test.ts`, `events.test.ts`, `format-sync.test.ts`, `admin-users.test.ts`, `championship-results.test.ts`, new `src/db/__tests__/helpers.ts`
- **Do:** `committingAfter` is **byte-identical** in six test files. That is three strikes twice over, and one `db` parameter extracts it cleanly.
  Task 36's review asked for a wider extraction than this and was wrong to: there are **twelve** sequencing helpers across eleven files, and they are not variations of one idea. `committingAfter` does **not** flatten the transaction — it runs `between`, then opens a real `target.transaction(run)`, firing at `BEGIN`. `insertingAfter` (three hand-written copies, in `hosting.test.ts`, `championship-events.test.ts` and `waivers.test.ts`) flattens and hardcodes one builder chain, and the three differ by chain shape (`.values().onConflictDoNothing()`, `.select().returning()`, `.values().onConflictDoNothing().returning()`). `completing` flattens, proxies all four builders recursively, is aimed by a regex over `toSQL()`, and hardcodes its action. Parameterising "where the interruption fires" across those three means a configurable proxy framework harder to read than any of them — so **extract only the six identical `committingAfter`s** and leave the rest.
- **Acceptance criteria:**
  - [x] One `committingAfter`, imported by all six files, each behaving as before
  - [x] The other six helpers are left alone, and a comment says why
  - [x] No test changes what it asserts
- **Depends on:** nothing, but it edits six test files, so run it when no other task holds them. Deferred from Task 36's review as a cosmetic win not worth risking a 132-file baseline mid-task.
- **Left over:** nothing, and the entry's reasoning held. `committingAfter` was byte-identical in all six files — **proved by hashing each 14-line body** (`sha256` `1811c270c5cd07d7` in all six) rather than by eye — and now lives in `src/db/__tests__/helpers.ts`, which **already existed** and was extended rather than duplicated. 510 tests across the six files before and after, with identical names, counts and statuses.
  The other six helpers were left alone and the canonical comment sits beside the kept one, naming each and what differs: three `insertingAfter`s differing by builder chain, `writingAfter` on `.set().where().returning()`, and `completing`/`completingBeforeTheLock` with their regex aim and recursive proxy. **Four cross-references that named `committingAfter`'s old home were made true rather than left dangling** — two of them already pointed at "`committingAfter` in `format-db.test.ts`", which this change would have left pointing at nothing.
  **No `fired()` was added, and the reason is measured rather than argued.** Breaking the shared helper so it never fires failed **all 14** call sites across all six files — nothing passes vacuously. The structural reason it differs from `completing`: `completing` is *aimed*, by a regex over `toSQL()`, so its pattern can drift off the statement while the write under test still succeeds, satisfying "nothing was written" for free — which is why `fired()` earned its keep there and twice again in Task 56. `committingAfter` has **no aim**; it fires unconditionally on the first `transaction` call, and every one of the 14 tests asserts an outcome that depends on `between` having committed — a refusal, or a specific promotee — rather than merely asserting nothing happened. Adding one would also have meant 14 new assertions, which the third criterion forbids.
  Six production mutations, one per file, each failing only the sequenced test: the in-transaction season re-check, `barWithin`'s locked census, `freeSeat`'s queue, `syncStages`' touch read, `recordGames`' series, `setTeamCount`'s count.
  **Two notes for whoever reads those tests next.** The `format-sync` test is held by the **match-row** read (`finishedAt` in `stageTouchOf`), not the game read — a mutation staling only the game rows passes all 35 tests, which was discovered by the mutation failing to bite and being re-aimed. And the `format-db` test survives its mutation **only because it asserts the exact refusal sentence**: under a stale series read `recordGames` still refuses, with a different message, so a test checking only `ok === false` would have passed it. That is the same lesson as every other escape here, arriving in the one place it could still do damage.

## Plan hygiene

A reconciliation of every acceptance criterion against the tree (2026-10-22, at commit `8ef5347`) found the checkboxes had drifted badly: **94 of 100 were unticked**, and 47 of those were met — several by mutation-resistant tests. They are now ticked. Two lessons worth keeping:

- **A criterion written as a grep is weaker than the rule it stands for.** Task 51's `grep -rn "Day \${"` reads clean of `label ??` fallbacks while four hits remain, and a fifth surface was missed entirely because it wrote the number as JSX (`Day {index + 1}`). The per-surface assertion is the criterion that holds; the grep is a convenience. Task 44's criterion has the same shape and nothing holds it — a future edit could reintroduce `R-196` and no test would fail.
- **26 of the 67 tasks state their acceptance criteria as prose rather than checkboxes, so no sweep can see them** — Tasks 14-29, 31-35 and 39-43. That was first recorded here as "Tasks 39-43 and Task 31", which was itself an undercount found the same way as every other one: by looking rather than assuming. Task 31's criterion is **not met** and went unnoticed for exactly this reason, and Task 32's was prose until it came up for work. Tasks 59-65 use checkboxes; the earlier 26 are left as they are, because converting a criterion somebody already satisfied invites re-ticking it from the text rather than from the tree.

Still open and **not** closable from this repo: Task 50's last criterion asks whether an index on `events.status` is wanted, which needs `EXPLAIN` against production rows. `DATABASE_URL` is blank here by design. The query to run is recorded at `src/db/schema.ts:1091-1116`.

### Task 65: `.field` was one instance of the pattern, not the bug (found in Task 38c)

- **Serves:** the Constraints in `docs/requirements.md`; every `.num`, `.btn` and `.wordmark` call site
- **Files:** `src/app/globals.css`, `src/components/ui/Stepper.tsx`, `src/components/DevLoginBanner.tsx`, the 24 `.num` call sites, `src/components/ui/__tests__/field-ordering.test.ts`
- **Do:** Task 38c fixed `.field` by wrapping it in `@layer components` so utilities beat it in the ordinary way. The *pattern* it fixed — a component class written after `@tailwind utilities` at equal specificity, so source order decides — is not unique to `.field`. **20 of the 22 top-level class rules set a property a utility can write**, across 17 distinct classes; only `.hatch` and `.btn:focus-visible` are clean. The table below said *nine*, from a grep over a hand-picked property list, and that undercount is recorded rather than corrected away because it is the same error this plan keeps making — a convenience grep standing in for a criterion. The properties a utility can write are not just sizing:

  | class | sets | call sites writing a conflicting utility |
  |---|---|---|
  | `.num` | `font-size: 0.94em` | **24** |
  | `.btn` | `font-size: 13px`, `font-weight`, `padding` | **3** |
  | `.wordmark` | `font-size: 13px` | 1 |
  | `.eyebrow` | `font-size`, `font-weight` | 0 |
  | `.font-display` | `font-weight` | 0 |
  | `.seam`, `.seam-bloom`, `.btn-union` | `height`, `width`, `font-weight` | 0 |

  **`.eyebrow` is the one to read first, because it already solved this** and the comment above it says how: it declares *no* `color` precisely because it sits after `@tailwind utilities`, so every `text-dim`/`text-muted` written beside it works. Declining to declare a property is the other valid fix, and it is why `.eyebrow`'s 26 colour utilities are not conflicts.

  **`.num` is not the same case as `.btn`, and that is the whole difficulty.** Its `font-size: 0.94em` is a *relative* correction — mono figures run optically large at the same nominal size, so it shrinks them against whatever surrounds them. A call site writing `text-16` today gets `0.94 × inherited`, not 16px, which is the defect; but layering `.num` makes all 24 sites take their written size and **lose the optical correction**, which was a deliberate typographic decision rather than an accident. So this is not a wrapper to apply: it is 24 call sites to look at, deciding per site whether the author wanted that size absolutely or wanted the figure to sit 6% down from its surroundings. Several may want `text-[0.94em]`-style relative sizing, or `.num` may want to keep winning and the call sites to drop their `text-*`.

  `.btn` and `.wordmark` are the straightforward half: 3 and 1 call sites, all of which plainly meant what they wrote. `Stepper.tsx`'s two `btn … text-16` arrows render at 13px, and `DevLoginBanner.tsx`'s `px-3 py-1.5` loses to `.btn`'s `0.5rem 0.85rem`.

  Task 38c deliberately left `.btn` alone rather than riding it in, and that was right — "moving it would change rendering at every button call site that writes a utility, and none of those has been measured". The measuring is this task.
- **Acceptance criteria:**
  - [x] Every unlayered class rule in `globals.css` is either layered, declares nothing a utility would write, or is listed with a reason it must keep winning
  - [x] `.btn`'s three call sites render what their author wrote, measured before and after
  - [x] Each of `.num`'s 24 call sites has a decision recorded: absolute size wanted, or the 0.94em correction wanted
  - [x] No control or button changes its rendered size where no utility was written
  - [x] The guard in `field-ordering.test.ts` is extended to every layered class, so a tenth rule added after `@tailwind utilities` fails rather than silently losing
- **Depends on:** Task 38c. Touches `globals.css`, so not beside another task holding it.
- **Left over:** nothing for the three classes named, but **the measurement in this entry was wrong, and the correction is the point.** `.field` was not one of nine — it was one of **twenty**. Measured against the properties the build really emits, **20 of the 22 top-level class rules** in `globals.css` declared one a utility could write, across **17 distinct classes**; only `.hatch` and `.btn:focus-visible` were clean. The "nine" came from a grep over a hand-picked property list — `width|font-size|padding|height|max-width|min-width|font-weight|margin` — which quietly assumed the universe of utilities is sizing. It is not: `color`, `background`, `border` and `animation` are all utilities too, which is how `.stage`, `.panel`, `.roundel`, `.btn-flare`, `.wordmark-accent` and the four animation classes were missed (`animate-*` writes the same `animation` shorthand, and `animate-pulse` is already written once in `src/**`). `.num` is **47 sites writing a size**, not 24; `.btn` is **6**, not 3. Everything is layered now bar two rules with recorded reasons.
  **`.num` needed an argument rather than a fix, and the argument is that `em` had already broken it.** `0.94em` resolves against the **parent**, so a call site's `text-12` was not overridden by a competing size — it was replaced by a number derived from whatever sat above it. One class list, browser-measured under three parents: **11.28px / 13.16px / 18.8px**. A stated size was therefore never what rendered, so the correction was not protecting anything an author asked for, and layering only stops it where a size was stated — the 31 sites that stated none keep `0.94em` to the pixel.
  The split needed no convention imposed, because it was already in the code: **every site that wrote a size is a flex item, a fixed-width cell, a standalone display figure or a size prop; every figure set inline in a sentence wrote nothing.** 34 class lists absolute, 12 relative, recorded in `NUM_DECISIONS` keyed by class list with every site mapped through it, so a new sized site with no decision fails. The two most defensible: `DaysTab` wrote `num text-12` inside a `text-14` list to make the day marker *smaller* and got 13.16px, nearly identical; `players/[handle]` wrote `text-13` inside a `text-12` run to put the figure a step *above* "points" and got 11.28px, below it.
  **Two defects fell out that nobody had named.** `Button`'s `size="sm"` had **never done anything** — `px-3 py-1.5` lost to `.btn`'s `padding`, so every compact button on the site rendered full-size (8/13.6px → 6/12px). And `DevLoginBanner` lost its **colour**, not merely its padding: `.btn`'s `color: var(--body)` beat `text-flare`, so the one control meant to look alarming rendered body grey.
  **Layering alone could not fix `BidBox`**, which passed `size="xl"` *and* `className="text-48"`. Two font-size utilities in one layer are decided by Tailwind's emitted order, not by the author — it rendered 48px only because `text-48` happens to be emitted after `text-24`. `MoneyFigure` gained a `2xl` row, `BidBox` uses it, `WatchPanel`'s redundant `text-24` is gone, and the guard now refuses two sizes in one `.num` class list.
  **The near-miss was Task 38c's own lesson, one layer deeper.** This task's first draft claimed layering `.roundel` would purge it. A probe disproved it — and the reason was that **the test file's own mention of the word was keeping the class alive**, because Tailwind's content globs cover `src/**/*.ts` and a class named in a comment or a string is a purge candidate. A guard proving a rule survives the purge, while being the sole reason it survives, is worth nothing. Every layered class is now also required to be worn by a real `.tsx` literal, and the emission list is read out of the source rather than hand-kept.
  **Two rules keep winning, with reasons.** `.wordmark-accent`: its `color: transparent` **is** the `background-clip: text` mechanism rather than a default — the gradient is seen through it, and `a.wordmark-accent:hover` works by dropping the image so that colour shows, so layering it would replace the lit mark with flat colour. `.roundel`: nothing in `src/**` wears it, so the rule never matches and cannot eat a utility. It is **dead CSS** and is already on Task 32's deletion list; left in place here because removing a gradient somebody may want is not an ordering fix's business.
  `.eyebrow` goes on declining `color`, which stands on its own merits — a label has no colour, the thing it labels does — and 26 call sites depend on it. Recorded that its *original* reason is now obsolete, since the block is layered.

### Task 66: Nothing bounds how many database connections a live draft opens

- **Serves:** the Scale constraint in `docs/requirements.md` — "the whole room during a live draft"
- **Files:** `src/db/index.ts`, possibly `docs/decisions/`
- **Do:** the Neon handle is built as `new Pool({ connectionString: url })` with **no `max`**, and `grep` for `pooler`, `max:`, `idleTimeout` or `connectionTimeout` across `src` finds nothing — there is no connection management in this repo at all. `@neondatabase/serverless`'s `Pool` follows node-postgres and defaults to **10**, and on Vercel **each serverless instance holds its own pool**, so the ceiling is 10 × however many instances Vercel spins up. A live draft is the one moment this app deliberately invites concurrency, and it is also the moment a refused connection is least recoverable: a captain whose bid fails on a pool error does not get another chance at that lot.
  **The first question is not the pool size, it is which endpoint `DATABASE_URL` names.** Neon offers a direct endpoint and a PgBouncer-backed pooled one, distinguished by `-pooler` in the host. With the pooler the fan-out is absorbed and a `max` is close to irrelevant; without it, direct connections are the hard limit and the default of 10 per instance is the problem. Nobody can read that value from this repo — `DATABASE_URL` is blank here by design and the Constraints forbid the value reaching any screen — so **this task starts by asking the operator which endpoint is configured**, and the answer decides whether there is any work to do.
  If it is the direct endpoint, the fix is a `max` sized to Neon's limit divided by expected concurrency, plus an `idleTimeout` so a suspended instance stops holding connections. **Do not simply set `max: 1`**: this app uses interactive transactions, and a pool of one serialises every request in that instance behind whichever transaction is open — including the lock-ordered writes Tasks 36 and 56 just finished making correct.
  Note the interaction with Neon's **autosuspend**: compute suspends when idle on the free tier, so the first connection after a quiet spell pays a cold start. A short `connectionTimeout` would turn that cold start into a failed request, which is the opposite of what is wanted.
- **Acceptance criteria:**
  - [ ] Which Neon endpoint production uses is established and written down
  - [ ] If direct: a `max` and `idleTimeout` are set, with the arithmetic recorded against Neon's documented limit
  - [ ] A transaction-heavy path still works with the configured pool, proven rather than assumed — a pool smaller than the concurrent transactions in one instance deadlocks rather than queueing
  - [ ] Cold start after autosuspend does not surface as an error to a reader
  - [ ] The reasoning lives where the next person will meet it, as `docs/decisions/004` does for transactions
- **Depends on:** nothing in the tree; it depends on an answer from whoever owns the Neon project. **Cannot be closed from this repo alone** — like Task 50's index, it needs production to look at.

## J. Discord announcements, editable (R-201 to R-208 / UC-37, UC-38)

Decisions taken with the user on 2026-10-22, recorded here because each one closed a question
the build would otherwise have had to guess: mentions are **per announcement, the admin's
choice** (not role-only, not a blanket ban on `@everyone`); the role list comes from a **bot
token picker** rather than a pasted id; **every kind** becomes editable, not only the four
new ones; and "two hours before the event" means the **first dated day's start**. The scheduler
is **GitHub Actions every 15 minutes** — Vercel Hobby allows one cron run a day, which cannot
fire a two-hour reminder, and `docs/requirements.md` already carried that as a constraint.

### Task 59: An announcement's wording is data, not code

- **Serves:** R-201 / UC-37 2a, 3a, 3b, 3c, 7a
- **Files:** `src/db/schema.ts` (+ migration), `src/lib/announce.ts`, `src/lib/discord.ts`, tests
- **Do:** the **seven** kinds in `ANNOUNCEMENTS` each have their wording compiled into `src/lib/announce.ts` as a function (`applicationDecidedMessage` and the rest). Store an override per kind, and have the compiled copy be the **default** rather than a fallback nobody sees: a kind nobody has edited must post byte-for-byte what it posts today, which is also the migration's answer for existing deployments — no backfill, because the absence of a row *is* "unedited".
  Each kind offers a fixed vocabulary of placeholders (the event's title, its dates, the places left, the member's name, and so on) and **only** the ones that kind actually has. A placeholder is refused at save time, naming what that kind does offer, because a wording that silently renders `{captain}` as nothing on an event with no captain is a mistake found in the channel. Note the existing `clamp()` calls — Discord's per-field limits are already respected by the compiled copy and must still be respected by an edited one, which is UC-37 3c and is a refusal *before* saving, not a failed post.
  `announcementSettingsFrom` is the precedent for the defaults shape and its module comment says why: a kind must be able to ship without a migration and without a deployment silently starting to post something nobody asked for.
- **Acceptance criteria:**
  - [x] An unedited kind posts exactly what it posts today, asserted against the current compiled output
  - [x] An edited kind posts the admin's wording, with every placeholder filled
  - [x] A placeholder that kind does not offer is refused at save, naming the ones it does, and nothing is stored
  - [x] Empty wording is refused; it is the switch, which is a separate control
  - [x] Wording over Discord's limit is refused at save, not discovered as a failed post
  - [x] Two saves at once: one wins, the loser is told the wording moved and shown the current one
  - [x] The migration states why there is no backfill
- **Depends on:** nothing. Needs a migration, so it must not run beside another that holds one.
- **Left over:** the kind count in this entry, R-201 and UC-37 was **wrong** — all three said *eleven* and `ANNOUNCEMENTS` holds **seven**, which also made Task 62's "a twelfth kind" off by four. Corrected in all four places. The arithmetic should have been 7 today + 3 from Tasks 62/63 = 10, and "new event announced" was never a new kind at all: `event_published` already existed and needed editability, not building. The store is keyed over `ANNOUNCEMENTS` rather than a literal list, so the three new kinds arrive editable with no migration and no change to `announce.ts`'s store.
  **`body` is nullable, and that is load-bearing rather than decoration.** The compiled copy is a *function*, not a sentence: a waitlisting reads differently with and without a queue number, a lot that went for nothing says so in words, a drawn series is waiting on an admin, a moved table says one of four things depending on who took the lead. A row with a null body is an admin who chose a mention and left the wording alone. Letting "choose a mention" force a save of the current wording would freeze **one variant** of each of those into a row, and from then on every announcement of that kind would post the frozen variant — a deployment silently starting to post something nobody asked for, which is the exact failure `announcementSettingsFrom` was built to prevent. It is also why the migration writes no rows: a backfill could only write a worse copy of the default.
  `announcement_templates.kind` is **text, not an enum**, deliberately unlike `notification_kind`, `entry_rule` and `profile_field_type`, because a new kind must ship without an `ALTER TYPE` and a deploy. A table rather than another `settings` key, because the switches are seven booleans one screen writes together while a wording is up to 4096 characters edited one kind at a time — in one jsonb blob two admins editing *different* kinds would overwrite each other, since each save carries that editor's stale copy of the other six.
  Two scope decisions: the override replaces the embed's **description** only (title, fields, colour, footer and link are structure, not wording), and there is deliberately **no `{link}` placeholder**, because the link is the embed's `url` and would be the one value with no honest rendering on an install that has never set a site origin. Every placeholder's `whenAbsent` is asserted non-empty over every kind — a helper returning `""` is how a negative assertion goes vacuous, and it has happened on this project.
  **The byte-for-byte claim is proven mechanically, not by hand:** the goldens were captured by running all seven builders out of `git show f207112:src/lib/announce.ts` and diffing the serialised payloads against the new module.

### Task 60: A mention is only ever the admin's own words

- **Serves:** R-202 / UC-37 4c; the mention Constraint in `docs/requirements.md`
- **Files:** `src/lib/announce.ts`, tests
- **Do:** **the security-critical task of this group.** Every payload today carries
  `allowed_mentions: { parse: [] }`, and `announce.ts:24-31` explains why: a member's display
  name is interpolated into announcements, and a display name of `@everyone` would ping the
  server. Allowing mentions must not reopen that.
  **The mechanism is the allow-list, not the embed.** An earlier draft of this entry said Discord
  "does not parse mentions inside embeds at all" and made that the guarantee. The API reference does
  **not** say it — `parse` is described as parsing "from the content" and the field as governing
  mentions in the message content and its components; embeds are never named. The behaviour is real
  but undocumented, so the guarantee rests on the allow-list instead and the embed separation is a
  second, independent layer. Note also that `parse`'s "mutually exclusive" rule is **per mention
  type**, and `everyone` has no id list in the API, so it can only be permitted through `parse`. So every interpolated value stays in the embed, where a mention is inert by
  construction, and the mention line is built *solely* from the stored template and placed in
  `content`. `allowed_mentions` then names the **exact role ids** the template used — an
  allow-list, not `parse: ["roles"]`, so a role id appearing anywhere else cannot ping — and
  permits `everyone` only when the template itself contains it.
  `@RoleName` is inert on Discord; a role ping is `<@&id>`. The editor stores ids.
- **Acceptance criteria:**
  - [x] A member whose display name is `@everyone` cannot make any announcement ping the server, asserted on a real payload
  - [x] A member whose display name contains `<@&id>` for a real role cannot make it ping, including when the template mentions a *different* role
  - [x] A template mentioning two roles produces `allowed_mentions.roles` of exactly those two ids, and no `parse` entry for roles
  - [x] `everyone` is permitted only when the template contains it
  - [x] Every interpolated value lands in the embed, asserted structurally rather than by eye
  - [x] An audit row records who made an announcement ping everyone
- **Depends on:** Task 59.
- **Left over:** **this entry's stated mechanism is not what Discord documents, and the implementation deliberately does not rest on it.** The entry said Discord "does not parse mentions inside embeds at all" and treated that as the guarantee. The API reference does not say it: `allowed_mentions.parse` is described as parsing "from the content" and governing mentions "in the message content, or the content of components attached to that message" — **embeds are never named**, and nothing states they are unparsed. Observed behaviour matches, and community reports agree, but it is undocumented behaviour rather than a promise, so building the security guarantee on it would be building on something Discord never agreed to.
  So the **allow-list is the guarantee** and the embed separation is a second, independent layer: `parse` contains `everyone` only when the admin's stored template contains it, which holds whether or not Discord ever starts parsing embeds. Both layers are documented in `announce.ts`'s module comment, each as individually sufficient.
  **A sharper finding changed the design.** The reference calls `parse` "mutually exclusive with the other fields", then gives `{parse: ["everyone"], users: [...]}` as a **valid** example while calling `{parse: ["users"], users: [...]}` a validation error — so the exclusivity is **per mention type**, and the boundary is unstated ("not all configurations are accepted" because of "possible ambiguities"). Two consequences: `everyone` has **no id list** in the API and can *only* be permitted through `parse`, so a pure id allow-list cannot express it; and naming a type in both `parse` and its id array is a 400. Payloads are therefore built so **no type is ever named in both places** — `parse` carries at most `everyone`, the id list carries only roles — and a test asserts that over every combination, so no payload this site sends ever tests the undocumented boundary.
  Snowflakes are validated **twice**, at save and again in `mentionLine`, because the second check is the only thing standing between a stored value and the `content` field.
  **One honest gap, and it is mine to note rather than the task's:** mutating `wordingFor` to ignore its `database` argument does **not** fail, because `discord.test.ts` mocks `@/db` to the test database so both handles are the same object. The parameter is threaded because it is correct, but no test holds it — and `announceOrigin` next door has the same latent issue.
  **Two audit actions were written but unregistered**, in `src/lib/audit.ts`, which the task did not own: `announcement.wording_changed` and `announcement.pings_everyone` wrote correctly (`recordAudit` takes `AuditAction | (string & {})`) but `/admin/audit` showed the bare action names and the whole-server ping rendered in the muted tone. Both now have headings, and `announcement.pings_everyone` returns `flare` from `actionTone` — the same tone as `announcement.failed`, because both are lines you want to find without filtering for them.

### Task 61: Pick a role instead of pasting an id

- **Serves:** R-203 / UC-37 4a, 4b
- **Files:** new `src/lib/discord-roles.ts`, `src/lib/discord.ts`, the settings screen, tests
- **Do:** one outbound `GET /guilds/{id}/roles` with the same bot token `src/lib/discord-dm.ts`
  already uses, so this stays inside the "no hosted bot process" line in Out of scope — no
  gateway, nothing listening. `discord-dm.ts` is the precedent for the whole shape: **inert
  until `DISCORD_BOT_TOKEN` exists**, and the screen says why rather than failing.
  **Read the guild id through `getGateConfig()` in `src/lib/auth.ts`, not from a new environment variable and not from the settings row directly.** It is already stored and already admin-editable, because the sign-in gate needs it and R-03 requires an admin to be able to change which server gates sign-in without a developer (`src/db/schema.ts`: "the guild id and the toggle are admin settings, not constants"). `DISCORD_GUILD_ID` already exists as the **fallback** — `loadGateConfig` resolves the setting first and that variable second — so a *third* source would be the mistake, and reading the settings row alone would be a different one: a deployment configured purely by env var would look to this feature like no guild was set at all. Take the resolved value.
  So the only new secret this whole group needs is the bot token, and that one is optional: `@everyone` carries no id, and a role ping needs only the numeric `<@&id>`, which an admin can copy out of Discord by hand. R-203 is "Could" for that reason — the picker removes a typo, not a limitation.
  Cache the list; a role list is not worth a request per page view. A role the template mentions
  that is no longer in the server must be **flagged on the screen, not repaired** — the
  announcement still posts and the dead mention renders as plain text, which is Discord's own
  behaviour and is better than the site rewriting an admin's words.
- **Acceptance criteria:**
  - [ ] With a token and guild id, the editor lists the server's real roles and stores ids
  - [ ] With neither, the screen says what is missing and takes a pasted id instead
  - [ ] The token never reaches the browser, the settings screen or the audit log (Constraints)
  - [ ] A deleted role is flagged on the screen and still posts as plain text
- **Depends on:** Task 60.

### Task 62: Signups opening is its own moment

- **Serves:** R-205 / UC-38 2, 2a
- **Files:** `src/lib/announce.ts`, `src/lib/events.ts`, tests
- **Do:** an **eighth** kind. `event_published` already posts on publish; this is the separate
  moment when applications actually open, which is not the same instant whenever an event is
  published ahead of its signup window (`signupWindowProblem` in `src/lib/events-policy.ts` is
  where that window lives).
  **The case that decides the design is UC-38 2a:** an event whose signups are already open when
  it is published must post *one* announcement, not two. Publishing and opening are one moment
  there, and two posts a second apart is the kind of thing a channel is muted for.
- **Acceptance criteria:**
  - [ ] An event published before its signups open posts the published announcement, then the signups-open one when they open
  - [x] An event already open when published posts only the published announcement
  - [x] Switchable like every other kind, and off does not suppress the published one
- **Depends on:** Task 59.
- **Left over:** **the trigger is not here, and it is Task 68's — not an oversight.** The kind, its vocabulary, its switch and its builder are in `announce.ts`; nothing posts it. Applications opening is a clock event, the repo has exactly one clock (`/api/cron/reminders`), and UC-38 5a needs a claim keyed on (announcement, event) that `notification_dm_claims` cannot hold. Task 63's agent reached the same two conclusions independently and stopped at the same line.
  **UC-38 2a turned out not to need a special case, and that is the design.** `events` has **no `published_at` column**, so "were signups already open when it was published?" is unanswerable from the row after the fact — the publish instant exists only while publication is happening. The resolution: a **forward-only** look-ahead makes 2a free, because an event already open at publish has `signupOpensAt` in the past forever and so never enters a window of the form `0 < target − now ≤ lead` — exactly the shape `announce-schedule.ts` independently chose. `publishingOpensSignups` names that rule once and is tested to the millisecond; **Task 68 must call it rather than re-derive it, and must not widen the window backwards.**
  **Correction to the brief, and to this entry's Files line.** I told the agent dates are derived so not to assume a column exists; that governs an event's **start and end** (dropped by drizzle/0026), but `signup_opens_at` and `signup_closes_at` are **real stored columns** and `missingToPublish` refuses to publish without both. The window is stored; the start is derived. The Files line names `events.ts` because the entry assumed a publish-time trigger — nothing there changed and nothing should, since 2a forbids posting when already open and publishing is not opening otherwise.
  The switch ships **off**, like `standings_changed`, and doubly so while nothing fires it: a switch that is on for an announcement nothing sends is a settings screen telling an untruth. **No `{opens}` placeholder** — by the time this posts, "when do applications open" is "now", and the only honest rendering would be a server-formatted instant, the one thing this module never emits.
  **An honest note on a citation:** `(R-24)` was copied from the entry above rather than verified fresh. R-24 is real but its text is about spreading an event over four days — the whole repo uses it as shorthand for "an event's dates are its days'", which is looser than the id suggests. R-205 and UC-38 2/2a verified exact.

### Task 63: The two moments nobody is watching for

- **Serves:** R-206, R-207 / UC-38 3, 3a, 4, 4a, 4b, 4c, 5a, 5b
- **Files:** `src/app/api/cron/reminders/route.ts`, `src/lib/notifications.ts` or a sibling, new `.github/workflows/cron.yml`, `vercel.json`, tests
- **Do:** one day before signups close, and two hours before the first dated day starts. Both are
  scheduled, so both need the look-ahead-plus-claim shape the reminder DMs already use — the
  claim table is what makes a second run inside one window send nothing (UC-25, and
  `notifications.test.ts` proves the 36h case).
  **Dates are derived, never stored** (R-24): the start comes from `event_days.starts_at` via
  `readDatesFor`, and `starts_at` is nullable, so an event with no dated day has nothing to count
  back from and gets nothing. Same for an event with no signup closing time.
  **Do not format an instant on the server** — a repo invariant, and Discord gives the right tool
  anyway: `<t:unix:F>` renders in each reader's own timezone, which is more correct than any
  string the site could pick.
  **Scheduling:** `vercel.json` runs `0 12 * * *` because Vercel Hobby allows one run a day, and
  the route's docblock records that an hourly schedule fails the whole deployment. A two-hour
  reminder cannot work at that cadence, so a GitHub Actions workflow pings the existing
  `/api/cron/reminders` every 15 minutes with `CRON_SECRET` from GitHub Secrets. Keep the Vercel
  daily run as a backstop. GitHub's scheduler is best-effort and can be 5-15 minutes late, so the
  window must tolerate that rather than assuming exactness — and `/api/cron/reminders` already
  fails closed without `CRON_SECRET`, which is what makes a public URL safe to ping.
- **Acceptance criteria:**
  - [ ] Each posts once per event, proven by running the scheduler twice in one window
  - [x] An event with no closing time, and one with no dated day, get nothing
  - [x] A cancelled event gets no starting-soon reminder
  - [x] A full event still gets the closing-soon one, and says it is full
  - [x] A missed window is not posted late
  - [x] A 15-minute-late run still fires the right moment and does not fire a second time
  - [x] No instant is formatted on the server; the message carries Discord timestamp markup
  - [x] The workflow fails closed without the secret, and the secret is not in the repo
- **Depends on:** Task 59. Touches the cron route, so not beside another task holding it.
- **Left over:** done **except the post itself**, and stopped rather than crossed — the remaining half is Task 68. `dueScheduledAnnouncements` decides which events are due and carries the facts with instants pre-rendered as Discord markup; `.github/workflows/cron.yml` pings the endpoint every quarter hour and **fails loudly** until configured; `vercel.json` is unchanged as the daily backstop.
  **Correction to the brief: the claim needs a new table, not a new column.** `notification_dm_claims` is `PRIMARY KEY (user_id, dedupe_key)` with `user_id` a NOT NULL reference to `users` — a channel announcement has no recipient, so there is no row shape for it. That is strictly more than the case the brief said to stop and report on, and no migration was generated because the chain may be held.
  **The window is arithmetic, not a comment.** Fire while `0 < target − now ≤ lead`: the upper bound tolerates lateness because a closed interval at least as wide as the worst gap between two runs is certain to contain one (worst observed gap 30 min, against leads of 2 h and 24 h); the lower bound ends *at* the instant, so sleeping through a window means silence rather than a late reminder (UC-38 5b). The window is the full lead rather than a narrow band so it fires at the **earliest** run after the moment arrives — a narrow band would turn a 15-minute slip into a 1h30m reminder. Exported as `SCHEDULE_TOLERATES_LATENESS`.
  **A test-design trap worth keeping:** a slip of *exactly* 15 minutes reproduces the same grid of wake times, so "every run 15 minutes late" fires at the identical instants as "on time" and proves nothing. The tests sweep 0/5/10/15.
  **The route's fail-closed guard had no test anywhere in the repo** — the thing that makes a public URL safe to ping. Now covered in `src/app/api/cron/__tests__/route.test.ts`: 503 when the secret is unset, 503 for a whitespace-only secret, 401 for absent/wrong/bare-not-Bearer credentials, and 500 without leaking the reason.
  **The agent's own first mutation harness reported all 23 mutations as survived with "(none)" as the failure** — because `spawnSync("npx.cmd")` fails `EINVAL` on Windows. It caught that, and the harness now throws unless the output contains a `Test Files` line, so a harness that cannot run the suite can no longer look like 23 passing mutations. The workflow assertions also run against a **comment-stripped** copy of the YAML, because its own prose names `CRON_SECRET` and the route path — `toContain` over the raw text would be satisfied by the explanation of a deleted step.
  **Two things the operator must set**, and one is not in `docs/discord-setup.md`'s original list: `CRON_SECRET` as a **secret**, and **`CRON_URL` as a variable** (the site origin, no trailing slash) — a deployment URL is not a credential, the header is what authorises, and no production URL exists anywhere in the repo so it could not be hardcoded. Also: GitHub disables scheduled workflows after 60 days of repository inactivity, and schedules run **only on the default branch**.

### Task 64: The screen that edits them

- **Serves:** R-204 / UC-37 1-6, 5a
- **Files:** `src/components/admin/AnnouncementSettings.tsx`, `src/app/admin/settings/actions.ts`, tests
- **Do:** the existing `AnnouncementSettings` component is the on/off switches
  (`settings.test.ts` asserts `configured`); it grows the wording, the mention picker and a
  preview. The preview must render **the real payload** through the same function that posts it,
  and send nothing — a preview built by a second code path is a preview that lies.
  A placeholder with no value in the preview shows that kind's example value, marked as an
  example, because the alternative is a preview full of blanks that looks like a bug.
- **Acceptance criteria:**
  - [ ] The preview is produced by the same function that builds the posted payload
  - [ ] The preview sends nothing, asserted with a stubbed sender
  - [ ] Placeholders with no value show a marked example
  - [ ] Every refusal in Task 59 is shown on the screen, not swallowed
  - [ ] Works at 400px
- **Depends on:** Tasks 59, 60, 61. Do it last of this group.

### Task 67: The published announcement tells an early-published event's readers to apply now (found in Task 62)

- **Serves:** R-107, R-201 / UC-26, UC-38 2
- **Files:** `src/lib/announce.ts`, `src/lib/discord.ts`, `src/lib/__tests__/announce.test.ts`
- **Do:** `src/lib/announce.ts:1000` posts **"Applications are open — three taps if your profile is filled in."** as `event_published`'s description whenever the event has none of its own, and `:1122` says the same in the preview. For an event published **ahead** of its signup window — the exact case Task 62 exists for — that is false: applications are shut, `applicationsOpen` returns `too_early`, and the apply page refuses. The embed compounds it by carrying an "Applications close" field with no "Applications open" counterpart, so a reader is told when a door they cannot yet use will shut.
  `EventPublishedInput` has `signupClosesAt` and **no `signupOpensAt`**, so the builder cannot currently tell which case it is in — the fix starts by passing the window, which `announceEventPublished` can read since `signup_opens_at` is a **real stored column** (`src/db/schema.ts:1216`, and `missingToPublish` refuses to publish without it). Note that is a genuine exception to the house shorthand: R-24 governs an event's **start and end**, which drizzle/0026 dropped and `readDatesFor` derives; the signup *window* is stored.
  **The reason this is its own task rather than a one-line fix** is `AS_IT_WAS.event_published` — the byte-for-byte golden Task 59 pinned to hold R-201's promise that an unedited announcement posts exactly what it posted before. Varying this sentence changes that golden, so the task has to decide what the golden promises: "these bytes forever", or "the bytes this function produced for the inputs it was given". The second is the useful reading and the one that lets a false sentence be corrected, but it must be stated rather than assumed, because the whole point of the golden is that nobody changes the wording by accident.
  `publishingOpensSignups` in `announce.ts` already names the one-moment-or-two rule and is tested to the millisecond; use it rather than re-deriving the comparison.
- **Acceptance criteria:**
  - [ ] An event published while signups are shut does not tell readers to apply, and says when they open
  - [ ] An event published with signups already open is unchanged, asserted against the current golden
  - [ ] The embed never shows a closing time without an opening one on an event that is not yet open
  - [ ] What `AS_IT_WAS` promises is written down where the goldens live, and the decision covers all ten kinds rather than this one
  - [ ] No instant is formatted on the server; Discord timestamp markup throughout
- **Depends on:** Task 62 for `publishingOpensSignups`. Touches `announce.ts`, so not beside another task holding it.

### Task 68: Wire the scheduled announcements to the channel (the wall Tasks 62 and 63 both stopped at)

- **Serves:** R-205, R-206, R-207 / UC-38 2, 3, 4, 5a
- **Files:** `src/lib/announce.ts`, `src/db/schema.ts` (+ migration), `src/lib/announce-schedule.ts`, `src/lib/discord.ts`, tests
- **Do:** Tasks 62 and 63 each built their half and **stopped at the same line, independently, for the same two reasons**. This is that line. Read both their `Left over` notes first — between them they specify this task precisely, and neither guessed.
  **(1) Two kinds.** `signups_closing_soon` and `event_starting_soon` in `AnnouncementKind` and `ANNOUNCEMENTS`, making ten with Task 62's `signups_open`. Note **`ANNOUNCEMENT_KINDS` does not exist** — it is the type plus the array; `NOTIFICATION_KINDS` in `notify-policy.ts` is the one spelled that way. Without a registered kind `deliver` reads an undefined switch, treats it as off, and posts nothing — so the feature would be dead code that *looked* wired up, which is why Task 63 refused to half-build it. Each needs a placeholder table and a builder going through the private `message()` helper — **do not copy `message()`**, it is the `allowed_mentions` security boundary Task 60 built and a second copy is exactly the wrong move. `{full}` on `signups_closing_soon` needs declared words rather than a blank, because UC-38 4c requires the message to *say* the event is full.
  `signups_open` is already built and switched off; wiring it is one more gatherer beside the two new ones. **Call `publishingOpensSignups`** rather than re-deriving the one-moment-or-two comparison, and **do not widen the look-ahead backwards** — UC-38 2a is free only because the window is forward-only.
  **(2) A new claim table, not a new column.** `notification_dm_claims` is `PRIMARY KEY (user_id, dedupe_key)` with `user_id` a NOT NULL reference to `users`. A channel announcement has no recipient, so there is no row shape for it — this is a new table keyed on the kind and the event, and a migration. That is UC-38 5a, and it is the single unmet criterion on both Tasks 62 and 63.
  **(3) Wire it.** `dueScheduledAnnouncements(now, db)` already decides which events are due and carries every fact with instants pre-rendered as Discord markup. It needs the claim around the post and the kinds to post as.
- **Acceptance criteria:**
  - [ ] Each of the three posts **once per event**, proven by running the scheduler twice in one window — assert the first run posted *and* the second did not, separately, because a test counting one post also passes when the first posted nothing
  - [ ] The claim table cannot hold a row that needs a user, and the migration says what it does with existing deployments
  - [ ] A 15-minute-late run still fires the right moment and does not fire twice — sweep slips of 0/5/10/15 minutes, because **a slip of exactly 15 reproduces the same grid of wakes** and proves nothing on its own (Task 63 hit this)
  - [ ] `signups_open` posts when the window opens, and an event already open at publish still posts only the published announcement
  - [ ] No instant formatted on the server; Discord timestamp markup throughout
  - [ ] All ten kinds remain editable with no further migration, and `toHaveLength(8)` in `announce.test.ts` becomes 10
- **Depends on:** Tasks 59, 60, 62, 63. Needs a migration, so it must not run beside another that holds one. **This is the last task before the announcement feature works end to end.**
