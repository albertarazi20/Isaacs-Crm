-- Stream 2 (S2-10, S2-13, S2-14): one-click reshop, the deal notes gate, and "ask a manager".

-- Reshop: every lender declined, so the deal closes as declined and a new one opens pre-filled with the same ask
-- (the merchant's positions are theirs already). Lenders will want the newest statement first, so that row joins the
-- checklist and the merchant is asked for it. The caller must own the merchant or be a manager.
create function public.start_reshop(p_client uuid)
returns deals
language plpgsql security definer set search_path = public, pg_temp as $$
declare c clients; old deals; d deals; b uuid; want date;
begin
  select * into c from clients where id = p_client for update;
  if not found then raise exception 'client not found' using errcode = 'P0002'; end if;
  if not (app.can_see_all() or c.user_id = app.current_user_id()) then
    raise exception 'this merchant is not in your book' using errcode = '22023';
  end if;
  select * into old from deals where client_id = p_client and outcome = 'open' order by created_at desc limit 1 for update;
  if not found then raise exception 'this merchant has no open deal to reshop' using errcode = '22023'; end if;
  if app.deal_status(old) <> 'declined_by_all' then
    raise exception 'reshop is for a deal every lender declined — this one is %', replace(app.deal_status(old), '_', ' ')
      using errcode = '22023';
  end if;
  perform close_deal(old.id, 'declined', 'Reshopped as a new deal');
  insert into deals (user_id, client_id, kind, requested_cents, use_of_funds, rep_note, blocker)
  values (c.user_id, c.id, 'reshop', old.requested_cents, old.use_of_funds, old.rep_note,
          'Reshop: waiting on the newest statement before lenders see it')
  returning * into d;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, c.id, 'system', 'Reshop: deal D-' || d.number || ' opened from D-' || old.number || ' with the same ask');
  -- the newest statement lenders expect joins the checklist (the trigger re-buckets), then the "newest statement"
  -- reminder goes out
  want := app.expected_statement_month(current_date, 5);
  insert into stips (user_id, client_id, kind, period, required)
  values (c.user_id, c.id, 'bank_statement', want, true)
  on conflict (client_id, kind, coalesce(period, date '0001-01-01')) do update set required = true;
  select id into b from buckets where key = 'missing_newest' and active;
  if b is not null then perform enroll_in_bucket(c.id, b, 'moved'); end if;
  return d;
end $$;
revoke execute on function public.start_reshop(uuid) from public;
grant execute on function public.start_reshop(uuid) to isaac_app;

-- The deal notes are split by role. The pages hide the editors; this is the gate (S2-13): a rep cannot write the
-- manager's note, and only ops or a manager write the ops note. The owner connection (jobs) is not restricted.
create function app.guard_deal_notes() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if app.current_user_id() is null then return new; end if;
  if new.manager_note is distinct from old.manager_note and not app.can_see_all() then
    raise exception 'only a manager can write the manager note' using errcode = '22023';
  end if;
  if new.ops_note is distinct from old.ops_note and app.current_role() not in ('ops', 'manager') then
    raise exception 'only ops or a manager can write the ops note' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger deals_guard_notes before update of manager_note, ops_note on deals
  for each row execute function app.guard_deal_notes();

-- Ask a manager: one action writes every manager's alert with the question and the deal's context, and a timeline
-- line on the merchant. Anyone who can see the deal may ask.
create function public.ask_manager(p_deal uuid, p_question text)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare d deals; bname text; asker text; q text := btrim(coalesce(p_question, '')); ctx text; n int;
begin
  if q = '' then raise exception 'say what you want to ask' using errcode = '22023'; end if;
  select * into d from deals where id = p_deal;
  if not found then raise exception 'deal not found' using errcode = 'P0002'; end if;
  if not (app.can_see_all() or d.user_id = app.current_user_id()
          or (app.current_role() = 'ops' and d.ops_status in ('queued', 'kicked_back', 'sent'))) then
    raise exception 'that deal is not in your view' using errcode = '22023';
  end if;
  select business_name into bname from clients where id = d.client_id;
  select coalesce(nullif(name, ''), email) into asker from app_users where id = app.current_user_id();
  ctx := bname || ' (D-' || d.number || ', ' || replace(app.deal_status(d), '_', ' ') || ')' ||
         coalesce(' — lenders: ' || (select string_agg(f.name || ' ' || replace(s.status, '_', ' '), ', ' order by s.sent_on)
                                        from submissions s join funders f on f.id = s.funder_id where s.deal_id = d.id), '') ||
         coalesce(' — best offer ' || (select app.fmt_money(o.amount_cents) || ' at ' || app.fmt_factor(o.factor_rate)
                                          from offers o where o.deal_id = d.id and o.status in ('open', 'presented', 'accepted')
                                         order by o.factor_rate, o.amount_cents desc limit 1), '') ||
         case when d.blocker <> '' then ' — blocker: ' || d.blocker else '' end;
  insert into user_alerts (user_id, kind, client_id, deal_id, title, body, href)
  select m, 'ask_manager', d.client_id, d.id, coalesce(asker, 'Someone') || ' asks about ' || bname,
         left(q, 2000) || E'\n\n' || ctx, '/deals/' || d.id
    from app.manager_ids() m;
  get diagnostics n = row_count;
  insert into activities (user_id, client_id, kind, body)
  values (d.user_id, d.client_id, 'system', coalesce(asker, 'Someone') || ' asked a manager: ' || left(q, 500));
  return n;
end $$;
revoke execute on function public.ask_manager(uuid, text) from public;
grant execute on function public.ask_manager(uuid, text) to isaac_app;
