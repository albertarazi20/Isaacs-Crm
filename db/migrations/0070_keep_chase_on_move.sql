-- A funder who hasn't answered still has to be chased after the merchant's deal moves a stage.
-- Before this, any stage move (a Board drag, the Move menu) closed every open timer, chase timers
-- included, and the app had to put them back by hand. Now a move leaves chase timers alone while the
-- deal is still in the funding pipeline, and closes them only when it leaves it (lost, dead, funded…).

create or replace function app.replace_timers(p_client uuid, p_user uuid, p_timers jsonb, p_reason text)
returns void
language plpgsql set search_path = public, pg_temp as $$
declare t jsonb;
begin
  if p_timers is null or jsonb_typeof(p_timers) <> 'array' or jsonb_array_length(p_timers) = 0 then
    raise exception 'at least one timer is required' using errcode = '22023';
  end if;
  for t in select * from jsonb_array_elements(p_timers) loop
    perform app.assert_due_on((t->>'due_on')::date);
  end loop;
  -- A booked call is an appointment: it survives a stage move until its day has passed.
  -- A chase timer belongs to a funder's pending answer: move_client decides whether it survives.
  update timers set done_at = now(), done_reason = p_reason
   where client_id = p_client and done_at is null and kind <> 'chase'
     and (kind <> 'scheduled_call' or due_on < current_date);
  for t in select * from jsonb_array_elements(p_timers) loop
    insert into timers (user_id, client_id, kind, due_on, note)
    values (p_user, p_client, t->>'kind', (t->>'due_on')::date, coalesce(t->>'note', ''));
  end loop;
end $$;

create or replace function public.move_client(p_client uuid, p_stage text, p_timers jsonb, p_reason text default '')
returns clients
language plpgsql set search_path = public, pg_temp as $$
declare c clients; old_stage text;
begin
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  old_stage := c.stage;
  perform app.replace_timers(p_client, c.user_id, p_timers, case when old_stage = p_stage then 'replaced' else 'stage_moved' end);
  -- Still waiting on funders → keep chasing them. Out of the pipeline → nothing left to chase.
  if p_stage not in ('application_in', 'stips', 'submitted', 'offers_in', 'offer_presented', 'contract_out') then
    update timers set done_at = now(), done_reason = 'stage_moved'
     where client_id = p_client and kind = 'chase' and done_at is null;
  end if;
  if old_stage <> p_stage then
    update clients set stage = p_stage, stage_changed_at = now() where id = p_client returning * into c;
    insert into activities (user_id, client_id, kind, body, from_stage, to_stage)
    values (c.user_id, p_client, 'stage_change', coalesce(p_reason, ''), old_stage, p_stage);
  end if;
  return c;
end $$;

-- move_client now keeps chase timers itself; this stays as a plain move for the callers that use it.
create or replace function app.move_keeping_chase(p_client uuid, p_stage text, p_timers jsonb, p_reason text)
returns void
language plpgsql set search_path = public, pg_temp as $$
begin
  perform move_client(p_client, p_stage, p_timers, p_reason);
end $$;
