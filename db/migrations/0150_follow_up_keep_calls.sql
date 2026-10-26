-- 0150: set_follow_up can leave a funded merchant's check-in and renewal call alone (QA I-1).
-- Snooze still pushes them (he picked a date on purpose); dragging a card to a follow-up column does not, so one
-- slip of the mouse can't push the best lead in the shop out by three years.

drop function public.set_follow_up(uuid, date, text);

create function public.set_follow_up(p_client uuid, p_due_on date, p_note text default '', p_keep_calls boolean default false)
returns timers
language plpgsql set search_path = public, pg_temp as $$
declare c clients; t timers;
begin
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  perform app.assert_due_on(p_due_on);
  update timers set done_at = now(), done_reason = 'replaced'
   where client_id = p_client and done_at is null and kind = 'follow_up';
  if not coalesce(p_keep_calls, false) then
    update timers set due_on = p_due_on
     where client_id = p_client and done_at is null and kind in ('check_in', 'renewal') and due_on < p_due_on;
  end if;
  insert into timers (user_id, client_id, kind, due_on, note)
  values (c.user_id, p_client, 'follow_up', p_due_on, coalesce(p_note, '')) returning * into t;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'timer', 'Follow up set for ' || to_char(p_due_on, 'FMMon FMDD, YYYY') || case when coalesce(p_note, '') <> '' then ' — ' || p_note else '' end);
  return t;
end $$;
