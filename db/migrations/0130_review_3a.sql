-- 0130: review-3A fixes that live in SQL.
--   A-7  update_funding_terms: "was it the latest advance" is judged on the row as it WAS; a funded-date change that
--        reorders the client's advances is refused unless it is the only thing being changed.
--   A-8  accept_offer remembers which offers it turned down, "Undo accept" restores them, and an offer that is
--        expired / turned down / from a funder that said no cannot be accepted.
--   A-16 one lock order everywhere: the client first, then the child row (no more deadlocks between two tabs).
--   I-2  record_default takes the default date the caller gives; only a missing date keeps the old one.

alter table offers
  add column declined_by uuid references offers (id) on delete set null,
  add column declined_from text check (declined_from in ('open', 'presented', 'accepted'));
alter table offers add constraint offers_declined_pair
  check ((declined_by is null) = (declined_from is null));

create or replace function public.set_submission_status(p_submission uuid, p_status text,
                                             p_decline_reason text default null, p_note text default '')
returns submissions
language plpgsql set search_path = public, pg_temp as $$
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

create or replace function public.record_offer(p_submission uuid, p_offer jsonb)
returns offers
language plpgsql set search_path = public, pg_temp as $$
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

create or replace function public.remove_submission(p_submission uuid)
returns void
language plpgsql set search_path = public, pg_temp as $$
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
  delete from submissions where id = s.id;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, c.id, 'system', 'Removed the submission to ' || fname);
  perform app.ensure_open_timer(c.id, 'Submission removed — next step');
end $$;

-- ---------------------------------------------------------------------------------------------
-- A-8 / A-16: the merchant takes an offer. Turned-down siblings are remembered so "Undo accept" can bring them back.

create or replace function public.accept_offer(p_offer uuid)
returns offers
language plpgsql set search_path = public, pg_temp as $$
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

-- present / reopen / turn down / let lapse. Acceptance has its own function.
-- Moving an ACCEPTED offer to anything else is "undo accept": the offers its acceptance turned down come back.
create or replace function public.set_offer_status(p_offer uuid, p_status text)
returns offers
language plpgsql set search_path = public, pg_temp as $$
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

-- ---------------------------------------------------------------------------------------------
-- A-16 / I-2: the client is locked first; a default date the caller gives is the one that is saved

create or replace function public.record_default(p_client uuid, p_stage text, p_defaulted_on date,
                                      p_promise_at timestamptz, p_promise_amount_cents bigint,
                                      p_timers jsonb, p_note text default '')
returns clients
language plpgsql set search_path = public, pg_temp as $$
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

-- ---------------------------------------------------------------------------------------------
-- A-7 / A-16

create or replace function public.update_funding_terms(p_funding uuid, p_terms jsonb)
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
end $$;
