# Decision 001: Rebuild in place, area by area, rather than rewrite

**Date:** 2026-09-15
**Status:** Proposed (Gate 2)

## Context

The user asked to "redo the whole site, including functionality, design". Gate 1 fixed the
spec (112 requirements, 27 use cases) and two constraints that decide this: production data
in Neon must survive intact, and jobcentre.vercel.app must keep working throughout.

A gap audit of UC-01 to UC-21 against the code found roughly half the use-case lines already
MET with tests, and the rest PARTIAL, MISSING or CONTRADICTS - concentrated in rules (archive
lock, approval entry, waitlist promotion, draft rule locking, host scoping) rather than in
the stack. The stack itself satisfies every requirement.

Already fixed and not reopened: Next.js 16 App Router, React 19, TypeScript, Tailwind 3,
Drizzle ORM, Neon Postgres (PGlite locally and in tests), Auth.js v5 with Discord, Vercel
Hobby, Vitest. None of these is a genuinely open choice.

## Options

| | A: Rebuild in place | B: Greenfield rewrite beside it | C: Design-only reskin |
|---|---|---|---|
| **What it is** | Keep repo, stack and data; each task brings one use case to spec, deleting untraceable code as it goes | New app, new schema, migrate data at cutover | Restyle pages; leave behaviour as is |
| **Pros** | - 1,807 tests keep guarding solved behaviour<br>- Every task deploys on its own<br>- No data migration event | - Clean slate, no legacy shapes<br>- Schema can follow the domain model exactly | - Fastest<br>- Lowest risk |
| **Cons** | - Some legacy names stay (`draft`/`live` statuses, `match_games`)<br>- Deletions need care | - Months with two apps<br>- One-shot migration of live data is the riskiest step in the whole redo<br>- Re-derives resolve-on-read, re-flow, draft concurrency | - Fails the requirement: CONTRADICTS findings (archive lock, host leak, broken Reopen) remain |
| **Effort to build** | Medium, spread over many small tasks | Very high | Low |
| **Effort to run** | None new | Two deployments until cutover | None new |
| **Lock-in** | None new | None new | None new |
| **Already known / in repo** | Yes | No | Yes |

## Recommendation

**A: Rebuild in place**, because it is the only option that satisfies the spec *and* both
Gate 1 constraints; B puts the live data at risk to buy tidier names, and C does not meet the
requirements.

## Decision

Pending approval at Gate 2.

## Consequences

- Each plan task is one use case (or one cross-cutting concern) brought to spec, with its own tests, deployable alone.
- Code, columns and settings no requirement asks for are deleted in the task that touches their area, listed at Gate 2 first.
- Legacy code names stay where renaming buys nothing (`draft`/`live` status values, `users`, `match_games`); the UI uses the glossary's names.
- Schema changes are additive-then-subtractive migrations, so a failed deploy never strands data.
