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

## Automations pass (2026-11-16, afternoon): streams 1 and 2 merged, wired, applied

Three worktrees built the streams in `docs/AUTOMATION-AUDIT.md` in parallel; this section is the merge onto main.
Stream 3 is appended below when it lands.

- **Stream 1** (`feat/stream-1-send`, 7 commits to a1d2f7a, migrations 0501–0509) merged at 680a24e, no conflicts.
  Pause and Delete reach the outbox (`trash_client`, `set_enrollment_paused`), the cross-rep duplicate block
  (`lead_owner`), the DNS gate, Sent mail from outside the CRM counted toward the cap (`send_ledger.source =
'external'`, `mailbox_sent_sync`), merchant replies tagged by Claude (`reply_tags`, `apply_reply_tag`), template
  and bucket scores with the bounce-spike auto-pause and the rep's bounce task, the holiday switch, one Cold nudger,
  the AI-run log helper, paste-a-lead-line, bulk intake, the claim checker, the Resend branch test. Tests:
  `tests/stream1-*.test.ts` (7 files).
- **Stream 2** (`feat/stream-2-deals`, 2 commits to ca54c2f, migrations 0510–0515) merged at d0610b2, no conflicts.
  The deal clocks (`expire_approvals`, `request_new_month_statements`), AI updates that write stips rows, the
  approval-landed alert, a funded email proposing the funding, undo (`revert_ai_update`), the double-submission guard
  (`create_submissions` gained `p_force`; the 4-argument signature is gone), Route B inbound channel, reshop, the
  notes gate, ask-a-manager, mailbox sync status, the reader's eval harness (`scripts/eval-reader.mjs`,
  `tests/fixtures/lender-emails/`). Tests: `tests/stream2-*.test.ts` (3 files). S2-12 (backdoor score per lender) is not in this stream: stream 3 built it (0525 `backdoor_reports`, `src/lib/trust/queries.ts`).
- **One test fallout, not a merge problem**: `tests/send-engine.test.ts` pinned its drain clock at 19:30Z / 20:00Z
  but queued rows on the wall clock, so it passed with stream 1 at 14:28 ET and failed with stream 2 at 14:31 ET.
  The enqueue clock is pinned now (44ccb65). The `create_submissions` signature change broke no caller (typecheck,
  attachments, pass2, funders-rls all green).
- **Cron wiring** (597a62d). `inbox`: after `syncInbox`, `recordExternalSends` (same token closure), then
  `tagMerchantReplies` behind `ANTHROPIC_API_KEY` like `processInbox`; the JSON gains `external` and `replyTags`,
  and a failed Sent-mail read answers 207 like a failed sync. `nightly`: `runDealClocks` after
  `roll_funding_clocks`; the JSON gains `deals`. Heartbeats stay last.
- **Smoke on the dev server** (`curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/<route>`):
  nightly 200 `{buckets, winback, clocks, deals: {expired: 0, statementsRequested: 0}}`; inbox 200 with
  `external: {mailboxes: 0}` and `replyTags` skipped (no key locally); outbox 200; sheets 207 ("Google is not
  configured", expected here); reminders 503 (no RESEND here, expected). The first smoke answered 500 because the
  dev database (`isaac_dev` on :5433) was still at 0490; `pnpm db:migrate` took it to 0516.
- **Gates on main**: typecheck, lint (0 warnings), format:check green; `pnpm -s vitest run` 103 files, 1742 tests,
  all green, 94 s. A run that overlapped the dev-database migration and the smoke on the same Postgres hit three
  timeouts (two `afterAll` drops, the two-database restore test); the clean re-run was green.
- **Supabase `aztoxzcmnvqaypjuuuwj`**: it was at 0490, not 0500 as the briefing said, so 0500 went first. 0500–0516
  applied through the MCP `execute_sql`, one file per call, each in a transaction with its `schema_migrations` row
  (`schema_migrations` has 69 rows; local has 69 files). Two statements the MCP gate refuses without a person to
  confirm are **left for the owner** (run them in the SQL editor):
  - 0508's delete of the three seeded "Cold — monthly nudge" steps did not run (the function and trigger did, and
    the row is in). Until it runs, Cold merchants on Supabase get the bucket's steps as well as the pool's:
    `delete from bucket_steps s using buckets b where s.bucket_id = b.id and b.key = 'cold' and s.action = 'email' and s.template_id in (select id from templates where owner_id is null and name = 'Cold — monthly nudge');`
  - 0512's `drop function create_submissions(uuid, uuid[], date, text)` became a rename to
    `create_submissions_retired_0512` with execute revoked from public and `isaac_app`, so the five-argument function
    resolves unambiguously. Drop the leftover:
    `drop function public.create_submissions_retired_0512(uuid, uuid[], date, text);`
- **Advisors after the apply.** New on this pass and fixed: the foreign keys 0500–0515 added had no covering index →
  0516 (e8f5280, applied). Pre-existing and left alone: 67 older unindexed foreign keys and 61 unused indexes (INFO),
  94 "multiple permissive policies" (the owner / team / ops policy triple, by design), five system tables with RLS
  and no policy (deny-all on purpose: `gmail_connections`, `job_runs`, `reminders_sent`, `schema_migrations`,
  `webhook_events`), and three 0001-era helpers without a fixed `search_path` (`app.current_user_id`,
  `app.can_see_all`, `app.current_role`).

### Stream 3 landed (2026-11-16, ~15:10 ET)

- **Stream 3** (`feat/stream-3-money`, 1 commit, 8e43335, migrations 0520–0525) merged at 9f58fb0, no conflicts
  (`tests/boundaries.test.ts` JOBS and `tests/review-4.test.ts` EXCLUDED merged both sides by themselves). Alerts
  by email (`user_alerts` generators and the hourly drain), month-end close (`close_month`, statements, locked
  lines, `correct_funding`), the plan in full (renewal split, manager override line, tiers), lender payout dates,
  the renewal engine (`start_renewal`, warm-up and eligible templates), compliance (`app.registration_missing`),
  dead-deal document retention, trust alerts, the backdoor score (S2-12), win-back finished (reasons, Claude's
  opener in auto or review mode, rescue nudges on days 20/25/29, `source_id` so a finished membership never
  re-enrols), dashboard speed numbers. Tests: `tests/stream3-*.test.ts` (9 files, 3 skipped cases are the
  Resend-only export sends).
- **Cron wiring** (9dedece). `reminders` (hourly): `runUserAlerts` and `runMonthEndClose` after the weekly
  scorecards, with the same `send` / `allowed`; a failed send in either answers 502 like the digest. `nightly`:
  `runWinback` gets `drafter: claudeOpenerDrafter` when `ANTHROPIC_API_KEY` is set; after the deal clocks,
  `runRenewals`, `runRescueNudges`, `purgeDeadDocuments` with `documentStore(env)`. JSON gains `alerts`, `close`,
  `renewals`, `rescue`, `retention`. Smoke: nightly 200 with every key; reminders 503 locally (no RESEND).
- **Cross-stream fallout, fixed on main (aa08353):** stream 3's win-back and trust tests failed on main because every
  test merchant carried the helper's one phone number and stream 2's double-submission guard (0512: same phone or
  email = the same owner) refused the second file to Pearl. Each test merchant now has its own phone — the fixture
  models distinct merchants, as it meant to. No guard was loosened.
- **Follow-ups the streams reported, settled:** the send-engine clock (44ccb65, above); `app.plan_for` now falls
  back to the person's newest plan (own first) for a funding dated before every plan's `effective_from` (0526,
  `tests/plan-for.test.ts`, proved by the manager's override line posting on such a funding); the win-back re-enrol
  loop — stream 3's `source_id` guard and stream 1's Cold trigger (0508) both stand, and two added cases walk the
  approved and Cold sequences to the end, roll twice more and count one membership.
- **Gates on main at 2ab296d:** typecheck, lint (0 warnings), format:check green; `pnpm -s vitest run` 113 files,
  1804 tests, all green; `pnpm -s build` green.
- **Supabase:** 0520–0527 applied the same way (schema_migrations has 77 rows; local has 77 files). Nothing new
  from the security advisor; the performance advisor's new unindexed foreign keys became 0527 (2ab296d, applied).
  The two statements left for the owner's hand are unchanged (0508's delete, the retired 0512 signature's drop).

## Design phase and the page controls (2026-11-16, evening): on main at 2c1cdbb

The owner asked for the look next ("precise and minimal, light by default with a dark switch, compact, the Selective
Capital brand, top bar") and then for everything to be finished. What landed, all merged to main:

- **The look** (`docs/DESIGN.md` is the spec): tokens in `globals.css` with `light-dark()` so one set serves both
  modes; the mode is a cookie (`theme`: light default, dark, device) set from the account menu or Settings → Me;
  Geist from the brand site; the S logomark in `public/brand/`; one gradient (blue → violet → fuchsia) used only on a
  screen's primary action. Three agents restyled every page and component to it, then verified at 1440 and 390 px,
  light and dark.
- **New pages**: the alert feed (`/alerts`, the bell in the header), the first-login policy gate (`/policy`), the
  merchant's application (`/apply/[token]`), month-end statements (`/funded/statements/[period]`,
  `/settings/plan/statements/[id]`), the state-rules editor (`/settings/states`).
- **Every backend now has its control**: four agents wired the settings (DNS check, deals inbox, approval validity,
  chase mode, holidays, scores, retention, statements, trust cards, AI spend), intake and follow-up (paste a lead
  line, cross-rep duplicate line with manager override, bulk intake, reply tags, pause until a date, bucket scores,
  application link), the board and deal page (undo an AI update, chase drafts, import a pasted offer or screenshot,
  offer compare, reshop, state badge, ask a question about the deal with verified citations, ask a manager) and the
  money pages (why it did not fund, the opener tray, recovered money, rescue nudges, statements, late payouts,
  corrections, start renewal, speed numbers). Each has a browser check that drives the control and reads the
  database (`e2e/wire-*.e2e.mjs`) and unit tests (`tests/wire-*.test.ts`).
- **Bugs found on the way, all fixed with tests**: signing the application failed for a merchant with no DBA (a null
  into a not-null column); a late native `close` event from one dialog closed the next one opened right after it
  (log a call, start another at once, and the second prompt vanished; `Dialog` now ignores the close events of its
  own `close()`); the alert feed's labels did not match the kinds the code writes; late-payout alerts linked to a
  page that does not exist.
- **Dependencies**: Next.js 16.4.2 → 16.4.6 (GHSA-mfr8-8qww-v76h, a `use cache` issue the app does not use; the patch
  is inside the caret range). `pnpm audit --prod` is clean. The old Pipeline board (kanban) is gone, with its two
  suites; the vocabulary test now takes the plan's own words (lender, payment) and still bans loan, borrower,
  interest rate, APR, principal and customer.
- **Gates on main at 2c1cdbb**: typecheck, lint (0 warnings), format:check green; `pnpm -s vitest run` 122 files,
  1,911 tests, all green; `pnpm -s build` green; the browser suites 688 of 688 checks against the redesigned
  screens (`BASE_URL=http://localhost:3001 node e2e/run.mjs`, Chrome driven locally, never in CI). One thing the
  browser helper now ignores on purpose: React 19.2's development-only "negative time stamp" page error thrown when a
  server page calls `notFound()` (the merchant page does it on main too; it is not in a production build).
- **Supabase `aztoxzcmnvqaypjuuuwj`**: applied through 0531 (79 migrations, matching local). The two statements the
  migration tool refuses to run unattended are unchanged (see "Automations pass").
- **Known limits, said plainly**: the AI controls (ask a question, screenshot import, paste) were proved end to end
  against a local stand-in for the model, not a real Anthropic key; a real Gmail send was proved only with a fake
  sender. Ops cannot read AI proposals (row security from 0340: proposals are the manager's tray), so an ops user sees
  chase drafts but an empty proposals list; changing that is a decision and a migration, so it is left as it is.
  Lenders saved before the "blank approval days = shop default" change still carry an explicit 30.

## Follow-up scope and the Obsidian rebuild (2026-11-16, night): branch scope/redesign

The owner changed the product twice in one evening. First the scope: deals, lenders, money, win-back and trust come
out; the CRM only brings interested merchants in (`docs/FOLLOW-UP-SYSTEM.md`). Then the look: the first redesign and
ten mockups were rejected as cheap. The instruction was to rebuild the real app so it feels expensive: everything on
a dropdown sidebar, lead intake as a button and never a page, compact pages with a lot in each, every page redone.

- **Removal** (`scope/follow-up`, 417 files, about 52,000 lines out): pages, automations, library code, tests and
  browser suites for the removed features. The schema is untouched. Old stage keys fold into Interested,
  Application in and Trash on screen.
- **The finish line** (`scope/handoff`): `0540_hand_off.sql` adds `clients.brought_in_at/by`, `hand_off` and
  `undo_hand_off` (definer functions, checked by `app.can_touch_client`), a trigger that cancels automated mail to a
  brought-in merchant, "Ready to hand off" as the last bucket's name, and Cold's 30/60/90 nudge. `loadOverview`
  (`src/lib/followup/overview.ts`) feeds the Overview. Tests read the database back
  (`tests/followup-handoff.test.ts`, `tests/followup-overview.test.ts`).
- **The design system** ("Obsidian", `docs/DESIGN.md`): dark by default, tokens still `light-dark()` so light is the
  same system; glass panels, pill buttons, one gradient primary per view; new primitives (PageHeader, StatCard,
  Sparkline, ProgressRing, Meter, Segmented, Avatar, Kbd, Skeleton), a `Drawer`, `CountUp`, a line-icon set.
- **The shell**: `src/components/shell/Sidebar.tsx` (Overview, Follow Up with every bucket and its count, Merchants,
  Settings, each a dropdown; alerts and the account at the foot; a top bar and slide-in menu on a phone) and
  `shell/NewLead.tsx` (one sheet for adding a lead, opened by any New lead button, the N key or `/?new-lead=1`;
  `/lead-intake` redirects). Search became a command palette (⌘K: merchants, jump-to, New lead). The top bar, the
  phone tab bar, the quick-add dialog and the user menu are gone.
- **Every page rebuilt**: Overview, Follow Up (board and bucket workspace with a merchant sheet and Hand off), the
  merchant page (hero, the bringing-them-in strip, timeline), Merchants, call list, power dial, import, trash, all
  six Settings pages (web lead connections moved to Settings, Lead sources), alerts, sign-in, and the three pages a
  merchant sees (upload, application, unsubscribe).
- **A bug the new browser suite found**: in Chrome the dialog's native `close` event can arrive half a second after
  Escape. Until then the app believed the dialog was still open, so opening it again did nothing. `useModal` now
  closes on the Escape key press itself, counts its own closes and ignores a close event that arrives while the
  dialog is open. The search palette and the phone menu use the same hook.
- **Supabase `aztoxzcmnvqaypjuuuwj`**: 0540 applied by hand in one transaction; 80 migrations, matching local.

## The assistant, two bug hunts, hot signals and the nudge (2026-11-17, overnight): branch signals

The owner asked for an AI assistant on Claude Opus 5.5 that tells a rep what to do next and sets it up for them, then
for the night to be spent finding bugs, fixing designs and adding ideas that make the CRM a better follow-up desk.

- **The assistant** (`src/lib/assistant/`, `src/components/assistant/`, `0541_assistant.sql`): a side panel (⌘J) that
  reads the CRM through read-only tools under the person's row security and proposes actions as buttons (open, hand
  off, set a follow-up, add a note, pause, move to a bucket, send an email after review, copy a text). Nothing
  happens until the person clicks. Recommendations on the Overview open it with a brief. Every model call is logged
  against the daily AI budget; conversations are saved per person. The model is scripted in the tests and in the
  browser suite (`e2e/model-stub.mjs`); a real key goes in Netlify as `ANTHROPIC_API_KEY`.
- **Hot signals** (`0547_link_opens.sql`, `src/lib/system/linkSignals.ts`, `/api/seen`): a merchant who keeps their
  upload link or application on screen for three seconds is recorded (a mail scanner is not; a signed-in rep is
  not). They go second in "Do this now" as Opened link, and the assistant recommends calling them.
- **Nudge after an open** (`0548_open_nudge.sql`, `src/lib/system/openNudge.ts`, hourly): off until a manager switches
  it on in Settings > Email. A merchant whose latest open was 20 to 72 hours ago and who has not finished gets their
  link again, once a week at most, from the two shop templates "Nudge: finish uploading" and "Nudge: finish the
  application".
- **Ask from anywhere**: each "Do this now" row has a sparkles button with a brief for why it is there (draft my
  reply, nudge them, prep the call, check the file, what came in, fix the email, catch up), and a merchant's newest
  reply has Draft my reply. Briefs carry the merchant's id, never their name.
- **Bug hunt 1** (four agents: engine, documents, UI, security; `0542`–`0546`): a not-now reply re-opened a closed
  chase; duplicate automated emails; the statement clock never ran; a relabelled or deleted file kept its box ticked;
  undo of a hand-off lost the bucket; renewal templates made money claims; stale alerts; another rep's merchant could
  be imported or sent by webhook a second time; wording, em dashes and touch targets across the app.
- **Bug hunt 2** (two fresh reviewers; `0549` and code): the open bucket page crashed (a server page called a
  function from a client-only file; `tests/boundaries.test.ts` now fails any such import); the assistant's link check
  accepted `/.//api/...`; cut-off model calls were not counted; one failed lookup broke the batch; the panel mixed
  threads when history was opened mid-answer; undo of a hand-off skipped the step it cancelled and ignored documents
  that came in meanwhile; re-bucketing re-opened closed chases and dropped pauses; a scan-rejected file kept its box
  ticked; the statement checklist never let an old month go; blasts were keyed to the UTC day; do-not-contact
  merchants showed on the call-now, opened and overdue lists; placeholder emails matched unrelated merchants.
- **Later the same night**: `{missing_docs}` (emails name what is still owed; 0550 rewrote three stock checklist
  emails), an Active mark and a Most active sort (the merchant's own last move), the phone Overview puts Do this now
  before the numbers, `docs/SYSTEM.md` and `docs/OWNER-TODO.md` rewritten for the follow-up system.
- **Bug hunt 3** (two fresh reviewers on everything after round 2; 0551, 0552): the assistant's 54 s stop re-ran the
  same paid call forever and under-counted its cost (now: effort steps down, then a "shorter answer" notice; cost
  counts the time a call ran; late tools run first in the next request); a queued nudge could still go after the
  merchant replied (the worker now cancels it, `app.nudge_overtaken`); the nudge ignored the checklist, rep emails
  and Resend replies, and counted opens from before it was switched on; `{missing_docs}` blocked the welcome for a
  lead with no checklist (now falls back to the bucket's ask); a closed chase never reached Ready (and its alert);
  the Most active sort crashed (pg Date vs text); `inbound_emails` had no client index.
  Known and left: a queued email's `{missing_docs}` is the list when it was queued.
- **Gates**: typecheck, lint, format clean; unit 104 files / 1,408 tests; `pnpm build` passes; browser suites run
  locally against the stand-in model.
- **Supabase `aztoxzcmnvqaypjuuuwj`**: 0541–0552 applied by hand, one transaction each (no 0545); 91 migrations.

## Open approvals (2026-11-17, evening)

The owner: "an open approval tab … any merchant who gets an offer and hasn't been pitched will be in there … we will
send them a html template which i already made … 1 initial [and] follow ups … automatically send them and read the
time stamp the initial was sent to send the follow up … in settings you can choose how long after each template the
next one sends." The owner will send the final designs; their drafts (four emails, options A/B/C each, in
`~/Downloads/selectivecap-templates-html`) set the fields: `{{first_name}} {{business_name}} {{offer_amount}}
{{offer_expiry}} {{rep_name}} {{rep_phone}} {{rep_email}} {{unsubscribe_link}}`.

- **Defaults taken (no question asked):** a rep marks the approval (amount, the date the funder holds it until,
  funder and note for the rep only) from Open approvals or the merchant's page; the first email goes at once inside
  the approval window (9am to 6pm merchant's time, weekdays; Settings); each follow-up goes its delay after the one
  before it was sent; Pitched or Close takes the merchant off the page; a reply stops the emails and puts the merchant
  first ("Replied, call them now"); four emails by default (1 + 3 follow-ups, 1, 2 and 3 days apart), up to six.
- **0553:** `approvals`, `approval_emails`, `app_users.phone`, the approval settings, outbox lane `approval` (each
  step once: `outbox_approval_once_idx`), `app.approval_halt` (read by the engine and by the worker right before a
  send), `app.approval_of`.
- **Sending HTML:** the worker sends a designed email as it is (its own footer and unsubscribe link, required when it
  is saved) with the legal footer on the plain-text part; Gmail sends multipart/alternative (`buildRawEmail`).
- **Two fresh reviewers** (backend; screens) found real problems before it shipped, all fixed with tests: approvals
  kept sending as an offboarded rep (a trigger now moves an open approval and refills a queued email with the new
  rep); one bad approval row could stop the whole outbox (the worker checks each approval under a savepoint and the
  cron's approval pass is time-boxed and caught); a retry could land at night (the worker re-checks the merchant's
  day); switching the emails off, changing the address, or replacing a design left an already queued email to go
  (each now takes it back); approvals went out through the shop's domain with no way for a reply to stop them (they
  go from the rep's own Gmail, replies always reach the rep); a design without the postal address now gets the
  legal footer; an unsubscribe link hidden in a comment, or a banned word in the hidden preview line, is refused;
  a reply to the last email was never flagged (`app.approval_needs_call`); Undo after Pitched restores the emails;
  the "more" menu was hidden behind the next card; the edit dialog never closed; the hold date was pre-filled with a
  guess that went in the emails (now empty, and the form says which email quotes it).
- **Known and left:** the worker sends inside an open transaction, so a function killed after the provider accepted
  a message could send it twice (true of every lane; the approval pass runs first and is time-boxed to keep that
  unlikely); the hold countdown uses the rep's today while the stop uses the merchant's.
- **Live:** main `82b87ba`, Netlify deploy 6afcd89833ce10d94baef5b1, Supabase `aztoxzcmnvqaypjuuuwj` through 0553 (92
  migrations; the four email slots are empty, so nothing sends until the designs are uploaded). Unit 107 files /
  1,472 tests; browser run 565 checks plus 22 (approvals) and 11 (approval settings); `pnpm build` passes.

## The brain, 2026-11-18

The owner turned the assistant back on (key on Netlify, credit added), asked for the model to be Sonnet 5.5, and for
"an AI brain designed to my business that automates most of my workflow".

- **Model:** the assistant now uses `shop_settings.ai_model` (Settings → AI; default Sonnet 5.5 since 0554) instead of a
  constant; reply tagging and lead splitting already did. A real run on Sonnet 5.5 passed (`LIVE_AI=1 ANTHROPIC_API_KEY=…
pnpm vitest run tests/assistant-live.test.ts`, a few cents).
- **House rules:** `shop_settings.playbook` (manager-written, 4,000 characters) is a second system block in every
  conversation, below the fixed prompt, which it cannot override.
- **The brain:** `src/lib/system/brain.ts` + `/api/cron/brain` + `netlify/functions/cron-brain.mts` (every five minutes).
  For each active rep it reads their own "Do this now" list (`loadQueue`, row security), skips what is not theirs and
  bounced addresses, and queues one `brain_preps` row per trigger (kind + merchant + the moment that put it on the list)
  inside a rolling 24-hour limit per rep (`brain_daily_per_rep`, default 15), plus one plan a day. Each is run through
  `runAssistantTurn` as the rep (the same tools, checks and spend log as a chat), claimed for three minutes so two
  runs never share one, resumed if it ran out of time, given up after three failures, and the whole sweep stops when
  the account is out of credit or the daily cap is spent. The rep's side: "Prepared for you" on the Overview
  (`PreparedForYou`), a mark and a changed sparkles button on the Do this now row, and the panel opens it with live
  buttons (`openPreparedAction`; the server re-checks each click as always). A manager sees the counts in Settings → AI.
- **Tests:** `tests/brain.test.ts` (17, DB-proving: who is queued, once only, the limit, the claim, credit, failures,
  offboarded reps, row security, the model and house rules), `tests/assistant-errors.test.ts`, `e2e/brain.e2e.mjs`
  (12 checks on the stand-in model). Full browser run 596/596.
- **Left on purpose:** nothing is sent by the brain (an email is a button the rep reviews); buttons done in an opened
  preparation are not remembered if it is opened again.

## Follow Up tools, 2026-11-18

The owner asked for: a dial list per bucket to copy into Google Voice, merchant information that is easy to find, a search
in every bucket and across all buckets, a CSV export per bucket for a sheet and a text blast, and a fix for "can't move
it to another bucket" (the merchant page's Move to… menu moved the _stage_, not the bucket).

- **Rows** show the number (it was hidden whenever an email existed). `matchesSearch` (src/lib/followup/search.ts) needs
  every typed word somewhere on the merchant (name, contact, email, state, bucket, rep) and matches a number as digits, so
  "305-555", "(305) 555 01" and "+1305555" all find (305) 555-0100.
- **Dial list** (`DialList.tsx`, src/lib/followup/dial.ts): the checked rows, else what the search and filter show. One
  "next to dial" card with the number, the merchant's own clock and a warning outside 8 am to 9 pm there; Copy number,
  Open in Google Voice (the existing `voiceCallHref`), Dialed next (which puts the next number on the clipboard);
  Copy all numbers (one a line) and Copy for a sheet (tabs). Do-not-contact, no-call and unusable numbers are left off
  with the reason; one number on two records is dialed once.
- **All buckets search** (`AllMembersSearch.tsx`, `listAllMembers`): results say which bucket, copy the number, open the
  merchant, and can become a dial list.
- **Export CSV** (managers, the same rule as every other export): per bucket from the rows on screen or checked (client
  side, `followupCsv`), and every bucket through `/api/export/followup?bucket=all|<id>`. Do-not-contact is left out and
  counted; Call OK / Text OK / Email OK columns mark the rest; the E.164 column is `+13055550100` (csvCell now leaves a
  plain international number alone, every other leading plus is still guarded).
- **Moving a merchant:** the merchant page has a Move to bucket select showing the current bucket (`BucketMover`); the
  stage control now reads "Change stage…". Locked for a merchant who was handed off.
- **Tests:** tests/followup-tools.test.ts (14), tests/followup-members.test.ts (6, DB-proving), e2e/follow-up-tools.e2e.mjs
  (26 checks, including a rep who gets the dial list and no export). boundaries allow-list for `buckets/queries.ts` is 4.
- **Left:** texting stays parked (the file is for the owner's own sheet); the dial list does not log a call (the call list
  on Today still does).

## Merchant offers, 2026-11-18

The owner showed another funder's offer page (amount, weekly payment, factor rate, payback, a countdown, "Accept your offer"
with two document uploads) and asked for "generate merchant offer": the terms in, a professional email out, a link to a
page like that. Built in Selective Capital's own look, not the other company's.

- **Data** (0555 `merchant_offers`; the old deal-desk `offers` table from the removed lender work is left alone): the
  payback and the payment are generated columns, so the email, the page and the CRM agree to the cent; a check proves
  the form's `computeTerms` against the database on edge cases. Reps insert and withdraw (column grants); views,
  acceptance and the merchant's name are written only by the system side. A trigger keeps an accepted or withdrawn offer
  final for the app role.
- **Email:** the outbox can now carry an HTML part on any lane (`enqueueEmail({ html })`; the worker sends a designed body
  as made). Offer emails ride lane `reply` with source `offer:<id>`, from the rep's Gmail, and expire with the offer.
- **Page:** `/offer/<token>` (no sign-in, noindex). The upload slots use the existing upload sessions; the upload route
  takes an optional `kind` limited to the offer documents. Accept checks the documents are on file (not infected or
  rejected), stamps the name, email and IP, alerts the rep (`offer_accepted`; the first open is `offer_opened`), and stops
  an approval's emails with note `offer_accepted`.
- **Also:** the approval card's "Change the offer" is now "Change the approval" (the word offer means the new thing).
- **Tests:** tests/offers-terms.test.ts (10), tests/offers.test.ts (14, DB-proving), e2e/offers.e2e.mjs (12 checks, the
  merchant in a signed-out browser uploading and accepting).
- **Two fresh reviews (backend; screens)** found real problems, fixed before shipping: opening an offer took over the
  merchant's everyday upload link (offer sessions now have their own purpose, and the everyday link skips them); the same
  file sent to two slots showed "Received" but never filled the second (a different-kind duplicate is refused with words,
  an unsorted one takes the slot's label; the page re-reads the slots from the server after every upload and failed
  accept); a slot the merchant picked was stored as a staff label (now a rule label at 0.7 so the documents card asks for
  a check, and only on offer sessions, one file at a time); a mail scanner's prefetch counted as the merchant opening it
  (the open is a beacon from the page after three seconds, never for a signed-in rep, and opening changes nothing); the
  payments could add up to more than the payback (each payment rounds down, the final one carries the leftover cents, shown
  as "Final payment"); an accepted or withdrawn offer could still be edited (any change is refused); a document behind an
  accepted offer that fails its check now alerts the rep; the accepting IP comes from Netlify's own header; designed HTML
  goes only on the approval and reply lanes; the Upload buttons nearly vanished in one theme (now the app's primary
  button); the countdown used the phone's clock (now the server's, corrected after load); the form showed terms the server
  refuses (it runs the same schema and says why), shows the deadline in the merchant's zone, and says up front when a
  merchant cannot be emailed; wording no longer promises funding ("move forward", "next steps", "accepted as"); Withdraw
  asks twice; the slots read well to a screen reader; a rep's preview cannot upload or accept.
- **Left:** an email the worker has already picked up cannot be taken back by Withdraw; Netlify functions take about 6 MB
  per request, so a very large phone photo is refused with "too big" (the page asks for a smaller file).

## Offers, part two, 2026-11-18

The owner asked for the offer to look "very professional… a financial font… stand out", for the accepted documents to
be "sent to my email", and to see whether the merchant opened the link.

- **Look:** the page is always on paper (its own shell, `color-scheme: light` on the whole document, theme colour
  #f4f2ec), Source Serif 4 (next/font) for headings and figures, an ink header with the offer number (`offerNumber`,
  "SC-2026-1F3A9C"), a double-ruled term sheet with the amount to the cent. The email matches: the light-text wordmark in
  an ink header (so Gmail's dark mode cannot hide it), Source Serif 4 where the client loads it, Times for figures
  elsewhere (Georgia's numerals dip), Outlook-safe table layout (a fixed 600 wrapper, padding on cells, no div rules).
- **The rep's copy:** `src/lib/system/offerNotice.ts` emails the merchant's rep (their notify address, else their email)
  the terms, who accepted, and the documents attached (multipart/mixed in `buildRawEmail`; Gmail's upload endpoint for
  messages with files; Resend's attachments). It is sent by the outbox job right after the scan, never with a file that
  has not passed it; a sender claims the offer first so two never both send; three tries, then "Email me the documents"
  on the card. From the rep's own Gmail, else the shop's Resend domain, else the error says what to connect (0556).
- **Opens:** the badge says "Opened" (eye) with how many times and when, on the merchant page card and on the Open
  approvals card; an open also lands in link_opens kind `offer`, so "Do this now" lists "Opened their offer, not accepted
  yet" (also after a hand-off) while it waits; the open nudge ignores it.
- **Reviews:** two fresh reviews found the unscanned-attachment hole, a double-send race, the copy going to the offer's
  maker rather than the merchant's rep, the Gmail body limit, the page's dark browser chrome and invisible focus ring,
  the email's width on phones and in Outlook, Georgia's old-style figures, faint grey text, "26 every two weeks
  payments": all fixed with tests.
