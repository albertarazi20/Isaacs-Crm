-- Google Sheets lead sync.
--   sheet_sources — a sheet + tab a rep (or the shop) pulls leads from, with its column mapping and target bucket.
--   sheet_rows    — the staged copy of every row seen, keyed by the normalised phone (and the row's hash), so the
--                   intake form can look a number up instantly and the daily loop can tell new rows from old.
-- The CRM reads the sheet through the connected Google account (spreadsheets.readonly). Reps never need the sheet.

create table sheet_sources (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references app_users (id) on delete cascade,     -- null = shared with the whole shop
  name text not null check (btrim(name) <> '' and length(name) <= 80),
  spreadsheet_id text not null,
  sheet_title text not null default '',                          -- the tab; blank = the first tab
  header_row int not null default 1 check (header_row >= 1),
  -- column letters/indexes per field, guessed from the header row and correctable
  mapping jsonb not null default '{}'::jsonb,
  -- where a new lead lands and whether the daily loop files rows by itself
  target_bucket_id uuid references buckets (id) on delete set null,
  auto_file boolean not null default false,
  -- which connected Google account reads it (the owner's, or a manager's for a shared sheet)
  reader_user_id uuid references app_users (id) on delete set null,
  active boolean not null default true,
  last_synced_at timestamptz,
  last_error text,
  row_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index sheet_sources_owner_idx on sheet_sources (owner_id, active);
create trigger sheet_sources_touch before update on sheet_sources for each row execute function app.touch_updated_at();

create table sheet_rows (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references sheet_sources (id) on delete cascade,
  row_no int not null,
  phone_key text,                       -- last 10 digits, null when the row has no usable phone
  business_name text not null default '',
  contact_name text not null default '',
  email text not null default '',
  phone text not null default '',
  phone2 text not null default '',
  email2 text not null default '',
  industry text not null default '',
  state text not null default '',
  monthly_revenue_cents bigint,
  time_in_business_months int,
  wanted text not null default '',
  notes text not null default '',
  raw jsonb not null default '{}'::jsonb,
  row_hash text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- once a row became a merchant in the CRM
  client_id uuid references clients (id) on delete set null,
  filed_at timestamptz,
  unique (source_id, row_no)
);
create index sheet_rows_phone_idx on sheet_rows (phone_key) where phone_key is not null;
create index sheet_rows_new_idx on sheet_rows (source_id, first_seen_at) where filed_at is null;

grant select, insert, update, delete on sheet_sources to isaac_app;
grant select, insert, update on sheet_rows to isaac_app;
alter table sheet_sources enable row level security;
alter table sheet_rows enable row level security;
create policy sheet_sources_read on sheet_sources for select to isaac_app
  using (owner_id is null or owner_id = app.current_user_id() or app.can_see_all());
create policy sheet_sources_write_own on sheet_sources for all to isaac_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());
create policy sheet_sources_write_manager on sheet_sources for all to isaac_app
  using (app.can_see_all()) with check (app.can_see_all());
create policy sheet_rows_read on sheet_rows for select to isaac_app
  using (exists (select 1 from sheet_sources s where s.id = source_id));
create policy sheet_rows_write on sheet_rows for all to isaac_app
  using (exists (select 1 from sheet_sources s where s.id = source_id and (s.owner_id = app.current_user_id() or app.can_see_all())))
  with check (exists (select 1 from sheet_sources s where s.id = source_id and (s.owner_id = app.current_user_id() or app.can_see_all())));

-- The Google connection may now also read sheets; which scopes were granted is kept so the UI can ask for more.
alter table gmail_connections add column can_read_sheets boolean not null default false;
alter table gmail_connections add column can_read_mail boolean not null default false;

-- Look a phone up across every sheet this user may read. Newest row wins.
create function public.sheet_lookup(p_phone text)
returns setof sheet_rows
language sql stable set search_path = public, pg_temp as $$
  select r.* from sheet_rows r
   where r.phone_key = right(regexp_replace(p_phone, '\D', '', 'g'), 10)
     and length(regexp_replace(p_phone, '\D', '', 'g')) >= 10
   order by r.last_seen_at desc
   limit 5
$$;
