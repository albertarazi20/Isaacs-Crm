# Review 2 — adversarial review of today's lead commits

Scope: `4857e18` CSV export, `5f28c49` PWA, `3751b4a` trash (0040), `66d1d57` session epoch (0050), `917ab1a` migration 0060 +
`docs/DEPLOY.md`, `b86519a` reports, `1d512af` lead source. Read at HEAD `f3bf894` (HEAD moved to `278f6ec`, lead intake, during the review) plus the uncommitted working tree.
`cc70d6f` (after the listed commits) rewrote `restore_client`; I reviewed the code as it stands now, not the version in `3751b4a`.
Nothing under `src/`, `db/`, `tests/`, `e2e/` was edited. The nine test files for these commits pass today
(`npx vitest run tests/{trash,export,session-epoch,hosted-roles,reports,reports-db,sources,import,import-db}.test.ts`: 121 passed).

How things were verified: repro scripts against throwaway databases made with `tests/helpers/db.ts` (`createTestDb`), never `isaac_dev`.
Labels: CONFIRMED = I reproduced it; LIKELY = argued from code; QUESTION = needs a decision.

Counts: 1 blocker, 7 bug, 6 risk, 7 nit.

---

### R-1 [blocker] A do-not-contact merchant stops being do-not-contact the moment it is trashed

**Status:** CONFIRMED

**Where:** `src/lib/data/import.ts:29`, `src/lib/data/queries.ts:117` (`findDuplicates`), `db/migrations/0040_trash.sql:104-112` (`purge_client`); also
`src/lib/leads/intake.ts` (landed in `278f6ec` while this review ran; its header says "Trashed merchants count as gone").

**Why it matters:** `docs/CREW-RULES.md` and the do-not-contact commit say a merchant who said "stop" must never get another call, text, email or
reminder. The duplicate check, CSV import and (new) lead intake all treat trashed merchants as nonexistent, so the "stop" fact lives only on a
row that is hidden and can be purged. Trash a DNC merchant ("clean up"), then a lead vendor re-sells the same number, or the owner imports the
list again: a brand-new card with `contact_status = 'ok'` and a follow-up tomorrow. This is the TCPA exposure the owner was told the app guards.
`tests/trash.test.ts` ("no duplicate warning, and a re-import creates a new client instead of skipping") pins the unsafe behaviour for ordinary
clients and does not look at DNC.

**Repro/evidence:** `insertClient` "Stop Pizza", `update clients set phone='+15557778888'`, `m.setContactStatus(dnc)`, `m.trashClient`.
`findDuplicates(q, {phone:"(555) 777-8888"})` returned `[]`. `importClients` of the same phone returned `{created: 1, skippedExisting: 0}`.
`listCards` then showed "Stop Pizza" with `contact_status: "ok"` and `next_due_on` tomorrow.

**Suggested fix:** let `findDuplicates`, `importClients` and lead intake match trashed rows whose `contact_status <> 'ok'` (skip the import row with a
"matches a do-not-contact merchant in the trash" problem; intake returns `doNotContact`). Make `purge_client` refuse a non-`ok` merchant, or copy
its phone/email into an RLS-protected suppression table first.

---

### R-2 [bug] Global search and inbound-call lookup still list trashed merchants

**Status:** CONFIRMED

**Where:** `src/lib/data/overdue.ts:172-186` (`clientDirectory`, called by `loadDirectoryAction` in `src/app/power-actions.ts:65`).

**Why it matters:** `docs/DECISIONS.md` and the trash page promise "hidden everywhere". `clientDirectory` reads `from clients c` directly, which
`docs/CREW-RULES.md` forbids without the `not exists (trashed_clients)` guard. A trashed merchant appears in the Cmd-K palette and in the
inbound-call phone lookup with name, phone and email, and the link opens a 404 (`getClientDetail` goes through `client_cards`).

**Repro/evidence:** after `m.trashClient(q, id)`: `clientDirectory(q).some(d => d.id === id)` is `true`; `listCards(q).some(...)` is `false`.

**Suggested fix:** add `where not exists (select 1 from trashed_clients t where t.client_id = c.id)`. Add a test next to `tests/power-search.test.ts`.

---

### R-3 [bug] "Delete forever" can delete a merchant that a concurrent restore just made live

**Status:** CONFIRMED

**Where:** `db/migrations/0040_trash.sql:104-112` (`purge_client`).

**Why it matters:** `purge_client` checks `exists (select 1 from trashed_clients ...)` and then `delete from clients` with no lock in between. Restore
takes `select ... for update` on the client; a purge that read the trash row before the restore committed still waits for the row lock and then
deletes the now-live client, cascading away every note, offer and advance. Irreversible, and reachable with the Trash page open in two tabs or on
two devices (the confirm button stays on screen).

**Repro/evidence:** connection 1: `begin; set local role isaac_app; ...; select restore_client(id)` (not committed). Connection 2: same setup,
`select purge_client(id)` (blocks on the delete). Commit 1. Connection 2 returned "purge ok"; afterwards `select 1 from clients where id = $1` returned 0 rows
and the "Restored from trash" activity was gone too.

**Suggested fix:** in `purge_client`, `select ... from clients where id = p_client for update` first (not found means "not in the trash"), then check
`trashed_clients`, then delete. Add a two-connection test.

---

### R-4 [bug] The notes export includes trashed merchants' notes, with a blank Business column

**Status:** CONFIRMED

**Where:** `src/app/api/export/activity/route.ts:15-22`.

**Why it matters:** the route reads every `activities` row and builds the name map from `listCards` (which hides trash). Notes of trashed merchants
are exported with an empty business name: they leak a "hidden" merchant's history (including notes that may be about a do-not-contact merchant) and
are unusable as a backup because nobody can tell whose note it is.

**Repro/evidence:** trash a client, add a note, run the route's query: rows `["...", "", "system", null, "Moved to trash"]` and
`["...", "", "note", null, "secret merchant note"]`.

**Suggested fix:** either filter `where not exists (trashed_clients ...)` or, since this is advertised as the backup, include trashed merchants with their
real name plus an "In trash" column (select names from `clients`, not `client_cards`). Decide and add a route-level test.

---

### R-5 [bug] "Log out everywhere" has no button, and DEPLOY.md says it does

**Status:** CONFIRMED (grep)

**Where:** `src/components/SecurityPanel.tsx` (never imported); `docs/DEPLOY.md:64`; `docs/BACKLOG.md:19` still `[ ]`.

**Why it matters:** the lost-phone feature is only reachable by editing `app_users.session_epoch` by hand (that is what `e2e/session.e2e.mjs` does, so it
passes without the UI). `grep -rn "SecurityPanel\|Sign out of all" src` finds only the component itself. DEPLOY.md tells the owner
'"Sign out of all devices" in Settings does it per user'. `logoutEverywhereAction` itself is also untested: no test calls it or proves the cookie is
deleted and the epoch moved.

**Suggested fix:** render `<SecurityPanel />` on the Settings page; extend the e2e to click the button and assert the DB epoch went up and a second
device is signed out; tick the BACKLOG item.

---

### R-6 [bug] Every imported phone number is exported with a visible leading apostrophe

**Status:** CONFIRMED

**Where:** `src/lib/export/csv.ts:10` and `:57`; the stored format comes from `src/lib/import/map.ts:324` (`phone: e164 ?? ""`).

**Why it matters:** the import wizard normalises phones to E.164 (`+13055550101`), so they start with `+`. `csvCell` prefixes `'` to anything starting with
`= + - @`, and a spreadsheet opening a CSV shows that apostrophe literally. The export test uses `(305) 555-0100`, which hides it. The same applies to
any note or business name beginning with `-` or `+`. The CSV is the backup the owner is told to take weekly.

**Repro/evidence:** `buildRows` then `importClients` then `listCards` then `clientRows`: stored `+13055550101`, exported cell `'+13055550101`.

**Suggested fix:** export `formatUS(c.phone)` (`(305) 555-0101`, starts with `(`, cannot be a formula) and keep the guard for free text. Add a test with a stored
E.164 phone.

---

### R-7 [bug] The reminder heartbeat is recorded even when every email failed to send

**Status:** LIKELY (read from code)

**Where:** `src/app/api/cron/reminders/route.ts:33-36`; `src/lib/system/reminders.ts:103-110` and `:271-277` (send errors are caught and counted in `failed`).

**Why it matters:** the dead-man's switch exists for "reminders stopped". With a wrong `RESEND_FROM`, an unverified domain or an expired key, `runReminders` and
`runCallReminders` return normally with `failed > 0`, the route records a fresh heartbeat anyway, replies 200, and the red banner never appears.
`docs/OWNER-TODO.md` item 5 says reminder email is unproven, so this is the likely first failure.

**Suggested fix:** record the heartbeat only when `digest.failed === 0 && calls.failed === 0` (or keep a separate `last_ok_at`), and return 502 when anything
failed so the scheduler alerts too. Test through `runReminders` with a throwing `send`.

---

### R-8 [bug] Booking a call changes the stage without writing history, so the report says "Never reached the owner"

**Status:** CONFIRMED

**Where:** `db/migrations/0001_init.sql:535` (`schedule_call` updates `stage` and logs only a `timer` activity); `src/lib/reports/report.ts:116`.

**Why it matters:** the funnel and "Where deals ended" read stage history from `activities.to_stage`. A deal that booked a call (so Isaac did speak to the owner),
then died, has history `{name_in, lost}`: `furthestRank` is 0 and it is counted as "Never reached the owner". "Added to Interested" speed is also late for
merchants that went through "Phone call scheduled".

**Repro/evidence:** `createClient` (name_in), `m.scheduleCall`, `m.moveClient(lost)`, `loadCohort`: `reached` keys `["lost","name_in"]`;
`buildDeathPoints` returns `[{label:"Never reached the owner", count:1}]`.

**Suggested fix:** insert a `stage_change` activity (`from_stage`, `to_stage`) in `schedule_call` when it moves the stage. Add a report test for book-a-call then lost.

---

### R-9 [risk] Restoring a funded merchant silently drops an overdue renewal call

**Status:** CONFIRMED

**Where:** `db/migrations/0040_trash.sql:86-88` (`due_on >= current_date`).

**Why it matters:** `cc70d6f` fixed the original loss of the renewal timer but still skips every timer already past due "so it doesn't land as a wall of overdue". The
overdue renewal call is the most valuable one (commission). After restore the merchant keeps only the 30-day check-in, and because an open timer exists
the "Restored from trash — pick the next step" fallback is not added either. The Renewals page still lists the advance (it reads advances, not timers), but the
digest will never remind him.

**Repro/evidence:** fund a client, `update timers set due_on = current_date - 3 where kind = 'renewal'`, trash, restore: open timers are
`[check_in 2026-11-22]` only.

**Suggested fix:** reopen overdue `renewal` and `check_in` (and `chase`) timers with `due_on = current_date`; only skip overdue plain `follow_up`s.

---

### R-10 [risk] Nothing in the database stops a trashed merchant getting timers again; only the reminder queries compensate

**Status:** CONFIRMED

**Where:** `db/migrations/0001_init.sql` and `0010_funders.sql` functions that take a client id (none check `trashed_clients`); `src/lib/data/queries.ts:77-83` (`dueCount`).

**Why it matters:** the guarantee "every timer closed so no reminder can fire" holds only until something writes a timer after the trash. The TS mutations that finish
with `mustCard` roll back (it returns null for trash), but `sendToFunders`, `setSubmissionStatus`, `recordOffer`, `addNote` and any direct SQL do not. A stale
tab is enough. Reminder emails are protected by the two `not exists` clauses added in `3751b4a`, but the Today badge is not, and `restore_client`'s reopen can
collide with the unique open-chase index if a new chase was created meanwhile.

**Repro/evidence:** after `trashClient`, `fm.sendToFunders(q, {clientId, funderIds:[f], sentOn: today-5})` succeeded and left an open `chase` timer; `dueCount` returned 1.

**Suggested fix:** one helper `app.assert_live(p_client)` called by every client-scoped function (or a trigger on `timers` insert), plus the anti-join in `dueCount`.

---

### R-11 [risk] A bulk import of merchants at later stages makes "how fast deals move" show 0 days

**Status:** CONFIRMED

**Where:** `src/lib/reports/report.ts:156-186` (`buildSpeed`); `src/lib/data/import.ts` (rows keep their sheet stage).

**Why it matters:** `create_client` logs `to_stage = <initial stage>` at creation, so an imported "Application in" merchant has `created_at` and "reached application"
within milliseconds. Isaac's first import will dominate the first report period: speed medians near 0 and a funnel that credits stages the CRM never saw.

**Repro/evidence:** import 4 rows at stage `application_in`: `buildSpeed` returned `Added → Interested n=4, 0 days` and `Added → Application in n=4, 0 days`.

**Suggested fix:** measure speed only from `stage_change` rows with a `from_stage`, or exclude clients created above `name_in` (and say "imported" in the UI).

---

### R-12 [risk] Opening Add client or Edit details revalidates the whole app

**Status:** LIKELY

**Where:** `src/app/actions.ts:23-31` (`run` always calls `revalidatePath("/", "layout")`) and `:74` (`listSourcesAction`); `src/components/SourceInput.tsx:16-24`.

**Why it matters:** `SourceInput` calls `listSourcesAction` on every mount, so a read-only lookup goes through `run` and invalidates the layout cache and re-renders the current page
(the Board with every card) in the action response. Server actions from one client run one at a time, so Save can queue behind it. `power-actions.ts` already has
`run(fn, false)` for reads (`loadDirectoryAction`); `findDuplicatesAction` has the same flaw (older).

**Suggested fix:** give `run` a `refresh` flag as in `power-actions.ts`; use `false` for `listSourcesAction` and `findDuplicatesAction`.

---

### R-13 [risk] One long source value rejects the whole import with an unhelpful message

**Status:** CONFIRMED

**Where:** `src/lib/import/map.ts:324` (`source: get(r, "source") || ...`) versus `src/lib/data/schemas.ts:283` (`source: line(100)`).

**Why it matters:** the new broad synonyms (`list`, `vendor`, `campaign`, `origin`) can map a free-text column. `buildRows` reports no problem, then the server's `importSchema.parse`
fails the entire batch.

**Repro/evidence:** a row with a 150-character source: `toActionError` shows "Too big: expected string to have <=100 characters", no row number, nothing imported.

**Suggested fix:** in `buildRows`, collapse whitespace, cut to 100 characters (or push a `RowProblem`), and strip control characters. Same hardening for `industry`, `state`, `contactName`.

---

### R-14 [risk] Trashing a funded merchant removes its advances and commission from Earnings and Renewals, and the dialog does not say so

**Status:** QUESTION

**Where:** `src/lib/earnings/queries.ts:52-70` (`listAdvances` joins `client_cards`); `src/components/client/ClientHeader.tsx` (trash dialog).

**Why it matters:** commission received is real money. One tap on "Move to trash" lowers the earnings totals and removes the merchant from the renewal radar until restored.
Probably intended ("hidden everywhere"), but nothing warns about it. Decide, then either warn in the dialog or keep trashed advances in the money totals.

---

### R-15 [nit] `listSources` suggests the alphabetically smallest spelling, not the most used one

**Status:** CONFIRMED (needs a non-C collation)

**Where:** `src/lib/data/queries.ts:154-163` (`min(c.source) ... group by lower(btrim(c.source))`).

**Why it matters:** the suggestion list is meant to stop "Referral" and "referral" splitting. `min()` is collation-dependent: the test database is `C` (uppercase first, so it passes), but on
an `en_US.UTF-8` or ICU en-US database (Supabase default) lowercase sorts first, so 9 clients typed "Referral" and 1 typed "referral" suggests "referral".
Checked on a scratch database created with `locale_provider icu icu_locale 'en-US'`: `select min(s) from (values ('Referral'),('referral')) v(s)` returns `referral`.
`buildSources` picks the most common spelling, so the two disagree.

**Suggested fix:** `mode() within group (order by c.source)`, and make the test use both spellings with unequal counts.

---

### R-16 [nit] The funder scoreboard counts trashed merchants' submissions

**Status:** QUESTION

**Where:** `src/lib/funders/queries.ts:45-66`.

**Why it matters:** the scoreboard (response rate, decline reasons, factor rates) reads `submissions` and `offers` with no trash filter, so deleting junk or test merchants into the trash
does not clean the numbers, while the same merchants vanish from Earnings. Pick one rule and apply it to both.

---

### R-17 [nit] Reports: small correctness and honesty gaps

**Status:** CONFIRMED / LIKELY as noted

- Cohort cutoff compares `c.created_at >= $1::date` (`src/lib/reports/queries.ts:41`). The date becomes midnight in the database's `TimeZone` (UTC), not the user's, so the window edge is off by hours. (LIKELY; DB tz verified `Etc/UTC`.)
- `loadCohort` types `created_at` as `string` (`:23`) but node-pg returns a `Date` (CONFIRMED, `typeof` is `object`). `Date.parse(Date)` works by accident via `toString()` and drops milliseconds; `buildSpeed` is only tested with strings.
- Percentages have no minimum sample in the funnel or on-time card (1 follow-up shows 100%); sources and speed do. Recent cohorts also look bad because deals have not had time to fund, and the UI does not say so.
- "Pushed back" = `done_reason = 'replaced'`, which is also written for a rebooked call (`schedule_call`) and a same-stage edit in `move_client`. `chase` timers (a funder's slowness) count in the on-time rate. QUESTION whether that is the intended meaning.
- `tests/reports-db.test.ts` "another user's timers never show up" asserts `theirs.length <= bTimers`, which is true for almost any result.

---

### R-18 [nit] CSV export: edge cases and the "backup" claim

**Status:** QUESTION / LIKELY

- Formula guard is `/^[=+\-@\t\r]/` (`src/lib/export/csv.ts:10`). A leading space, NBSP or LF before `=` is not covered. I believe Excel and LibreOffice treat those cells as text, so low risk, but `s.trimStart()` before the test is free defence in depth. Fullwidth lookalikes (`＝`, `＋`, `－`, `＠`) do not matter: no spreadsheet normalises them to operators.
- Export timestamps use the UTC date (`created_at.slice(0, 10)`, `last_call_at.slice(0, 10)`), so an evening add in New York shows tomorrow.
- `docs/DEPLOY.md:59-60` presents the two CSVs as the weekly backup. They omit every advance but the latest per merchant, offers, submissions, funders, positions, stips, timers, snippets and commission received, and nothing imports them back. Call them a reference copy.

---

### R-19 [nit] Add client remembers the last source silently

**Status:** LIKELY

**Where:** `src/components/QuickAdd.tsx:21-36, 154`.

**Why it matters:** a walk-in added after a batch from "Lead vendor Oct" is saved as "Lead vendor Oct" unless Isaac notices the pre-filled box, which corrupts the very report the field exists for.
A pre-filled input also makes the browser's datalist show only matching options, so the other suggestions are hidden until the box is cleared. Separately, `isaac:lastSource` and
`isaac:pending-touch` (business name) survive "log out everywhere" because only `LogoutButton` clears `isaac:*` keys.
**Suggested fix:** show "same as your last add" hint or clear after a few minutes; select-all on focus; clear `isaac:*` in the log-out-everywhere path.

---

### R-20 [nit] Docs that are stale or untrue

**Status:** CONFIRMED

- `docs/DEPLOY.md:64` Settings "Sign out of all devices" does not exist (R-5).
- `docs/DEPLOY.md:50` says Settings has "Send me a test reminder"; the button reads "Send me a test email" (`src/components/SettingsPanels.tsx:114`).
- `docs/DEPLOY.md:22` says `withSystem` is confined to login, reminders and `/api/*`; since `66d1d57` every request calls it through `getSession` (`src/lib/system/users.ts`), and the boundary test allows all of `lib/system/`.
- `docs/BACKLOG.md` lines 19, 30, 45, 46, 47 and 52 are still `[ ]` for work that shipped today (log out everywhere, export, PWA, trash, source pick-list, hosted-role revoke).
- `docs/OWNER-TODO.md:30` quotes "about 20 seconds" for lint/typecheck/format in CI with no command next to it (CLAUDE.md: a number in a doc gets its command).
- `docs/REQUIREMENTS.md` has no rows for trash, reports, export or session epoch.

---

### R-21 [nit] Repo hygiene

**Status:** CONFIRMED at review time

- `66d1d57` (`src/app/api/cron/reminders/route.ts`) imports `src/lib/system/heartbeat.ts`, and `0003_job_heartbeat.sql`, `0020_earnings.sql`, `0030_snippets.sql` were untracked in the working tree. A clean checkout of that commit does not build or migrate. Make sure the lead commits them before CI runs.
- `tests/hosted-roles.test.ts` creates cluster-level roles `anon` and `authenticated` and never drops them, so they persist on the dev machine and in any shared Postgres.
- `.github/workflows/ci.yml` runs typecheck, lint and format check, while CLAUDE.md says CI is unit tests plus a build only. `docs/OWNER-TODO.md` section C already asks the owner; keep that decision open on purpose.

---

## Missing tests (behaviours that could regress)

1. Search directory, Today badge (`dueCount`), activity export and funder scoreboard exclude trashed merchants (R-2, R-4, R-10, R-16). The trash test suite checks cards, digest, duplicates and import only.
2. DNC merchant in the trash is not re-created by import, add or lead intake; `purge_client` on a DNC merchant (R-1).
3. Purge racing a restore (two connections) (R-3).
4. Trash then restore of a funded merchant whose renewal is overdue; restore after a stale-tab chase timer was created (R-9, R-10).
5. Export routes at the HTTP level: 401 without a session, only the caller's rows, `no-store`, `attachment`; a stored E.164 phone round-trips without an apostrophe (R-6).
6. `getSession` itself: a token with an old epoch, a deleted user, or no `ep` after a bump returns null. Today only `epochMatches` with a stub and the column are tested; deleting the `epochMatches` line from `src/lib/auth/server.ts` keeps CI green (e2e is local only). Also `logoutEverywhereAction` end to end.
7. `runReminders` with a throwing `send`: heartbeat behaviour (R-7).
8. `schedule_call` then lost then report death point (R-8); `buildSpeed` fed real `Date` objects from `loadCohort` (R-17); report cohort boundary in a non-UTC time zone.
9. `listSources` with 9x "Referral" and 1x "referral" on a non-C collation (R-15); `buildRows` with an over-long or multi-line source (R-13).
10. Manifest and icons reachable without a session on a production build, and the CSP header present on them (only checked by hand).

---

## Looked at and fine

- `trashed_clients`: RLS on from creation, policy `for all to isaac_app` keyed on `user_id`, composite FK `(client_id, user_id)` so B cannot write a trash row for A's client, minimal grants (`select, insert, delete`), no `security definer`, `search_path` set. `trash_client`, `restore_client` and `purge_client` are invoker functions: for another user's id every path ends in the same generic "not found / not in the trash" (the suite covers B vs A). `purge_client` refuses a live client.
- Reminder emails: `loadDueTimers` (digest and test digest) and `runCallReminders` both anti-join `trashed_clients`; no other server path emails or schedules a call from `clients`/`timers` (grepped every `from clients`, `join clients`, `from timers`, `client_cards`, `from activities` in `src/` and `scripts/`). `src/lib/earnings` and `src/lib/messaging` read through `client_cards`. `src/lib/funders` only reads by client id or per funder.
- `client_cards` recreated in 0040 with the same column list as 0002; `create or replace` works because it is the last change to `clients` columns.
- `restore_client`: closed-by-trash timers are matched on the shared transaction timestamp; DNC restores to the 36-month review timer; a booked call is not reopened (tested).
- Session epoch: `verifySession` always returns an integer epoch (missing, non-numeric or non-integer `ep` becomes 0), so a token without `ep` matches only a user still at epoch 0 and dies at the first bump; forging needs `SESSION_SECRET`. A deleted user has no row, so `epochMatches` is false. `verifySession` is called only from `getSession`; every page, action and route handler goes through `getSession`/`requireSession`. React `cache()` is per request (and a plain call outside a render), so it cannot leak across users. The app role has no UPDATE on `session_epoch` (tested).
- Export routes: authenticated by `getSession` (epoch included), query as the user through `withUser` so RLS applies, `cache-control: no-store`, `attachment`, `force-dynamic`. RFC 4180 quoting for comma, quote, CR and LF; `= + - @ TAB CR` neutralised.
- PWA: `/manifest.webmanifest` (200, `application/manifest+json`), `/icon-192.png`, `/apple-icon.png` served without a session on the running dev server; `<link rel="manifest">`, theme-color and apple meta present. Icons are solid-colour with the glyph inside the maskable safe zone. No service worker is registered and no doc claims offline support.
- Production headers in `next.config.ts`: `default-src 'self'` covers `manifest-src`; `img-src 'self' data: blob:` covers icons; `form-action 'self'` is fine because login and Gmail reconnect are plain anchors to a same-origin route; nothing here changed with the PWA commit.
- Migration 0060 on plain Postgres: guarded by `pg_roles`, idempotent, transactional, covered by a test that simulates the hosted defaults (current and future tables, views). Caveats for real Supabase (unverified, already admitted in DECISIONS): `alter default privileges` without `for role` covers only the role running the migration (`postgres`, which is what Supabase uses for tables you create); `service_role` is deliberately untouched (never put that key in this app); public functions stay executable through the Data API as `anon` but run as `anon` with no table grants, so they do nothing.
- Reports: the period is an allowlist (`parsePeriod`) and everything else is a bound parameter, so no injection; `pct()` guards division by zero and an empty cohort shows the empty state; `done_at` is converted with `at time zone $3` (tested in Auckland); trash is excluded from both cohort and timer history; funnel counts never rise with the steps; the median needs 3 merchants.
- `listSources` excludes trash, `Imported` and other users; `mergeSources` dedupes case-insensitively; `SourceInput` and `rememberSource` wrap storage in try/catch.
- `importClients` falls back to `Imported` when no source is given; a sheet's own source beats the typed list name (tested).
