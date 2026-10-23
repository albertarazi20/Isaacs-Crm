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
