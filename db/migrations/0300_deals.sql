-- Deals. One merchant (clients) can have many deals over time: a first advance, a reshop, a renewal.
-- A deal is born when the rep submits the file to ops; everything a lender says about it hangs off the deal.
-- The existing per-client tables keep working: submissions, offers and fundings get a nullable deal_id, and the
-- SQL functions that create them are left alone (deal_id is stamped by the app layer or by the triggers below).
--
-- Status is derived from the lender rows, never typed by hand, through app.deal_status(). Ops and kickbacks:
--   rep "submit to ops"  → status working_ops (ops_status = 'queued')
--   ops kicks back       → ops_status = 'kicked_back' with a reason (pick-list) → rep fixes → resubmits
--   ops sends to lenders → ops_status = 'sent' and submissions rows appear
--
-- Everyone with a deal in the ops queue needs ops to see it: the deals_ops policy below grants ops read/write on
-- deals that are queued or kicked back, and on the merchant rows behind them (clients_ops, stips_ops).

create table deals (
  id uuid primary key default gen_random_uuid(),
  -- short human id for subject lines: D-1042
  number bigint generated always as identity,
  user_id uuid not null,                        -- the rep who owns it (RLS key, like every table)
  client_id uuid not null,
  kind text not null default 'new' check (kind in ('new', 'reshop', 'renewal', 'add_on')),
  requested_cents bigint check (requested_cents > 0),
  use_of_funds text not null default '',
  -- the ops loop
  ops_status text not null default 'queued'
    check (ops_status in ('queued', 'kicked_back', 'sent', 'closed')),
  ops_owner uuid references app_users (id) on delete set null,
  queued_at timestamptz not null default now(),
  kicked_back_at timestamptz,
  kickback_reason text
    check (kickback_reason in ('unsigned_application', 'missing_statement_month', 'statements_not_newest',
                               'missing_ein_ssn_dob', 'ownership_mismatch', 'illegible_id', 'duplicate_merchant',
                               'wrong_bank_statements', 'other')),
  kickback_note text not null default '',
  kickback_count int not null default 0,
  sent_at timestamptz,
  -- outcome
  outcome text not null default 'open'
    check (outcome in ('open', 'funded', 'declined', 'dead', 'lost')),
  outcome_reason text not null default '',
  closed_at timestamptz,
  -- what blocks the deal right now, written by the app ("Waiting on October statement") — one line, never a novel
  blocker text not null default '',
  rep_note text not null default '',
  manager_note text not null default '',
  ops_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kickback_reason is null or ops_status = 'kicked_back' or kickback_count > 0),
  unique (id, user_id),
  foreign key (client_id, user_id) references clients (id, user_id) on delete cascade
);
create index deals_client_idx on deals (client_id, created_at desc);
create index deals_ops_queue_idx on deals (ops_status, queued_at) where ops_status in ('queued', 'kicked_back');
create index deals_open_idx on deals (user_id, created_at desc) where outcome = 'open';
create trigger deals_touch before update on deals for each row execute function app.touch_updated_at();

-- Lender rows, offers and fundings belong to a deal when one exists.
alter table submissions add column deal_id uuid references deals (id) on delete cascade;
alter table offers add column deal_id uuid references deals (id) on delete cascade;
alter table fundings add column deal_id uuid references deals (id) on delete set null;
create index submissions_deal_idx on submissions (deal_id) where deal_id is not null;
create index offers_deal_idx on offers (deal_id) where deal_id is not null;
create index fundings_deal_idx on fundings (deal_id) where deal_id is not null;

-- A new lender row or offer joins the merchant's open deal automatically, so the existing SQL functions need no change.
create function app.stamp_deal_id() returns trigger
language plpgsql as $$
begin
  if new.deal_id is null then
    select id into new.deal_id from deals
     where client_id = new.client_id and outcome = 'open'
     order by created_at desc limit 1;
  end if;
  return new;
end $$;
create trigger submissions_stamp_deal before insert on submissions for each row execute function app.stamp_deal_id();
create trigger offers_stamp_deal before insert on offers for each row execute function app.stamp_deal_id();
create trigger fundings_stamp_deal before insert on fundings for each row execute function app.stamp_deal_id();

-- Richer lender statuses. The old six stay valid; the new ones are the steps between approved and funded.
alter table submissions drop constraint submissions_status_check;
alter table submissions add constraint submissions_status_check check (status in (
  'sent', 'stips_requested', 'approved', 'revised', 'declined', 'no_response', 'withdrawn',
  'contracts_out', 'contracts_in', 'funding_call', 'funded', 'expired'
));
-- Where a status came from: typed by a person, read from an email, or set by a rule. Every AI update keeps its receipt.
alter table submissions
  add column source text not null default 'manual' check (source in ('manual', 'email', 'rule')),
  add column source_ref text,              -- the email message id the status was read from
  add column approval_expires_on date,     -- per-lender validity clock; null = unknown
  add column last_chased_at timestamptz,
  add column chase_count int not null default 0;

-- A clean decline taxonomy (the old ten stay valid). Each reason carries a "curable after" rule used by Winback.
alter table submissions drop constraint submissions_decline_reason_check;
alter table submissions add constraint submissions_decline_reason_check check (decline_reason is null or decline_reason in (
  -- bank health
  'revenue', 'low_balances', 'negative_days', 'nsfs', 'falling_revenue',
  -- debt load
  'position', 'over_leveraged', 'recently_funded',
  -- business profile
  'time_in_business', 'industry', 'state',
  -- credit / background
  'credit', 'lien', 'bankruptcy',
  -- file integrity
  'stips', 'failed_bv', 'altered_statements',
  -- history
  'prior_default', 'other'
));

create table decline_reasons (
  key text primary key,
  label text not null,
  category text not null check (category in ('bank_health', 'debt_load', 'profile', 'credit', 'file', 'history', 'other')),
  -- days until this reason usually stops applying; null = not curable on a clock
  curable_after_days int,
  sort int not null
);
insert into decline_reasons (key, label, category, curable_after_days, sort) values
  ('revenue', 'Revenue too low', 'bank_health', 90, 10),
  ('falling_revenue', 'Revenue falling', 'bank_health', 90, 11),
  ('low_balances', 'Low daily balances', 'bank_health', 60, 12),
  ('negative_days', 'Too many negative days', 'bank_health', 60, 13),
  ('nsfs', 'Too many NSFs', 'bank_health', 60, 14),
  ('position', 'Too many positions', 'debt_load', 120, 20),
  ('over_leveraged', 'Over-leveraged', 'debt_load', 120, 21),
  ('recently_funded', 'Funded too recently', 'debt_load', 90, 22),
  ('time_in_business', 'Time in business', 'profile', 180, 30),
  ('industry', 'Restricted industry', 'profile', null, 31),
  ('state', 'Restricted state', 'profile', null, 32),
  ('credit', 'Credit', 'credit', 180, 40),
  ('lien', 'Tax lien', 'credit', 180, 41),
  ('bankruptcy', 'Bankruptcy', 'credit', 365, 42),
  ('stips', 'Stips never came in', 'file', 14, 50),
  ('failed_bv', 'Failed bank verification', 'file', 30, 51),
  ('altered_statements', 'Suspected altered statements', 'file', null, 52),
  ('prior_default', 'Prior default', 'history', 365, 60),
  ('other', 'Other', 'other', null, 99);
grant select on decline_reasons to isaac_app;
alter table decline_reasons enable row level security;
create policy decline_reasons_read on decline_reasons for select to isaac_app using (true);

-- Deal status, derived from the lender rows and the ops loop. One definition, used by every filter and the dashboard.
create function app.deal_status(d deals) returns text
language sql stable set search_path = public, pg_temp as $$
  select case
    when d.outcome = 'funded' then 'funded'
    when d.outcome in ('declined', 'dead', 'lost') then d.outcome
    when d.ops_status = 'queued' then 'working_ops'
    when d.ops_status = 'kicked_back' then 'kicked_back'
    when exists (select 1 from submissions s where s.deal_id = d.id and s.status = 'funding_call') then 'funding_call'
    when exists (select 1 from submissions s where s.deal_id = d.id and s.status = 'contracts_in') then 'contracts_in'
    when exists (select 1 from submissions s where s.deal_id = d.id and s.status = 'contracts_out') then 'contracts_out'
    when exists (select 1 from submissions s where s.deal_id = d.id and s.status in ('approved', 'revised')) then
      case when exists (select 1 from offers o where o.deal_id = d.id and o.status in ('presented', 'accepted'))
           then 'pitched' else 'needs_pitch' end
    when exists (select 1 from submissions s where s.deal_id = d.id and s.status = 'stips_requested') then 'stips_needed'
    when exists (select 1 from submissions s where s.deal_id = d.id and s.status in ('sent')) then 'pending_lenders'
    when exists (select 1 from submissions s where s.deal_id = d.id)
         and not exists (select 1 from submissions s where s.deal_id = d.id and s.status not in ('declined', 'withdrawn', 'expired', 'no_response'))
      then 'declined_by_all'
    else 'working'
  end
$$;

grant select, insert, update, delete on deals to isaac_app;

-- RLS: reps own their deals; managers see all (team policy); ops see what is in their queue plus the merchant behind it.
alter table deals enable row level security;
create policy deals_owner on deals for all to isaac_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy deals_team on deals for all to isaac_app
  using (app.can_see_all()) with check (app.can_see_all());
create policy deals_ops on deals for all to isaac_app
  using (app.current_role() = 'ops' and ops_status in ('queued', 'kicked_back', 'sent'))
  with check (app.current_role() = 'ops');

create function app.is_ops_deal(p_client uuid) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select app.current_role() = 'ops'
     and exists (select 1 from deals d where d.client_id = p_client and d.ops_status in ('queued', 'kicked_back', 'sent'))
$$;
-- Ops reach the merchant, its stips, documents-to-be and lender rows through the deal, read and write, but never
-- commission figures (fundings stay rep + manager only).
create policy clients_ops on clients for all to isaac_app using (app.is_ops_deal(id)) with check (app.is_ops_deal(id));
create policy stips_ops on stips for all to isaac_app using (app.is_ops_deal(client_id)) with check (app.is_ops_deal(client_id));
create policy submissions_ops on submissions for all to isaac_app using (app.is_ops_deal(client_id)) with check (app.is_ops_deal(client_id));
create policy offers_ops on offers for select to isaac_app using (app.is_ops_deal(client_id));
create policy activities_ops_select on activities for select to isaac_app using (app.is_ops_deal(client_id));
create policy activities_ops_insert on activities for insert to isaac_app with check (app.is_ops_deal(client_id));
create policy client_asks_ops on client_asks for select to isaac_app using (app.is_ops_deal(client_id));
create policy positions_ops on positions for select to isaac_app using (app.is_ops_deal(client_id));
create policy timers_ops on timers for select to isaac_app using (app.is_ops_deal(client_id));
-- The lender list is shared across the shop: anyone may send a merchant to any lender on file, and ops see them all.
-- The composite (funder_id, user_id) key assumed one lender list per user; a plain key on the lender row replaces it.
do $$
declare k text;
begin
  -- the composite key's name is generated and differs between a fresh migrate and the live database
  select conname into k from pg_constraint
   where conrelid = 'submissions'::regclass and contype = 'f' and confrelid = 'funders'::regclass;
  if k is not null then execute format('alter table submissions drop constraint %I', k); end if;
end $$;
alter table submissions add constraint submissions_funder_id_fkey foreign key (funder_id) references funders (id) on delete restrict;
create policy funders_shared_read on funders for select to isaac_app using (true);

-- The deal lifecycle in SQL, so it is the same from a page, a job or the email reader.

-- Rep (or manager) submits the file to ops. One open deal per merchant at a time.
create function public.submit_to_ops(p_client uuid, p_kind text default 'new', p_requested bigint default null,
                                     p_use_of_funds text default '', p_note text default '')
returns deals
language plpgsql set search_path = public, pg_temp as $$
declare c clients; d deals;
begin
  select * into c from clients where id = p_client for update;
  if not found then raise exception 'client not found' using errcode = 'P0002'; end if;
  select * into d from deals where client_id = p_client and outcome = 'open' for update;
  if found then
    if d.ops_status = 'kicked_back' then
      update deals set ops_status = 'queued', queued_at = now(), rep_note = coalesce(nullif(btrim(p_note), ''), rep_note),
                       blocker = '' where id = d.id returning * into d;
      insert into activities (user_id, client_id, kind, body) values (c.user_id, c.id, 'system', 'Resubmitted to ops');
      return d;
    end if;
    raise exception 'This merchant already has an open deal (%)', app.deal_status(d) using errcode = '22023';
  end if;
  insert into deals (user_id, client_id, kind, requested_cents, use_of_funds, rep_note)
  values (c.user_id, c.id, p_kind, p_requested, btrim(coalesce(p_use_of_funds, '')), btrim(coalesce(p_note, '')))
  returning * into d;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, c.id, 'system', 'Submitted to ops as deal D-' || d.number);
  if c.stage in ('name_in', 'spoke_with_owner', 'interested', 'call_scheduled', 'application_sent') then
    -- move_client needs a next date: ops answers within a business day, so the rep checks back then
    perform move_client(c.id, 'application_in',
      jsonb_build_array(jsonb_build_object('kind', 'follow_up', 'due_on', (current_date + 1)::text, 'note', 'Ops is reviewing the file')),
      'Submitted to ops');
  end if;
  return d;
end $$;

-- Ops kicks a file back to the rep with a reason from the pick-list.
create function public.kick_back_deal(p_deal uuid, p_reason text, p_note text default '')
returns deals
language plpgsql set search_path = public, pg_temp as $$
declare d deals;
begin
  select * into d from deals where id = p_deal for update;
  if not found then raise exception 'deal not found' using errcode = 'P0002'; end if;
  if d.ops_status not in ('queued', 'sent') then
    raise exception 'only a queued deal can be kicked back' using errcode = '22023';
  end if;
  update deals set ops_status = 'kicked_back', kicked_back_at = now(), kickback_reason = p_reason,
                   kickback_note = btrim(coalesce(p_note, '')), kickback_count = kickback_count + 1,
                   ops_owner = coalesce(ops_owner, app.current_user_id()),
                   blocker = 'Kicked back by ops: ' || replace(p_reason, '_', ' ')
   where id = d.id returning * into d;
  insert into activities (user_id, client_id, kind, body)
  values (d.user_id, d.client_id, 'system',
          'Ops kicked back: ' || replace(p_reason, '_', ' ') || case when btrim(coalesce(p_note, '')) <> '' then ' — ' || btrim(p_note) else '' end);
  return d;
end $$;

-- Ops (or a manager) claims the file and marks it sent once the lender rows exist.
create function public.mark_deal_sent(p_deal uuid)
returns deals
language plpgsql set search_path = public, pg_temp as $$
declare d deals;
begin
  select * into d from deals where id = p_deal for update;
  if not found then raise exception 'deal not found' using errcode = 'P0002'; end if;
  update deals set ops_status = 'sent', sent_at = coalesce(sent_at, now()), ops_owner = coalesce(ops_owner, app.current_user_id()), blocker = ''
   where id = d.id returning * into d;
  return d;
end $$;

-- Close a deal with an outcome. Funded is set by the FUND flow; the rest by a person or a rule.
create function public.close_deal(p_deal uuid, p_outcome text, p_reason text default '')
returns deals
language plpgsql set search_path = public, pg_temp as $$
declare d deals;
begin
  if p_outcome not in ('funded', 'declined', 'dead', 'lost') then
    raise exception 'unknown outcome: %', p_outcome using errcode = '22023';
  end if;
  select * into d from deals where id = p_deal for update;
  if not found then raise exception 'deal not found' using errcode = 'P0002'; end if;
  update deals set outcome = p_outcome, outcome_reason = btrim(coalesce(p_reason, '')), closed_at = now(),
                   ops_status = 'closed', blocker = ''
   where id = d.id returning * into d;
  insert into activities (user_id, client_id, kind, body)
  values (d.user_id, d.client_id, 'system', 'Deal D-' || d.number || ' ' || p_outcome ||
          case when btrim(coalesce(p_reason, '')) <> '' then ': ' || btrim(p_reason) else '' end);
  return d;
end $$;

-- Existing merchants in the pipeline get a deal so nothing is orphaned (one per merchant with lender rows or an offer).
insert into deals (user_id, client_id, kind, ops_status, queued_at, sent_at, outcome, closed_at)
select c.user_id, c.id, 'new',
       case when c.stage in ('funded','paying_off_soon','paid_in_full','declined','lost','killed','dead') then 'closed' else 'sent' end,
       c.stage_changed_at, c.stage_changed_at,
       case c.stage when 'funded' then 'funded' when 'paying_off_soon' then 'funded' when 'paid_in_full' then 'funded'
                    when 'declined' then 'declined' when 'lost' then 'lost' when 'killed' then 'dead' when 'dead' then 'dead'
                    else 'open' end,
       case when c.stage in ('funded','paying_off_soon','paid_in_full','declined','lost','killed','dead') then c.stage_changed_at end
  from clients c
 where exists (select 1 from submissions s where s.client_id = c.id)
    or exists (select 1 from fundings f where f.client_id = c.id);
update submissions s set deal_id = d.id from deals d where d.client_id = s.client_id and s.deal_id is null;
update offers o set deal_id = d.id from deals d where d.client_id = o.client_id and o.deal_id is null;
update fundings f set deal_id = d.id from deals d where d.client_id = f.client_id and f.deal_id is null;

-- set_submission_status validated reasons against a list in its body; it now reads the decline_reasons table,
-- so a new reason is a row, not a migration of the function. Everything else in it is unchanged (0130).
create or replace function public.set_submission_status(p_submission uuid, p_status text,
                                             p_decline_reason text default null, p_note text default '')
returns submissions
language plpgsql set search_path = public, pg_temp as $$
declare
  s submissions; c clients; cid uuid; fname text; old_status text;
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
        else responded_at end
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
