# Isaac (MCA CRM) — working rules

## READ FIRST: this repo is isaac-work, a separate copy

This repository (`github.com/albertarazi20/isaac-work`, local clone `~/isaac-work`) was started from Ronny's Isaac codebase on 2026-11-15. It is a
**different deployment with its own database**:

- **Our database:** Supabase project `aztoxzcmnvqaypjuuuwj` (org "MCA CRM", us-east-1). Every Supabase call passes this `project_id`.
- **Never touch Isaac's live systems:** Supabase project `vngxqywqqdmucvcdjfec` and the Netlify site `mca123`. The docs under
  `docs/` and `docs/handoff/` were written for that deployment; read their project IDs, site names and counts (e.g. "31 migrations",
  "24 clients") as Isaac's, not ours.
- Our Netlify (or other host) site does not exist yet.

## What this is

A CRM for a **merchant cash advance (MCA)** shop. One client: a friend of the owner.
The CRM is built and live; `docs/handoff/STATE.md` says where it stands and `docs/DOMAIN.md` has the original model.

## New to this repo? Start here

Read `docs/handoff/README.md` first. It holds the current state, the next steps, the MCA business knowledge, how the owner works, and
the database facts. This file holds the rules that never change.

## Hard separation from BH

This repo is **not** BH Violation Removal. Do not import from, copy out of, deploy to, or read
anything under `~/Code/bh-*`. Different business, different client, different database. If a
pattern from BH is genuinely worth reusing, re-type it here on purpose — never symlink or share.

## Build order (the owner's standing rule, from his uncle — applies to every repo)

1. **Tooling before code.** Get typecheck + lint + format actually running first. Correct tooling
   is what makes the code-specific bugs visible.
2. **Fix everything it reveals. NEVER disable a rule to get green.** A silenced rule is a bug you
   have agreed not to see. This is the hard line.
3. Only once green: **unit-test the backend — db + api**, then every external integration.
4. **Write a formal test plan**, run it manually, write down every issue. Collect first, do not fix
   while discovering.
5. Fix that list, then drive the browser to confirm the frontend passes.
6. **A backend test must prove the DB really changed** — not that the call returned 200.
7. Re-run the manual tests after the fixes.

Stack: **standard ESLint + Prettier.** No oxlint, no biome.

## CI costs money

Free tier is 2,000 GitHub Actions minutes. **CI runs unit tests + a real build. Nothing else.**
Browser/frontend tests run locally, never in CI.

## Money and personal data — decide before storing, not after

An MCA CRM handles bank statements, owner identity and funding terms. Before any field that holds
one of these exists in the schema, decide and write down where it lives and who can read it:

- **Never store** full bank credentials, or card numbers.
- **SSN / EIN:** if the business genuinely needs it, store last-4 only unless the client states a
  legal reason for the full value, and record that reason in `docs/DECISIONS.md`.
- **Bank statements** are documents, not columns. Keep them in object storage behind an
  authenticated URL, never inline in a table, never in git.
- Any table holding merchant or owner data gets row-level security from the day it is created.

## Working style

- Edit surgically. Never reprint a whole file to change a few lines.
- Terse on simple things, full depth on hard ones.
- Measure, do not assume. If a number goes in a doc, the command that produced it goes next to it.
- Never call something done without running it.
