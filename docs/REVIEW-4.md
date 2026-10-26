# Review 4 — adversarial pass on review-3A fixes, lead cap, local-today, trash freeze, backup/restore

Branch `claude/relaxed-johnson-esxl59`, HEAD `e592cf2`. Scope: migrations 0130, 0140, 0150, 0160, 0170, 0180 (and 0190 where it
touches the same rows), `src/lib/leads/*`, `src/app/api/leads/route.ts`, `src/lib/export/*`, `scripts/restore-backup.ts`,
`src/lib/earnings/*`, `src/lib/mca/funding.ts`, `src/lib/data/{nameKey,mutations,errors}.ts`, `src/components/stage-move/*`,
`src/components/client/FundingCard.tsx`, `src/lib/system/heartbeat.ts`. Files owned by the other crew were not reviewed.

Nothing under `src/`, `db/`, `tests/` or `e2e/` was edited. `isaac_dev` was only read (`schema_migrations`). Everything was run
against throwaway databases (`rev4_scratch`, `rev4_pre`, `rev4_restore`, `rev4_restore2`, all created from `template0` and dropped at the end) and
the `createTestDb()` databases that vitest makes and drops itself.

State before I started: `pnpm typecheck` clean, `pnpm lint` clean, `pnpm vitest run` 67 files / 1531 tests passed (18 s). No
`eslint-disable`, `@ts-ignore`, `.skip` or `.only` in the diff since `f7b4825~1`. Every finding below is therefore something the
existing tests do not exercise.

Totals: 5 bugs, 4 risks, 4 nits, 2 questions. Numbering is C-1 ... C-15.

---

## Bugs

### C-1 [bug] CONFIRMED — "Remove offer" / "Remove submission" on the offer the merchant accepted fails with a check violation

**Where.** `db/migrations/0130_review_3a.sql:9-13` adds `declined_by uuid references offers(id) on delete set null`,
`declined_from text`, and `check ((declined_by is null) = (declined_from is null))`. Callers that delete an offer row:
`src/lib/funders/mutations.ts:125` (`removeOffer`, a bare `delete from offers`), `public.remove_submission` (0130:165,
`delete from submissions`, which cascades to its offers), and `public.merge_clients` (0190, `delete from clients` after
moving rows; see below).

**Why it matters.** After `accept_offer(A)` every sibling carries `declined_by = A, declined_from = 'open'`. Deleting A makes
Postgres run the `ON DELETE SET NULL` action, which nulls `declined_by` but not `declined_from`, so the pair-check fails and the
whole delete is refused. "I entered the accepted offer wrong, remove it and type it again" (the documented use of Remove offer)
and "I sent this to the wrong funder" both dead-end. The person sees the generic text "One of those values isn't allowed —
check the amounts and dates" (23514 goes through `checkMessage`'s fallback), which points at the wrong thing. It also breaks
`merge_clients` when the dropped card has an accepted offer on a submission that is a duplicate of one on the kept card: the
duplicate submission is not moved, its accepted offer is deleted with the dropped card, and a moved sibling still points at it.
Purge does NOT hit this (every offer of the merchant goes in one cascade statement), which is why the purge test passes.

**Reproduction** (plain SQL; any migrated scratch DB with a user `1111...`; I ran it against `rev4_scratch`):

```sql
begin;
set local role isaac_app;
select set_config('app.user_id','11111111-1111-1111-1111-111111111111',true);
select id as cid from create_client('{"business_name":"Repro C1","phone":"5550009999"}'::jsonb,
  jsonb_build_array(jsonb_build_object('kind','follow_up','due_on',current_date + 1))) \gset
insert into funders (user_id,name) values (app.current_user_id(),'C1-A'||random()), (app.current_user_id(),'C1-B'||random());
select array_agg(id) as fids from funders where name like 'C1-%' \gset
select s.id as s1 from create_submissions(:'cid', :'fids'::uuid[]) s order by s.created_at limit 1 \gset
select o1.id as o1 from record_offer(:'s1', '{"amount_cents":5000000,"factor_rate":1.3}') o1 \gset
select s.id as s2 from submissions s where s.client_id = :'cid' and s.id <> :'s1' \gset
select o2.id as o2 from record_offer(:'s2', '{"amount_cents":4000000,"factor_rate":1.35}') o2 \gset
select id, status from accept_offer(:'o1');
select status, declined_by is not null as declined_by_set, declined_from from offers where id = :'o2';
select remove_submission(:'s1');
rollback;
```

Output:

```
 81b76b37-39d3-4c0c-a62d-528a8b36e990 | accepted
 declined | t               | open
psql:repro_c1.sql:14: ERROR:  new row for relation "offers" violates check constraint "offers_declined_pair"
CONTEXT:  SQL statement "UPDATE ONLY "public"."offers" SET "declined_by" = NULL WHERE $1 OPERATOR(pg_catalog.=) "declined_by""
SQL statement "delete from submissions where id = s.id"
PL/pgSQL function remove_submission(uuid) line 14 at SQL statement
```

Through the app's own functions (`tsx`, `removeOffer`/`removeSubmission` from `src/lib/funders/mutations.ts`, then `toActionError`):

```
removeOffer(accepted offer) -> 23514 | new row for relation "offers" violates check constraint "offers_declined_pair" | user sees: "One of those values isn't allowed — check the amounts and dates"
removeSubmission(its submission) -> 23514 | ... | user sees: "One of those values isn't allowed — check the amounts and dates"
```

`merge_clients` (0190 applied to the scratch DB; both cards sent to funder F1 the same day, the drop card also to F2, drop's F1
offer accepted so its F2 offer is `declined_by` it):

```
ERR  merge_clients where the dropped card's accepted offer is a duplicate that gets deleted -> 23514 new row for relation "offers" violates check constraint "offers_declined_pair" [offers_declined_pair]
```

**Suggested fix.** Either (a) relax the check to `check (declined_by is null or declined_from is not null)` — I applied this in a
rolled-back transaction and the delete then succeeds, leaving the sibling `declined / declined_by null / declined_from open`; or
(b) better for the person, make "remove the accepted offer" behave like "Undo accept" first: in `remove_submission` and in a new
`remove_offer(p_offer)` SQL function, bring the siblings back (the same `update offers x set status = ..., declined_by = null,
declined_from = null where x.declined_by = <this offer>` block as `set_offer_status`) before the delete. Do not do (b) as a BEFORE
DELETE trigger: it would update rows of a trashed merchant during purge and `offers_live_only` would refuse it. Make
`removeOffer` go through a function that locks the client first (it is the one remaining bare child-row write that skips the
A-16 lock order). Add a test that removes an accepted offer and its submission and asserts the sibling's status in the table.

---

### C-2 [bug] CONFIRMED — A backup taken while anything is being written can be a file that cannot be restored

**Where.** `src/lib/export/backup.ts:48-80` (`buildBackup` runs 13 separate `select ... from <table>` statements) inside
`db.withUser` (`src/app/api/export/backup/route.ts:11`), which is a READ COMMITTED transaction: each statement gets a new
snapshot.

**Why it matters.** A merchant created (a lead webhook, a second tab) between the `clients` select and the `activities`/`timers`
selects puts child rows in the file whose parent is not in it. Restore then dies on the foreign key and rolls everything back.
Nobody finds out until the day the backup is needed. The window is small per backup but real, and the lead webhook is exactly an
unattended writer.

**Reproduction** (`tsx`; wraps the connection so a second connection commits a new merchant right after the `clients` select,
then restores the produced file into a migrated empty database):

```ts
const wrapped = {
  query: async (sql, p) => {
    const r = await c.query(sql, p);
    if (!fired && /from clients t order by/.test(sql)) {
      fired = true;
      await mk("Landed During Backup");
    } // other connection, committed
    return r;
  },
};
const backup = await buildBackup(wrapped); // buildBackup(q) from src/lib/export/backup.ts
// orphan check, then restoreBackup(...) into rev4_restore inside begin/commit
```

Output:

```
clients in file: 1  activities whose client is NOT in the file: 1
restore FAILED: 23503 insert or update on table "timers" violates foreign key constraint "timers_client_id_user_id_fkey"
```

**Suggested fix.** Build the whole backup in one statement (`select jsonb_build_object('clients', (select coalesce(jsonb_agg(to_jsonb(t)
order by ...), '[]') from clients t), 'timers', (...), ...)`): one statement is one snapshot. (`set transaction isolation level
repeatable read` is not available because `withUser` has already run queries.) Add a test that interleaves a write like the
script above, and have the route (or `checkBackup`) assert referential closure before sending the file.

---

### C-3 [bug] CONFIRMED — Undo after booking a call from the new "when is the call?" dialog leaves the call booked

**Where.** `src/components/stage-move/useStageMove.tsx:83` passes `wroteRecord = "funding" in extra || "competitor" in extra`; a
move that sent `callAt` (`src/lib/data/mutations.ts:195-200`, `schedule_call`) is not counted, so the toast offers Undo.
`undoInput` (`forms.ts:266-283`) then just moves the stage back.

**Why it matters.** The toast says "Undone — X is back in Interested", but `clients.scheduled_call_at` and an open
`scheduled_call` timer are still there (booked calls deliberately survive stage moves, `app.replace_timers`). The merchant sits in
Interested with a phantom appointment, a reminder will fire for it, and Today will show it. The person believes he undid the call.

**Reproduction** (`tsx`, real `moveClient` + real `undoInput`, as user 1111 in `rev4_scratch`):

```
before: interested null
after drag + CallDialog: call_scheduled 2026-10-25T15:00:00+00:00
undo input: {"clientId":"90c05747-...","stage":"interested","followUpOn":"2026-10-27"}
after Undo: interested scheduled_call_at = 2026-10-25T15:00:00+00:00
[ { kind: 'follow_up', ... open: false }, { kind: 'follow_up', ... open: false },
  { kind: 'scheduled_call', due_on: '2026-10-25', open: true },
  { kind: 'follow_up', due_on: '2026-10-26', open: false }, { kind: 'follow_up', due_on: '2026-10-27', open: true } ]
```

**Suggested fix.** Count `callAt` as a written record (`"funding" in extra || "competitor" in extra || "callAt" in extra`) so no
Undo is offered, or make that undo call `cancel_call` (which since 0160 closes the timer and restores the previous stage). Add a
test in `tests/` that runs the move and the undo input and asserts `scheduled_call_at is null` afterwards.

---

### C-4 [bug] CONFIRMED — Flipping the Dollars/Points switch in "Update funding" and saving rewrites the stored commission

**Where.** `src/lib/earnings/terms.ts:226-247` (`switchCommissionMode`) rounds points to 2 decimals (`formatPoints`) and
`checkTerms` (`terms.ts:168-187`) turns that text back into cents; `changedTermsPayload` (`terms.ts:313`) then sees a different
`commission` and sends it.

**Why it matters.** Money field silently changes by a few dollars from a display toggle, and (because 0130 logs commission changes)
the timeline records "commission $2,533 -> $2,535" for something he never typed. It also defeats the "send only what changed"
guarantee (A-12) for exactly the field the shop cares about.

**Reproduction** (`tsx`, pure functions; a stored commission of $2,533.00 on a $50,000 advance):

```
stored commission  : $2533 | box after switching to points: "5.07"
commission it would save: $2535
payload sent for a toggle-only 'edit': {"fundingId":"f1","commission":"2535"}
```

**Suggested fix.** Treat the commission as unchanged unless the user edited the text: keep the original cents in the form state
and only recompute `commissionCents` when `commission` text differs from what `switchCommissionMode` produced from them (or
compare `now.commissionCents` to `before.commissionCents` only when the text is not the rounded rendering of `before`). Add a
test: toggle mode and back, assert `changedTermsPayload` returns null.

---

### C-5 [bug] CONFIRMED — Restore drops the settings the backup carries (time zone, signature, application link, digest)

**Where.** `src/lib/export/backup.ts:49-58` writes `profile` (timezone, signature, application_link, notify_email, digest_*);
`src/lib/export/restore.ts` never reads `backup.profile`. `docs/BACKUP.md` says the file includes "his display settings".

**Why it matters.** After a disaster restore the account comes back with `timezone = 'UTC'`. Since 0160 that value drives
`app.local_today()` inside ten SQL functions (next business day, "today" for submissions, restore, DNC dates), so every
evening-hours action in New York lands a day late again until he finds the setting. The e-mail signature and application link
used by every message template are gone.

**Reproduction** (`tsx`, user 1111 given non-default settings, backup built, restored into an empty account in another DB):

```
backup.profile = {"name":"","email":"a@x.test","timezone":"America/Chicago","signature":"Best, Isaac","digest_hour":7,"notify_email":"alerts@example.com","digest_enabled":true,"application_link":"https://apply.example.com/x"}
restored counts {"clients":1,"client_asks":0,"positions":0,"competing_offers":0,"fundings":0,"stips":0,"funders":13,"submissions":2,"offers":2,"timers":4,"activities":6,"snippets":0,"trashed_clients":0}
[ { email: 'restore@x.test', timezone: 'UTC', signature: '', application_link: '', notify_email: null, digest_hour: 8 } ]
```

**Suggested fix.** In `restoreBackup`, after the rows go in, `update app_users set timezone, signature, application_link,
digest_enabled, digest_hour = ... where id = $target` from `backup.profile` (leave `email` and `notify_email` alone, or restore
`notify_email` only if empty). Extend `tests/restore.test.ts` to compare the profile columns. Whichever you choose, say it in
`docs/BACKUP.md`.

---

## Risks

### C-6 [risk] CONFIRMED — `restore_rows` inserts NULL for any column the file does not mention, so an older backup cannot be restored after the next NOT NULL DEFAULT column is added

**Where.** `db/migrations/0180_restore_rows.sql:21-24`: the insert lists every non-generated column and selects each from
`jsonb_populate_recordset(null::<table>, $1)`, which yields NULL (not the column default) for a key that is absent.
`BACKUP_VERSION` (`src/lib/export/backup.ts:4`) is the only guard and is not tied to migrations.

**Why it matters.** The documented restore path is "fresh database after a disaster", i.e. a database migrated to the newest
schema receiving an older file. The first later migration that does `add column ... not null default ...` on one of the 13 tables
(0130 and 0140 both added columns; they happened to be nullable or on an excluded table) makes every older backup unrestorable.

**Reproduction** (`psql` against the restore DB, rolled back; simulates the next migration):

```sql
begin;
alter table snippets add column pinned boolean not null default false;
select app.restore_rows('snippets', jsonb_build_array(jsonb_build_object(
  'id','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','user_id','33333333-3333-3333-3333-333333333333',
  'title','Hi','kind','text','body','Hi there','sort',0,'created_at','2026-10-01T00:00:00Z')));
rollback;
```

```
ERROR:  null value in column "pinned" of relation "snippets" violates not-null constraint
CONTEXT:  SQL statement "insert into snippets (id, user_id, title, kind, body, sort, created_at, pinned) select id, user_id, title, kind, body, sort, created_at, pinned from jsonb_populate_recordset(null::snippets, $1)"
```

**Suggested fix.** Build the column list from the keys actually present in the first row (`select string_agg(quote_ident(c.column_name),
', ') from information_schema.columns c where ... and p_rows->0 ? c.column_name`), so missing keys take their defaults. Add a
test that restores a file with one key removed from a table that has a default. Also add a guard test that every table in the
`public` schema is either in `BACKUP_TABLES` or on a named exclusion list (today they all are: see "Looked at"), so a table added
later cannot silently fall out of the backup.

---

### C-7 [risk] CONFIRMED — The trash freeze (0170) only covers insert/update; a stale tab can still delete a trashed merchant's offer

**Where.** `db/migrations/0170_live_only_children.sql:3-4` ("Deletes are left alone on purpose"), triggers are `before insert or
update`; `src/lib/funders/mutations.ts:125` is a bare `delete from offers`.

**Why it matters.** A-13 says a merchant in the trash "can't be edited from a stale tab", and `set_offer_status`,
`record_offer`, `remove_submission` (via `ensure_open_timer`) are refused, but "Remove offer" in `SubmissionsCard` still works and
destroys the offer of a merchant who is in the trash.

**Reproduction** (`node`, as user 1111):

```
ERR  trashed merchant: set_offer_status (edit) -> 22023 That merchant is in the trash — restore it first
OK   trashed merchant: DELETE offer from a stale tab (removeOffer SQL) [{"id":"1185cac9-1140-4fde-912e-828dac9a9dd1"}]
ERR  trashed merchant: remove_submission -> 22023 That merchant is in the trash — restore it first
left: [ { offers: 0, subs: 2 } ]
```

**Suggested fix.** Add `before delete` triggers on the three tables that refuse only a direct statement. RI cascades (purge)
run one trigger level deeper, so `pg_trigger_depth() = 1` separates them. I tried exactly this in the scratch DB:

```sql
create function app.refuse_delete_when_trashed() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if pg_trigger_depth() = 1 and exists (select 1 from trashed_clients t where t.client_id = old.client_id) then
    raise exception 'That merchant is in the trash — restore it first' using errcode = '22023';
  end if;
  return old;
end $$;
```

Result: `ERR direct DELETE of a trashed merchant's offer -> 22023 That merchant is in the trash` and
`OK purge_client of the other trashed merchant [{"purge_client":""}]`. Add the delete case to the A-13 tests.

---

### C-8 [risk] CONFIRMED — The "Funded" dialog and `record_funding` accept advances that "Update funding" then refuses to save at all

**Where.** `src/components/stage-move/forms.ts:117-160` (`checkFunding`) and `record_funding` (`db/migrations/0001_init.sql:592`,
no range checks) versus `src/lib/earnings/terms.ts:checkTerms` and `FundingCard.tsx:335` (`save()` returns when `errors` is non-empty).

**Why it matters.** `update_funding_terms` was written so "an unrelated edit is never blocked by an old row that predates a rule"
(0130:381-382), but the dialog validates the whole form, not the changed keys. An advance created through the move dialog with
position above 20, a remittance that implies a payoff over 5 years, or a commission larger than the advance shows errors on an
untouched form, so he cannot even record "commission received" until he edits the unrelated field.

**Reproduction.**

```
Funded dialog errors: {}
Update-funding errors on an UNTOUCHED form: {"positionNo":"Position must be a whole number from 1 to 20","payment":"At $10 this advance would take more than 5 years to pay back — check the remittance amount","commission":"Commission can't be more than the advance"}
OK   record_funding position 25, $10/day on $50k, commission $60k > amount {"id":"4f0e971e-...","position_no":25,"payment_cents":"1000","commission_cents":"6000000"}
```

**Suggested fix.** Put the same range checks in `record_funding` and `checkFunding` (one shared rule set), and make the Update
dialog block only on errors for fields whose value differs from `initial`. Test: open an advance with an out-of-range legacy
field and change only the note.

---

### C-9 [risk] CONFIRMED — The backup file the app downloads is not git-ignored

**Where.** `.gitignore`; the route names the file `isaac-backup-YYYY-MM-DD.json` (`src/app/api/export/backup/route.ts:14`), and
`docs/BACKUP.md` tells the operator to run the restore with that filename from the repo directory.

**Why it matters.** It is the whole customer list (names, phones, e-mails, revenue, funding terms). CLAUDE.md puts merchant data
behind authenticated access and out of git. One `git add .` after a restore rehearsal publishes it. The CSV exports
(`isaac-clients-*.csv`, `isaac-activity-*.csv`) have the same gap.

**Reproduction.**

```
$ git check-ignore -v isaac-backup-2026-10-23.json || echo "NOT ignored: isaac-backup-*.json"
NOT ignored: isaac-backup-*.json
```

**Suggested fix.** Add `isaac-backup-*.json`, `isaac-clients-*.csv`, `isaac-activity-*.csv` to `.gitignore`.

---

## Nits

### C-10 [nit] CONFIRMED — "Update funding" still stores a bare `6` as $6.00 (and `6,5` as $65); the QA I-3 guard exists only in the Funded dialog

**Where.** `src/lib/earnings/terms.ts:168-187` (dollars mode calls `parseMoney` directly) versus `parseCommissionText`
(`src/lib/earnings/commission.ts:18-46`). **Output:**

```
Update-funding dialog, commission box '6' (dollars mode): {"errors":{},"commissionCents":600}
Funded dialog, '6': {"ok":false,"error":"Is 6 points or dollars? Type 6% for points, or $6 for dollars"}
"6,5" -> {"ok":true,"cents":6500,"viaPoints":false}
```

**Fix.** Use `parseCommissionText` in `checkTerms` for the dollars mode, and treat a comma that is not followed by exactly three
digits as an error.

### C-11 [nit] CONFIRMED — the "today is the user's day" sweep (A-21) left server-date uses behind

`src/lib/data/mutations.ts:164` and `:450` use `coalesce($9::date, current_date)` for `competing_offers.offered_on`, and the
column defaults `offers.received_on`, `submissions.sent_on`, `competing_offers.offered_on` are `CURRENT_DATE`. `psql` listing of
`information_schema.columns where column_default ~* 'current_date'` and `grep -rn current_date src` show exactly these. At 8 PM New
York a lost-deal record is dated tomorrow. Fix: pass `ctx.today` from TypeScript in both statements. (`app.assert_due_on` and
`lead_token_take_slot` use `current_date` on purpose: the first has a one-day slack, the second is a UTC-day cap.)

### C-12 [nit] CONFIRMED — dates that pass the zod regex but are not dates reach the database and come back as "Something went wrong"

`isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)` in `src/lib/data/schemas.ts:7`, `src/lib/earnings/schemas.ts:6`,
`src/lib/funders/schemas.ts:11`. `termsUpdateSchema.safeParse({fundingId, fundedOn: "2026-02-31"}).success` is `true`; calling
`update_funding_terms` with it raised `22008 date/time field value out of range: "2026-02-30"` (600-call fuzz of
`update_funding_terms`: the only non-22023/P0002 errors were type garbage of this kind), which `toActionError` maps to
"Something went wrong — try again" and logs. A date picker cannot produce it, so impact is low. Fix: refine with a real calendar
check, or add `22007`/`22008` to the plain-words list.

### C-13 [nit] CONFIRMED — the restore script mis-reports a mixed-case e-mail and gives no check that it is the intended account

`scripts/restore-backup.ts:20-25` looks the account up with the e-mail exactly as typed, but `app_users` stores lower case
(`app_users_email_lower`), so:

```
$ DATABASE_URL=.../rev4_restore npx tsx scripts/restore-backup.ts /nonexistent.json Restore@X.test
No account with the email Restore@X.test — sign in once first so it exists
```

for an account that exists as `restore@x.test`. A missing file prints a raw stack. Also, nothing compares `backup.profile.email`
with the target, or prints "restoring N merchants from <email> into <email>" before writing; the only guard is "target has no
merchants" (it does not check funders or snippets). Restoring into an account with no merchants but one funder of the same name
(`rev4_restore2`) fails only after the work, with the database's own text:

```
restore into an account with no merchants but one funder -> DatabaseError 23505 duplicate key value violates unique constraint "funders_user_name_key"
```

Fix: `email.toLowerCase()`, print the source and target and the counts, refuse (or require `--yes`) on a
different e-mail, and check emptiness of every restored table.

---

## Questions

### C-14 [nit] QUESTION — the Paid-in-full list on Renewals still shows do-not-contact merchants as "hot"

`src/lib/earnings/radar.ts:150-165`: A-4 removed do-not-contact merchants from the Ready list and the forecast, but the
`paidInFull` loop has no `notRenewable` guard. A probe with one `ok` and one `dnc` paid-in-full merchant:

```
paid-in-full list: [ 'dnc-merchant (dnc) hot=true', 'ok-merchant (ok) hot=true' ]
```

The page copy there is "the best time to call". The Call button is disabled for DNC by `ContactActions`, so it is not unsafe,
but is the list meant to include them? If not, tally them into `excluded.dnc`.

### C-15 [nit] QUESTION — undoing a switched acceptance leaves the earlier-accepted offer open, not accepted

`db/migrations/0130_review_3a.sql:248-251` maps `declined_from = 'accepted'` to `open`; `tests/review-3a.test.ts:208` is titled
"switching the accepted offer works, and undoing the switch puts the first one back" but asserts `{ o1: "open", o2: "open", o3:
"open" }`. If "undo" means back to the state before the second acceptance, o1 should be `accepted` again. If open is intended, the
test title and the timeline text ("N other offers are back on the table") are fine and this is only the name.

---

## What the existing tests do not cover (for whoever writes the next tests)

- `tests/review-3a.test.ts` A-8: nothing removes an accepted offer or its submission (C-1); nothing exercises `merge_clients` with
  accepted offers.
- A-13 trash tests: inserts/updates only, no delete (C-7).
- `tests/backup.test.ts` / `tests/restore.test.ts`: no concurrent write while exporting (C-2), no assertion on `profile` after a
  restore (C-5), no restore of a file that predates a column (C-6), no "every table is backed up or excluded" catalog test.
- Stage-move: no test that runs `undoInput` for a move that sent `callAt` (C-3); `changedTermsPayload` is tested with typed edits
  but not with the mode switch (C-4).
- `checkTerms` vs `checkFunding` vs `record_funding`: no test that the same advance passes all three (C-8).

---

## Looked at and fine (do not re-review)

All of these were run, not just read.

- **0130 `update_funding_terms`.** 600 randomised calls (random key subsets, boundary and garbage values) against two advances of
  one merchant: every rejection was a 22023/P0002 sentence or a type error the zod layer prevents (C-12); afterwards both rows
  still satisfied commission <= amount, payment <= payback, last remittance >= funded date. Reorder refusal, "judged on the row as
  it was", client-first lock order (read: client `for update`, then the advance), and renewal re-derivation behave as the tests
  state. A date-only reorder is allowed by design and can leave the active advance older than a renewed one; I did not count that.
- **0130 `accept_offer` / `set_offer_status` logic** (apart from C-1, C-15): switch, undo, himself-declined sibling stays,
  funder-pulled sibling stays, expired/declined refusal, client-first order. The 40-round race tests pass.
- **Purge cascade with `declined_by` chains.** `purge_client` on a trashed merchant with accepted-first, -middle and -last of
  three offers all succeed (the `ON DELETE SET NULL` update does not fire on rows already deleted by the same cascade).
- **0140 lead cap and mark, route level** (real `POST` handler against `rev4_scratch`): lower-case `bearer` works; BOM body works;
  junk phone `N/A` + e-mail creates a card; junk phone only is a 400; duplicate by phone is a 200 and takes no slot, also at cap;
  a new lead at 200 is a 429 with the explanatory text; one "Added by lead connection" activity per created card. The slot is taken
  by a single conditional `update`, so concurrent requests cannot exceed the cap, and a rollback gives it back. Lock order is
  advisory locks first, token row second, in every path (no cycle).
- **0150 `set_follow_up`.** Every caller found by grep: `mutations.setFollowUp` (passes the flag), `moveToBucket` (true), the two
  `intake.ts` calls and `overdue.applyMoves` (3 args, default false = old behaviour), no SQL function calls it. `drop function`
  - recreate lost no grant (`PUBLIC` execute).
- **0160.** I diffed `pg_get_functiondef` for every `public`/`app` function between a database migrated to 0150 and one migrated
  to 0190: the only changes are `current_date` -> `app.local_today()` in ten functions (`cancel_call`, `create_submissions`,
  `ensure_open_timer`, `log_touch`, `promote_to_offers_in`, `record_offer`, `replace_timers`, `restore_client`,
  `set_contact_status`, `set_submission_status`), the new stage restore in `cancel_call`, and the new objects. `cancel_call`'s previous-stage lookup, including re-booking and "no record" cases, behaves as documented.
  `app_users.timezone` is validated against `pg_timezone_names` before it is stored, so `local_today()` cannot raise.
- **0170.** No cron or system job writes to `fundings`, `submissions` or `offers` (grep of `src/`, `scripts/`, migrations);
  `trash_client`, `restore_client` (deletes the trash row first), `purge_client`, `record_funding` and the lead path are unaffected.
- **0180 / backup.** `restore_rows` table whitelist, `%I` quoting, `search_path`, generated-column exclusion, self-referencing
  `offers.declined_by` inside one insert, restore order (trash flags last), user id forced to the target on every row. `isaac_app`
  cannot execute it. Catalog check: every table in `public` is either backed up or deliberately left out (`app_users` as the
  profile only; `gmail_connections`, `lead_tokens`, `reminders_sent`, `job_runs`, `schema_migrations`, `stages` excluded). The
  route is authenticated, `no-store`, runs under RLS.
- **TypeScript.** `paybackCents` integer rounding against the database: 20,000 random (amount, factor) pairs, 0 mismatches
  (`round(a::numeric * f::numeric)`); `nameKey` vs `NAME_KEY_SQL`; Funded-dialog `parseCommissionText` edge cases; `notRenewable`
  wiring (callers pass `cards`); heartbeat's `REMINDER_ENV` matches what the cron route requires; `errors.ts` mapping (a
  few messages are imprecise, e.g. `offers_amount_cents_check` says "can't be negative" for $0, but I could not reach them from
  the UI: the funders `money` schema rejects $0 first); application-date
  stamping and `callAt` validation in `moveClient`.
- **Lock order outside the listed functions.** `set_stip_received` takes the stip row before the client's key-share; the only
  cycle I can construct is against a cascade delete of the same trashed merchant. Not worth a change.
- **CLAUDE.md rules.** No rule disabled, no skipped tests, no new table without RLS (none were added), no secret columns in the
  backup (`doc_key` is a storage key, not a document).
