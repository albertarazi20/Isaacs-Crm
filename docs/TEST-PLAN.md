# Manual + browser test plan

Written before the pass, per CLAUDE.md step 4. Run it, write every failure into `docs/ISSUES.md`
**without fixing while discovering**, then fix the list, then re-run. Each case says what must be
true in the **database**, not just on screen (step 6) — check with `psql` against `isaac_dev`.

Setup: `pnpm db:migrate && pnpm db:seed isaac@example.com && DEV_LOGIN=1 pnpm dev`, sign in at `/api/dev-login`.

Legend: **DB** = verify the row. **Both** = verify in light _and_ dark mode and at 390px wide.

## A. Access and isolation

| #   | Case                                                                | Expected                                                                    |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A1  | Open `/` signed out                                                 | Redirects to `/login`.                                                      |
| A2  | Open `/clients/<id of another user's client>`                       | 404, no data leaked. **DB** a second user's rows untouched.                 |
| A3  | Sign in with an email not in `ALLOWED_EMAILS` (real Google)         | "That Google account isn't allowed", no session cookie, no `app_users` row. |
| A4  | Tamper with the session cookie                                      | Treated as signed out.                                                      |
| A5  | Production build: `/api/dev-login`                                  | 404.                                                                        |
| A6  | `/api/cron/reminders` with no / wrong bearer                        | 401. With right bearer and no Resend keys → 503 with a clear message.       |
| A7  | Call a server action from the console with another user's client id | "That record no longer exists", **DB** unchanged.                           |

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

| #   | Case                                    | Expected                                                                  |
| --- | --------------------------------------- | ------------------------------------------------------------------------- |
| D1  | Add a note; reload                      | Note persists, newest first.                                              |
| D2  | Edit the ask twice                      | History shows both; card shows the newest. **DB** two `client_asks` rows. |
| D3  | Add 2 positions, edit one, delete one   | Rollup updates; **DB** matches.                                           |
| D4  | Position with no payback                | Shows "add payback to see % paid down", never a made-up %.                |
| D5  | Log a competing offer; mark won         | **DB** row; insight line appears at 2+ offers.                            |
| D6  | Start stip checklist; tick all required | "Ready to submit"; unticking one names the missing month.                 |
| D7  | Funding card: enter collected-so-far    | Paydown uses the override and says it was entered by hand.                |
| D8  | Delete client                           | Confirm dialog; **DB** client, timers, notes, stips all gone.             |

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
