# Build notes (running log for the Selective CRM build)

Owner's instruction 2026-11-15: build everything first, fix bugs at the end. This file lists what to come back to.

## Known test fallout to fix at the end

- **Date skew after 7pm Eastern**: tests that compute "today" in JS (EST) vs the test database (`current_date` in UTC) drift by one day past 19:00/20:00 ET. Affects funders-db, contact, streak, review-* tests. Pre-existing; not caused by the build. Fix: make `tests/helpers/db.ts` set the session time zone, or derive `t.today` in the same zone the SQL uses.
- **funders-rls.test.ts**: five assertions encode the old "one private lender list per user" rule. Since migration 0300 the lender list is shared (read by all, written by owner/manager). Rewrite those assertions: a user may _read_ another user's lender and submit to it; they still cannot see another user's submissions, offers or timers.
- **funders-db.test.ts › stips requested … already due that soon**: submit_to_ops / the new set_submission_status leave two follow-ups in one case. Check whether `ensure_open_timer` double-creates when the stage move already made one.
- **Browser (e2e) suite**: 42 checks failed before the build started (Board drag-and-drop, Earnings, Winback, Today). Those pages are being replaced; rewrite the e2e files with the new pages.

## Decisions made while building

- Roles live on `app_users.role` ('rep' | 'ops' | 'manager'); managers see everything via `*_team` policies; ops see the ops queue and the merchant behind it via `app.is_ops_deal`.
- Deals are a new table on top of `clients`; submissions/offers/fundings get `deal_id` stamped by trigger so the old SQL functions keep working.
- Deal status is derived in SQL (`app.deal_status`), never stored.
- Decline reasons moved to a `decline_reasons` table with `curable_after_days` (drives Winback revive dates).
- **tests/send-engine.test.ts** (2 cases) fail only when run together with buckets-engine.test.ts: the worker test pins `now` to 2026-11-16 but `send_ledger.sent_at` defaults to the real `now()`, so the rolling-24h window and the per-merchant count drift. Fix: pass `now` through to the ledger insert (worker already has it) and seed `sent_at` explicitly in the cap test. Both pass in isolation.
- **tests/inbox-match.test.ts › 4. a known lender naming the business**: the funder-name rung should match "Offer for Mikes Pizza" to "Mike's Pizza LLC". Fix in `matchEmail`: strip apostrophes and legal suffixes before the includes() check (the `squash` helper), then re-run.

## Boundaries: token-table reads outside src/lib/system (found 2026-11-15, documents block)

`tests/boundaries.test.ts` "never writes raw SQL against token or reminder tables outside src/lib/system" fails on
`lib/inbox/sync.ts`, `lib/send/worker.ts`, `lib/sheets/sync.ts`: each reads `gmail_connections` for a refresh token
(`productionMailTokenFor`, `productionTokenFor`, the worker's Gmail lookup). Fix at the end of the build: move those
reads into `src/lib/system/gmail.ts` helpers and import them. Not an allow-list rule — do not weaken the test.
The system-connection rule was handled properly: the job modules are registered by name in the test with a reason each.

## Status at the end of the automation pass (2026-11-15, late)

Built and unit-tested, pages still to come (owner: pages last):

- Roles (rep / ops / manager), deals + ops loop, send engine (lanes, caps, windows, footer, one-click unsubscribe headers),
  buckets + sequences + blasts, Google Sheets daily loop + phone lookup, lender inbox (Gmail sync → match → Claude
  reader → proposed updates tray), money (FUND propose/confirm, commission ledger, plans, clawbacks, renewal clocks,
  winback pools, state rules), dashboard metrics (scoreboard, goal pace, funnel, money on the table, now-list,
  scorecards, email meter), documents (private storage, merchant upload links, auto-label, freshness, watermarks,
  expiring lender links, scan gate), replies/bounces/complaints/unsubscribe (Resend webhooks, STOP detection, rep
  alerts), deal flow (next-step rules, milestones, timeline, auto-chase from the rep's mailbox), anti-backdooring
  (access log, manager-only logged exports, canaries, trust panel, leak tracer, offboarding), team functions.
- Parked by the owner: texting and calling (Telnyx, click-to-call, "text me the link").
- Not yet wired: inbox attachment filing into Documents (needs Gmail attachment download in inbox sync); Resend inbound
  body fetch (the webhook carries from/subject; body retrieval depends on the Resend inbound setup); shotgun warning
  (lender count limit per deal); ops "forward stips to lender" one-click.

## Full unit suite after the automation pass (2026-11-15 ~22:40 ET): 72 files passed, 18 failed (36 tests)

Buckets, all parked for the end-of-build bug pass (owner: keep building):

1. **Date skew after 7pm ET** (JS "today" in EST vs DB current_date in UTC): streak, review-fixes, review-fixes-2,
   review-3a, leads-db, contact, funders-db timer tests. Re-run in the morning before touching any of them.
2. **funders-rls**: the lender list became shop-wide in 0300 (one list for everyone) — the per-user assertions describe
   the old model. Rewrite the test to the new rule: everyone reads every lender; submissions/offers stay per merchant.
3. **funders-db**: stips_requested now also re-buckets the merchant (0320) → a second follow-up timer; record_offer and
   create_submissions expectations predate deals (0300). Update the expectations to the deal model.
4. **send-engine** (3): pass alone, fail in the full run — shared `now` / cap clock across files. Isolate.
5. **inbox-match** test 4 funder_name ladder — known, see earlier note.
6. **boundaries**: token-table reads outside lib/system — see the note above (move into lib/system/gmail.ts).
7. **language.test**: the house word list forbids "lender" and "payment"; the owner's plan says "lender" throughout
   and the new strings follow him. Decide the vocabulary with the owner, then fix the list or the strings — not both.
8. **backup.test (C-6)**: the new tables (deals, documents, goals, access_log, webhook_events, upload_sessions, …) are
   neither in the backup nor on the exclusion list. Decide per table: user data → backup (in restore order), system
   → exclusion. "an empty account still backs up" fails for the same reason.
9. **messaging-snippets-db**: app_users writable-column list changed (0290/0310 grants). Update the expected list.
10. **messaging-merge / format-templates / winback greets**: the sender fallback is now "Selective Capital", not "Isaac".
    Fixed the expectations in this commit where they only named the fallback.

## Pages pass (2026-11-16, early): every page in the plan exists and renders

Dashboard, Lead Intake, Follow Up, Submission Board (+ review tray), My Deals + deal page (overview / documents /
activity / lenders & offers / FUND + confirm), Winback, Funded, Settings (me, buckets & templates, sheets, team &
trust, email & lenders, commission plan, AI, lender list). Old pages kept off the nav: /today (calls), /pipeline
(stage kanban), /clients, /renewals, /earnings, /long-game, /dial, /funders. Full unit suite: 77 files pass,
14 fail — all in the buckets listed above plus `tests/boundaries.test.ts` "no SQL built from input" flagging the
constant `${TZ_LABEL}` fragment in src/lib/buckets/queries.ts (register it in the test's ALLOWED map on purpose).

## Browser tests (2026-11-16, ~00:30 ET)

New flows, all green locally (`pnpm e2e crm-` and `pnpm e2e winback`, CHROMIUM_PATH set, dev server on :3000):
dashboard 8/8, deals + FUND 13/13, submissions 6/6, intake 6/6, follow-up 5/5, winback 4/4, settings 5/5. Each proves
the database changed, not just the screen. The older flows (today, pipeline, clients, client, funders, power,
mobile-ui, import, leads, source, text-guard, trash, session, backup, earnings, contact, funder-package) target pages
that still exist but moved off the main nav; the full-suite log says which of their checks the nav changes broke.

## Legacy pages (2026-11-16)

`/earnings` and `/renewals` are superseded by Funded (ledger, rep cuts, month totals) and Winback's paid-off pool;
`/today` and `/pipeline` stay as the calls list and the stage kanban under More. `e2e/earnings.legacy.mjs` is the old
earnings flow, kept out of the suite (run.mjs only picks `*.e2e.mjs`); delete it with the page when the owner signs
off on Funded. The kanban's own view links now point at /pipeline (they still said /board).

## Browser suite after the role fix (2026-11-16, ~01:30 ET)

Green: crm-dashboard 8/8, crm-deals 13/13, crm-submissions 6/6, crm-intake 6/6, crm-followup 5/5, crm-settings 5/5,
winback 4/4, leads 21/21, clients 10/10, trash 11/11, backup 9/9, funders 31/31, funder-package 8/8, import 8/8,
session 9/9, source 4/4, text-guard 5/5, contact 9/9, today 20/21, power 72/73, client 194/197.
Still red, and why:

- `board.e2e` 53/77 and `mobile-ui.e2e` 2/5: the kanban drag flows were written for the 23-stage model; stages fold
  into a dozen columns now (`FOLDS_INTO` in src/lib/mca/stages.ts, Ronny's change), so "Offer presented" columns and
  cards are never found and every drag times out. The page itself renders and the view memory works. Decide with the
  owner whether the kanban stays (it is under More as "Pipeline board"); if it stays, those flows get rewritten to the
  folded columns, if not, both flows and the page go.
- `client.e2e` 3 checks in "book and cancel a call": the booking UI changed (day + hour/minute chooser, "Remind me to"
  channels) — the flow still speaks the old one.
- `today.e2e` 1 check: quick-add's 3-month timer lands 92 days out on the 16th (month length), the check hard-codes 90.
- `power.e2e` 1 check: the "$ at stake" explanation regex vs the note's exact wording.

## Browser suite, final pass (2026-11-16, ~03:00 ET)

Every old flow that the new UI had broken is green again (`pnpm e2e <name>`, Chrome driven locally):
today 21/21, power 73/73, client 203/203, backup 9/9, leads 21/21 — on top of the new-page flows above.
The client fix landed in two commits: 1f99210 claimed 203/203 before the patch had applied; 32d2390 is the run that
made it true (a past day is refused by the picker's own validation, the database stays unchanged).

Still red, by the owner's decision rather than a bug: `board.e2e` 53/77 and `mobile-ui.e2e` 2/5 (the kanban drag
flows, see "Browser suite after the role fix" above). Unit suite: 90/91 files — `tests/language.test.ts` waits on
the lender-vs-funder / payment-vs-remittance vocabulary call (OWNER-TODO).

## Pass 2 — formal test plan, manual run, fixes (2026-11-16, overnight)

Plan: `docs/TEST-PLAN-SELECTIVE.md`. Findings: `docs/ISSUES.md` "Pass 2" (P2-1 … P2-53; 8 blockers), collected before any
fix, with the two fresh-context reviews (security, correctness) folded in. Fixes land in batches, each with
typecheck + lint + the unit suite green (tests/language.test.ts excepted — the owner's vocabulary call):

- Batch 1 (`0aa49aa`): migrations 0480/0490 (ops write policies, confirmed-funding guard, deal marked sent on send,
  epoch bump, token revocation, audit policies, suppression helper), inbound-mail authentication, active-account
  filters, role checks outside `try`, upload-route limits, page gate, postal-address guard, smaller items.
  Regression tests: `tests/pass2.test.ts` (ops loop as the ops role, the guard, tokens, the postal guard).
- Dashboard (`0800a15`): ops queue tiles; rep names on the manager's do-now list.
- In flight on branches `fix/sheets-intake` (P2-8/9/10/15/16/17/21) and `fix/lender-ui` (P2-6/22/34/38/43/44/45/47/
  49/50/52): fresh-context agents in their own worktrees, merged here after their suites pass.
- After the merge: P2-1, P2-7, P2-14, P2-19 (page wiring), P2-29 (rotate action), P2-32, P2-39/40, P2-51; then the
  plan is re-run and `pnpm e2e` with it.

Supabase (`aztoxzcmnvqaypjuuuwj`) carries every migration the dev database does (52 at this line); the security
advisor shows only the intentional notes.

## Pass 2 — after the fixes (2026-11-16, ~03:30 ET)

All 53 findings are fixed; `docs/ISSUES.md` "Pass 2 — fix status" says where each landed. The two agent branches
(`fix/sheets-intake` 057a4cd, `fix/lender-ui` 5ccdf42) are merged into main; the worktrees are gone.

- Gates: typecheck, lint, format all clean. `pnpm build` (the CI build) passes.
- Unit suite: 93 of 94 files, 1,743 of 1,745 tests. The two failures are `tests/language.test.ts` (the owner's
  lender/payment vocabulary call). New this pass: `tests/pass2.test.ts` (ops loop as the ops role, the
  confirmed-funding guard, token revocation, the postal guard, the shotgun refusal and override, the upload-link
  reset), the sheets-intake and lender-UI suites from the agents, and a boundaries test that refuses any
  "use client" file whose imports reach Node, pg or next/headers.
- Browser suites (`pnpm e2e`, 26 files): 506 of 533 checks. The 27 misses are all `board.e2e.mjs` (23) and
  `mobile-ui.e2e.mjs` (4): the kanban drag flows written for the 23-stage model, waiting on the owner's
  keep-or-drop call. `crm-settings`, `crm-dashboard` and `funders` were rewritten for this pass (form-scoped Role
  lookup; the goal button copy; lender names are unique shop-wide and accepting an offer no longer funds, so the
  run tags its lenders, parks the shop's others, and takes "Mark funded" to FUND on the deal page). `power.e2e`
  missed one check once under load and now polls for the words instead of a fixed wait; 73/73 on its own.
- Verified in the real app on top of the suites: the board's "Send to lenders" opens the lender picker, the
  shotgun warning shows past the shop limit and the send marks the deal sent with chase timers; the blast confirm
  shows the merged template; copy controls and manager/ops merchant views land in `access_log`; "Reset upload
  link" kills the old permanent link (it now reads "This link isn't valid any more") and the new one opens the
  upload form; every main page fits a 390px phone for every role.
- Found on the way: a client component imported two constants from `src/lib/docs/links.ts`, which imports the
  upload module and so `node:fs/promises`; Turbopack refused the browser chunk and the deal route 500'd. The
  constants live in `src/lib/docs/linkExpiry.ts` now and the boundaries test keeps it that way. After a Turbopack
  panic the dev server stays wedged until restarted.

Still the owner's: the vocabulary decision (language test), kanban keep/drop, the JSON backup scope, the shotgun
and chase defaults, and every OWNER-TODO credential before go-live (Google OAuth app, Resend + DNS + webhook
secret, Anthropic key, Supabase Storage bucket `documents` + service key, hosting + cron schedules, the shop's
postal address). Texting and calling stay parked.
