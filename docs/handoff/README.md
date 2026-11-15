# Handoff: Isaac's MCA CRM

Read this first if you are a new Claude picking up the build. It is the one folder that holds what the first Claude
session knew. Written 2026-11-15. The first session built v1 (Oct 20 to 26, 2026). A second Claude thread then merged pull
requests 3 to 9 (Oct 26 to 29). This handoff was written afterwards, from the repository, the live database and the first
session's memory.

## The project in five lines

- A follow-up CRM for **Isaac**, who brokers merchant cash advances (MCA). One client, one database, one codebase.
- The owner and builder is **Ronny** (the user). Isaac is his friend and the end user.
- The product is timers: every client always has a next date, and nobody leaves the system. The notes are the product.
- Stack: Next.js 16, React 19, TypeScript, Postgres (Supabase), Resend for email, Google sign-in and Gmail send.
- Code: `github.com/ronny-arch/Isaac` (private), default branch `main`. Database: a Supabase project (see `SUPABASE.md`).

## Hard rules (never break these)

1. **This is not BH Violation Removal and not David's CRM.** Never read, copy from, deploy to or share anything with them.
   Different business, different client, different database. If a Netlify, Supabase or GitHub account shows other
   projects, name-search for the one you need and leave the rest alone.
2. **Tooling before code. Never disable a lint rule to get green.** The rules are in `CLAUDE.md` at the repo root.
3. **A backend test must prove the database changed**, not that a call returned 200.
4. **Never paste or store a secret.** Keys live in the host's environment settings only. If one reaches chat, treat it as
   exposed and have it replaced.
5. **Never call something done without running it.** Say "unverified" when you could not check.

## Before you touch production (do these in this order)

Merging to `main` deploys: the Netlify site `mca123` is connected to this repository and has **no password**. The live database
may hold Isaac's real merchants (24 clients on 2026-11-15; unconfirmed whether they are real).

1. Get the owner's OK for anything that changes the live database or the live site's behavior.
2. Have a backup first (Settings, then Your data, then Download a full backup; `docs/BACKUP.md` has the restore).
3. Prove the change locally, against a database that has every migration, with `pnpm check`.
4. If it has a migration, **apply the migration to the live database first**, then merge the code that needs it. Never the reverse.
5. Merge. Then run `node scripts/smoke-live.mjs https://mca123.netlify.app` and read the result.

On the live database: always pass `project_id` `vngxqywqqdmucvcdjfec`, check `select count(*) from schema_migrations` first (31 on
2026-11-15), and never use the connector's `apply_migration` (it writes Supabase's own migration table, not `schema_migrations`, so
the runner and the fingerprint check drift). Details and the paste method: `SUPABASE.md`.

## Where to look

| File                         | What it holds                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `STATE.md`                   | What is true today: measured numbers, what is live, what is not, open risks                         |
| `NEXT-STEPS.md`              | The ordered to-do list for you, and what only the owner can do                                      |
| `MCA-KNOWLEDGE.md`           | The MCA business, the rules Isaac works by, and where each rule lives in the code                   |
| `OWNER-AND-WORKING-STYLE.md` | How Ronny works and what he expects from Claude                                                     |
| `SUPABASE.md`                | The database project, how migrations are applied and verified, advisor findings                     |
| `LESSONS.md`                 | Real mistakes and what to do instead                                                                |
| `KICKOFF-PROMPT.md`          | The message to paste into a new Claude to start it on this folder                                   |
| `tools/`                     | `fingerprint.sql` (compare two databases), `make-paste-sql.sh` (build a paste-ready migration file) |
| `schema/`                    | The full schema as SQL, generated from migrations 0001 to 0280                                      |
| `artifacts/`                 | The owner's finish list (HTML) as last published                                                    |

Older, deeper docs live one level up in `docs/`: `DOMAIN.md` (the business model), `DECISIONS.md` (why things are built
the way they are), `DEPLOY.md`, `OWNER-TODO.md`, `BACKLOG.md`, `TEST-PLAN.md`, `ISSUES.md`, `REVIEW-*.md`, `BACKUP.md`,
`LEAD-INTAKE.md`, `REQUIREMENTS.md`, `CREW-RULES.md`.

## Stale files (do not trust their numbers; this folder is current)

- `docs/DOMAIN.md`, `docs/REQUIREMENTS.md` and the root `README.md` describe the original 23 stages. The board shows seven now.
- `docs/OWNER-TODO.md` and `docs/DEPLOY.md` were refreshed on 2026-11-15 for counts and merged pull requests, but written before the
  Netlify site existed: step 2 in OWNER-TODO is already done.
- `artifacts/finish-list.html` says "26 of 26 migrations", "73 test files, 1,581 tests" and "Create the Netlify site". All stale.

## Local setup (about ten minutes)

Any Postgres 15 or newer works; it need not be a superuser (the first session tested on a non-superuser Postgres 16; CI uses the
`postgres` superuser). The root `README.md` "Run it locally" has the same steps.

```
createdb isaac_dev                    # or any name; point DATABASE_URL at it
cp .env.example .env.local            # set DATABASE_URL, SESSION_SECRET (32+ characters), DEV_LOGIN=1
pnpm install
pnpm db:migrate                       # applies db/migrations in name order
pnpm db:seed isaac@example.com        # 51 demo merchants, localhost databases only
pnpm dev                              # http://localhost:3000, DEV_LOGIN=1 skips Google
```

- **Unit and database tests** (`pnpm check`, `pnpm test`): each file creates and drops its own database. They look for Postgres at
  `TEST_DATABASE_URL`, default `postgres://postgres@localhost:5433/postgres`. Set it if yours is elsewhere.
- **Browser tests** (`pnpm e2e`, or one file: `pnpm e2e funders`): need `pnpm dev` running, `DEV_LOGIN=1`, a migrated and seeded
  **localhost** database, and `CHROMIUM_PATH` if Chromium is not found (on the first session's machine
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`). They run locally only, never in CI.
- **CI** (`.github/workflows/ci.yml`) runs typecheck, lint, format check, the unit and database tests, and a real build. `CLAUDE.md`
  says CI should run unit tests and a real build only; the extra three were the first session's addition, and whether to drop them is
  an open owner decision (`docs/OWNER-TODO.md` section C).

## How the first session worked (copy this)

Build in slices. After each slice run the checks, then ask a **separate reviewer agent** to hunt for bugs in the diff
(give it the code, not your conclusion), fix what it finds with tests, and only then push. One branch and one pull
request per change. The owner has said merging pull requests is Claude's job, so merge your own once the checks you
ran are green, and tell him plainly when a check could not run. Anything that touches the live database or the live site follows
"Before you touch production" above, with his OK first (see `docs/DECISIONS.md`, "Delegation").
