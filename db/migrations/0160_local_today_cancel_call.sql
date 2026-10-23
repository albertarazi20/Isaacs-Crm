-- 0160: "today" in the database functions is the user's day, not the server's (review-3A A-21), and cancelling a
-- booked call puts the merchant back in the stage he was in before it was booked (QA I-7).
--
-- The database clock is UTC. At 8 PM in New York it is already tomorrow there, so "next business day" and "today"
-- came out a day late. app.local_today() reads the signed-in user's time zone (UTC when there is no user, as in the
-- hourly job). The function bodies below are the ones already installed, with current_date replaced.

create function app.local_today() returns date
language sql stable set search_path = public, pg_temp as $$
  select (now() at time zone coalesce((select timezone from app_users where id = app.current_user_id()), 'UTC'))::date
$$;

CREATE OR REPLACE FUNCTION public.cancel_call(p_client uuid)
 RETURNS clients
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.create_submissions(p_client uuid, p_funder_ids uuid[], p_sent_on date DEFAULT NULL::date, p_note text DEFAULT ''::text)
 RETURNS SETOF submissions
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION app.ensure_open_timer(p_client uuid, p_note text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare uid uuid;
begin
  if not exists (select 1 from timers where client_id = p_client and done_at is null) then
    select user_id into uid from clients where id = p_client;
    insert into timers (user_id, client_id, kind, due_on, note)
    values (uid, p_client, 'follow_up', app.add_business_days(app.local_today(), 1), coalesce(p_note, ''));
  end if;
end $function$;

CREATE OR REPLACE FUNCTION public.log_touch(p_client uuid, p_kind text, p_outcome text, p_body text, p_next_due_on date)
 RETURNS activities
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- Only a call within a few hours of (or after) the booked time counts as THE booked call.
  call_is_now := p_kind = 'call' and c.scheduled_call_at is not null and c.scheduled_call_at <= now() + interval '3 hours';
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
end $function$;

CREATE OR REPLACE FUNCTION app.promote_to_offers_in(p_client uuid, p_reason text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.record_offer(p_submission uuid, p_offer jsonb)
 RETURNS offers
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION app.replace_timers(p_client uuid, p_user uuid, p_timers jsonb, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.restore_client(p_client uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.set_contact_status(p_client uuid, p_status text, p_note text DEFAULT ''::text)
 RETURNS clients
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.set_submission_status(p_submission uuid, p_status text, p_decline_reason text DEFAULT NULL::text, p_note text DEFAULT ''::text)
 RETURNS submissions
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
end $function$;

