-- 0592: pin the search path of app.phone_key (Supabase advisor, 2026-11-19). It only uses built-in functions.
alter function app.phone_key(text) set search_path = pg_catalog, pg_temp;
