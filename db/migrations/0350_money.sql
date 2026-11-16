-- Money: FUND with guardrails, a commission ledger with clawback states, per-lender terms, renewals, win-back pools.
--   funders        — gains the per-lender facts every clock reads: max upsell, PSF cap, clawback days, approval validity,
--                    statement freshness rule, commission pay timing.
--   fundings       — gains the sell/buy rate, points, PSF, the rep's cut, confirmation, and the ledger state.
--   commission_ledger — append-only lines per funding: expected, paid, at risk, clear, clawed back, correction.
--   commission_plans  — per rep with effective dates: split, tiers, PSF share, renewal rate, manager override.
--   winback_pools / winback_members — the pools Winback works (approved-not-funded 30+, declined-curable, funded-elsewhere,
--                    paid-off, cold) with the date each member becomes workable and the reason.
--   state_rules       — the compliance table the FUND checklist and templates read (editable; seeded with what research found).

alter table funders
  add column max_upsell_points numeric(5,2) check (max_upsell_points is null or (max_upsell_points >= 0 and max_upsell_points <= 100)),
  add column psf_cap_pct numeric(5,2) check (psf_cap_pct is null or (psf_cap_pct >= 0 and psf_cap_pct <= 100)),
  add column clawback_days int not null default 30 check (clawback_days between 0 and 365),
  add column approval_valid_days int not null default 30 check (approval_valid_days between 1 and 365),
  add column statement_fresh_day int not null default 5 check (statement_fresh_day between 1 and 28),
  add column commission_paid_after_days int not null default 7 check (commission_paid_after_days between 0 and 120),
  add column renewal_commission_basis text not null default 'new_money' check (renewal_commission_basis in ('full', 'new_money'));

alter table fundings
  add column sell_rate numeric(5,3),
  add column buy_rate numeric(5,3) check (buy_rate is null or (buy_rate >= 1 and buy_rate <= 3)),
  add column points numeric(5,2) check (points is null or points >= 0),
  add column psf_cents bigint not null default 0 check (psf_cents >= 0),
  add column psf_collected_at text not null default 'at_closing' check (psf_collected_at in ('at_closing', 'from_proceeds', 'none')),
  add column rep_cut_cents bigint,
  add column house_cut_cents bigint,
  add column funder_id uuid references funders (id) on delete set null,
  add column proposed_by uuid references app_users (id) on delete set null,
  add column confirmed_by uuid references app_users (id) on delete set null,
  add column confirmed_at timestamptz,
  add column ledger_state text not null default 'expected'
    check (ledger_state in ('expected', 'paid', 'at_risk', 'clear', 'clawed_back')),
  add column clawback_until date,
  add column renewal_eligible_on date,
  add column renewal_warm_on date;

create table commission_ledger (
  id bigint generated always as identity primary key,
  funding_id uuid not null references fundings (id) on delete cascade,
  user_id uuid not null references app_users (id) on delete cascade,   -- the rep (RLS key)
  kind text not null check (kind in ('expected', 'paid', 'correction', 'clawback', 'clear', 'draw', 'draw_repaid', 'override')),
  gross_cents bigint not null,
  rep_cents bigint not null,
  house_cents bigint not null,
  note text not null default '',
  -- which pay period it lands in (first of the month)
  period date not null default date_trunc('month', current_date)::date,
  created_by uuid references app_users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index commission_ledger_funding_idx on commission_ledger (funding_id, created_at);
create index commission_ledger_user_period_idx on commission_ledger (user_id, period);
-- Lines are written only by the SQL functions above (confirm_funding, record_commission_paid, the clawback trigger);
-- the insert policy mirrors who may call them: the owning rep's rows, or a manager.
grant select, insert on commission_ledger to isaac_app;
alter table commission_ledger enable row level security;
create policy commission_ledger_owner on commission_ledger for select to isaac_app using (user_id = app.current_user_id());
create policy commission_ledger_team on commission_ledger for select to isaac_app using (app.can_see_all());
create policy commission_ledger_insert on commission_ledger for insert to isaac_app
  with check (user_id = app.current_user_id() or app.can_see_all());

create table commission_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references app_users (id) on delete cascade,     -- null = the shop default
  effective_from date not null default current_date,
  split_pct numeric(5,2) not null default 50 check (split_pct between 0 and 100),
  self_gen_split_pct numeric(5,2) check (self_gen_split_pct is null or (self_gen_split_pct between 0 and 100)),
  psf_share_pct numeric(5,2) not null default 0 check (psf_share_pct between 0 and 100),
  renewal_split_pct numeric(5,2) check (renewal_split_pct is null or (renewal_split_pct between 0 and 100)),
  -- tiers: [{"from_cents": 0, "split_pct": 50}, {"from_cents": 50000000, "split_pct": 60}] by funded volume in the month
  tiers jsonb not null default '[]'::jsonb,
  manager_override_pct numeric(5,2) not null default 0 check (manager_override_pct between 0 and 100),
  clawback_borne_by text not null default 'rep' check (clawback_borne_by in ('rep', 'house', 'split')),
  note text not null default '',
  created_at timestamptz not null default now()
);
create index commission_plans_user_idx on commission_plans (user_id, effective_from desc);
insert into commission_plans (user_id, split_pct) values (null, 50);
grant select, insert, update, delete on commission_plans to isaac_app;
alter table commission_plans enable row level security;
create policy commission_plans_read on commission_plans for select to isaac_app using (user_id is null or user_id = app.current_user_id() or app.can_see_all());
create policy commission_plans_manager on commission_plans for all to isaac_app using (app.can_see_all()) with check (app.can_see_all());

-- The plan that applies to a rep on a date: their own newest, else the shop default.
create function app.plan_for(p_user uuid, p_on date) returns commission_plans
language sql stable set search_path = public, pg_temp as $$
  select * from commission_plans
   where (user_id = p_user or user_id is null) and effective_from <= p_on
   order by (user_id is not null) desc, effective_from desc limit 1
$$;

-- Points of a funding: sell minus buy when both are known, else the entered points, else the lender's commission points.
create function app.points_of(f fundings) returns numeric
language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    case when f.sell_rate is not null and f.buy_rate is not null then round((f.sell_rate - f.buy_rate) * 100, 2) end,
    f.points,
    (select commission_points from funders where id = f.funder_id),
    case when f.commission_cents is not null and f.amount_cents > 0 then round(f.commission_cents::numeric / f.amount_cents * 100, 2) end)
$$;

-- The split that applies, with monthly tiers by the rep's funded volume that month.
create function app.split_for(p_user uuid, p_on date, p_lead_source text) returns numeric
language plpgsql stable set search_path = public, pg_temp as $$
declare p commission_plans; vol bigint; t jsonb; best numeric;
begin
  p := app.plan_for(p_user, p_on);
  if p.id is null then return 50; end if;
  best := case when p_lead_source in ('own_form', 'referral') and p.self_gen_split_pct is not null then p.self_gen_split_pct else p.split_pct end;
  select coalesce(sum(amount_cents), 0) into vol from fundings
   where user_id = p_user and date_trunc('month', funded_on) = date_trunc('month', p_on) and confirmed_at is not null;
  for t in select * from jsonb_array_elements(p.tiers) loop
    if vol >= (t->>'from_cents')::bigint then best := greatest(best, (t->>'split_pct')::numeric); end if;
  end loop;
  return best;
end $$;

-- FUND: the rep proposes terms; a manager confirms; only then does commission post. Guardrails: points above the
-- lender's max upsell or a PSF above its cap are refused; the lender row and the deal close as funded.
create function public.propose_funding(p_client uuid, p_terms jsonb)
returns fundings
language plpgsql set search_path = public, pg_temp as $$
declare c clients; d deals; f fundings; fd funders; v_points numeric; v_amount bigint; v_psf bigint; v_sell numeric; v_buy numeric; tmr jsonb;
begin
  select * into c from clients where id = p_client for update;
  if not found then raise exception 'client not found' using errcode = 'P0002'; end if;
  select * into d from deals where client_id = p_client and outcome = 'open' order by created_at desc limit 1 for update;
  v_amount := (p_terms->>'amount_cents')::bigint;
  v_sell := nullif(p_terms->>'sell_rate', '')::numeric;
  v_buy := nullif(p_terms->>'buy_rate', '')::numeric;
  v_psf := coalesce(nullif(p_terms->>'psf_cents', '')::bigint, 0);
  v_points := coalesce(nullif(p_terms->>'points', '')::numeric,
                       case when v_sell is not null and v_buy is not null then round((v_sell - v_buy) * 100, 2) end);
  if (p_terms->>'funder_id') is not null then
    select * into fd from funders where id = (p_terms->>'funder_id')::uuid;
    if fd.max_upsell_points is not null and v_points is not null and v_points > fd.max_upsell_points then
      raise exception '% caps points at % — you entered %', fd.name, fd.max_upsell_points, v_points using errcode = '22023';
    end if;
    if fd.psf_cap_pct is not null and v_amount > 0 and v_psf * 100.0 / v_amount > fd.psf_cap_pct then
      raise exception '% caps the PSF at %%% of the advance', fd.name, fd.psf_cap_pct using errcode = '22023';
    end if;
  end if;
  if v_psf > 0 and (p_terms->>'psf_collected_at') = 'before_closing' then
    raise exception 'A PSF cannot be collected before closing' using errcode = '22023';
  end if;
  -- the existing record_funding writes the row, timers and stage move; then the new columns are filled in
  tmr := coalesce(p_terms->'timers', '[]'::jsonb);
  select * into f from record_funding(p_client, jsonb_build_object(
    'funded_on', coalesce(p_terms->>'funded_on', current_date::text),
    'funder_name', coalesce(fd.name, p_terms->>'funder_name', ''),
    'amount_cents', v_amount,
    'factor_rate', coalesce(v_sell, (p_terms->>'factor_rate')::numeric),
    'payment_cents', (p_terms->>'payment_cents')::bigint,
    'frequency', p_terms->>'frequency',
    'position_no', coalesce((p_terms->>'position_no')::int, 1),
    'term_days', nullif(p_terms->>'term_days', '')::int,
    'commission_cents', case when v_points is not null then round(v_amount * v_points / 100)::bigint + v_psf end,
    'note', coalesce(p_terms->>'note', '')), tmr);
  update fundings set
      sell_rate = coalesce(v_sell, factor_rate), buy_rate = v_buy, points = v_points, psf_cents = v_psf,
      psf_collected_at = coalesce(nullif(p_terms->>'psf_collected_at', ''), 'at_closing'),
      funder_id = fd.id, deal_id = d.id, proposed_by = app.current_user_id(),
      clawback_until = funded_on + coalesce(fd.clawback_days, 30),
      renewal_warm_on = app.paydown_date(amount_cents, factor_rate, payment_cents, frequency, funded_on, 40),
      renewal_eligible_on = app.paydown_date(amount_cents, factor_rate, payment_cents, frequency, funded_on, coalesce(fd.renewal_paydown_pct, 50))
   where id = f.id returning * into f;
  return f;
end $$;

-- The day a schedule crosses pct% paid: business days for daily, else calendar steps.
create function app.paydown_date(p_amount bigint, p_factor numeric, p_payment bigint, p_freq text, p_funded date, p_pct numeric)
returns date
language plpgsql immutable as $$
declare payback numeric; n int; d date; i int := 0;
begin
  if p_payment is null or p_payment <= 0 then return null; end if;
  payback := p_amount * p_factor;
  n := ceil((p_pct / 100.0) * payback / p_payment);
  if p_freq = 'daily' then
    d := p_funded;
    while i < n loop
      d := d + 1;
      if extract(isodow from d) < 6 then i := i + 1; end if;
    end loop;
    return d;
  elsif p_freq = 'weekly' then return p_funded + 7 * n;
  elsif p_freq = 'biweekly' then return p_funded + 14 * n;
  else return (p_funded + (n || ' months')::interval)::date;
  end if;
end $$;

-- Manager confirms: the terms freeze, the ledger gets its expected line, the lender row and deal close as funded,
-- and the merchant leaves every chase.
create function public.confirm_funding(p_funding uuid)
returns fundings
language plpgsql set search_path = public, pg_temp as $$
declare f fundings; c clients; p commission_plans; split numeric; gross bigint; rep bigint; house bigint; sub uuid;
begin
  if not app.can_see_all() then raise exception 'only a manager can confirm a funding' using errcode = '22023'; end if;
  select * into f from fundings where id = p_funding for update;
  if not found then raise exception 'funding not found' using errcode = 'P0002'; end if;
  if f.confirmed_at is not null then return f; end if;
  select * into c from clients where id = f.client_id;
  gross := coalesce(f.commission_cents, 0);
  split := app.split_for(f.user_id, f.funded_on, c.lead_source_kind);
  p := app.plan_for(f.user_id, f.funded_on);
  rep := round(gross * split / 100) + round(f.psf_cents * coalesce(p.psf_share_pct, 0) / 100);
  house := gross - rep;
  update fundings set confirmed_by = app.current_user_id(), confirmed_at = now(), rep_cut_cents = rep, house_cut_cents = house,
                      ledger_state = 'at_risk'
   where id = f.id returning * into f;
  insert into commission_ledger (funding_id, user_id, kind, gross_cents, rep_cents, house_cents, note, period, created_by)
  values (f.id, f.user_id, 'expected', gross, rep, house, 'Confirmed: ' || coalesce(f.funder_name, '') || ' at ' || coalesce(app.points_of(f)::text, '?') || ' points',
          date_trunc('month', f.funded_on)::date, app.current_user_id());
  -- lender row + deal
  select s.id into sub from submissions s where s.deal_id = f.deal_id and (s.funder_id = f.funder_id or f.funder_id is null)
     and s.status in ('approved', 'revised', 'contracts_out', 'contracts_in', 'funding_call') order by s.status_changed_at desc limit 1;
  if sub is not null then perform set_submission_status(sub, 'funded'); end if;
  if f.deal_id is not null then perform close_deal(f.deal_id, 'funded', 'Funded ' || app.fmt_money(f.amount_cents)); end if;
  perform stop_enrollment(f.client_id, 'funded');
  return f;
end $$;

-- Lender paid us: the ledger line and the state. A short or late payment shows in the Funded sheet.
create function public.record_commission_paid(p_funding uuid, p_cents bigint, p_on date default current_date, p_note text default '')
returns fundings
language plpgsql set search_path = public, pg_temp as $$
declare f fundings; p commission_plans; split numeric; rep bigint;
begin
  select * into f from fundings where id = p_funding for update;
  if not found then raise exception 'funding not found' using errcode = 'P0002'; end if;
  update fundings set commission_received_cents = coalesce(commission_received_cents, 0) + p_cents, commission_received_on = p_on,
                      ledger_state = case when ledger_state = 'clawed_back' then ledger_state when current_date > clawback_until then 'clear' else 'paid' end
   where id = f.id returning * into f;
  split := app.split_for(f.user_id, f.funded_on, (select lead_source_kind from clients where id = f.client_id));
  rep := round(p_cents * split / 100);
  insert into commission_ledger (funding_id, user_id, kind, gross_cents, rep_cents, house_cents, note, created_by)
  values (f.id, f.user_id, 'paid', p_cents, rep, p_cents - rep, p_note, app.current_user_id());
  return f;
end $$;

-- A default inside the clawback window: the commission flips to clawed back and the month is corrected.
create function app.funding_defaulted() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare p commission_plans; rep_share numeric;
begin
  if new.status = 'defaulted' and old.status <> 'defaulted' and new.clawback_until is not null and coalesce(new.defaulted_on, current_date) <= new.clawback_until then
    p := app.plan_for(new.user_id, new.funded_on);
    rep_share := case coalesce(p.clawback_borne_by, 'rep') when 'rep' then 1 when 'house' then 0 else 0.5 end;
    insert into commission_ledger (funding_id, user_id, kind, gross_cents, rep_cents, house_cents, note)
    values (new.id, new.user_id, 'clawback', -coalesce(new.commission_cents, 0),
            -round(coalesce(new.rep_cut_cents, 0) * rep_share), -(coalesce(new.commission_cents, 0) - round(coalesce(new.rep_cut_cents, 0) * rep_share)),
            'Defaulted inside the ' || (new.clawback_until - new.funded_on) || '-day clawback window');
    new.ledger_state := 'clawed_back';
  end if;
  return new;
end $$;
create trigger fundings_clawback before update on fundings for each row execute function app.funding_defaulted();

-- Nightly: fundings past their clawback window become clear; renewal dates become tasks.
create function public.roll_funding_clocks()
returns table (cleared int, warmed int, eligible int)
language plpgsql set search_path = public, pg_temp as $$
declare n1 int; n2 int; n3 int;
begin
  update fundings set ledger_state = 'clear'
   where ledger_state in ('paid') and clawback_until < current_date and status = 'active';
  get diagnostics n1 = row_count;
  -- warm-up: a light task 10 points before the threshold
  insert into timers (user_id, client_id, kind, due_on, note)
  select f.user_id, f.client_id, 'check_in', current_date, 'Renewal warm-up: ' || f.funder_name || ' advance is ~40% paid'
    from fundings f where f.status = 'active' and f.renewal_warm_on <= current_date
     and not exists (select 1 from timers t where t.client_id = f.client_id and t.kind = 'check_in' and t.note like 'Renewal warm-up:%')
     and not exists (select 1 from trashed_clients tc where tc.client_id = f.client_id);
  get diagnostics n2 = row_count;
  insert into timers (user_id, client_id, kind, due_on, note)
  select f.user_id, f.client_id, 'renewal', current_date, 'Eligible for more funds: ' || f.funder_name || ' renewal threshold reached'
    from fundings f where f.status = 'active' and f.renewal_eligible_on <= current_date
     and not exists (select 1 from timers t where t.client_id = f.client_id and t.kind = 'renewal' and t.done_at is null)
     and not exists (select 1 from trashed_clients tc where tc.client_id = f.client_id);
  get diagnostics n3 = row_count;
  return query select n1, n2, n3;
end $$;

-- Win-back pools.
create table winback_pools (
  key text primary key,
  name text not null,
  sort int not null,
  -- the sequence: templates by step (days after entering), a step-down cadence
  steps jsonb not null default '[]'::jsonb
);
insert into winback_pools (key, name, sort, steps) values
  ('approved_unfunded', 'Approved, never funded', 10, '[{"day":0},{"day":7},{"day":14},{"day":28},{"day":90}]'),
  ('declined_curable',  'Declined, now curable',  20, '[{"day":0},{"day":14},{"day":45}]'),
  ('funded_elsewhere',  'Took another offer',     30, '[{"day":0},{"day":30}]'),
  ('paid_off',          'Paid off',               40, '[{"day":0},{"day":14}]'),
  ('cold',              'Cold leads',             50, '[{"day":0},{"day":30},{"day":60}]');
grant select on winback_pools to isaac_app;
alter table winback_pools enable row level security;
create policy winback_pools_read on winback_pools for select to isaac_app using (true);

create table winback_members (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users (id) on delete cascade,
  client_id uuid not null,
  deal_id uuid references deals (id) on delete set null,
  pool text not null references winback_pools (key),
  reason text not null default '',
  -- the first day the merchant is workable (a decline's cure date, 30 days after an approval, the paid-off day)
  workable_on date not null,
  next_step int not null default 1,
  next_due_on date,
  steps_sent int not null default 0,
  status text not null default 'waiting' check (status in ('waiting', 'active', 'replied', 'recovered', 'stopped')),
  stop_reason text,
  last_outbox_id uuid references outbox (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (client_id, user_id) references clients (id, user_id) on delete cascade
);
create unique index winback_members_live_key on winback_members (client_id, pool) where status in ('waiting', 'active');
create index winback_members_due_idx on winback_members (next_due_on) where status = 'active';
grant select, insert, update on winback_members to isaac_app;
alter table winback_members enable row level security;
create policy winback_members_owner on winback_members for all to isaac_app using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy winback_members_team on winback_members for all to isaac_app using (app.can_see_all()) with check (app.can_see_all());

-- Enrol into the pools by rule. Idempotent; nightly.
create function public.refresh_winback_pools()
returns table (added int)
language plpgsql set search_path = public, pg_temp as $$
declare n int; k int;
begin
  -- 1. approved, not funded, 30+ days since the approval, deal still open
  insert into winback_members (user_id, client_id, deal_id, pool, reason, workable_on)
  select d.user_id, d.client_id, d.id, 'approved_unfunded', 'Approved ' || app.fmt_money(o.amount_cents) || ' by ' || f.name || ' on ' || s.responded_at::date,
         (s.responded_at::date + 30)
    from deals d join submissions s on s.deal_id = d.id join funders f on f.id = s.funder_id
    join lateral (select amount_cents from offers o where o.submission_id = s.id order by created_at desc limit 1) o on true
   where d.outcome = 'open' and s.status in ('approved', 'revised') and s.responded_at < now() - interval '30 days'
     and not exists (select 1 from winback_members w where w.client_id = d.client_id and w.pool = 'approved_unfunded' and w.status in ('waiting', 'active'))
     and not exists (select 1 from clients c where c.id = d.client_id and (c.contact_status <> 'ok' or c.email_opt_out))
  on conflict do nothing;
  get diagnostics n = row_count;
  -- 2. declined by every lender for a curable reason: workable when the cure period passes
  insert into winback_members (user_id, client_id, deal_id, pool, reason, workable_on)
  select d.user_id, d.client_id, d.id, 'declined_curable', 'Declined: ' || r.label, (s.status_changed_at::date + r.curable_after_days)
    from deals d join submissions s on s.deal_id = d.id join decline_reasons r on r.key = s.decline_reason
   where d.outcome in ('declined', 'open') and app.deal_status(d) in ('declined_by_all', 'declined') and r.curable_after_days is not null
     and not exists (select 1 from winback_members w where w.client_id = d.client_id and w.pool = 'declined_curable' and w.status in ('waiting', 'active'))
     and not exists (select 1 from clients c where c.id = d.client_id and (c.contact_status <> 'ok' or c.email_opt_out))
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;
  -- 3. lost to another lender: back when that advance should be about half paid
  insert into winback_members (user_id, client_id, deal_id, pool, reason, workable_on)
  select c.user_id, c.id, null, 'funded_elsewhere', 'Took ' || coalesce(co.funder_name, 'another offer'),
         coalesce(co.offered_on, c.stage_changed_at::date) + coalesce(co.term_days, 180) / 2
    from clients c left join lateral (select * from competing_offers x where x.client_id = c.id and x.won order by offered_on desc limit 1) co on true
   where c.stage = 'lost' and c.contact_status = 'ok' and not c.email_opt_out
     and not exists (select 1 from winback_members w where w.client_id = c.id and w.pool = 'funded_elsewhere' and w.status in ('waiting', 'active'))
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;
  -- 4. paid off: the hottest lead the shop owns
  insert into winback_members (user_id, client_id, deal_id, pool, reason, workable_on)
  select f.user_id, f.client_id, f.deal_id, 'paid_off', 'Paid off ' || f.funder_name, current_date
    from fundings f join clients c on c.id = f.client_id
   where f.status = 'paid_off' and c.contact_status = 'ok' and not c.email_opt_out
     and not exists (select 1 from fundings g where g.client_id = f.client_id and g.status = 'active')
     and not exists (select 1 from winback_members w where w.client_id = f.client_id and w.pool = 'paid_off' and w.status in ('waiting', 'active'))
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;
  -- 5. cold: a sequence ran dry (the Cold bucket)
  insert into winback_members (user_id, client_id, deal_id, pool, reason, workable_on)
  select e.user_id, e.client_id, null, 'cold', 'No reply to the follow-up sequence', current_date
    from enrollments e join buckets b on b.id = e.bucket_id
   where b.key = 'cold' and e.stopped_at is null
     and not exists (select 1 from winback_members w where w.client_id = e.client_id and w.pool = 'cold' and w.status in ('waiting', 'active'))
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;
  -- waiting → active once workable
  update winback_members set status = 'active', next_due_on = workable_on where status = 'waiting' and workable_on <= current_date;
  -- a funded deal, a reply, or an opt-out ends membership
  update winback_members w set status = 'recovered', stop_reason = 'funded'
   where w.status in ('waiting', 'active') and exists (select 1 from fundings f where f.client_id = w.client_id and f.funded_on > w.created_at::date);
  update winback_members w set status = 'stopped', stop_reason = 'opted_out'
   where w.status in ('waiting', 'active') and exists (select 1 from clients c where c.id = w.client_id and (c.email_opt_out or c.contact_status <> 'ok'));
  return query select n;
end $$;

-- State rules the FUND checklist and the template checker read. Research 2026-11-15; counsel confirms.
create table state_rules (
  state char(2) primary key,
  broker_registration boolean not null default false,
  registration_deadline date,
  advance_fee_ban boolean not null default false,
  apr_wording_rule boolean not null default false,
  disclosure_law boolean not null default false,
  note text not null default '',
  source_url text not null default '',
  last_reviewed date not null default current_date
);
insert into state_rules (state, broker_registration, registration_deadline, advance_fee_ban, apr_wording_rule, disclosure_law, note, source_url) values
  ('TX', true, '2026-12-31', false, false, true, 'HB 700: brokers register with the OCCC via NMLS by 2026-12-31; up to $10,000 per violation; auto-debit restriction.', 'https://occc.texas.gov/industry/regulated-lenders/commercial-sales-based-finance/'),
  ('FL', false, null, true, false, true, 'No fee may be collected from the merchant before the deal closes (s. 559.9614).', 'https://flsenate.gov/Laws/Statutes/2024/0559.9614'),
  ('VA', true, null, false, false, true, 'Broker registration with the SCC since 2022-11-01.', 'https://law.lis.virginia.gov/vacodefull/title6.2/chapter22.1/'),
  ('CT', true, null, false, false, true, 'Broker registration with the Department of Banking.', 'https://portal.ct.gov/dob'),
  ('MO', true, null, false, false, true, 'Broker registration with the Division of Finance; $10,000 bond.', 'https://www.mayerbrown.com/'),
  ('CA', false, '2028-07-01', false, true, true, 'SB 362: no rate wording without an APR. AB 2116: broker licence from 2028-07-01.', 'https://www.stinson.com/'),
  ('NY', false, null, false, false, true, 'Commercial Finance Disclosure Law applies to financings up to $2.5M where the business is run from NY.', 'https://www.dfs.ny.gov/'),
  ('KS', false, null, true, false, true, 'Advance fee defined and restricted for brokers.', 'https://kssos.org/'),
  ('GA', false, null, false, false, true, 'Disclosure law in force since 2024-01-01 (broker duties unconfirmed).', ''),
  ('UT', true, null, false, false, true, 'Registration at the Department of Financial Institutions (unconfirmed for brokers).', '');
grant select on state_rules to isaac_app;
grant update on state_rules to isaac_app;
alter table state_rules enable row level security;
create policy state_rules_read on state_rules for select to isaac_app using (true);
create policy state_rules_manager on state_rules for update to isaac_app using (app.can_see_all()) with check (app.can_see_all());

-- Shop registrations per state, for the warning when a deal is submitted where the shop is not registered.
create table shop_registrations (
  state char(2) primary key references state_rules (state),
  registration_no text not null default '',
  status text not null default 'none' check (status in ('none', 'filed', 'registered', 'exempt')),
  renews_on date,
  note text not null default ''
);
grant select, insert, update on shop_registrations to isaac_app;
alter table shop_registrations enable row level security;
create policy shop_registrations_read on shop_registrations for select to isaac_app using (true);
create policy shop_registrations_manager on shop_registrations for all to isaac_app using (app.can_see_all()) with check (app.can_see_all());

-- The pre-FUND checklist for a merchant's state, as data the dialog renders.
create function public.fund_checklist(p_client uuid)
returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'state', upper(btrim(c.state)),
    'rules', coalesce((select to_jsonb(r) from state_rules r where r.state = upper(btrim(c.state))), '{}'::jsonb),
    'registration', coalesce((select to_jsonb(s) from shop_registrations s where s.state = upper(btrim(c.state))), '{}'::jsonb),
    'items', (
      select jsonb_agg(x) from (
        select 'disclosure_sent' as key, 'Lender disclosure received and signed by the merchant' as label, (select coalesce(r.disclosure_law, false) from state_rules r where r.state = upper(btrim(c.state))) as required
        union all select 'compensation_recorded', 'Broker compensation recorded (points and PSF)', true
        union all select 'psf_at_closing', 'PSF taken at closing or from proceeds, never before', (select coalesce(r.advance_fee_ban, false) from state_rules r where r.state = upper(btrim(c.state)))
        union all select 'shop_registered', 'Shop is registered in this state', (select coalesce(r.broker_registration, false) from state_rules r where r.state = upper(btrim(c.state)))
      ) x))
  from clients c where c.id = p_client
$$;

-- Remittances that have come due between two dates: business days for daily, else calendar steps (mirrors
-- src/lib/mca/funding.ts remittancesElapsed, so the sheet's paid-in % agrees with the pages).
create function app.remittances_elapsed(p_funded date, p_as_of date, p_freq text) returns int
language plpgsql immutable as $$
declare n int := 0; d date;
begin
  if p_as_of <= p_funded then return 0; end if;
  if p_freq = 'daily' then
    d := p_funded;
    while d < p_as_of loop
      d := d + 1;
      if extract(isodow from d) < 6 then n := n + 1; end if;
    end loop;
    return n;
  elsif p_freq = 'weekly' then return floor((p_as_of - p_funded) / 7);
  elsif p_freq = 'biweekly' then return floor((p_as_of - p_funded) / 14);
  else
    while (p_funded + ((n + 1) || ' months')::interval)::date <= p_as_of loop n := n + 1; end loop;
    return n;
  end if;
end $$;
