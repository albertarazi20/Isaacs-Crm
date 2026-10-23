# Isaac — MCA follow-up CRM

A CRM for a merchant cash advance shop, built for one client. **The product is the follow-up:** every
client always has a next date (1 week out to 36 months), nobody ever leaves the system, and a dead
lead from 2024 is a warm call today.

**This repo has nothing to do with BH Violation Removal.** Separate repo, git history and database.

- `docs/DOMAIN.md` — the MCA model, the stages and their default timers, and what research did and did not confirm.
- `docs/DECISIONS.md` — why it is built this way (data handling, RLS, timers, Gmail, texting, reminders).
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

## Production

See `docs/DEPLOY.md` for the full checklist.

Hourly, call `GET /api/cron/reminders` with `Authorization: Bearer $CRON_SECRET` from any scheduler. It sends each
user one digest per day at their chosen hour.
