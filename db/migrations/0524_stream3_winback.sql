-- Stream 3 win-back (docs/AUTOMATION-AUDIT.md S3-11): the "why didn't it fund" pick-list on a member, the first line
-- Claude drafts per merchant (auto or review mode, see shop_settings.winback_opener_mode in 0520), and the rescue
-- nudges on days 20, 25 and 29 of a live approval, recorded once per deal per day so a re-run never doubles one.
-- The job that sends is src/lib/money/winback.ts; recovered money per pool and per template is a query there too.

create table winback_reasons (
  key text primary key,
  label text not null,
  sort int not null
);
insert into winback_reasons (key, label, sort) values
  ('terms',              'Terms were too high',             10),
  ('took_another_offer', 'Took another lender''s offer',    20),
  ('no_longer_needed',   'Did not need the money',          30),
  ('went_quiet',         'Stopped answering',               40),
  ('docs_never_came',    'Documents never came in',         50),
  ('lender_pulled',      'Lender pulled the approval',      60),
  ('bad_timing',         'Bad timing',                      70),
  ('other',              'Other',                           99);
grant select on winback_reasons to isaac_app;
alter table winback_reasons enable row level security;
create policy winback_reasons_read on winback_reasons for select to isaac_app using (true);

alter table winback_members
  add column why_not_funded text references winback_reasons (key),
  add column why_note text not null default '',
  -- the one line Claude writes for this merchant, merged into the step as {opener}
  add column opener text not null default '' check (length(opener) <= 300),
  add column opener_status text not null default 'none' check (opener_status in ('none', 'drafted', 'approved', 'rejected')),
  add column opener_model text,
  add column opener_drafted_at timestamptz;

-- The rep (or a manager) says why the deal never funded. The pool's reason stays; this is the pick-list answer.
create function public.set_winback_reason(p_member uuid, p_reason text, p_note text default '')
returns winback_members
language plpgsql security definer set search_path = public, pg_temp as $$
declare m winback_members; me uuid := app.current_user_id();
begin
  if not exists (select 1 from winback_reasons where key = p_reason) then
    raise exception 'unknown reason: %', p_reason using errcode = '22023';
  end if;
  select * into m from winback_members where id = p_member for update;
  if not found then raise exception 'win-back member not found' using errcode = 'P0002'; end if;
  if me is not null and not (m.user_id = me or app.can_see_all()) then
    raise exception 'that merchant is not yours' using errcode = '22023';
  end if;
  update winback_members set why_not_funded = p_reason, why_note = left(btrim(coalesce(p_note, '')), 300)
   where id = m.id returning * into m;
  insert into activities (user_id, client_id, kind, body)
  values (m.user_id, m.client_id, 'system', 'Why it did not fund: ' || (select label from winback_reasons where key = p_reason) ||
          case when btrim(coalesce(p_note, '')) <> '' then ' — ' || left(btrim(p_note), 300) else '' end);
  return m;
end $$;
revoke execute on function public.set_winback_reason(uuid, text, text) from public;
grant execute on function public.set_winback_reason(uuid, text, text) to isaac_app;

-- Review mode: a manager approves (possibly after editing) or rejects the drafted line.
create function public.review_winback_opener(p_member uuid, p_text text, p_approve boolean)
returns winback_members
language plpgsql security definer set search_path = public, pg_temp as $$
declare m winback_members;
begin
  if not app.can_see_all() then raise exception 'only a manager can approve a win-back opener' using errcode = '22023'; end if;
  select * into m from winback_members where id = p_member for update;
  if not found then raise exception 'win-back member not found' using errcode = 'P0002'; end if;
  if p_approve and btrim(coalesce(p_text, '')) = '' then raise exception 'the opener is empty' using errcode = '22023'; end if;
  update winback_members
     set opener = case when p_approve then left(btrim(p_text), 300) else opener end,
         opener_status = case when p_approve then 'approved' else 'rejected' end,
         opener_drafted_at = coalesce(opener_drafted_at, now())
   where id = m.id returning * into m;
  return m;
end $$;
revoke execute on function public.review_winback_opener(uuid, text, boolean) from public;
grant execute on function public.review_winback_opener(uuid, text, boolean) to isaac_app;

-- Rescue nudges while an approval is live: one row per deal per day (20, 25, 29).
create table rescue_nudges (
  id bigint generated always as identity primary key,
  deal_id uuid not null references deals (id) on delete cascade,
  user_id uuid not null references app_users (id) on delete cascade,
  client_id uuid not null references clients (id) on delete cascade,
  day int not null check (day in (20, 25, 29)),
  outbox_id uuid references outbox (id) on delete set null,
  sent_at timestamptz not null default now(),
  unique (deal_id, day)
);
grant select on rescue_nudges to isaac_app;
alter table rescue_nudges enable row level security;
create policy rescue_nudges_owner on rescue_nudges for select to isaac_app using (user_id = app.current_user_id());
create policy rescue_nudges_team on rescue_nudges for select to isaac_app using (app.can_see_all());

-- A member whose sequence finished (or who replied, funded or opted out) stays finished. 0350's refresh only skipped
-- live members, so the night after a sequence ended the merchant was enrolled again, for every pool, forever (found
-- by stream 1, which closed it for the Cold pool with a trigger). Each membership now remembers the row that caused
-- it — the approval, the declined deal, the competing offer, the paid-off funding, the Cold enrolment — and the same
-- cause never enrols the same merchant in the same pool twice. A new approval or a new payoff is a new cause.
alter table winback_members add column source_id uuid;
create index winback_members_source_idx on winback_members (client_id, pool, source_id);

create or replace function public.refresh_winback_pools()
returns table (added int)
language plpgsql set search_path = public, pg_temp as $$
declare n int; k int;
begin
  -- 1. approved, not funded, 30+ days since the approval, deal still open (the cause: that approval)
  insert into winback_members (user_id, client_id, deal_id, pool, reason, workable_on, source_id)
  select d.user_id, d.client_id, d.id, 'approved_unfunded', 'Approved ' || app.fmt_money(o.amount_cents) || ' by ' || f.name || ' on ' || s.responded_at::date,
         (s.responded_at::date + 30), s.id
    from deals d join submissions s on s.deal_id = d.id join funders f on f.id = s.funder_id
    join lateral (select amount_cents from offers o where o.submission_id = s.id order by created_at desc limit 1) o on true
   where d.outcome = 'open' and s.status in ('approved', 'revised') and s.responded_at < now() - interval '30 days'
     and not exists (select 1 from winback_members w where w.client_id = d.client_id and w.pool = 'approved_unfunded'
                       and (w.status in ('waiting', 'active') or w.source_id = s.id or w.source_id is null))
     and not exists (select 1 from clients c where c.id = d.client_id and (c.contact_status <> 'ok' or c.email_opt_out))
  on conflict do nothing;
  get diagnostics n = row_count;
  -- 2. declined by every lender for a curable reason: workable when the cure period passes (the cause: that deal)
  insert into winback_members (user_id, client_id, deal_id, pool, reason, workable_on, source_id)
  select d.user_id, d.client_id, d.id, 'declined_curable', 'Declined: ' || r.label, (s.status_changed_at::date + r.curable_after_days), d.id
    from deals d join submissions s on s.deal_id = d.id join decline_reasons r on r.key = s.decline_reason
   where d.outcome in ('declined', 'open') and app.deal_status(d) in ('declined_by_all', 'declined') and r.curable_after_days is not null
     and not exists (select 1 from winback_members w where w.client_id = d.client_id and w.pool = 'declined_curable'
                       and (w.status in ('waiting', 'active') or w.source_id = d.id or w.source_id is null))
     and not exists (select 1 from clients c where c.id = d.client_id and (c.contact_status <> 'ok' or c.email_opt_out))
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;
  -- 3. lost to another lender: back when that advance should be about half paid (the cause: that offer, else the loss itself)
  insert into winback_members (user_id, client_id, deal_id, pool, reason, workable_on, source_id)
  select c.user_id, c.id, null, 'funded_elsewhere', 'Took ' || coalesce(co.funder_name, 'another offer'),
         coalesce(co.offered_on, c.stage_changed_at::date) + coalesce(co.term_days, 180) / 2, coalesce(co.id, c.id)
    from clients c left join lateral (select * from competing_offers x where x.client_id = c.id and x.won order by offered_on desc limit 1) co on true
   where c.stage = 'lost' and c.contact_status = 'ok' and not c.email_opt_out
     and not exists (select 1 from winback_members w where w.client_id = c.id and w.pool = 'funded_elsewhere'
                       and (w.status in ('waiting', 'active') or w.source_id = coalesce(co.id, c.id) or w.source_id is null))
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;
  -- 4. paid off: the hottest lead the shop owns (the cause: that funding)
  insert into winback_members (user_id, client_id, deal_id, pool, reason, workable_on, source_id)
  select f.user_id, f.client_id, f.deal_id, 'paid_off', 'Paid off ' || f.funder_name, current_date, f.id
    from fundings f join clients c on c.id = f.client_id
   where f.status = 'paid_off' and c.contact_status = 'ok' and not c.email_opt_out
     and not exists (select 1 from fundings g where g.client_id = f.client_id and g.status = 'active')
     and not exists (select 1 from winback_members w where w.client_id = f.client_id and w.pool = 'paid_off'
                       and (w.status in ('waiting', 'active') or w.source_id = f.id or w.source_id is null))
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;
  -- 5. cold: a sequence ran dry (the Cold bucket; the cause: that enrolment)
  insert into winback_members (user_id, client_id, deal_id, pool, reason, workable_on, source_id)
  select e.user_id, e.client_id, null, 'cold', 'No reply to the follow-up sequence', current_date, e.id
    from enrollments e join buckets b on b.id = e.bucket_id
   where b.key = 'cold' and e.stopped_at is null
     and not exists (select 1 from winback_members w where w.client_id = e.client_id and w.pool = 'cold'
                       and (w.status in ('waiting', 'active') or w.source_id = e.id or w.source_id is null))
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;
  -- waiting → active once workable
  update winback_members set status = 'active', next_due_on = workable_on where status = 'waiting' and workable_on <= current_date;
  -- a funded deal, a reply, or an opt-out ends membership
  update winback_members w set status = 'recovered', stop_reason = 'funded'
   where w.status in ('waiting', 'active') and exists (select 1 from fundings f where f.client_id = w.client_id and f.funded_on >= w.created_at::date);
  update winback_members w set status = 'stopped', stop_reason = 'opted_out'
   where w.status in ('waiting', 'active') and exists (select 1 from clients c where c.id = w.client_id and (c.email_opt_out or c.contact_status <> 'ok'));
  return query select n;
end $$;
