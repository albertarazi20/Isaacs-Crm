# Deploying Isaac

Nothing here has been done yet. Everything marked **(unverified)** is from provider docs, not from running it.
Claude does not deploy, create accounts or spend money — you do steps 1–4, then tell Claude the names.

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
- The connecting role must be allowed to `create role` once and `set role isaac_app` (the first migration does both).
  Use the project's owner role, not a read-only one.
- Row-level security is the wall between merchants. The app role `isaac_app` cannot bypass it. Never connect the
  app as a superuser for requests: `withUser` always drops to `isaac_app`; `withSystem` is confined to
  `src/lib/system/**`, `src/lib/db/**` and `src/app/api/**` (a test enforces that). Every request does read one
  small row that way (the "sign out everywhere" epoch), so the owner connection is used for that lookup only.

## 3. Environment variables (host dashboard, never git, never chat)

| Name                             | Value                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `DATABASE_URL`                   | pooled connection string                                                       |
| `SESSION_SECRET`                 | 32+ random characters (`openssl rand -base64 48`)                              |
| `TOKEN_ENC_KEY`                  | `openssl rand -base64 32` — encrypts the stored Gmail token                    |
| `APP_URL`                        | the public https URL, no trailing slash                                        |
| `ALLOWED_EMAILS`                 | Isaac's Google address only (each address gets its own empty account)          |
| `GOOGLE_CLIENT_ID` / `_SECRET`   | from the new Google Cloud project; redirect URI `APP_URL/api/auth/callback`    |
| `RESEND_API_KEY` / `RESEND_FROM` | Resend key; sender on a domain verified in Resend                              |
| `CRON_SECRET`                    | 16+ random characters                                                          |
| `DEV_LOGIN`                      | **leave unset.** It is ignored in production and unless `APP_URL` is localhost |

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
