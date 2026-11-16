-- Supabase's performance advisor after 0520–0526 landed (2026-11-16): the foreign keys stream 3 added had no covering
-- index (the same INFO the 0516 indexes answered for streams 1 and 2). A user, client, outbox row or ledger line going
-- away cascades or nulls into these tables; the page reads that filter on them (a rep's corrections, a merchant's
-- rescue nudges, a member's reason) otherwise scan.
create index backdoor_reports_reported_by_idx on backdoor_reports (reported_by) where reported_by is not null;
create index commission_closes_closed_by_idx on commission_closes (closed_by) where closed_by is not null;
create index fundings_corrections_user_idx on fundings_corrections (user_id);
create index fundings_corrections_corrected_by_idx on fundings_corrections (corrected_by) where corrected_by is not null;
create index fundings_corrections_ledger_line_idx on fundings_corrections (ledger_line_id) where ledger_line_id is not null;
create index rescue_nudges_user_idx on rescue_nudges (user_id);
create index rescue_nudges_client_idx on rescue_nudges (client_id);
create index rescue_nudges_outbox_idx on rescue_nudges (outbox_id) where outbox_id is not null;
create index winback_members_reason_idx on winback_members (why_not_funded) where why_not_funded is not null;
