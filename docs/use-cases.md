# Use Cases - Job Centre Events (full redo)

Every requirement in `requirements.md` appears in at least one use case. The main success
path of each use case is its acceptance test; every alternate and error flow gets its own.

## Coverage

| Requirements | Covered by |
|---|---|
| R-01, R-02, R-06 | UC-01 |
| R-03, R-04, R-05, R-07, R-14 | UC-02 |
| R-08, R-09, R-10 | UC-03 |
| R-11, R-12 | UC-04 |
| R-13 | UC-05 |
| R-15, R-16, R-17, R-18 | UC-06 |
| R-19, R-20 | UC-07 |
| R-21, R-22, R-23, R-24, R-25, R-26, R-27, R-28, R-29, R-30, R-31, R-32 | UC-08 |
| R-33, R-34, R-35, R-36, R-37, R-38, R-39 | UC-09 |
| R-32, R-40, R-41, R-42 | UC-10 |
| R-43, R-44, R-45, R-46, R-47, R-77 | UC-11 |
| R-48, R-49, R-50, R-51 | UC-12 |
| R-52, R-53, R-54, R-55, R-56, R-60 | UC-13 |
| R-57, R-58, R-59 | UC-14 |
| R-61, R-62, R-63 | UC-15 |
| R-64, R-65, R-66, R-67, R-70 | UC-16 |
| R-68, R-69 | UC-17 |
| R-71, R-72, R-73, R-74, R-75, R-76 | UC-18 |
| R-77, R-78, R-79, R-80, R-81, R-82 | UC-19 |
| R-83, R-84 | UC-20 |
| R-85, R-86 | UC-21 |
| R-87, R-88, R-89, R-90 | UC-22 |
| R-91, R-95, R-101 | UC-23 |
| R-92, R-93, R-94 | UC-24 |
| R-96, R-97, R-98, R-99, R-100, R-102, R-103, R-104, R-105, R-106 | UC-25 |
| R-107, R-108 | UC-26 |
| R-109, R-110, R-111, R-112 | UC-27 |
| R-113, R-114, R-115, R-116, R-117 | UC-08 extensions |
| R-118 | UC-11 extensions |
| R-121, R-122 | UC-12 extensions |
| R-123, R-124 | UC-13 extensions |
| R-119, R-120 | UC-14 extensions |
| R-131, R-132, R-133 | UC-03 extensions |
| R-134 | UC-06 extensions |
| R-135, R-136, R-137, R-138, R-139, R-140 | UC-02 extensions |
| R-151 | UC-05 extensions |
| R-161 | UC-15 extensions |
| R-143, R-144, R-145, R-146, R-147, R-148, R-149 | UC-16 extensions |
| R-152, R-154, R-155, R-156, R-160, R-162 | UC-18 extensions |
| R-153, R-157, R-158, R-159 | UC-19 extensions |
| R-167, R-168 | UC-20 extensions |
| R-163, R-164, R-165 | UC-22 extensions |
| R-166 | UC-23 extensions |
| R-150 | UC-26 extensions |
| R-169 | UC-27 extensions |
| R-22, R-125, R-126, R-127, R-128, R-129, R-130 | UC-28 |
| R-141 | UC-29 |
| R-142 | UC-30 |

---

## UC-01: Sign in

**Actor:** Member (with Discord)
**Requirements covered:** R-01, R-02, R-06
**Trigger:** A visitor chooses to sign in.

**Preconditions**
1. The visitor has a Discord account.
2. The gate is on and names a server.

**Main success path**
1. Visitor chooses to sign in with Discord.
2. System sends them to Discord to authorise the site.
3. Visitor authorises.
4. System asks Discord whether they are in the gating server; they are.
5. System creates or updates the member (name, avatar) and applies admin rights if their Discord account is on the admin list.
6. System returns them to the page they started from, signed in.
7. Later, member chooses to sign out.
8. System ends the session and shows the page as a visitor.

**Outcome**
- A session exists until sign-out; the member's name and avatar match Discord.

**Alternate flows**
- **4a.** Gate is off - System skips the membership check. Resumes at 5.
- **5a.** Account is on the permanently revoked list - System signs them in without admin rights, even if they had them before.

**Error flows**
- **3a.** Visitor cancels at Discord - System returns them signed out with "Sign-in cancelled"; nothing is stored.
- **4b.** Not in the server - System refuses with "You need to be in the Job Centre Discord server"; no member or session is created.
- **4c.** Discord unreachable - System refuses with "Discord did not answer, try again"; nothing is stored.

---

## UC-02: Manage members and admin rights

**Actor:** Admin
**Requirements covered:** R-03, R-04, R-05, R-07, R-14
**Trigger:** An admin needs to change who can get in or who is an admin.

**Preconditions**
1. Actor is signed in as an admin.

**Main success path**
1. Admin enters a Discord account id to be made admin.
2. System validates the id (17-20 digits) and adds it to the admin list.
3. That person signs in for the first time (UC-01) and has admin rights.
4. Admin permanently revokes a different admin.
5. System removes their rights now and records that they must not be restored on sign-in.
6. Admin writes a private note on a member.
7. System saves it, visible only to admins.
8. Admin changes the gating server id.
9. System saves it; the next sign-in is checked against the new server.

**Outcome**
- The admin list, revoked list, notes and gating server reflect the changes; each is in the audit log.

**Alternate flows**
- **4a.** Admin ends a member's sessions instead - System deletes their sessions; their next request is signed out.
- **8a.** Admin turns the gate off - System saves; any Discord user may sign in.

**Error flows**
- **2a.** Not a valid id - System rejects with "That is not a Discord account id"; nothing saved.
- **5a.** Admin tries to revoke themselves, or the last remaining admin - System refuses with the reason; nothing changes.
- **9a.** Server id is not valid - System rejects; the old gate stays.

---

## UC-03: Manage the game catalogue

**Actor:** Admin
**Requirements covered:** R-08, R-09, R-10
**Trigger:** The community wants to run events for a game not yet listed, or a game needs new details.

**Preconditions**
1. Actor is an admin.

**Main success path**
1. Admin adds a game with a name.
2. System saves it; it can now be chosen for events and appears on profiles.
3. Admin defines the rank ladder, lowest to highest.
4. System saves the order.
5. Admin adds profile details for the game, each a choice, multi-choice, rank, yes/no, number or (sparingly) text.
6. System saves them; members see them on their profile for that game.

**Outcome**
- Game, ladder and details exist and are used by UC-04 and UC-12.

**Alternate flows**
- **3a.** Game has no ranks - Admin skips; rank details and entry rules are unavailable for it.
- **5a.** Admin reorders or retires a detail - System keeps members' existing answers but stops asking.

**Error flows**
- **1a.** Name already used - System rejects with "That game already exists".
- **3b.** Ranks reordered while an event has an entry rule on this game - System warns which events are affected before saving.

---

## UC-04: Keep my profile up to date

**Actor:** Member
**Requirements covered:** R-11, R-12
**Trigger:** Member opens their profile, or is sent there from an application.

**Preconditions**
1. Member is signed in; at least one game exists.

**Main success path**
1. Member opens their profile and picks a game.
2. System shows that game's details with any saved answers.
3. Member answers, choosing rank from the ladder.
4. System validates and saves, noting when the rank was last confirmed.

**Outcome**
- Answers are stored per game and prefill future applications.

**Error flows**
- **4a.** A number out of range - System shows the field error; nothing saved.
- **4b.** A required detail left blank - System saves the rest and marks it as missing; applying asks for it (UC-12 2b).

---

## UC-05: Look up a player

**Actor:** Visitor
**Requirements covered:** R-13
**Trigger:** Visitor follows a player's name anywhere on the site.

**Preconditions**
1. The player has taken part in at least one published event, or has a profile.

**Main success path**
1. Visitor opens the player's profile.
2. System shows name, avatar, events played in (published, live, complete only), the team in each and placings.

**Outcome**
- Nothing changes; private notes, unpublished events and non-public profile details are never shown.

**Error flows**
- **1a.** No such player - System shows not found.

---

## UC-06: Set my general availability

**Actor:** Member
**Requirements covered:** R-15, R-16, R-17, R-18
**Trigger:** Member wants organisers to know when they are usually free.

**Preconditions**
1. Member is signed in.

**Main success path**
1. Member opens a day of the week.
2. System shows the day's current times (none by default).
3. Member adds a time range as free.
4. Member adds another range as maybe.
5. Member marks Saturday as free all day.
6. Member adds a specific date as not available.
7. System validates and saves in the member's time zone.

**Outcome**
- A usual week plus date overrides is stored; UC-07 counts it.

**Alternate flows**
- **6a.** Member adds a date as available for a range - it replaces the usual week for that date only.
- **7a.** Member clears a day - System saves the day as not free.

**Error flows**
- **7b.** A range ends before it starts - System shows which range is wrong; nothing saved.
- **7d.** Ranges on the same day overlap - System merges them into one and saves.
- **7c.** A date in the past - System rejects it.

---

## UC-07: Find a time for an event

**Actor:** Admin
**Requirements covered:** R-19, R-20
**Trigger:** An admin is choosing when to hold an event.

**Preconditions**
1. Actor is an admin; some members have set availability.

**Main success path**
1. Admin opens the availability view.
2. System shows the current week in 30-minute slots between the default daily window, each slot shaded by how many are free.
3. Admin changes the window (e.g. 14:00 to 01:00) and moves to next week.
4. System redraws; slots past midnight belong to the evening they continue.
5. Admin points at a slot.
6. System lists who is free and who is maybe in that slot.

**Outcome**
- Nothing changes; admin has the information to set event days (UC-08).

**Alternate flows**
- **2a.** Nobody has set availability - System says so and explains where members set it.
- **4a.** Week contains a clock change - System shows real local times; no slot is duplicated or lost silently.

---

## UC-08: Set up an event

**Actor:** Admin (creating); Manager (every later step)
**Requirements covered:** R-21, R-22, R-23, R-24, R-25, R-26, R-27, R-28, R-29, R-30, R-31, R-32
**Trigger:** An admin decides to run an event.

**Preconditions**
1. Admin is signed in; the game exists (UC-03).

**Main success path**
1. Admin creates an event from a template.
2. System creates it unpublished with the template's settings, visible only to managers.
3. Manager sets name, game, kind and description.
4. Manager sets one to four days with a start time each.
5. Manager sets the sign-up window and the seat cap.
6. Manager chooses first-come with waitlist.
7. Manager sets a minimum rank to enter and one to captain.
8. Manager writes the sign-up questions, mostly choices, and marks which are required.
9. Manager saves.
10. System validates and saves all of it.

**Outcome**
- The event exists, unpublished, with everything UC-12 needs; the change is in the audit log.

**Alternate flows**
- **1a.** Admin starts from blank - System creates it with no settings. Resumes at 3.
- **6a.** Manager chooses approval - applications arrive pending review (UC-14).
- **9a.** Manager tries to leave with unsaved changes - System holds the navigation and offers save or discard; leaving is only possible after one of them.
- **10a.** Manager saves the setup as a template (admin only) - System stores a template with a name.
- **10b.** Event is already published and applicants exist - System saves and notifies them (UC-25) of the change or question change.

**Error flows**
- **10c.** Sign-ups close after the first day starts, days overlap, cap below 2, or a choice question has no options - System names the problem; nothing saved.
- **10d.** Rank rule set but the game has no ladder - System rejects that field.
- **3a.** Actor is neither admin nor this event's host - System refuses; nothing is shown.

---

## UC-09: Move an event through its life

**Actor:** Manager
**Requirements covered:** R-33, R-34, R-35, R-36, R-37, R-38, R-39
**Trigger:** An event is ready, starting, finished, or called off.

**Preconditions**
1. The event exists; actor manages it.

**Main success path**
1. Manager publishes the unpublished event.
2. System checks it is complete enough (name, at least one day, sign-up window) and makes it visible; announces and notifies (UC-25, UC-26).
3. On the day, manager marks it running.
4. System shows it as live on the front page.
5. Manager marks it complete.
6. System moves it to the archive and makes it read-only.

**Outcome**
- Status is complete; every edit to the event, its teams, draft and results is refused until reopened.

**Alternate flows**
- **1a.** Manager takes a published event back to unpublished - System hides it; applications stay.
- **5a.** Manager cancels instead - System marks it cancelled, keeps it visible in the archive with applications, notifies applicants.
- **6a.** Manager reopens a completed event - System returns it to running, records who reopened it, and edits are allowed again.

**Error flows**
- **2a.** Required setup missing - System lists what is missing; stays unpublished.
- **6b.** Any edit attempted on a complete event - System refuses with "This event is finished - reopen it to change it".
- **3a.** Transition not allowed from the current status (e.g. complete to unpublished) - System refuses.

---

## UC-10: Find something to join or look up

**Actor:** Visitor
**Requirements covered:** R-32, R-40, R-41, R-42
**Trigger:** Visitor arrives at the site.

**Preconditions**
1. None.

**Main success path**
1. Visitor opens the front page.
2. System shows what is live, what is next and the latest results.
3. Visitor opens upcoming events and filters by a kind.
4. System lists matching published events, soonest first.
5. Visitor opens past events.
6. System lists complete and cancelled events, most recent first.

**Outcome**
- Nothing changes; unpublished events never appear.

**Alternate flows**
- **2a.** Nothing live or upcoming - System says so and links the archive.
- **4a.** No events of that kind - System says so and offers to clear the filter.

---

## UC-11: Follow an event

**Actor:** Visitor
**Requirements covered:** R-43, R-44, R-45, R-46, R-47, R-77
**Trigger:** Visitor opens an event.

**Preconditions**
1. The event is published, running, complete or cancelled.

**Main success path**
1. Visitor opens the event.
2. System shows details, days, sign-up state and seats left.
3. Visitor views teams.
4. System shows each team, captain and roster.
5. Visitor views the schedule.
6. System shows each day's blocks with times adjusted to actual finish times.
7. Visitor views the bracket.
8. System shows the stages, pairings resolved from results, and standings.
9. Visitor views results.
10. System shows every match with each map's result, side and map choosers, and referee.

**Outcome**
- Nothing changes. While the event is running, the page keeps itself current without a reload.

**Alternate flows**
- **3a.** Event has no teams, draft or format - System does not offer those views.
- **8a.** Slot not yet decided - System shows where it comes from ("Winner of Upper semi 1").

**Error flows**
- **1a.** Event unpublished and visitor is not a manager - System shows not found.

---

## UC-12: Apply to an event

**Actor:** Member
**Requirements covered:** R-48, R-49, R-50, R-51
**Trigger:** Member chooses to apply.

**Preconditions**
1. Event is published and sign-ups are open.
2. Member is signed in and has not already applied.

**Main success path**
1. Member chooses apply.
2. System shows their saved profile details for the event's game and asks whether they are still right; shows the entry rules and whether they meet them.
3. Member confirms the details.
4. Member answers the event's questions.
5. Member picks the days they can attend.
6. Member submits.
7. System validates, stores the application and gives them a seat.
8. System shows "You're in" and notifies (UC-25).

**Outcome**
- Application stored as accepted; seats left drops by one.

**Alternate flows**
- **3a.** Details changed - Member edits them in place; System saves them to their profile too.
- **7a.** Seats full - System stores them waitlisted with their position.
- **7b.** Event uses approval - System stores them as pending review.

**Error flows**
- **2a.** Member is below the minimum rank and no manager has waived it for them on this event - System says so before any questions, and does not offer submit.
- **2b.** No profile for this game - System asks for the required details inline.
- **6a.** Required answer missing - System marks it; nothing stored.
- **7c.** Sign-ups closed between opening and submitting - System refuses with "Sign-ups closed"; nothing stored.
- **7d.** Double submit - System stores one application.

---

## UC-13: Manage my application

**Actor:** Applicant
**Requirements covered:** R-52, R-53, R-54, R-55, R-56, R-60
**Trigger:** Applicant checks on or changes an application.

**Preconditions**
1. Applicant has an application.

**Main success path**
1. Applicant opens their dashboard.
2. System shows their next event, open applications with status and position, and to-dos (unanswered changed questions, unconfirmed attendance).
3. Applicant changes an answer while sign-ups are open.
4. System saves it.
5. Close to the date, applicant confirms they are coming.
6. System records it.

**Outcome**
- Answers and confirmation stored; managers see them (UC-14).

**Alternate flows**
- **3a.** Applicant withdraws - System marks it withdrawn; if they held a seat, the first waitlisted applicant is moved into it and notified.
- **5a.** Applicant says they are not coming - System frees their seat, promoting as in 3a.

**Error flows**
- **4a.** Sign-ups closed - System refuses edits; withdrawing is still allowed.
- **3b.** Event complete - System refuses every change.

---

## UC-14: Decide on applicants

**Actor:** Manager
**Requirements covered:** R-57, R-58, R-59
**Trigger:** Applications have arrived.

**Preconditions**
1. Actor manages the event; there is at least one application.

**Main success path**
1. Manager opens the applicants.
2. System lists them with status, answers, rank, days and confirmation, filterable by status.
3. Manager accepts one waitlisted applicant.
4. System gives them a seat and notifies them.
5. Manager declines another.
6. System frees their seat, promotes the next waitlisted, notifies both.

**Outcome**
- Statuses changed, seats and waitlist consistent, each decision in the audit log.

**Alternate flows**
- **3a.** Accepting goes over the cap - System asks the manager to confirm going over; seat cap is not changed.
- **3b.** Manager waives an entry rule (to enter, or to captain) for a member on this event, before or after they apply - System records the waiver and who gave it.

**Error flows**
- **4a.** Event complete - System refuses.

---

## UC-15: Form teams

**Actor:** Manager
**Requirements covered:** R-61, R-62, R-63
**Trigger:** Enough players are accepted to make teams.

**Preconditions**
1. Actor manages an event with teams; accepted applicants exist.

**Main success path**
1. Manager sets the number of teams.
2. System creates them.
3. Manager chooses a captain for each from accepted applicants.
4. System names each team after its captain ("Team Bob") and puts the captain on its roster.
5. Manager places the remaining players on rosters by hand.
6. System saves.

**Outcome**
- Teams, captains and rosters stored; the format follows them (UC-18).

**Alternate flows**
- **4a.** Manager has renamed a team - System keeps the custom name when the captain changes.
- **5a.** Event uses a draft - Manager skips; players are placed by UC-16.

**Error flows**
- **3a.** Captain below the captain rank rule - System says so; manager may override as in UC-14 3b.
- **3b.** Player already captain of another team - System refuses.
- **6a.** A generated name clashes with another team's - System adds a distinguishing suffix. A typed duplicate is refused.

---

## UC-16: Run the draft

**Actor:** Manager; Visitors watch
**Requirements covered:** R-64, R-65, R-66, R-67, R-70
**Trigger:** Teams have captains and the draft is due.

**Preconditions**
1. Captains are chosen (UC-15); pool is the accepted non-captains.

**Main success path**
1. Manager sets the draft rules: balances, how the next player is chosen, sealed or open bidding, bid visibility, reserve pool, roster size.
2. System saves them.
3. Manager puts the next player up.
4. System opens the lot to captains; the room sees who is up.
5. Captains bid (UC-17).
6. Manager closes the lot and awards it to the highest bid.
7. System adds the player to that roster, deducts the balance, shows the result to the room.
8. Repeat 3-7 until rosters are full or the pool is empty.

**Outcome**
- Every pool player is awarded, discarded or reserved; rosters and balances stored; the room saw it as it happened.

**Alternate flows**
- **3a.** Selection is by wheel - System spins, all watchers see the same result.
- **6a.** No bids - Manager discards or sends to reserve; System records it.
- **6b.** Tie - Manager picks among the tied bids; System shows the room that it was a tie.
- **7a.** Manager undoes the last award - System voids the lot, restores balance and roster, and shows it; the voided lot stays in history.
- **8a.** Main pool empty with reserve players - System puts reserve players up in turn.

**Error flows**
- **1a.** Rules changed after the first lot opened - System refuses.
- **3b.** A lot is already open - System refuses to open another.

---

## UC-17: Bid as a captain

**Actor:** Captain
**Requirements covered:** R-68, R-69
**Trigger:** A lot is open.

**Preconditions**
1. Actor is a captain in this draft; a lot is open.

**Main success path**
1. Captain sees the player, their balance and the most they can bid.
2. Captain enters a bid.
3. System accepts it and shows it according to visibility rules.

**Outcome**
- Bid stored. In open bidding the captain may raise it until the lot closes; in sealed bidding it is their one bid.

**Error flows**
- **3a.** Above balance - System rejects with the maximum.
- **3b.** Would leave too little to fill the roster at the minimum price - System rejects with the maximum allowed.
- **3c.** Open bidding and below the current highest plus increment - System rejects with the minimum.
- **3d.** Lot closed before it arrived - System rejects; nothing stored.
- **3e.** Captain's roster already full - System does not let them bid.

---

## UC-18: Configure the format

**Actor:** Manager
**Requirements covered:** R-71, R-72, R-73, R-74, R-75, R-76
**Trigger:** Manager plans how the event is played.

**Preconditions**
1. Actor manages an event with a format.

**Main success path**
1. Manager adds a stage and picks its kind.
2. System generates its matches, using placeholder teams if real teams are too few.
3. Manager sets series length for the stage and a longer one for the final.
4. Manager sets bronze match, bracket reset, points and tiebreaks as the kind allows.
5. System regenerates the stage's matches.
6. Manager sets concurrent matches and break length for the event.
7. System shows the planned blocks with clock times and day totals.
8. Teams change (UC-15, UC-16).
9. System regenerates matches with real teams.

**Outcome**
- Stages and matches exist and match the teams; the schedule preview is current.

**Alternate flows**
- **1a.** Groups then playoff - Manager sets group count and how many advance.
- **9a.** A stage has recorded results or manual changes - System does not regenerate it, marks it out of date, and offers "rebuild anyway" with a warning of what is lost.

**Error flows**
- **2a.** Kind does not support the team count - System names the valid range; nothing generated.
- **7a.** Day overruns midnight or the next day - System warns; it is allowed.
- **5a.** Event complete - System refuses.

---

## UC-19: Record results

**Actor:** Manager
**Requirements covered:** R-77, R-78, R-79, R-80, R-81, R-82
**Trigger:** A match is played.

**Preconditions**
1. Match has two resolved teams; event is running.

**Main success path**
1. Manager opens the match.
2. System shows who chooses side and who chooses map for each map, from the coin toss.
3. Manager records map 1: which map, score, referee, side taken.
4. System stores it; the series score updates.
5. Manager records the remaining maps until one team has won the series.
6. System marks the match won, fills the next match's slot, updates standings and shifts later matches that day by the actual finish time.

**Outcome**
- Result stored; bracket, standings and schedule reflect it on every view; announced (UC-26).

**Alternate flows**
- **2a.** Coin was miscalled - Manager re-tosses or hands side choice to a named team; System swaps choosers for the series.
- **3a.** Manager corrects a map of a match already feeding later matches - System recomputes every dependent slot and standing; if a later match now has a different team and had results, it is flagged for the manager.

**Error flows**
- **2b.** Re-toss after any map is played - System refuses with "Clear the series first".
- **4a.** Score not valid (negative, or a draw on a single map) - System rejects with the reason; nothing stored.
- **5a.** Map recorded beyond series length - System refuses.
- **1a.** Event complete - System refuses (UC-09 6b).

---

## UC-20: Apply to host

**Actor:** Member
**Requirements covered:** R-83, R-84
**Trigger:** Member wants to run an event.

**Preconditions**
1. Member is signed in and has no pending host application.

**Main success path**
1. Member opens host application.
2. Member describes the event: game (from catalogue or new), what players must provide, format, proposed dates.
3. Member submits.
4. System stores it as pending and shows its status.

**Outcome**
- A pending host application admins can see (UC-21, UC-27).

**Alternate flows**
- **4a.** Member withdraws a pending application - System marks it withdrawn.

**Error flows**
- **3a.** Required fields missing - System marks them; nothing stored.
- **3b.** Already has a pending application - System refuses and links it.

---

## UC-21: Decide a host application

**Actor:** Admin, then Host
**Requirements covered:** R-85, R-86
**Trigger:** A host application is pending.

**Preconditions**
1. Actor is an admin.

**Main success path**
1. Admin opens the host application.
2. Admin creates the event from it (UC-08 1-2), with the game, questions and format described.
3. Admin approves, linking that event.
4. System makes the applicant host of that one event and notifies them.
5. Host manages that event through UC-08, UC-09, UC-14 to UC-19.

**Outcome**
- Host has manager rights on exactly one event.

**Alternate flows**
- **3a.** Admin declines with a reason - System marks it declined and notifies.

**Error flows**
- **5a.** Host acts on another event, or on an item belonging to another event - System refuses; nothing changes.
- **5b.** Host tries to create events, manage users or change site settings - System refuses.

---

## UC-22: Suggest and back events

**Actor:** Member; Visitor reads; Admin responds
**Requirements covered:** R-87, R-88, R-89, R-90
**Trigger:** Someone has an idea.

**Preconditions**
1. Member is signed in to suggest or vote.

**Main success path**
1. Member submits a suggestion with a title and short description.
2. System lists it.
3. Other members like or dislike it.
4. System ranks suggestions by support.
5. Admin marks it planned.
6. System shows the status to everyone.

**Outcome**
- Suggestions visible to visitors with support counts and status.

**Alternate flows**
- **3a.** Member changes like to dislike or removes it - System keeps one vote per member.

**Error flows**
- **1a.** Empty or too long - System rejects.
- **3b.** Visitor not signed in tries to vote - System asks them to sign in.

---

## UC-23: Run a poll

**Actor:** Admin
**Requirements covered:** R-91, R-95, R-101
**Trigger:** An admin wants to ask the community something.

**Preconditions**
1. Actor is an admin.

**Main success path**
1. Admin writes a question, at least two options, single or multiple choice, closing time.
2. System publishes it and notifies members (UC-25).
3. Admin edits the wording of an option before it closes.
4. System saves; if the change alters an option people voted for, the admin is shown which votes are affected before saving.
5. Admin closes it early.
6. System stops voting and shows final results.

**Outcome**
- Poll closed; results final and public.

**Alternate flows**
- **5a.** Closing time passes - System treats it as closed.
- **5b.** Admin deletes the poll - System removes it and its votes.

**Error flows**
- **1a.** Fewer than two options, duplicates, or closing time in the past - System rejects.
- **3a.** Poll already closed - System refuses edits.
- **1b.** Non-admin tries to create - System refuses.

---

## UC-24: Vote in a poll

**Actor:** Member; Visitor reads
**Requirements covered:** R-92, R-93, R-94
**Trigger:** A poll is open.

**Preconditions**
1. Member signed in; poll open.

**Main success path**
1. Member picks an option (or several for multiple choice) and votes.
2. System stores it and shows counts and who voted for each option.
3. Member changes their vote.
4. System replaces it.

**Outcome**
- One current vote per member; counts and voters public.

**Error flows**
- **1a.** More than one option on a single-choice poll - System rejects.
- **3a.** Poll closed - System refuses.

---

## UC-25: Receive notifications

**Actor:** Member; Scheduler
**Requirements covered:** R-96, R-97, R-98, R-99, R-100, R-102, R-103, R-104, R-105, R-106
**Trigger:** Something the member may care about happens, or the scheduler wakes.

**Preconditions**
1. Member is signed in to read them.

**Main success path**
1. An event is published (UC-09).
2. System creates a notification for each member who has not switched that kind off.
3. Member sees an unread count.
4. Member opens notifications and follows one.
5. System marks it read and takes them to the event.
6. Member switches off "new event" and turns on Discord DMs for "application decided".
7. System saves the preferences.
8. Scheduler wakes.
9. System finds events starting within a day and notifies each seat holder once.

**Outcome**
- Notifications stored per member, never duplicated for the same happening; preferences honoured.

**Alternate flows**
- **2a.** Kind is event changed/cancelled/questions changed - recipients are that event's applicants.
- **2b.** Kind is application or host decision - it cannot be switched off.
- **2c.** Member opted in to DMs for the kind - System also sends a Discord DM.

**Error flows**
- **2d.** Discord DM fails (bot not configured, DMs closed) - in-site notification still stored; nothing retried endlessly.
- **8a.** Scheduler call without the correct secret, or no secret configured - System refuses; nothing sent.
- **9a.** Scheduler wakes twice in the window - no member is reminded twice.

---

## UC-26: Announce to Discord

**Actor:** Admin (configures); Discord (receives)
**Requirements covered:** R-107, R-108
**Trigger:** An event is published, an application decided, or a result recorded.

**Preconditions**
1. An announcement channel is configured.

**Main success path**
1. Admin chooses which announcements are sent.
2. System saves it.
3. An event is published.
4. System posts to the channel with a link to the event.

**Outcome**
- Discord channel has the message; the site action completed regardless.

**Alternate flows**
- **3a.** That announcement is switched off - System posts nothing.

**Error flows**
- **4a.** Discord rejects or is unreachable - the site action still succeeds; failure is logged for admins.
- **4b.** No channel configured - nothing is posted; settings show it as not set up.

---

## UC-27: Oversee the site

**Actor:** Admin
**Requirements covered:** R-109, R-110, R-111, R-112
**Trigger:** An admin checks in, or needs to change configuration.

**Preconditions**
1. Actor is an admin.

**Main success path**
1. Admin opens the admin home.
2. System shows pending applications, pending host applications and unscheduled matches, each linked.
3. Admin opens the audit log and filters by an event.
4. System lists who did what and when.
5. Admin changes the announcement channel and site address in settings.
6. System saves them; they take effect without a redeploy.

**Outcome**
- Settings changed and logged, with the channel URL masked in the log.

**Alternate flows**
- **2a.** Nothing needs attention - System says so.

**Error flows**
- **5a.** Invalid URL - System rejects; old value stays.
- **5b.** Secrets: settings never display or accept `AUTH_SECRET`, `DISCORD_CLIENT_SECRET`, `DATABASE_URL`, bot token or cron secret; the channel URL is shown masked.
- **1a.** Non-admin (including a host) opens any of this - System refuses.

---

# Added at Gate 2 (2026-09-17)

Features the site already had, kept as requirements R-113 to R-169. Where a feature fits an
existing use case it is written as an extension of it: flows numbered `E1`, `E2`, ... that
branch from the named step, each one an acceptance test like any other flow. Three are use
cases of their own.

## UC-02 extensions: Manage members and admin rights

**Requirements covered:** R-135, R-136, R-137, R-138, R-139, R-140

- **E1.** Admin searches members by name and filters by admin / not admin - System lists matches, each with when they were last on the site and how many events they have played.
- **E2.** At step 1, admin adds a note to the grant - System stores it with the granting admin; the admin list shows both.
- **E3.** Admin turns the gate off (as 8a) - System warns that anyone with Discord can now sign in before saving. The gate is on for a new deployment.

## UC-03 extensions: Manage the game catalogue

**Requirements covered:** R-131, R-132, R-133

- **E1.** At step 5, admin adds a detail for every game - System asks it on every game's profile section, once.
- **E2.** Admin hides a game - System stops offering it for new events, host applications and profiles; existing events, answers and history keep it.
- **E3.** Admin reorders games - System shows them in that order everywhere a game is chosen.

## UC-05 extensions: Look up a player

**Requirements covered:** R-151

- **E1.** At step 2, the player was drafted - System also shows the price in each draft and their draft totals.

## UC-06 extensions: Set my general availability

**Requirements covered:** R-134

- **E1.** At step 6, member adds a note ("away at a wedding") - System stores it with the override and shows it to admins in UC-07's slot list.

## UC-08 extensions: Set up an event

**Requirements covered:** R-113, R-114, R-115, R-116, R-117

- **E1.** At step 3, manager adds a banner image - System shows it on the event page and its front-page card.
- **E2.** At step 3, manager changes the web address - System saves it.
  - **E2a.** Address taken or not letters, numbers and hyphens - System rejects with the reason; the old address stays.
- **E3.** At step 4, manager labels a day - System uses the label wherever the day is named.
- **E4.** At step 3, manager types a kind not in the list - System saves it and offers it as a filter once an event of that kind is published.
- **E5.** At any step, System lists what is still missing or worth checking (no questions, no cap, a rank rule with no rank question). The list advises; it does not block - only UC-09 2a blocks.

## UC-11 extensions: Follow an event

**Requirements covered:** R-118

- **E1.** Visitor views who is in - System lists members holding a seat (accepted), not the waitlist.

## UC-12 extensions: Apply to an event

**Requirements covered:** R-121, R-122

- **E1.** Precondition 2 fails because the member withdrew earlier - System lets them apply again; they go to the back of the queue.
- **E2.** Precondition 2 fails because the member was declined - System refuses with "You were declined for this event" and offers no form.

## UC-13 extensions: Manage my application

**Requirements covered:** R-123, R-124

- **E1.** At step 2, System also lists events taking applications that the member has not applied to.
- **E2.** At step 2, System shows how many of the member's profile details are answered, linking the profile.

## UC-14 extensions: Decide on applicants

**Requirements covered:** R-119, R-120

- **E1.** Manager writes a note on an application - System stores it, visible to managers only.
- **E2.** Manager changes which days an applicant can attend - System saves it and audits who changed it.
- **E3.** Either on a complete event - System refuses (UC-09 6b).

## UC-15 extensions: Form teams

**Requirements covered:** R-161

- **E1.** At step 1, manager lowers the team count - System first lists what will be cleared (rosters, draft awards, generated matches, recorded results) and removes teams only after the manager confirms.

## UC-16 extensions: Run the draft

**Requirements covered:** R-143, R-144, R-145, R-146, R-147, R-148, R-149

- **E1.** At step 1, manager sets a bid time limit - at step 4 System shows a countdown to everyone; bids after it are refused (UC-17 3d).
- **E2.** At step 1, manager sets how many times a reserved player can come back - at 8a a reserved player is put up again at most that many times, then is out of the draft.
- **E3.** At step 1, manager sets a minimum bid - UC-17 refuses bids below it.
- **E4.** At step 1, manager switches off the roster-fill protection - UC-17 3b no longer applies.
- **E5.** At step 5, manager clears one captain's bid or every bid on the open lot - System removes them; captains may bid again.
- **E6.** Before the first lot, manager moves a player between the main and reserve pools - System saves it.
  - **E6a.** After the first lot has opened - System refuses.
- **E7.** At step 5, every captain able to bid has bid - System tells the manager.

## UC-18 extensions: Configure the format

**Requirements covered:** R-152, R-154, R-155, R-156, R-160, R-162

- **E1.** At step 3, manager sets the mode played on each map of a series length (e.g. Bo3: convoy, convoy, domination) - System shows each map's mode on the match.
- **E2.** At step 3, manager sets a series length for one bracket or one match - it wins over the stage and round lengths.
- **E3.** At step 1, manager makes a round robin double - System generates every pair twice.
- **E4.** At step 7, manager moves a block to another day - System recomputes both days.
- **E5.** Before step 2, manager sets team seeds - System pairs by seed.
- **E6.** At step 5, the change would clear anything - System lists what first and changes only after the manager confirms.

## UC-19 extensions: Record results

**Requirements covered:** R-153, R-157, R-158, R-159

- **E1.** At step 3, manager records the mode the map was played on.
- **E2.** Manager moves a match's start time - System saves it, shifts later matches that day, and marks the stage hand-edited (UC-18 9a).
- **E3.** At step 6, manager records how long the match took - System uses it for that day's schedule.
- **E4.** At step 5, an even-length series ends level - System marks the match as needing a winner; manager decides; System proceeds as step 6.

## UC-20 extensions: Apply to host

**Requirements covered:** R-167, R-168

- **E1.** At step 2, member gives how many players the event expects and a short summary - admins see both first in UC-21.

## UC-22 extensions: Suggest and back events

**Requirements covered:** R-163, R-164, R-165

- **E1.** At step 1, member names the game - System shows it on the suggestion.
- **E2.** At step 2, System counts the author's like.
- **E3.** Member deletes their own suggestion - System asks to confirm, then removes it and its votes. Another member's is refused.

## UC-23 extensions: Run a poll

**Requirements covered:** R-166

- **E1.** At step 1, admin adds a description - System shows it under the question.
  - **E1a.** Too long - System rejects.

## UC-26 extensions: Announce to Discord

**Requirements covered:** R-150

- **E1.** At step 1, draft sales are one of the announcements - when a lot is awarded (UC-16 step 7), System posts the player, team and price.

## UC-27 extensions: Oversee the site

**Requirements covered:** R-169

- **E1.** At step 2, System also lists events ready to publish, events with teams missing captains, an open draft lot, and matches needing a winner.

---

## UC-28: Maintain templates

**Actor:** Admin
**Requirements covered:** R-22, R-125, R-126, R-127, R-128, R-129, R-130
**Trigger:** An admin wants to change what new events start from.

**Preconditions**
1. Actor is an admin.

**Main success path**
1. Admin opens templates.
2. System lists them in order, each with how many events used it and whether it is on.
3. Admin creates a template from scratch with name, kind, questions, entry mode and format defaults.
4. System saves it.
5. Admin duplicates it and edits the copy.
6. System saves both.
7. Admin switches the original off and moves the copy to the top.
8. System stops offering the original in UC-08 step 1 and saves the order.

**Outcome**
- Templates as arranged; events created from them are unaffected by later edits.

**Alternate flows**
- **3a.** Admin saves a template from an event instead (UC-08 10a).

**Error flows**
- **4a.** Name empty or already used - System rejects.
- **8a.** Deleting a template events were created from - System keeps those events and forgets only the link.

---

## UC-29: Start with an admin

**Actor:** Admin
**Requirements covered:** R-141
**Trigger:** A new deployment, or someone listed in its configuration, signs in.

**Preconditions**
1. The deployment's configuration lists the person's Discord account id.

**Main success path**
1. Person signs in (UC-01).
2. System finds their id in the configuration and makes them an admin.

**Outcome**
- The site has an admin without anyone using the admin screen.

**Error flows**
- **2a.** Their id has been permanently revoked (UC-02 step 5) - System does not make them an admin, whatever the configuration says.

---

## UC-30: Sign in locally without Discord

**Actor:** Developer
**Requirements covered:** R-142
**Trigger:** A developer runs the site on their own machine.

**Preconditions**
1. The site uses the local database, and developer sign-in is switched on in local configuration.

**Main success path**
1. Developer opens developer sign-in and chooses member or admin.
2. System signs them in as a local test member, shows a banner saying so on every page.

**Outcome**
- A working session with no Discord involved.

**Error flows**
- **1a.** The site points at a remote database, or developer sign-in is off - System shows not found and signs nobody in.
