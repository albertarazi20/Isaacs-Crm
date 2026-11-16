-- Anti-backdooring (plan §14): a log of who touched which merchant's contact details, exports that only managers can
-- run and that are recorded, canary leads, one-click offboarding that moves the book and bumps the session epoch, and
-- the team functions a manager uses to add people. Watermarks and document views are in 0370.

-- ---------- the access log ----------
create table access_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references app_users (id) on delete cascade,
  action text not null check (action in ('view_contact', 'copy_contact', 'copy_phone', 'copy_email', 'export', 'backup',
                                         'download', 'contact_changed', 'mass_view', 'offboard', 'canary_created', 'team_change')),
  client_id uuid references clients (id) on delete set null,
  document_id uuid references documents (id) on delete set null,
  detail text not null default '',
  ip text not null default '',
  user_agent text not null default '',
  at timestamptz not null default now()
);
create index access_log_user_idx on access_log (user_id, at desc);
create index access_log_client_idx on access_log (client_id, at desc) where client_id is not null;
grant select, insert on access_log to isaac_app;
alter table access_log enable row level security;
-- anyone writes their own line; only managers read
create policy access_log_insert on access_log for insert to isaac_app
  with check (user_id = app.current_user_id() or app.can_see_all());
create policy access_log_manager_read on access_log for select to isaac_app using (app.can_see_all());

-- A phone or email changed on a merchant whose file is already with lenders is how a backdoor starts. Log it.
create function app.contact_changed() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare live boolean; who uuid;
begin
  if new.phone = old.phone and new.email = old.email then return new; end if;
  select exists (select 1 from submissions s where s.client_id = new.id)
      or exists (select 1 from deals d where d.client_id = new.id and d.ops_status in ('sent', 'closed')) into live;
  if not live then return new; end if;
  who := coalesce(app.current_user_id(), new.user_id);
  insert into access_log (user_id, action, client_id, detail)
  values (who, 'contact_changed', new.id,
          concat_ws('; ',
            case when new.phone <> old.phone then 'phone: ' || old.phone || ' → ' || new.phone end,
            case when new.email <> old.email then 'email: ' || old.email || ' → ' || new.email end));
  return new;
end $$;
create trigger clients_contact_changed after update of phone, email on clients for each row execute function app.contact_changed();

-- ---------- canaries ----------
alter table clients add column is_canary boolean not null default false;
alter table app_users add column offboarded_at timestamptz, add column offboarded_by uuid references app_users (id) on delete set null;

-- A fake merchant in a rep's book whose phone and email reach the manager. A call to that number says whose book leaked.
create function public.create_canary(p_rep uuid, p_business text, p_contact text, p_phone text, p_email text)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  if not app.can_see_all() then raise exception 'only a manager can plant a canary' using errcode = '22023'; end if;
  if not exists (select 1 from app_users where id = p_rep and active) then raise exception 'rep not found' using errcode = 'P0002'; end if;
  insert into clients (user_id, business_name, contact_name, phone, email, source, lead_source_kind, is_canary)
  values (p_rep, p_business, p_contact, p_phone, p_email, 'web', 'own_form', true) returning clients.id into v_id;
  insert into timers (user_id, client_id, kind, due_on) values (p_rep, v_id, 'follow_up', current_date + 1);
  insert into activities (user_id, client_id, kind, body) values (p_rep, v_id, 'system', 'New lead');
  insert into access_log (user_id, action, client_id, detail) values (app.current_user_id(), 'canary_created', v_id, p_business || ' in ' || (select email from app_users where id = p_rep));
  return v_id;
end $$;
revoke execute on function public.create_canary(uuid, text, text, text, text) from public;
grant execute on function public.create_canary(uuid, text, text, text, text) to isaac_app;

-- ---------- the team ----------
create function public.add_team_member(p_email text, p_name text, p_role text)
returns app_users
language plpgsql security definer set search_path = public, pg_temp as $$
declare u app_users;
begin
  if not app.can_see_all() then raise exception 'only a manager can add people' using errcode = '22023'; end if;
  if p_role not in ('rep', 'ops', 'manager') then raise exception 'role must be rep, ops or manager' using errcode = '22023'; end if;
  if p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'that is not an email address' using errcode = '22023'; end if;
  insert into app_users (email, name, role, invited_by) values (lower(btrim(p_email)), btrim(p_name), p_role, app.current_user_id())
  on conflict (email) do update set active = true, role = excluded.role, name = case when excluded.name <> '' then excluded.name else app_users.name end,
                                   invited_by = excluded.invited_by, offboarded_at = null, offboarded_by = null
  returning * into u;
  insert into access_log (user_id, action, detail) values (app.current_user_id(), 'team_change', 'added ' || u.email || ' as ' || u.role);
  return u;
end $$;
revoke execute on function public.add_team_member(text, text, text) from public;
grant execute on function public.add_team_member(text, text, text) to isaac_app;

create function public.set_team_member(p_user uuid, p_role text, p_active boolean)
returns app_users
language plpgsql security definer set search_path = public, pg_temp as $$
declare u app_users; me uuid := app.current_user_id();
begin
  if not app.can_see_all() then raise exception 'only a manager can change the team' using errcode = '22023'; end if;
  if p_role not in ('rep', 'ops', 'manager') then raise exception 'role must be rep, ops or manager' using errcode = '22023'; end if;
  if p_user = me and (p_role <> 'manager' or not p_active) then raise exception 'you cannot demote or disable yourself' using errcode = '22023'; end if;
  update app_users set role = p_role, active = p_active,
         session_epoch = case when not p_active or role <> p_role then session_epoch + 1 else session_epoch end
   where id = p_user returning * into u;
  if not found then raise exception 'user not found' using errcode = 'P0002'; end if;
  insert into access_log (user_id, action, detail) values (me, 'team_change', u.email || ' → ' || u.role || case when u.active then '' else ' (disabled)' end);
  return u;
end $$;
revoke execute on function public.set_team_member(uuid, text, boolean) from public;
grant execute on function public.set_team_member(uuid, text, boolean) to isaac_app;

-- ---------- offboarding ----------
-- Every child table keyed (client_id, user_id) → clients (id, user_id) must move with the merchant in one transaction.
-- Those keys are immediate today; make them deferrable so offboard_user can swap owner on parent and children together.
do $$
declare r record;
begin
  for r in
    select con.conname, con.conrelid::regclass as tbl
      from pg_constraint con
     where con.contype = 'f' and con.confrelid = 'clients'::regclass and array_length(con.confkey, 1) = 2
  loop
    execute format('alter table %s alter constraint %I deferrable initially immediate', r.tbl, r.conname);
  end loop;
end $$;

create function public.offboard_user(p_user uuid, p_to uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare rep app_users; heir app_users; n_clients int; n_deals int; n_docs int; n_enrol int; report jsonb; me uuid := app.current_user_id();
begin
  if not app.can_see_all() then raise exception 'only a manager can offboard someone' using errcode = '22023'; end if;
  if p_user = me then raise exception 'you cannot offboard yourself' using errcode = '22023'; end if;
  if p_user = p_to then raise exception 'pick someone else to receive the book' using errcode = '22023'; end if;
  select * into rep from app_users where id = p_user for update;
  if not found then raise exception 'user not found' using errcode = 'P0002'; end if;
  select * into heir from app_users where id = p_to and active;
  if not found then raise exception 'the person receiving the book must be active' using errcode = '22023'; end if;

  set constraints all deferred;
  create temp table moved on commit drop as select id from clients where user_id = p_user;

  -- 1. the login dies now: inactive, and every open session is invalid on its next request
  update app_users set active = false, session_epoch = session_epoch + 1, offboarded_at = now(), offboarded_by = me where id = p_user;
  -- 2. the mailbox connection is cut; queued mail goes out on behalf of the new owner instead
  delete from gmail_connections where user_id = p_user;
  delete from mail_sync_state where user_id = p_user;
  update mailboxes set active = false where user_id = p_user;
  update sheet_sources set reader_user_id = null where reader_user_id = p_user;
  update outbox set user_id = p_to, mailbox_id = null where user_id = p_user and status = 'queued';
  -- 3. the book moves, children with it. Commission history stays in the ledger under the leaving rep.
  update clients set user_id = p_to where user_id = p_user;            get diagnostics n_clients = row_count;
  update client_asks set user_id = p_to where user_id = p_user;
  update positions set user_id = p_to where user_id = p_user;
  update competing_offers set user_id = p_to where user_id = p_user;
  update fundings set user_id = p_to where user_id = p_user;
  update stips set user_id = p_to where user_id = p_user;
  update timers set user_id = p_to where user_id = p_user;
  update activities set user_id = p_to where user_id = p_user;
  update submissions set user_id = p_to where user_id = p_user;
  update offers set user_id = p_to where user_id = p_user;
  update trashed_clients set user_id = p_to where user_id = p_user;
  update deals set user_id = p_to where user_id = p_user;              get diagnostics n_deals = row_count;
  update enrollments set user_id = p_to where user_id = p_user;        get diagnostics n_enrol = row_count;
  update winback_members set user_id = p_to where user_id = p_user;
  update documents set user_id = p_to where user_id = p_user;          get diagnostics n_docs = row_count;
  insert into activities (user_id, client_id, kind, body)
  select p_to, m.id, 'system', 'Reassigned from ' || coalesce(nullif(rep.name, ''), rep.email) || ' to ' || coalesce(nullif(heir.name, ''), heir.email) || ' (offboarding)' from moved m;

  -- 4. the 30-day report: what they looked at, copied and took out
  report := jsonb_build_object(
    'user', rep.email, 'to', heir.email,
    'clients_moved', n_clients, 'deals_moved', n_deals, 'documents_moved', n_docs, 'enrollments_moved', n_enrol,
    'last_30_days', jsonb_build_object(
      'contact_copies', (select count(*) from access_log where user_id = p_user and action in ('copy_contact', 'copy_phone', 'copy_email') and at > now() - interval '30 days'),
      'contact_views', (select count(*) from access_log where user_id = p_user and action = 'view_contact' and at > now() - interval '30 days'),
      'contact_changes', (select count(*) from access_log where user_id = p_user and action = 'contact_changed' and at > now() - interval '30 days'),
      'exports', (select count(*) from access_log where user_id = p_user and action in ('export', 'backup') and at > now() - interval '30 days'),
      'document_opens', (select count(*) from document_views where viewer_user_id = p_user and at > now() - interval '30 days'),
      'after_hours_document_opens', (select count(*) from document_views v where v.viewer_user_id = p_user and v.at > now() - interval '30 days'
                                        and extract(hour from v.at at time zone coalesce(rep.timezone, 'UTC')) not between 7 and 20),
      'lenders_sent_to', (select count(distinct s.funder_id) from submissions s where s.client_id in (select id from moved) and s.sent_on > current_date - 30),
      'canaries_touched', (select count(*) from access_log a join clients c on c.id = a.client_id where a.user_id = p_user and c.is_canary and a.at > now() - interval '30 days')
    ));
  insert into access_log (user_id, action, detail) values (me, 'offboard', report::text);
  return report;
end $$;
revoke execute on function public.offboard_user(uuid, uuid) from public;
grant execute on function public.offboard_user(uuid, uuid) to isaac_app;
