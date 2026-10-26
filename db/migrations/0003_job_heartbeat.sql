-- Dead-man's switch for the hourly scheduler: each scheduled job writes the time it last ran to completion,
-- and the app shows a red banner when the reminder job has gone quiet.
--
-- System-only on purpose, like reminders_sent and gmail_connections: it holds no merchant data, but the
-- browser-facing role has no business reading or writing it. RLS is on and isaac_app is granted nothing,
-- so any query from that role fails with "permission denied". Only src/lib/system/heartbeat.ts touches
-- it, through withSystem().

create table job_runs (
  name text primary key check (btrim(name) <> '' and length(name) <= 64),
  last_run_at timestamptz not null
);

alter table job_runs enable row level security;
revoke all on job_runs from isaac_app;
