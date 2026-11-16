-- Stream 1, S1-1: mail sent outside the CRM counts toward the cap (plan §11.1). Google counts everything that leaves
-- the mailbox, so the inbox job reads each connected mailbox's Sent mail and writes a send_ledger row with
-- source = 'external' for every message the CRM did not send (src/lib/send/external.ts). app.mailbox_sent_24h
-- already counts every ledger row, so the fuel gauge and the worker's cap see them at once.
--   * send_ledger.provider_id — the provider's id of the message (Gmail's message id), unique per mailbox, so a
--     message is recorded once however many runs see it, and the CRM's own sends are never counted twice.
--   * mailbox_sent_sync — the watermark per mailbox: the newest Sent message recorded, so each run reads only what
--     is new.
alter table send_ledger add column provider_id text;
create unique index send_ledger_provider_key on send_ledger (mailbox_id, provider_id) where provider_id is not null;

create table mailbox_sent_sync (
  user_id uuid primary key references app_users (id) on delete cascade,
  -- Gmail internalDate (milliseconds) of the newest Sent message recorded; 0 = never read
  last_internal_date bigint not null default 0,
  last_synced_at timestamptz,
  last_error text,
  messages_seen int not null default 0
);
grant select on mailbox_sent_sync to isaac_app;
alter table mailbox_sent_sync enable row level security;
create policy mailbox_sent_sync_read on mailbox_sent_sync for select to isaac_app
  using (user_id = app.current_user_id() or app.can_see_all());
