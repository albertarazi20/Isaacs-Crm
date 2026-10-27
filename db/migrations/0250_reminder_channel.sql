-- A reminder is a booked time plus what to do at it: call, text or email. The booking itself already lives in
-- clients.scheduled_call_at and one open 'scheduled_call' timer; the timer now also remembers the channel.
-- The view is dropped and rebuilt (clients has gained columns since it was made, so it cannot be replaced in place).
alter table timers add column channel text check (channel in ('call','text','email'));

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
  f.defaulted_on, f.last_payment_on, f.promise_to_pay_at, f.promise_amount_cents,
  (select t.channel from timers t where t.client_id = c.id and t.kind = 'scheduled_call' and t.done_at is null
    order by t.created_at desc limit 1) as reminder_channel
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
) f on true
where not exists (select 1 from trashed_clients tc where tc.client_id = c.id);
grant select on client_cards to isaac_app;
