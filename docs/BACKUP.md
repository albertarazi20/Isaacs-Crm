# Backup and restore

## Take one

Settings → **Your data** → _Download a full backup (.json)_. It is every merchant, advance, offer, submission, note,
timer and saved snippet Isaac has put in, plus his display settings. It holds **no** Gmail access, lead-token
fingerprints, sessions or passwords (`tests/backup.test.ts` fails if any of those appear). Treat it like a customer
list anyway: it has names, phone numbers and funding terms.

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
- Advance paybacks are recomputed by the database, not copied. The trash flags go in last, so a trashed merchant is
  still trashed afterwards.

## Proven how

`tests/restore.test.ts` backs up one database and restores it into a second, then reads both back and compares every
table row by row (ignoring only the account id), including a trashed merchant, an accepted/declined offer pair and an
advance whose payback is generated.
`pnpm e2e backup` downloads the file from the running app and checks its row counts against the database.

## Not covered

Bank statements and other documents are not in the app yet (see `docs/DECISIONS.md`), so there is nothing to back up
for them. Gmail has to be reconnected after a restore, and lead tokens re-made.
