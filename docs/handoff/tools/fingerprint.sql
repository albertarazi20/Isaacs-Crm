select category, n, md5 from (
  select 'columns' as category, count(*) as n, md5(coalesce(string_agg(
    table_schema||'.'||table_name||'.'||column_name||':'||data_type||':'||is_nullable||':'||coalesce(column_default,'')||':'||coalesce(generation_expression,''),
    '|' order by table_schema, table_name, column_name), '')) as md5
  from information_schema.columns where table_schema in ('public','app')
  union all
  select 'constraints', count(*), md5(coalesce(string_agg(
    c.conrelid::regclass::text||'.'||c.conname||':'||pg_get_constraintdef(c.oid), '|' order by c.conrelid::regclass::text, c.conname), ''))
  from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ('public','app')
  union all
  select 'indexes', count(*), md5(coalesce(string_agg(indexdef, '|' order by indexname), ''))
  from pg_indexes where schemaname in ('public','app')
  union all
  select 'functions', count(*), md5(coalesce(string_agg(pg_get_functiondef(p.oid), '|' order by p.proname, pg_get_function_identity_arguments(p.oid)), ''))
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public','app') and p.prokind = 'f' and p.proname <> 'rls_auto_enable'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
  union all
  select 'policies', count(*), md5(coalesce(string_agg(
    schemaname||'.'||tablename||'.'||policyname||':'||cmd||':'||roles::text||':'||coalesce(qual,'')||':'||coalesce(with_check,''),
    '|' order by schemaname, tablename, policyname), ''))
  from pg_policies where schemaname in ('public','app')
  union all
  select 'triggers', count(*), md5(coalesce(string_agg(pg_get_triggerdef(t.oid), '|' order by t.tgrelid::regclass::text, t.tgname), ''))
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal and n.nspname in ('public','app')
  union all
  select 'rls_flags', count(*), md5(coalesce(string_agg(
    c.relname||':'||c.relkind::text||':'||c.relrowsecurity::text||':'||c.relforcerowsecurity::text||':'||coalesce(c.reloptions::text,''), '|' order by c.relname), ''))
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public','app') and c.relkind in ('r','v','p') and c.relname <> 'schema_migrations'
  union all
  select 'views', count(*), md5(coalesce(string_agg(viewname||':'||definition, '|' order by viewname), ''))
  from pg_views where schemaname in ('public','app')
  union all
  select 'grants_isaac_app', count(*), md5(coalesce(string_agg(
    table_schema||'.'||table_name||':'||privilege_type, '|' order by table_schema, table_name, privilege_type), ''))
  from information_schema.role_table_grants where grantee = 'isaac_app' and table_schema in ('public','app')
  union all
  select 'grants_anon_authenticated', count(*), md5(coalesce(string_agg(
    grantee||'.'||table_schema||'.'||table_name||':'||privilege_type, '|' order by grantee, table_schema, table_name, privilege_type), ''))
  from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_schema in ('public','app')
) t order by category;
