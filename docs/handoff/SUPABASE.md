# The database (Supabase)

No password, key or connection string with a password is in this repo. Never add one.

## The project

| Fact                  | Value                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project ref           | `vngxqywqqdmucvcdjfec`                                                                                                                                 |
| Name in the dashboard | an email address used as a name (not Isaac's). Rename it to `isaac-crm` in Settings                                                                    |
| Organization          | named after a different client's work. The connector sees everything in the organization, so the owner should move Isaac to an organization of its own |
| Region, version       | us-east-1, Postgres 17.11                                                                                                                              |
| Created               | 2026-10-25                                                                                                                                             |
| Used by               | this app only. It is Isaac's database. David's CRM and BH have their own                                                                               |

If a connector lists other projects, ignore them. **Every call passes `project_id` `vngxqywqqdmucvcdjfec`.** Before any write, run
`select count(*) from schema_migrations` and confirm it is 31 (or the number you expect). Never use the connector's `apply_migration`: it
records in Supabase's own migration table, not in `schema_migrations`, so the runner and the fingerprint check would drift. Putting a
`DATABASE_URL` with a password into a session would break the no-secrets rule; the paste method below is the clean route.

## Connection (what the running app uses)

- App: the **Transaction pooler**, port 6543, host copied from the dashboard (Connect button). Append `?sslmode=no-verify` and
  URL-encode the password. Every request is one transaction (`begin; set local role isaac_app; ...; commit`), which transaction
  pooling allows. All session state in the code is `set local` or `set_config(..., true)`.
- `?sslmode=no-verify` encrypts but does not check who answered. Supabase's pooler certificate does not chain to a public
  authority, so strict verification likely fails (unverified until a live connect). Pinning Supabase's CA in code is on the backlog.
- Migrations by command line: `DATABASE_URL=... pnpm db:migrate` against the **Session pooler** (port 5432) or the direct host. Never
  port 6543: the runner takes a session-level advisory lock. The direct host is IPv6 only.
- Roles: the app connects as the owner role and drops to `isaac_app` per request (`src/lib/db/index.ts`). `isaac_app` cannot bypass row-level
  security. Supabase's own `anon` and `authenticated` roles have no table grants (migration 0060). The app never uses Supabase's data API.

## Supabase-specific behavior found the hard way

- Supabase turns row-level security **on for every new table** (an event trigger runs `public.rls_auto_enable`). The shared `stages`
  table had no policy, so the app saw it as empty and a funder's "yes" silently never moved a deal. Migration `0230_stages_readable.sql`
  fixes it; `tests/hosted-rls.test.ts` shows the failure and the fix. Keep that test passing on any new reference table.
- The SQL editor and the connector may ask the user to confirm destructive statements (`drop view` and similar). That prompt may never
  reach the user, and the call times out after 60 seconds. Do not disguise statements to avoid it. Use the paste method below.

## How to apply a new migration (three ways, in order of preference)

1. **Test it locally first.** Create a scratch database with Supabase-like roles (`anon`, `authenticated`, `service_role`) and a
   non-superuser owner, run `pnpm db:migrate`, run the test suite. The first session did exactly this with Postgres 16.
2. **Paste method (most reliable):** `docs/handoff/tools/make-paste-sql.sh 0290 0290 > file.sql`, give the file to the owner, and have
   him paste it into Supabase, then SQL Editor, then New query, then Run. The script wraps the file in `begin; ... commit;`, so it is all or nothing.
3. **Connector:** `execute_sql` with the same text plus `insert into schema_migrations (name) values ('<file>');`. Works for
   statements that do not trigger the confirmation prompt.

Always record the migration in `schema_migrations` (the paste script does), and verify afterwards.

## Verify the live database equals the code

`tools/fingerprint.sql` returns 10 rows (columns, constraints, indexes, functions, policies, triggers, RLS flags, views, grants for
`isaac_app`, grants for `anon` and `authenticated`) with a count and an md5. Run it on a fresh local migrate and on the project, then compare. Also compare the migration list:
`select count(*), md5(string_agg(name, '|' order by name)) from schema_migrations`. It excludes two things Supabase adds itself:
`public.rls_auto_enable` and RLS on `schema_migrations`.

Result on 2026-11-15, project versus a fresh local migrate of all 31 files: **identical in all 10 rows and in the migration list.**

| Category                           | Count | md5                                |
| ---------------------------------- | ----- | ---------------------------------- |
| columns                            | 266   | `c9da76d7dd636e0ff2e74d15bddc9e13` |
| constraints                        | 126   | `74272f4d0bf0ab2259d17b4b0549e506` |
| functions                          | 48    | `9b516e3369ced3689daf029d8f0baf24` |
| indexes                            | 47    | `79735b82ce377dccac1f41f0d7dae8d5` |
| policies                           | 20    | `de0c0415b9340431aeb2e1ff03c39dc1` |
| triggers                           | 13    | `f521d9823afbac51609e32369a54a7fa` |
| RLS flags                          | 20    | `bae15c34cd1cb4dd8a29f79c75609d58` |
| views                              | 1     | `3cb12a3adac39808559aa1ee37750667` |
| grants, `isaac_app`                | 52    | `c8c0a285fa00c0dc2c2172df25d3436c` |
| grants, `anon` and `authenticated` | 0     | `d41d8cd98f00b204e9800998ecf8427e` |
| migrations                         | 31    | `9eb1cbd54ace265254ad119a3f68a6a4` |

After you add a migration these numbers change. Re-run and update this table.

## Security advisor (run 2026-11-15, type "security")

- INFO, 4 tables with row-level security on and no policy: `gmail_connections`, `job_runs`, `reminders_sent`, `schema_migrations`.
  **Intentional.** They are system-only; `isaac_app` has no grants on them and only the owner connection touches them.
- WARN, 2 functions with a mutable `search_path`: `app.current_user_id` and `app.touch_updated_at`. Real, small, fixable: add
  `set search_path = ''` or a pinned path in a new migration (qualify names). Listed in `NEXT-STEPS.md`.
- WARN, `public.rls_auto_enable()` is `SECURITY DEFINER` and executable by `anon` and `authenticated`. This is Supabase's own function,
  not ours. Revoking execute from those roles is reasonable; check that it does not break the event trigger before doing it.

## The schema as SQL

`schema/public-and-app.sql` is `pg_dump --schema-only` of a fresh local migrate of all 31 files (schemas `public` and `app`),
generated 2026-11-15. It is a reading aid, not a way to build the database: build it with the migrations.
