# Backlog — the overnight run's work queue (and your finish list)

Claude works this top to bottom without stopping, commits and pushes after every item, and adds anything
new it finds. `[x]` done and tested · `[~]` in progress · `[ ]` queued · `[!]` needs a human (see
`docs/OWNER-TODO.md`). Source of each item in brackets: **R** gap review · **S** security review ·
**B** Board/Client crew findings · **C** Claude's own.

## 1. Review fixes (bugs found by the reviewers — verified before fixing)

- [x] Logged call / snooze / drag deleted a funded client's renewal + check-in timers [R2, B4]
- [x] Booked call could never clear and became a permanent "overdue" ghost; added Cancel call [R1]
- [x] Digest listed a client twice when two timers fell on one day [C]
- [x] Short timers are business days (no Saturday "tomorrow"); post-call default respects the stage [R3, R7]
- [x] Text outcomes say "They replied / Sent — no reply yet", not "Left message" [R10]
- [x] Import must not turn "do not call" rows into a revive-text lead [R21]
- [x] Notes / call bodies must refuse SSNs and card numbers (CLAUDE.md "never store") [R24, S-L6]
- [x] Reject control characters in every single-line field; validate email; one recipient only [S-M3]
- [x] Allowlist re-checked on every request (verified on a production build), 14-day sessions, 100 emails/day cap [S-M1]
- [ ] "Log out everywhere" (`session_epoch`) [R27]
- [x] Reminder address can't be pointed at an attacker: drop the editable notify address; rate-limit test email [S-M2]
- [x] Security headers (CSP etc.), production-only — verified: 9 pages, dialogs, zero CSP violations on a real production build [S-M4]
- [x] `revoke temp`, `statement_timeout`, search_path on helper functions [S-L1]
- [x] `/login?error=__proto__` crashed (500) [S-L2] · sign the OAuth state cookie [S-L3] · dev-login needs localhost [S-L4]
- [x] Timezone checked against Postgres, not Intl [S-L5] · fetch timeouts on Resend/Google [S-L7]
- [x] Import returned raw error text to the browser [S-L8] · clear local storage on logout [S-L9]
- [x] Delete unused `POST /api/auth/logout` [S-L10] · CI `permissions: contents: read` [S-L11]
- [ ] Editable funding terms (a typo today can only be "fixed" by re-funding, which corrupts timers); renewal timer recomputes [R14]
- [ ] Reminder-job heartbeat + banner "reminders haven't run in 3 hours" [R8]
- [ ] Mobile: bottom tab bar; note box first on the client page [R9]
- [ ] Data export (CSV of clients, notes) and a backup note [R17]
- [ ] Correct OWNER-TODO: extra ALLOWED_EMAILS users get separate empty accounts [R27]

## 2. Features nobody should have to ask for (approved overnight)

- [ ] **Do-not-contact** flag + consent source/date + quiet hours (hide Text outside 8am–9pm merchant-local); excluded from reminders [R21–22]
- [ ] **Funders, submissions, offers-in** — the biggest functional gap: funder list with appetite, per-merchant submissions (sent / stips-requested / approved / declined + reason), offers hang off a submission, Accept pre-fills the Funded dialog, chase timer for a silent funder, fit check [R13]
- [ ] **Money-first queue + power-dial mode**: rank by dollars at stake, one card at a time, ~3 taps per client [R5, I1]
- [ ] Commission and earnings view (expected vs received, this month, renewal pipeline $) [R14]
- [ ] Renewal radar: days since eligible, paid-past-payoff prompt "move to Paid in full?" [R11, I3]
- [ ] Win-back batches from dead / declined / lost with reason-aware text [I4]
- [ ] Notes → suggested next date and hot flag (rules, no AI call) [I5]
- [ ] Global search (⌘K) and inbound-call phone lookup [R12]
- [ ] Bulk "reschedule all overdue" spread by priority; "snoozed 3×" badge; guard on burying underwriting deals [R6]
- [ ] Add-to-calendar (.ics) link for booked calls [R15]
- [ ] Installable PWA (manifest, icons, app badge) [R16]
- [ ] Soft-delete trash + audit trail for client edits [R18]
- [ ] Saved snippets + signature/app-link in Settings; source pick-list [R19–20]
- [ ] Price-book analytics from logged offers [I6]

- [x] Connection pool error handler (an idle-connection drop would have crashed the server) [C]
- [ ] Board page title should carry the due count like the other pages [C]
- [ ] Supabase/Neon deploy note: revoke default `anon`/`authenticated` grants or disable the Data API [S-L13]

## 3. Proof work

- [ ] Browser e2e for Board drag, stage dialogs and Client page (extends `pnpm e2e`) [C]
- [ ] Run `docs/TEST-PLAN.md` end to end, write every failure into `docs/ISSUES.md`, fix, re-run [CLAUDE.md steps 4–7]
- [ ] Production build + start, smoke test with a minted session [C]
- [ ] Re-run security review after the fixes [C]
- [ ] Update `docs/REQUIREMENTS.md` statuses from real results [C]

## 4. Only a human can do these (full list: `docs/OWNER-TODO.md`)

- [!] GitHub Actions billing (CI jobs don't start) · hosting accounts · Google OAuth credentials + mode ·
  Resend key + domain · hourly scheduler · Isaac's call (stage names, 50%, states, his CSV) · phone test of Text/Call.
- [!] Counsel: state commercial-financing disclosure/registration (secondary sources suggest CA, NY, UT, VA, FL,
  GA, CT, KS, MO, TX; Texas broker registration reportedly due 2026-12-31 — **unverified, ask counsel**) and
  TCPA/consent for texting merchants.

## 5. Deliberately not built (say so, don't drift)

Syndication, rep splits (RLS is single-user), real file upload (needs a storage decision), disclosure
document generation (needs counsel), SMS API (owner said no).
