-- Stream 3 money (docs/AUTOMATION-AUDIT.md S3-1, S3-5, S3-6):
--   * month-end close — a closed month's ledger lines are locked (a trigger refuses update and delete), one
--     commission statement per person is built from them, and the close itself is a row (commission_closes). Lines
--     that arrive for a closed month land in the current period instead (app.open_period).
--   * the commission plan in full — the renewal split on renewal deals, the manager override as its own ledger line
--     under the manager's name, tiers by the month's funded volume including the funding being confirmed.
--   * corrections — correct_funding changes a confirmed funding's terms (manager only), keeps the original values in
--     fundings_corrections and posts the difference as a dated 'correction' line in the current period.
--   * lender payout tracking — commission_expected_on from the lender's commission_paid_after_days; the late query
--     and the alert are in src/lib/money/payouts.ts and src/lib/system/alerts.ts.

-- ---------- locks and the close ----------
alter table commission_ledger add column locked_at timestamptz;
create index commission_ledger_open_period_idx on commission_ledger (period) where locked_at is null;

create table commission_closes (
  period date primary key check (period = date_trunc('month', period)::date),
  closed_at timestamptz not null default now(),
  closed_by uuid references app_users (id) on delete set null,
  line_count int not null default 0,
  gross_cents bigint not null default 0,
  rep_cents bigint not null default 0,
  house_cents bigint not null default 0,
  summary_emailed_at timestamptz
);
grant select on commission_closes to isaac_app;
alter table commission_closes enable row level security;
create policy commission_closes_read on commission_closes for select to isaac_app using (true);

create table commission_statements (
  id uuid primary key default gen_random_uuid(),
  period date not null references commission_closes (period) on delete cascade,
  user_id uuid not null references app_users (id) on delete cascade,
  line_count int not null default 0,
  gross_cents bigint not null default 0,
  rep_cents bigint not null default 0,
  house_cents bigint not null default 0,
  lines jsonb not null default '[]'::jsonb,
  locked_at timestamptz not null default now(),
  emailed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (period, user_id)
);
create index commission_statements_user_idx on commission_statements (user_id, period desc);
grant select on commission_statements to isaac_app;
alter table commission_statements enable row level security;
create policy commission_statements_owner on commission_statements for select to isaac_app using (user_id = app.current_user_id());
create policy commission_statements_team on commission_statements for select to isaac_app using (app.can_see_all());

-- A line in a closed month never changes, whoever asks: corrections are new dated lines in the open period.
create function app.guard_locked_ledger() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if old.locked_at is not null then
    raise exception 'This commission line is in a closed month — add a correction in the current period' using errcode = '22023';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger commission_ledger_locked before update or delete on commission_ledger
  for each row execute function app.guard_locked_ledger();

-- The period a new line lands in: its own month while that month is open, else the current month.
create function app.open_period(p date) returns date
language sql stable set search_path = public, pg_temp as $$
  select case when exists (select 1 from commission_closes where period = date_trunc('month', p)::date)
              then date_trunc('month', current_date)::date
              else date_trunc('month', p)::date end
$$;

-- Close a month: lock its lines, build (or rebuild, identically) every person's statement. Idempotent; the owner
-- connection (the job) or a manager. Refuses the current month and the future.
create function public.close_month(p_period date)
returns commission_closes
language plpgsql security definer set search_path = public, pg_temp as $$
declare per date := date_trunc('month', p_period)::date; cl commission_closes; r record;
begin
  if app.current_user_id() is not null and not app.can_see_all() then
    raise exception 'only a manager can close a month' using errcode = '22023';
  end if;
  if per >= date_trunc('month', current_date)::date then
    raise exception 'The month is not over yet' using errcode = '22023';
  end if;
  update commission_ledger set locked_at = now() where period = per and locked_at is null;
  insert into commission_closes (period, closed_by) values (per, app.current_user_id()) on conflict (period) do nothing;
  for r in
    select l.user_id, count(*)::int as n, sum(l.gross_cents)::bigint as g, sum(l.rep_cents)::bigint as rp, sum(l.house_cents)::bigint as h,
           jsonb_agg(jsonb_build_object(
             'id', l.id, 'funding_id', l.funding_id, 'kind', l.kind, 'gross_cents', l.gross_cents, 'rep_cents', l.rep_cents,
             'house_cents', l.house_cents, 'note', l.note, 'business', c.business_name, 'funder', f.funder_name,
             'funded_on', f.funded_on, 'created_at', l.created_at) order by l.created_at, l.id) as lines
      from commission_ledger l join fundings f on f.id = l.funding_id join clients c on c.id = f.client_id
     where l.period = per group by l.user_id
  loop
    insert into commission_statements (period, user_id, line_count, gross_cents, rep_cents, house_cents, lines)
    values (per, r.user_id, r.n, r.g, r.rp, r.h, r.lines)
    on conflict (period, user_id) do update
      set line_count = excluded.line_count, gross_cents = excluded.gross_cents, rep_cents = excluded.rep_cents,
          house_cents = excluded.house_cents, lines = excluded.lines;
  end loop;
  update commission_closes set
      line_count = (select count(*)::int from commission_ledger where period = per),
      gross_cents = coalesce((select sum(gross_cents) from commission_ledger where period = per), 0),
      rep_cents = coalesce((select sum(rep_cents) from commission_ledger where period = per), 0),
      house_cents = coalesce((select sum(house_cents) from commission_ledger where period = per), 0)
   where period = per returning * into cl;
  return cl;
end $$;
revoke execute on function public.close_month(date) from public;
grant execute on function public.close_month(date) to isaac_app;

-- ---------- the plan in full ----------
alter table fundings add column commission_expected_on date;

-- The split for a funding: the renewal rate on a renewal deal, the self-gen rate on the rep's own lead, else the
-- plan's split; then the month's tiers by funded volume, this funding included.
create function app.split_for_funding(f fundings) returns numeric
language plpgsql stable set search_path = public, pg_temp as $$
declare p commission_plans; vol bigint; t jsonb; best numeric; lead text; v_kind text;
begin
  p := app.plan_for(f.user_id, f.funded_on);
  if p.id is null then return 50; end if;
  select c.lead_source_kind into lead from clients c where c.id = f.client_id;
  select d.kind into v_kind from deals d where d.id = f.deal_id;
  best := case
    when v_kind = 'renewal' and p.renewal_split_pct is not null then p.renewal_split_pct
    when lead in ('own_form', 'referral') and p.self_gen_split_pct is not null then p.self_gen_split_pct
    else p.split_pct end;
  select coalesce(sum(g.amount_cents), 0) into vol from fundings g
   where g.user_id = f.user_id and date_trunc('month', g.funded_on) = date_trunc('month', f.funded_on)
     and g.confirmed_at is not null and g.id <> f.id;
  vol := vol + f.amount_cents;
  for t in select * from jsonb_array_elements(p.tiers) loop
    if vol >= (t->>'from_cents')::bigint then best := greatest(best, (t->>'split_pct')::numeric); end if;
  end loop;
  return best;
end $$;

-- "10", "12.5": a percentage column (numeric(5,2)) in words, without the trailing zeros.
create function app.fmt_pct(p numeric) returns text
language sql immutable set search_path = public, pg_temp as $$
  select rtrim(rtrim(to_char(p, 'FM9999990.99'), '0'), '.')
$$;

-- The manager an override belongs to: the one who added the rep, else the manager confirming.
create function app.override_manager(p_rep uuid) returns uuid
language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    (select u.invited_by from app_users u join app_users m on m.id = u.invited_by
      where u.id = p_rep and m.role = 'manager' and m.active),
    (select id from app_users where id = app.current_user_id() and role = 'manager'))
$$;

-- P2-46 wording kept; adds the expected commission date from the lender's terms (S3-6).
create or replace function public.propose_funding(p_client uuid, p_terms jsonb)
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
      raise exception '% caps the PSF at %', fd.name, fd.psf_cap_pct::text || '% of the advance' using errcode = '22023';
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
      commission_expected_on = funded_on + coalesce(fd.commission_paid_after_days, 7),
      renewal_warm_on = app.paydown_date(amount_cents, factor_rate, payment_cents, frequency, funded_on, 40),
      renewal_eligible_on = app.paydown_date(amount_cents, factor_rate, payment_cents, frequency, funded_on, coalesce(fd.renewal_paydown_pct, 50))
   where id = f.id returning * into f;
  return f;
end $$;

-- Manager confirms: the terms freeze, the ledger gets its expected line (and the manager's override line), the lender
-- row and deal close as funded, and the merchant leaves every chase. A line for a closed month lands in the open one.
create or replace function public.confirm_funding(p_funding uuid)
returns fundings
language plpgsql set search_path = public, pg_temp as $$
declare f fundings; p commission_plans; split numeric; gross bigint; rep bigint; house bigint; sub uuid; per date;
        ovr bigint; mgr uuid; fd funders;
begin
  if not app.can_see_all() then raise exception 'only a manager can confirm a funding' using errcode = '22023'; end if;
  select * into f from fundings where id = p_funding for update;
  if not found then raise exception 'funding not found' using errcode = 'P0002'; end if;
  if f.confirmed_at is not null then return f; end if;
  gross := coalesce(f.commission_cents, 0);
  split := app.split_for_funding(f);
  p := app.plan_for(f.user_id, f.funded_on);
  rep := round(gross * split / 100) + round(f.psf_cents * coalesce(p.psf_share_pct, 0) / 100);
  house := gross - rep;
  select * into fd from funders where id = f.funder_id;
  update fundings set confirmed_by = app.current_user_id(), confirmed_at = now(), rep_cut_cents = rep, house_cut_cents = house,
                      ledger_state = 'at_risk',
                      commission_expected_on = coalesce(commission_expected_on, funded_on + coalesce(fd.commission_paid_after_days, 7))
   where id = f.id returning * into f;
  per := app.open_period(f.funded_on);
  insert into commission_ledger (funding_id, user_id, kind, gross_cents, rep_cents, house_cents, note, period, created_by)
  values (f.id, f.user_id, 'expected', gross, rep, house,
          'Confirmed: ' || coalesce(f.funder_name, '') || ' at ' || coalesce(app.points_of(f)::text, '?') || ' points' ||
          case when split <> 50 then ' (' || app.fmt_pct(split) || '% split)' else '' end,
          per, app.current_user_id());
  -- the manager's override comes out of the house cut, under the manager's own name
  if coalesce(p.manager_override_pct, 0) > 0 and gross > 0 then
    ovr := round(gross * p.manager_override_pct / 100);
    mgr := app.override_manager(f.user_id);
    if ovr > 0 and mgr is not null then
      insert into commission_ledger (funding_id, user_id, kind, gross_cents, rep_cents, house_cents, note, period, created_by)
      values (f.id, mgr, 'override', 0, ovr, -ovr,
              'Manager override ' || app.fmt_pct(p.manager_override_pct) || '% on ' || coalesce(nullif(f.funder_name, ''), 'the funding'),
              per, app.current_user_id());
    end if;
  end if;
  -- lender row + deal
  select s.id into sub from submissions s where s.deal_id = f.deal_id and (s.funder_id = f.funder_id or f.funder_id is null)
     and s.status in ('approved', 'revised', 'contracts_out', 'contracts_in', 'funding_call') order by s.status_changed_at desc limit 1;
  if sub is not null then perform set_submission_status(sub, 'funded'); end if;
  if f.deal_id is not null then perform close_deal(f.deal_id, 'funded', 'Funded ' || app.fmt_money(f.amount_cents)); end if;
  perform stop_enrollment(f.client_id, 'funded');
  return f;
end $$;

-- ---------- corrections ----------
create table fundings_corrections (
  id uuid primary key default gen_random_uuid(),
  funding_id uuid not null references fundings (id) on delete cascade,
  user_id uuid not null references app_users (id) on delete cascade,     -- the rep, so it reads like the funding
  corrected_by uuid references app_users (id) on delete set null,
  reason text not null,
  old_values jsonb not null,
  new_values jsonb not null,
  ledger_line_id bigint references commission_ledger (id) on delete set null,
  created_at timestamptz not null default now()
);
create index fundings_corrections_funding_idx on fundings_corrections (funding_id, created_at desc);
grant select on fundings_corrections to isaac_app;
alter table fundings_corrections enable row level security;
create policy fundings_corrections_owner on fundings_corrections for select to isaac_app using (user_id = app.current_user_id());
create policy fundings_corrections_team on fundings_corrections for select to isaac_app using (app.can_see_all());

create function app.funding_snapshot(f fundings) returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'amount_cents', f.amount_cents, 'sell_rate', f.sell_rate, 'buy_rate', f.buy_rate, 'points', f.points,
    'psf_cents', f.psf_cents, 'commission_cents', f.commission_cents, 'rep_cut_cents', f.rep_cut_cents,
    'house_cut_cents', f.house_cut_cents, 'funder_name', f.funder_name, 'payment_cents', f.payment_cents,
    'frequency', f.frequency, 'term_days', f.term_days)
$$;

-- A confirmed funding is never edited in place by a rep (0480). A manager corrects it here: the terms change, the
-- original values are kept, and the money difference is a dated correction line in the current period.
create function public.correct_funding(p_funding uuid, p_changes jsonb, p_reason text)
returns fundings
language plpgsql security definer set search_path = public, pg_temp as $$
declare f fundings; n fundings; p commission_plans; k text; v_points numeric; gross bigint; rep bigint; house bigint; split numeric;
        lid bigint; what text := ''; old_v jsonb; new_v jsonb;
        allowed text[] := array['amount_cents', 'sell_rate', 'buy_rate', 'points', 'psf_cents', 'commission_cents', 'funder_name', 'payment_cents', 'frequency', 'term_days'];
begin
  if not app.can_see_all() then raise exception 'only a manager can correct a confirmed funding' using errcode = '22023'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'nothing to correct' using errcode = '22023';
  end if;
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'say why the funding is being corrected' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p_changes) loop
    if not (k = any(allowed)) then raise exception 'cannot correct %', k using errcode = '22023'; end if;
  end loop;
  select * into f from fundings where id = p_funding for update;
  if not found then raise exception 'funding not found' using errcode = 'P0002'; end if;
  if f.confirmed_at is null then
    raise exception 'this funding is not confirmed yet — change the proposal instead' using errcode = '22023';
  end if;
  old_v := app.funding_snapshot(f);
  update fundings set
    amount_cents = coalesce((p_changes->>'amount_cents')::bigint, amount_cents),
    sell_rate = coalesce((p_changes->>'sell_rate')::numeric, sell_rate),
    factor_rate = coalesce((p_changes->>'sell_rate')::numeric, factor_rate),
    buy_rate = case when p_changes ? 'buy_rate' then nullif(p_changes->>'buy_rate', '')::numeric else buy_rate end,
    points = case when p_changes ? 'points' then nullif(p_changes->>'points', '')::numeric else points end,
    psf_cents = coalesce((p_changes->>'psf_cents')::bigint, psf_cents),
    funder_name = coalesce(p_changes->>'funder_name', funder_name),
    payment_cents = coalesce((p_changes->>'payment_cents')::bigint, payment_cents),
    frequency = coalesce(p_changes->>'frequency', frequency),
    term_days = case when p_changes ? 'term_days' then nullif(p_changes->>'term_days', '')::int else term_days end
   where id = f.id returning * into n;
  -- the money follows the corrected terms unless the commission itself was typed
  if p_changes ? 'commission_cents' then
    gross := (p_changes->>'commission_cents')::bigint;
  else
    v_points := app.points_of(n);
    gross := case when v_points is not null then round(n.amount_cents * v_points / 100)::bigint + n.psf_cents else coalesce(n.commission_cents, 0) end;
  end if;
  split := app.split_for_funding(n);
  p := app.plan_for(n.user_id, n.funded_on);
  rep := round(gross * split / 100) + round(n.psf_cents * coalesce(p.psf_share_pct, 0) / 100);
  house := gross - rep;
  update fundings set commission_cents = gross, rep_cut_cents = rep, house_cut_cents = house where id = n.id returning * into n;
  new_v := app.funding_snapshot(n);
  for k in select jsonb_object_keys(p_changes) loop
    what := what || case when what = '' then '' else '; ' end || replace(k, '_cents', '') || ' ' ||
      case when k like '%_cents' then app.fmt_money(coalesce((old_v->>k)::bigint, 0)) || ' → ' || app.fmt_money(coalesce((new_v->>k)::bigint, 0))
           else coalesce(old_v->>k, '—') || ' → ' || coalesce(new_v->>k, '—') end;
  end loop;
  if gross <> coalesce(f.commission_cents, 0) or rep <> coalesce(f.rep_cut_cents, 0) then
    what := what || '; commission ' || app.fmt_money(coalesce(f.commission_cents, 0)) || ' → ' || app.fmt_money(gross);
  end if;
  insert into commission_ledger (funding_id, user_id, kind, gross_cents, rep_cents, house_cents, note, period, created_by)
  values (n.id, n.user_id, 'correction', gross - coalesce(f.commission_cents, 0), rep - coalesce(f.rep_cut_cents, 0),
          house - coalesce(f.house_cut_cents, 0), 'Correction: ' || btrim(p_reason) || ' (' || what || ')',
          date_trunc('month', current_date)::date, app.current_user_id())
  returning id into lid;
  insert into fundings_corrections (funding_id, user_id, corrected_by, reason, old_values, new_values, ledger_line_id)
  values (n.id, n.user_id, app.current_user_id(), btrim(p_reason), old_v, new_v, lid);
  insert into activities (user_id, client_id, kind, body)
  values (n.user_id, n.client_id, 'funding', 'Funding corrected: ' || what || ' — ' || btrim(p_reason));
  return n;
end $$;
revoke execute on function public.correct_funding(uuid, jsonb, text) from public;
grant execute on function public.correct_funding(uuid, jsonb, text) to isaac_app;

-- The managers' close summary rides the once-only ledger the other reminders use (one claim per manager per period).
alter table reminders_sent drop constraint reminders_sent_kind_check;
alter table reminders_sent add constraint reminders_sent_kind_check
  check (kind in ('digest', 'call', 'new_lead', 'weekly', 'reply', 'close'));
