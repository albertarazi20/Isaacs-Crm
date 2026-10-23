-- Do-not-contact. A merchant who says "stop" must never get another call, text, email or reminder.
-- Texting from a personal number has consent rules (TCPA and state mini-TCPAs): this is the switch.

alter table clients
  add column contact_status text not null default 'ok'
    check (contact_status in ('ok', 'no_text', 'no_call', 'no_email', 'dnc')),
  add column contact_status_note text not null default '',
  add column contact_status_at timestamptz;

-- The card view expands c.* when it is created, so it has to be recreated to see the new columns.
drop view client_cards;

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
) f on true;;

grant select on client_cards to isaac_app;

-- Set how this merchant may be contacted. "dnc" closes every timer and booked call, then leaves ONE
-- far-out review timer so the invariant holds (a client always has a next date) — and Today, the
-- board's call buttons and every reminder skip them.
create function public.set_contact_status(p_client uuid, p_status text, p_note text default '')
returns clients
language plpgsql set search_path = public, pg_temp as $$
declare c clients; label text;
begin
  if p_status not in ('ok', 'no_text', 'no_call', 'no_email', 'dnc') then
    raise exception 'unknown contact status: %', p_status using errcode = '22023';
  end if;
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  update clients
     set contact_status = p_status, contact_status_note = coalesce(p_note, ''), contact_status_at = now()
   where id = p_client returning * into c;
  if p_status = 'dnc' then
    update timers set done_at = now(), done_reason = 'cancelled' where client_id = p_client and done_at is null;
    update clients set scheduled_call_at = null where id = p_client returning * into c;
    insert into timers (user_id, client_id, kind, due_on, note)
    values (c.user_id, p_client, 'follow_up', (current_date + interval '36 months')::date, 'Do-not-contact — review this status');
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
