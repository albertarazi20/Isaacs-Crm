-- The alert feed (plan §3 "Alerts", §6 "approval landed", §7 "Ask manager", §14 trust alerts): one row per thing a
-- person should hear about. Pages read it; the hourly job emails what is unsent (bundled per person). Anyone may
-- write a row for anyone (a rep asking a manager, the inbox reader telling a rep); a person reads and marks only
-- their own. dedupe_key stops the same alert landing twice (one "deal sitting too long" per deal per day).
create table user_alerts (
  id bigint generated always as identity primary key,
  user_id uuid not null references app_users (id) on delete cascade,
  kind text not null,
  client_id uuid references clients (id) on delete cascade,
  deal_id uuid references deals (id) on delete cascade,
  title text not null,
  body text not null default '',
  href text not null default '',
  dedupe_key text,
  created_at timestamptz not null default now(),
  emailed_at timestamptz,
  read_at timestamptz
);
create unique index user_alerts_dedupe_idx on user_alerts (user_id, dedupe_key) where dedupe_key is not null;
create index user_alerts_unsent_idx on user_alerts (user_id, created_at) where emailed_at is null;
create index user_alerts_feed_idx on user_alerts (user_id, created_at desc);
grant select, insert, update on user_alerts to isaac_app;
alter table user_alerts enable row level security;
create policy user_alerts_read on user_alerts for select to isaac_app
  using (user_id = app.current_user_id());
create policy user_alerts_write on user_alerts for insert to isaac_app with check (true);
create policy user_alerts_mark on user_alerts for update to isaac_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

-- Managers as a set: every stream alerts "the managers" the same way.
create function app.manager_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select id from app_users where role = 'manager' and active
$$;
revoke execute on function app.manager_ids() from public;
grant execute on function app.manager_ids() to isaac_app;
