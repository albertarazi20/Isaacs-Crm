-- Offers, part two (0556).
--   1. When a merchant accepts, their rep is emailed the accepted terms with the documents attached. The offer
--      remembers whether that went (a failed send is tried again by the outbox job, three times at most).
--   2. Opening an offer is a signal like opening the upload link: it lands in link_opens, so "Do this now" shows
--      "Opened their offer" while it is still waiting on them.
alter table merchant_offers
  add column accept_notified_at timestamptz,
  add column accept_notice_attempts int not null default 0,
  add column accept_notice_error text not null default '' check (char_length(accept_notice_error) <= 300),
  -- a sender takes the notice before it sends, so two of them (the job, a rep pressing "send again") never both do
  add column accept_notice_claimed_at timestamptz;
create index merchant_offers_notice_idx on merchant_offers (accepted_at)
  where status = 'accepted' and accept_notified_at is null;

alter table link_opens drop constraint link_opens_kind_check;
alter table link_opens add constraint link_opens_kind_check check (kind in ('upload', 'apply', 'offer'));
