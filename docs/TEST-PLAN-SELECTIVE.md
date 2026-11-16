# Selective CRM — formal test plan (pages and automations built 2026-11-15/16)

Written per CLAUDE.md step 4, before the manual pass. Run it, write every failure into `docs/ISSUES.md` under a dated
heading **without fixing while discovering**, then fix the list, then re-run. Every case says what must be true in the
**database**, not only on screen (step 6): check with `psql` against the dev database (`DATABASE_URL` in `.env.local`).
`docs/TEST-PLAN.md` still covers the legacy pages (Today, Pipeline, All merchants, Trash) and is not repeated here.

Setup: `pnpm db:migrate`, dev server on :3000 with `DEV_LOGIN=1` (launch config `mca-crm-dev`), sign in at
`/api/dev-login?email=<user>` — a seeded user keeps its role; `&role=rep|ops|manager` sets one. Three users: a **rep**,
an **ops**, a **manager**. The browser suite (`pnpm e2e`) already drives the happy paths marked _e2e_; the manual pass
spends its time on the edges and the role boundaries.

Legend: **DB** = verify the row. **Role** = repeat as the named role. **Both** = light and dark, and at 390px wide.

## A. Access, roles and navigation

| #   | Case                                                                                                                              | Expected                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A1  | Dev login as a seeded manager with no `role=`                                                                                     | Lands on Dashboard; nav shows Lead Intake, Follow Up, Submission Board, My Deals, Winback, Funded, Settings.   |
| A2  | Dev login `&role=rep`                                                                                                             | No Submission Board in nav; phone tabs Home / Intake / Follow / Deals / More. **DB** `app_users.role = 'rep'`. |
| A3  | Dev login `&role=ops`                                                                                                             | Nav: Dashboard, Submission Board, My Deals, Settings only.                                                     |
| A4  | **Role rep** opens `/board`, `/settings/team`, `/settings/plan` by URL                                                            | Refused or empty with a readable notice; no manager data rendered. **DB** nothing written.                     |
| A5  | **Role ops** opens `/deals/<id>` of a merchant with no queued/sent deal                                                           | Not found; **DB** untouched.                                                                                   |
| A6  | **Role rep** calls a manager action from the console (confirmFunding, setTeamMember, approveTemplate, createCanary, offboardUser) | Error text, not a stack; **DB** unchanged.                                                                     |
| A7  | Signed out: `/`, `/deals`, `/settings`                                                                                            | Redirect to `/login`. Public pages `/u/x`, `/upload/x`, `/d/x` do not redirect.                                |
| A8  | **Both**: each top-level page                                                                                                     | No horizontal scroll, text readable, buttons reachable at 390px; dark mode has no white panels.                |

## B. Dashboard

| #   | Case                                                         | Expected                                                                                                                                                     |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | _e2e_ Scoreboard with seeded data                            | Subs / approved / declined / funded / commission tiles match SQL counts for the month (**DB** compare).                                                      |
| B2  | Month switch: this month, last month, quarter                | Numbers change; "compare" shows deltas; an empty month shows zeros, not blanks or NaN.                                                                       |
| B3  | "Do this now" list                                           | One line per item kind (approval to pitch, stips asked, offer expiring, kickback, reply, contracts out); each button goes to the deal; list ranked by money. |
| B4  | Set a goal in Settings, come back                            | "N funded, M to go, K working days left" uses working days; pace line sane on the 1st and last day of a month.                                               |
| B5  | **Role manager** per-rep table, ops queue ages, lender board | Every rep listed including zero rows; **Role rep** sees only their own line.                                                                                 |
| B6  | Email meter                                                  | Sent-24h / cap per mailbox; with no mailbox rows the panel says so (no crash).                                                                               |
| B7  | Fresh database (no clients at all)                           | Dashboard renders with zeros and empty-state copy; no 500.                                                                                                   |

## C. Lead Intake

| #   | Case                                                      | Expected                                                                                                                              |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | _e2e_ Create a lead with name + phone + bucket            | Merchant created; enrolled in the bucket; welcome email queued. **DB** `clients` row, `enrollments` live row, `outbox` lane `intake`. |
| C2  | Phone typed with punctuation `(310) 555-0100`             | Stored normalised; duplicate check finds an existing merchant with the same digits.                                                   |
| C3  | Duplicate: a phone already on another rep's merchant      | Warning names the owner and the bucket; submit blocked or confirms; **DB** no second row.                                             |
| C4  | Phone matches a `sheet_rows` row                          | Form autofills business, name, email, state, revenue, phone2/email2, looking-for; **DB** `sheet_rows.filed_at` set after submit.      |
| C5  | State blank, phone 310                                    | **DB** `clients.timezone = America/Los_Angeles`, `timezone_source = area_code`; state FL → New_York / `state`.                        |
| C6  | Email on the shop suppression list (unsubscribed earlier) | Lead is created but no welcome email; notice says why. **DB** no `outbox` row.                                                        |
| C7  | Required fields missing (no name, no phone)               | Field-level errors, nothing saved.                                                                                                    |
| C8  | Second phone and second email, "looking for"              | **DB** `phone2`, `email2`, `looking_for` saved; shown on the deal page overview.                                                      |
| C9  | Bucket with no template at step 1                         | Lead created and enrolled; no email; no error.                                                                                        |

## D. Follow Up (buckets, sequences, blasts)

| #   | Case                                                                | Expected                                                                                                                |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| D1  | _e2e_ Bucket list with counts; open a bucket                        | Members listed with lead line (local time chip, age, last touch, next email, dots).                                     |
| D2  | Move a merchant to another bucket                                   | Old enrolment stopped (`stop_reason = moved`), new one live with step 1 due today-local. **DB** both rows.              |
| D3  | Pause / resume                                                      | `paused` flips; worker skips a paused enrolment (run `runBucketSteps` via the job route or script).                     |
| D4  | Remove from bucket                                                  | Enrolment stopped `removed`; merchant stays.                                                                            |
| D5  | New personal bucket, same name as a shared one                      | Allowed (owner differs); same name twice for the same owner refused with a message.                                     |
| D6  | Rep writes a template, tries to put it on a step                    | Allowed to save; engine will not auto-send it until a manager approves (`approved=false`); UI says "awaiting approval". |
| D7  | **Role manager** approves the template                              | **DB** `approved`, `approved_by`, `approved_at` set; the step now sends.                                                |
| D8  | Blast: pick bucket + template, uncheck two names, preview, send     | Preview shows merged fields; **DB** one `outbox` row per checked merchant, lane `blast`, none for unchecked.            |
| D9  | Blast when `postal_address` is empty in shop settings               | Refused with a CAN-SPAM message; **DB** no rows.                                                                        |
| D10 | Blast to a merchant already emailed today (sequence)                | Row queued but worker defers it (`per_merchant_cap`); gauge counts.                                                     |
| D11 | A reply recorded for an enrolled merchant (`record_merchant_reply`) | Enrolment stops `replied`; queued sequence rows cancelled; merchant floats to top with "Replied".                       |
| D12 | A stip ticked (document uploaded)                                   | Merchant re-buckets per `app.stips_bucket` (missing_app → missing_statements → … → ready_for_ops).                      |
| D13 | Cap gauge                                                           | Header shows sent/cap; at ≥ amber it turns amber; at cap bulk lanes defer, intake still sends.                          |

## E. Submission Board (ops / manager)

| #   | Case                                                                            | Expected                                                                                                                   |
| --- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| E1  | _e2e_ Rep submits a merchant to ops                                             | Deal `queued`; stage moves to Application in; **DB** `deals` row, timer "Ops is reviewing the file".                       |
| E2  | **Role ops** kicks back with a reason                                           | `ops_status = kicked_back`, `kickback_count = 1`, blocker text set; rep sees it on Dashboard and deal header.              |
| E3  | Rep resubmits                                                                   | Back to `queued`, count stays 1; activity "Resubmitted to ops".                                                            |
| E4  | Send to lenders: tick 3, note, send                                             | **DB** 3 `submissions` rows `sent` with `deal_id`, 3 chase timers, outbox/system lines; `ops_status = sent`.               |
| E5  | Send to more lenders than `max_lenders_per_deal`                                | Shotgun warning shown first; proceeding is possible and logged in activities.                                              |
| E6  | Same lender twice on one day                                                    | Refused: "Already sent to X on …"; **DB** unchanged.                                                                       |
| E7  | Filter chips                                                                    | Each chip's count equals the rows shown; "Needs pitch" appears after an approval with no presented offer.                  |
| E8  | Lender row status changes (stips requested → approved → contracts out → funded) | Deal status rolls up per `app.deal_status`; activities written; timers adjusted (stips → follow-up next business day).     |
| E9  | Decline with a reason                                                           | Reason from `decline_reasons`; when every lender declines → status `declined_by_all`; Winback picks it up when curable.    |
| E10 | Review tray: a proposed update (seed one in `proposed_updates`)                 | Apply → status applied, lender row changes, receipt shows the email; Reject → `rejected`, nothing else changes.            |
| E11 | Chase: a lender quiet past `lender_chase_days`                                  | Chase action available; `chase_count` increments, `last_chased_at` set; capped by `lender_chase_max`; off when mode `off`. |
| E12 | **Role rep** on `/board`                                                        | Not available (A4).                                                                                                        |

## F. My Deals and the deal page

| #   | Case                                                                                 | Expected                                                                                                                           |
| --- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| F1  | _e2e_ List filters (working, kicked back, pending, approved, funded, declined, dead) | Each filter shows the right deals; counts agree with the board's chips for the same user.                                          |
| F2  | Deal header                                                                          | Status, requested, revenue, time in business, positions, state, owner, one blocker line; no "undefined"/"NaN".                     |
| F3  | Documents: mint upload link, open `/upload/<token>` in a private window              | Page names the merchant and what is wanted; upload a PDF → auto-labelled; **DB** `documents` row, `stips` ticked, activity.        |
| F4  | Upload a non-PDF/non-image, or > size limit                                          | Refused with a message; **DB** no row.                                                                                             |
| F5  | Upload session older than 2h (edit `expires_at` in DB)                               | Page says the link expired; offers nothing else.                                                                                   |
| F6  | Relabel a document to another kind/month                                             | **DB** `label_by = human`, stips follow; freshness line updates ("Newest statement is …").                                         |
| F7  | Lender link: mint for lender X, open `/d/<token>`                                    | PDF downloads with the lender's name and date watermark; **DB** `document_links.downloads` +1, `document_views` row.               |
| F8  | Lender link past `max_downloads`, revoked, or expired                                | 410/404 with plain text; no file.                                                                                                  |
| F9  | Forward documents to a lender (checked docs + lender)                                | **DB** links minted (7 days, max 10, lender set), outbox email on the submission thread, status `stips_requested → sent`.          |
| F10 | Activity feed                                                                        | Timeline merges activities, emails, milestones; milestone chips present (submitted, approved, …); newest first.                    |
| F11 | Record an offer on a lender row                                                      | **DB** `offers` row with `deal_id`; deal → needs pitch; activity line with money formatting.                                       |
| F12 | Accept one of two offers, then undo                                                  | Other offer `declined` with `declined_by`; undo brings it back (`open`/`presented`).                                               |
| F13 | FUND (rep): propose with points above the lender's max upsell                        | Refused with the lender's cap in the message; **DB** no funding row.                                                               |
| F14 | FUND (rep): valid terms                                                              | **DB** `fundings` row with sell/buy/points/psf, `confirmed_at` null, `ledger_state = expected`; deal still open.                   |
| F15 | **Role rep** clicks Confirm                                                          | Refused "only a manager".                                                                                                          |
| F16 | **Role manager** confirms                                                            | **DB** `confirmed_at`, `rep_cut_cents`, `commission_ledger` expected line, deal `funded`, lender row `funded`, enrolments stopped. |
| F17 | FUND checklist for a FL merchant                                                     | PSF-before-closing item marked required; TX shows registration item.                                                               |
| F18 | Deal notes (rep / manager / ops)                                                     | Each role edits its own note field only; **DB** columns.                                                                           |

## G. Winback

| #   | Case                                                              | Expected                                                                                                         |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| G1  | _e2e_ Pools with counts; member rows                              | Five pools; each row shows reason, workable date, step, status.                                                  |
| G2  | Run `refresh_winback_pools()`                                     | An approval older than 30 days with an open deal joins `approved_unfunded`; a paid-off funding joins `paid_off`. |
| G3  | Member becomes workable (set `workable_on` to yesterday, refresh) | Status `waiting → active`, `next_due_on` set.                                                                    |
| G4  | Set status recovered / stopped from the row                       | **DB** status and `stop_reason`.                                                                                 |
| G5  | Merchant opts out                                                 | Membership `stopped (opted_out)` on next refresh; no winback email queued.                                       |
| G6  | Winback templates in Settings                                     | Edit the step templates; a step with no template skips without error.                                            |

## H. Funded

| #   | Case                                                  | Expected                                                                                                        |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| H1  | _e2e_ Sheet rows and totals                           | Every confirmed funding listed; totals (month, last month, YTD, lifetime, avg points, avg size) match SQL.      |
| H2  | Record commission paid (full, short, late)            | **DB** `commission_received_cents` accumulates, ledger `paid` line with the rep's split; status `paid`/`clear`. |
| H3  | Default inside the clawback window (`record_default`) | Trigger writes a `clawback` line (negative), `ledger_state = clawed_back`; month total corrects.                |
| H4  | Default after the window                              | No clawback line.                                                                                               |
| H5  | `roll_funding_clocks()`                               | Past-window paid fundings → `clear`; warm-up check-in and renewal timers created once, never twice.             |
| H6  | **Role rep**                                          | Sees only their own rows and cut; **Role manager** sees all with house cut.                                     |

## I. Settings

| #   | Case                                                                 | Expected                                                                                                             |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| I1  | Me: time zone, signature, application link                           | **DB** saved; an invalid link refused; the session zone follows (dates on Today shift).                              |
| I2  | Email: cap, amber, reserved, window, weekends, postal address        | Bounds enforced (cap 50–2000, window end > start); **DB** `shop_settings`.                                           |
| I3  | Email: `automation_from` blank vs set                                | Worker sends from the rep's Gmail vs Resend; UI explains which.                                                      |
| I4  | Lenders: add, edit appetite + caps, archive, delete with submissions | Delete refused when submissions exist (restrict FK); archive hides from send list; duplicate name refused shop-wide. |
| I5  | Team (manager): add rep/ops/manager; set role; disable               | **DB** rows; disabled login refused at dev-login; `session_epoch` bumped; access_log `team_change` lines.            |
| I6  | Team: demote or disable yourself                                     | Refused.                                                                                                             |
| I7  | Trust panel: copy a phone on a deal, then view the panel             | **DB** `access_log` `copy_phone`; panel shows it under the rep; after-hours flag when applicable.                    |
| I8  | Canary: plant one in a rep's book                                    | **DB** `clients.is_canary`; appears in the rep's lists like a real merchant; manager panel lists it.                 |
| I9  | Offboard a rep to another user                                       | **DB** rep inactive, epoch bumped, all per-user rows moved, activities "Reassigned …", report JSON in `access_log`.  |
| I10 | Plan: split, tiers JSON, PSF share, clawback borne by                | **DB** `commission_plans` row; invalid tier JSON refused; a confirm after the change uses the new split.             |
| I11 | AI: kill switch off                                                  | Inbox reader skips extraction (ai_runs none); tray empty with a notice.                                              |
| I12 | Sheets: connect without Google creds                                 | Clear message naming the owner step; **DB** no half row.                                                             |
| I13 | Buckets & templates page                                             | Sequence editor saves steps (day offsets ascending, actions email/call/move_to_cold); invalid order refused.         |

## J. Public pages and webhooks

| #   | Case                                                                 | Expected                                                                                                                                                            |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J1  | `/u/<token>` GET                                                     | Confirmation page naming the shop; POST (and the List-Unsubscribe one-click POST) → **DB** `email_opt_out`, suppression row, queued automation cancelled, activity. |
| J2  | `/u/<bad token>`                                                     | Plain not-found; no enumeration hint.                                                                                                                               |
| J3  | `/upload/<token>` after `files_received = max_files`                 | Refused with a message.                                                                                                                                             |
| J4  | `POST /api/webhooks/resend` unsigned, bad signature, stale timestamp | 401; **DB** no `webhook_events` row.                                                                                                                                |
| J5  | Signed bounce event twice (same `svix-id`)                           | First: outbox `bounced`, suppression, activity; second: 200 and nothing new (**DB** one `webhook_events` row).                                                      |
| J6  | Signed complaint                                                     | `opt_out(..., 'complaint')` path: flags + suppression + activity.                                                                                                   |
| J7  | `POST /api/leads` with a lead token                                  | Lead created on Today; cap per day (`lead_token_take_slot`); revoked token → 401.                                                                                   |
| J8  | `/api/dev-login` with `DEV_LOGIN` unset                              | 404.                                                                                                                                                                |

## K. Jobs (run through their entry points, not by hand in SQL)

| #   | Case                                                                  | Expected                                                                                     |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| K1  | Outbox worker (`drainOutbox`)                                         | Sends due rows in lane order; cap and per-merchant rules; ledger rows; `job_runs` heartbeat. |
| K2  | Bucket steps (`runBucketSteps`)                                       | Due steps → outbox rows / call timers / move to cold; sequences off → step 1 template daily. |
| K3  | Sheet loop                                                            | With no creds: records `last_error`, no crash.                                               |
| K4  | Inbox sync + reader                                                   | With no creds: records `last_error`; with the kill switch off: no `ai_runs`.                 |
| K5  | Clocks (`roll_funding_clocks`, `refresh_winback_pools`, offer expiry) | Idempotent on a second run (same counts, no duplicates).                                     |
| K6  | Digest / reply alerts (`reminders_sent`)                              | One row per user per day per kind; a retry sends nothing new.                                |

## L. Data and money invariants (SQL, after the pass)

- No client without an open timer except trashed ones: `select count(*) from clients c where not exists (select 1 from timers t where t.client_id = c.id and t.done_at is null) and not exists (select 1 from trashed_clients x where x.client_id = c.id)` = 0.
- Every confirmed funding has exactly one `expected` ledger line; every clawed-back one has one `clawback` line.
- No `outbox` row `sent` without a `send_ledger` row; no ledger row without a mailbox.
- Every `documents` row has a `stips` row for a stip kind; `document_links.downloads <= max_downloads`.
- `access_log` has a line for every copy, export, canary, team change and offboarding performed during the pass.
