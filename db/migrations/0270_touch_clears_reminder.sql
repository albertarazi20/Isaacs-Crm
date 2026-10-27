-- Logging a text or an email finishes a text or email reminder, the way logging a call finishes a call reminder.
CREATE OR REPLACE FUNCTION public.log_touch(p_client uuid, p_kind text, p_outcome text, p_body text, p_next_due_on date)
 RETURNS activities
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare c clients; a activities; call_is_now boolean;
begin
  if p_kind not in ('call','text','email') then
    raise exception 'touch kind must be call, text or email' using errcode = '22023';
  end if;
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  perform app.assert_due_on(p_next_due_on);
  -- Only a touch of the reminder's own kind (call, text or email), within a few hours of (or after) the booked time,
  -- counts as THE reminder being done. A reminder with no recorded channel is a call.
  call_is_now := c.scheduled_call_at is not null and c.scheduled_call_at <= now() + interval '3 hours'
    and p_kind = coalesce((select t.channel from timers t
                            where t.client_id = p_client and t.kind = 'scheduled_call' and t.done_at is null
                            order by t.created_at desc limit 1), 'call');
  -- What this touch resolves: the follow-up he was chasing, a funded check-in or renewal call that
  -- is due, and the booked call if this is it. A renewal call due in 80 days is NOT resolved by it.
  update timers set done_at = now(), done_reason = 'completed'
   where client_id = p_client and done_at is null and (
         kind = 'follow_up'
      or (kind in ('check_in', 'renewal') and due_on <= app.local_today())
      or (kind = 'scheduled_call' and call_is_now));
  if call_is_now then
    update clients set scheduled_call_at = null where id = p_client;
  end if;
  insert into timers (user_id, client_id, kind, due_on, note)
  values (c.user_id, p_client, 'follow_up', p_next_due_on, '');
  insert into activities (user_id, client_id, kind, outcome, body)
  values (c.user_id, p_client, p_kind, p_outcome, coalesce(p_body, '')) returning * into a;
  update clients set last_contact_at = now() where id = p_client;
  return a;
end $function$;
