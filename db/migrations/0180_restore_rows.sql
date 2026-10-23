-- 0180: restoring a backup file (scripts/restore-backup.ts). One function, run by the database OWNER only, that
-- inserts a batch of rows from a backup into one of Isaac's own tables. It exists so the TypeScript side never builds
-- SQL from a table name: the name is checked against this list here, and the columns come from the catalog.
-- Generated columns (an advance's payback) are left out, so they are recomputed.

create function app.restore_rows(p_table text, p_rows jsonb) returns int
language plpgsql set search_path = public, pg_temp as $$
declare cols text; n int;
begin
  if p_table not in ('clients', 'trashed_clients', 'client_asks', 'positions', 'competing_offers', 'fundings',
                     'stips', 'funders', 'submissions', 'offers', 'timers', 'activities', 'snippets') then
    raise exception 'not a table a backup can restore into: %', p_table using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be a list' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = p_table and is_generated = 'NEVER';
  execute format('insert into %I (%s) select %s from jsonb_populate_recordset(null::%I, $1)',
                 p_table, cols, cols, p_table) using p_rows;
  get diagnostics n = row_count;
  return n;
end $$;

-- the browser-facing role must never be able to write rows under someone else's user_id
revoke all on function app.restore_rows(text, jsonb) from public;
revoke all on function app.restore_rows(text, jsonb) from isaac_app;
