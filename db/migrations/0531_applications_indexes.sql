-- Covering indexes for the foreign keys 0530 added (the Supabase performance advisor), and the three 0001-era
-- helpers get a fixed search_path like every function written since (the security advisor's last warning).
create index applications_user_idx on applications (user_id);
create index applications_deal_idx on applications (deal_id) where deal_id is not null;
create index applications_document_idx on applications (document_id) where document_id is not null;

alter function app.current_user_id() set search_path = public, pg_temp;
alter function app.can_see_all() set search_path = public, pg_temp;
alter function app.current_role() set search_path = public, pg_temp;
