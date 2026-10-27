-- Setting a reminder no longer moves the merchant to "Phone call scheduled". A reminder is a time and a channel
-- (call, text or email) on whatever stage he is already in; that stage is retired from the pickers.
create or replace function public.schedule_call(p_client uuid, p_at timestamptz, p_note text default '')
returns clients
language plpgsql set search_path = public, pg_temp as $$
declare c clients; tz text; call_day date;
begin
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  select timezone into tz from app_users where id = c.user_id;
  call_day := (p_at at time zone coalesce(tz, 'UTC'))::date;
  perform app.assert_due_on(call_day);
  update timers set done_at = now(), done_reason = 'replaced'
   where client_id = p_client and done_at is null and kind = 'scheduled_call';
  insert into timers (user_id, client_id, kind, due_on, note)
  values (c.user_id, p_client, 'scheduled_call', call_day, coalesce(p_note, ''));
  update clients set scheduled_call_at = p_at where id = p_client returning * into c;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'timer', 'Reminder set for ' || to_char(p_at at time zone coalesce(tz, 'UTC'), 'FMMon FMDD, FMHH12:MI AM') || case when coalesce(p_note, '') <> '' then ' — ' || p_note else '' end);
  return c;
end $$;
