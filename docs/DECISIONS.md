# Decisions

Append-only. One entry per decision that someone could later ask "why is it like this?" about.
Each entry: the date, the decision, the reason, and who decided.

## 2026-10-20 — repo created

Separate repo from BH Violation Removal, at the owner's request ("not to mix up with my shit").
No shared code, git history or database.

## 2026-10-20 — named `Isaac`

Renamed from `mca-crm` to `Isaac`, the client's name, at the owner's request (typed into the
GitHub Desktop new-repository dialog). The folder name carries no meaning in code — nothing
imports by path — so this is a rename only.

## 2026-10-23 — stack: Next.js 16 + plain Postgres, no ORM

Next.js App Router + TypeScript, `pg` against plain Postgres with hand-written SQL migrations in
`db/migrations/`. Standard ESLint + Prettier + Vitest, per CLAUDE.md. Why plain Postgres and not a
Supabase client: the logic that must not break (stage moves, timers, funding) lives in SQL functions
tested directly against a real Postgres, and the same migrations run on Supabase, Neon or a laptop.
`.env.example` already carried `DATABASE_URL`. Decided by Claude, owner to veto.

TypeScript is pinned to `~6.0` because `typescript-eslint` 8.x does not support TypeScript 7 (lint
refused to start). Revisit when typescript-eslint adds 7.

## 2026-10-23 — what personal and financial data the app stores (decided before the schema)

- **Never stored:** bank credentials, card numbers, **EIN, SSN, date of birth**. A follow-up CRM does
  not need them — the funders' portals collect them. If Isaac later needs EIN for dedupe, store
  last-4 only and record his stated reason here first.
- **Stored, owner-readable only:** merchant name, business name, phone, email, state, industry,
  self-reported monthly revenue, other advances' funder names and balances, funding terms, notes.
  Every table holding these has row-level security from creation (`user_id = app.current_user_id()`).
- **Bank statements are files, not columns.** `stips.doc_key` holds an object-storage key only.
  Uploading is NOT built in v1 — stips are checkboxes. When uploads arrive they go to a private
  bucket behind authenticated, short-lived URLs. Never in the database, never in git.
- **Gmail refresh token** is a credential: AES-256-GCM encrypted with `TOKEN_ENC_KEY`, stored in a
  table the browser-facing DB role cannot read at all, never sent to the browser.
- Money is `bigint` cents. Factor rate is `numeric(5,3)`. Dates are `date`; Isaac's timezone is a
  setting so "due today" means his today.

## 2026-10-23 — how row-level security is enforced

Every user-facing request runs inside a transaction as `SET LOCAL ROLE isaac_app` (NOLOGIN, no
BYPASSRLS) with `app.user_id` set. Policies key off `app.current_user_id()`. RLS is `ENABLE`d, not
`FORCE`d, so system jobs (login upsert, reminder cron) connect as the owner on purpose — they go
through `withSystem()`, which is only imported from `src/app/api/**` and `src/lib/system/**` (a test
greps for this). `gmail_connections` has no grants for `isaac_app` at all.

## 2026-10-23 — timers are rows, not a column

A client can hold several open timers (`follow_up`, `check_in`, `renewal`, `scheduled_call`). A funded
client needs a 30-day check-in AND a renewal call at once; one `next_follow_up` column cannot do
that. A client's "next follow-up" is the earliest open timer. Every stage move must leave at least
one open timer — enforced in `move_client()`, not by convention. Max horizon 36 months.
Stage→timer defaults live in TypeScript (`src/lib/mca/stages.ts`); the DB only stores `stages`
(key/label/group/sort) for foreign-key integrity, and a test fails if the two drift.

## 2026-10-23 — Gmail: Testing mode is NOT zero-downside (correcting an earlier claim)

Earlier in chat I said to keep the Google OAuth app in "Testing" with zero downside. Wrong: Google
documents that refresh tokens issued to a Testing-status app expire after **7 days**. `gmail.send`
is a sensitive scope, so Isaac would have to reconnect Gmail weekly. Options, none testable from
here without his Google account: (a) publish to Production unverified — warning screen on consent,
100-user cap, one forum report claims 7-day expiry persisted, so UNVERIFIED; (b) Google verification
(privacy policy + demo video, days to weeks); (c) Internal app type if Isaac has Google Workspace.
The app treats `invalid_grant` as "reconnect" (banner + `needs_reconnect`) and always offers a Gmail
compose link that needs no OAuth, so email never hard-fails. **Open: owner picks (a)/(b)/(c).**

## 2026-10-23 — texting: no SMS API

Text/Call buttons open `sms:`/`tel:` on a phone and Google Voice on desktop. Google Voice has no
documented deep link; the `itemId=t.<e164>` and `calls?a=nc,<e164>` forms are community-known and
**unverified** — the UI also copies the number and message to the clipboard so it never depends on
them. The app cannot know a text was sent, so every Call/Text/Email click opens a one-tap outcome
prompt (Reached / No answer / Left message) that logs the touch and resets the timer.

## 2026-10-23 — reminders

One endpoint, `POST /api/cron/reminders`, bearer-authed with `CRON_SECRET`, called hourly by an
external scheduler (not GitHub Actions — CI minutes cost money). It sends one Resend digest per user
at their local `digest_hour`, idempotent via `reminders_sent (user_id, kind, for_date)`. Resend free
tier: 100/day, 3,000/month, which is far above one user's digest. Vercel Hobby cron is daily-only,
so it cannot be the hourly trigger.

## 2026-10-23 — booked calls get their own "get ready" email

The same hourly job also emails a short heads-up for any booked call starting within 90 minutes (so a
3:30 call is caught by the 2:00 run): who, phone, what he wants, other advances, and the last call note.
One email per booking — rebooking to a new time sends a fresh one. Same claim-before-send rule as the
digest. It shares the digest on/off switch; add a separate switch only if Isaac asks.

## 2026-10-23 — import is part of v1

Not in the owner's list, added because Isaac already has clients: day one without import is hand-typing
them. Re-importing the same file never duplicates (matched by phone, or by business name when there is
no phone). Funded and default clients cannot be imported as such — they need advance terms — so they
land in "Name in" with an "Imported status: Funded" note for Isaac to finish.

## 2026-10-23 — MCA language is enforced by a test

`tests/language.test.ts` fails if visible UI text says loan, lender, borrower, installment, interest
rate, principal, APR, amount due, customer, or "payment" (use remittance). Identifiers such as
`paymentCents` may keep their names.

## 2026-10-23 — every page loads every client in one query (and where that stops working)

Today, Board, Renewals, Long game and Clients all read `client_cards` once and filter in memory.
Measured on 5,000 synthetic clients (30,000 notes/calls, 5,000 timers, 2,000 positions), as the
restricted `isaac_app` role with RLS on, `to_jsonb` of every row forced:

- first (cold) query: **3.0 s**; warm: **0.36 s**; payload **6.5 MB**
- command: create `isaac_bench`, `pnpm db:migrate`, bulk-insert with `generate_series`, then time
  `select count(*), sum(length(j::text)) from (select to_jsonb(c) j from client_cards c order by c.next_due_on nulls last, lower(c.business_name)) x`
  after `set local role isaac_app` and `set_config('app.user_id', …)`. (Read the user id BEFORE
  switching role — RLS hides `app_users` from `isaac_app` until the id is set.)

Fine for Isaac's size (hundreds, maybe a couple of thousand). **Past ~3,000 active clients** the board
should load per-column and the payload should drop columns the board doesn't draw. Do that when the
number is real, not before.

## 2026-10-23 — "stop" means stop (do-not-contact)

`clients.contact_status`: ok / no_text / no_call / no_email / dnc, set only through `set_contact_status()`.
The Call/Text/Email buttons are disabled with the reason, AND `logTouch`/`sendEmailAction` refuse on the
server, so a stale tab can't contact someone who said stop. `dnc` cancels every timer and booked call and
leaves one review reminder 36 months out (a client always has a next date); Today and the morning email
skip them. Imports never create a lead from a row marked do-not-call. Texting before 8 AM or after 9 PM
in the merchant's state shows a warning (a warning, not a block — and unknown states warn about nothing).
Not built: consent source/date capture and a daily text counter (Google Voice may throttle bulk-looking
texting; counsel should confirm TCPA posture for one-to-one texts to sole proprietors).

## 2026-10-23 — a booked call is an appointment, not a timer

`scheduled_call` timers survive a stage move and a snooze. A logged _call_ near the booked time closes
it; a stale one is closed by the next stage move; `cancel_call()` clears it. Snoozing pushes an earlier
funded check-in/renewal out to the snooze date and NEVER deletes a later renewal call — losing the renewal
timer silently was the worst bug the review found.

## 2026-10-23 — short timers are business days

Stage defaults of 1–3 days are business days (a Friday "tomorrow" is Monday). 7 and 14 are calendar days.
After a logged touch, "Reached" suggests the stage's own pace (Contract out stays next business day)
capped at two weeks, not a flat 14 days.

## 2026-10-23 — delete is a trash, not a one-tap wipe

"Delete client" used to remove a merchant and every note, offer and funded advance at once. Now it moves the
client to the trash (`trashed_clients`, migration 0040): hidden from `client_cards`, every timer closed so no
reminder can fire, history kept. Restore reopens the follow-ups the trash closed (a funded merchant keeps its
renewal call); anything already past due, and a booked call, are not reopened — if nothing is left, one
follow-up a week out (36 months for do-not-contact). "Delete forever" only works from the trash and needs a
second click. A separate table, not a column, because `client_cards` expands `c.*` and a new column would
reorder it. New code reads merchants through `client_cards` (rule added to `docs/CREW-RULES.md`).
No automatic purge: merchant data stays until the owner empties it, and that is his call.

## 2026-10-23 — "log out everywhere"

`app_users.session_epoch` (migration 0050); a session token carries the epoch it was issued under and
`getSession` compares it on every request (one indexed read, cached per request). Bumping it signs out every
device; a deleted user's tokens die the same way. The app role can read the column but has no UPDATE on it.
Cost: one extra small query per request. Removing someone from `ALLOWED_EMAILS` still ends their session too.

## 2026-10-23 — hosted Postgres roles are locked out

Migration 0060 revokes table access from the `anon` and `authenticated` roles when they exist (Supabase
creates them and auto-grants new tables to them, which an HTTP data API can serve). This app reaches the
database only through its own server. Recommendation in `docs/DEPLOY.md`: Neon (plain Postgres) is the
simpler fit. Schema usage and function execute stay with PUBLIC as in any Postgres — without table access
they do nothing. Not verified against a real Supabase project.

## 2026-10-23 — lead source is first-class

Reports compare lead sources, so the source must be filled in and consistent. Import stamps every row with
the sheet's source column, else the list name typed in the wizard ("Lead vendor, Oct 2026"), else
"Imported". Add client and Edit details suggest sources already in use (so "Referral" and "referral" stay
one — reports also group case-insensitively), and Add client remembers the last source for batch entry.

## 2026-10-23 — funders, submissions and offers (migration 0010)

Isaac submits merchants to outside funders, so "Offers in" now has somewhere to put offers. `funders` (name,
states they skip, minimum revenue and time in business, industries they exclude, notes), `submissions` (one
per merchant × funder: sent date, status, decline reason) and `offers` (terms per submission). A fit check
before sending flags a funder that excludes the merchant's state, industry, revenue or age — a warning, never
a block, and "unknown" when the merchant's field is blank. Sending creates a `chase` timer per funder for the
next business day; merchant contact (a call, text or email) does NOT clear a chase — only the funder's answer
does. A late approval moves a Declined deal back to Offers in. Accepting an offer opens the Funded dialog
pre-filled and does NOT fund by itself; "Mark funded" writes the advance. Funders hold business contacts only,
free text goes through the sensitive-data guard, and every table is row-level secured. A manual stage move from
the Board closes chase timers (existing `replace_timers` behaviour); the card offers "Remind me to chase".

## 2026-10-23 — lead intake (migration 0080)

`POST /api/leads` with a per-connection bearer token adds a merchant as "call now" (due today). Speed to lead
is the metric in this business and a CSV is too slow. Tokens are 256-bit random, shown once, stored only as
SHA-256 (`lead_tokens`; the app role can't even select the hash column). A token can only add a merchant to its
owner's account and cannot read the CRM — but its reply does say whether a phone number is already on file
(`created` vs `duplicate`, the card id, and `doNotContact`), and a duplicate adds a note and moves that merchant's
follow-up to today (review-3A A-10; accepted: the caller already holds the number, and answering both the same way
would hide a real duplicate from a form that wants to say "we already have you"). Limits: 30 a minute per token (counted on the row, refused tries included),
20 KB body, a phone or email required, SSN/card guard on notes, unknown fields ignored (no setting a stage or
owner). A merchant already in the CRM is not duplicated: note + follow-up today, and do-not-contact merchants
only get the note. Revoking, removing the owner from `ALLOWED_EMAILS`, or deleting the user kills the token at
once. Not built: instant email/push on a new lead, hosted form page.

## 2026-10-23 — money-first ranking and the power dial

Today orders overdue and due-today by a score: dollars at stake × stage weight × an overdue bonus. Pipeline deals
use the smaller of what he wants and what funders would approve; defaults use payback outstanding at the default
date; renewals use the funded amount (a paid-in-full merchant would score $0 on payback). Unknown amounts count as
$5k; the cap is $2M. The ranking is a tool, not a rule: the page can be flipped to oldest-first. The ★ star is per
browser (a cross-device star needs a `clients.hot` column). Bulk "reschedule all overdue" is one transaction
(all-or-nothing), skips do-not-contact merchants and clients whose overdue timer is a passed booked call or a
funder chase, and does not count as a snooze. Snoozing an underwriting deal past a week asks for a one-line
reason — it never blocks. The reminder heartbeat (`job_runs`, system-only) is recorded only when a run sent
without failures, and the cron route answers 502 otherwise so the scheduler alerts too.

## 2026-10-23 — earnings and editable advance terms (migration 0020)

Advance terms are editable in place (`update_funding_terms`), never re-funded: a typo fix must not mark the first
advance "renewed" and corrupt the renewal timers. Only the LATEST active advance's renewal timer is re-derived
(DB and TypeScript agree on the date across 600 random terms, tested); editing a past advance moves nothing.
Average points = plain mean of commission ÷ amount across advances with commission above $0. "Awaiting
commission" counts only advances funded in the last 90 days. Defaulted advances are excluded from expected
commission. The pipeline estimate covers Offers in, Offer presented and Contract out and says "estimate" with the
formula. The renewal timer stays at 50% paid down (matches `record_funding`); the radar's threshold is `?min=`,
then the funder's own `renewal_paydown_pct`, then 50. Trashed merchants are excluded from every money figure,
and the trash dialog says so.

## 2026-10-23 — messaging, snippets and note hints (migration 0030)

Signature and application link are plain columns on `app_users`; snippet bodies, the signature and the link go
through the SSN/card/account guard. Merge fields never go silently blank: an unknown `{field}` stays visible and
disables Send. Note hints are rules, not AI: "call Friday", "after the 15th", "after tax season" produce
one-tap chips and NEVER change a date without a tap; a note with no date gives nothing. The win-back list excludes
anyone with a contact limit entirely. The "texts today" counter is per browser — a soft warning, not enforcement.
The calendar file (.ics) is built by hand and tested for folding, escaping and DST.

## 2026-10-23 — zod runs without eval

Zod compiles object parsers with `new Function` and the production CSP forbids eval, so the browser logged a
"script-src eval" violation on every page with a form (found by the production-build smoke test: Client page,
Funders, Settings, the Add-client dialog). Harmless but noisy. `src/lib/zod-setup.ts` sets `jitless` and is the
first import of every schema file the browser loads; `tests/zod-csp.test.ts` fails if one forgets. The CSP keeps
`script-src 'self' 'unsafe-inline'` with no `unsafe-eval`. Verified on a real production build: 15 pages, the
Add-client dialog and the ⌘K palette — zero violations. (Command: `scratchpad/prod-smoke.mjs`, a minted session
against `next start`; build made in a copy so the dev server's `.next` is untouched.)

## 2026-10-23 — instant lead alert and the Monday scorecard (migrations 0100, 0110)

Two more emails on the same claim-then-send table (`reminders_sent`), so a retry or two overlapping hourly runs
can't send one twice and a failed send rolls its claim back. **New-lead alert:** sent by the lead-intake route
after the lead is saved; never fails the request; at most 20 a day per user; off when the reminder switch is off;
proven on a production build with a failing Resend key (lead saved, failure logged, no claim left). **Monday
scorecard:** the user's own Monday, after their digest hour, covering Mon–Sun before: follow-ups done on time /
late / pushed back / overdue (same definitions as Reports), merchants added, advances funded, commission
received, and the five biggest overdue deals to start with. Facts only — no targets, no scolding. Gathered
through row-level security (`withUser`), trashed merchants excluded, do-not-contact merchants left out of the
"start here" list. The cron route answers 502 if any of the three email jobs failed.

## 2026-10-23 — performance at 5,000 merchants, and JIT is off

Measured on a PRODUCTION build against one user with 5,000 merchants, 20,000 timers, 1,190 advances
(`psql -f scripts/bench/seed-5k.sql`, then `node scripts/bench/pages.mjs`; three requests per page, server and
Postgres on the same small machine, other work running at the same time):

| page          | before (JIT on) | after (JIT off) | HTML  |
| ------------- | --------------- | --------------- | ----- |
| Today         | 1.8–2.5 s       | 1.1–1.25 s      | 3.9MB |
| Board         | 1.3–1.5 s       | 0.65–0.9 s      | 8.3MB |
| Clients       | 1.9–2.1 s       | 0.85–0.94 s     | 11 MB |
| Renewals      | 1.5–1.6 s       | 0.8 s           | 4.8MB |
| Earnings      | 1.3–1.7 s       | 0.8 s           | 3.9MB |
| Reports (90d) | 0.13 s          | 0.1 s           | —     |
| Win-back      | 0.12 s          | 0.05–0.09 s     | —     |

Cause: Postgres JIT-compiles the card-list query (`client_cards`, many correlated subqueries) and the compile
costs more than the query. `EXPLAIN ANALYZE select to_jsonb(c) from client_cards c`: 1.04 s with JIT, 0.27 s
without. Every request now runs `set local jit = off` (`tests/db-settings.test.ts`). Still heavy at that size:
Clients ships every merchant (11 MB) — fine for hundreds, slow on a phone at thousands. Next step if it matters:
page the Clients list and slim the card payload. Reports and win-back stay fast because they aggregate in SQL.

## 2026-10-23 — second review round (docs/REVIEW-3B.md): what changed

- **Do-not-contact is enforced where it is read:** the morning email, the booked-call email, the Today badge and the
  Monday scorecard all skip a do-not-contact merchant, whatever timer a later drag or "set follow-up" gave them.
  (The database still allows the timer; refusing it there would also block moving a merchant to "Not interested".)
- **Off the allowlist means off the email too:** the three email jobs skip anyone not on `ALLOWED_EMAILS` (the
  cron route passes the same rule sign-in uses). The unit tests call the jobs without a rule, so they serve everyone.
- **A booked call today is an appointment** however it ties with an older follow-up: Today and the dial classify by
  `scheduled_call_at` in the user's time zone, show "Call at 3:00 PM", and replace Snooze (which can't move an
  appointment) with "Move the call".
- **Bulk reschedule keeps each follow-up's reason.** Only a follow-up with no note gets "Rescheduled in bulk".
- **Leaving do-not-contact** replaces the 36-month review timer with a follow-up a week out.
- **A text with an unfilled `{field}` can't be sent**, the same rule email already had.
- Not changed: the snooze-reason question still isn't asked on a Board drop, the Set-follow-up button, note chips or
  win-back "Not now" (it never blocks; it only asks). Recorded in the backlog.

## 2026-10-23 — third review round (docs/REVIEW-3A.md): what changed

- **Renewal list and forecast only count calls he can make.** Merchants who said no or went elsewhere (exit
  stages) and do-not-contact merchants are left out of the radar, its dollar total and the Earnings forecast; the
  forecast also leaves out merchants already in a funding deal (the Pipeline tile prices them). Both pages say how
  many were left out. A merchant working a renewal deal stays on the radar — that is the renewal in progress.
- **Price book: a sample is merchants, not prices.** An offer he took and then funded counts once (as the advance).
  The average needs prices from three different merchants. (No `offer_id` on fundings: matching on merchant +
  amount + factor is the same thing without a schema change.)
- **Correcting a funded date:** "latest advance" is judged on the row as it was. A date change that would swap
  which advance is current is refused when other things change in the same save, and goes through as the only change
  (the Funding dialog now sends only what he changed, so that is one click away).
- **A stale Funding dialog can't erase money recorded elsewhere:** the dialog sends only the boxes he changed.
- **Undo accept brings the other offers back** (`offers.declined_by/declined_from`); an expired offer, one he turned
  down himself, or one from a funder that said no can't be accepted. Switching straight from one accepted offer to
  another still works.
- **One lock order everywhere (the client first)** — the record_default / update_funding_terms deadlock is gone
  (40 parallel rounds: 3 of 3 runs failed before, 0 after; `tests/review-3a.test.ts`).
- **Default date:** re-entering a default stage saves the date he gives (QA I-2).
- **Payback rounds half-up on integers**, the same as the database column (a $1,385 × 1.251 advance was 1¢ apart).
- **Lead token:** daily cap of 200 new merchants per token (migration 0140), a timeline line on every card it adds,
  and the docs no longer say it "reads nothing" — it can tell a sender whether a phone number is on file.
- **Duplicate names are compared as ASCII letters and digits in both TypeScript and SQL**, so the check no longer
  depends on the database's locale. A name with no ASCII letter or digit (e.g. all Chinese) is matched by phone only.
- Not changed (recorded in BACKLOG): A-11 (three definitions of "when to call about a renewal"), A-13 (a trashed
  merchant's advance can still be edited from a stale tab), A-14, A-17 (RLS keyed on a setting the app role can
  change — the app role never receives user input as SQL), A-19..A-22.
