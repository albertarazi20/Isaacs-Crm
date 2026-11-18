# Backup and restore

## Take one

Settings → **Your data** → _Download a full backup (.json)_. It covers seven tables and the person's display settings:
merchants (`clients`), the merchants in the trash (`trashed_clients`), what each merchant asked for (`client_asks`),
the document checklist (`stips`), follow-up timers (`timers`), the timeline of notes, calls and emails
(`activities`) and saved snippets (`snippets`). `BACKUP_TABLES` in `src/lib/export/backup.ts` is the list.
It holds **no** Gmail access, lead-token fingerprints, sessions or passwords, and none of a merchant's `upload_token`
or `application_token` (anyone holding one can open that merchant's documents or application). It DOES hold each
merchant's `unsubscribe_token`: it can only unsubscribe that one merchant, and a restore needs it so the links in emails
already sent keep working (see below). `tests/backup.test.ts` and `tests/round2-backup.test.ts` fail if a bearer
token, hash or session appears in the file. Treat it like a customer list anyway: it has names, phone numbers, funding
terms and those unsubscribe links.

Also on that card: the merchants and all-notes CSVs.

## Put one back

Restoring is an operator job, not a button: it writes rows under whatever account you name.

```sh
DATABASE_URL=postgres://… npx tsx scripts/restore-backup.ts isaac-backup-2026-10-23.json isaac@example.com
```

- The account (by sign-in email) must already exist (sign in once) and must be **empty** — no merchants.
- It must be a database that does not still hold the originals (ids are kept, so a restore on top of the same data is
  refused rather than half-done). The normal case is a fresh database after a disaster, or a copy for testing.
- All or nothing: one transaction. The script prints how many rows went back into each table.
- Every merchant gets a **new** upload token and application token on restore (also from an old backup file that still
  carries them), so an old upload or application link stops working for the restored merchants. The
  **unsubscribe token is restored as it was**: every email already sent carries `/u/<token>` and a one-click
  List-Unsubscribe link, and those must keep working after a restore (CAN-SPAM, Gmail one-click). A backup file with no
  unsubscribe tokens (one made earlier on 2026-11-18) still restores; those merchants get new ones.
- Advance paybacks are recomputed by the database, not copied. The trash flags go in last, so a trashed merchant is
  still trashed afterwards.

## Proven how

`tests/restore.test.ts` backs up one database and restores it into a second, then reads both back and compares every
table row by row (ignoring only the account id), including a trashed merchant, an accepted/declined offer pair and an
advance whose payback is generated.
`pnpm e2e backup` downloads the file from the running app and checks its row counts against the database.

## Not covered

Everything added after backup version 1 is **not** in the file: uploaded documents (their rows and the files),
signed applications, follow-up bucket enrolments, inbound emails and reply tags, the outbox and send history,
merchant offers, link opens, alerts, assistant conversations, lead sources and settings. Adding any of them needs
the table added to `app.restore_rows` (a migration), then to `BACKUP_TABLES`.

Bank statements and other documents are not in the app yet (see `docs/DECISIONS.md`), so there is nothing to back up
for them. Gmail has to be reconnected after a restore, and lead tokens re-made.
