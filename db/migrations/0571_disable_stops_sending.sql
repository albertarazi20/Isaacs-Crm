-- 0571: disabling a team member stops their mail, not only their login.
-- set_team_member(active = false) killed the session and the lead-intake tokens, but the rep's Gmail connection stayed,
-- so the outbox kept claiming their queued sequence mail and the bucket engine kept queueing more, all sent from a mailbox
-- of someone who no longer works here. Now disabling also cuts the Gmail connection (the stored refresh token goes),
-- clears the mailbox sync state and switches the rep's mailbox row off, the same three steps offboard_user takes.
-- (The worker and the bucket engine also skip inactive reps themselves; src/lib/send/worker.ts, src/lib/buckets/engine.ts.)
-- Queued mail stays on the outbox, untouched: it goes out only if the person is switched on again and reconnects Gmail.
-- Re-enabling changes nothing here: a mailbox row is switched back on by the first send after a new connection.

create or replace function public.set_team_member(p_user uuid, p_role text, p_active boolean)
 RETURNS app_users
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare u app_users; me uuid := app.current_user_id();
begin
  if not app.can_see_all() then raise exception 'only a manager can change the team' using errcode = '22023'; end if;
  if p_role not in ('rep', 'ops', 'manager') then raise exception 'role must be rep, ops or manager' using errcode = '22023'; end if;
  if p_user = me and (p_role <> 'manager' or not p_active) then raise exception 'you cannot demote or disable yourself' using errcode = '22023'; end if;
  update app_users set role = p_role, active = p_active,
         session_epoch = case when not p_active or role <> p_role then session_epoch + 1 else session_epoch end
   where id = p_user returning * into u;
  if not found then raise exception 'user not found' using errcode = 'P0002'; end if;
  if not p_active then
    update lead_tokens set revoked_at = now() where user_id = p_user and revoked_at is null;
    -- the mailbox goes with the login: no connection to send or read through, no active mailbox on the ledger
    delete from gmail_connections where user_id = p_user;
    delete from mail_sync_state where user_id = p_user;
    update mailboxes set active = false where user_id = p_user;
  end if;
  insert into access_log (user_id, action, detail) values (me, 'team_change', u.email || ' → ' || u.role || case when u.active then '' else ' (disabled)' end);
  return u;
end $function$;

-- people already disabled before this: the same clean-up, once
delete from gmail_connections where user_id in (select id from app_users where not active);
delete from mail_sync_state where user_id in (select id from app_users where not active);
update mailboxes set active = false where user_id in (select id from app_users where not active) and active;
