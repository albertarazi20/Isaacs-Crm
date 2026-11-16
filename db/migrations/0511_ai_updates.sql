-- Stream 2 (S2-1, S2-4, S2-9, S2-15): what applying an AI update does, and how it is undone.
--   * A lender's stips request becomes checklist rows (stips), which re-buckets the merchant (0320) and the bucket
--     email asks for exactly those items. The reader's free-text list is mapped to kinds in code
--     (src/lib/inbox/stips.ts) before it lands in payload.stip_rows; 'other' keeps its label.
--   * An applied approval writes the rep's alert; a funded email proposes the funding from the offer on that lender
--     row (a manager confirms it with FUND) and alerts the managers.
--   * The lender row's status before the update is kept on the update, so revert_ai_update puts it back.
--   * An update may come from pasted text (source 'pasted'); it has no email behind it.

alter table stips add column label text not null default '';

alter table proposed_updates
  add column source text not null default 'email' check (source in ('email', 'pasted')),
  add column previous_status text,
  add column previous_decline_reason text,
  add column previous_approval_expires_on date,
  add column created_offer_id uuid references offers (id) on delete set null,
  add column reverted_by uuid references app_users (id) on delete set null,
  add column reverted_at timestamptz;
alter table proposed_updates drop constraint proposed_updates_status_check;
alter table proposed_updates add constraint proposed_updates_status_check
  check (status in ('auto', 'proposed', 'applied', 'rejected', 'reverted'));

create or replace function public.apply_proposed_update(p_update uuid)
returns proposed_updates
language plpgsql set search_path = public, pg_temp as $$
declare
  u proposed_updates; s submissions; d deals; o offers; f fundings;
  off_id uuid; fname text; bname text; item jsonb; v_kind text; v_period date; v_label text; asked text := '';
begin
  select * into u from proposed_updates where id = p_update for update;
  if not found then raise exception 'update not found' using errcode = 'P0002'; end if;
  if u.status in ('applied', 'rejected', 'reverted') then return u; end if;
  select * into d from deals where id = u.deal_id for update;
  select business_name into bname from clients where id = d.client_id;
  if u.submission_id is not null then
    select * into s from submissions where id = u.submission_id for update;
    select name into fname from funders where id = s.funder_id;
    -- what the lender row said before, so revert_ai_update can put it back
    update proposed_updates
       set previous_status = s.status, previous_decline_reason = s.decline_reason, previous_approval_expires_on = s.approval_expires_on
     where id = u.id;
  end if;
  -- the review is over: the "Review: …" blocker the proposal wrote comes off
  update deals set blocker = '' where id = d.id and blocker like 'Review:%';

  if u.event in ('info_requested', 'stip_requested') and s.id is not null then
    perform set_submission_status(s.id, 'stips_requested', null, coalesce(u.payload->>'note', ''));
    -- the lender's list becomes checklist rows; the stips trigger (0320) re-buckets the merchant and the bucket
    -- email names what is needed
    for item in select * from jsonb_array_elements(coalesce(u.payload->'stip_rows', '[]'::jsonb)) loop
      v_kind := item->>'kind';
      v_period := case when v_kind = 'bank_statement' then nullif(item->>'period', '')::date end;
      v_label := left(btrim(coalesce(item->>'label', '')), 120);
      if v_kind is null then continue; end if;
      insert into stips (user_id, client_id, kind, period, required, label)
      values (d.user_id, d.client_id, v_kind, v_period, true, v_label)
      on conflict (client_id, kind, coalesce(period, date '0001-01-01'))
        do update set required = true, label = case when stips.label = '' then excluded.label else stips.label end;
      asked := asked || case when asked = '' then '' else ', ' end ||
        case when v_kind = 'bank_statement' then coalesce(to_char(v_period, 'FMMon YYYY') || ' statement', 'bank statement')
             when v_kind = 'other' and v_label <> '' then v_label
             else app.document_label(v_kind, null::date) end;
    end loop;
    if asked <> '' then
      insert into activities (user_id, client_id, kind, body)
      values (d.user_id, d.client_id, 'system', 'Checklist updated — ' || coalesce(fname, 'the lender') || ' needs: ' || asked);
    end if;
  elsif u.event = 'declined' and s.id is not null then
    perform set_submission_status(s.id, 'declined', nullif(u.payload->>'decline_reason', ''), coalesce(u.payload->>'note', ''));
  elsif u.event in ('approved', 'revised') and s.id is not null then
    if (u.payload->>'amount_cents') is not null and (u.payload->>'factor_rate') is not null then
      select id into off_id from record_offer(s.id, jsonb_build_object(
        'amount_cents', (u.payload->>'amount_cents')::bigint,
        'factor_rate', (u.payload->>'factor_rate')::numeric,
        'payment_cents', nullif(u.payload->>'payment_cents', '')::bigint,
        'frequency', nullif(u.payload->>'frequency', ''),
        'term_days', nullif(u.payload->>'term_days', '')::int,
        'position_no', nullif(u.payload->>'position_no', '')::int,
        'fees_cents', nullif(u.payload->>'fees_cents', '')::bigint,
        'expires_on', nullif(u.payload->>'expires_on', ''),
        'note', coalesce(u.payload->>'note', '')));
      update proposed_updates set created_offer_id = off_id where id = u.id;
      if u.event = 'revised' then update submissions set status = 'revised' where id = s.id; end if;
    else
      perform set_submission_status(s.id, 'approved', null, coalesce(u.payload->>'note', ''));
    end if;
    -- the rep hears that an approval landed
    insert into user_alerts (user_id, kind, client_id, deal_id, title, body, href, dedupe_key)
    values (d.user_id, 'approval_landed', d.client_id, d.id,
            coalesce(fname, 'A lender') || ' approved ' || bname, u.summary, '/deals/' || d.id, 'approval_landed:' || u.id)
    on conflict do nothing;
  elsif u.event = 'docs_out' and s.id is not null then
    perform set_submission_status(s.id, 'contracts_out');
  elsif u.event = 'contracts_in' and s.id is not null then
    perform set_submission_status(s.id, 'contracts_in');
  elsif u.event in ('bv_done', 'funding_call_done') and s.id is not null then
    perform set_submission_status(s.id, 'funding_call', null, coalesce(u.payload->>'note', ''));
  elsif u.event = 'funded' and s.id is not null then
    perform set_submission_status(s.id, 'funded');
    -- the latest offer on this lender row becomes the proposed funding; a manager confirms the money with FUND
    select * into o from offers where submission_id = s.id order by created_at desc limit 1;
    if o.id is not null and o.payment_cents is not null and o.frequency is not null
       and not exists (select 1 from fundings x where x.deal_id = d.id) then
      -- the same timers FUND writes (src/lib/mca/stages.ts, funded): a check-in in 30 days, the renewal call at 50 % paid
      select * into f from propose_funding(d.client_id, jsonb_build_object(
        'funder_id', s.funder_id, 'funder_name', fname, 'funded_on', current_date::text,
        'amount_cents', o.amount_cents, 'sell_rate', o.factor_rate, 'payment_cents', o.payment_cents,
        'frequency', o.frequency, 'term_days', o.term_days, 'position_no', coalesce(o.position_no, 1),
        'psf_cents', 0, 'psf_collected_at', 'at_closing',
        'note', 'Proposed from ' || coalesce(fname, 'the lender') || '''s funded email',
        'timers', jsonb_build_array(
          jsonb_build_object('kind', 'check_in', 'due_on', (current_date + 30)::text, 'note', 'Remittances clearing? Any NSFs?'),
          jsonb_build_object('kind', 'renewal',
                             'due_on', coalesce(app.paydown_date(o.amount_cents, o.factor_rate, o.payment_cents, o.frequency, current_date, 50), current_date + 90)::text,
                             'note', '50% paid down — renewal call'))));
      update deals set blocker = 'Funding proposed from ' || coalesce(fname, 'the lender') || '''s email — a manager confirms it with FUND'
       where id = d.id;
      insert into user_alerts (user_id, kind, client_id, deal_id, title, body, href, dedupe_key)
      select m, 'funding_proposed', d.client_id, d.id,
             'Confirm the funding: ' || bname || ' with ' || coalesce(fname, 'the lender'),
             app.fmt_money(o.amount_cents) || ' at ' || app.fmt_factor(o.factor_rate) || ' factor, proposed from the lender''s funded email',
             '/deals/' || d.id, 'funding_proposed:' || f.id
        from app.manager_ids() m
      on conflict do nothing;
    else
      update deals set blocker = 'Lender says funded — confirm the terms with FUND' where id = d.id;
    end if;
  elsif u.event = 'killed' and s.id is not null then
    perform set_submission_status(s.id, 'withdrawn', null, coalesce(u.payload->>'note', ''));
  elsif u.event = 'merchant_replied' then
    perform stop_enrollment(d.client_id, 'replied');
  end if;

  if s.id is not null then
    update submissions
       set source = case when u.source = 'pasted' then 'manual' else 'email' end,
           source_ref = (select gmail_id from inbound_emails where id = u.email_id)
     where id = s.id;
  end if;
  update proposed_updates set status = 'applied', decided_by = app.current_user_id(), decided_at = now() where id = u.id returning * into u;
  return u;
end $$;

-- A pasted portal page (S2-15): the reader's answer is written down (ai_runs) and lands in the tray as a proposed
-- update with source 'pasted'. Manager-only, as the owner: the app role may not insert into either table.
create function public.record_pasted_read(p_deal uuid, p_submission uuid, p_run jsonb, p_update jsonb)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare d deals; v_id uuid; who text;
begin
  if not app.can_see_all() then raise exception 'only a manager can import pasted text' using errcode = '22023'; end if;
  select * into d from deals where id = p_deal for update;
  if not found then raise exception 'deal not found' using errcode = 'P0002'; end if;
  if p_submission is not null and not exists (select 1 from submissions where id = p_submission and deal_id = d.id) then
    raise exception 'that lender row is not on this deal' using errcode = '22023';
  end if;
  select coalesce(nullif(name, ''), email) into who from app_users where id = app.current_user_id();
  insert into ai_runs (purpose, model, prompt_version, input_hash, input_tokens, output_tokens, cost_cents, output, deal_id)
  values ('read_pasted_offer', p_run->>'model', p_run->>'prompt_version', p_run->>'input_hash',
          (p_run->>'input_tokens')::int, (p_run->>'output_tokens')::int, (p_run->>'cost_cents')::numeric, p_run->'output', d.id);
  insert into proposed_updates (email_id, deal_id, submission_id, event, payload, evidence, confidence, status, summary, next_step, source)
  values (null, d.id, p_submission, p_update->>'event', coalesce(p_update->'payload', '{}'::jsonb),
          coalesce(p_update->'evidence', '[]'::jsonb), (p_update->>'confidence')::numeric, 'proposed',
          coalesce(p_update->>'summary', ''), coalesce(p_update->>'next_step', ''), 'pasted')
  returning id into v_id;
  update deals set blocker = 'Review: ' || left(coalesce(p_update->>'summary', ''), 120)
   where id = d.id and (blocker = '' or blocker like 'Review:%');
  insert into activities (user_id, client_id, kind, body)
  values (d.user_id, d.client_id, 'system', '[needs review] ' || coalesce(p_update->>'summary', '') || ' (pasted by ' || coalesce(who, 'a manager') || ')');
  return v_id;
end $$;
revoke execute on function public.record_pasted_read(uuid, uuid, jsonb, jsonb) from public;
grant execute on function public.record_pasted_read(uuid, uuid, jsonb, jsonb) to isaac_app;

-- Undo an applied AI update: the lender row goes back to what it was, an offer the update created goes away, and
-- the timeline says so. Manager-only. A funded update is undone through the funding itself, not here.
create function public.revert_ai_update(p_update uuid)
returns proposed_updates
language plpgsql security definer set search_path = public, pg_temp as $$
declare u proposed_updates; s submissions; d deals; fname text;
begin
  if not app.can_see_all() then raise exception 'only a manager can undo an AI update' using errcode = '22023'; end if;
  select * into u from proposed_updates where id = p_update for update;
  if not found then raise exception 'update not found' using errcode = 'P0002'; end if;
  if u.status <> 'applied' then raise exception 'only an applied update can be undone' using errcode = '22023'; end if;
  if u.event = 'funded' then
    raise exception 'a funded update is undone on the funding itself, not here' using errcode = '22023';
  end if;
  if u.submission_id is null or u.previous_status is null then
    raise exception 'this update changed no lender row, so there is nothing to put back' using errcode = '22023';
  end if;
  select * into s from submissions where id = u.submission_id for update;
  if not found then raise exception 'the lender row is gone' using errcode = 'P0002'; end if;
  select * into d from deals where id = u.deal_id;
  select name into fname from funders where id = s.funder_id;
  if u.created_offer_id is not null then
    delete from offers where id = u.created_offer_id;
  end if;
  update submissions
     set status = u.previous_status,
         decline_reason = case when u.previous_status = 'declined' then u.previous_decline_reason end,
         decline_note = case when u.previous_status = 'declined' then decline_note else '' end,
         approval_expires_on = u.previous_approval_expires_on,
         status_changed_at = now(), source = 'manual', source_ref = null
   where id = s.id;
  update proposed_updates set status = 'reverted', reverted_by = app.current_user_id(), reverted_at = now()
   where id = u.id returning * into u;
  insert into activities (user_id, client_id, kind, body)
  values (d.user_id, d.client_id, 'system',
          'Undid the AI update — ' || coalesce(fname, 'the lender') || ' is back to ' || replace(u.previous_status, '_', ' '));
  return u;
end $$;
revoke execute on function public.revert_ai_update(uuid) from public;
grant execute on function public.revert_ai_update(uuid) to isaac_app;
