-- 0565: indexes for the columns Follow Up and the cascades actually walk (review finding database-7).
-- Every page of Follow Up counts and lists the live members of each bucket (enrollments by bucket_id, live only); the
-- other columns are foreign keys whose parents' deletes (a user, a mailbox, an outbox row) otherwise scan the table.
create index if not exists enrollments_bucket_live_idx on enrollments (bucket_id) where stopped_at is null;
create index if not exists enrollments_user_idx on enrollments (user_id);
create index if not exists outbox_mailbox_idx on outbox (mailbox_id) where mailbox_id is not null;
create index if not exists documents_user_idx on documents (user_id);
create index if not exists merchant_offers_user_idx on merchant_offers (user_id);
create index if not exists merchant_offers_outbox_idx on merchant_offers (outbox_id) where outbox_id is not null;
create index if not exists sheet_rows_client_idx on sheet_rows (client_id) where client_id is not null;
