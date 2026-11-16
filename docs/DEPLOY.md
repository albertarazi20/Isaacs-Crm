# Deploying Selective CRM on Netlify (your own account)

This is the current route for this repo (`albertarazi20/isaac-work`, Supabase project `aztoxzcmnvqaypjuuuwj`). The
older sections below were written for Ronny's Isaac deployment and stay for reference. Never touch Ronny's site or his
Supabase project.

## What runs where

- The app: Netlify builds it from GitHub with its zero-config Next.js adapter (`next build`; Node 22 from
  `netlify.toml`). Nothing to install or pin.
- The five scheduled jobs: Netlify scheduled functions in `netlify/functions/cron-*.mts` call the app's own
  `/api/cron/*` routes with the bearer secret (outbox and inbox every 5 minutes, sheets every 10, nightly and
  reminders hourly, all in UTC). They fire only on the published production deploy, so nothing else to schedule.
- The database: the Supabase project, already migrated through 0531.

## Steps

1. **Create the site and link the repo.** The site can be created by Claude in your Netlify account; you link the
   repo once in the dashboard: Project configuration → Build & deploy → Continuous deployment → Link repository →
   GitHub (authorize the Netlify app for `isaac-work`) → branch `main`. Keep the detected build settings.
2. **Set the environment variables** (Project configuration → Environment variables; scope **Builds and Functions**;
   mark the secrets as secret). Values change only at the next build, so redeploy after editing.

   | Name                                                     | Value                                                                                                           |
   | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
   | `APP_URL`                                                | the site's address, `https://<name>.netlify.app`, no trailing slash                                             |
   | `SESSION_SECRET`, `TOKEN_ENC_KEY`, `CRON_SECRET`         | random strings (Claude can set these)                                                                           |
   | `DATABASE_URL`                                           | Supabase → Connect → **Transaction pooler** (port 6543) with the database password, ending `?sslmode=no-verify` |
   | `ALLOWED_EMAILS`                                         | the sign-in addresses, comma separated; the first one is who the passcode signs in as                           |
   | `ACCESS_PASSCODE`                                        | 12+ characters you choose; lets you sign in before Google is set up                                             |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `DOCS_BUCKET`    | `https://aztoxzcmnvqaypjuuuwj.supabase.co`, the service key from Supabase → Settings → API, and `documents`     |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`               | from the Google Cloud OAuth client (redirect URI `<APP_URL>/api/auth/callback`)                                 |
   | `RESEND_API_KEY`, `RESEND_FROM`, `RESEND_WEBHOOK_SECRET` | from Resend, once the domain's DNS records pass                                                                 |
   | `ANTHROPIC_API_KEY`                                      | from the Anthropic console                                                                                      |

   Leave `DEV_LOGIN` unset: dev login is impossible in production anyway.

3. **Deploy** (Deploys → Trigger deploy). Sign in with the passcode, then check Settings → Email & lenders (the DNS
   check) and the Functions tab (the five `cron-*` functions and their last runs).
4. A custom domain, when you want one: Domain management → Add a domain, then update `APP_URL`, the Google redirect
   URI and the Resend webhook, and redeploy.

---

# Deploying Isaac (the original notes)

> **isaac-work note (2026-11-15):** this file describes Ronny's original Isaac deployment (Supabase `vngxqywqqdmucvcdjfec`, Netlify `mca123`). This repo uses Supabase project `aztoxzcmnvqaypjuuuwj`. Never run anything against the Isaac project or site. See `CLAUDE.md`.

Partly done (2026-11-15): the database is live with all 31 migrations, and a Netlify site `mca123` builds this repository (merging to `main` deploys it).
Everything marked **(unverified)** is from provider docs, not from running it. Claude does not create accounts or spend money; the owner does
that and tells Claude the names.

## 1. Separate accounts from BH

New hosting project, new database, new Google Cloud project, new Resend domain. Nothing shared with BH.

## 2. Database — Neon is the simpler fit (recommendation)

- Plain Postgres 15+. No HTTP data API that exposes tables. The app only ever talks to it from its own server.
- Supabase also works. Migration `0060_lock_hosted_roles.sql` revokes the `anon`/`authenticated` roles it
  auto-grants, so its data API can't serve merchant data. Supabase also switches row-level security on for every new table; `0230_stages_readable.sql` keeps the shared `stages` table readable under that. Still: do **not** put the Supabase anon key in this app.
- Two connection strings (**unverified** on Neon's exact names):
  - **Direct** (no pooler) for `pnpm db:migrate`. Migrations hold an advisory lock, which needs a session connection.
  - **Pooled** for the running app. Every request is one transaction (`begin … set local role … commit`), which
    works with transaction-mode pooling.
- **Supabase, as deployed (2026-10-25):** the project holds all 31 migrations. The running app uses the **Transaction
  pooler** (port 6543) and ends the string with `?sslmode=no-verify`: Supabase's pooler certificate does not chain to a
  public authority, so `sslmode=require` fails verification (unverified until a live connect) and no `sslmode` means no
  encryption. `no-verify` is encrypted but does not prove who answered; the hardening is to pass Supabase's CA in code
  (backlog). Run later `pnpm db:migrate` against the **Session pooler** (port 5432) or the direct host from a laptop,
  never port 6543: migrations take a session-level lock. Copy the host from the dashboard (newer projects say `aws-1-…`)
  and URL-encode the password.
- The connecting role must be allowed to `create role` once and `set role isaac_app` (the first migration does both).
  Use the project's owner role, not a read-only one.
- Row-level security is the wall between merchants. The app role `isaac_app` cannot bypass it. Never connect the
  app as a superuser for requests: `withUser` always drops to `isaac_app`; `withSystem` is confined to
  `src/lib/system/**`, `src/lib/db/**` and `src/app/api/**` (a test enforces that). Every request does read one
  small row that way (the "sign out everywhere" epoch), so the owner connection is used for that lookup only.

## 3. Environment variables (host dashboard, never git, never chat)

| Name                             | Value                                                                                                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                   | pooled connection string, with `?sslmode=no-verify` on Supabase (see section 2)                                                                                               |
| `SESSION_SECRET`                 | 32+ random characters (`openssl rand -base64 48`)                                                                                                                             |
| `TOKEN_ENC_KEY`                  | `openssl rand -base64 32` — encrypts the stored Gmail token                                                                                                                   |
| `APP_URL`                        | the public https URL, no trailing slash                                                                                                                                       |
| `ALLOWED_EMAILS`                 | Isaac's Google address only (each address gets its own empty account)                                                                                                         |
| `GOOGLE_CLIENT_ID` / `_SECRET`   | from the new Google Cloud project; redirect URI `APP_URL/api/auth/callback`                                                                                                   |
| `RESEND_API_KEY` / `RESEND_FROM` | Resend key; sender on a verified domain, or `onboarding@resend.dev` if the Resend account was created with Isaac's sign-in email (it only delivers to that one address)       |
| `CRON_SECRET`                    | 16+ random characters                                                                                                                                                         |
| `ACCESS_PASSCODE`                | optional, 12+ characters. Adds a passcode box to /login that signs in as the first `ALLOWED_EMAILS` address. Use instead of Google; anyone with the passcode gets full access |
| `DEV_LOGIN`                      | **leave unset.** It is ignored in production and unless `APP_URL` is localhost                                                                                                |

## 4. Scheduler

Vercel's free cron runs at most daily. Use a free external scheduler (e.g. cron-job.org) to call
`GET APP_URL/api/cron/reminders` every hour with header `Authorization: Bearer <CRON_SECRET>`.
The app shows a red banner if the scheduler stops (heartbeat).

## 5. First run — Claude does this once you hand over the names

1. `pnpm db:migrate` against the direct URL. Expect every file in `db/migrations/` applied, no errors.
2. Open the app, sign in as Isaac. Wrong Google account must show "not allowed".
3. Add a client, move it, log a call. Check the database rows changed.
4. Settings → "Send me a test email". Check the email arrives (and isn't in spam).
5. Connect Gmail, send a test email to yourself.
6. Wait for the scheduler's first hourly call; the heartbeat banner must not appear.
7. Import Isaac's CSV (Clients → Import).
8. On Isaac's phone: tap Text on a test client and report what opens.

After the first deploy, from any machine: `node scripts/smoke-live.mjs <APP_URL>` checks the public surface with no login
(redirect to /login, Google redirect URI exact and the state cookie HttpOnly and Secure, headers, private routes refuse
strangers, dev login off). Add `--run-cron` with `CRON_SECRET` in the environment to run the reminder job once for real.

## 6. Backups

**(unverified)** Neon keeps point-in-time history on paid plans and a short window on free. Also download
**Clients → Download clients (CSV)** and **Download notes (CSV)** weekly until a real backup is set up. Those two
files are a **reference copy, not a backup**: they leave out all but each merchant's latest advance, plus offers,
submissions, funders, stips, positions and timers, and nothing reads them back in. Merchant data is the business. Decide who owns the backup before real clients go in.

## 7. Security reminders

- Rotate `SESSION_SECRET` to sign everyone out; "Sign out of all devices" in Settings does it per user.
- Removing an address from `ALLOWED_EMAILS` ends that session on its next request.
- Bank statements are not stored in this app. If uploads are added later they go in private object storage behind
  authenticated URLs, never a public bucket, never git.
