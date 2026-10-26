-- Funders, submissions and offers-in.
--
-- The broker sends each merchant's application to several FUNDERS; each answers with an offer or a
-- decline. `competing_offers` (0001) is what OTHER funders offered the merchant; `offers` below is what
-- OUR funders offered after we submitted. Every table holds merchant data, so row-level security is on
-- from creation, and every cross-table reference is composite on (id, user_id) so a row can never
-- point at another user's client, funder or submission.

-- ---------------------------------------------------------------------------------------------
-- business days (mirrors addBusinessDays in src/lib/mca/dates.ts: Mon-Fri, holidays ignored)

create function app.add_business_days(p_from date, p_n int) returns date
language plpgsql immutable set search_path = public, pg_temp as $$
declare d date := p_from; remaining int := p_n;
begin
  while remaining > 0 loop
    d := d + 1;
    if extract(isodow from d) < 6 then
      remaining := remaining - 1;
    end if;
  end loop;
  return d;
end $$;

-- ---------------------------------------------------------------------------------------------
-- funders, with their appetite (what each one will and won't write)

create table funders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  name text not null check (btrim(name) <> '' and length(name) <= 200),
  submission_email text not null default '',
  contact_name text not null default '',
  phone text not null default '',
  notes text not null default '',
  active boolean not null default true,
  -- appetite. null = no limit / not known.
  min_monthly_revenue_cents bigint check (min_monthly_revenue_cents >= 0),
  min_time_in_business_months int check (min_time_in_business_months >= 0),
  max_position int check (max_position >= 1),
  min_amount_cents bigint check (min_amount_cents >= 0),
  max_amount_cents bigint check (max_amount_cents >= 0),
  excluded_states text[] not null default '{}',
  excluded_industries text[] not null default '{}',
  -- our commission, in points of the funded amount (10 = 10%)
  commission_points numeric(5,2) check (commission_points >= 0 and commission_points <= 100),
  -- how far paid down a merchant must be before this funder will renew them; null = use the shop default
  renewal_paydown_pct int check (renewal_paydown_pct between 1 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (min_amount_cents is null or max_amount_cents is null or min_amount_cents <= max_amount_cents),
  unique (id, user_id)
);
create unique index funders_user_name_key on funders (user_id, lower(btrim(name)));
create trigger funders_touch before update on funders for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- submissions: one application sent to one funder

create table submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  client_id uuid not null,
  funder_id uuid not null,
  sent_on date not null default current_date,
  status text not null default 'sent'
    check (status in ('sent','stips_requested','approved','declined','no_response','withdrawn')),
  decline_reason text
    check (decline_reason in ('revenue','time_in_business','nsfs','position','industry','state',
                              'credit','stips','over_leveraged','other')),
  decline_note text not null default '',
  note text not null default '',
  status_changed_at timestamptz not null default now(),
  -- when the funder FIRST answered (approved / declined / asked for stips); drives "days to respond"
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  check (decline_reason is null or status = 'declined'),
  unique (id, user_id),
  -- a merchant can be re-submitted on another day; the same funder twice on one day is a slip
  unique (client_id, funder_id, sent_on),
  foreign key (client_id, user_id) references clients (id, user_id) on delete cascade,
  -- Deferred to commit on purpose. Deleting a whole user cascades to funders AND clients (and so to
  -- submissions); Postgres fires those cascades in no promised order, and an immediate check on the
  -- funder side can run before the client side has removed its submissions. At commit, everything the
  -- cascade removes is gone, while deleting one funder that still has submissions is still refused.
  foreign key (funder_id, user_id) references funders (id, user_id) deferrable initially deferred
);
create index submissions_client_idx on submissions (client_id, sent_on desc);
create index submissions_funder_idx on submissions (funder_id);

-- ---------------------------------------------------------------------------------------------
-- offers: what our funders came back with

create table offers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  client_id uuid not null,
  submission_id uuid not null,
  amount_cents bigint not null check (amount_cents > 0),
  factor_rate numeric(5,3) not null check (factor_rate >= 1 and factor_rate <= 3),
  payment_cents bigint check (payment_cents > 0),
  frequency text check (frequency in ('daily','weekly','biweekly','monthly')),
  term_days int check (term_days > 0),
  position_no int check (position_no >= 1),
  fees_cents bigint check (fees_cents >= 0),
  note text not null default '',
  received_on date not null default current_date,
  status text not null default 'open' check (status in ('open','presented','accepted','declined','expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  foreign key (client_id, user_id) references clients (id, user_id) on delete cascade,
  foreign key (submission_id, user_id) references submissions (id, user_id) on delete cascade
);
create index offers_client_idx on offers (client_id, received_on desc);
create index offers_submission_idx on offers (submission_id);
create trigger offers_touch before update on offers for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- timers: a "chase" timer belongs to ONE submission. A call, text or email to the merchant does not
-- close it (log_touch closes follow_up / due check_in / due renewal / the booked call only); only that
-- submission getting a response does. Allowed-kinds check is extended in place, so a kind another
-- migration added earlier is kept.

do $$
declare c record; changed int := 0;
begin
  for c in
    select conname, pg_get_constraintdef(oid) as def from pg_constraint
     where conrelid = 'public.timers'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%scheduled_call%'
       and pg_get_constraintdef(oid) not like '%chase%'
  loop
    execute format('alter table timers drop constraint %I', c.conname);
    execute format('alter table timers add constraint %I %s', c.conname,
                   regexp_replace(c.def, '(ARRAY\[[^]]*)\]', '\1, ''chase''::text]'));
    changed := changed + 1;
  end loop;
  if changed <> 1 then
    raise exception 'expected to extend exactly one timers.kind check, changed %', changed;
  end if;
end $$;

alter table timers add column submission_id uuid;
alter table timers add constraint timers_submission_fk
  foreign key (submission_id, user_id) references submissions (id, user_id) on delete cascade;
alter table timers add constraint timers_chase_has_submission check ((kind = 'chase') = (submission_id is not null));
create unique index timers_one_open_chase_idx on timers (submission_id) where kind = 'chase' and done_at is null;

-- ---------------------------------------------------------------------------------------------
-- row-level security + grants (functions below are SECURITY INVOKER, so the role needs the DML itself)

alter table funders enable row level security;
alter table submissions enable row level security;
alter table offers enable row level security;
create policy funders_owner on funders for all to isaac_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy submissions_owner on submissions for all to isaac_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy offers_owner on offers for all to isaac_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

grant select, insert, update, delete on funders, submissions, offers to isaac_app;

-- ---------------------------------------------------------------------------------------------
-- helpers

create function app.fmt_money(p_cents bigint) returns text
language sql immutable set search_path = public, pg_temp as $$
  select '$' || case when p_cents % 100 = 0 then to_char(p_cents / 100, 'FM999,999,999,999')
                     else to_char(p_cents / 100.0, 'FM999,999,999,990.00') end
$$;

-- 1.34, 1.4 -> 1.40, 1.345 stays 1.345
create function app.fmt_factor(p_factor numeric) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when p_factor * 100 = round(p_factor * 100) then to_char(p_factor, 'FM0.00') else to_char(p_factor, 'FM0.000') end
$$;

create function app.decline_reason_label(p_reason text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case p_reason
    when 'revenue' then 'revenue too low'
    when 'time_in_business' then 'not enough time in business'
    when 'nsfs' then 'too many NSFs'
    when 'position' then 'position'
    when 'industry' then 'industry'
    when 'state' then 'state'
    when 'credit' then 'credit'
    when 'stips' then 'stips'
    when 'over_leveraged' then 'over-leveraged'
    else 'other' end
$$;

-- move_client closes EVERY open timer (replace_timers), which would silently drop the chase timers of
-- funders that have not answered yet. Move, then put those chase timers back exactly as they were.
create function app.move_keeping_chase(p_client uuid, p_stage text, p_timers jsonb, p_reason text)
returns void
language plpgsql set search_path = public, pg_temp as $$
declare saved jsonb; c clients; r jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('submission_id', submission_id, 'due_on', due_on, 'note', note)
                            order by created_at), '[]'::jsonb)
    into saved from timers where client_id = p_client and kind = 'chase' and done_at is null;
  select * into c from move_client(p_client, p_stage, p_timers, p_reason);
  for r in select * from jsonb_array_elements(saved) loop
    insert into timers (user_id, client_id, kind, due_on, note, submission_id)
    values (c.user_id, p_client, 'chase', (r->>'due_on')::date, r->>'note', (r->>'submission_id')::uuid);
  end loop;
end $$;

-- A funder said yes: the deal is "Offers in" if it was earlier in the pipeline (or had been marked
-- Declined). Returns whether it moved.
create function app.promote_to_offers_in(p_client uuid, p_reason text) returns boolean
language plpgsql set search_path = public, pg_temp as $$
declare st text; behind boolean;
begin
  select stage into st from clients where id = p_client;
  select coalesce((select sort from stages where key = st) < (select sort from stages where key = 'offers_in')
                  or st = 'declined', false) into behind;
  if not behind then
    return false;
  end if;
  perform app.move_keeping_chase(p_client, 'offers_in',
    jsonb_build_array(jsonb_build_object('kind', 'follow_up', 'due_on', app.add_business_days(current_date, 1), 'note', '')),
    p_reason);
  return true;
end $$;

-- Every client keeps a next date (docs/DECISIONS.md). Closing a chase timer must not be the thing that breaks it.
create function app.ensure_open_timer(p_client uuid, p_note text) returns void
language plpgsql set search_path = public, pg_temp as $$
declare uid uuid;
begin
  if not exists (select 1 from timers where client_id = p_client and done_at is null) then
    select user_id into uid from clients where id = p_client;
    insert into timers (user_id, client_id, kind, due_on, note)
    values (uid, p_client, 'follow_up', app.add_business_days(current_date, 1), coalesce(p_note, ''));
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- send a merchant to several funders at once

create function public.create_submissions(p_client uuid, p_funder_ids uuid[], p_sent_on date default null, p_note text default '')
returns setof submissions
language plpgsql set search_path = public, pg_temp as $$
declare
  c clients;
  sent date := coalesce(p_sent_on, current_date);
  ids uuid[];
  new_ids uuid[];
  names text;
  v_note text := btrim(coalesce(p_note, ''));
begin
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  select coalesce(array_agg(distinct x), '{}') into ids from unnest(p_funder_ids) x where x is not null;
  if cardinality(ids) = 0 then
    raise exception 'pick at least one funder' using errcode = '22023';
  end if;
  if cardinality(ids) > 50 then
    raise exception 'send to 50 funders or fewer at a time' using errcode = '22023';
  end if;
  -- ±1 day of slack: the database clock is UTC, Isaac's calendar is not.
  if sent > current_date + 1 then
    raise exception 'the sent date % is in the future', sent using errcode = '22023';
  end if;
  if sent < current_date - 365 then
    raise exception 'the sent date % is more than a year ago', sent using errcode = '22023';
  end if;
  -- RLS hides other users' funders, so a foreign id is simply "not found".
  if (select count(*) from funders where id = any(ids)) <> cardinality(ids) then
    raise exception 'funder not found' using errcode = 'P0002';
  end if;
  select string_agg(name, ', ' order by lower(name)) into names from funders where id = any(ids) and not active;
  if names is not null then
    raise exception '% is archived — restore it on the Funders page first', names using errcode = '22023';
  end if;
  select string_agg(f.name, ', ' order by lower(f.name)) into names
    from submissions s join funders f on f.id = s.funder_id
   where s.client_id = p_client and s.funder_id = any(ids) and s.sent_on = sent;
  if names is not null then
    raise exception 'Already sent to % on %', names, to_char(sent, 'FMMon FMDD') using errcode = '22023';
  end if;

  with ins as (
    insert into submissions (user_id, client_id, funder_id, sent_on, note)
    select c.user_id, p_client, f.id, sent, v_note from funders f where f.id = any(ids)
    returning id
  )
  select array_agg(id) into new_ids from ins;

  select string_agg(f.name, ', ' order by lower(f.name)) into names from funders f where f.id = any(ids);
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Submitted to ' || names || case when v_note <> '' then ' — ' || v_note else '' end);

  -- Application in / Collecting stips -> Submitted to funders. This closes every open timer, so the
  -- chase timers are created AFTER it.
  if c.stage in ('application_in', 'stips') then
    perform app.move_keeping_chase(p_client, 'submitted',
      jsonb_build_array(jsonb_build_object('kind', 'follow_up', 'due_on', app.add_business_days(current_date, 1), 'note', '')),
      '');
  end if;

  insert into timers (user_id, client_id, kind, due_on, note, submission_id)
  select c.user_id, p_client, 'chase', app.add_business_days(sent, 1), 'Ask ' || f.name || ' for a decision', s.id
    from submissions s join funders f on f.id = s.funder_id
   where s.id = any(new_ids)
   order by lower(f.name);

  return query
    select s.* from submissions s join funders f on f.id = s.funder_id
     where s.id = any(new_ids) order by lower(f.name);
end $$;

-- ---------------------------------------------------------------------------------------------
-- a funder answered (or we stopped waiting)

create function public.set_submission_status(p_submission uuid, p_status text,
                                             p_decline_reason text default null, p_note text default '')
returns submissions
language plpgsql set search_path = public, pg_temp as $$
declare
  s submissions; c clients; fname text; old_status text;
  v_note text := btrim(coalesce(p_note, ''));
  body text; due date;
begin
  if p_status is null or p_status not in ('sent','stips_requested','approved','declined','no_response','withdrawn') then
    raise exception 'unknown submission status: %', p_status using errcode = '22023';
  end if;
  if p_decline_reason is not null and p_status <> 'declined' then
    raise exception 'a decline reason only goes with a decline' using errcode = '22023';
  end if;
  if p_decline_reason is not null and p_decline_reason not in
     ('revenue','time_in_business','nsfs','position','industry','state','credit','stips','over_leveraged','other') then
    raise exception 'unknown decline reason: %', p_decline_reason using errcode = '22023';
  end if;
  select * into s from submissions where id = p_submission for update;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  select * into c from clients where id = s.client_id for update;
  select name into fname from funders where id = s.funder_id;
  old_status := s.status;

  -- The chase is over the moment the funder answers or we stop waiting. Closed BEFORE any stage move
  -- so the move does not carry it over.
  update timers set done_at = now(), done_reason = 'completed'
   where submission_id = s.id and kind = 'chase' and done_at is null;

  update submissions set
      status = p_status,
      decline_reason = case when p_status = 'declined' then p_decline_reason else null end,
      decline_note = case when p_status = 'declined' then v_note else '' end,
      note = case when p_status <> 'declined' and v_note <> '' then v_note else submissions.note end,
      status_changed_at = now(),
      responded_at = case
        when p_status in ('approved', 'declined', 'stips_requested') then coalesce(responded_at, now())
        when p_status = 'sent' and old_status in ('approved', 'declined') then null
        else responded_at end
   where id = s.id returning * into s;

  -- A funder that withdraws its yes (declined / pulled) takes its open offers with it.
  if p_status in ('declined', 'withdrawn') then
    update offers set status = 'expired' where submission_id = s.id and status in ('open', 'presented');
  end if;

  body := fname || case p_status
    when 'sent' then ': waiting for a decision again'
    when 'stips_requested' then ' asked for stips'
    when 'approved' then ' approved'
    when 'declined' then ' declined'
    when 'no_response' then ': no response'
    else ': withdrawn' end;
  if p_status = 'declined' and p_decline_reason is not null then
    body := body || ' — ' || app.decline_reason_label(p_decline_reason);
  end if;
  if v_note <> '' then
    body := body || ' — ' || v_note;
  end if;
  insert into activities (user_id, client_id, kind, body) values (c.user_id, c.id, 'system', body);

  if p_status = 'approved' then
    perform app.promote_to_offers_in(c.id, 'Offer from ' || fname);
  elsif p_status = 'stips_requested' then
    -- the ball is with the merchant now: make sure there is a near follow-up to go get the stips
    due := app.add_business_days(current_date, 1);
    if not exists (select 1 from timers where client_id = c.id and done_at is null and kind = 'follow_up' and due_on <= due) then
      insert into timers (user_id, client_id, kind, due_on, note)
      values (c.user_id, c.id, 'follow_up', due, left('Get stips for ' || fname || case when v_note <> '' then ': ' || v_note else '' end, 300));
    end if;
  elsif p_status = 'sent' then
    -- waiting on the funder again (stips went in, or an answer was entered by mistake)
    insert into timers (user_id, client_id, kind, due_on, note, submission_id)
    select c.user_id, c.id, 'chase', app.add_business_days(current_date, 1), 'Ask ' || fname || ' for a decision', s.id
     where not exists (select 1 from timers t where t.submission_id = s.id and t.kind = 'chase' and t.done_at is null);
  end if;

  perform app.ensure_open_timer(c.id, 'Funder answered — next step');
  return s;
end $$;

-- ---------------------------------------------------------------------------------------------
-- an offer comes in: store it, mark the submission approved, bring the deal to "Offers in"

create function public.record_offer(p_submission uuid, p_offer jsonb)
returns offers
language plpgsql set search_path = public, pg_temp as $$
declare
  s submissions; c clients; o offers; fname text; got date; body text;
begin
  select * into s from submissions where id = p_submission for update;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  select * into c from clients where id = s.client_id for update;
  select name into fname from funders where id = s.funder_id;
  got := coalesce(nullif(p_offer->>'received_on', '')::date, current_date);
  if got > current_date + 1 then
    raise exception 'the offer date % is in the future', got using errcode = '22023';
  end if;

  insert into offers (user_id, client_id, submission_id, amount_cents, factor_rate, payment_cents, frequency,
                      term_days, position_no, fees_cents, note, received_on)
  values (c.user_id, c.id, s.id, (p_offer->>'amount_cents')::bigint, (p_offer->>'factor_rate')::numeric,
          nullif(p_offer->>'payment_cents', '')::bigint, nullif(p_offer->>'frequency', ''),
          nullif(p_offer->>'term_days', '')::int, nullif(p_offer->>'position_no', '')::int,
          nullif(p_offer->>'fees_cents', '')::bigint, coalesce(p_offer->>'note', ''), got)
  returning * into o;

  update timers set done_at = now(), done_reason = 'completed'
   where submission_id = s.id and kind = 'chase' and done_at is null;
  update submissions set status = 'approved', decline_reason = null, decline_note = '',
         status_changed_at = now(), responded_at = coalesce(responded_at, now())
   where id = s.id;

  body := fname || ' approved: ' || app.fmt_money(o.amount_cents) || ' at ' || app.fmt_factor(o.factor_rate) || ' factor';
  if o.payment_cents is not null then
    body := body || ', ' || app.fmt_money(o.payment_cents) || coalesce(' ' || o.frequency, '');
  end if;
  insert into activities (user_id, client_id, kind, body) values (c.user_id, c.id, 'system', body);

  perform app.promote_to_offers_in(c.id, 'Offer from ' || fname);
  perform app.ensure_open_timer(c.id, 'Offer in — next step');
  return o;
end $$;

-- ---------------------------------------------------------------------------------------------
-- the merchant takes an offer. This does NOT fund: funding goes through the Funded dialog / record_funding.

create function public.accept_offer(p_offer uuid)
returns offers
language plpgsql set search_path = public, pg_temp as $$
declare o offers; c clients; fname text;
begin
  select * into o from offers where id = p_offer for update;
  if not found then
    raise exception 'offer not found' using errcode = 'P0002';
  end if;
  select * into c from clients where id = o.client_id for update;
  if o.status = 'accepted' then
    return o;
  end if;
  -- the merchant can only take one: every other live offer on this deal is turned down
  update offers set status = 'declined'
   where client_id = o.client_id and id <> o.id and status in ('open', 'presented', 'accepted');
  update offers set status = 'accepted' where id = o.id returning * into o;
  select f.name into fname from submissions s join funders f on f.id = s.funder_id where s.id = o.submission_id;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, c.id, 'system',
          'Accepted ' || fname || '''s offer: ' || app.fmt_money(o.amount_cents) || ' at ' || app.fmt_factor(o.factor_rate) || ' factor');
  return o;
end $$;

-- present / reopen / turn down / let lapse. Acceptance has its own function.
create function public.set_offer_status(p_offer uuid, p_status text)
returns offers
language plpgsql set search_path = public, pg_temp as $$
declare o offers; c clients; fname text;
begin
  if p_status is null or p_status not in ('open', 'presented', 'declined', 'expired') then
    raise exception 'unknown offer status: %', p_status using errcode = '22023';
  end if;
  select * into o from offers where id = p_offer for update;
  if not found then
    raise exception 'offer not found' using errcode = 'P0002';
  end if;
  select * into c from clients where id = o.client_id for update;
  update offers set status = p_status where id = o.id returning * into o;
  select f.name into fname from submissions s join funders f on f.id = s.funder_id where s.id = o.submission_id;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, c.id, 'system',
          fname || '''s offer ' || case p_status
            when 'open' then 'reopened'
            when 'presented' then 'presented to the merchant'
            when 'declined' then 'turned down'
            else 'expired' end);
  return o;
end $$;

-- a submission entered by mistake
create function public.remove_submission(p_submission uuid)
returns void
language plpgsql set search_path = public, pg_temp as $$
declare s submissions; c clients; fname text;
begin
  select * into s from submissions where id = p_submission for update;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  select * into c from clients where id = s.client_id for update;
  select name into fname from funders where id = s.funder_id;
  delete from submissions where id = s.id;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, c.id, 'system', 'Removed the submission to ' || fname);
  perform app.ensure_open_timer(c.id, 'Submission removed — next step');
end $$;
