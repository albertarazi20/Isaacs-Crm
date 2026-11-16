-- Hosted Postgres, part two (0060 covered tables and sequences). Supabase's default privileges also hand every new
-- function in public to anon, authenticated and service_role, and PostgREST exposes them at /rest/v1/rpc/<name>: the
-- four security-definer team functions (0410) were callable with the public key (their manager check still refused
-- the call, since no app.user_id is set — this closes the door rather than relying on the lock). The app never uses
-- the data API: it reaches the database only through its own server as isaac_app. A no-op without those roles.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke all on all functions in schema public from %I', r);
      execute format('revoke all on all functions in schema app from %I', r);
      execute format('revoke usage on schema app from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke all on functions from %I', r);
    end if;
  end loop;
end $$;

-- A fixed search_path on the helper functions that still resolved names through the caller's. isaac_app cannot create
-- objects anywhere (no CREATE on a schema, no TEMP on the database), so nothing could be planted in its path; the
-- setting makes that true by construction. The three functions every RLS policy calls per row —
-- app.current_user_id, app.current_role, app.can_see_all — stay without it on purpose: a SET clause stops Postgres
-- inlining a SQL function, and they only touch pg_catalog built-ins and (now) a schema-qualified table.
alter function app.touch_updated_at() set search_path = public, pg_temp;
alter function app.guard_role_change() set search_path = public, pg_temp;
alter function app.stamp_deal_id() set search_path = public, pg_temp;
alter function app.suppression_key(text) set search_path = public, pg_temp;
alter function app.stips_changed() set search_path = public, pg_temp;
alter function app.deal_changed() set search_path = public, pg_temp;
alter function app.paydown_date(bigint, numeric, bigint, text, date, numeric) set search_path = public, pg_temp;
alter function app.remittances_elapsed(date, date, text) set search_path = public, pg_temp;
alter function app.document_label(text, date) set search_path = public, pg_temp;

create or replace function app.current_role() returns text
language sql stable as $$
  select u.role from public.app_users u where u.id = app.current_user_id()
$$;
