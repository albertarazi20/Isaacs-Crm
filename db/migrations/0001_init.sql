-- Isaac MCA CRM — initial schema. Plain Postgres 15+ (security_invoker views).
-- Money: bigint cents. Dates: date. Every table with merchant/owner data has row-level security.

create schema if not exists app;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'isaac_app') then
    create role isaac_app nologin;
  end if;
end $$;

-- A non-superuser owner needs explicit membership to SET ROLE; for a superuser this is a no-op.
do $$
begin
  execute format('grant isaac_app to %I', current_user);
exception when others then
  null;
end $$;

create function app.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

create function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- users

create table app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null default '',
  timezone text not null default 'America/New_York',
  digest_enabled boolean not null default true,
  digest_hour int not null default 8 check (digest_hour between 0 and 23),
  notify_email text,
  created_at timestamptz not null default now(),
  constraint app_users_email_lower check (email = lower(email))
);

-- ---------------------------------------------------------------------------------------------
-- stages (reference data; timer defaults live in src/lib/mca/stages.ts, a test checks drift)

create table stages (
  key text primary key,
  label text not null,
  stage_group text not null check (stage_group in ('prospecting','underwriting','funded','trouble','exit')),
  sort int not null unique
);

insert into stages (key, label, stage_group, sort) values
  ('name_in',           'Name in',              'prospecting',  1),
  ('spoke_with_owner',  'Spoke with owner',     'prospecting',  2),
  ('interested',        'Interested',           'prospecting',  3),
  ('call_scheduled',    'Phone call scheduled', 'prospecting',  4),
  ('application_sent',  'Application sent',     'prospecting',  5),
  ('application_in',    'Application in',       'underwriting', 6),
  ('stips',             'Collecting stips',     'underwriting', 7),
  ('submitted',         'Submitted to funders', 'underwriting', 8),
  ('offers_in',         'Offers in',            'underwriting', 9),
  ('offer_presented',   'Offer presented',      'underwriting', 10),
  ('contract_out',      'Contract out',         'underwriting', 11),
  ('funded',            'Funded',               'funded',       12),
  ('paying_off_soon',   'Pays off soon',        'funded',       13),
  ('paid_in_full',      'Paid in full',         'funded',       14),
  ('default_workable',  'Workable default',     'trouble',      15),
  ('default_bad',       'Bad default',          'trouble',      16),
  ('legal_collections', 'Legal / collections',  'trouble',      17),
  ('written_off',       'Written off',          'trouble',      18),
  ('declined',          'Declined',             'exit',         19),
  ('lost',              'Lost deal',            'exit',         20),
  ('killed',            'Killed deal',          'exit',         21),
  ('dead',              'Dead deal',            'exit',         22),
  ('not_interested',    'Not interested',       'exit',         23);

-- ---------------------------------------------------------------------------------------------
-- clients (the card). No EIN / SSN / DOB / card / bank credentials — see docs/DECISIONS.md.

create table clients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  business_name text not null check (btrim(business_name) <> ''),
  dba text not null default '',
  contact_name text not null default '',
  phone text not null default '',
  email text not null default '',
  industry text not null default '',
  state text not null default '',
  source text not null default '',
  monthly_revenue_cents bigint check (monthly_revenue_cents >= 0),
  time_in_business_months int check (time_in_business_months >= 0),
  stage text not null default 'name_in' references stages(key),
  stage_changed_at timestamptz not null default now(),
  application_received_on date,
  scheduled_call_at timestamptz,
  last_contact_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create index clients_user_stage_idx on clients (user_id, stage);
create index clients_user_phone_idx on clients (user_id, phone) where phone <> '';
create trigger clients_touch before update on clients for each row execute function app.touch_updated_at();

-- What the merchant wants and what Isaac thinks lenders will approve. Append-only snapshots:
-- the newest row is "current", the rest are "how much he wanted in the past".
create table client_asks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  client_id uuid not null,
  wanted_amount_cents bigint check (wanted_amount_cents > 0),
  wanted_terms text not null default '',
  est_approval_cents bigint check (est_approval_cents >= 0),
  est_approval_note text not null default '',
  created_at timestamptz not null default now(),
  foreign key (client_id, user_id) references clients (id, user_id) on delete cascade
);
create index client_asks_client_idx on client_asks (client_id, created_at desc);

-- Other advances the merchant already carries (the position stack).
create table positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  client_id uuid not null,
  position_no int not null check (position_no >= 1),
  funder_name text not null default '',
  funded_amount_cents bigint not null default 0 check (funded_amount_cents >= 0),
  payback_cents bigint check (payback_cents >= 0),
  balance_cents bigint not null default 0 check (balance_cents >= 0),
  payment_cents bigint check (payment_cents >= 0),
  frequency text check (frequency in ('daily','weekly','biweekly','monthly')),
  funded_on date,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id, user_id) references clients (id, user_id) on delete cascade
);
create index positions_client_idx on positions (client_id, position_no);
create trigger positions_touch before update on positions for each row execute function app.touch_updated_at();

-- What competitors offered the same merchant. Log it on every lost deal and it becomes a price book.
create table competing_offers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  client_id uuid not null,
  funder_name text not null check (btrim(funder_name) <> ''),
  amount_cents bigint check (amount_cents > 0),
  factor_rate numeric(5,3) check (factor_rate >= 1 and factor_rate <= 3),
  payment_cents bigint check (payment_cents > 0),
  frequency text check (frequency in ('daily','weekly','biweekly','monthly')),
  position_no int check (position_no >= 1),
  term_days int check (term_days > 0),
  offered_on date not null default current_date,
  won boolean not null default false,
  note text not null default '',
  created_at timestamptz not null default now(),
  foreign key (client_id, user_id) references clients (id, user_id) on delete cascade
);
create index competing_offers_client_idx on competing_offers (client_id, offered_on desc);

-- A funded advance. payback = amount × factor. Default tracking lives here, on the advance that defaulted.
create table fundings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  client_id uuid not null,
  funded_on date not null,
  funder_name text not null default '',
  amount_cents bigint not null check (amount_cents > 0),
  factor_rate numeric(5,3) not null check (factor_rate >= 1 and factor_rate <= 3),
  payback_cents bigint generated always as (round(amount_cents * factor_rate)::bigint) stored,
  payment_cents bigint not null check (payment_cents > 0),
  frequency text not null check (frequency in ('daily','weekly','biweekly','monthly')),
  position_no int not null default 1 check (position_no >= 1),
  term_days int check (term_days > 0),
  commission_cents bigint check (commission_cents >= 0),
  paid_back_override_cents bigint check (paid_back_override_cents >= 0),
  status text not null default 'active' check (status in ('active','paid_off','defaulted','renewed')),
  defaulted_on date,
  last_payment_on date,
  promise_to_pay_at timestamptz,
  promise_amount_cents bigint check (promise_amount_cents > 0),
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (client_id, user_id) references clients (id, user_id) on delete cascade
);
create index fundings_client_idx on fundings (client_id, funded_on desc);
create trigger fundings_touch before update on fundings for each row execute function app.touch_updated_at();

-- Stipulations. One row per box Isaac ticks. doc_key is an object-storage key, never file bytes.
create table stips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  client_id uuid not null,
  kind text not null check (kind in (
    'signed_application','bank_statement','drivers_license','voided_check',
    'proof_of_ownership','tax_return','lease_letter','processing_statement','other')),
  period date,
  required boolean not null default true,
  received_at timestamptz,
  doc_key text,
  created_at timestamptz not null default now(),
  foreign key (client_id, user_id) references clients (id, user_id) on delete cascade
);
create unique index stips_unique_idx on stips (client_id, kind, coalesce(period, date '0001-01-01'));

-- Timers: a client can hold several open ones. "Next follow-up" = the earliest open timer.
create table timers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  client_id uuid not null,
  kind text not null check (kind in ('follow_up','check_in','renewal','scheduled_call')),
  due_on date not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  done_at timestamptz,
  done_reason text check (done_reason in ('completed','replaced','stage_moved','cancelled')),
  check ((done_at is null) = (done_reason is null)),
  foreign key (client_id, user_id) references clients (id, user_id) on delete cascade
);
create index timers_open_due_idx on timers (user_id, due_on) where done_at is null;
create index timers_client_idx on timers (client_id) where done_at is null;

-- Append-only timeline. The notes ARE the product.
create table activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  client_id uuid not null,
  kind text not null check (kind in ('note','call','text','email','stage_change','timer','funding','system')),
  outcome text check (outcome in ('reached','no_answer','left_message','bad_number')),
  body text not null default '',
  from_stage text references stages(key),
  to_stage text references stages(key),
  -- clock_timestamp(), not now(): several rows written in one transaction must keep their order.
  occurred_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (client_id, user_id) references clients (id, user_id) on delete cascade
);
create index activities_client_idx on activities (client_id, occurred_at desc);

-- System-only tables: the browser-facing role has no grants on these at all.
create table reminders_sent (
  user_id uuid not null references app_users(id) on delete cascade,
  kind text not null check (kind in ('digest','call')),
  for_date date not null,
  ref text not null default '',
  provider_id text,
  sent_at timestamptz not null default now(),
  primary key (user_id, kind, for_date, ref)
);

create table gmail_connections (
  user_id uuid primary key references app_users(id) on delete cascade,
  google_email text not null,
  refresh_token_enc text not null,
  scope text not null default '',
  status text not null default 'ok' check (status in ('ok','needs_reconnect')),
  last_error text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger gmail_connections_touch before update on gmail_connections for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- row-level security: every row belongs to exactly one user

do $$
declare t text;
begin
  foreach t in array array['client_asks','positions','competing_offers','fundings','stips','timers']
  loop
    execute format('alter table %I enable row level security', t);
    execute format(
      'create policy %I on %I for all to isaac_app using (user_id = app.current_user_id()) with check (user_id = app.current_user_id())',
      t || '_owner', t);
  end loop;
end $$;

alter table clients enable row level security;
create policy clients_owner on clients for all to isaac_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

alter table activities enable row level security;
create policy activities_select on activities for select to isaac_app using (user_id = app.current_user_id());
create policy activities_insert on activities for insert to isaac_app with check (user_id = app.current_user_id());

alter table app_users enable row level security;
create policy app_users_self_select on app_users for select to isaac_app using (id = app.current_user_id());
create policy app_users_self_update on app_users for update to isaac_app
  using (id = app.current_user_id()) with check (id = app.current_user_id());

alter table reminders_sent enable row level security;
alter table gmail_connections enable row level security;

-- ---------------------------------------------------------------------------------------------
-- grants

grant usage on schema public, app to isaac_app;
grant select on stages to isaac_app;
grant select on app_users to isaac_app;
grant update (name, timezone, digest_enabled, digest_hour, notify_email) on app_users to isaac_app;
grant select, insert, update, delete on clients, client_asks, positions, competing_offers, fundings, stips, timers to isaac_app;
grant select, insert on activities to isaac_app;

-- ---------------------------------------------------------------------------------------------
-- the card: one row per client with everything the board and the call list need

create view client_cards with (security_invoker = true) as
select
  c.*,
  nt.due_on  as next_due_on,
  nt.kind    as next_due_kind,
  (select max(a.occurred_at) from activities a where a.client_id = c.id and a.kind = 'call')  as last_call_at,
  (select max(a.occurred_at) from activities a where a.client_id = c.id and a.kind in ('call','text','email')) as last_touch_at,
  (select a.body from activities a where a.client_id = c.id and a.kind = 'call' and a.body <> '' order by a.occurred_at desc limit 1) as last_call_note,
  ask.wanted_amount_cents, ask.wanted_terms, ask.est_approval_cents, ask.est_approval_note,
  (select count(*) from positions p where p.client_id = c.id)::int as position_count,
  (select coalesce(sum(p.balance_cents), 0) from positions p where p.client_id = c.id)::bigint as position_balance_cents,
  (select count(*) from stips s where s.client_id = c.id and s.required)::int as stips_required,
  (select count(*) from stips s where s.client_id = c.id and s.required and s.received_at is not null)::int as stips_received,
  f.id as funding_id, f.funded_on, f.amount_cents as funding_amount_cents, f.factor_rate,
  f.payback_cents as funding_payback_cents, f.payment_cents as funding_payment_cents,
  f.frequency as funding_frequency, f.paid_back_override_cents, f.status as funding_status,
  f.defaulted_on, f.last_payment_on, f.promise_to_pay_at, f.promise_amount_cents
from clients c
left join lateral (
  select t.due_on, t.kind from timers t
  where t.client_id = c.id and t.done_at is null
  order by t.due_on, t.created_at limit 1
) nt on true
left join lateral (
  select * from client_asks k where k.client_id = c.id order by k.created_at desc limit 1
) ask on true
left join lateral (
  select * from fundings x where x.client_id = c.id order by x.funded_on desc, x.created_at desc limit 1
) f on true;

grant select on client_cards to isaac_app;

-- ---------------------------------------------------------------------------------------------
-- functions. SECURITY INVOKER on purpose: they run as isaac_app, so RLS applies to every statement.

create function app.assert_due_on(p_due date) returns void
language plpgsql stable as $$
begin
  if p_due is null then
    raise exception 'due date is required' using errcode = '22023';
  end if;
  -- ±1 day of slack: the database clock is UTC, Isaac's calendar is not.
  if p_due < current_date - 1 then
    raise exception 'follow-up date % is in the past', p_due using errcode = '22023';
  end if;
  if p_due > (current_date + interval '36 months')::date + 1 then
    raise exception 'follow-up date % is more than 36 months out', p_due using errcode = '22023';
  end if;
end $$;

-- Replace every open timer (except a booked call) with the given ones. Rejects an empty list:
-- no client may ever be left without a next date.
create function app.replace_timers(p_client uuid, p_user uuid, p_timers jsonb, p_reason text)
returns void
language plpgsql as $$
declare t jsonb;
begin
  if p_timers is null or jsonb_typeof(p_timers) <> 'array' or jsonb_array_length(p_timers) = 0 then
    raise exception 'at least one timer is required' using errcode = '22023';
  end if;
  for t in select * from jsonb_array_elements(p_timers) loop
    perform app.assert_due_on((t->>'due_on')::date);
  end loop;
  update timers set done_at = now(), done_reason = p_reason
   where client_id = p_client and done_at is null and kind <> 'scheduled_call';
  for t in select * from jsonb_array_elements(p_timers) loop
    insert into timers (user_id, client_id, kind, due_on, note)
    values (p_user, p_client, t->>'kind', (t->>'due_on')::date, coalesce(t->>'note', ''));
  end loop;
end $$;

-- New client + first timer in one transaction. The only way the app creates a client, so a card
-- can never exist without a next date.
create function public.create_client(p_fields jsonb, p_timers jsonb)
returns clients
language plpgsql set search_path = public as $$
declare c clients;
begin
  insert into clients (user_id, business_name, dba, contact_name, phone, email, industry, state, source,
                       monthly_revenue_cents, time_in_business_months, stage)
  values (app.current_user_id(), p_fields->>'business_name', coalesce(p_fields->>'dba', ''),
          coalesce(p_fields->>'contact_name', ''), coalesce(p_fields->>'phone', ''),
          coalesce(p_fields->>'email', ''), coalesce(p_fields->>'industry', ''),
          coalesce(p_fields->>'state', ''), coalesce(p_fields->>'source', ''),
          (p_fields->>'monthly_revenue_cents')::bigint, (p_fields->>'time_in_business_months')::int,
          coalesce(p_fields->>'stage', 'name_in'))
  returning * into c;
  perform app.replace_timers(c.id, c.user_id, p_timers, 'replaced');
  insert into activities (user_id, client_id, kind, body, to_stage)
  values (c.user_id, c.id, 'system', 'Added', c.stage);
  return c;
end $$;

create function public.move_client(p_client uuid, p_stage text, p_timers jsonb, p_reason text default '')
returns clients
language plpgsql set search_path = public as $$
declare c clients; old_stage text;
begin
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  old_stage := c.stage;
  perform app.replace_timers(p_client, c.user_id, p_timers, case when old_stage = p_stage then 'replaced' else 'stage_moved' end);
  if old_stage <> p_stage then
    update clients set stage = p_stage, stage_changed_at = now() where id = p_client returning * into c;
    insert into activities (user_id, client_id, kind, body, from_stage, to_stage)
    values (c.user_id, p_client, 'stage_change', coalesce(p_reason, ''), old_stage, p_stage);
  end if;
  return c;
end $$;

create function public.set_follow_up(p_client uuid, p_due_on date, p_note text default '')
returns timers
language plpgsql set search_path = public as $$
declare c clients; t timers;
begin
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  perform app.replace_timers(
    p_client, c.user_id,
    jsonb_build_array(jsonb_build_object('kind', 'follow_up', 'due_on', p_due_on, 'note', coalesce(p_note, ''))),
    'replaced');
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'timer', 'Follow up set for ' || p_due_on || case when coalesce(p_note, '') <> '' then ' — ' || p_note else '' end);
  select * into t from timers where client_id = p_client and done_at is null and kind = 'follow_up' order by created_at desc limit 1;
  return t;
end $$;

-- One tap after a call / text / email: log what happened and set the next date in the same breath.
create function public.log_touch(p_client uuid, p_kind text, p_outcome text, p_body text, p_next_due_on date)
returns activities
language plpgsql set search_path = public as $$
declare c clients; a activities;
begin
  if p_kind not in ('call','text','email') then
    raise exception 'touch kind must be call, text or email' using errcode = '22023';
  end if;
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  perform app.replace_timers(
    p_client, c.user_id,
    jsonb_build_array(jsonb_build_object('kind', 'follow_up', 'due_on', p_next_due_on, 'note', '')),
    'completed');
  insert into activities (user_id, client_id, kind, outcome, body)
  values (c.user_id, p_client, p_kind, p_outcome, coalesce(p_body, '')) returning * into a;
  update clients set last_contact_at = now() where id = p_client;
  return a;
end $$;

-- Book a call. The reminder fires on the day (and the digest lists it); stage moves to
-- "Phone call scheduled" only while the client is still early in prospecting.
create function public.schedule_call(p_client uuid, p_at timestamptz, p_note text default '')
returns clients
language plpgsql set search_path = public as $$
declare c clients; tz text; call_day date;
begin
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  select timezone into tz from app_users where id = c.user_id;
  call_day := (p_at at time zone coalesce(tz, 'UTC'))::date;
  perform app.assert_due_on(call_day);
  update timers set done_at = now(), done_reason = 'replaced'
   where client_id = p_client and done_at is null and kind = 'scheduled_call';
  insert into timers (user_id, client_id, kind, due_on, note)
  values (c.user_id, p_client, 'scheduled_call', call_day, coalesce(p_note, ''));
  update clients set scheduled_call_at = p_at,
         stage = case when stage in ('name_in','spoke_with_owner','interested') then 'call_scheduled' else stage end,
         stage_changed_at = case when stage in ('name_in','spoke_with_owner','interested') then now() else stage_changed_at end
   where id = p_client returning * into c;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'timer', 'Call booked for ' || to_char(p_at at time zone coalesce(tz, 'UTC'), 'Mon DD HH12:MI AM') || case when coalesce(p_note, '') <> '' then ' — ' || p_note else '' end);
  return c;
end $$;

-- Seed the stip checklist (the defaults are computed in TypeScript and passed in).
create function public.add_stips(p_client uuid, p_stips jsonb)
returns int
language plpgsql set search_path = public as $$
declare c clients; s jsonb; n int := 0;
begin
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  for s in select * from jsonb_array_elements(p_stips) loop
    insert into stips (user_id, client_id, kind, period, required)
    values (c.user_id, p_client, s->>'kind', nullif(s->>'period', '')::date, coalesce((s->>'required')::boolean, true))
    on conflict (client_id, kind, coalesce(period, date '0001-01-01')) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

create function public.set_stip_received(p_stip uuid, p_received boolean)
returns stips
language plpgsql set search_path = public as $$
declare s stips;
begin
  update stips set received_at = case when p_received then coalesce(received_at, now()) else null end
   where id = p_stip returning * into s;
  if not found then
    raise exception 'stip not found' using errcode = 'P0002';
  end if;
  insert into activities (user_id, client_id, kind, body)
  values (s.user_id, s.client_id, 'system',
          (case when p_received then 'Received: ' else 'Marked missing: ' end) || s.kind ||
          coalesce(' ' || to_char(s.period, 'Mon YYYY'), ''));
  return s;
end $$;

-- A deal funds: store the advance, move the card to Funded, and start both timers (30-day
-- check-in + renewal) in one transaction. Any earlier active advance is marked renewed.
create function public.record_funding(p_client uuid, p_funding jsonb, p_timers jsonb)
returns fundings
language plpgsql set search_path = public as $$
declare c clients; f fundings;
begin
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  update fundings set status = 'renewed' where client_id = p_client and status = 'active';
  insert into fundings (user_id, client_id, funded_on, funder_name, amount_cents, factor_rate, payment_cents,
                        frequency, position_no, term_days, commission_cents, note)
  values (c.user_id, p_client, (p_funding->>'funded_on')::date, coalesce(p_funding->>'funder_name', ''),
          (p_funding->>'amount_cents')::bigint, (p_funding->>'factor_rate')::numeric,
          (p_funding->>'payment_cents')::bigint, p_funding->>'frequency',
          coalesce((p_funding->>'position_no')::int, 1), (p_funding->>'term_days')::int,
          (p_funding->>'commission_cents')::bigint, coalesce(p_funding->>'note', ''))
  returning * into f;
  perform move_client(p_client, 'funded', p_timers, 'Funded');
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'funding', 'Funded $' || (f.amount_cents / 100) || ' at ' || f.factor_rate);
  return f;
end $$;

-- Merchant defaulted (or made a promise): stamp the advance and move the card in one step.
create function public.record_default(p_client uuid, p_stage text, p_defaulted_on date,
                                      p_promise_at timestamptz, p_promise_amount_cents bigint,
                                      p_timers jsonb, p_note text default '')
returns clients
language plpgsql set search_path = public as $$
declare c clients; fid uuid;
begin
  if p_stage not in ('default_workable','default_bad','legal_collections','written_off') then
    raise exception 'not a default stage: %', p_stage using errcode = '22023';
  end if;
  select id into fid from fundings where client_id = p_client order by funded_on desc, created_at desc limit 1;
  if fid is null then
    raise exception 'client has no funding to default' using errcode = 'P0002';
  end if;
  update fundings
     set status = 'defaulted', defaulted_on = coalesce(defaulted_on, p_defaulted_on),
         promise_to_pay_at = p_promise_at, promise_amount_cents = p_promise_amount_cents
   where id = fid;
  select * into c from move_client(p_client, p_stage, p_timers, p_note);
  return c;
end $$;
