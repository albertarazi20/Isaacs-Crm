# Manual + browser test plan

Written before the pass, per CLAUDE.md step 4. Run it, write every failure into `docs/ISSUES.md`
**without fixing while discovering**, then fix the list, then re-run. Each case says what must be
true in the **database**, not just on screen (step 6) — check with `psql` against `isaac_dev`.

Setup: `pnpm db:migrate && pnpm db:seed isaac@example.com && DEV_LOGIN=1 pnpm dev`, sign in at `/api/dev-login`.

Legend: **DB** = verify the row. **Both** = verify in light _and_ dark mode and at 390px wide.

## A. Access and isolation

| #   | Case                                                                       | Expected                                                                        |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A1  | Open `/` signed out                                                        | Redirects to `/login`.                                                          |
| A2  | Open `/clients/<id of another user's client>`                              | 404, no data leaked. **DB** a second user's rows untouched.                     |
| A3  | Sign in with an email that has no account, or a disabled one (real Google) | "That Google account isn't allowed", no session cookie, no new `app_users` row. |
| A4  | Tamper with the session cookie                                             | Treated as signed out.                                                          |
| A5  | Production build: `/api/dev-login`                                         | 404.                                                                            |
| A6  | `/api/cron/reminders` with no / wrong bearer                               | 401. With right bearer and no Resend keys → 503 with a clear message.           |
| A7  | Call a server action from the console with another user's client id        | "That record no longer exists", **DB** unchanged.                               |

## B. Follow-up timers (the product)

| #   | Case                                                        | Expected                                                                                       |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| B1  | Add client via "+ Add client" with name only                | Created in _Name in_, timer +1 day. **DB** one open `follow_up`.                               |
| B2  | Pick each preset 1w … 36m in the timer picker               | Date shown matches; **DB** `due_on` equals it.                                                 |
| B3  | Type a custom date 37 months out                            | Rejected with a readable message; nothing saved.                                               |
| B4  | Snooze from Today by 1 month                                | Card leaves Overdue/Today; **DB** `due_on` moved.                                              |
| B5  | Drag a card into each follow-up column (Board → Follow-ups) | Date = today + that span. Overdue/Later are not drop targets.                                  |
| B6  | Move a client to each of the 23 stages                      | Each gets its default timer (see DOMAIN.md). No stage leaves the client without an open timer. |
| B7  | Move to Funded with terms                                   | **DB** funding row, payback = amount × factor; two timers: +30d check-in and renewal at 50%.   |
| B8  | Move to Lost with competitor term 180d                      | **DB** competing offer `won`; follow-up at +90d.                                               |
| B9  | Move to Workable default with a promise to pay              | **DB** funding `defaulted`, `defaulted_on`, `promise_to_pay_at` in Isaac's timezone.           |
| B10 | Client with a timer 14 months out                           | Appears on Long game, not in Today.                                                            |

## C. Contact and outcome capture

| #   | Case                                                          | Expected                                                                               |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| C1  | Call → "No answer" → Log it                                   | **DB** `call/no_answer` activity; timer reset to tomorrow; last-call note on the card. |
| C2  | Call → close the tab → reopen app                             | Outcome prompt is still waiting.                                                       |
| C3  | Text: dialog shows stage-aware template; "I sent it" → prompt | Prompt opens; logging sets the next date.                                              |
| C4  | Email without Gmail connected                                 | Offers "Connect Gmail" and "Open in Gmail instead"; no send attempted.                 |
| C5  | Email to a client with no address                             | Says so and links to the client page.                                                  |
| C6  | Phone with 3 digits                                           | Call/Text disabled.                                                                    |
| C7  | Settings → "Send me a test email" with Resend configured      | Email arrives with working client links. Without keys: clear "not set up" message.     |

## D. Client page

| #   | Case                                    | Expected                                                                                                                                                                                   |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Add a note; reload                      | Note persists, newest first.                                                                                                                                                               |
| D2  | Edit the ask twice                      | History shows both; card shows the newest. **DB** two `client_asks` rows.                                                                                                                  |
| D3  | Add 2 positions, edit one, delete one   | Rollup updates; **DB** matches.                                                                                                                                                            |
| D4  | Position with no payback                | Shows "add payback to see % paid down", never a made-up %.                                                                                                                                 |
| D5  | Log a competing offer; mark won         | **DB** row; insight line appears at 2+ offers.                                                                                                                                             |
| D6  | Start stip checklist; tick all required | "Ready to submit"; unticking one names the missing month.                                                                                                                                  |
| D7  | Funding card: enter collected-so-far    | Paydown uses the override and says it was entered by hand.                                                                                                                                 |
| D8  | Move a client to the trash              | Confirm dialog; **DB** in `trashed_clients`, every timer closed, history kept. Restore reopens the follow-ups. "Delete forever" only from the trash (never for a do-not-contact merchant). |

## E. Board

| #   | Case                                       | Expected                                               |
| --- | ------------------------------------------ | ------------------------------------------------------ |
| E1  | Drag a card between two stages; reload     | Stays. **DB** stage + timer changed.                   |
| E2  | Drag where the server rejects              | Card snaps back, error shown.                          |
| E3  | "Move to…" menu on a card (no drag)        | Same result as dragging.                               |
| E4  | Search + overdue-only + hide-empty filters | Counts correct; filters survive reload where promised. |
| E5  | 51 cards, then 2,000 cards                 | Drag stays smooth.                                     |
| E6  | Keyboard-only drag                         | Possible, with stage names announced.                  |

## F. Pages

| #   | Case                                       | Expected                                                |
| --- | ------------------------------------------ | ------------------------------------------------------- |
| F1  | Today KPI numbers                          | Match `select` counts from `client_cards`.              |
| F2  | Renewals at 50/60/70/80/90%                | List narrows monotonically; paid-in-full always listed. |
| F3  | Clients search by phone digits, DBA, email | Finds it.                                               |
| F4  | Every page at 390px wide                   | No horizontal scroll. **Both** themes legible.          |

## G. Reminders (job-level, DB-verified)

| #   | Case                                 | Expected                                 |
| --- | ------------------------------------ | ---------------------------------------- |
| G1  | Run job at 9am local with due timers | One digest; **DB** `reminders_sent` row. |
| G2  | Run again                            | Nothing sent.                            |
| G3  | Provider fails                       | No row; next run retries.                |
| G4  | Two runs at once                     | One email.                               |
| G5  | User in another timezone             | Waits for _their_ digest hour.           |

## H. Not testable without real credentials (say so in the report)

Google sign-in end to end, Gmail send, Resend delivery, Google Voice deep links.
Those have mocked-network unit tests only.

## I. Added during the build (each is covered by an automated test; the browser ones assert the database)

| #   | Area                                         | What must be true                                                                                                                                                                                                            | Where it is proven                                                                                             |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| I1  | Trash and restore                            | Hidden everywhere, no reminders; restore returns the follow-ups it closed; do-not-contact merchants stay on file; nothing can add timers to a trashed merchant                                                               | `tests/trash.test.ts`, `tests/review-fixes.test.ts`, `e2e/trash`                                               |
| I2  | Sign out of all devices                      | Every cookie dies on its next request; a deleted user's cookie dies                                                                                                                                                          | `tests/session-epoch.test.ts`, `e2e/session`                                                                   |
| I3  | Lead intake                                  | Token-only; plain-words refusals; duplicates become a note; do-not-contact never scheduled; 30/min; revoke is immediate                                                                                                      | `tests/leads-*.test.ts`, `e2e/leads`                                                                           |
| I4  | Instant new-lead alert, Monday scorecard     | One email per lead / per Monday; failed send rolls back; capped; off when the reminder switch is off; a disabled account (`active = false`) gets none, an active Team-added account gets them whatever `ALLOWED_EMAILS` says | `tests/lead-alert.test.ts`, `tests/weekly.test.ts`                                                             |
| I5  | Funders, submissions, offers, chase timers   | Fit check; chase survives a stage move inside the pipeline; accepting an offer pre-fills Funded and does not fund                                                                                                            | `tests/funders-*.test.ts`, `tests/chase-move.test.ts`, `e2e/funders`                                           |
| I6  | Earnings, renewals, editable terms           | Typo fix recomputes payback and ONLY the latest advance's renewal date; DB date equals TypeScript date                                                                                                                       | `tests/earnings-*.test.ts`, `e2e/earnings`                                                                     |
| I7  | Power dial, ranking, bulk reschedule         | Ranking never hides a merchant; bulk move is one transaction and keeps each reason; booked calls are appointments                                                                                                            | `tests/priority.test.ts`, `tests/power-*.test.ts`, `tests/booked.test.ts`, `e2e/power`                         |
| I8  | Win-back, snippets, note hints, calendar     | Limited merchants excluded; hints change nothing without a tap; unfilled `{fields}` block a send                                                                                                                             | `tests/winback*.test.ts`, `tests/notehints.test.ts`, `e2e/winback`, `e2e/text-guard`                           |
| I9  | Reports, filters, export, import with source | Numbers equal the database; trash excluded; CSV formula-safe; a secret in a sheet is dropped from the row, not the file                                                                                                      | `tests/reports*.test.ts`, `tests/client-filters.test.ts`, `tests/export.test.ts`, `e2e/reports`, `e2e/clients` |
| I10 | Secrets (SSN, card, account, tax ID)         | Refused in notes AND every one-line field, with or without dashes                                                                                                                                                            | `tests/sensitive.test.ts`                                                                                      |
| I11 | Production build                             | 15 pages and the dialogs open with zero CSP violations; `/api/dev-login` is 404; exports 401 without a session; cron 401/503; leads survive a failing Resend                                                                 | `scripts/bench/pages.mjs` for speed; the smoke is recorded in `docs/DECISIONS.md`                              |
| I12 | Performance at 5,000 merchants               | See `docs/DECISIONS.md` ("performance at 5,000 merchants") — commands next to the numbers                                                                                                                                    | `scripts/bench/*`                                                                                              |

| I13 | Merge, backup, restore | Merge moves every child and keeps the earlier date, a stop wins; a backup is one snapshot with nothing that can act on an account; restore round-trips every table | `tests/merge.test.ts`, `tests/backup.test.ts`, `tests/restore.test.ts`, `e2e/backup` |
| I14 | Fourth review, QA pass | Each finding in `docs/REVIEW-4.md` and `docs/ISSUES.md` has a test that fails without its fix | `tests/review-3a.test.ts`, `tests/review-4.test.ts`, `tests/qa-fixes.test.ts`, `e2e/board`, `e2e/client` |

## Run log (2026-10-23, this machine)

Each number comes from the command next to it.

| What                                | Command                                                                    | Result                                               |
| ----------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------- |
| Unit and database tests             | `pnpm -s vitest run`                                                       | 69 files, 1,562 tests passed                         |
| Types, lint, format                 | `pnpm -s tsc --noEmit`, `pnpm -s eslint .`, `pnpm -s prettier --check ...` | clean, 0 warnings                                    |
| Browser tests (dev server, real DB) | `CHROMIUM_PATH=... pnpm -s e2e`                                            | 19 files, 765 of 765 checks, exit 0                  |
| Production build and smoke          | `scratchpad/prod-rebuild.sh`, `scratchpad/prod-smoke.mjs`                  | 15 of 15 pages, 0 console problems, 0 CSP violations |

Not run here: CI (GitHub does not start the jobs; billing), real Google/Resend/Voice, a real phone.

## J. Still manual (cannot be proven from here)

Real Google sign-in and Gmail send; real Resend delivery (digest, call heads-up, new-lead alert, scorecard); the hourly
scheduler calling the cron route; a phone opening `sms:` / Google Voice; installing the app on a phone; push is not built.
