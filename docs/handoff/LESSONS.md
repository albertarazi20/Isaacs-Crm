# Lessons from the first build (real, with the fix)

| What happened                                                                                                                                                                              | What to do instead                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Every test passed but the type check was red: a test passed one argument too many, and tests do not type-check.                                                                            | Run every check (type check, lint, format, tests) before every push. `pnpm check` does it.                         |
| A test failed only on Mondays. The cron test sent the weekly scorecard for real that day.                                                                                                  | Tests must not touch the network or depend on the weekday or hour. Stub both.                                      |
| Tests failed between 8pm and midnight New York time (found by the second Claude thread). The tests compared against the database's UTC day while the app counts from Isaac's New York day. | Use the database's own idea of today in tests (`t.today`), and pass the user's time zone.                          |
| On Supabase a lookup table read as empty and deals silently stopped advancing. Supabase turns row-level security on for every new table.                                                   | Test on the host's real behavior. Compare the live schema to a clean local copy with `tools/fingerprint.sql`.      |
| CI failed on every push for days with no log. The free build minutes had been used up by another repository on the same account.                                                           | Open the job page and read GitHub's actual message before guessing.                                                |
| Claude guessed the rest of a commit hash; the merge was refused.                                                                                                                           | Never invent an id or a hash. Run the command that prints it.                                                      |
| A secret key was pasted into chat.                                                                                                                                                         | Treat it as exposed, replace it, enter the new value only in the host's settings.                                  |
| A connector could see every project in the account, including other clients'.                                                                                                              | One organization or team per client. Name-search for the one you need and leave the rest alone.                    |
| A confirmation prompt never reached the user, so database changes stalled for hours.                                                                                                       | Keep a manual fallback: build one SQL file, have the owner paste and run it, then verify.                          |
| The chosen free hosting plan did not allow business use.                                                                                                                                   | Read the plan's terms before building around it.                                                                   |
| A big import and a big backup could exceed a host's time or size limits.                                                                                                                   | Send big jobs in slices (the import now does 100 rows per call), stream big downloads, test with realistic volume. |
| A reviewer found real bugs every round (four review rounds plus a browser pass).                                                                                                           | Run a separate reviewer on every medium or large change, give it the diff, not your conclusion.                    |
| A session was cut off by a worker restart mid-task and local Postgres died.                                                                                                                | Restart it (`pg_ctlcluster 16 main start` on the first session's machine), and keep long jobs resumable.           |

## Process that worked

1. Tooling first; fix everything it reveals; never silence a rule.
2. Build a slice. Test the backend against a real Postgres and read the rows back.
3. Run a reviewer agent over the diff. Fix findings with tests that fail first.
4. Drive the browser (`pnpm e2e`) and write down every issue before fixing any.
5. Measure, do not assume: every number in a document names the command that produced it.
6. One branch and one pull request per change; merge when your checks are green.

## Traps in this codebase

- Next.js 16 differs from older versions: `params` and `searchParams` are Promises, `cookies()` is async. Read
  `node_modules/next/dist/docs/` before using a Next API (`AGENTS.md`).
- `withSystem` (owner connection, bypasses row-level security) may only be used in `src/app/api/**`, `src/lib/system/**` and
  `src/lib/db/**`. `tests/boundaries.test.ts` enforces it. Everything a user triggers goes through `withUser`.
- The `client_cards` view expands `c.*` when created, so any migration that adds a column to `clients` must drop and recreate the view
  (see `0250_reminder_channel.sql` for the pattern).
- `eslint-disable`, `@ts-ignore` and `@ts-nocheck` are grepped for by tests. Fix the cause instead.
- The dev database is Postgres on port 5433 (`isaac_dev`); a dev server runs on port 3000. `pnpm e2e` drives both.
