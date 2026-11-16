-- Stream 2 (S2-5): Route B. Lender mail can reach the CRM through the shop's dedicated deals inbox (Resend inbound on
-- the automation domain; submissions carry it as Reply-To) as well as through a manager's Gmail. Such a message
-- belongs to no user's mailbox, so mailbox_user_id may be null; `channel` says which door it came through, and the
-- provider's email id is kept in gmail_id so a replayed webhook stores nothing twice.
alter table inbound_emails alter column mailbox_user_id drop not null;
alter table inbound_emails add column channel text not null default 'gmail' check (channel in ('gmail', 'resend'));
create unique index inbound_emails_resend_key on inbound_emails (gmail_id) where mailbox_user_id is null;
