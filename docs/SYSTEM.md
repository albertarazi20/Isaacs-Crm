> Scope changed on 2026-11-16: see docs/FOLLOW-UP-SYSTEM.md; the deals, lenders, money, win-back and trust parts below are removed from the app.

# Selective CRM — how the system is built

For the owner, for the next engineer, and for the lawyer who asks "where does this data go". It says what runs
where, what runs by itself, what each screen is for, and what protects the data. The plan it implements is
`FINAL-BUILD-PLAN.md`; what was built against it, item by item, is `docs/AUTOMATION-AUDIT.md`; the look is
`docs/DESIGN.md`; going live is `docs/OWNER-TODO.md` and `docs/DEPLOY.md` (read their notes: they were written for
the original Isaac deployment, and this repo uses its own Supabase project).

## 1. The shape

- **One web app** (Next.js 16, React 19, TypeScript, Tailwind 4) and **one Postgres database**. Every page is
  rendered on the server from the database. Buttons call server actions. The browser never talks to the database.
- **The database enforces who sees what.** Every row has an owner. Row-level security (role `isaac_app`) means a
  rep's session cannot read another rep's merchants even if a page has a bug; ops see the deals sent to them;
  managers see the floor. Three roles: rep, ops, manager (admin is a manager). The RLS-bypassing connection
  (`withSystem`) exists only for scheduled jobs and public token pages, and a test fails the build if any other file
  uses it.
- **Money is integer cents** end to end. A confirmed funding's terms never change in place; a correction is a new
  dated line.
- **AI is boxed.** Claude tags merchants' replies, splits pasted lead lines and runs the assistant. It never sends
  mail and never writes a record by itself. The assistant (Claude Opus 5.5, `src/lib/assistant/`) reads the CRM through
  read-only tools that run under the person's own row security, and proposes actions (set a follow-up, add a note,
  hand off, pause, move to a bucket, copy a message, open a page) that are checked twice, once when proposed and again
  by the app's own server action when the person clicks; nothing happens without the click. One switch turns AI off;
  a daily spend cap (counted shop-wide) stops a runaway; every model call is logged in `ai_runs`. Conversations are
  private to the person (`assistant_threads`, owner-only row security).

## 2. The jobs (an outside scheduler calls each with `Authorization: Bearer <CRON_SECRET>`)

| Job                   | How often         | What it does                                                                                                                                                            |
| --------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/cron/outbox`    | every few minutes | Sends whatever is due (inside each merchant's local window, under the cap), scans uploads                                                                               |
| `/api/cron/inbox`     | every few minutes | Pulls lender mail, matches it to a deal, reads it, applies or proposes; counts mail sent outside the CRM toward the cap; tags merchant replies; nudges quiet lenders    |
| `/api/cron/sheets`    | every few minutes | Pulls the connected lead sheets and files new rows into their bucket                                                                                                    |
| `/api/cron/nightly`   | hourly            | Bucket and win-back steps, deal clocks (approvals expire, the new month's statement is requested), money clocks (clawback, renewals), rescue nudges, document retention |
| `/api/cron/reminders` | hourly            | Morning brief, call reminders, weekly scorecards, the alert email, month-end close                                                                                      |

Each job records a heartbeat; the app shows a banner when one has gone quiet.

## 3. The outside services (each optional until configured)

| Service   | Used for                                                                                |
| --------- | --------------------------------------------------------------------------------------- |
| Google    | Sign-in; Gmail send and read (the manager mailbox); Sheets read                         |
| Resend    | The automation sending domain, inbound mail, delivery events (bounces, complaints)      |
| Anthropic | The AI uses listed above                                                                |
| Supabase  | The hosted Postgres; Storage for private document files (a local folder in development) |

## 4. The data, in one breath

Merchant → many deals → each deal has submissions to lenders → offers → one funding (FUND; a manager confirms) →
commission ledger lines (plan splits, clawback window, month-end statements). Around the merchant: timers (the
follow-up list), activities (the timeline), documents (uploads, auto-labelled, watermarked), bucket enrolments
(follow-up sequences), win-back memberships, inbound emails and the AI's proposed updates, the signed application,
the access log (who viewed or copied what), and the alert feed. Shop-level settings hold the send cap and windows,
the automation domain, the lender limit per deal, approval validity, commission plans, state rules and
registrations, and the AI model and spend cap. All of it is in `db/migrations` (0001–0531); each migration applies
in its own transaction.

## 5. What runs by itself

- **Lead intake:** welcome email in seconds with upload and application links; bucket placement; time zone from the
  state or area code; duplicate and ownership check across reps; a "call now" task; consent and opt-out recorded.
- **Follow Up:** each bucket's sequence at the merchant's local 9 to 11; one automated email per merchant per day;
  stops the moment they reply, upload, sign, opt out, bounce, pause or are deleted; moves between buckets as
  documents arrive; "Ready for ops" when the file is complete; a call task after three silent emails; Cold after the
  sequence; replies tagged (interested, sending docs, not now with a revive date, stop, wrong person); a bounce
  makes a task to get the right address; a template pauses itself on a bounce spike.
- **Sending:** a per-mailbox cap (CRM and outside mail counted), a slice held for intake and replies, the legal
  footer and one-click unsubscribe, a claim checker (no "approved" without an offer, no "guaranteed"), and a DNS
  check before the automation domain is used.
- **Deals:** send to lenders with the deal ID and watermarked document links; chase quiet lenders in business hours;
  lender replies read into statuses (stips become a checklist and a merchant email, approvals alert the rep, a funded
  email proposes the funding, a portal link becomes a manager task); approvals expire on the lender's clock; declines
  go to reshop or win-back; double-submission and shotgun guards; undo for any AI update.
- **Money:** FUND maths with lender caps and a state checklist; manager confirmation; ledger lines; clawback
  clocks; renewal warm-up and eligibility emails; month-end close with a statement per rep; late lender payouts
  flagged.
- **Win-back:** five pools fill themselves; rescue nudges on days 20, 25 and 29; a changing-angle sequence with an
  AI first line; a hot list on replies and link opens.
- **Trust and compliance:** every contact view and copy logged; canary merchants; watermarked documents; manager
  alerts on odd copy patterns; one-click offboarding with a 30-day report; logged exports; state badge and
  warnings; registration reminders; dead-deal documents purged after the retention period; a first-login policy.

## 6. The screens

Rebuilt on 2026-11-16 for the follow-up scope (the look is `docs/DESIGN.md`). Reps and managers see the same four
places in the left sidebar (`src/lib/nav.ts`), each a dropdown; a phone gets a top bar whose menu button slides the
same sidebar in, and bottom-sheet dialogs.

| Screen       | For                    | What it is for                                                                                                                               |
| ------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview     | all                    | Brought in, new leads, replies and docs this month; what needs a person now, ranked; the funnel; the buckets; 8 weeks; the team (managers)   |
| New lead     | all                    | Not a page: a sheet any "New lead" button (or the N key) opens over the page. Phone first, sheet lookup, paste a lead line, rows from sheets |
| Follow Up    | all                    | The all-buckets board; a bucket's workspace (its sequence, its members, search, bulk actions, a merchant sheet, Hand off)                    |
| Merchants    | all                    | The whole book with filters; the call list; power dial; import a file; trash                                                                 |
| A merchant   | all                    | The hero, the "bringing them in" strip with Hand off, notes and timeline, next follow-up, documents, application                             |
| Settings     | all, managers see more | My account, buckets and templates, lead sources (Google Sheets and web lead connections), email, team, AI assistant                          |
| Alerts       | all                    | What the automations wrote for you, by day                                                                                                   |
| Public pages | merchants              | Upload link, application, unsubscribe (the token is the key, no sign-in)                                                                     |

## 7. How to run it

```bash
export PATH=~/.local/bin:/usr/local/bin:$PATH
pnpm install --frozen-lockfile
pnpm db:migrate            # DATABASE_URL in .env.local; local Postgres 17 on :5433, database isaac_dev
pnpm dev                   # http://localhost:3000; log in at /api/dev-login?email=qa-manager@example.com
pnpm -s typecheck && pnpm -s lint && pnpm -s format:check
pnpm -s vitest run         # each test file builds its own migrated database
pnpm -s build              # the CI build
CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node e2e/run.mjs   # browser suites, local only
```

CI runs only the unit tests and the build. The browser suites run locally, driven in Chrome; they read the database
after every action, because a 200 is not proof.

## 8. Before it goes live

Everything the owner has to supply is in `docs/OWNER-TODO.md`: the Google OAuth app, Resend with its DNS records
and webhook secret, the Anthropic key, the Supabase Storage bucket `documents` with its service key, hosting and the
five scheduler entries above, and the shop's postal address (automated mail waits without it). Per-lender facts
(approval validity, clawback days, renewal threshold) go in the lender list. Two Supabase statements the migration
tool refuses to run unattended are in `BUILD-NOTES.md` ("Automations pass"). Texting and calling are parked by the
owner and are not in this build.
