-- Dashboard: monthly goals. Everything else the dashboard shows is computed from tables that already exist.
--
-- A goal is a funded-dollar target (and optionally a deal count) for one month, per rep, plus one for the whole
-- shop (user_id null). Managers set them; everyone reads them, so a rep sees their own line and the shop's.

create table goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references app_users (id) on delete cascade,              -- null = the whole shop
  month date not null check (month = date_trunc('month', month)::date),
  funded_cents bigint not null default 0 check (funded_cents >= 0),
  deals int not null default 0 check (deals >= 0),
  set_by uuid references app_users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique nulls not distinct (user_id, month)
);
create index goals_month_idx on goals (month);
grant select, insert, update, delete on goals to isaac_app;
alter table goals enable row level security;
create policy goals_read on goals for select to isaac_app using (true);
create policy goals_manager_write on goals for all to isaac_app
  using (app.can_see_all()) with check (app.can_see_all());
create trigger goals_touch before update on goals for each row execute function app.touch_updated_at();

-- The shop's first goal row, so the dashboard has something to show before a manager types a number.
insert into goals (user_id, month) values (null, date_trunc('month', current_date)::date) on conflict do nothing;
