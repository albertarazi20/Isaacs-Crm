-- Hosted Postgres (Supabase especially) pre-creates roles named anon and authenticated and grants them
-- access to everything new in the public schema, so an HTTP data API can serve those tables to anyone
-- holding the public key. This app never uses that API: it reaches the database only through its own
-- server as the isaac_app role. Shut the other door so a default can't expose merchant data.
-- (Functions and the schema itself stay open to PUBLIC, as in any Postgres: without table access they do nothing.)
-- A no-op on a database without those roles (plain Postgres, Neon, local).
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
    end if;
  end loop;
end $$;
