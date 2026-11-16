-- Team accounts. Isaac was built for one user: every row has a user_id and every policy says
-- user_id = app.current_user_id(). Selective CRM has reps, ops and managers on the same data, so:
--   * app_users.role — 'rep' | 'ops' | 'manager'. Reps are all identical; managers have everything.
--   * app_users.active — a disabled login keeps its rows (deals, history) but cannot sign in.
--   * app_users.invited_by — who added the account (managers add reps, ops and other managers).
--   * app.current_role() — the role of the signed-in user, read once per statement (stable).
--   * app.can_see_all() — true for managers; the new *_team policies let them read and write every row.
-- Ops visibility (deals in the ops queue) lands with the submission model; until then ops see their own rows.
-- Policies are additive in Postgres (any permissive policy that passes grants access), so the existing
-- *_owner policies keep working untouched for reps.

alter table app_users
  add column role text not null default 'rep' check (role in ('rep', 'ops', 'manager')),
  add column active boolean not null default true,
  add column invited_by uuid references app_users (id) on delete set null,
  add column last_login_at timestamptz;

create index app_users_role_idx on app_users (role) where active;
-- Managers change roles and disable accounts through the app role; the trigger below is what keeps reps out.
grant update (role, active, invited_by) on app_users to isaac_app;

create function app.current_role() returns text
language sql stable as $$
  select u.role from app_users u where u.id = app.current_user_id()
$$;

create function app.can_see_all() returns boolean
language sql stable as $$
  select coalesce(app.current_role() = 'manager', false)
$$;

-- Managers see and edit every user's rows on every per-user table.
do $$
declare t text;
begin
  foreach t in array array[
    'clients','client_asks','positions','competing_offers','fundings','stips','timers',
    'offers','submissions','funders','snippets','trashed_clients','activities','lead_tokens'
  ] loop
    execute format(
      'create policy %I on %I for all to isaac_app using (app.can_see_all()) with check (app.can_see_all())',
      t || '_team', t);
  end loop;
end $$;

-- Every signed-in user can see who is on the team (names and roles) to assign and mention; only a manager
-- may change someone else's row, and nobody can promote themselves (column-level grants are not RLS, so the
-- trigger below enforces the role rule).
create policy app_users_team_select on app_users for select to isaac_app using (true);
create policy app_users_manager_write on app_users for all to isaac_app
  using (app.can_see_all()) with check (app.can_see_all());

create function app.guard_role_change() returns trigger
language plpgsql as $$
begin
  -- The owner connection (migrations, system jobs) sets no app.user_id and is trusted; the guard is for isaac_app.
  if app.current_user_id() is null then return new; end if;
  if (new.role is distinct from old.role or new.active is distinct from old.active)
     and not app.can_see_all() then
    raise exception 'only a manager can change a role or disable an account' using errcode = 'P0001';
  end if;
  if new.role is distinct from old.role and old.id = app.current_user_id() then
    raise exception 'you cannot change your own role' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger app_users_guard_role before update on app_users
  for each row execute function app.guard_role_change();

-- The one account that existed before this migration becomes the first manager, so nobody is locked out.
update app_users set role = 'manager'
 where id = (select id from app_users order by created_at limit 1);
