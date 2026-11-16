-- Supabase's performance advisor, run after 0500–0515 landed (2026-11-16): the foreign keys those migrations added
-- had no covering index. A merchant, deal, offer or user going away cascades into these tables, and the page reads
-- that filter on them (the deal's alerts, an update's offer) otherwise scan. Only the new ones are covered here; the
-- older unindexed keys the advisor lists predate this pass and are the same INFO-level kind.
create index user_alerts_client_idx on user_alerts (client_id) where client_id is not null;
create index user_alerts_deal_idx on user_alerts (deal_id) where deal_id is not null;
create index proposed_updates_created_offer_idx on proposed_updates (created_offer_id) where created_offer_id is not null;
create index proposed_updates_reverted_by_idx on proposed_updates (reverted_by) where reverted_by is not null;
