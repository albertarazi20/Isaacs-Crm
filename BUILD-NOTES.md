# Build notes (running log for the Selective CRM build)

Owner's instruction 2026-11-15: build everything first, fix bugs at the end. This file lists what to come back to.

## Known test fallout to fix at the end
- **Date skew after 7pm Eastern**: tests that compute "today" in JS (EST) vs the test database (`current_date` in UTC) drift by one day past 19:00/20:00 ET. Affects funders-db, contact, streak, review-* tests. Pre-existing; not caused by the build. Fix: make `tests/helpers/db.ts` set the session time zone, or derive `t.today` in the same zone the SQL uses.
- **funders-rls.test.ts**: five assertions encode the old "one private lender list per user" rule. Since migration 0300 the lender list is shared (read by all, written by owner/manager). Rewrite those assertions: a user may *read* another user's lender and submit to it; they still cannot see another user's submissions, offers or timers.
- **funders-db.test.ts › stips requested … already due that soon**: submit_to_ops / the new set_submission_status leave two follow-ups in one case. Check whether `ensure_open_timer` double-creates when the stage move already made one.
- **Browser (e2e) suite**: 42 checks failed before the build started (Board drag-and-drop, Earnings, Winback, Today). Those pages are being replaced; rewrite the e2e files with the new pages.

## Decisions made while building
- Roles live on `app_users.role` ('rep' | 'ops' | 'manager'); managers see everything via `*_team` policies; ops see the ops queue and the merchant behind it via `app.is_ops_deal`.
- Deals are a new table on top of `clients`; submissions/offers/fundings get `deal_id` stamped by trigger so the old SQL functions keep working.
- Deal status is derived in SQL (`app.deal_status`), never stored.
- Decline reasons moved to a `decline_reasons` table with `curable_after_days` (drives Winback revive dates).
- **tests/send-engine.test.ts** (2 cases) fail only when run together with buckets-engine.test.ts: the worker test pins `now` to 2026-11-16 but `send_ledger.sent_at` defaults to the real `now()`, so the rolling-24h window and the per-merchant count drift. Fix: pass `now` through to the ledger insert (worker already has it) and seed `sent_at` explicitly in the cap test. Both pass in isolation.
- **tests/inbox-match.test.ts › 4. a known lender naming the business**: the funder-name rung should match "Offer for Mikes Pizza" to "Mike's Pizza LLC". Fix in `matchEmail`: strip apostrophes and legal suffixes before the includes() check (the `squash` helper), then re-run.
