-- 0576: a rep's session used to read every teammate's whole app_users row (finder auth-db-6): the digest address
-- (notify_email), time zone, digest settings, session epoch, offboarding and policy stamps. A rep needs a teammate's
-- name and role to show who owns a merchant, not that. The table is now readable only through a column list, and
-- the whole row is readable for one's own account through a view.
--
-- Safe on a database with rows: no data is touched, every statement can run again, and the only locks are the
-- instant ones a grant, a view and a function replacement take.

-- 1. The caller's own row, every column. The view runs as its owner (so row security on app_users does not hide the
--    row) and its WHERE is the whole of what it shows; security_barrier stops a caller's own predicate (a cast that
--    raises, a function with side effects) being evaluated against another person's row before that WHERE.
--    Columns are listed on purpose: a new column of app_users is private until someone adds it here.
create or replace view app.my_user with (security_barrier = true) as
select id, email, name, timezone, digest_enabled, digest_hour, notify_email, created_at, signature,
       application_link, session_epoch, role, active, invited_by, last_login_at, offboarded_at, offboarded_by,
       policy_accepted_at, phone
  from public.app_users
 where id = app.current_user_id();
revoke all on app.my_user from public;
grant select on app.my_user to isaac_app;

-- 2. About other people: the columns the screens show for a teammate. The team select policy (0290) still lets every
--    signed-in user see every row; the column list is what keeps the rest out of reach.
--      id, email, name, role, active  who someone is and whether they can sign in (owner names, team page, mentions)
--      created_at, last_login_at, invited_by  the team page and the override routing (app.override_manager)
--      signature, application_link, phone  the sender block that goes to merchants in every email a manager or the
--                                          system sends for another rep's merchant (offers, approvals, buckets)
--    Not readable about anyone else: timezone, digest_enabled, digest_hour, notify_email, session_epoch,
--    offboarded_at, offboarded_by, policy_accepted_at.
revoke select on app_users from isaac_app;
grant select (id, email, name, role, active, invited_by, created_at, last_login_at, signature, application_link, phone)
  on app_users to isaac_app;

-- 3. A merchant's time zone falls back to its rep's, and a manager works merchants of other reps, so the reps' own
--    zones cannot simply be revoked. This returns one: your own, or anyone's to a manager. It is the only way
--    left to read a zone off app_users as isaac_app. (A rep only ever reaches their own merchants, so nothing a rep
--    could do before is lost.) The system connection (no signed-in user) is unrestricted, as in app.suppress.
create or replace function app.user_timezone(p_user uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select u.timezone
    from app_users u
   where u.id = p_user
     and (app.current_user_id() is null or u.id = app.current_user_id() or app.can_see_all())
$$;
revoke all on function app.user_timezone(uuid) from public;
grant execute on function app.user_timezone(uuid) to isaac_app;

-- 4. Functions that run as the caller and read the zone off app_users now read it through the function above. Each
--    rewrite swaps one statement inside the existing definition (so nothing else in a long function is retyped), keeps
--    the owner and the grants (CREATE OR REPLACE), and can run again: a function already rewritten is skipped, and one
--    that matches neither form stops the migration rather than being guessed at.
do $$
declare
  r record;
  src text;
  def text;
begin
  for r in
    select * from (values
      ('app.client_timezone(clients)',
       '(select timezone from app_users where id = c.user_id)',
       'app.user_timezone(c.user_id)'),
      ('app.local_today()',
       '(select timezone from app_users where id = app.current_user_id())',
       'app.user_timezone(app.current_user_id())'),
      ('public.schedule_call(uuid, timestamptz, text)',
       'select timezone into tz from app_users where id = c.user_id;',
       'tz := app.user_timezone(c.user_id);'),
      ('public.record_default(uuid, text, date, timestamptz, bigint, jsonb, text)',
       'select timezone into tz from app_users where id = c.user_id;',
       'tz := app.user_timezone(c.user_id);'),
      ('public.update_funding_terms(uuid, jsonb)',
       'select timezone into tz from app_users where id = c.user_id;',
       'tz := app.user_timezone(c.user_id);')
    ) as v(fn, old_text, new_text)
  loop
    src := (select p.prosrc from pg_proc p where p.oid = r.fn::regprocedure);
    if position(r.old_text in src) > 0 then
      def := replace(pg_get_functiondef(r.fn::regprocedure), r.old_text, r.new_text);
      execute def;
    elsif position(r.new_text in src) = 0 then
      raise exception 'function % has changed: expected to find "%" in it', r.fn, r.old_text;
    end if;
  end loop;
end $$;
