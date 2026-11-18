# Security

## Local security scan

`pnpm security` (runs `scripts/security-scan.mjs`) is a check the developer runs before a release. It is **not** part of
CI (CI runs unit tests and a real build only, to save the free Actions minutes) and it needs network access for the first
check. It exits non-zero when anything fails.

| Check                | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency audit     | `pnpm audit --prod`: fails on any known advisory in a production dependency and lists each with its severity, affected and fixed versions. An audit that cannot run (offline) is a failure, not a pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Secrets              | Reads every git-tracked text file (`git ls-files`). Looks for `sk-ant-` keys, AWS key ids (`AKIA`/`ASIA`), private key blocks, JWT-looking tokens (`eyJ...`), Supabase service keys (`sb_secret_`, or a JWT whose role is `service_role`), Resend keys (`re_...`), GitHub tokens (`ghp_`, `gho_`, `github_pat_`), Netlify tokens (`nfp_`), Stripe live keys (`sk_live_`, `rk_live_`), database URLs with a user and password in them (`postgres://user:password@host`), and long hex or base64 values assigned to names containing KEY, SECRET, TOKEN or PASSWORD. It also flags **any non-empty literal** assigned to `ACCESS_PASSCODE`, `SESSION_SECRET`, `DATABASE_URL`, `ANTHROPIC_API_KEY` or `SUPABASE_SERVICE_KEY` (rule `named-secret-assignment`), however short. Not flagged: empty values, `changeme`/`your-...`/`<...>`/`***`/`...` stand-ins, references (`$VAR`, `${VAR}`, `process.env.X`, `secrets.X`), type annotations, and a local database URL with no password. Fake values in tests go in the allowlist, each with a reason. |
| Tracked `.env` files | Fails if any `.env` or `.env.*` is tracked, at any depth, except `.env.example`. Also fails if a downloaded `isaac-backup-*.json` (customer data) is tracked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Plain `http://`      | Fails on an `http://` URL in a tracked `src/` file unless it points at `localhost`, `127.0.0.1`, `[::1]` or `0.0.0.0`, or is allowlisted (credentials and query string are redacted when it is printed).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Findings print as `path:line  rule  preview`, where the preview is the first four characters and the length for a value of 16
characters or more, and only the length for a shorter one (four characters of a weak passcode would be most of it). The
scan never prints a secret, so its output is safe to paste into a ticket. The `http://` finding prints the URL with any
user name and password replaced by `***` and everything from the query string on cut off.

**Allowlist.** `scripts/security-allowlist.json` holds the exceptions, in three lists (`secrets`, `http`, `advisories`).
Every entry needs a `reason`, and the scan refuses to start if one has none. A `secrets` entry names a `path` (an exact
file, or a directory ending in `/`) and may narrow it with `rule` and `contains` (a fragment of the value). An `http`
entry names a `path` and may narrow it to a `url` prefix. An `advisories` entry names the advisory `id` (for example a
`GHSA-...`). The scan notes any entry that matched nothing so stale ones get removed. Prefer fixing the finding: if a real
secret is found, rotate it first, then remove it from git.

**First run (2026-11-18)**, before the rules for vendor keys, database URLs and the app's own secret names were added. Dependency audit: 0 advisories (129 production packages). Secrets: none in 717 tracked text
files. No tracked `.env` file and no tracked backup file. One `http://` URL in `src/`: the SVG namespace in
`src/app/icon.svg` (`http://www.w3.org/2000/svg`), an XML namespace name that is never fetched; allowlisted with that
reason.

**With the added rules** the scan found 15 places, all fakes: the CI workflow's throwaway Postgres service container password
(`.github/workflows/ci.yml`, `TEST_DATABASE_URL`) and fake values that tests put in their own process environment
(`"s".repeat(40)`, a placeholder `postgres://x`, a deliberately too-short passcode) in 10 test files. Each is allowlisted per
file and rule with its reason, so a real secret added to any other file, or of any other kind, still fails. An elided
`DATABASE_URL=postgres://…` in `docs/BACKUP.md` is read as a stand-in. Nothing real was found.

The matching lives in `scripts/lib/secretScan.mjs` (pure, no file or network access) and is tested table-driven in
`tests/security-scan.test.ts`: real-looking secrets are caught, harmless strings are not.

## Rate limits

The public pages that need no sign-in are each a token in a URL, so a script can hammer them. A fixed-window counter in
Postgres brakes it (`rate_limits`, migration `0574`, helper `src/lib/system/ratelimit.ts`). It is in the database, not
in memory, because the app runs on serverless instances that share nothing. Each request is one atomic upsert
(`insert ... on conflict do update set hits = hits + 1 returning hits`): the count and the verdict come back together, so
parallel requests cannot all pass a check made before any of them counted. Windows are aligned to the epoch; being
refused never extends one.

| Route                                                     | Key                         | Limit                                                                                     |
| --------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| `POST /api/upload/[token]` (a link that exists)           | address, then link          | 200 per 10 min per address, 15 per 10 min per link                                        |
| `GET /api/upload/[token]` (what is still wanted)          | address                     | 300 per 10 min (a link that exists)                                                       |
| `POST /api/apply/[token]`                                 | address                     | 60 per 10 min (a link that exists)                                                        |
| `GET`/`POST /api/offer/[token]`                           | address                     | 300 per 10 min (a link that exists)                                                       |
| any of the three above naming a link that does NOT exist  | address (per route family)  | 20 per 10 min (`invalidLinkIp`; `upload-invalid`, `apply-invalid`, `offer-invalid`)       |
| `POST /api/seen`, `POST /api/offer/[token]/seen`          | address (one shared bucket) | 300 per 10 min                                                                            |
| `POST /api/unsubscribe/[token]` and the `/u/[token]` page | address                     | 30 per 10 min                                                                             |
| `GET /api/auth/google`, `GET /api/auth/callback`          | address (one bucket each)   | 30 per 10 min (`authIp`), counted before anything else, so a refusal writes no audit line |

- **Over the limit:** HTTP 429, a `Retry-After` header in seconds, and a plain message ("Too many requests from your
  connection. Please wait N minutes and try again."). The `/u` page is a page, so it cannot answer 429; it shows the
  same words instead. The button's own route (`/api/unsubscribe`) answers 429.
- **The address** is `clientIp()` (`src/lib/docs/clientIp.ts`): Netlify's own connection header (`x-nf-client-connection-ip`).
  In production, with that header absent, `x-forwarded-for` is **not** used at all (the client can write it): the address is
  empty and the shared bucket below applies. In development and tests the last `x-forwarded-for` entry is the fallback. An
  IPv6 address is cut to its **/64** (`2001:db8:1:2::/64`), because one network owns the whole /64 and could otherwise make
  endless "different" addresses; an IPv4-mapped one (`::ffff:1.2.3.4`) is the IPv4 address; anything that is not an address
  reads as none. The rate limits, the passcode lock, the failed-sign-in guard and new-device checks all key on this.
  `exactClientIp()` is the same trusted reading, whole, and is what goes on a signed application, an offer acceptance and an
  upload record. Keys are cut to 64 characters of address. Tests: `tests/security-fixes-clientip.test.ts` (table-driven).
- **Order of checks.** A link that does not exist is told apart first (a read of the token, and for an upload before the
  body is read) and counted only in the small invalid-link bucket, so strangers' guesses never use the room real merchants
  behind a shared office or carrier address need, and a guess never gets a counter of its own. A link that exists is counted
  per address (roomy) and, for uploads, per link (the real protection, 15 per 10 minutes). The sign-in pages are counted
  first; they have no token.
- **No readable address:** everyone shares one bucket per route (`<route>:no-address`) with a limit 10 times higher
  (`NO_ADDRESS_FACTOR`), so a missing header can never lock every merchant out while a script is still bounded. Same idea
  as `passcodeKey` in `src/lib/system/users.ts`. Behind Netlify the header is always there; in production this is also what a
  forged `x-forwarded-for` gets.
- **Links are counted by a hash** of the token (`tokenKey`), so a working token is never written into the table.
- **A merchant never meets these:** the offer page sends one file per document (six) and reads after each; the upload
  page sends a whole batch in one request. The per-link limit of 15 leaves room for six documents, retries and a second
  visit. Offices and mobile carriers that put many merchants behind one address share the per-address numbers, which is why
  they are large (200 uploads, 300 offer reads, 60 signatures per 10 minutes).
- **Fails open:** if the counter cannot be reached the request goes through and the error is logged
  (`rate limit not counted:`). The public pages need the same database anyway; a counter outage must not take them
  down. `hit()` itself throws, so the tests prove the counting.
- **System-only table:** row security on, the app role has no grants (the `passcode_attempts` pattern), not in the JSON
  backup (named in `tests/review-4.test.ts`). Stale windows (over a day old) are deleted by `sweepRateLimits()`, which
  the hourly `/api/cron/nightly` calls; a failed sweep is logged and never fails the run.
- **Tests:** `tests/security-ratelimit-db.test.ts` (counting, window rolling, per-address and per-route isolation, the
  no-address bucket, the sweep, the grants; every assertion reads the `rate_limits` rows),
  `tests/security-ratelimit-routes.test.ts` (the real route handlers with real links: 429, `Retry-After`, the body, the
  invalid-link bucket kept apart) and `tests/security-fixes-signin-flood.test.ts` (the two Google routes).
- **Known limit:** one-click unsubscribe POSTs from a large mail provider arrive from that provider's addresses. 30 per
  10 minutes per address is far above this shop's volume; raise `LIMITS.unsubscribeIp` if a big send ever changes that.

## Sessions

A sign-in cookie is a signed token (`isaac_session`, HS256, `src/lib/auth/session.ts`). Four rules decide whether it
counts, all enforced on the server in `resolveSessionOutcome` (`src/lib/auth/resolve.ts`), never only by the cookie's
`max-age`:

1. **Signature and absolute lifetime: 7 days** from sign-in, however busy the person has been. The token's own `exp` is
   7 days, and the signed issue time (`iat`) is checked too, so a token minted when sessions lasted 14 days is ended at
   7 days anyway.
2. **The account is still allowed.**
3. **The session epoch** (`app_users.session_epoch`) still matches: "log out everywhere", disabling a user or
   offboarding them kills every session at once. It is checked before the idle rule, so a revoked session is never
   touched.
4. **Idle timeout: 12 hours** with no use ends the session.

How the idle rule is kept: every sign-in writes one row in `session_activity` (migration `0575`: `sid`, `user_id`,
`last_seen_at`) and the cookie carries that `sid`. One statement (`touchSession`, `src/lib/system/sessions.ts`) reads the
last use and, if it is inside the window but at least 5 minutes old, rolls it to now. So the idle window rolls forward
on use but a page load writes at most once every 5 minutes. A session with no row, or whose last use is 12 hours or
more ago, is refused and stays refused. It is per sign-in, so a busy laptop does not keep a forgotten phone alive. The
timestamps live in the database, not the cookie, because a page render cannot set a cookie.

- **Passcode and Google sign-in** both go through `sessionCookie()` (`src/lib/auth/server.ts`), which records the sign-in
  and signs the cookie; there is no second path.
- **What the person sees:** an idle session is sent to `/login?reason=idle`, which says "You were signed out for
  inactivity." An over-age one goes to `/login?error=session_expired` ("Your session ended. Sign in again."). The query
  strings carry a reason only, nothing about the account.
- **Sessions issued before this existed** carry no `sid`. They have no idle clock and are ended by the 7-day cap at the
  latest; every new sign-in has both.
- **Housekeeping:** records older than the lifetime plus a day are deleted by `sweepSessions()` in the hourly nightly cron;
  a deleted user's rows go with them (`on delete cascade`). `session_activity` is system-only (row security on, no app-role
  grants) and not in the JSON backup.
- **Signing out ends the session on the server.** `logoutAction` deletes the `session_activity` row of the cookie's `sid`
  (`endSession`, scoped to the signed-in person, so a cookie can only end its own row); a copy of the cookie taken before is
  then refused as unknown. `logoutEverywhereAction` bumps the epoch and deletes all of that person's rows (`endAllSessions`).
  Other devices and other people are untouched by a plain sign-out. `tests/security-fixes-signout.test.ts` signs in for real,
  copies the cookie, signs out and shows the copy refused and the row gone.
- **No second step at sign-in**, on purpose: the owner does not want one.
- **Tests:** `tests/security-fixes-signout.test.ts` (sign-out), `tests/security-session-timeouts.test.ts` (a clock the test holds: idle refused at 12 hours, a recent session
  accepted and rolled, at most one write per 5 minutes, per-sign-in clocks, the 7-day cap, the epoch kill, the sweep,
  the grants) and `tests/security-session-signin.test.ts` (a real passcode sign-in, `requireSession` with the date
  moved, the sign-in page's message).

## Audit log

Who signed in, from where, what they changed and what they downloaded. One line per event in `audit_events` (migration
`0573`), written by `src/lib/system/audit.ts` and read by managers on **Settings > Security** (`/settings/security`,
the last 200 lines, filter by kind and person, one plain sentence each; a rep is sent home).

- **Append-only.** The app role (`isaac_app`) can `select` and nothing else on the table: no insert, update, delete or
  truncate, so no request can edit or erase a line. Row security lets only a manager read. Writing happens on the owner
  connection (`withSystem`), like `job_runs` and `passcode_attempts`. `user_id` and `client_id` are plain columns, not
  foreign keys, so a line outlives the person or merchant it is about (and a restore cannot cascade it away). Not in the
  JSON backup.
- **Never breaks the request.** `recordAudit` catches everything and logs only the kind and the error message. A
  sign-in, a settings save or an export goes ahead when the log cannot be written. `detail` holds facts only (which
  settings keys changed, a row count, a label) and is capped at 8 KB; the code never puts a secret, a token, a passcode
  or a merchant's details in it. Settings lines name the keys that changed, and show a value only for numbers and
  on/off switches, never text.
- **Kept 180 days.** The hourly job (`/api/cron/nightly`) deletes older lines (`sweepAuditEvents`).

| Kind                                                                                 | Written by                                                                                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `signin_ok`, `signin_failed`                                                         | `/api/auth/callback` (Google), `/api/auth/passcode`; the failed line carries the reason, never the passcode              |
| `signout`, `signout_everywhere`                                                      | `logoutAction`, `logoutEverywhereAction` (`src/app/actions.ts`)                                                          |
| `team_added`, `team_role_changed`, `team_disabled`, `team_enabled`, `session_killed` | `src/app/team-actions.ts` (a disable or a role change ends the person's sessions: the database does it, the log says so) |
| `lead_token_created`, `lead_token_revoked`                                           | `src/app/lead-actions.ts` (the label and the id; never the token)                                                        |
| `settings_shop_saved`, `settings_ai_saved`, `settings_approvals_saved`               | `src/app/settings-actions.ts`, `src/app/approval-actions.ts`                                                             |
| `gmail_connected`, `gmail_disconnected`                                              | `/api/auth/callback`, `disconnectGmailAction`                                                                            |
| `export_download`, `export_blocked`                                                  | `/api/export/clients`, `/api/export/activity`, `/api/export/followup` (the export name and row count)                    |

**Alerts to every active manager** (the in-app alert feed, bundled into the hourly alert email, each linking to
Settings > Security):

- **New device** (`security_new_device`): a successful sign-in from an address and browser this person has not used in
  the last 90 days of the log, when they have signed in before (the first sign-in the log ever sees raises nothing). One
  alert per person and device per day.
- **Exports** (`security_export`): one export of more than 500 rows, or more than 5 export downloads by one person in an
  hour (once an hour per person).
- **Failed sign-ins** (`security_failed_signins`): 5 or more failed sign-ins for the same email or the same address within
  15 minutes. **At most one alert an hour in total**: its dedupe key has no email or address in it, so a stream of different
  ones cannot fill the managers' feed (every line is still in the log). A passcode attempt refused while the address is
  locked is not written (it would let a locked address fill the table). Flood guards on the lines themselves: past 100 failed
  lines from one address in 15 minutes no more are written (an unreadable address counts as one address, so this holds with
  no header too), and past 500 failed lines in an hour across all addresses nothing more is written
  (`FAILED_SIGNIN_GLOBAL_CAP`). `/api/auth/callback` and `/api/auth/google` are also rate limited (above), so the public route
  that writes these lines cannot be driven faster than 30 calls per 10 minutes per address. Tests:
  `tests/security-fixes-signin-flood.test.ts`.

**Export limit.** A person who already made 20 export downloads in the last hour (counted from this table) is refused the
next with HTTP 429, a `Retry-After` and "You have already made 20 exports in the last hour. Try again in about N
minutes." The check runs before the file is built and again, under a per-person lock, when the download is recorded, so
parallel requests cannot slip under it. A refusal is logged as `export_blocked` (at most once in ten minutes) and does not
count toward the limit. The backup download (`/api/export/backup`) is wired in: both its `GET` (plain) and `POST` (encrypted) call
`refuseIfOverExportLimit` before the file is built and `recordExportDownload` when it is handed over, so a backup is logged as an
`export_download` with `export: "backup"` and its row count, counts toward the 20 an hour and the alerts like any other
export, and gets the same 429 when over (`src/app/api/export/backup/route.ts`; `tests/security-backup-route.test.ts`).

## Database access

What the app's database role (`isaac_app`, the role every signed-in request runs as) can read and write, tightened in
migrations 0576 and 0577. The system connection (`withSystem`, the table owner) is not affected by any of it.

**Teammates' accounts (0576).** Every signed-in user could read every teammate's whole `app_users` row, including the
digest address (`notify_email`), time zone, digest settings, `session_epoch` and the offboarding and policy stamps. The
role now has no table-level SELECT on `app_users`, only a column list:

| Readable about anyone                       | Why                                                       |
| ------------------------------------------- | --------------------------------------------------------- |
| `id`, `email`, `name`, `role`, `active`     | owner names, the team list, mentions, who can sign in     |
| `invited_by`, `created_at`, `last_login_at` | the team page; override routing (`app.override_manager`)  |
| `signature`, `application_link`, `phone`    | the sender block in every email sent for a rep's merchant |

**Not readable about anyone (own row only):** `timezone`, `digest_enabled`, `digest_hour`, `notify_email`,
`session_epoch`, `offboarded_at`, `offboarded_by`, `policy_accepted_at`.

- **Your own whole row** is `select ... from app.my_user` (a `security_barrier` view that returns the caller's row only
  and nothing at all with no signed-in user; read-only). `select timezone from app_users` is "permission denied" even
  for your own row; `update app_users set timezone = ... where id = app.current_user_id()` is unchanged (UPDATE is
  granted by column, and an UPDATE may not read an ungranted column on the right-hand side either: use `app.my_user`).
- **A merchant's time zone falls back to its rep's** (`app.client_timezone`, `app.local_today`, `schedule_call`,
  `update_funding_terms`, `record_default`). They now call `app.user_timezone(user)`, a security-definer function that
  returns your own zone, anyone's to a manager, and null to a rep asking about a teammate. Crafting a merchant row with
  someone else's `user_id` does not get their zone out for a rep.
- A new `app_users` column is private until it is added to the column list in a migration and to the view.
- Code reading `app_users` as a session must select only the granted columns or use `app.my_user`; the system
  connection can read the table. Tests: `tests/security-db-users.test.ts`.

**Documents (0577).** Scan results are the scanner's alone: UPDATE of the scan columns has been revoked since 0564, but
INSERT was open and row security checks only `user_id`, so a session could insert a row already `clean`. A trigger now
forces every row inserted by `isaac_app` to `scan_status = 'pending'`, `scan_note = ''`, `scanned_at = null`, and
requires `storage_key` to start with the row's own `client_id` followed by `/` (so a row cannot be pointed at another
merchant's stored file). The system connection (merchant upload link, email attachments, the generated signed
application) writes its own verdict as before. A rep's drag-and-drop upload (`POST /api/docs`) therefore starts
`pending`; the route runs `scanPending` for exactly those ids right after commit so the file still opens at once, and a
failure leaves them for the cron scan. Tests: `tests/security-db-documents.test.ts`.

**Looked at and left alone** (what the app role can still read, and why):

- `clients.upload_token`, `application_token`, `unsubscribe_token`, `merchant_offers.token`, `upload_sessions.token`,
  `document_links.token`: bearer tokens, but a rep needs their own merchants' links to send them, and row security
  already confines a rep to their own rows (managers see all, by design). A column revoke would break the product.
- `outbox` (message bodies): owner-only for reps, everything for managers; not readable across reps.
- `gmail_connections`, `lead_tokens`, `passcode_attempts`, `rate_limits`, `session_activity`: no grant to the app role.
- `send_ledger`, `mailboxes`, `shop_settings`, `shop_registrations`, and the other `using (true)` reference tables:
  shared on purpose (the email meter and the cap), holding no secret; `send_ledger` shows other reps' merchant ids and
  send times only.
- `app_users` UPDATE of `role`, `active`, `invited_by`: kept; `role` and `active` are guarded by a trigger (managers
  only). A rep can set their own `invited_by`, which only changes which manager their override requests route to; it
  is not a secret and not changed here.
- `documents.storage_key` is selectable by the owner of the row (the download path needs it).
