-- Earnings: commission received, and editable advance terms.
--
-- Until now a funded advance was immutable after the Funded dialog: a typo could only be "fixed" by
-- funding again, which marks the first row 'renewed' and corrupts the renewal timers. update_funding_terms()
-- edits the row in place and moves the ONE open renewal call to match, atomically.
--
-- fundings already has row-level security and grants for isaac_app (0001), which cover new columns. This file
-- is ALTER/CREATE FUNCTION only. It depends on nothing from 0010_funders.sql on purpose (that migration may or
-- may not be applied yet), so the helpers below carry their own names instead of reusing app.add_business_days.

-- ---------------------------------------------------------------------------------------------
-- commission received: what the funder actually paid the shop, entered by hand. Amount and the day it
-- arrived travel together.

alter table fundings
  add column commission_received_cents bigint check (commission_received_cents >= 0),
  add column commission_received_on date,
  add constraint fundings_commission_received_pair
    check ((commission_received_cents is null) = (commission_received_on is null));

-- ---------------------------------------------------------------------------------------------
-- date helpers. These port src/lib/mca/dates.ts + funding.ts so the database can re-derive a renewal call;
-- tests/earnings-db.test.ts compares them with the TypeScript for hundreds of random terms.

-- n business days after p_from (Mon-Fri, holidays ignored). Same answer as addBusinessDays(), including from a
-- weekend, but closed-form so an absurd remittance can never spin a loop.
create function app.earnings_add_business_days(p_from date, p_n int) returns date
language plpgsql immutable set search_path = public, pg_temp as $$
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

-- The day the merchant crosses p_pct percent paid down (dateAtPaydown). Null when the remittance is unusable.
-- All integer arithmetic: remittances needed = ceil(payback * pct / (100 * remittance)).
create function app.date_at_paydown(p_funded_on date, p_amount_cents bigint, p_factor numeric,
                                    p_payment_cents bigint, p_frequency text, p_pct int)
returns date
language plpgsql immutable set search_path = public, pg_temp as $$
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

-- ---------------------------------------------------------------------------------------------
-- words for the timeline

create function app.earnings_fmt_money(p_cents bigint) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when p_cents is null then 'none'
              when p_cents % 100 = 0 then '$' || to_char(p_cents / 100, 'FM999,999,999,999,999')
              else '$' || to_char(p_cents / 100.0, 'FM999,999,999,999,990.00') end
$$;

-- 1.34, 1.4 -> 1.34, 1.40; 1.345 stays 1.345
create function app.earnings_fmt_factor(p_factor numeric) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when p_factor * 100 = round(p_factor * 100) then to_char(p_factor, 'FM0.00') else to_char(p_factor, 'FM0.000') end
$$;

create function app.earnings_fmt_date(p_date date) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when p_date is null then 'none' else to_char(p_date, 'FMMon FMDD, YYYY') end
$$;

create function app.earnings_ordinal(p_n int) returns text
language sql immutable set search_path = public, pg_temp as $$
  select p_n::text || case
    when p_n % 100 between 11 and 13 then 'th'
    when p_n % 10 = 1 then 'st'
    when p_n % 10 = 2 then 'nd'
    when p_n % 10 = 3 then 'rd'
    else 'th' end
$$;

-- "$550/day", "$2,000 every 2 weeks"
create function app.earnings_fmt_remittance(p_cents bigint, p_frequency text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select app.earnings_fmt_money(p_cents) || case p_frequency
    when 'daily' then '/day'
    when 'weekly' then '/week'
    when 'biweekly' then ' every 2 weeks'
    else '/month' end
$$;

-- ---------------------------------------------------------------------------------------------
-- edit an advance's terms. SECURITY INVOKER: it runs as isaac_app, so row-level security hides every other user's
-- advance and "not found" is all a stranger can learn.
--
-- p_terms is a JSON object. A key that is present is validated and written (JSON null clears an optional field); a key
-- that is absent keeps the stored value, so "mark commission received" can send just those two keys. Keys:
--   funded_on, funder_name, amount_cents, factor_rate, payment_cents, frequency, position_no, term_days,
--   commission_cents, paid_back_override_cents, last_payment_on, promise_to_pay_at, promise_amount_cents, note,
--   commission_received_cents, commission_received_on
--
-- When the advance is the client's LATEST and still ACTIVE, the open renewal call is re-derived from the new terms.
-- An older (renewed / paid off) advance changes its row and nothing else. A renewal call Isaac snoozed past the date
-- the old terms gave is not pulled back earlier; one that is already overdue stays overdue. No timer is created:
-- a client whose renewal call was already made (or moved on to "Pays off soon") does not get a new one.
create function public.update_funding_terms(p_funding uuid, p_terms jsonb)
returns fundings
language plpgsql set search_path = public, pg_temp as $$
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
  is_latest boolean;
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
  -- same lock order as every other function: the client, then its advance
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

  if n.status = 'active' and is_latest then
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
    body := case when is_latest then 'Advance terms corrected: ' else
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
end $$;
