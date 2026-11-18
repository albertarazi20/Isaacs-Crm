-- Merchant offers (0555). A rep writes the funding terms (amount, factor rate, how often and how many payments, how
-- long the offer stands); the merchant gets an email with a private link to a page that shows the offer, asks for
-- the documents it needs, and lets them accept. The arithmetic is the database's: the payback and each payment are
-- computed columns, so the page, the email and the CRM can never disagree.

-- (the old deal-desk table `offers` from the removed lender work stays as it was; this is a new one)
create table merchant_offers (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id) on delete cascade,
  -- the rep who made it (the merchant's owner at the time)
  user_id uuid not null default app.current_user_id() references app_users (id) on delete cascade,
  approval_id uuid references approvals (id) on delete set null,
  -- the merchant's key to the page: 64 random hex characters, never shown in the CRM's own URLs
  token text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  funded_cents bigint not null check (funded_cents between 100000 and 1000000000),
  factor_rate numeric(5, 3) not null check (factor_rate between 1.000 and 2.500),
  frequency text not null check (frequency in ('daily', 'weekly', 'biweekly', 'monthly')),
  payments int not null check (payments between 1 and 1000),
  payback_cents bigint generated always as (round(funded_cents * factor_rate)::bigint) stored,
  -- each payment, rounded down to the cent; the final one carries the few cents left over, so the payments add up to
  -- the payback exactly (final = payback - payment × (payments - 1))
  payment_cents bigint generated always as (round(funded_cents * factor_rate)::bigint / payments) stored,
  -- for the CRM only: the page does not name the funder
  funder text not null default '' check (char_length(funder) <= 120),
  -- a short line from the rep, shown on the page
  message text not null default '' check (char_length(message) <= 600),
  -- what the merchant uploads before accepting
  docs text[] not null default '{drivers_license,voided_check}'
    check (docs <@ array['drivers_license', 'voided_check', 'proof_of_ownership', 'processing_statement',
                         'tax_return', 'lease_letter']::text[]),
  expires_at timestamptz not null,
  status text not null default 'sent' check (status in ('sent', 'accepted', 'withdrawn')),
  outbox_id uuid references outbox (id) on delete set null,
  views int not null default 0,
  first_viewed_at timestamptz,
  last_viewed_at timestamptz,
  accepted_at timestamptz,
  accepted_name text not null default '' check (char_length(accepted_name) <= 160),
  accepted_email text not null default '' check (char_length(accepted_email) <= 254),
  accepted_ip text not null default '' check (char_length(accepted_ip) <= 64),
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check ((status = 'accepted') = (accepted_at is not null)),
  check ((status = 'withdrawn') = (withdrawn_at is not null))
);
create index merchant_offers_client_idx on merchant_offers (client_id, created_at desc);
create index merchant_offers_approval_idx on merchant_offers (approval_id) where approval_id is not null;

alter table merchant_offers enable row level security;
-- whoever can see the merchant sees their offers (a rep their own, a manager the floor)
create policy merchant_offers_visible on merchant_offers to isaac_app
  using (exists (select 1 from clients c where c.id = client_id))
  with check (exists (select 1 from clients c where c.id = client_id));
grant select on merchant_offers to isaac_app;
grant insert (client_id, approval_id, funded_cents, factor_rate, frequency, payments, funder, message, docs, expires_at)
  on merchant_offers to isaac_app;
-- a rep can withdraw an offer and record the email that carried it; the merchant's side is written by the system
grant update (status, withdrawn_at, outbox_id) on merchant_offers to isaac_app;

-- an accepted or withdrawn offer is final: the app role cannot change anything on it any more
create function app.merchant_offers_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user = 'isaac_app' and old.status <> 'sent' then
    raise exception 'That offer was already %', old.status using errcode = '23514', constraint = 'merchant_offers_status_final';
  end if;
  return new;
end $$;
create trigger merchant_offers_guard before update on merchant_offers for each row execute function app.merchant_offers_guard();

-- the offer page's own upload sessions: kept apart from the merchant's everyday upload link, which asks for what the
-- file still needs (statements and the rest), while an offer's slots ask for exactly its documents
alter table upload_sessions drop constraint upload_sessions_purpose_check;
alter table upload_sessions add constraint upload_sessions_purpose_check
  check (purpose in ('documents', 'statements', 'stips', 'application', 'renewal', 'offer'));
