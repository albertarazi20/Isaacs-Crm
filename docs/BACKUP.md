# Backup and restore

## Take one

Settings → **Your data** → **Full backup**. Type a passphrase (12 characters or more, twice) and press _Download encrypted
backup_; the file is `isaac-backup-<date>.enc.json`. The panel asks for a passphrase first; _Download without
encryption_ gives the plain `isaac-backup-<date>.json` instead. Managers only. It covers seven tables and the person's display settings:
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

### Encrypted backups

The encrypted file is a small JSON envelope: AES-256-GCM, with the key derived from the passphrase by scrypt (N=2^17,
r=8, p=1, a random 16-byte salt per file), a random 12-byte nonce per file, a versioned header, and the GCM tag. The header
(version, cipher, scrypt settings, salt, nonce) is authenticated together with the data, so changing any byte of the file
makes it fail to open. Only `node:crypto` is used. The passphrase is sent to the server in a POST body (never a URL),
used once to make the file, and not stored or logged.

**A lost passphrase cannot be recovered.** Nothing on the server can open the file, and the UI says so. Keep the
passphrase somewhere safe, apart from the file. GCM cannot tell a wrong passphrase from a changed file, so both give the
same refusal: _Wrong passphrase, or the file has been changed. Nothing was restored_.

The server holds no copy of a backup (see Retention below), so the file the manager downloads is the only one.

## Put one back

Restoring is an operator job, not a button: it writes rows under whatever account you name.

```sh
DATABASE_URL=postgres://… npx tsx scripts/restore-backup.ts isaac-backup-2026-10-23.json isaac@example.com
DATABASE_URL=postgres://… npx tsx scripts/restore-backup.ts isaac-backup-2026-10-23.enc.json isaac@example.com --require-encrypted
```

The script tells an encrypted file from a plain one by its contents, not its name. **Add `--require-encrypted`** whenever the backup is supposed to be encrypted: a plain file (or a file that is not a backup) is then refused with a clear message _before the database is even reached_, so a plain file swapped in for the real one, or a download made without a passphrase, cannot slip through as a downgrade. Without the flag a plain file still restores, but the script prints a loud warning on stderr (the file is not encrypted, delete every copy afterwards, use the flag to refuse plain files); an encrypted file prints no warning. For an encrypted one it asks for the
passphrase on the terminal (typed hidden), or reads `BACKUP_PASSPHRASE` from the environment when there is no terminal. It is
never a command-line argument (those show in shell history and `ps`). The file is decrypted and checked before the
database is touched at all, so a wrong passphrase or a damaged file exits with a message and writes nothing. A plain
backup restores exactly as before.

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
`tests/security-backup-restore.test.ts` does the same through the encrypted file: the restored rows are read back from the
database and compared; a wrong passphrase and a tampered file are shown to leave the target database with zero rows in every
backup table (also through the real `scripts/restore-backup.ts`, exit code and message); and a plain file still restores.
`tests/security-fixes-restore.test.ts` runs the real script: `--require-encrypted` refuses a plain file (and junk) with the target database still empty and before the database is reached, lets an encrypted one restore (rows read back), and a plain restore without the flag still works and prints the warning.
`tests/security-backup-crypto.test.ts` covers the envelope (tampering with every field, the scrypt cost limits, passphrase
rules) and `tests/security-backup-route.test.ts` the download route.
`pnpm e2e backup` downloads the file from the running app and checks its row counts against the database (the plain
download, `GET /api/export/backup`).

## Retention

Retention does not apply: **the app stores no backup anywhere.** `GET`/`POST /api/export/backup` builds the file from the
database for the manager who asked, streams it in that one response and keeps nothing: no storage bucket, no table, no
file on the server (the route is the only caller of `buildBackup`, and no migration creates a place for one). So there is
no server-side copy to delete after 30 days and no cron job for it. The only copies are the ones managers download; keeping or
deleting those is up to them, and they are encrypted unless the manager chose otherwise. (The hosted database's own
backups are the provider's, outside this app: see `docs/DEPLOY.md`.) If a stored backup is ever added, it must come with
a deletion of copies older than 30 days in an existing cron route, and a test.

## Not covered

Everything added after backup version 1 is **not** in the file: uploaded documents (their rows and the files),
signed applications, follow-up bucket enrolments, inbound emails and reply tags, the outbox and send history,
merchant offers, link opens, alerts, assistant conversations, lead sources and settings. Adding any of them needs
the table added to `app.restore_rows` (a migration), then to `BACKUP_TABLES`.

Bank statements and other documents are not in the app yet (see `docs/DECISIONS.md`), so there is nothing to back up
for them. Gmail has to be reconnected after a restore, and lead tokens re-made.
