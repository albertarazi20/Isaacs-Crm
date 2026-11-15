# Isaac — MCA follow-up CRM

A CRM for a merchant cash advance shop, built for one client. **The product is the follow-up:** every
client always has a next date (1 week out to 36 months), nobody ever leaves the system, and a dead
lead from 2024 is a warm call today.

**This repo has nothing to do with BH Violation Removal.** Separate repo, git history and database.

## What it does

- **Today:** who to call, ranked by dollars at stake; start a **power dial** through the list; ⌘K finds anyone
  (and looks up an inbound caller by number); a follow-up streak; bulk "reschedule all overdue".
- **Board:** drag a merchant between the MCA stages (23 keys in the database, seven shown on the board) or between follow-up buckets (1 week → 36 months). Every
  stage has a timer; nobody ever leaves the system.
- **Client page:** notes on everything, last call / last follow-up / next follow-up, what he wants and what
  funders would approve, other advances (positions), competing offers, stips checklist, submissions to funders,
  funded advance terms (editable), do-not-contact status.
- **Funders:** send a merchant to several funders, chase the silent ones, record offers, accept one into the Funded dialog.
- **Money:** earnings (commission received and expected), renewal radar, price book, and **reports** (follow-ups
  done on time, funnel, where deals ended, lead-source results).
- **Win-back** batches from dead / declined / lost with reason-aware texts; saved snippets; add-to-calendar.
- **Reminders:** morning email digest, call heads-up, instant new-lead alert, Monday scorecard (Resend);
  send email as Isaac through his Gmail (Google OAuth); texting opens his phone / Google Voice (no SMS API).
- **Lead intake:** `POST /api/leads` puts a new merchant on Today as "call now" (`docs/LEAD-INTAKE.md`).
- **Backup:** Settings → Your data downloads everything as one JSON file; `scripts/restore-backup.ts` puts it back (`docs/BACKUP.md`).
- CSV import and export, trash with restore, sign out of all devices, installable on a phone.

## Where things are

- **New Claude? Start with `docs/handoff/README.md`.**
- `docs/OWNER-TODO.md` — only the things a human must do. `docs/BACKLOG.md` — the work queue and what is next.
- `docs/DOMAIN.md` — the MCA model, the stages and their default timers, and what research did and did not confirm.
- `docs/DECISIONS.md` — why it is built this way (data handling, RLS, timers, Gmail, texting, reminders).
- `docs/REQUIREMENTS.md` — every ask from the owner, mapped to what is proven. `docs/TEST-PLAN.md`, `docs/ISSUES.md`.
- `docs/DEPLOY.md`, `docs/LEAD-INTAKE.md`, `docs/BACKUP.md`, `docs/CREW-RULES.md` (how the parallel builders were kept apart), `docs/REVIEW-*.md`.
- `db/migrations/` — Postgres schema, row-level security and the SQL functions that move clients.
- `src/lib/mca/` — pure domain logic (stages, timers, renewal math, stips). `src/lib/data/` — queries, mutations, schemas.

## Run it locally

```sh
cp .env.example .env.local        # fill DATABASE_URL, SESSION_SECRET; set DEV_LOGIN=1 to skip Google
pnpm install
pnpm db:migrate                   # applies db/migrations to DATABASE_URL
pnpm db:seed isaac@example.com    # optional: 51 demo merchants (localhost databases only)
pnpm dev
```

## Checks

`pnpm check` runs typecheck, lint, format check and the tests. Database tests need a Postgres:
`TEST_DATABASE_URL` (default `postgres://postgres@localhost:5433/postgres`) — each test file creates and
drops its own database.

`pnpm e2e` drives the real app in a browser and asserts the database changed (needs `pnpm dev`, `DEV_LOGIN=1`, a
localhost `DATABASE_URL`, and `CHROMIUM_PATH` if Chromium isn't found). `pnpm e2e funders` runs one file. Browser
tests run locally, never in CI (CI runs typecheck, lint, format, the unit/DB tests, and a real build).

## Production

See `docs/DEPLOY.md` for the full checklist.

Hourly, call `GET /api/cron/reminders` with `Authorization: Bearer $CRON_SECRET` from any scheduler. It sends each
user one digest per day at their chosen hour.
