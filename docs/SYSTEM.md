> Scope changed on 2026-11-16 (docs/FOLLOW-UP-SYSTEM.md): the CRM brings interested merchants in and stops at the
> hand-off. Deals, lenders, money, win-back and trust are out of the app; their tables are left in the schema, unused.

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
  rep's session cannot read another rep's merchants even if a page has a bug; managers see the floor. Two roles are
  offered: rep and manager. The RLS-bypassing connection
  (`withSystem`) exists only for scheduled jobs and public token pages, and a test fails the build if any other file
  uses it.
- **Amounts are integer cents** end to end (what a merchant says they want is the only money the CRM keeps).
- **AI is boxed.** Claude tags merchants' replies, splits pasted lead lines and runs the assistant. It never sends
  mail and never writes a record by itself. The assistant (Claude Opus 5.5, `src/lib/assistant/`) reads the CRM through
  read-only tools that run under the person's own row security, and proposes actions (set a follow-up, add a note,
  hand off, pause, move to a bucket, copy a message, open a page) that are checked twice, once when proposed and again
  by the app's own server action when the person clicks; nothing happens without the click. One switch turns AI off;
  a daily spend cap (counted shop-wide) stops a runaway; every model call is logged in `ai_runs`. Conversations are
  private to the person (`assistant_threads`, owner-only row security).

## 2. The jobs (an outside scheduler calls each with `Authorization: Bearer <CRON_SECRET>`)

| Job                   | How often         | What it does                                                                                                          |
| --------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `/api/cron/outbox`    | every few minutes | Sends whatever is due (inside each merchant's local window, under the cap), scans uploads                             |
| `/api/cron/inbox`     | every few minutes | Reads the reps' Gmail for merchant replies and tags them, alerts the rep, counts mail sent outside the CRM to the cap |
| `/api/cron/sheets`    | every few minutes | Pulls the connected lead sheets and files new rows into their bucket                                                  |
| `/api/cron/nightly`   | hourly            | The statement clock (asks for a month that came due), each bucket's next step, the nudge after an open (when on)      |
| `/api/cron/reminders` | hourly            | Morning brief, call reminders, weekly scorecards, the alert email                                                     |

Each job records a heartbeat; the app shows a banner when one has gone quiet.

## 3. The outside services (each optional until configured)

| Service   | Used for                                                                                |
| --------- | --------------------------------------------------------------------------------------- |
| Google    | Sign-in; Gmail send and read (the manager mailbox); Sheets read                         |
| Resend    | The automation sending domain, inbound mail, delivery events (bounces, complaints)      |
| Anthropic | The AI uses listed above                                                                |
| Supabase  | The hosted Postgres; Storage for private document files (a local folder in development) |

## 4. The data, in one breath

The merchant is the centre: timers (the follow-up list), activities (the timeline), the document checklist (stips)
and the documents themselves (uploads, auto-labelled, scanned), the bucket enrolment (the follow-up sequence and
where it stands), inbound emails and their reply tags, the signed application, link opens (the hot signal), the
outbox (every automated email), the hand-off stamp (`brought_in_at`), the assistant's conversations and the alert
feed. Shop-level settings hold the send cap and windows, the automation domain and postal address, the nudge switch,
and the AI model and spend cap. All of it is in `db/migrations` (0001–0550); each migration applies in its own
transaction. Tables from the removed features stay in the schema, unused.

## 5. What runs by itself

- **Lead intake:** welcome email in seconds with upload and application links; bucket placement; time zone from the
  state or area code; duplicate and ownership check across reps (placeholder emails match nothing); a "call now"
  task; consent and opt-out recorded.
- **Follow Up:** each bucket's sequence at the merchant's local 9 to 11; one automated email per merchant per day;
  stops the moment they reply, upload, sign, opt out, bounce, pause or are handed off; moves between buckets as
  documents arrive (and back when a file is deleted, relabelled or fails the safety scan); "Ready to hand off" when
  the file is complete; a call task after three silent emails; Cold after the sequence; replies tagged (interested,
  sending docs, not now with a revive date, stop, wrong person); a bounce makes a task to get the right address; a
  template pauses itself on a bounce spike. Emails can name exactly what is missing (`{missing_docs}`).
- **Signals:** a merchant keeping their upload link or application open is an "Opened link" in Do this now (a
  signed-in rep looking is not); "Most active" sorts the list by the merchant's own last move; the nudge after an
  open sends the link again a day later when a manager has switched it on.
- **The statement clock:** when a new month's statement becomes due, merchants being chased for documents are asked
  for it and the oldest month still missing drops off.
- **Sending:** a per-mailbox cap (CRM and outside mail counted), a slice held for intake and replies, the legal
  footer and one-click unsubscribe, a claim checker (no "approved" without an offer, no "guaranteed"), and a DNS
  check before the automation domain is used.
- **The assistant:** Claude Opus 5.5 reads the CRM under the person's row security and proposes actions as buttons;
  nothing happens until the person clicks; every call is counted against the daily AI budget.

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
| Assistant    | all                    | A side panel (⌘J, the sparkles buttons): Plan my day, recommendations, answers read from the CRM, and action buttons that wait for a click   |
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
five scheduler entries above, and the shop's postal address (automated mail waits without it). The nudge after an
open is off until a manager switches it on (Settings > Email). Two Supabase statements the migration tool refuses to
run unattended are in `BUILD-NOTES.md` ("Automations pass"). Texting and calling are parked by the owner and are not
in this build.
