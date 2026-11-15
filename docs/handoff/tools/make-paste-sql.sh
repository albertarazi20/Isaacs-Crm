#!/usr/bin/env bash
# Build one paste-ready SQL file from a range of migrations, for the Supabase SQL Editor.
#   docs/handoff/tools/make-paste-sql.sh 0290 0290 > /tmp/paste.sql
# Each migration is followed by the insert that records it in schema_migrations, the same row `pnpm db:migrate` writes.
# The output is wrapped in begin/commit, so it is all or nothing. Prove it on a local database first.
# Exits non-zero when the arguments are not four-digit numbers or no migration file matches.
set -euo pipefail
from="${1:?first migration number, four digits, e.g. 0290}"
to="${2:?last migration number, four digits, e.g. 0290}"
[[ "$from" =~ ^[0-9]{4}$ && "$to" =~ ^[0-9]{4}$ ]] || { echo "migration numbers are four digits, e.g. 0290" >&2; exit 2; }
dir="$(cd "$(dirname "$0")/../../.." && pwd)/db/migrations"
body=""
matched=0
for f in "$dir"/*.sql; do
  b="$(basename "$f")"
  n="${b%%_*}"
  if [[ "$n" < "$from" || "$n" > "$to" ]]; then continue; fi
  matched=$((matched + 1))
  body+=$'\n'"-- ======== $b ========"$'\n'"$(cat "$f")"$'\n'
  body+="insert into schema_migrations (name) values ('$b');"$'\n'
done
if [[ "$matched" -eq 0 ]]; then echo "no migration files between $from and $to in $dir" >&2; exit 1; fi
echo "-- Isaac CRM database migrations $from to $to ($matched files). One transaction: all or nothing."
echo "begin;"
printf '%s' "$body"
echo "commit;"
