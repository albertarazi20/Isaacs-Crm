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
- [x] "Log out everywhere" (`session_epoch`) [R27]
- [x] Reminder address can't be pointed at an attacker: drop the editable notify address; rate-limit test email [S-M2]
- [x] Security headers (CSP etc.), production-only — verified: 9 pages, dialogs, zero CSP violations on a real production build [S-M4]
- [x] `revoke temp`, `statement_timeout`, search_path on helper functions [S-L1]
- [x] `/login?error=__proto__` crashed (500) [S-L2] · sign the OAuth state cookie [S-L3] · dev-login needs localhost [S-L4]
- [x] Timezone checked against Postgres, not Intl [S-L5] · fetch timeouts on Resend/Google [S-L7]
- [x] Import returned raw error text to the browser [S-L8] · clear local storage on logout [S-L9]
- [x] Delete unused `POST /api/auth/logout` [S-L10] · CI `permissions: contents: read` [S-L11]
- [x] Editable funding terms (a typo today can only be "fixed" by re-funding, which corrupts timers); renewal timer recomputes [R14]
- [x] Reminder-job heartbeat + banner "reminders haven't run in 3 hours" [R8]
- [x] Mobile: bottom tab bar; note box first on the client page [R9]
- [x] Data export (CSV of clients, notes) — a reference copy, NOT a full backup (advances, offers, funders, stips are not in it) [R17]
- [x] Correct OWNER-TODO: extra ALLOWED_EMAILS users get separate empty accounts [R27]

## 2. Features nobody should have to ask for (approved overnight)

- [x] **Do-not-contact** status (none / no text / no call / no email / DNC): buttons disabled with the reason, server refuses, Today excludes, all timers cancelled; quiet-hours warning by merchant state [R21–22]. Not built: consent source/date, daily text counter
- [x] **Funders, submissions, offers-in** — the biggest functional gap: funder list with appetite, per-merchant submissions (sent / stips-requested / approved / declined + reason), offers hang off a submission, Accept pre-fills the Funded dialog, chase timer for a silent funder, fit check [R13]
- [x] **Money-first queue + power-dial mode**: rank by dollars at stake, one card at a time, ~3 taps per client [R5, I1]
- [x] Commission and earnings view (expected vs received, this month, renewal pipeline $) [R14]
- [x] Renewal radar: days since eligible, paid-past-payoff prompt "move to Paid in full?" [R11, I3]
- [x] Win-back batches from dead / declined / lost with reason-aware text [I4]
- [x] Notes → suggested next date and hot flag (rules, no AI call) [I5]
- [x] Global search (⌘K) and inbound-call phone lookup [R12]
- [x] Bulk "reschedule all overdue" spread by priority; "snoozed 3×" badge; guard on burying underwriting deals [R6]
- [x] Add-to-calendar (.ics) link for booked calls [R15]
- [x] Installable PWA (manifest, icons, app badge) [R16]
- [x] Soft-delete trash with restore (a do-not-contact merchant is kept on file for good). No per-field audit trail [R18]
- [x] Saved snippets + signature/app-link in Settings; source pick-list [R19–20]
- [x] Price-book analytics from logged offers [I6]

- [x] Connection pool error handler (an idle-connection drop would have crashed the server) [C]
- [x] Board page title should carry the due count like the other pages [C]
- [x] Supabase/Neon deploy note: revoke default `anon`/`authenticated` grants or disable the Data API [S-L13]

### Added during the run (not asked for)

- [x] Reports: follow-ups done on time, funnel, where deals ended, speed, lead-source results
- [x] Lead source is first-class: import column + list name, Add client field with suggestions
- [x] Lead intake: `POST /api/leads` with a revocable token puts a new merchant on Today as call-now (`docs/LEAD-INTAKE.md`)
- [x] Monday scorecard email (last week: follow-ups on time, funded, new merchants, commission, biggest overdue deals to start with)
- [x] Funder submission package: copy a ready-to-send merchant summary, or open a Gmail draft to each funder (attach statements by hand)
- [x] Follow-up streak (business days in a row with nothing overdue at close) on Today
- [x] Clients list filters (stage, source, state, industry, amount, not-contacted-in) and download of the filtered list
- [x] A stage move keeps chase timers while the deal is in the funding pipeline
- [x] Second adversarial review (`docs/REVIEW-2.md`): 1 blocker + 7 bugs fixed and tested

### Next (ranked; none needs the owner except where marked)

- [x] Instant "new lead" email alert (capped 20/day) — push notifications still to do; delivery needs the Resend account
- [ ] Web push notifications for the installed PWA (needs a phone to prove)
- [x] Merge duplicate merchants (`merge_clients`; from Edit details when the phone or name matches another card)
- [x] Cross-device ★ (`clients.hot`, 0220; stars a browser kept locally move to the server once)
- [ ] Stips upload link texted to the merchant [!] needs a storage decision (private bucket) from the owner
- [x] A true backup: full export incl. advances, offers, submissions, stips — and a restore that reads it back (`docs/BACKUP.md`)
- [ ] Consent source/date capture per merchant (TCPA) [!] counsel first
- [ ] Per-field audit trail for client edits (who changed what)
- [ ] Clients list: page it and slim the card payload (11 MB of HTML at 5,000 merchants; fine at hundreds)
- [ ] One definition of "the day to call about a renewal": the timer (50%), the Funding card (collected figure), the Renewals page (funder's own line) and Today's reason can disagree (review-3A A-11)
- [ ] Estimates presented as facts: the "Record received" box is pre-filled with an estimate; a renewal's commission shows as entered (A-14)
- [ ] Row-level security keys on `app.user_id`, which the app role can change; fine while no SQL is built from input (`tests/boundaries.test.ts` guards it) — one database role per user is the real fix (A-17)
- [ ] Foreign keys prove "same user", not "same merchant" (offers/timers → submissions); two `app` helpers lack `search_path` (A-20)
- [ ] A deal that leaves the funding pipeline and comes back gets no new chase timers; "Send to funders" replaces a do-not-contact merchant's review timer (A-22)
- [ ] The new-lead email is sent inside the request; a slow Resend delays the sender's answer by up to 10 s (A-19)
- [ ] Today page tap targets under 40px on a phone: the Snooze menu summary, the star, the "at stake" chip and "Move the call" (QA I-12 covered the Board cards, client page and dialogs only)
- [ ] Snooze-reason prompt on a Board drop, the Set-follow-up button, note chips and win-back "Not now" (3B)

## 3. Proof work

- [~] Browser e2e for Board drag, stage dialogs and Client page (`e2e/board.e2e.mjs`, `e2e/client.e2e.mjs` — QA crew; findings in `docs/ISSUES.md`) [C]
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
