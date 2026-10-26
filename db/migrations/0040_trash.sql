-- Trash. "Delete" used to remove a merchant and every note, offer and funded advance in one tap.
-- Now it moves the client to the trash: hidden everywhere, every timer closed (so no reminder can fire),
-- history kept. Restore puts it back with a fresh follow-up. Only "Delete forever" removes data.
--
-- A separate table instead of a column on clients: client_cards expands c.* when created, and a new
-- column would shift its column order. Keeping the column list lets create-or-replace work in place.

create table trashed_clients (
  client_id uuid primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  trashed_at timestamptz not null default now(),
  foreign key (client_id, user_id) references clients (id, user_id) on delete cascade
);
alter table trashed_clients enable row level security;
create policy trashed_clients_owner on trashed_clients for all to isaac_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
grant select, insert, delete on trashed_clients to isaac_app;

-- Same columns, same order as 0002; only the filter is new.
create or replace view client_cards with (security_invoker = true) as
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
) f on true
where not exists (select 1 from trashed_clients tc where tc.client_id = c.id);

create function public.trash_client(p_client uuid)
returns void
language plpgsql set search_path = public, pg_temp as $$
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

-- Back from the trash. The follow-ups the trash closed come back as they were — a funded merchant keeps
-- its renewal call — except ones already past due (they'd land as a wall of overdue) and a booked call
-- (the appointment was cancelled with the client). If nothing is left open, a follow-up in a week
-- (36 months for do-not-contact) keeps the "every client always has a next date" rule.
create function public.restore_client(p_client uuid)
returns void
language plpgsql set search_path = public, pg_temp as $$
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
     and kind <> 'scheduled_call' and due_on >= current_date;
  if not exists (select 1 from timers where client_id = p_client and done_at is null) then
    insert into timers (user_id, client_id, kind, due_on, note)
    values (c.user_id, p_client, 'follow_up',
            case when c.contact_status = 'dnc'
                 then (current_date + interval '36 months')::date
                 else current_date + 7 end,
            case when c.contact_status = 'dnc'
                 then 'Do-not-contact — review this status'
                 else 'Restored from trash — pick the next step' end);
  end if;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Restored from trash');
end $$;

-- Delete forever: only for a client that is already in the trash.
create function public.purge_client(p_client uuid)
returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from trashed_clients where client_id = p_client) then
    raise exception 'client not in the trash' using errcode = 'P0002';
  end if;
  delete from clients where id = p_client;
end $$;
