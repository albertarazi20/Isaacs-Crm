-- Stream 3 compliance (docs/AUTOMATION-AUDIT.md S3-7): submit to ops warns, in the timeline and in the deal's blocker,
-- when the merchant's state requires broker registration and the shop has none on file. The state badge for the
-- deal snapshot is pure code (src/lib/funders/states.ts stateCompliance); registration renewals alert managers 30
-- days ahead from the generator in src/lib/system/alerts.ts.

-- True when state_rules says the state needs a registered broker and shop_registrations has nothing live for it.
create function app.registration_missing(p_state text) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select exists (select 1 from state_rules r where r.state = upper(btrim(p_state)) and r.broker_registration)
     and not exists (select 1 from shop_registrations s where s.state = upper(btrim(p_state)) and s.status in ('registered', 'exempt'))
$$;

-- Rep (or manager) submits the file to ops. One open deal per merchant at a time. (0300, plus the registration check.)
create or replace function public.submit_to_ops(p_client uuid, p_kind text default 'new', p_requested bigint default null,
                                                p_use_of_funds text default '', p_note text default '')
returns deals
language plpgsql set search_path = public, pg_temp as $$
declare c clients; d deals; st text;
begin
  select * into c from clients where id = p_client for update;
  if not found then raise exception 'client not found' using errcode = 'P0002'; end if;
  st := upper(btrim(c.state));
  select * into d from deals where client_id = p_client and outcome = 'open' for update;
  if found then
    if d.ops_status = 'kicked_back' then
      update deals set ops_status = 'queued', queued_at = now(), rep_note = coalesce(nullif(btrim(p_note), ''), rep_note),
                       blocker = case when app.registration_missing(st) then 'Shop is not registered in ' || st else '' end
       where id = d.id returning * into d;
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
  if app.registration_missing(st) then
    insert into activities (user_id, client_id, kind, body)
    values (c.user_id, c.id, 'system',
            'Warning: ' || st || ' requires broker registration and the shop has none on file — a manager should check before this goes to lenders');
    update deals set blocker = 'Shop is not registered in ' || st where id = d.id returning * into d;
  end if;
  if c.stage in ('name_in', 'spoke_with_owner', 'interested', 'call_scheduled', 'application_sent') then
    -- move_client needs a next date: ops answers within a business day, so the rep checks back then
    perform move_client(c.id, 'application_in',
      jsonb_build_array(jsonb_build_object('kind', 'follow_up', 'due_on', (current_date + 1)::text, 'note', 'Ops is reviewing the file')),
      'Submitted to ops');
  end if;
  return d;
end $$;
