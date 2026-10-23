# Rules for every builder working in this repo

Read `CLAUDE.md`, `AGENTS.md` (Next 16 differs from your training data — read `node_modules/next/dist/docs/` before using
a Next API; `params`/`searchParams` are Promises, `cookies()` is async), `docs/DOMAIN.md`, `docs/DECISIONS.md`,
`docs/BACKLOG.md`. Several builders work in the SAME working tree at once, so ownership below is strict.

## Hard rules

- **Never disable a lint/TS rule** (no `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`). Tests grep for it.
- `react-hooks` lint forbids setState synchronously inside `useEffect`: render dialog bodies only when open and init state
  with `useState(() => …)`.
- **MCA language in every visible string**: advance/funding (never loan), factor rate (never interest), payback (never amount due),
  remittance (never payment/installment), funder (never lender), merchant (never borrower/customer), position, stips, term,
  commission points, renewal. `tests/language.test.ts` fails the build on violations.
- **Never store** SSN/EIN/DOB/card/bank-account numbers. Free text goes through the guard in `src/lib/data/sensitive.ts`
  (`findSensitive`); single-line fields must refuse control characters (see `line()` in `src/lib/data/schemas.ts`).
- **Every table with merchant data gets row-level security at creation**: policy `user_id = app.current_user_id()` for role
  `isaac_app`, composite FK `(client_id, user_id) → clients(id, user_id)`, grants only what the app needs, no SECURITY DEFINER,
  `set search_path = public, pg_temp` on every function. State changes that must be atomic live in SQL functions (invoker) that
  tests run against a real Postgres. Dates are `date`/ISODate strings; money is bigint cents; factor rate `numeric(5,3)`.
- A do-not-contact merchant (`contact_status` ≠ `ok`) must never be offered a call/text/email path: use `contactAllowed()` from
  `src/lib/mca/contact.ts` and reuse `<ContactActions>`.
- Do NOT run `pnpm build`. Do NOT `git commit/push/stash/checkout/reset` — the lead commits. Do NOT add dependencies.
- Before reporting: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` all clean (`npx prettier --write` your files).
  Keep the tree compiling as you go — others run typecheck concurrently.

## Ownership protocol

- Never edit migration `0001_init.sql` or `0002_*`. New tables/columns go in YOUR numbered migration file (given in your brief).
  Apply it to the dev DB: `DATABASE_URL=postgres://postgres@localhost:5433/isaac_dev pnpm -s db:migrate`. Do not recreate the
  `client_cards` view (ask the lead if you need a card field).
- Put your server actions in YOUR OWN `"use server"` file (copy the `run()` pattern from `src/app/actions.ts`; map errors with
  `toActionError` from `src/lib/data/errors.ts`). Put your schemas/queries/mutations in your own modules. Do NOT edit
  `src/app/actions.ts`, `src/lib/data/{schemas,mutations,queries,types,views}.ts`, `src/components/{ui,overlay,app-context}.tsx`
  unless your brief names the file.
- If you need a change in a file you don't own, finish everything else and put the exact change in your report.

## Verifying in a browser

A dev server is ALREADY running at http://localhost:3000 — never start another, never stop it. Use `playwright-core` (a
devDependency; chromium at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, launch with `args: ['--no-sandbox']`). Sign in as
your own isolated user: `http://localhost:3000/api/dev-login?email=<yourname>@example.com`, then seed it:
`cd /home/user/Isaac && DATABASE_URL=postgres://postgres@localhost:5433/isaac_dev pnpm -s db:seed <yourname>@example.com`
(51 demo merchants; RLS keeps users apart). Write your own `e2e/<feature>.e2e.mjs` (see `e2e/lib.mjs`, `e2e/contact.e2e.mjs`) that
drives the flows and asserts on DATABASE ROWS, and run it: `CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
DATABASE_URL=postgres://postgres@localhost:5433/isaac_dev pnpm -s e2e <feature>`. Take screenshots into
`/tmp/claude-0/-home-user-Isaac/17874b0e-83c6-5f06-8a6a-1bf11b991d45/scratchpad/<feature>/` and LOOK at them — light, dark
(`page.emulateMedia({colorScheme:'dark'})`) and 390px wide. Use the design tokens (bg-surface, text-muted, border-border, bg-good-soft…).

## Final report (under 40 lines)

Files created/edited; what you verified in the browser vs only by tests; what you could NOT do; changes needed in files you don't
own. Do not claim anything works unless you ran it.

## Trash (added with migration 0040)

A client moved to the trash is hidden from `client_cards` and has every timer closed. Read merchants through
`client_cards`, never `from clients` directly, unless you add `and not exists (select 1 from trashed_clients t where t.client_id = clients.id)`.
