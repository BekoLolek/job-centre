# Decision 002: How a running event's page stays current

**Date:** 2026-09-15
**Status:** Proposed (Gate 2)

## Context

UC-11's outcome: while an event is running its page keeps itself current without a reload
(R-45, R-46, R-47, R-77). Today public pages are `force-dynamic` and never refresh; only the
draft room updates live, by polling a server action every second (R-70), which works.

Fixed: Vercel Hobby functions (request/response, no long-lived process), Neon Postgres, tens
of concurrent viewers normally.

## Options

| | A: Poll while running | B: Server-Sent Events | C: Hosted realtime (Pusher / Ably) |
|---|---|---|---|
| **What it is** | Client calls `router.refresh()` every ~10 s, only while status is running and the tab is visible | A streaming route pushes changes | Writes publish to a third-party channel; pages subscribe |
| **Pros** | - ~20 lines, no new dependency<br>- Same pattern as the draft room<br>- Works with server components unchanged | - Push, not pull | - True push at any scale |
| **Cons** | - Up to ~10 s stale<br>- Each refresh is a DB read | - Functions time out, so streams reconnect constantly<br>- Needs cross-instance fan-out (Neon's pooled driver has no LISTEN over HTTP) | - New vendor, keys, client SDK<br>- Every write path must publish |
| **Effort to build** | Very low | High | Medium |
| **Effort to run** | None | Reconnect tuning | Another account |
| **Cost** | Neon compute while pages are open during an event | Same, plus function time | Free tier, then paid |
| **Lock-in** | None | None | Vendor SDK in every write path |
| **Already known / in repo** | Yes (draft room) | No | No |

## Recommendation

**A: Poll while running**, because a ten-second-old bracket satisfies R-77 for a community
watching on Discord, and it is the pattern already proven in the draft room.

## Decision

Pending approval at Gate 2.

## Consequences

- One small client component on the event page; nothing else changes.
- Polling stops when the event is not running or the tab is hidden, which bounds Neon compute to events actually being watched.
- If viewer counts ever make this expensive, C replaces the one component; nothing else depends on how refresh happens.
