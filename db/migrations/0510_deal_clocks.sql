-- Stream 2 (S2-2, S2-5, S2-6, S2-8 settings): the deal's clocks.
--   * An approval has a shelf life: the lender's approval_valid_days, else the shop's. Recording an approval without a
--     stated date stamps approval_expires_on; a nightly function moves past-date approvals to expired with a timeline
--     line and tells the rep.
--   * When the month turns, every merchant with an open deal who is collecting statements gets the unreceived row for
--     the newest month lenders expect, so the checklist trigger (0320) re-buckets them and the reminder goes out.
--   * Settings the other stream-2 pieces read: the deals inbox address (Route B), the chase mode gains 'draft', and
--     the double-submission window.

alter table shop_settings
  add column approval_valid_days int not null default 30 check (approval_valid_days between 1 and 365),
  add column deals_inbox_address text not null default '',
  add column resubmit_block_days int not null default 30 check (resubmit_block_days between 0 and 365);

-- A lender's own validity overrides the shop's. 0350 forced 30 on every lender; from here null means "the shop default".
alter table funders alter column approval_valid_days drop not null;
alter table funders alter column approval_valid_days drop default;

alter table shop_settings drop constraint shop_settings_lender_chase_mode_check;
alter table shop_settings add constraint shop_settings_lender_chase_mode_check
  check (lender_chase_mode in ('send', 'draft', 'off'));

create function app.approval_valid_days(p_funder uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select f.approval_valid_days from funders f where f.id = p_funder),
                  (select s.approval_valid_days from shop_settings s), 30)
$$;
revoke execute on function app.approval_valid_days(uuid) from public;
grant execute on function app.approval_valid_days(uuid) to isaac_app;

-- The newest complete statement month a lender expects on a day: last month from the ready day on, else the month
-- before (banks post a statement a few days after month end). Mirrors src/lib/docs/freshness.ts expectedMonth.
create function app.expected_statement_month(p_today date, p_ready_day int default 5) returns date
language sql immutable security definer set search_path = public, pg_temp as $$
  select (date_trunc('month', p_today) - case when extract(day from p_today) >= p_ready_day then interval '1 month' else interval '2 months' end)::date
$$;
revoke execute on function app.expected_statement_month(date, int) from public;
grant execute on function app.expected_statement_month(date, int) to isaac_app;

-- record_offer (0130) now stamps the approval's expiry: the stated date, else received + the lender's validity.
create or replace function public.record_offer(p_submission uuid, p_offer jsonb)
returns offers
language plpgsql set search_path = public, pg_temp as $$
declare
  s submissions; c clients; cid uuid; o offers; fname text; got date; body text; v_expires date;
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
  v_expires := coalesce(nullif(p_offer->>'expires_on', '')::date, got + app.approval_valid_days(s.funder_id));

  insert into offers (user_id, client_id, submission_id, amount_cents, factor_rate, payment_cents, frequency,
                      term_days, position_no, fees_cents, note, received_on, expires_on)
  values (c.user_id, c.id, s.id, (p_offer->>'amount_cents')::bigint, (p_offer->>'factor_rate')::numeric,
          nullif(p_offer->>'payment_cents', '')::bigint, nullif(p_offer->>'frequency', ''),
          nullif(p_offer->>'term_days', '')::int, nullif(p_offer->>'position_no', '')::int,
          nullif(p_offer->>'fees_cents', '')::bigint, coalesce(p_offer->>'note', ''), got, v_expires)
  returning * into o;

  update timers set done_at = now(), done_reason = 'completed'
   where submission_id = s.id and kind = 'chase' and done_at is null;
  update submissions set status = 'approved', decline_reason = null, decline_note = '',
         status_changed_at = now(), responded_at = coalesce(responded_at, now()),
         approval_expires_on = v_expires
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

-- set_submission_status (0300): an approval with no date gets the lender's validity; leaving the approved states
-- clears the clock. Everything else is unchanged.
create or replace function public.set_submission_status(p_submission uuid, p_status text,
                                             p_decline_reason text default null, p_note text default '')
returns submissions
language plpgsql set search_path = public, pg_temp as $$
declare
  s submissions; c clients; cid uuid; fname text; old_status text; v_valid int;
  v_note text := btrim(coalesce(p_note, ''));
  body text; due date;
begin
  if p_status is null or p_status not in ('sent','stips_requested','approved','revised','declined','no_response','withdrawn',
                                          'contracts_out','contracts_in','funding_call','funded','expired') then
    raise exception 'unknown submission status: %', p_status using errcode = '22023';
  end if;
  if p_decline_reason is not null and p_status <> 'declined' then
    raise exception 'a decline reason only goes with a decline' using errcode = '22023';
  end if;
  if p_decline_reason is not null and not exists (select 1 from decline_reasons where key = p_decline_reason) then
    raise exception 'unknown decline reason: %', p_decline_reason using errcode = '22023';
  end if;
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
  old_status := s.status;
  v_valid := app.approval_valid_days(s.funder_id);

  update timers set done_at = now(), done_reason = 'completed'
   where submission_id = s.id and kind = 'chase' and done_at is null;

  update submissions set
      status = p_status,
      decline_reason = case when p_status = 'declined' then p_decline_reason else null end,
      decline_note = case when p_status = 'declined' then v_note else '' end,
      note = case when p_status <> 'declined' and v_note <> '' then v_note else submissions.note end,
      status_changed_at = now(),
      responded_at = case
        when p_status in ('approved', 'revised', 'declined', 'stips_requested', 'contracts_out', 'contracts_in', 'funding_call', 'funded')
          then coalesce(responded_at, now())
        when p_status = 'sent' and old_status in ('approved', 'declined') then null
        else responded_at end,
      approval_expires_on = case
        when p_status in ('approved', 'revised') then coalesce(approval_expires_on, current_date + v_valid)
        when p_status in ('sent', 'declined', 'withdrawn', 'no_response') then null
        else approval_expires_on end
   where id = s.id returning * into s;

  if p_status in ('declined', 'withdrawn', 'expired') then
    update offers set status = 'expired' where submission_id = s.id and status in ('open', 'presented');
  end if;

  body := fname || case p_status
    when 'sent' then ': waiting for a decision again'
    when 'stips_requested' then ' asked for stips'
    when 'approved' then ' approved'
    when 'revised' then ' sent a revised offer'
    when 'declined' then ' declined'
    when 'no_response' then ': no response'
    when 'contracts_out' then ': contracts out'
    when 'contracts_in' then ': contracts in'
    when 'funding_call' then ': funding call done'
    when 'funded' then ' funded'
    when 'expired' then ': approval expired'
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

-- Nightly: approvals past their date expire (the lender row, its open offers, a timeline line, the rep's alert).
create function public.expire_approvals(p_today date default current_date)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0;
begin
  if app.current_user_id() is not null and not app.can_see_all() then
    raise exception 'only a manager can run the approval clock' using errcode = '22023';
  end if;
  for r in
    select s.id, s.deal_id, s.client_id, s.approval_expires_on, f.name as fname, d.user_id, c.business_name
      from submissions s
      join funders f on f.id = s.funder_id
      join deals d on d.id = s.deal_id
      join clients c on c.id = s.client_id
     where s.status in ('approved', 'revised') and s.approval_expires_on is not null and s.approval_expires_on < p_today
       and d.outcome = 'open'
       and not exists (select 1 from trashed_clients tc where tc.client_id = s.client_id)
     order by s.approval_expires_on
  loop
    perform set_submission_status(r.id, 'expired', null, 'it was good through ' || to_char(r.approval_expires_on, 'FMMon FMDD'));
    insert into user_alerts (user_id, kind, client_id, deal_id, title, body, href, dedupe_key)
    values (r.user_id, 'approval_expired', r.client_id, r.deal_id,
            r.fname || '''s approval of ' || r.business_name || ' expired',
            'It was good through ' || to_char(r.approval_expires_on, 'FMMon FMDD') || '. Ask ' || r.fname || ' to re-approve, or reshop.',
            '/deals/' || r.deal_id, 'approval_expired:' || r.id)
    on conflict do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.expire_approvals(date) from public;
grant execute on function public.expire_approvals(date) to isaac_app;

-- Nightly: the month turned. A merchant with an open deal who is collecting statements gets the unreceived row for
-- the newest month lenders expect (the earliest ready day among the deal's lenders, else the 5th). The checklist
-- trigger (0320) re-buckets them; when that new month is the only statement missing, the "newest statement" bucket
-- says it better than "missing statements", so they are moved there and its reminder goes out.
create function public.request_new_month_statements(p_today date default current_date)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0; want date; b_newest uuid; cur record;
begin
  if app.current_user_id() is not null and not app.can_see_all() then
    raise exception 'only a manager can run the statement clock' using errcode = '22023';
  end if;
  select id into b_newest from buckets where key = 'missing_newest' and active;
  for r in
    select d.id as deal_id, d.client_id, c.user_id, c.business_name,
           coalesce((select min(f.statement_fresh_day) from submissions s join funders f on f.id = s.funder_id where s.deal_id = d.id), 5) as ready_day
      from deals d join clients c on c.id = d.client_id
     where d.outcome = 'open'
       and exists (select 1 from stips st where st.client_id = d.client_id and st.required and st.kind = 'bank_statement')
       and not exists (select 1 from trashed_clients tc where tc.client_id = d.client_id)
     order by d.created_at
  loop
    want := app.expected_statement_month(p_today, r.ready_day);
    insert into stips (user_id, client_id, kind, period, required)
    values (r.user_id, r.client_id, 'bank_statement', want, true)
    on conflict (client_id, kind, coalesce(period, date '0001-01-01')) do nothing;
    if not found then continue; end if;
    n := n + 1;
    insert into activities (user_id, client_id, kind, body)
    values (r.user_id, r.client_id, 'system', 'The month turned: asked for the ' || to_char(want, 'FMMonth YYYY') || ' statement');
    if b_newest is null then continue; end if;
    if exists (select 1 from stips st where st.client_id = r.client_id and st.required and st.received_at is null
                  and (st.kind = 'signed_application' or (st.kind = 'bank_statement' and st.period <> want))) then
      continue;   -- older gaps first: the trigger's bucket already asks for them
    end if;
    select e.bucket_id, b.key into cur from enrollments e join buckets b on b.id = e.bucket_id
     where e.client_id = r.client_id and e.stopped_at is null limit 1;
    if found and cur.key is null then continue; end if;   -- a rep's own bucket is theirs to manage
    if not found or cur.key is distinct from 'missing_newest' then
      perform enroll_in_bucket(r.client_id, b_newest, 'moved');
    end if;
  end loop;
  return n;
end $$;
revoke execute on function public.request_new_month_statements(date) from public;
grant execute on function public.request_new_month_statements(date) to isaac_app;
