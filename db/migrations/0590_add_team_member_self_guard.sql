-- 0590: "Add person" could demote or lock out the manager using it (security review, 2026-11-18).
-- set_team_member refuses to demote or disable yourself, but add_team_member's on-conflict branch rewrites the role of
-- any existing email, including the caller's own: a manager typing their own address with role Rep lost the manager
-- role and was signed out (session epoch bump). Because the caller is always an active manager, refusing that one case
-- also means the shop can never be left with no manager through the team screens.
-- This is the 0480 version with one added check.
create or replace function public.add_team_member(p_email text, p_name text, p_role text)
 RETURNS app_users
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare u app_users;
begin
  if not app.can_see_all() then raise exception 'only a manager can add people' using errcode = '22023'; end if;
  if p_role not in ('rep', 'ops', 'manager') then raise exception 'role must be rep, ops or manager' using errcode = '22023'; end if;
  if p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'that is not an email address' using errcode = '22023'; end if;
  if p_role <> 'manager' and exists (
       select 1 from app_users me where me.id = app.current_user_id() and me.email = lower(btrim(p_email))) then
    raise exception 'you cannot demote yourself' using errcode = '22023';
  end if;
  insert into app_users (email, name, role, invited_by) values (lower(btrim(p_email)), btrim(p_name), p_role, app.current_user_id())
  on conflict (email) do update set session_epoch = app_users.session_epoch + case when app_users.role <> excluded.role or not app_users.active then 1 else 0 end,
                                   active = true, role = excluded.role, name = case when excluded.name <> '' then excluded.name else app_users.name end,
                                   invited_by = excluded.invited_by, offboarded_at = null, offboarded_by = null
  returning * into u;
  insert into access_log (user_id, action, detail) values (app.current_user_id(), 'team_change', 'added ' || u.email || ' as ' || u.role);
  return u;
end $function$;
