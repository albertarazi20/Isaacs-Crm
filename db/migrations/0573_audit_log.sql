-- 0573: the security audit log. One row per thing a manager would want to be able to answer "who did this, from where,
-- and when?" about: sign-ins (and the failed ones), sign-outs, team changes, lead-token and settings changes, Gmail
-- connections, and every export download. The app writes it; managers read it on Settings > Security.
--
-- Append-only for the app role: isaac_app is granted SELECT and nothing else, so no request can edit or erase a line.
-- Rows are written on the owner connection (withSystem, src/lib/system/audit.ts), like job_runs and passcode_attempts,
-- and the retention sweep (rows older than 180 days) runs there too. Row security lets only a manager read.
--
-- user_id and client_id are plain columns, not foreign keys: a line about a person or a merchant must outlive them
-- (a deleted merchant, a restored backup, a removed account), and a cascade here would let removing one erase the
-- record of what was done to it. Not in the JSON backup (system state, like access_log and passcode_attempts).
--
-- detail is for facts only (which settings keys changed, how many rows an export held, a label). Never a secret,
-- a token, a passcode or a merchant's own details; src/lib/system/audit.ts caps its size.

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  user_id uuid,
  email text not null default '',
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  ip text not null default '' check (length(ip) <= 64),
  user_agent text not null default '' check (length(user_agent) <= 300),
  detail jsonb not null default '{}'::jsonb,
  client_id uuid
);

create index audit_events_at_idx on audit_events (at desc);
create index audit_events_user_idx on audit_events (user_id, at desc);
-- the failed-sign-in and export counts look at one kind over the last hour or so
create index audit_events_kind_idx on audit_events (kind, at desc);

alter table audit_events enable row level security;
revoke all on audit_events from isaac_app;
grant select on audit_events to isaac_app;
create policy audit_events_manager_read on audit_events for select to isaac_app using (app.can_see_all());
