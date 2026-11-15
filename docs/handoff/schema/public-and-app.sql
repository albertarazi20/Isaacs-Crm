--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: app; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA app;


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: add_business_days(date, integer); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.add_business_days(p_from date, p_n integer) RETURNS date
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: assert_due_on(date); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.assert_due_on(p_due date) RETURNS void
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: current_user_id(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.current_user_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;


--
-- Name: date_at_paydown(date, bigint, numeric, bigint, text, integer); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.date_at_paydown(p_funded_on date, p_amount_cents bigint, p_factor numeric, p_payment_cents bigint, p_frequency text, p_pct integer) RETURNS date
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare payback bigint; num bigint; den bigint; n bigint;
begin
  if p_payment_cents is null or p_payment_cents <= 0 or p_funded_on is null then
    return null;
  end if;
  payback := round(p_amount_cents * p_factor)::bigint;
  num := payback * p_pct;
  den := 100 * p_payment_cents;
  n := (num + den - 1) / den;
  if n > 20000 then
    return null;
  end if;
  return case p_frequency
    when 'daily' then app.earnings_add_business_days(p_funded_on, n::int)
    when 'weekly' then p_funded_on + (7 * n)::int
    when 'biweekly' then p_funded_on + (14 * n)::int
    when 'monthly' then (p_funded_on + make_interval(months => n::int))::date
    else null
  end;
end $$;


--
-- Name: decline_reason_label(text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.decline_reason_label(p_reason text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: earnings_add_business_days(date, integer); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.earnings_add_business_days(p_from date, p_n integer) RETURNS date
    LANGUAGE plpgsql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare d date := p_from; n int := p_n; dow int;
begin
  if n <= 0 then
    return p_from;
  end if;
  dow := extract(isodow from d);
  if dow >= 6 then
    -- the first business day after a weekend is the coming Monday
    d := d + (8 - dow);
    n := n - 1;
  end if;
  d := d + 7 * (n / 5);
  n := n % 5;
  while n > 0 loop
    d := d + 1;
    if extract(isodow from d) < 6 then
      n := n - 1;
    end if;
  end loop;
  return d;
end $$;


--
-- Name: earnings_fmt_date(date); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.earnings_fmt_date(p_date date) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select case when p_date is null then 'none' else to_char(p_date, 'FMMon FMDD, YYYY') end
$$;


--
-- Name: earnings_fmt_factor(numeric); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.earnings_fmt_factor(p_factor numeric) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select case when p_factor * 100 = round(p_factor * 100) then to_char(p_factor, 'FM0.00') else to_char(p_factor, 'FM0.000') end
$$;


--
-- Name: earnings_fmt_money(bigint); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.earnings_fmt_money(p_cents bigint) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $_$
  select case when p_cents is null then 'none'
              when p_cents % 100 = 0 then '$' || to_char(p_cents / 100, 'FM999,999,999,999,999')
              else '$' || to_char(p_cents / 100.0, 'FM999,999,999,999,990.00') end
$_$;


--
-- Name: earnings_fmt_remittance(bigint, text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.earnings_fmt_remittance(p_cents bigint, p_frequency text) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select app.earnings_fmt_money(p_cents) || case p_frequency
    when 'daily' then '/day'
    when 'weekly' then '/week'
    when 'biweekly' then ' every 2 weeks'
    else '/month' end
$$;


--
-- Name: earnings_ordinal(integer); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.earnings_ordinal(p_n integer) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select p_n::text || case
    when p_n % 100 between 11 and 13 then 'th'
    when p_n % 10 = 1 then 'st'
    when p_n % 10 = 2 then 'nd'
    when p_n % 10 = 3 then 'rd'
    else 'th' end
$$;


--
-- Name: ensure_open_timer(uuid, text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.ensure_open_timer(p_client uuid, p_note text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare uid uuid;
begin
  if not exists (select 1 from timers where client_id = p_client and done_at is null) then
    select user_id into uid from clients where id = p_client;
    insert into timers (user_id, client_id, kind, due_on, note)
    values (uid, p_client, 'follow_up', app.add_business_days(app.local_today(), 1), coalesce(p_note, ''));
  end if;
end $$;


--
-- Name: fmt_factor(numeric); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.fmt_factor(p_factor numeric) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select case when p_factor * 100 = round(p_factor * 100) then to_char(p_factor, 'FM0.00') else to_char(p_factor, 'FM0.000') end
$$;


--
-- Name: fmt_money(bigint); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.fmt_money(p_cents bigint) RETURNS text
    LANGUAGE sql IMMUTABLE
    SET search_path TO 'public', 'pg_temp'
    AS $_$
  select '$' || case when p_cents % 100 = 0 then to_char(p_cents / 100, 'FM999,999,999,999')
                     else to_char(p_cents / 100.0, 'FM999,999,999,990.00') end
$_$;


--
-- Name: local_today(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.local_today() RETURNS date
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select (now() at time zone coalesce((select timezone from app_users where id = app.current_user_id()), 'UTC'))::date
$$;


--
-- Name: move_keeping_chase(uuid, text, jsonb, text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.move_keeping_chase(p_client uuid, p_stage text, p_timers jsonb, p_reason text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  perform move_client(p_client, p_stage, p_timers, p_reason);
end $$;


--
-- Name: promote_to_offers_in(uuid, text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.promote_to_offers_in(p_client uuid, p_reason text) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare st text; behind boolean;
begin
  select stage into st from clients where id = p_client;
  select coalesce((select sort from stages where key = st) < (select sort from stages where key = 'offers_in')
                  or st = 'declined', false) into behind;
  if not behind then
    return false;
  end if;
  perform app.move_keeping_chase(p_client, 'offers_in',
    jsonb_build_array(jsonb_build_object('kind', 'follow_up', 'due_on', app.add_business_days(app.local_today(), 1), 'note', '')),
    p_reason);
  return true;
end $$;


--
-- Name: refuse_delete_when_trashed(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.refuse_delete_when_trashed() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if pg_trigger_depth() = 1 and exists (select 1 from trashed_clients t where t.client_id = old.client_id) then
    raise exception 'That merchant is in the trash — restore it first' using errcode = '22023';
  end if;
  return old;
end $$;


--
-- Name: refuse_when_trashed(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.refuse_when_trashed() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if exists (select 1 from trashed_clients t where t.client_id = new.client_id) then
    raise exception 'That merchant is in the trash — restore it first' using errcode = '22023';
  end if;
  return new;
end $$;


--
-- Name: reopen_siblings(uuid); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.reopen_siblings(p_offer uuid) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare brought_back int;
begin
  with back as (
    update offers x set status = case x.declined_from when 'presented' then 'presented' else 'open' end,
                        declined_by = null, declined_from = null
      from submissions s
     where x.declined_by = p_offer and x.status = 'declined'
       and s.id = x.submission_id and s.status not in ('declined', 'withdrawn')
    returning x.id)
  select count(*) into brought_back from back;
  update offers set declined_by = null, declined_from = null where declined_by = p_offer;
  return brought_back;
end $$;


--
-- Name: replace_timers(uuid, uuid, jsonb, text); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.replace_timers(p_client uuid, p_user uuid, p_timers jsonb, p_reason text) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare t jsonb;
begin
  if p_timers is null or jsonb_typeof(p_timers) <> 'array' or jsonb_array_length(p_timers) = 0 then
    raise exception 'at least one timer is required' using errcode = '22023';
  end if;
  for t in select * from jsonb_array_elements(p_timers) loop
    perform app.assert_due_on((t->>'due_on')::date);
  end loop;
  -- A booked call is an appointment: it survives a stage move until its day has passed.
  -- A chase timer belongs to a funder's pending answer: move_client decides whether it survives.
  update timers set done_at = now(), done_reason = p_reason
   where client_id = p_client and done_at is null and kind <> 'chase'
     and (kind <> 'scheduled_call' or due_on < app.local_today());
  for t in select * from jsonb_array_elements(p_timers) loop
    insert into timers (user_id, client_id, kind, due_on, note)
    values (p_user, p_client, t->>'kind', (t->>'due_on')::date, coalesce(t->>'note', ''));
  end loop;
end $$;


--
-- Name: restore_rows(text, jsonb); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.restore_rows(p_table text, p_rows jsonb) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare cols text; n int;
begin
  if p_table not in ('clients', 'trashed_clients', 'client_asks', 'positions', 'competing_offers', 'fundings',
                     'stips', 'funders', 'submissions', 'offers', 'timers', 'activities', 'snippets') then
    raise exception 'not a table a backup can restore into: %', p_table using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be a list' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;
  -- only the columns the file actually has: a column added since the backup keeps its default instead of getting NULL
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = p_table and is_generated = 'NEVER'
     and (p_rows->0) ? column_name;
  execute format('insert into %I (%s) select %s from jsonb_populate_recordset(null::%I, $1)',
                 p_table, cols, cols, p_table) using p_rows;
  get diagnostics n = row_count;
  return n;
end $_$;


--
-- Name: timers_live_only(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.timers_live_only() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  if exists (select 1 from trashed_clients t where t.client_id = new.client_id) then
    raise exception 'That merchant is in the trash — restore it first' using errcode = '22023';
  end if;
  return new;
end $$;


--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: app; Owner: -
--

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: offers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.offers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    submission_id uuid NOT NULL,
    amount_cents bigint NOT NULL,
    factor_rate numeric(5,3) NOT NULL,
    payment_cents bigint,
    frequency text,
    term_days integer,
    position_no integer,
    fees_cents bigint,
    note text DEFAULT ''::text NOT NULL,
    received_on date DEFAULT app.local_today() NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    declined_by uuid,
    declined_from text,
    CONSTRAINT offers_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT offers_declined_from_check CHECK ((declined_from = ANY (ARRAY['open'::text, 'presented'::text, 'accepted'::text]))),
    CONSTRAINT offers_declined_pair CHECK (((declined_by IS NULL) OR (declined_from IS NOT NULL))),
    CONSTRAINT offers_factor_rate_check CHECK (((factor_rate >= (1)::numeric) AND (factor_rate <= (3)::numeric))),
    CONSTRAINT offers_fees_cents_check CHECK ((fees_cents >= 0)),
    CONSTRAINT offers_frequency_check CHECK ((frequency = ANY (ARRAY['daily'::text, 'weekly'::text, 'biweekly'::text, 'monthly'::text]))),
    CONSTRAINT offers_payment_cents_check CHECK ((payment_cents > 0)),
    CONSTRAINT offers_position_no_check CHECK ((position_no >= 1)),
    CONSTRAINT offers_status_check CHECK ((status = ANY (ARRAY['open'::text, 'presented'::text, 'accepted'::text, 'declined'::text, 'expired'::text]))),
    CONSTRAINT offers_term_days_check CHECK ((term_days > 0))
);


--
-- Name: accept_offer(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accept_offer(p_offer uuid) RETURNS public.offers
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare o offers; c clients; cid uuid; fname text; sub_status text;
begin
  select client_id into cid from offers where id = p_offer;
  if not found then
    raise exception 'offer not found' using errcode = 'P0002';
  end if;
  select * into c from clients where id = cid for update;
  select * into o from offers where id = p_offer for update;
  if not found then
    raise exception 'offer not found' using errcode = 'P0002';
  end if;
  if o.status = 'accepted' then
    return o;
  end if;
  select f.name, s.status into fname, sub_status
    from submissions s join funders f on f.id = s.funder_id where s.id = o.submission_id;
  -- an offer turned down by ACCEPTING another one (declined_by is set) can be taken instead: that is changing his mind.
  -- One he turned down himself, or that lapsed, has to be reopened first.
  if o.status = 'expired' or (o.status = 'declined' and o.declined_by is null) then
    raise exception 'That offer is % — reopen it first if it is back on the table',
      case o.status when 'expired' then 'expired' else 'turned down' end using errcode = '22023';
  end if;
  if sub_status in ('declined', 'withdrawn') then
    raise exception '% has % this deal, so its offer can''t be accepted', fname,
      case sub_status when 'declined' then 'declined' else 'withdrawn' end using errcode = '22023';
  end if;
  -- the merchant can only take one: every other live offer on this deal is turned down, and remembered
  update offers set declined_from = status, declined_by = o.id, status = 'declined'
   where client_id = o.client_id and id <> o.id and status in ('open', 'presented', 'accepted');
  -- ones an earlier acceptance turned down now hang on this one (switching: undo brings back all of them)
  update offers set declined_by = o.id
   where client_id = o.client_id and id <> o.id and status = 'declined' and declined_by is not null;
  update offers set status = 'accepted', declined_by = null, declined_from = null
   where id = o.id returning * into o;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, c.id, 'system',
          'Accepted ' || fname || '''s offer: ' || app.fmt_money(o.amount_cents) || ' at ' || app.fmt_factor(o.factor_rate) || ' factor');
  return o;
end $$;


--
-- Name: add_stips(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_stips(p_client uuid, p_stips jsonb) RETURNS integer
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    business_name text NOT NULL,
    dba text DEFAULT ''::text NOT NULL,
    contact_name text DEFAULT ''::text NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    industry text DEFAULT ''::text NOT NULL,
    state text DEFAULT ''::text NOT NULL,
    source text DEFAULT ''::text NOT NULL,
    monthly_revenue_cents bigint,
    time_in_business_months integer,
    stage text DEFAULT 'name_in'::text NOT NULL,
    stage_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    application_received_on date,
    scheduled_call_at timestamp with time zone,
    last_contact_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    contact_status text DEFAULT 'ok'::text NOT NULL,
    contact_status_note text DEFAULT ''::text NOT NULL,
    contact_status_at timestamp with time zone,
    hot boolean DEFAULT false NOT NULL,
    CONSTRAINT clients_business_name_check CHECK ((btrim(business_name) <> ''::text)),
    CONSTRAINT clients_contact_status_check CHECK ((contact_status = ANY (ARRAY['ok'::text, 'no_text'::text, 'no_call'::text, 'no_email'::text, 'dnc'::text]))),
    CONSTRAINT clients_monthly_revenue_cents_check CHECK ((monthly_revenue_cents >= 0)),
    CONSTRAINT clients_time_in_business_months_check CHECK ((time_in_business_months >= 0))
);


--
-- Name: cancel_call(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cancel_call(p_client uuid) RETURNS public.clients
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare c clients; n int; prev text; target text;
begin
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  update timers set done_at = now(), done_reason = 'cancelled'
   where client_id = p_client and done_at is null and kind = 'scheduled_call';
  get diagnostics n = row_count;
  if n > 0 or c.scheduled_call_at is not null then
    update clients set scheduled_call_at = null where id = p_client returning * into c;
    insert into activities (user_id, client_id, kind, body) values (c.user_id, p_client, 'timer', 'Call cancelled');
  end if;
  -- "Phone call scheduled" means a time is booked. With none, he goes back to the stage he was in before it was booked
  -- (or, with no record of that, to "Spoke with owner").
  if c.stage = 'call_scheduled' then
    select from_stage into prev from activities
     where client_id = p_client and kind = 'stage_change' and to_stage = 'call_scheduled'
     order by created_at desc, id desc limit 1;
    target := coalesce(prev, 'spoke_with_owner');
    if target = 'call_scheduled' then
      target := 'spoke_with_owner';
    end if;
    update clients set stage = target, stage_changed_at = now() where id = p_client returning * into c;
    insert into activities (user_id, client_id, kind, body, from_stage, to_stage)
    values (c.user_id, p_client, 'stage_change', 'Call cancelled', 'call_scheduled', target);
  end if;
  if not exists (select 1 from timers where client_id = p_client and done_at is null) then
    insert into timers (user_id, client_id, kind, due_on, note)
    values (c.user_id, p_client, 'follow_up', app.local_today() + 1, 'Call cancelled — follow up');
  end if;
  return c;
end $$;


--
-- Name: create_client(jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_client(p_fields jsonb, p_timers jsonb) RETURNS public.clients
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
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
  values (c.user_id, c.id, 'system', 'Client added', c.stage);
  return c;
end $$;


--
-- Name: submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.submissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    funder_id uuid NOT NULL,
    sent_on date DEFAULT app.local_today() NOT NULL,
    status text DEFAULT 'sent'::text NOT NULL,
    decline_reason text,
    decline_note text DEFAULT ''::text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    status_changed_at timestamp with time zone DEFAULT now() NOT NULL,
    responded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT submissions_check CHECK (((decline_reason IS NULL) OR (status = 'declined'::text))),
    CONSTRAINT submissions_decline_reason_check CHECK ((decline_reason = ANY (ARRAY['revenue'::text, 'time_in_business'::text, 'nsfs'::text, 'position'::text, 'industry'::text, 'state'::text, 'credit'::text, 'stips'::text, 'over_leveraged'::text, 'other'::text]))),
    CONSTRAINT submissions_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'stips_requested'::text, 'approved'::text, 'declined'::text, 'no_response'::text, 'withdrawn'::text])))
);


--
-- Name: create_submissions(uuid, uuid[], date, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_submissions(p_client uuid, p_funder_ids uuid[], p_sent_on date DEFAULT NULL::date, p_note text DEFAULT ''::text) RETURNS SETOF public.submissions
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  c clients;
  sent date := coalesce(p_sent_on, app.local_today());
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
  if sent > app.local_today() + 1 then
    raise exception 'the sent date % is in the future', sent using errcode = '22023';
  end if;
  if sent < app.local_today() - 365 then
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
      jsonb_build_array(jsonb_build_object('kind', 'follow_up', 'due_on', app.add_business_days(app.local_today(), 1), 'note', '')),
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


--
-- Name: lead_token_take_slot(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.lead_token_take_slot(p_token uuid, p_cap integer) RETURNS boolean
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare took int;
begin
  update lead_tokens set
      created_today = case when created_day = current_date then created_today + 1 else 1 end,
      created_day = current_date
   where id = p_token and revoked_at is null
     and (created_day is distinct from current_date or created_today < p_cap);
  get diagnostics took = row_count;
  return took = 1;
end $$;


--
-- Name: activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    kind text NOT NULL,
    outcome text,
    body text DEFAULT ''::text NOT NULL,
    from_stage text,
    to_stage text,
    occurred_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT activities_kind_check CHECK ((kind = ANY (ARRAY['note'::text, 'call'::text, 'text'::text, 'email'::text, 'stage_change'::text, 'timer'::text, 'funding'::text, 'system'::text]))),
    CONSTRAINT activities_outcome_check CHECK ((outcome = ANY (ARRAY['reached'::text, 'no_answer'::text, 'left_message'::text, 'bad_number'::text])))
);


--
-- Name: log_touch(uuid, text, text, text, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_touch(p_client uuid, p_kind text, p_outcome text, p_body text, p_next_due_on date) RETURNS public.activities
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare c clients; a activities; call_is_now boolean;
begin
  if p_kind not in ('call','text','email') then
    raise exception 'touch kind must be call, text or email' using errcode = '22023';
  end if;
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  perform app.assert_due_on(p_next_due_on);
  -- Only a touch of the reminder's own kind (call, text or email), within a few hours of (or after) the booked time,
  -- counts as THE reminder being done. A reminder with no recorded channel is a call.
  call_is_now := c.scheduled_call_at is not null and c.scheduled_call_at <= now() + interval '3 hours'
    and p_kind = coalesce((select t.channel from timers t
                            where t.client_id = p_client and t.kind = 'scheduled_call' and t.done_at is null
                            order by t.created_at desc limit 1), 'call');
  -- What this touch resolves: the follow-up he was chasing, a funded check-in or renewal call that
  -- is due, and the booked call if this is it. A renewal call due in 80 days is NOT resolved by it.
  update timers set done_at = now(), done_reason = 'completed'
   where client_id = p_client and done_at is null and (
         kind = 'follow_up'
      or (kind in ('check_in', 'renewal') and due_on <= app.local_today())
      or (kind = 'scheduled_call' and call_is_now));
  if call_is_now then
    update clients set scheduled_call_at = null where id = p_client;
  end if;
  insert into timers (user_id, client_id, kind, due_on, note)
  values (c.user_id, p_client, 'follow_up', p_next_due_on, '');
  insert into activities (user_id, client_id, kind, outcome, body)
  values (c.user_id, p_client, p_kind, p_outcome, coalesce(p_body, '')) returning * into a;
  update clients set last_contact_at = now() where id = p_client;
  return a;
end $$;


--
-- Name: merge_clients(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.merge_clients(p_keep uuid, p_drop uuid) RETURNS public.clients
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  k clients; d clients;
  n_notes int; n_adv int; n_subs int; n_stips int;
  keep_next date; drop_next date; new_status text; summary text;
begin
  if p_keep is null or p_drop is null or p_keep = p_drop then
    raise exception 'Pick two different merchants to merge' using errcode = '22023';
  end if;
  -- lock both cards, always in id order, so two merges (or a merge and an edit) can't deadlock
  perform 1 from clients where id = least(p_keep, p_drop) for update;
  perform 1 from clients where id = greatest(p_keep, p_drop) for update;
  select * into k from clients where id = p_keep;
  select * into d from clients where id = p_drop;
  if k.id is null or d.id is null then
    raise exception 'merchant not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from trashed_clients where client_id in (p_keep, p_drop)) then
    raise exception 'That merchant is in the trash — restore it first' using errcode = '22023';
  end if;

  -- the kept card fills its blanks from the other, and keeps the earlier application date
  update clients set
      hot = k.hot or d.hot,
      dba = case when btrim(k.dba) = '' then d.dba else k.dba end,
      contact_name = case when btrim(k.contact_name) = '' then d.contact_name else k.contact_name end,
      phone = case when btrim(k.phone) = '' then d.phone else k.phone end,
      email = case when btrim(k.email) = '' then d.email else k.email end,
      industry = case when btrim(k.industry) = '' then d.industry else k.industry end,
      state = case when btrim(k.state) = '' then d.state else k.state end,
      source = case when btrim(k.source) = '' then d.source else k.source end,
      monthly_revenue_cents = coalesce(k.monthly_revenue_cents, d.monthly_revenue_cents),
      time_in_business_months = coalesce(k.time_in_business_months, d.time_in_business_months),
      application_received_on = case
        when k.application_received_on is null then d.application_received_on
        when d.application_received_on is null then k.application_received_on
        else least(k.application_received_on, d.application_received_on) end
   where id = p_keep;

  -- plain moves
  update client_asks set client_id = p_keep where client_id = p_drop;
  update positions set client_id = p_keep where client_id = p_drop;
  update competing_offers set client_id = p_keep where client_id = p_drop;
  update fundings set client_id = p_keep where client_id = p_drop;
  get diagnostics n_adv = row_count;

  -- stips: a received one beats a missing one; otherwise move, unless the kept card already has that stip
  update stips ks set received_at = ds.received_at, doc_key = ds.doc_key
    from stips ds
   where ks.client_id = p_keep and ds.client_id = p_drop and ks.kind = ds.kind
     and coalesce(ks.period, date '0001-01-01') = coalesce(ds.period, date '0001-01-01')
     and ks.received_at is null and ds.received_at is not null;
  update stips ds set client_id = p_keep
   where ds.client_id = p_drop
     and not exists (select 1 from stips ks where ks.client_id = p_keep and ks.kind = ds.kind
                       and coalesce(ks.period, date '0001-01-01') = coalesce(ds.period, date '0001-01-01'));
  get diagnostics n_stips = row_count;

  -- submissions to the same funder on the same day are the same fact: the kept card's copy stays, the other goes
  with moved as (
    update submissions s set client_id = p_keep
     where s.client_id = p_drop
       and not exists (select 1 from submissions x where x.client_id = p_keep and x.funder_id = s.funder_id
                         and x.sent_on = s.sent_on)
    returning s.id)
  select count(*) into n_subs from moved;
  update offers set client_id = p_keep
   where client_id = p_drop and submission_id in (select id from submissions where client_id = p_keep);
  update timers set client_id = p_keep
   where client_id = p_drop and done_at is null and kind = 'chase'
     and submission_id in (select id from submissions where client_id = p_keep);

  -- a booked call survives if the kept card has none
  if d.scheduled_call_at is not null and k.scheduled_call_at is null then
    update clients set scheduled_call_at = d.scheduled_call_at where id = p_keep;
    update timers set client_id = p_keep
     where client_id = p_drop and done_at is null and kind = 'scheduled_call';
  end if;

  -- the history comes with it (stage moves and timer lines belong to the other card's story, so they stay behind)
  insert into activities (user_id, client_id, kind, body, occurred_at, created_at)
  select a.user_id, p_keep, a.kind, a.body, a.occurred_at, a.created_at
    from activities a
   where a.client_id = p_drop and a.kind not in ('stage_change', 'timer');
  get diagnostics n_notes = row_count;

  -- never lose a date: if the other card had something due earlier, the kept card gets a follow-up that day
  select min(due_on) into drop_next from timers where client_id = p_drop and done_at is null;
  select min(due_on) into keep_next from timers where client_id = p_keep and done_at is null;
  if drop_next is not null and (keep_next is null or drop_next < keep_next) then
    if exists (select 1 from timers where client_id = p_keep and done_at is null and kind = 'follow_up') then
      update timers set due_on = drop_next
       where client_id = p_keep and done_at is null and kind = 'follow_up';
    else
      insert into timers (user_id, client_id, kind, due_on, note)
      values (k.user_id, p_keep, 'follow_up', drop_next, 'From the merged card');
    end if;
  end if;

  -- a stop wins
  if d.contact_status <> 'ok' and k.contact_status = 'ok' then
    new_status := d.contact_status;
  elsif d.contact_status <> 'ok' and k.contact_status <> d.contact_status then
    new_status := 'dnc';
  end if;

  summary := 'Merged with ' || d.business_name
    || case when btrim(d.phone) <> '' then ' (' || d.phone || ')' else '' end
    || ': ' || n_notes || ' notes, ' || n_adv || ' advances, ' || n_subs || ' submissions, ' || n_stips
    || ' stips moved over';
  insert into activities (user_id, client_id, kind, body) values (k.user_id, p_keep, 'system', summary);

  -- offers that stay behind are deleted with the other card; anything declined only because of them comes back
  perform app.reopen_siblings(o.id) from offers o where o.client_id = p_drop;
  delete from clients where id = p_drop;

  if new_status is not null then
    perform set_contact_status(p_keep, new_status,
      'Carried over from the merged card (' || d.business_name || ')');
  end if;
  perform app.ensure_open_timer(p_keep, 'Merged — next step');

  select * into k from clients where id = p_keep;
  return k;
end $$;


--
-- Name: move_client(uuid, text, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.move_client(p_client uuid, p_stage text, p_timers jsonb, p_reason text DEFAULT ''::text) RETURNS public.clients
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare c clients; old_stage text;
begin
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  old_stage := c.stage;
  perform app.replace_timers(p_client, c.user_id, p_timers, case when old_stage = p_stage then 'replaced' else 'stage_moved' end);
  -- Still waiting on funders → keep chasing them. Out of the pipeline → nothing left to chase.
  if p_stage not in ('application_in', 'stips', 'submitted', 'offers_in', 'offer_presented', 'contract_out') then
    update timers set done_at = now(), done_reason = 'stage_moved'
     where client_id = p_client and kind = 'chase' and done_at is null;
  end if;
  if old_stage <> p_stage then
    update clients set stage = p_stage, stage_changed_at = now() where id = p_client returning * into c;
    insert into activities (user_id, client_id, kind, body, from_stage, to_stage)
    values (c.user_id, p_client, 'stage_change', coalesce(p_reason, ''), old_stage, p_stage);
  end if;
  return c;
end $$;


--
-- Name: purge_client(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_client(p_client uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare c clients;
begin
  select * into c from clients where id = p_client for update;
  if not found or not exists (select 1 from trashed_clients where client_id = p_client) then
    raise exception 'client not in the trash' using errcode = 'P0002';
  end if;
  if c.contact_status <> 'ok' then
    raise exception 'This merchant asked not to be contacted, so the record is kept to stop them being added again'
      using errcode = '22023';
  end if;
  delete from clients where id = p_client;
end $$;


--
-- Name: record_default(uuid, text, date, timestamp with time zone, bigint, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_default(p_client uuid, p_stage text, p_defaulted_on date, p_promise_at timestamp with time zone, p_promise_amount_cents bigint, p_timers jsonb, p_note text DEFAULT ''::text) RETURNS public.clients
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare c clients; fid uuid; tz text;
begin
  if p_stage not in ('default_workable','default_bad','legal_collections','written_off') then
    raise exception 'not a default stage: %', p_stage using errcode = '22023';
  end if;
  select * into c from clients where id = p_client for update;
  select id into fid from fundings where client_id = p_client order by funded_on desc, created_at desc limit 1;
  if fid is null then
    raise exception 'client has no funding to default' using errcode = 'P0002';
  end if;
  select timezone into tz from app_users where id = c.user_id;
  update fundings
     set status = 'defaulted',
         defaulted_on = coalesce(p_defaulted_on, defaulted_on, (now() at time zone coalesce(tz, 'UTC'))::date),
         promise_to_pay_at = p_promise_at, promise_amount_cents = p_promise_amount_cents
   where id = fid;
  select * into c from move_client(p_client, p_stage, p_timers, p_note);
  return c;
end $$;


--
-- Name: fundings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fundings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    funded_on date NOT NULL,
    funder_name text DEFAULT ''::text NOT NULL,
    amount_cents bigint NOT NULL,
    factor_rate numeric(5,3) NOT NULL,
    payback_cents bigint GENERATED ALWAYS AS ((round(((amount_cents)::numeric * factor_rate)))::bigint) STORED,
    payment_cents bigint NOT NULL,
    frequency text NOT NULL,
    position_no integer DEFAULT 1 NOT NULL,
    term_days integer,
    commission_cents bigint,
    paid_back_override_cents bigint,
    status text DEFAULT 'active'::text NOT NULL,
    defaulted_on date,
    last_payment_on date,
    promise_to_pay_at timestamp with time zone,
    promise_amount_cents bigint,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    commission_received_cents bigint,
    commission_received_on date,
    CONSTRAINT fundings_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT fundings_commission_cents_check CHECK ((commission_cents >= 0)),
    CONSTRAINT fundings_commission_not_above_amount CHECK (((commission_cents IS NULL) OR (commission_cents <= amount_cents))),
    CONSTRAINT fundings_commission_received_cents_check CHECK ((commission_received_cents >= 0)),
    CONSTRAINT fundings_commission_received_pair CHECK (((commission_received_cents IS NULL) = (commission_received_on IS NULL))),
    CONSTRAINT fundings_factor_rate_check CHECK (((factor_rate >= (1)::numeric) AND (factor_rate <= (3)::numeric))),
    CONSTRAINT fundings_frequency_check CHECK ((frequency = ANY (ARRAY['daily'::text, 'weekly'::text, 'biweekly'::text, 'monthly'::text]))),
    CONSTRAINT fundings_paid_back_override_cents_check CHECK ((paid_back_override_cents >= 0)),
    CONSTRAINT fundings_payment_cents_check CHECK ((payment_cents > 0)),
    CONSTRAINT fundings_position_no_check CHECK ((position_no >= 1)),
    CONSTRAINT fundings_position_range CHECK ((position_no <= 20)),
    CONSTRAINT fundings_promise_amount_cents_check CHECK ((promise_amount_cents > 0)),
    CONSTRAINT fundings_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paid_off'::text, 'defaulted'::text, 'renewed'::text]))),
    CONSTRAINT fundings_term_days_check CHECK ((term_days > 0))
);


--
-- Name: record_funding(uuid, jsonb, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_funding(p_client uuid, p_funding jsonb, p_timers jsonb) RETURNS public.fundings
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $_$
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
  values (c.user_id, p_client, 'funding', 'Funded $' || to_char(f.amount_cents / 100, 'FM999,999,999') || ' at ' || trim(trailing '.' from to_char(f.factor_rate, 'FM0.999')) || ' factor');
  return f;
end $_$;


--
-- Name: record_offer(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_offer(p_submission uuid, p_offer jsonb) RETURNS public.offers
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  s submissions; c clients; cid uuid; o offers; fname text; got date; body text;
begin
  select client_id into cid from submissions where id = p_submission;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  select * into c from clients where id = cid for update;
  select * into s from submissions where id = p_submission for update;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  select name into fname from funders where id = s.funder_id;
  got := coalesce(nullif(p_offer->>'received_on', '')::date, app.local_today());
  if got > app.local_today() + 1 then
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


--
-- Name: remove_offer(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_offer(p_offer uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare o offers; c clients; cid uuid; fname text;
begin
  select client_id into cid from offers where id = p_offer;
  if not found then
    raise exception 'That offer no longer exists' using errcode = 'P0002';
  end if;
  select * into c from clients where id = cid for update;
  select * into o from offers where id = p_offer for update;
  if not found then
    raise exception 'That offer no longer exists' using errcode = 'P0002';
  end if;
  select f.name into fname from submissions s join funders f on f.id = s.funder_id where s.id = o.submission_id;
  perform app.reopen_siblings(o.id);
  delete from offers where id = o.id;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, c.id, 'system',
          'Removed ' || coalesce(fname, 'a funder') || '''s offer: ' || app.fmt_money(o.amount_cents) || ' at '
          || app.fmt_factor(o.factor_rate) || ' factor');
end $$;


--
-- Name: remove_submission(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_submission(p_submission uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare s submissions; c clients; cid uuid; fname text;
begin
  select client_id into cid from submissions where id = p_submission;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  select * into c from clients where id = cid for update;
  select * into s from submissions where id = p_submission for update;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  select name into fname from funders where id = s.funder_id;
  perform app.reopen_siblings(o.id) from offers o where o.submission_id = s.id;
  delete from submissions where id = s.id;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, c.id, 'system', 'Removed the submission to ' || fname);
  perform app.ensure_open_timer(c.id, 'Submission removed — next step');
end $$;


--
-- Name: restore_client(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.restore_client(p_client uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare c clients; trashed timestamptz;
begin
  select * into c from clients where id = p_client for update;
  select trashed_at into trashed from trashed_clients where client_id = p_client;
  if not found or c.id is null then
    raise exception 'client not in the trash' using errcode = 'P0002';
  end if;
  delete from trashed_clients where client_id = p_client;
  update timers set done_at = null, done_reason = null
   where client_id = p_client and done_reason = 'cancelled' and done_at = trashed
     and kind <> 'scheduled_call'
     and (due_on >= app.local_today() or kind in ('renewal', 'check_in', 'chase'));
  update timers set due_on = app.local_today()
   where client_id = p_client and done_at is null and due_on < app.local_today()
     and kind in ('renewal', 'check_in', 'chase');
  if not exists (select 1 from timers where client_id = p_client and done_at is null) then
    insert into timers (user_id, client_id, kind, due_on, note)
    values (c.user_id, p_client, 'follow_up',
            case when c.contact_status = 'dnc'
                 then (app.local_today() + interval '36 months')::date
                 else app.local_today() + 7 end,
            case when c.contact_status = 'dnc'
                 then 'Do-not-contact — review this status'
                 else 'Restored from trash — pick the next step' end);
  end if;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Restored from trash');
end $$;


--
-- Name: schedule_call(uuid, timestamp with time zone, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.schedule_call(p_client uuid, p_at timestamp with time zone, p_note text DEFAULT ''::text) RETURNS public.clients
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
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
  update clients set scheduled_call_at = p_at where id = p_client returning * into c;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'timer', 'Reminder set for ' || to_char(p_at at time zone coalesce(tz, 'UTC'), 'FMMon FMDD, FMHH12:MI AM') || case when coalesce(p_note, '') <> '' then ' — ' || p_note else '' end);
  return c;
end $$;


--
-- Name: set_contact_status(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_contact_status(p_client uuid, p_status text, p_note text DEFAULT ''::text) RETURNS public.clients
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare c clients; label text; old_status text;
begin
  if p_status not in ('ok', 'no_text', 'no_call', 'no_email', 'dnc') then
    raise exception 'unknown contact status: %', p_status using errcode = '22023';
  end if;
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  old_status := c.contact_status;
  update clients
     set contact_status = p_status, contact_status_note = coalesce(p_note, ''), contact_status_at = now()
   where id = p_client returning * into c;
  if p_status = 'dnc' then
    update timers set done_at = now(), done_reason = 'cancelled' where client_id = p_client and done_at is null;
    update clients set scheduled_call_at = null where id = p_client returning * into c;
    insert into timers (user_id, client_id, kind, due_on, note)
    values (c.user_id, p_client, 'follow_up', (app.local_today() + interval '36 months')::date, 'Do-not-contact — review this status');
  elsif old_status = 'dnc' then
    update timers set done_at = now(), done_reason = 'replaced'
     where client_id = p_client and done_at is null and kind = 'follow_up'
       and note = 'Do-not-contact — review this status';
    insert into timers (user_id, client_id, kind, due_on, note)
    values (c.user_id, p_client, 'follow_up', app.local_today() + 7, 'Contact allowed again — pick the next step');
  end if;
  label := case p_status
    when 'ok' then 'OK to contact'
    when 'no_text' then 'Do not text'
    when 'no_call' then 'Do not call'
    when 'no_email' then 'Do not email'
    else 'Do not contact' end;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Contact status: ' || label || case when coalesce(p_note, '') <> '' then ' — ' || p_note else '' end);
  return c;
end $$;


--
-- Name: timers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.timers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    kind text NOT NULL,
    due_on date NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    done_at timestamp with time zone,
    done_reason text,
    submission_id uuid,
    channel text,
    CONSTRAINT timers_channel_check CHECK ((channel = ANY (ARRAY['call'::text, 'text'::text, 'email'::text]))),
    CONSTRAINT timers_chase_has_submission CHECK (((kind = 'chase'::text) = (submission_id IS NOT NULL))),
    CONSTRAINT timers_check CHECK (((done_at IS NULL) = (done_reason IS NULL))),
    CONSTRAINT timers_done_reason_check CHECK ((done_reason = ANY (ARRAY['completed'::text, 'replaced'::text, 'stage_moved'::text, 'cancelled'::text]))),
    CONSTRAINT timers_kind_check CHECK ((kind = ANY (ARRAY['follow_up'::text, 'check_in'::text, 'renewal'::text, 'scheduled_call'::text, 'chase'::text])))
);


--
-- Name: set_follow_up(uuid, date, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_follow_up(p_client uuid, p_due_on date, p_note text DEFAULT ''::text, p_keep_calls boolean DEFAULT false) RETURNS public.timers
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare c clients; t timers;
begin
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  perform app.assert_due_on(p_due_on);
  update timers set done_at = now(), done_reason = 'replaced'
   where client_id = p_client and done_at is null and kind = 'follow_up';
  if not coalesce(p_keep_calls, false) then
    update timers set due_on = p_due_on
     where client_id = p_client and done_at is null and kind in ('check_in', 'renewal') and due_on < p_due_on;
  end if;
  insert into timers (user_id, client_id, kind, due_on, note)
  values (c.user_id, p_client, 'follow_up', p_due_on, coalesce(p_note, '')) returning * into t;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'timer', 'Follow up set for ' || to_char(p_due_on, 'FMMon FMDD, YYYY') || case when coalesce(p_note, '') <> '' then ' — ' || p_note else '' end);
  return t;
end $$;


--
-- Name: set_offer_status(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_offer_status(p_offer uuid, p_status text) RETURNS public.offers
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare o offers; c clients; cid uuid; fname text; was text; brought_back int := 0; sub_status text;
begin
  if p_status is null or p_status not in ('open', 'presented', 'declined', 'expired') then
    raise exception 'unknown offer status: %', p_status using errcode = '22023';
  end if;
  select client_id into cid from offers where id = p_offer;
  if not found then
    raise exception 'offer not found' using errcode = 'P0002';
  end if;
  select * into c from clients where id = cid for update;
  select * into o from offers where id = p_offer for update;
  if not found then
    raise exception 'offer not found' using errcode = 'P0002';
  end if;
  was := o.status;
  select f.name, s.status into fname, sub_status
    from submissions s join funders f on f.id = s.funder_id where s.id = o.submission_id;
  if p_status in ('open', 'presented') and sub_status in ('declined', 'withdrawn') then
    raise exception '% has % this deal, so its offer can''t be reopened', fname,
      case sub_status when 'declined' then 'declined' else 'withdrawn' end using errcode = '22023';
  end if;

  update offers set status = p_status, declined_by = null, declined_from = null
   where id = o.id returning * into o;

  if was = 'accepted' then
    with back as (
      update offers x set status = case x.declined_from when 'presented' then 'presented' else 'open' end,
                          declined_by = null, declined_from = null
        from submissions s
       where x.declined_by = o.id and x.status = 'declined'
         and s.id = x.submission_id and s.status not in ('declined', 'withdrawn')
      returning x.id)
    select count(*) into brought_back from back;
    -- any the funder has since pulled stay turned down, but are no longer tied to this acceptance
    update offers set declined_by = null, declined_from = null where declined_by = o.id;
  end if;

  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, c.id, 'system',
          fname || '''s offer ' || case p_status
            when 'open' then 'reopened'
            when 'presented' then 'presented to the merchant'
            when 'declined' then 'turned down'
            else 'expired' end
          || case when brought_back > 0
                  then ' — ' || brought_back || case when brought_back = 1 then ' other offer is' else ' other offers are' end
                       || ' back on the table' else '' end);
  return o;
end $$;


--
-- Name: stips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stips (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    kind text NOT NULL,
    period date,
    required boolean DEFAULT true NOT NULL,
    received_at timestamp with time zone,
    doc_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT stips_kind_check CHECK ((kind = ANY (ARRAY['signed_application'::text, 'bank_statement'::text, 'drivers_license'::text, 'voided_check'::text, 'proof_of_ownership'::text, 'tax_return'::text, 'lease_letter'::text, 'processing_statement'::text, 'other'::text])))
);


--
-- Name: set_stip_received(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_stip_received(p_stip uuid, p_received boolean) RETURNS public.stips
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare s stips;
begin
  update stips set received_at = case when p_received then coalesce(received_at, now()) else null end
   where id = p_stip returning * into s;
  if not found then
    raise exception 'stip not found' using errcode = 'P0002';
  end if;
  insert into activities (user_id, client_id, kind, body)
  values (s.user_id, s.client_id, 'system',
          (case when p_received then 'Stip received: ' else 'Stip marked missing: ' end) ||
          case s.kind
            when 'signed_application' then 'Signed application'
            when 'bank_statement' then coalesce(to_char(s.period, 'FMMon YYYY') || ' ', '') || 'bank statement'
            when 'drivers_license' then 'Driver''s license / ID'
            when 'voided_check' then 'Voided check'
            when 'proof_of_ownership' then 'Proof of ownership'
            when 'tax_return' then 'Tax return'
            when 'lease_letter' then 'Landlord / lease letter'
            when 'processing_statement' then 'Processing statement'
            else 'Other document'
          end);
  return s;
end $$;


--
-- Name: set_submission_status(uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_submission_status(p_submission uuid, p_status text, p_decline_reason text DEFAULT NULL::text, p_note text DEFAULT ''::text) RETURNS public.submissions
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  s submissions; c clients; cid uuid; fname text; old_status text;
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
  select client_id into cid from submissions where id = p_submission;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  -- lock order: the client, then the submission, then its offers (the same as every other function)
  select * into c from clients where id = cid for update;
  select * into s from submissions where id = p_submission for update;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
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
    due := app.add_business_days(app.local_today(), 1);
    if not exists (select 1 from timers where client_id = c.id and done_at is null and kind = 'follow_up' and due_on <= due) then
      insert into timers (user_id, client_id, kind, due_on, note)
      values (c.user_id, c.id, 'follow_up', due, left('Get stips for ' || fname || case when v_note <> '' then ': ' || v_note else '' end, 300));
    end if;
  elsif p_status = 'sent' then
    -- waiting on the funder again (stips went in, or an answer was entered by mistake)
    insert into timers (user_id, client_id, kind, due_on, note, submission_id)
    select c.user_id, c.id, 'chase', app.add_business_days(app.local_today(), 1), 'Ask ' || fname || ' for a decision', s.id
     where not exists (select 1 from timers t where t.submission_id = s.id and t.kind = 'chase' and t.done_at is null);
  end if;

  perform app.ensure_open_timer(c.id, 'Funder answered — next step');
  return s;
end $$;


--
-- Name: trash_client(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trash_client(p_client uuid) RETURNS void
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare c clients;
begin
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from trashed_clients where client_id = p_client) then
    return;
  end if;
  -- now() is the transaction's start, so the closed timers and the trash row share one timestamp.
  update timers set done_at = now(), done_reason = 'cancelled' where client_id = p_client and done_at is null;
  update clients set scheduled_call_at = null where id = p_client;
  insert into trashed_clients (client_id, user_id, trashed_at) values (p_client, c.user_id, now());
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Moved to trash');
end $$;


--
-- Name: update_funding_terms(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_funding_terms(p_funding uuid, p_terms jsonb) RETURNS public.fundings
    LANGUAGE plpgsql
    SET search_path TO 'public', 'pg_temp'
    AS $_$
declare
  f fundings;      -- the advance as it was
  n fundings;      -- the advance as it is
  c clients;
  cid uuid;
  tz text;
  today date;
  v_funded_on date;
  v_funder text;
  v_amount bigint;
  v_factor numeric;
  v_payment bigint;
  v_freq text;
  v_position int;
  v_term int;
  v_commission bigint;
  v_override bigint;
  v_last_payment date;
  v_promise_at timestamptz;
  v_promise_amount bigint;
  v_note text;
  v_received bigint;
  v_received_on date;
  v_payback bigint;
  v_payoff_days numeric;
  was_latest boolean;
  is_latest boolean;
  rank_before int;
  rank_after int;
  newer_funded date;
  old_raw date;
  new_raw date;
  t timers;
  target date;
  snoozed boolean;
  moved_to date;
  changes text[] := '{}';
  body text;
begin
  if p_terms is null or jsonb_typeof(p_terms) <> 'object' then
    raise exception 'nothing to save' using errcode = '22023';
  end if;

  select client_id into cid from fundings where id = p_funding;
  if not found then
    raise exception 'that advance no longer exists' using errcode = 'P0002';
  end if;
  -- the lock order every function uses: the client first, then its advance
  select * into c from clients where id = cid for update;
  select * into f from fundings where id = p_funding for update;
  if not found then
    raise exception 'that advance no longer exists' using errcode = 'P0002';
  end if;

  select timezone into tz from app_users where id = c.user_id;
  today := (now() at time zone coalesce(tz, 'UTC'))::date;

  v_funded_on := case when p_terms ? 'funded_on' then (p_terms->>'funded_on')::date else f.funded_on end;
  v_funder := case when p_terms ? 'funder_name' then btrim(coalesce(p_terms->>'funder_name', '')) else f.funder_name end;
  v_amount := case when p_terms ? 'amount_cents' then (p_terms->>'amount_cents')::bigint else f.amount_cents end;
  v_factor := case when p_terms ? 'factor_rate' then round((p_terms->>'factor_rate')::numeric, 3) else f.factor_rate end;
  v_payment := case when p_terms ? 'payment_cents' then (p_terms->>'payment_cents')::bigint else f.payment_cents end;
  v_freq := case when p_terms ? 'frequency' then p_terms->>'frequency' else f.frequency end;
  v_position := case when p_terms ? 'position_no' then (p_terms->>'position_no')::int else f.position_no end;
  v_term := case when p_terms ? 'term_days' then (p_terms->>'term_days')::int else f.term_days end;
  v_commission := case when p_terms ? 'commission_cents' then (p_terms->>'commission_cents')::bigint else f.commission_cents end;
  v_override := case when p_terms ? 'paid_back_override_cents' then (p_terms->>'paid_back_override_cents')::bigint else f.paid_back_override_cents end;
  v_last_payment := case when p_terms ? 'last_payment_on' then (p_terms->>'last_payment_on')::date else f.last_payment_on end;
  v_promise_at := case when p_terms ? 'promise_to_pay_at' then (p_terms->>'promise_to_pay_at')::timestamptz else f.promise_to_pay_at end;
  v_promise_amount := case when p_terms ? 'promise_amount_cents' then (p_terms->>'promise_amount_cents')::bigint else f.promise_amount_cents end;
  v_note := case when p_terms ? 'note' then coalesce(p_terms->>'note', '') else f.note end;
  v_received := case when p_terms ? 'commission_received_cents' then (p_terms->>'commission_received_cents')::bigint else f.commission_received_cents end;
  v_received_on := case when p_terms ? 'commission_received_on' then (p_terms->>'commission_received_on')::date else f.commission_received_on end;

  -- ---- validation, in words Isaac can act on. Only the groups he is actually changing are checked, so
  -- an unrelated edit is never blocked by an old row that predates a rule.
  if p_terms ?| array['funded_on'] then
    if v_funded_on is null then
      raise exception 'Pick the funded date' using errcode = '22023';
    end if;
    if v_funded_on > today + 1 then
      raise exception 'The funded date % is in the future', app.earnings_fmt_date(v_funded_on) using errcode = '22023';
    end if;
    if v_funded_on < date '2000-01-01' then
      raise exception 'The funded date % looks wrong', app.earnings_fmt_date(v_funded_on) using errcode = '22023';
    end if;
  end if;
  if length(v_funder) > 200 or v_funder ~ '[[:cntrl:]]' then
    raise exception 'The funder name must be one line of 200 characters or fewer' using errcode = '22023';
  end if;
  if p_terms ?| array['amount_cents'] and (v_amount is null or v_amount <= 0 or v_amount > 10000000000) then
    raise exception 'The advance amount must be more than $0 and at most $100,000,000' using errcode = '22023';
  end if;
  if p_terms ?| array['factor_rate'] and (v_factor is null or v_factor < 1 or v_factor > 3) then
    raise exception 'Factor rate must be between 1.00 and 3.00' using errcode = '22023';
  end if;
  if p_terms ?| array['payment_cents'] and (v_payment is null or v_payment <= 0) then
    raise exception 'Enter the remittance amount' using errcode = '22023';
  end if;
  if p_terms ?| array['frequency'] and (v_freq is null or v_freq not in ('daily', 'weekly', 'biweekly', 'monthly')) then
    raise exception 'Pick how often the remittance is taken' using errcode = '22023';
  end if;
  if p_terms ?| array['position_no'] and (v_position is null or v_position < 1 or v_position > 20) then
    raise exception 'Position must be a whole number from 1 to 20' using errcode = '22023';
  end if;
  if p_terms ?| array['term_days'] and v_term is not null and (v_term < 1 or v_term > 3650) then
    raise exception 'Term must be between 1 and 3,650 days' using errcode = '22023';
  end if;
  if p_terms ?| array['commission_cents', 'amount_cents'] and v_commission is not null
     and (v_commission < 0 or v_commission > v_amount) then
    raise exception 'Commission can''t be more than the advance' using errcode = '22023';
  end if;
  if p_terms ?| array['paid_back_override_cents'] and v_override is not null and v_override < 0 then
    raise exception 'Collected so far can''t be negative' using errcode = '22023';
  end if;
  if p_terms ?| array['promise_amount_cents'] and v_promise_amount is not null and v_promise_amount <= 0 then
    raise exception 'The promised amount must be more than $0' using errcode = '22023';
  end if;
  if length(v_note) > 5000 then
    raise exception 'The note is too long' using errcode = '22023';
  end if;
  if p_terms ?| array['commission_received_cents', 'commission_received_on'] then
    if (v_received is null) <> (v_received_on is null) then
      raise exception 'Enter both the commission received and the day it arrived' using errcode = '22023';
    end if;
    if v_received is not null and v_received < 0 then
      raise exception 'Commission received can''t be negative' using errcode = '22023';
    end if;
    if v_received_on is not null and v_received_on > today + 1 then
      raise exception 'The commission received date % is in the future', app.earnings_fmt_date(v_received_on)
        using errcode = '22023';
    end if;
  end if;
  if p_terms ?| array['funded_on', 'amount_cents', 'factor_rate', 'payment_cents', 'frequency'] then
    v_payback := round(v_amount * v_factor)::bigint;
    if v_payment > v_payback then
      raise exception 'One remittance can''t be more than the whole payback (%)', app.earnings_fmt_money(v_payback)
        using errcode = '22023';
    end if;
    -- nobody writes a five-year advance: that is a mistyped remittance, and it would put a renewal call off the calendar
    v_payoff_days := ceil(v_payback::numeric / v_payment) * case v_freq
      when 'daily' then 7.0 / 5 when 'weekly' then 7 when 'biweekly' then 14 else 30.5 end;
    if v_payoff_days > 1830 then
      raise exception 'At % this advance would take more than 5 years to pay back — check the remittance amount',
        app.earnings_fmt_remittance(v_payment, v_freq) using errcode = '22023';
    end if;
  end if;
  if p_terms ?| array['funded_on', 'last_payment_on'] and v_last_payment is not null then
    if v_last_payment < v_funded_on then
      raise exception 'The last remittance (%) is before the funded date (%) — change one of them',
        app.earnings_fmt_date(v_last_payment), app.earnings_fmt_date(v_funded_on) using errcode = '22023';
    end if;
    if v_last_payment > today + 1 then
      raise exception 'The last remittance date % is in the future', app.earnings_fmt_date(v_last_payment)
        using errcode = '22023';
    end if;
  end if;

  -- ---- is this the client's newest advance? Judged on the row as it WAS: the renewal call belongs to it
  select (id = f.id) into was_latest from fundings
   where client_id = f.client_id order by funded_on desc, created_at desc limit 1;
  -- a corrected date that would put this advance before (or after) another one swaps which advance is "current".
  -- Refuse that when other things are being changed in the same save; as the only change it is the correction.
  if p_terms ? 'funded_on' and v_funded_on is distinct from f.funded_on and (select count(*) from jsonb_object_keys(p_terms)) > 1 then
    select count(*) into rank_before from fundings o
     where o.client_id = f.client_id and o.id <> f.id and (o.funded_on, o.created_at) > (f.funded_on, f.created_at);
    select count(*) into rank_after from fundings o
     where o.client_id = f.client_id and o.id <> f.id and (o.funded_on, o.created_at) > (v_funded_on, f.created_at);
    if rank_before <> rank_after then
      select max(o.funded_on) into newer_funded from fundings o
       where o.client_id = f.client_id and o.id <> f.id
         and o.funded_on between least(f.funded_on, v_funded_on) and greatest(f.funded_on, v_funded_on);
      raise exception 'Funded %: that puts this advance on the other side of the one funded % — change just the date first, then the rest',
        app.earnings_fmt_date(v_funded_on), app.earnings_fmt_date(newer_funded) using errcode = '22023';
    end if;
  end if;

  update fundings set
      funded_on = v_funded_on, funder_name = v_funder, amount_cents = v_amount, factor_rate = v_factor,
      payment_cents = v_payment, frequency = v_freq, position_no = v_position, term_days = v_term,
      commission_cents = v_commission, paid_back_override_cents = v_override, last_payment_on = v_last_payment,
      promise_to_pay_at = v_promise_at, promise_amount_cents = v_promise_amount, note = v_note,
      commission_received_cents = v_received, commission_received_on = v_received_on
   where id = f.id returning * into n;

  -- ---- the renewal call: only for the client's latest advance, and only while it is active
  select (id = n.id) into is_latest from fundings
   where client_id = n.client_id order by funded_on desc, created_at desc limit 1;

  if n.status = 'active' and (was_latest or is_latest) then
    old_raw := app.date_at_paydown(f.funded_on, f.amount_cents, f.factor_rate, f.payment_cents, f.frequency, 50);
    new_raw := app.date_at_paydown(n.funded_on, n.amount_cents, n.factor_rate, n.payment_cents, n.frequency, 50);
    if new_raw is not null and old_raw is distinct from new_raw then
      for t in select * from timers
                where client_id = n.client_id and kind = 'renewal' and done_at is null
                order by due_on for update loop
        snoozed := old_raw is not null and t.due_on > greatest(old_raw, today);
        target := case
          when snoozed then greatest(new_raw, t.due_on)
          when new_raw > today then new_raw
          else least(t.due_on, today) end;
        if target <> t.due_on then
          update timers set due_on = target where id = t.id;
          moved_to := target;
        end if;
      end loop;
    end if;
  end if;

  -- ---- the timeline, in human words
  if f.funded_on is distinct from n.funded_on then
    changes := changes || ('funded date ' || app.earnings_fmt_date(f.funded_on) || ' → ' || app.earnings_fmt_date(n.funded_on));
  end if;
  if f.funder_name is distinct from n.funder_name then
    changes := changes || ('funder ' || coalesce(nullif(f.funder_name, ''), 'none') || ' → ' || coalesce(nullif(n.funder_name, ''), 'none'));
  end if;
  if f.amount_cents is distinct from n.amount_cents then
    changes := changes || ('amount ' || app.earnings_fmt_money(f.amount_cents) || ' → ' || app.earnings_fmt_money(n.amount_cents));
  end if;
  if f.factor_rate is distinct from n.factor_rate then
    changes := changes || ('factor rate ' || app.earnings_fmt_factor(f.factor_rate) || ' → ' || app.earnings_fmt_factor(n.factor_rate));
  end if;
  if f.payment_cents is distinct from n.payment_cents or f.frequency is distinct from n.frequency then
    changes := changes || ('remittance ' || app.earnings_fmt_remittance(f.payment_cents, f.frequency)
                           || ' → ' || app.earnings_fmt_remittance(n.payment_cents, n.frequency));
  end if;
  if f.position_no is distinct from n.position_no then
    changes := changes || ('position ' || app.earnings_ordinal(f.position_no) || ' → ' || app.earnings_ordinal(n.position_no));
  end if;
  if f.term_days is distinct from n.term_days then
    changes := changes || ('term ' || coalesce(f.term_days::text || ' days', 'none') || ' → ' || coalesce(n.term_days::text || ' days', 'none'));
  end if;
  if f.commission_cents is distinct from n.commission_cents then
    changes := changes || ('commission ' || app.earnings_fmt_money(f.commission_cents) || ' → ' || app.earnings_fmt_money(n.commission_cents));
  end if;

  if cardinality(changes) > 0 then
    body := case when was_latest then 'Advance terms corrected: ' else
              'Past advance (funded ' || app.earnings_fmt_date(n.funded_on) || ') terms corrected: ' end
            || array_to_string(changes, ', ');
    if moved_to is not null then
      body := body || '; renewal call moved to ' || app.earnings_fmt_date(moved_to);
    end if;
    insert into activities (user_id, client_id, kind, body) values (c.user_id, c.id, 'funding', body);
  elsif moved_to is not null then
    insert into activities (user_id, client_id, kind, body)
    values (c.user_id, c.id, 'funding', 'Renewal call moved to ' || app.earnings_fmt_date(moved_to));
  end if;

  if f.commission_received_cents is distinct from n.commission_received_cents
     or f.commission_received_on is distinct from n.commission_received_on then
    body := case
      when n.commission_received_cents is null then 'Commission received cleared'
      when f.commission_received_cents is null then
        'Commission received: ' || app.earnings_fmt_money(n.commission_received_cents) || ' on ' || app.earnings_fmt_date(n.commission_received_on)
      else
        'Commission received corrected: ' || app.earnings_fmt_money(f.commission_received_cents) || ' → '
        || app.earnings_fmt_money(n.commission_received_cents) || ' on ' || app.earnings_fmt_date(n.commission_received_on)
      end;
    insert into activities (user_id, client_id, kind, body) values (c.user_id, c.id, 'funding', body);
  end if;

  return n;
end $_$;


--
-- Name: app_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    timezone text DEFAULT 'America/New_York'::text NOT NULL,
    digest_enabled boolean DEFAULT true NOT NULL,
    digest_hour integer DEFAULT 8 NOT NULL,
    notify_email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    signature text DEFAULT ''::text NOT NULL,
    application_link text DEFAULT ''::text NOT NULL,
    session_epoch integer DEFAULT 0 NOT NULL,
    CONSTRAINT app_users_application_link_check CHECK (((length(application_link) <= 500) AND ((application_link = ''::text) OR (application_link ~ '^https?://[^[:space:]]+$'::text)))),
    CONSTRAINT app_users_digest_hour_check CHECK (((digest_hour >= 0) AND (digest_hour <= 23))),
    CONSTRAINT app_users_email_lower CHECK ((email = lower(email))),
    CONSTRAINT app_users_signature_check CHECK ((length(signature) <= 2000))
);


--
-- Name: client_asks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_asks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    wanted_amount_cents bigint,
    wanted_terms text DEFAULT ''::text NOT NULL,
    est_approval_cents bigint,
    est_approval_note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT client_asks_est_approval_cents_check CHECK ((est_approval_cents >= 0)),
    CONSTRAINT client_asks_wanted_amount_cents_check CHECK ((wanted_amount_cents > 0))
);


--
-- Name: positions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.positions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    position_no integer NOT NULL,
    funder_name text DEFAULT ''::text NOT NULL,
    funded_amount_cents bigint DEFAULT 0 NOT NULL,
    payback_cents bigint,
    balance_cents bigint DEFAULT 0 NOT NULL,
    payment_cents bigint,
    frequency text,
    funded_on date,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT positions_balance_cents_check CHECK ((balance_cents >= 0)),
    CONSTRAINT positions_frequency_check CHECK ((frequency = ANY (ARRAY['daily'::text, 'weekly'::text, 'biweekly'::text, 'monthly'::text]))),
    CONSTRAINT positions_funded_amount_cents_check CHECK ((funded_amount_cents >= 0)),
    CONSTRAINT positions_payback_cents_check CHECK ((payback_cents >= 0)),
    CONSTRAINT positions_payment_cents_check CHECK ((payment_cents >= 0)),
    CONSTRAINT positions_position_no_check CHECK ((position_no >= 1))
);


--
-- Name: trashed_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trashed_clients (
    client_id uuid NOT NULL,
    user_id uuid NOT NULL,
    trashed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: client_cards; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.client_cards WITH (security_invoker='true') AS
 SELECT c.id,
    c.user_id,
    c.business_name,
    c.dba,
    c.contact_name,
    c.phone,
    c.email,
    c.industry,
    c.state,
    c.source,
    c.monthly_revenue_cents,
    c.time_in_business_months,
    c.stage,
    c.stage_changed_at,
    c.application_received_on,
    c.scheduled_call_at,
    c.last_contact_at,
    c.created_at,
    c.updated_at,
    c.contact_status,
    c.contact_status_note,
    c.contact_status_at,
    c.hot,
    nt.due_on AS next_due_on,
    nt.kind AS next_due_kind,
    ( SELECT max(a.occurred_at) AS max
           FROM public.activities a
          WHERE ((a.client_id = c.id) AND (a.kind = 'call'::text))) AS last_call_at,
    ( SELECT max(a.occurred_at) AS max
           FROM public.activities a
          WHERE ((a.client_id = c.id) AND (a.kind = ANY (ARRAY['call'::text, 'text'::text, 'email'::text])))) AS last_touch_at,
    ( SELECT a.body
           FROM public.activities a
          WHERE ((a.client_id = c.id) AND (a.kind = 'call'::text) AND (a.body <> ''::text))
          ORDER BY a.occurred_at DESC
         LIMIT 1) AS last_call_note,
    ask.wanted_amount_cents,
    ask.wanted_terms,
    ask.est_approval_cents,
    ask.est_approval_note,
    (( SELECT count(*) AS count
           FROM public.positions p
          WHERE (p.client_id = c.id)))::integer AS position_count,
    (( SELECT COALESCE(sum(p.balance_cents), (0)::numeric) AS "coalesce"
           FROM public.positions p
          WHERE (p.client_id = c.id)))::bigint AS position_balance_cents,
    (( SELECT count(*) AS count
           FROM public.stips s
          WHERE ((s.client_id = c.id) AND s.required)))::integer AS stips_required,
    (( SELECT count(*) AS count
           FROM public.stips s
          WHERE ((s.client_id = c.id) AND s.required AND (s.received_at IS NOT NULL))))::integer AS stips_received,
    f.id AS funding_id,
    f.funded_on,
    f.amount_cents AS funding_amount_cents,
    f.factor_rate,
    f.payback_cents AS funding_payback_cents,
    f.payment_cents AS funding_payment_cents,
    f.frequency AS funding_frequency,
    f.paid_back_override_cents,
    f.status AS funding_status,
    f.defaulted_on,
    f.last_payment_on,
    f.promise_to_pay_at,
    f.promise_amount_cents,
    ( SELECT t.channel
           FROM public.timers t
          WHERE ((t.client_id = c.id) AND (t.kind = 'scheduled_call'::text) AND (t.done_at IS NULL))
          ORDER BY t.created_at DESC
         LIMIT 1) AS reminder_channel
   FROM (((public.clients c
     LEFT JOIN LATERAL ( SELECT t.due_on,
            t.kind
           FROM public.timers t
          WHERE ((t.client_id = c.id) AND (t.done_at IS NULL))
          ORDER BY t.due_on, t.created_at
         LIMIT 1) nt ON (true))
     LEFT JOIN LATERAL ( SELECT k.id,
            k.user_id,
            k.client_id,
            k.wanted_amount_cents,
            k.wanted_terms,
            k.est_approval_cents,
            k.est_approval_note,
            k.created_at
           FROM public.client_asks k
          WHERE (k.client_id = c.id)
          ORDER BY k.created_at DESC
         LIMIT 1) ask ON (true))
     LEFT JOIN LATERAL ( SELECT x.id,
            x.user_id,
            x.client_id,
            x.funded_on,
            x.funder_name,
            x.amount_cents,
            x.factor_rate,
            x.payback_cents,
            x.payment_cents,
            x.frequency,
            x.position_no,
            x.term_days,
            x.commission_cents,
            x.paid_back_override_cents,
            x.status,
            x.defaulted_on,
            x.last_payment_on,
            x.promise_to_pay_at,
            x.promise_amount_cents,
            x.note,
            x.created_at,
            x.updated_at,
            x.commission_received_cents,
            x.commission_received_on
           FROM public.fundings x
          WHERE (x.client_id = c.id)
          ORDER BY x.funded_on DESC, x.created_at DESC
         LIMIT 1) f ON (true))
  WHERE (NOT (EXISTS ( SELECT 1
           FROM public.trashed_clients tc
          WHERE (tc.client_id = c.id))));


--
-- Name: competing_offers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.competing_offers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    funder_name text NOT NULL,
    amount_cents bigint,
    factor_rate numeric(5,3),
    payment_cents bigint,
    frequency text,
    position_no integer,
    term_days integer,
    offered_on date DEFAULT app.local_today() NOT NULL,
    won boolean DEFAULT false NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT competing_offers_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT competing_offers_factor_rate_check CHECK (((factor_rate >= (1)::numeric) AND (factor_rate <= (3)::numeric))),
    CONSTRAINT competing_offers_frequency_check CHECK ((frequency = ANY (ARRAY['daily'::text, 'weekly'::text, 'biweekly'::text, 'monthly'::text]))),
    CONSTRAINT competing_offers_funder_name_check CHECK ((btrim(funder_name) <> ''::text)),
    CONSTRAINT competing_offers_payment_cents_check CHECK ((payment_cents > 0)),
    CONSTRAINT competing_offers_position_no_check CHECK ((position_no >= 1)),
    CONSTRAINT competing_offers_term_days_check CHECK ((term_days > 0))
);


--
-- Name: funders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.funders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    submission_email text DEFAULT ''::text NOT NULL,
    contact_name text DEFAULT ''::text NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    min_monthly_revenue_cents bigint,
    min_time_in_business_months integer,
    max_position integer,
    min_amount_cents bigint,
    max_amount_cents bigint,
    excluded_states text[] DEFAULT '{}'::text[] NOT NULL,
    excluded_industries text[] DEFAULT '{}'::text[] NOT NULL,
    commission_points numeric(5,2),
    renewal_paydown_pct integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT funders_check CHECK (((min_amount_cents IS NULL) OR (max_amount_cents IS NULL) OR (min_amount_cents <= max_amount_cents))),
    CONSTRAINT funders_commission_points_check CHECK (((commission_points >= (0)::numeric) AND (commission_points <= (100)::numeric))),
    CONSTRAINT funders_max_amount_cents_check CHECK ((max_amount_cents >= 0)),
    CONSTRAINT funders_max_position_check CHECK ((max_position >= 1)),
    CONSTRAINT funders_min_amount_cents_check CHECK ((min_amount_cents >= 0)),
    CONSTRAINT funders_min_monthly_revenue_cents_check CHECK ((min_monthly_revenue_cents >= 0)),
    CONSTRAINT funders_min_time_in_business_months_check CHECK ((min_time_in_business_months >= 0)),
    CONSTRAINT funders_name_check CHECK (((btrim(name) <> ''::text) AND (length(name) <= 200))),
    CONSTRAINT funders_renewal_paydown_pct_check CHECK (((renewal_paydown_pct >= 1) AND (renewal_paydown_pct <= 100)))
);


--
-- Name: gmail_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gmail_connections (
    user_id uuid NOT NULL,
    google_email text NOT NULL,
    refresh_token_enc text NOT NULL,
    scope text DEFAULT ''::text NOT NULL,
    status text DEFAULT 'ok'::text NOT NULL,
    last_error text,
    connected_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gmail_connections_status_check CHECK ((status = ANY (ARRAY['ok'::text, 'needs_reconnect'::text])))
);


--
-- Name: job_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_runs (
    name text NOT NULL,
    last_run_at timestamp with time zone NOT NULL,
    CONSTRAINT job_runs_name_check CHECK (((btrim(name) <> ''::text) AND (length(name) <= 64)))
);


--
-- Name: lead_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lead_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone,
    window_start timestamp with time zone DEFAULT now() NOT NULL,
    window_count integer DEFAULT 0 NOT NULL,
    created_day date,
    created_today integer DEFAULT 0 NOT NULL
);


--
-- Name: reminders_sent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reminders_sent (
    user_id uuid NOT NULL,
    kind text NOT NULL,
    for_date date NOT NULL,
    ref text DEFAULT ''::text NOT NULL,
    provider_id text,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT reminders_sent_kind_check CHECK ((kind = ANY (ARRAY['digest'::text, 'call'::text, 'new_lead'::text, 'weekly'::text])))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: snippets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snippets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    title text NOT NULL,
    kind text NOT NULL,
    body text NOT NULL,
    sort integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT snippets_body_check CHECK (((btrim(body) <> ''::text) AND (length(body) <= 5000))),
    CONSTRAINT snippets_kind_check CHECK ((kind = ANY (ARRAY['text'::text, 'email'::text]))),
    CONSTRAINT snippets_title_check CHECK (((btrim(title) <> ''::text) AND (length(title) <= 80)))
);


--
-- Name: stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stages (
    key text NOT NULL,
    label text NOT NULL,
    stage_group text NOT NULL,
    sort integer NOT NULL,
    CONSTRAINT stages_stage_group_check CHECK ((stage_group = ANY (ARRAY['prospecting'::text, 'underwriting'::text, 'funded'::text, 'trouble'::text, 'exit'::text])))
);


--
-- Name: activities activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_pkey PRIMARY KEY (id);


--
-- Name: app_users app_users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_email_key UNIQUE (email);


--
-- Name: app_users app_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_users
    ADD CONSTRAINT app_users_pkey PRIMARY KEY (id);


--
-- Name: client_asks client_asks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_asks
    ADD CONSTRAINT client_asks_pkey PRIMARY KEY (id);


--
-- Name: clients clients_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_id_user_id_key UNIQUE (id, user_id);


--
-- Name: clients clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_pkey PRIMARY KEY (id);


--
-- Name: competing_offers competing_offers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competing_offers
    ADD CONSTRAINT competing_offers_pkey PRIMARY KEY (id);


--
-- Name: funders funders_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.funders
    ADD CONSTRAINT funders_id_user_id_key UNIQUE (id, user_id);


--
-- Name: funders funders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.funders
    ADD CONSTRAINT funders_pkey PRIMARY KEY (id);


--
-- Name: fundings fundings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fundings
    ADD CONSTRAINT fundings_pkey PRIMARY KEY (id);


--
-- Name: gmail_connections gmail_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gmail_connections
    ADD CONSTRAINT gmail_connections_pkey PRIMARY KEY (user_id);


--
-- Name: job_runs job_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_runs
    ADD CONSTRAINT job_runs_pkey PRIMARY KEY (name);


--
-- Name: lead_tokens lead_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_tokens
    ADD CONSTRAINT lead_tokens_pkey PRIMARY KEY (id);


--
-- Name: lead_tokens lead_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_tokens
    ADD CONSTRAINT lead_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: offers offers_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offers
    ADD CONSTRAINT offers_id_user_id_key UNIQUE (id, user_id);


--
-- Name: offers offers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offers
    ADD CONSTRAINT offers_pkey PRIMARY KEY (id);


--
-- Name: positions positions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT positions_pkey PRIMARY KEY (id);


--
-- Name: reminders_sent reminders_sent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders_sent
    ADD CONSTRAINT reminders_sent_pkey PRIMARY KEY (user_id, kind, for_date, ref);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (name);


--
-- Name: snippets snippets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snippets
    ADD CONSTRAINT snippets_pkey PRIMARY KEY (id);


--
-- Name: stages stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stages
    ADD CONSTRAINT stages_pkey PRIMARY KEY (key);


--
-- Name: stages stages_sort_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stages
    ADD CONSTRAINT stages_sort_key UNIQUE (sort);


--
-- Name: stips stips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stips
    ADD CONSTRAINT stips_pkey PRIMARY KEY (id);


--
-- Name: submissions submissions_client_id_funder_id_sent_on_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_client_id_funder_id_sent_on_key UNIQUE (client_id, funder_id, sent_on);


--
-- Name: submissions submissions_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_id_user_id_key UNIQUE (id, user_id);


--
-- Name: submissions submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_pkey PRIMARY KEY (id);


--
-- Name: timers timers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timers
    ADD CONSTRAINT timers_pkey PRIMARY KEY (id);


--
-- Name: trashed_clients trashed_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trashed_clients
    ADD CONSTRAINT trashed_clients_pkey PRIMARY KEY (client_id);


--
-- Name: activities_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX activities_client_idx ON public.activities USING btree (client_id, occurred_at DESC);


--
-- Name: client_asks_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX client_asks_client_idx ON public.client_asks USING btree (client_id, created_at DESC);


--
-- Name: clients_user_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clients_user_phone_idx ON public.clients USING btree (user_id, phone) WHERE (phone <> ''::text);


--
-- Name: clients_user_stage_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clients_user_stage_idx ON public.clients USING btree (user_id, stage);


--
-- Name: competing_offers_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX competing_offers_client_idx ON public.competing_offers USING btree (client_id, offered_on DESC);


--
-- Name: funders_user_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX funders_user_name_key ON public.funders USING btree (user_id, lower(btrim(name)));


--
-- Name: fundings_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fundings_client_idx ON public.fundings USING btree (client_id, funded_on DESC);


--
-- Name: lead_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lead_tokens_user_idx ON public.lead_tokens USING btree (user_id);


--
-- Name: offers_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX offers_client_idx ON public.offers USING btree (client_id, received_on DESC);


--
-- Name: offers_submission_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX offers_submission_idx ON public.offers USING btree (submission_id);


--
-- Name: positions_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX positions_client_idx ON public.positions USING btree (client_id, position_no);


--
-- Name: snippets_user_kind_title_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX snippets_user_kind_title_key ON public.snippets USING btree (user_id, kind, lower(btrim(title)));


--
-- Name: snippets_user_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX snippets_user_sort_idx ON public.snippets USING btree (user_id, kind, sort, created_at);


--
-- Name: stips_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX stips_unique_idx ON public.stips USING btree (client_id, kind, COALESCE(period, '0001-01-01'::date));


--
-- Name: submissions_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submissions_client_idx ON public.submissions USING btree (client_id, sent_on DESC);


--
-- Name: submissions_funder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX submissions_funder_idx ON public.submissions USING btree (funder_id);


--
-- Name: timers_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX timers_client_idx ON public.timers USING btree (client_id) WHERE (done_at IS NULL);


--
-- Name: timers_one_open_chase_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX timers_one_open_chase_idx ON public.timers USING btree (submission_id) WHERE ((kind = 'chase'::text) AND (done_at IS NULL));


--
-- Name: timers_open_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX timers_open_due_idx ON public.timers USING btree (user_id, due_on) WHERE (done_at IS NULL);


--
-- Name: clients clients_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER clients_touch BEFORE UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: funders funders_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER funders_touch BEFORE UPDATE ON public.funders FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: fundings fundings_live_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fundings_live_only BEFORE INSERT OR UPDATE ON public.fundings FOR EACH ROW EXECUTE FUNCTION app.refuse_when_trashed();


--
-- Name: fundings fundings_no_delete_in_trash; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fundings_no_delete_in_trash BEFORE DELETE ON public.fundings FOR EACH ROW EXECUTE FUNCTION app.refuse_delete_when_trashed();


--
-- Name: fundings fundings_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER fundings_touch BEFORE UPDATE ON public.fundings FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: gmail_connections gmail_connections_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER gmail_connections_touch BEFORE UPDATE ON public.gmail_connections FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: offers offers_live_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER offers_live_only BEFORE INSERT OR UPDATE ON public.offers FOR EACH ROW EXECUTE FUNCTION app.refuse_when_trashed();


--
-- Name: offers offers_no_delete_in_trash; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER offers_no_delete_in_trash BEFORE DELETE ON public.offers FOR EACH ROW EXECUTE FUNCTION app.refuse_delete_when_trashed();


--
-- Name: offers offers_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER offers_touch BEFORE UPDATE ON public.offers FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: positions positions_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER positions_touch BEFORE UPDATE ON public.positions FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();


--
-- Name: submissions submissions_live_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER submissions_live_only BEFORE INSERT OR UPDATE ON public.submissions FOR EACH ROW EXECUTE FUNCTION app.refuse_when_trashed();


--
-- Name: submissions submissions_no_delete_in_trash; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER submissions_no_delete_in_trash BEFORE DELETE ON public.submissions FOR EACH ROW EXECUTE FUNCTION app.refuse_delete_when_trashed();


--
-- Name: timers timers_live_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER timers_live_only BEFORE INSERT ON public.timers FOR EACH ROW EXECUTE FUNCTION app.timers_live_only();


--
-- Name: activities activities_client_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_client_id_user_id_fkey FOREIGN KEY (client_id, user_id) REFERENCES public.clients(id, user_id) ON DELETE CASCADE;


--
-- Name: activities activities_from_stage_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_from_stage_fkey FOREIGN KEY (from_stage) REFERENCES public.stages(key);


--
-- Name: activities activities_to_stage_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activities
    ADD CONSTRAINT activities_to_stage_fkey FOREIGN KEY (to_stage) REFERENCES public.stages(key);


--
-- Name: client_asks client_asks_client_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_asks
    ADD CONSTRAINT client_asks_client_id_user_id_fkey FOREIGN KEY (client_id, user_id) REFERENCES public.clients(id, user_id) ON DELETE CASCADE;


--
-- Name: clients clients_stage_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_stage_fkey FOREIGN KEY (stage) REFERENCES public.stages(key);


--
-- Name: clients clients_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: competing_offers competing_offers_client_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.competing_offers
    ADD CONSTRAINT competing_offers_client_id_user_id_fkey FOREIGN KEY (client_id, user_id) REFERENCES public.clients(id, user_id) ON DELETE CASCADE;


--
-- Name: funders funders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.funders
    ADD CONSTRAINT funders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: fundings fundings_client_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fundings
    ADD CONSTRAINT fundings_client_id_user_id_fkey FOREIGN KEY (client_id, user_id) REFERENCES public.clients(id, user_id) ON DELETE CASCADE;


--
-- Name: gmail_connections gmail_connections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gmail_connections
    ADD CONSTRAINT gmail_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: lead_tokens lead_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_tokens
    ADD CONSTRAINT lead_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: offers offers_client_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offers
    ADD CONSTRAINT offers_client_id_user_id_fkey FOREIGN KEY (client_id, user_id) REFERENCES public.clients(id, user_id) ON DELETE CASCADE;


--
-- Name: offers offers_declined_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offers
    ADD CONSTRAINT offers_declined_by_fkey FOREIGN KEY (declined_by) REFERENCES public.offers(id) ON DELETE SET NULL;


--
-- Name: offers offers_submission_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.offers
    ADD CONSTRAINT offers_submission_id_user_id_fkey FOREIGN KEY (submission_id, user_id) REFERENCES public.submissions(id, user_id) ON DELETE CASCADE;


--
-- Name: positions positions_client_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.positions
    ADD CONSTRAINT positions_client_id_user_id_fkey FOREIGN KEY (client_id, user_id) REFERENCES public.clients(id, user_id) ON DELETE CASCADE;


--
-- Name: reminders_sent reminders_sent_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reminders_sent
    ADD CONSTRAINT reminders_sent_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: snippets snippets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snippets
    ADD CONSTRAINT snippets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: stips stips_client_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stips
    ADD CONSTRAINT stips_client_id_user_id_fkey FOREIGN KEY (client_id, user_id) REFERENCES public.clients(id, user_id) ON DELETE CASCADE;


--
-- Name: submissions submissions_client_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_client_id_user_id_fkey FOREIGN KEY (client_id, user_id) REFERENCES public.clients(id, user_id) ON DELETE CASCADE;


--
-- Name: submissions submissions_funder_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_funder_id_user_id_fkey FOREIGN KEY (funder_id, user_id) REFERENCES public.funders(id, user_id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: timers timers_client_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timers
    ADD CONSTRAINT timers_client_id_user_id_fkey FOREIGN KEY (client_id, user_id) REFERENCES public.clients(id, user_id) ON DELETE CASCADE;


--
-- Name: timers timers_submission_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timers
    ADD CONSTRAINT timers_submission_fk FOREIGN KEY (submission_id, user_id) REFERENCES public.submissions(id, user_id) ON DELETE CASCADE;


--
-- Name: trashed_clients trashed_clients_client_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trashed_clients
    ADD CONSTRAINT trashed_clients_client_id_user_id_fkey FOREIGN KEY (client_id, user_id) REFERENCES public.clients(id, user_id) ON DELETE CASCADE;


--
-- Name: trashed_clients trashed_clients_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trashed_clients
    ADD CONSTRAINT trashed_clients_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.app_users(id) ON DELETE CASCADE;


--
-- Name: activities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;

--
-- Name: activities activities_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY activities_insert ON public.activities FOR INSERT TO isaac_app WITH CHECK ((user_id = app.current_user_id()));


--
-- Name: activities activities_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY activities_select ON public.activities FOR SELECT TO isaac_app USING ((user_id = app.current_user_id()));


--
-- Name: app_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;

--
-- Name: app_users app_users_self_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY app_users_self_select ON public.app_users FOR SELECT TO isaac_app USING ((id = app.current_user_id()));


--
-- Name: app_users app_users_self_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY app_users_self_update ON public.app_users FOR UPDATE TO isaac_app USING ((id = app.current_user_id())) WITH CHECK ((id = app.current_user_id()));


--
-- Name: client_asks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.client_asks ENABLE ROW LEVEL SECURITY;

--
-- Name: client_asks client_asks_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY client_asks_owner ON public.client_asks TO isaac_app USING ((user_id = app.current_user_id())) WITH CHECK ((user_id = app.current_user_id()));


--
-- Name: clients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

--
-- Name: clients clients_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY clients_owner ON public.clients TO isaac_app USING ((user_id = app.current_user_id())) WITH CHECK ((user_id = app.current_user_id()));


--
-- Name: competing_offers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.competing_offers ENABLE ROW LEVEL SECURITY;

--
-- Name: competing_offers competing_offers_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY competing_offers_owner ON public.competing_offers TO isaac_app USING ((user_id = app.current_user_id())) WITH CHECK ((user_id = app.current_user_id()));


--
-- Name: funders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.funders ENABLE ROW LEVEL SECURITY;

--
-- Name: funders funders_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY funders_owner ON public.funders TO isaac_app USING ((user_id = app.current_user_id())) WITH CHECK ((user_id = app.current_user_id()));


--
-- Name: fundings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fundings ENABLE ROW LEVEL SECURITY;

--
-- Name: fundings fundings_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY fundings_owner ON public.fundings TO isaac_app USING ((user_id = app.current_user_id())) WITH CHECK ((user_id = app.current_user_id()));


--
-- Name: gmail_connections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.gmail_connections ENABLE ROW LEVEL SECURITY;

--
-- Name: job_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.job_runs ENABLE ROW LEVEL SECURITY;

--
-- Name: lead_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lead_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: lead_tokens lead_tokens_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lead_tokens_insert ON public.lead_tokens FOR INSERT TO isaac_app WITH CHECK ((user_id = app.current_user_id()));


--
-- Name: lead_tokens lead_tokens_revoke; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lead_tokens_revoke ON public.lead_tokens FOR UPDATE TO isaac_app USING ((user_id = app.current_user_id())) WITH CHECK ((user_id = app.current_user_id()));


--
-- Name: lead_tokens lead_tokens_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY lead_tokens_select ON public.lead_tokens FOR SELECT TO isaac_app USING ((user_id = app.current_user_id()));


--
-- Name: offers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.offers ENABLE ROW LEVEL SECURITY;

--
-- Name: offers offers_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY offers_owner ON public.offers TO isaac_app USING ((user_id = app.current_user_id())) WITH CHECK ((user_id = app.current_user_id()));


--
-- Name: positions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;

--
-- Name: positions positions_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY positions_owner ON public.positions TO isaac_app USING ((user_id = app.current_user_id())) WITH CHECK ((user_id = app.current_user_id()));


--
-- Name: reminders_sent; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reminders_sent ENABLE ROW LEVEL SECURITY;

--
-- Name: snippets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.snippets ENABLE ROW LEVEL SECURITY;

--
-- Name: snippets snippets_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY snippets_owner ON public.snippets TO isaac_app USING ((user_id = app.current_user_id())) WITH CHECK ((user_id = app.current_user_id()));


--
-- Name: stages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stages ENABLE ROW LEVEL SECURITY;

--
-- Name: stages stages_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stages_read ON public.stages FOR SELECT TO isaac_app USING (true);


--
-- Name: stips; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stips ENABLE ROW LEVEL SECURITY;

--
-- Name: stips stips_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY stips_owner ON public.stips TO isaac_app USING ((user_id = app.current_user_id())) WITH CHECK ((user_id = app.current_user_id()));


--
-- Name: submissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;

--
-- Name: submissions submissions_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY submissions_owner ON public.submissions TO isaac_app USING ((user_id = app.current_user_id())) WITH CHECK ((user_id = app.current_user_id()));


--
-- Name: timers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.timers ENABLE ROW LEVEL SECURITY;

--
-- Name: timers timers_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY timers_owner ON public.timers TO isaac_app USING ((user_id = app.current_user_id())) WITH CHECK ((user_id = app.current_user_id()));


--
-- Name: trashed_clients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trashed_clients ENABLE ROW LEVEL SECURITY;

--
-- Name: trashed_clients trashed_clients_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY trashed_clients_owner ON public.trashed_clients TO isaac_app USING ((user_id = app.current_user_id())) WITH CHECK ((user_id = app.current_user_id()));


--
-- PostgreSQL database dump complete
--


