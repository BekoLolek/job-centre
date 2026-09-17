# Requirements - Job Centre Events (full redo)

Written from zero for the redo, not copied from the current build. The current site is
evidence of what the community uses; it is not the spec. Anything the current site does
that is not listed here is a candidate for deletion in the plan.

## Actors

| Role | Description |
|---|---|
| Visitor | Anyone, signed in or not. Wants to see what is on, what happened, and who won. |
| Member | A signed-in person from the Job Centre Discord server. Wants to take part with as little typing as possible. |
| Applicant | A member who has applied to a particular event. Wants to know where they stand and to change their mind. |
| Captain | An applicant chosen to lead a team in one event. Wants to build a team in the draft. |
| Host | A member granted management of one specific event after applying to host it. Wants to run their event without an admin doing it for them. |
| Manager | Either an admin, or the host of the event in question. Used where both may do the same thing to an event. |
| Admin | Runs the community's events and the site itself. Wants to set things up quickly and keep the record straight. |
| Discord | External. Supplies identity and server membership; receives channel announcements and direct messages. |
| Scheduler | External clock. Wakes the site at intervals so time-based things (reminders) happen with nobody on the site. |
| Developer | Whoever works on the site's code. Wants to exercise it locally without a real Discord account. |

## Requirements

### Identity and access

| ID | Requirement | Priority |
|---|---|---|
| R-01 | As a member, I want to sign in with my Discord account, so that I do not need another password. | Must |
| R-02 | As an admin, I want sign-in restricted to members of our Discord server, so that the site stays inside the community. | Must |
| R-03 | As an admin, I want to change which Discord server gates sign-in, so that moving servers does not need a developer. | Should |
| R-04 | As an admin, I want to grant admin rights to a Discord account before its owner has ever signed in, so that a new admin is ready on their first visit. | Must |
| R-05 | As an admin, I want to permanently revoke someone's admin rights, so that they are not restored the next time that person signs in. | Must |
| R-06 | As a member, I want to sign out, so that a shared computer does not stay signed in as me. | Must |
| R-07 | As an admin, I want to end a member's active sessions, so that someone removed from the community cannot keep using an open session. | Could |

### Games and profiles

| ID | Requirement | Priority |
|---|---|---|
| R-08 | As an admin, I want to add a game to the catalogue, so that events can be run for it. | Must |
| R-09 | As an admin, I want to define which details a game asks of its players, so that each game collects only what it needs. | Must |
| R-10 | As an admin, I want to define a game's ordered rank ladder, so that ranks can be compared. | Must |
| R-11 | As a member, I want to keep my details for each game on my profile, so that I do not retype them for every event. | Must |
| R-12 | As a member, I want to choose my rank from the game's ladder, so that entry rules can be checked without anyone reading prose. | Must |
| R-13 | As a visitor, I want to view a player's public profile with the events and teams they played in, so that I can see their history. | Should |
| R-14 | As an admin, I want to keep private notes on a member, so that other admins have context I would otherwise have to repeat. | Could |

### General availability

| ID | Requirement | Priority |
|---|---|---|
| R-15 | As a member, I want to set my usual free times for each day of the week, so that organisers know when I can play. | Should |
| R-16 | As a member, I want to mark a whole day as free in one action, so that I do not enter a range for an open day. | Should |
| R-17 | As a member, I want to mark times as "maybe", so that I can answer without committing. | Should |
| R-18 | As a member, I want to add specific dates that override my usual week, so that holidays and one-off plans are counted. | Should |
| R-19 | As an admin, I want to see, for a chosen week and daily time window, how many members are free in each slot, so that I can pick a time for an event. | Should |
| R-20 | As an admin, I want to see who is free and who is "maybe" in a given slot, so that I know whether the people who matter can come. | Should |

### Event setup

| ID | Requirement | Priority |
|---|---|---|
| R-21 | As an admin, I want to create an event from a template, so that common kinds of event start pre-configured. | Must |
| R-22 | As an admin, I want to save an event's setup as a template, so that a good setup can be reused. | Could |
| R-23 | As a manager, I want to set an event's name, game, kind and description, so that people know what it is. | Must |
| R-24 | As a manager, I want to spread an event over up to four days, each with its own start time, so that long events fit real evenings. | Must |
| R-25 | As a manager, I want to set when sign-ups open and close, so that people apply in a known window. | Must |
| R-26 | As a manager, I want to cap the number of seats, so that an event does not take more players than it can run. | Must |
| R-27 | As a manager, I want to choose between first-come entry with a waitlist and entry by approval, so that each event fills the way it needs to. | Must |
| R-28 | As a manager, I want to set a minimum rank to enter, so that competitive events stay balanced. | Should |
| R-29 | As a manager, I want to set a minimum rank to captain, so that captains can lead their teams. | Should |
| R-30 | As a manager, I want to write the event's sign-up questions, mostly as choices, so that applying is clicks rather than typing. | Must |
| R-31 | As a manager, I want to be stopped from losing unsaved edits when I navigate away, so that I do not redo work. | Should |
| R-32 | As an admin, I want unpublished events visible only to their managers, so that nobody applies to something half-written. | Must |

### Event lifecycle

| ID | Requirement | Priority |
|---|---|---|
| R-33 | As a manager, I want to publish an event, so that members can see it and apply. | Must |
| R-34 | As a manager, I want to take a published event back to unpublished, so that a mistake can be pulled. | Should |
| R-35 | As a manager, I want to mark an event as running, so that visitors see it is live. | Should |
| R-36 | As a manager, I want to mark an event as complete, so that it moves to the archive. | Must |
| R-37 | As a manager, I want to reopen a completed event, so that a recorded mistake can be corrected. | Should |
| R-38 | As a manager, I want to cancel an event, so that applicants know it is off while the record stays. | Should |
| R-39 | As a member, I want a completed event to stay exactly as it finished unless deliberately reopened, so that the record can be trusted. | Must |

### Finding events

| ID | Requirement | Priority |
|---|---|---|
| R-40 | As a visitor, I want the front page to show what is live, what is next and recent results, so that I see the state of things at a glance. | Must |
| R-41 | As a visitor, I want to browse upcoming events filtered by kind, so that I find the ones I would join. | Must |
| R-42 | As a visitor, I want to browse past events, so that I can look up what happened. | Must |
| R-43 | As a visitor, I want to see an event's details and dates, so that I can decide whether to take part. | Must |
| R-44 | As a visitor, I want to see an event's teams and rosters, so that I know who is playing for whom. | Must |
| R-45 | As a visitor, I want to see an event's schedule, so that I know when matches happen. | Must |
| R-46 | As a visitor, I want to see an event's bracket and standings, so that I can follow the competition. | Must |
| R-47 | As a visitor, I want to see the result of every map played in an event, so that I can check the scores. | Must |

### Applying

| ID | Requirement | Priority |
|---|---|---|
| R-48 | As a member, I want to apply to an event by answering its questions, so that I get a seat. | Must |
| R-49 | As a member, I want my profile details shown back to me when I apply, so that I only confirm they are still right. | Must |
| R-50 | As a member, I want to be told before applying that I do not meet an entry rule, so that I do not waste my time. | Should |
| R-51 | As a member, I want to say which of the event's days I can attend, so that the organiser can plan around me. | Must |
| R-52 | As an applicant, I want to see whether I am in, waitlisted or declined, so that I know where I stand. | Must |
| R-53 | As an applicant, I want to change my answers while sign-ups are open, so that a mistake is not permanent. | Should |
| R-54 | As an applicant, I want to withdraw, so that my seat goes to someone who can play. | Must |
| R-55 | As a waitlisted applicant, I want to move into a seat automatically when one frees up, so that I do not depend on an admin noticing. | Must |
| R-56 | As an applicant, I want to confirm I am still coming close to the date, so that no-shows are known in advance. | Should |
| R-57 | As a manager, I want to review applicants with their answers, so that I can decide who plays. | Must |
| R-58 | As a manager, I want to accept, waitlist or decline an applicant, so that the seats go to the right people. | Must |
| R-59 | As a manager, I want to let a specific applicant past an entry rule, so that a filler can play. | Should |
| R-60 | As a member, I want one place showing my next event, my open applications and what I still need to do, so that nothing slips. | Should |

### Teams and the draft

| ID | Requirement | Priority |
|---|---|---|
| R-61 | As a manager, I want to set teams and their rosters by hand, so that events without a draft still have teams. | Must |
| R-62 | As a manager, I want to choose one captain per team from the accepted applicants, so that the draft has people to run it. | Must |
| R-63 | As a manager, I want teams named after their captain unless I rename them, so that I do not have to invent names. | Could |
| R-64 | As a manager, I want to set the draft rules - starting balances, how the next player is chosen, sealed or open bidding, who sees bids, reserve pool, roster size - so that each draft is run the way the event needs. | Must |
| R-65 | As a manager, I want to put the next player up for auction, so that the draft moves forward. | Must |
| R-66 | As a manager, I want to award a player to the winning bid, discard them or send them to the reserve pool, so that every lot is settled. | Must |
| R-67 | As a manager, I want to undo an award, so that a mistake in the room can be corrected. | Must |
| R-68 | As a captain, I want to bid on the player up for auction within my remaining balance, so that I can build my team. | Must |
| R-69 | As a captain, I want to be stopped from bidding so much that I cannot fill my roster, so that one blind bid does not wreck my team. | Should |
| R-70 | As a visitor, I want to watch the draft as it happens, so that the community can follow it. | Must |

### Format, schedule and results

| ID | Requirement | Priority |
|---|---|---|
| R-71 | As a manager, I want to build the event's format from one or more stages (round robin, single elimination, double elimination, swiss, groups then playoff), so that any competition shape is possible. | Must |
| R-72 | As a manager, I want to preview the format with placeholder teams before real teams exist, so that I can plan early. | Should |
| R-73 | As a manager, I want matches to follow changes to teams and stage settings while nothing has been played, so that I never rebuild them by hand. | Should |
| R-74 | As a manager, I want to set series length per stage and per round, so that finals can be longer. | Must |
| R-75 | As a manager, I want to choose bronze match, bracket reset, points and tiebreak rules, so that the format matches what we announced. | Should |
| R-76 | As a manager, I want to set how many matches run at once and the breaks between blocks, so that a realistic schedule is planned. | Must |
| R-77 | As a visitor, I want later matches that day to shift when earlier ones finish late or early, so that the schedule shows real times. | Must |
| R-78 | As a manager, I want to record, for each map of a match, which map it was, the score and the referee, so that the result is on record. | Must |
| R-79 | As a manager, I want correcting an earlier result to update everything that depended on it, so that the bracket never disagrees with the scores. | Must |
| R-80 | As a manager, I want a coin toss to decide which team chooses side first, the other team choosing the map, with the two swapping every map of the series, so that both teams get an equal say. | Should |
| R-81 | As a manager, I want to re-toss or hand the side choice to a named team before any map is played, so that a miscalled coin can be fixed. | Should |
| R-82 | As a manager, I want to note which side the choosing team took, so that the record is complete. | Could |

### Hosting

| ID | Requirement | Priority |
|---|---|---|
| R-83 | As a member, I want to apply to host an event, describing the game, what players need to provide and how it runs, so that an admin can set it up for me. | Should |
| R-84 | As a member, I want to see my host application's status and withdraw it, so that I am not left guessing. | Could |
| R-85 | As an admin, I want to approve or decline a host application, so that only suitable events run. | Should |
| R-86 | As a host, I want to manage everything about the one event I was granted, so that I run it without an admin. | Should |

### Suggestions and polls

| ID | Requirement | Priority |
|---|---|---|
| R-87 | As a member, I want to suggest an event, so that organisers hear what people want. | Should |
| R-88 | As a visitor, I want to see suggested events ranked by support, so that demand is visible. | Should |
| R-89 | As a member, I want to like or dislike a suggestion, so that my opinion counts. | Should |
| R-90 | As an admin, I want to mark a suggestion as planned, done or declined, so that people know what came of it. | Could |
| R-91 | As an admin, I want to post a poll with single or multiple choice and a closing time, so that I can ask the community something. | Should |
| R-92 | As a member, I want to vote in a poll, so that my answer counts. | Should |
| R-93 | As a member, I want to change my vote until the poll closes, so that I can change my mind. | Should |
| R-94 | As a visitor, I want to see each option's vote count and who voted for it, so that the result is transparent. | Should |
| R-95 | As an admin, I want to edit, close or delete a poll, so that I can fix mistakes and end it. | Should |

### Notifications

| ID | Requirement | Priority |
|---|---|---|
| R-96 | As a member, I want to be notified when a new event is published, so that I do not miss sign-ups. | Should |
| R-97 | As a member, I want to be reminded the day before an event I have a seat in, so that I turn up. | Should |
| R-98 | As an applicant, I want to be notified when an event I applied to changes or is cancelled, so that my plans stay right. | Should |
| R-99 | As an applicant, I want to be notified when an event's questions change after I answered them, so that I can update my answers. | Should |
| R-100 | As an applicant, I want to be notified when my application is decided, so that I know without checking. | Should |
| R-101 | As a member, I want to be notified when a poll is posted, so that I can vote before it closes. | Could |
| R-102 | As a member, I want to be notified when my host application is decided, so that I can get started. | Could |
| R-103 | As a member, I want to see how many notifications I have not read, so that I know when something needs me. | Should |
| R-104 | As a member, I want to switch off any kind of notification except answers to my own applications, so that I only hear what I care about. | Should |
| R-105 | As a member, I want to opt in, per kind, to receiving notifications as Discord direct messages, off by default, so that important ones reach me outside the site. | Could |
| R-106 | As the scheduler, I want to trigger delivery of reminders that are due, so that reminders arrive with nobody on the site. | Should |
| R-107 | As an admin, I want new events, application decisions and results announced in a Discord channel, so that the server sees what is happening. | Should |
| R-108 | As an admin, I want to choose which of those announcements are sent, so that the channel is not noisy. | Could |

### Running the site

| ID | Requirement | Priority |
|---|---|---|
| R-109 | As an admin, I want one place showing what needs attention - pending applications, host applications, unscheduled matches, so that nothing waits on me unnoticed. | Should |
| R-110 | As an admin, I want a log of who changed what and when, filterable by event, so that disputes can be settled. | Should |
| R-111 | As an admin, I want to change non-secret settings such as the Discord server, announcement channel and site address without a redeploy, so that routine changes need no developer. | Should |
| R-112 | As an admin, I want secrets impossible to read or change from the site, so that an admin account compromise does not leak credentials. | Must |

### Kept from the current site (added at Gate 2, 2026-09-17)

The gap audit found these in the code with no requirement asking for them. The user chose to
keep them rather than delete them, so they are requirements now. Where one bends an earlier
requirement, the note says how the two combine.

| ID | Requirement | Priority | Note |
|---|---|---|---|
| R-113 | As a manager, I want to give an event a banner image, so that its page and the front page are recognisable at a glance. | Could | |
| R-114 | As a manager, I want to choose an event's web address, so that links shared on Discord are readable. | Could | |
| R-115 | As a manager, I want to label each event day, so that a schedule reads "Groups" and "Finals" rather than "Day 1". | Could | |
| R-116 | As a manager, I want to give an event a kind that is not in the list, so that one-off events can still be categorised. | Could | |
| R-117 | As a manager, I want to see what an event still lacks before I publish it, so that I publish with confidence. | Should | Advice only; the refusal rules are UC-09 2a |
| R-118 | As a visitor, I want to see who has a seat in an event, so that I know who is coming. | Should | |
| R-119 | As a manager, I want to keep a private note on an application, so that my reasoning is there when I decide. | Could | |
| R-120 | As a manager, I want to correct which days an applicant can attend, so that a message on Discord can be recorded. | Could | |
| R-121 | As a member, I want to apply again after withdrawing, so that changing my mind back is possible. | Should | Goes to the back of the queue |
| R-122 | As a manager, I want a declined member unable to apply to that event again, so that a decision sticks. | Should | Beats R-121 |
| R-123 | As a member, I want my dashboard to show which events are taking applications, so that I see what I can join. | Should | |
| R-124 | As a member, I want to see how complete my profile is, so that I know what is left to fill in. | Could | |
| R-125 | As an admin, I want to create a template from scratch, so that a new kind of event has a starting point before one has run. | Could | |
| R-126 | As an admin, I want to edit a template, so that it stays current. | Could | |
| R-127 | As an admin, I want to duplicate a template, so that a variant starts from an existing one. | Could | |
| R-128 | As an admin, I want to switch a template off without deleting it, so that a seasonal setup is kept for next time. | Could | |
| R-129 | As an admin, I want to order templates, so that the common ones come first. | Could | |
| R-130 | As an admin, I want to see how many events used each template, so that I know which ones earn their place. | Could | |
| R-131 | As an admin, I want to define details asked of players for every game, so that shared details are asked once. | Could | |
| R-132 | As an admin, I want to hide a game without deleting it, so that its history stays while it is off the menu. | Could | |
| R-133 | As an admin, I want to order games, so that the ones we play most come first. | Could | |
| R-134 | As a member, I want to add a note to a date override, so that organisers know why. | Could | |
| R-135 | As an admin, I want to search and filter members, so that I find someone quickly. | Could | |
| R-136 | As an admin, I want to see when a member was last on the site, so that I know who is active. | Could | |
| R-137 | As an admin, I want to see how many events a member has played, so that I know who the regulars are. | Could | |
| R-138 | As an admin, I want to note why an account is on the admin list, so that other admins know. | Could | |
| R-139 | As an admin, I want to see who added an account to the admin list, so that grants are accountable. | Could | |
| R-140 | As an admin, I want to turn the server gate off, so that people outside the server can sign in when we choose. | Could | Gate is on by default; R-02 holds while it is on |
| R-141 | As an admin, I want first admins named in the deployment's configuration, so that the site has an admin before anyone can reach the admin screen. | Should | A permanent revoke (R-05) beats the configuration |
| R-142 | As a developer, I want to sign in locally without Discord, so that I can exercise the site. | Should | Only ever with a local database |
| R-143 | As a manager, I want to set a time limit for bids on a lot, so that the draft keeps moving. | Could | |
| R-144 | As a manager, I want to set how many times a reserved player can come back, so that the reserve pool runs as announced. | Could | Replaces the "comes back once" assumption |
| R-145 | As a manager, I want to set a minimum bid, so that no player goes for nothing. | Could | |
| R-146 | As a manager, I want to choose whether captains must keep enough to fill their roster, so that the protection suits the draft. | Could | R-69 applies while it is on; on by default |
| R-147 | As a manager, I want to clear one captain's bid or every bid on the open lot, so that a mistaken bid can be undone. | Could | |
| R-148 | As a manager, I want to move players between the main and reserve pools before the draft, so that the pools are set up as planned. | Could | |
| R-149 | As a manager, I want to see when every captain has bid on the open lot, so that I know I can close it. | Could | |
| R-150 | As an admin, I want each draft sale announced in the Discord channel, so that the server can follow the draft. | Could | Switchable with the others (R-108) |
| R-151 | As a visitor, I want to see the prices a player went for in drafts on their profile, so that draft history is visible. | Could | |
| R-152 | As a manager, I want to set the mode played on each map of a series, so that the format matches the game's rules. | Could | |
| R-153 | As a manager, I want to record which mode each map was, so that the record is complete. | Could | |
| R-154 | As a manager, I want to set series length for a particular bracket or match, so that a final or a lower bracket can differ. | Could | Extends R-74 |
| R-155 | As a manager, I want a round robin played twice, so that every pair meets home and away. | Could | |
| R-156 | As a manager, I want to choose which day each block of matches runs on, so that the schedule fits the evenings. | Could | |
| R-157 | As a manager, I want to move a match's start time by hand, so that a late lobby is reflected. | Could | A moved match marks its stage as hand-edited (UC-18 9a) |
| R-158 | As a manager, I want to record how long a match took, so that schedule estimates improve. | Could | |
| R-159 | As a manager, I want to decide the winner of a drawn series, so that a bracket can continue after a draw. | Could | Series lengths may be even |
| R-160 | As a manager, I want to set team seeds, so that brackets pair teams fairly. | Should | |
| R-161 | As a manager, I want to see what removing teams will clear before I do it, so that I do not lose results by accident. | Could | |
| R-162 | As a manager, I want to see what changing stages will clear before I do it, so that I do not lose results by accident. | Could | |
| R-163 | As a member, I want to delete my own suggestion, so that I can take back an idea. | Could | |
| R-164 | As a member, I want my own suggestion to start with my like, so that it counts me. | Could | |
| R-165 | As a member, I want to say which game a suggestion is for, so that organisers can tell at a glance. | Could | |
| R-166 | As an admin, I want to add a description to a poll, so that the question has context. | Could | |
| R-167 | As a member, I want to say how many players my event expects when applying to host, so that an admin can judge it. | Could | |
| R-168 | As a member, I want to give a short summary when applying to host, so that an admin sees the idea quickly. | Could | |
| R-169 | As an admin, I want the admin home to flag events that are ready to publish, missing captains, holding an open draft lot, or with a series needing a winner, so that those decisions reach me. | Could | Extends R-109 |
| R-170 | As a manager, I want a first-come event to either keep a waitlist or simply close when full, so that a small event does not collect a queue it will never use. | Could | Added during Task 7 planning: the audit found it, and it was missed from the Gate 2 list. Applies to first-come entry only (R-27) |

Priority: Must (no launch without it) / Should (launch is worse without it) / Could (nice to have).

## Constraints

- **Production data survives.** Every existing user, event, application, team, draft, match and result in the live Neon database must be present and correct after the redo. No reset.
- **The live site keeps working.** jobcentre.vercel.app stays usable throughout; there is no "down for the rebuild" window.
- **Identity is Discord only.** The community lives on Discord; no other sign-in.
- **Hosting stays free-tier.** Vercel Hobby and Neon free tier. Vercel Cron on Hobby runs at most once a day per job unless upgraded (to verify in Phase 5).
- **Scale.** One community: hundreds of members, tens of concurrent users normally, the whole room during a live draft.
- **Signing up is clicks, not typing.** Free text only where unavoidable (an in-game name, "anything else").
- **Usable on a phone** at ~400px wide; readable contrast (WCAG AA); respects reduced-motion.
- **Secrets** (`AUTH_SECRET`, `DISCORD_CLIENT_SECRET`, `DATABASE_URL`, bot token, cron secret) never reach the browser, the settings screen or the audit log. The webhook URL is shown masked only.
- **Nothing on the record is hard-deleted** - events, applications, results and draft lots. (Polls and suggestions may be deleted by an admin; R-95.)

## Out of scope

- Any sign-in other than Discord; passwords; email accounts.
- Email or SMS notifications.
- A hosted Discord bot process (slash commands, reading channels). Direct messages are sent, not received.
- Map veto / ban-pick flow (replaced by the side-and-map swap rule, R-80).
- Pulling results or ranks automatically from game APIs; verifying claimed ranks.
- Payments, prizes, entry fees.
- Chat, comments or messaging between members on the site.
- Streaming, VOD embedding or match replays.
- Multiple communities / servers on one deployment.
- A public API.
- Translation into other languages.
- Native mobile apps.
- One host managing several events under a single grant (each grant is one event; R-86).
- The retired password-based draft board and its env-var accounts.
- Artificial delays or simulated mouse movement between actions.

## Open questions

**Gate 1 approved 2026-09-15** ("proceed"). No requirements were cut, and no new design
direction was given, so questions 2 and 3 close under the assumptions written below; the
other assumptions stand.

| # | Question | Blocking? | Assumption made if not blocking |
|---|---|---|---|
| 1 | What does "redo" mean for the code: a from-scratch rewrite, or rebuild area by area against this spec, keeping what already satisfies it? | No (decided at Gate 2) | Area by area on the live database. A from-scratch rewrite would duplicate ~1,800 tests' worth of solved behaviour and put the production-data constraint at risk. |
| 2 | Which requirements should be cut? Anything struck here gets deleted from the code, not hidden. | Closed | None cut; all 112 stand. |
| 3 | What is wrong with the current design that the redo must fix - a new visual direction, or the same direction done better? | Closed | Same direction (neutral dark ground, Union blue, Inter / Michroma / JetBrains Mono) done consistently: one set of primitives, one page structure, no hand-rolled equivalents. |
| 4 | May a host publish, complete and cancel their own event, or only set it up and run it? | No | Yes - R-86 means everything about that one event. Creating events stays admin-only. |
| 5 | Are suggestion likes public by name, like poll votes (R-94)? | No | No - counts only. |
| 6 | What do the rank thresholds default to (Platinum 3 to enter, Diamond 2 to captain were provisional)? | No | No default; unset means no rule. |
| 7 | What is a draft "reserve round" - how many times a reserved player comes back round? | Closed | A manager setting (R-144): a reserved player comes back up to that many times, each after the main pool is empty. |
| 8 | Should `live` be set by a manager (R-35) or automatically when the first day starts? | No | By a manager. |

## Glossary

| Term | Means |
|---|---|
| Event | One thing the community runs - a tournament, a game night - with its own sign-ups, and optionally teams, a draft and a format. |
| Kind | The category of an event (Rivals tournament, casual 6v6, Jackbox, ...), used for filtering and templates. |
| Template | A saved event setup that new events can start from. |
| Game | An entry in the catalogue, with its own profile details and rank ladder. |
| Rank ladder | A game's ranks in order, lowest to highest. |
| Application | A member's request for a seat in one event, with their answers. |
| Seat | A place in an event, held by an accepted applicant. |
| Waitlist | Applicants beyond the seat cap, in the order they applied. |
| Entry rule | A minimum rank to enter or to captain. |
| Manager | An admin, or the host of the event in question. |
| Host | A member granted management of one event. |
| Draft | The auction where captains bid for players. |
| Lot | One player put up for auction in the draft. |
| Balance | The currency a captain has left to bid with. |
| Reserve pool | Players set aside during the draft to be auctioned again later. |
| Stage | One phase of an event's format, e.g. groups then playoff. |
| Match | Two teams meeting in a stage; a series of one or more maps. |
| Map | One round of play within a match, with its own score. Never called a "game" - Game means the catalogue entry. |
| Block | Matches that start at the same time on a day. |
| General availability | A member's usual weekly free times, independent of any event. |
| Announcement | A message posted to the Discord channel. |
| Notification | A message to one member, in the site and optionally by Discord DM. |
