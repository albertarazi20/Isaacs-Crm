-- Fixes from the second adversarial review (docs/REVIEW-2.md).

-- R-8: booking a call moved the stage without writing history, so reports saw a deal that reached the
-- owner as "never reached the owner". A stage change by booking a call is now recorded like any other.
create or replace function public.schedule_call(p_client uuid, p_at timestamptz, p_note text default '')
returns clients
language plpgsql set search_path = public, pg_temp as $$
declare c clients; tz text; call_day date; old_stage text;
begin
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  old_stage := c.stage;
  select timezone into tz from app_users where id = c.user_id;
  call_day := (p_at at time zone coalesce(tz, 'UTC'))::date;
  perform app.assert_due_on(call_day);
  update timers set done_at = now(), done_reason = 'replaced'
   where client_id = p_client and done_at is null and kind = 'scheduled_call';
  insert into timers (user_id, client_id, kind, due_on, note)
  values (c.user_id, p_client, 'scheduled_call', call_day, coalesce(p_note, ''));
  update clients set scheduled_call_at = p_at,
         stage = case when stage in ('name_in','spoke_with_owner','interested') then 'call_scheduled' else stage end,
         stage_changed_at = case when stage in ('name_in','spoke_with_owner','interested') then now() else stage_changed_at end
   where id = p_client returning * into c;
  if c.stage <> old_stage then
    insert into activities (user_id, client_id, kind, body, from_stage, to_stage)
    values (c.user_id, p_client, 'stage_change', 'Call booked', old_stage, c.stage);
  end if;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'timer', 'Call booked for ' || to_char(p_at at time zone coalesce(tz, 'UTC'), 'FMMon FMDD, FMHH12:MI AM') || case when coalesce(p_note, '') <> '' then ' — ' || p_note else '' end);
  return c;
end $$;

-- R-1 / R-3: "Delete forever" locks the merchant first (a concurrent restore can no longer be overtaken
-- and then deleted), and refuses a merchant with any contact limit. A "stop" is a fact about a person; the
-- record that holds it is what keeps an import or a lead vendor from adding them back as a fresh lead.
create or replace function public.purge_client(p_client uuid)
returns void
language plpgsql set search_path = public, pg_temp as $$
declare c clients;
begin
  select * into c from clients where id = p_client for update;
  if not found or not exists (select 1 from trashed_clients where client_id = p_client) then
    raise exception 'client not in the trash' using errcode = 'P0002';
  end if;
  if c.contact_status <> 'ok' then
    raise exception 'This merchant asked not to be contacted, so the record is kept to stop them being added again'
      using errcode = '22023';
  end if;
  delete from clients where id = p_client;
end $$;

-- R-9: restoring a funded merchant must not lose an OVERDUE renewal call — it is the commission. Overdue
-- renewal, check-in and funder-chase timers come back due today; only an overdue plain follow-up is
-- replaced by one a week out (a wall of overdue follow-ups helps nobody).
create or replace function public.restore_client(p_client uuid)
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
     and kind <> 'scheduled_call'
     and (due_on >= current_date or kind in ('renewal', 'check_in', 'chase'));
  update timers set due_on = current_date
   where client_id = p_client and done_at is null and due_on < current_date
     and kind in ('renewal', 'check_in', 'chase');
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

-- R-10: nothing may give a trashed merchant a new timer — not a stale browser tab, not a funders action.
-- (Restore deletes the trash row before it adds its fallback follow-up, so it is not blocked.)
create function app.timers_live_only() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (select 1 from trashed_clients t where t.client_id = new.client_id) then
    raise exception 'That merchant is in the trash — restore it first' using errcode = '22023';
  end if;
  return new;
end $$;

create trigger timers_live_only before insert on timers
  for each row execute function app.timers_live_only();
