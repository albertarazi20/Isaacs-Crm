-- Stream 2 (S2-18): last synced per mailbox, for the Settings page. gmail_connections holds the refresh token and the
-- app role may not read it; this answers as the owner with the safe columns only — a person's own mailbox, or every
-- mailbox for a manager.
create function public.mailbox_sync_status()
returns table (user_id uuid, name text, email text, google_email text, can_read_mail boolean, connection_status text,
               last_synced_at timestamptz, last_error text, messages_seen int, has_cursor boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select g.user_id, coalesce(nullif(u.name, ''), u.email), u.email, g.google_email, g.can_read_mail, g.status,
         m.last_synced_at, m.last_error, coalesce(m.messages_seen, 0), m.history_id is not null
    from gmail_connections g
    join app_users u on u.id = g.user_id
    left join mail_sync_state m on m.user_id = g.user_id
   where u.active and (g.user_id = app.current_user_id() or app.can_see_all())
   order by g.can_read_mail desc, lower(u.email)
$$;
revoke execute on function public.mailbox_sync_status() from public;
grant execute on function public.mailbox_sync_status() to isaac_app;
