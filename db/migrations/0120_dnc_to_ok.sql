-- Review-3B B-5: setting a merchant back from do-not-contact used to leave the single 36-month review timer,
-- so they vanished from Today for three years with nothing wrong in sight. Leaving "dnc" now replaces that
-- review timer with a follow-up a week out, so the merchant is back in the follow-up game on purpose.
create or replace function public.set_contact_status(p_client uuid, p_status text, p_note text default '')
returns clients
language plpgsql set search_path = public, pg_temp as $$
declare c clients; label text; old_status text;
begin
  if p_status not in ('ok', 'no_text', 'no_call', 'no_email', 'dnc') then
    raise exception 'unknown contact status: %', p_status using errcode = '22023';
  end if;
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  old_status := c.contact_status;
  update clients
     set contact_status = p_status, contact_status_note = coalesce(p_note, ''), contact_status_at = now()
   where id = p_client returning * into c;
  if p_status = 'dnc' then
    update timers set done_at = now(), done_reason = 'cancelled' where client_id = p_client and done_at is null;
    update clients set scheduled_call_at = null where id = p_client returning * into c;
    insert into timers (user_id, client_id, kind, due_on, note)
    values (c.user_id, p_client, 'follow_up', (current_date + interval '36 months')::date, 'Do-not-contact — review this status');
  elsif old_status = 'dnc' then
    update timers set done_at = now(), done_reason = 'replaced'
     where client_id = p_client and done_at is null and kind = 'follow_up'
       and note = 'Do-not-contact — review this status';
    insert into timers (user_id, client_id, kind, due_on, note)
    values (c.user_id, p_client, 'follow_up', current_date + 7, 'Contact allowed again — pick the next step');
  end if;
  label := case p_status
    when 'ok' then 'OK to contact'
    when 'no_text' then 'Do not text'
    when 'no_call' then 'Do not call'
    when 'no_email' then 'Do not email'
    else 'Do not contact' end;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Contact status: ' || label || case when coalesce(p_note, '') <> '' then ' — ' || p_note else '' end);
  return c;
end $$;
