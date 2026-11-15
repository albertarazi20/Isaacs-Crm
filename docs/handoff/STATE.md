# State of the project (2026-11-15)

Everything here was measured on 2026-11-15 unless marked **unverified**. The command that produced each number is next to it.

## Code

- Repo `ronny-arch/Isaac`, branch `main`, head `13d0902` (2026-10-29). Git history: `git log --oneline | wc -l` gave 86.
- Nine pull requests merged, all by Claude sessions, none by hand:
  1. The whole first build (75 commits): Today, Board, Clients, client page, funders, offers, earnings, reminders, import,
     backup, 26 migrations.
  2. Netlify prep: the merchant import goes up in slices of 100 rows; `netlify.toml` pins Node 22.
  3. **Passcode sign-in** as an alternative to Google (`ACCESS_PASSCODE`).
  4. Premium look; short stage list; call/text/email reminders.
  5. **Seven-stage list.**
  6. A button that turns on browser notifications for reminders.
  7. Earnings page: a "$4k a month" goal banner with a photo (Ronny's request).
  8. Time-of-day picker in 30-minute steps for reminders, follow-ups and new clients.
  9. Board follow-up menu with time options; cards show last talked and next call with the time.
     Pull requests 3 to 9 were written by a different Claude thread (branches `claude/project-thread-hg5937*`), after the
     first session stopped. Read `git log` and the pull request descriptions for detail.
- Checks on `main` today: `pnpm typecheck` clean, `pnpm lint` clean, `pnpm format:check` clean,
  `TEST_DATABASE_URL=... pnpm vitest run` gave **78 files, 1,604 tests, all passing**, on a non-superuser Postgres 16 (CI uses the
  `postgres` superuser; either works).
- Browser tests (`pnpm e2e`) were last run in full on 2026-10-25 (19 files, 765 of 765 checks) **before** pull requests
  3 to 9. They have **not** been re-run since. Treat the board, Today and client page as unverified in a browser.
- GitHub Actions CI: on 2026-10-23 to 26 every run failed to start. The job annotation said "recent account payments have failed
  or your spending limit needs to be increased", and the Billing page showed the free minutes had been used up by a different
  repository on the same account. **On 2026-11-15 it runs again**: the `check` job on pull request 10 (run 43769572141, commit
  `5586d8f`) started and finished green in about 2.5 minutes (typecheck, lint, format, unit tests, real build). The free allowance
  resets monthly; another repository on the account can use it up again. Read the job's own message if it ever dies in seconds.
- Netlify built the same commit as a deploy preview (`https://deploy-preview-10--mca123.netlify.app`) and reported ready, so the
  Netlify build of this repo works as of that commit.

## The stage list (changed since the first build)

The database still has all 23 stage keys, so no history was rewritten. The app shows seven (`CORE_STAGES` in
`src/lib/mca/stages.ts`): Interested, Application in, Offers in, Funded, Workable default, Bad default, and Trash
(key `dead`). `FOLDS_INTO` in the same file (use the exported `foldStage`) says where each retired stage shows up. Labels are set by migrations 0240
and 0280. `docs/DOMAIN.md` still describes the original 23-stage design.

## Database (Supabase)

- Project ref `vngxqywqqdmucvcdjfec`, region us-east-1, Postgres 17.11. Details and method in `SUPABASE.md`.
- **31 of 31 migrations applied** (0001 to 0280). Check:
  `select count(*), max(name) from schema_migrations` returned `31, 0280_trash_stage.sql`.
- Schema fingerprints of the live project (the 10 rows from `tools/fingerprint.sql` plus the migration list) **equal** a fresh local migrate of the same 31 files.
  Method and numbers in `SUPABASE.md`.
- Live data: 1 user and 24 clients (`select count(*) from app_users`, `... from clients`). Whether these are demo rows or
  Isaac's real merchants is **unknown to this session**. Ask the owner before deleting or importing anything.

## Hosting and live site

- **Netlify project `mca123`** (id `84d887a3-4d06-493a-a0ae-b804db141936`) is connected to this repository. Found on 2026-11-15
  because its bot commented a deploy preview on pull request 10. A name search for "isaac" or "crm" does **not** find it, so
  search for "mca" or "mca123".
- Production URL `https://mca123.netlify.app` (the connector lists `http://mca123.netlify.app`; the https one is the one to use).
  The production deploy `6ae38ee4247680336637e83a` was in state `ready`. No site password and no SSO on it. Plan code `nf_team_dev`.
- The same Netlify team holds other businesses' sites. Leave them alone.
- **Not checked**: whether sign-in works, which environment variables are set (names or values were not read on purpose), whether
  the hourly scheduler is configured, and whether Isaac is using it. The first session's machine cannot reach `netlify.app`
  (its network proxy refused the host), so `node scripts/smoke-live.mjs https://mca123.netlify.app` was **not** run. Run it first.
- Environment variable names and where each value comes from: `docs/DEPLOY.md` section 3. Nothing secret is in git.

## Email

- Resend sends reminders (morning digest, call heads-up, new-lead alert, Monday scorecard). Gmail sends as Isaac.
- **A Resend API key was pasted into the chat on 2026-11-12.** It is exposed. It is not in the repo or in this folder. It
  must be deleted in Resend and replaced before use, and the new one typed straight into the host's settings.
- Which Resend account made that key is **unconfirmed**. If it is the owner's BH account, do not use it: Isaac needs his own.
- Sender: with no verified domain use `onboarding@resend.dev`, which (from memory, unverified) only delivers to the email
  the Resend account was created with.

## People and boundaries

- Ronny: owner and builder, the person you talk to.
- Isaac: the broker. Never message him as if he were the owner.
- David (a "smart suit replacement" CRM) and BH Violation Removal are separate Claude sessions and separate businesses.
  Do not read their repos, databases or sessions.

## Open risks

- **Passcode sign-in** (`src/app/api/auth/passcode/route.ts`) has only a one-second delay on a wrong passcode and no rate limit, and one
  shared passcode gives full access. Whether `ACCESS_PASSCODE` is set on the public `mca123` site is **unknown**. Treat a short or
  guessable passcode as a real risk; add a rate limit.
- Supabase security advisor (run 2026-11-15, type security): see `SUPABASE.md`. Two app functions have a mutable
  `search_path` (easy fix, listed in `NEXT-STEPS.md`).
- TLS to the database is encrypted but not verified (`?sslmode=no-verify`). Pinning Supabase's CA is a backlog item.
- The full backup is one JSON file: 18.7 MB at 3,000 merchants and 30,000 notes. Close to a 20 MB streamed-response cap
  that sources attribute to Netlify (unconfirmed). Compress it if a live deploy shows trouble.
