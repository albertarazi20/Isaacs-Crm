-- The send counters take the worker's clock. The worker runs at one instant (`now`, which a scheduled run reads from
-- the wall and a test pins), writes the ledger with it, and must count the ledger against the same instant — until
-- now the two counters compared ledger rows with the server's now(), so a pinned run saw a different 24 hours than
-- the one it was writing. Default stays now() for the dashboard gauge, which reads the live clock.
drop function app.mailbox_sent_24h(uuid);
create function app.mailbox_sent_24h(p_mailbox uuid, p_as_of timestamptz default now()) returns int
language sql stable set search_path = public, pg_temp as $$
  select count(*)::int from send_ledger where mailbox_id = p_mailbox and sent_at > p_as_of - interval '24 hours'
$$;

drop function app.merchant_sent(uuid, interval);
create function app.merchant_sent(p_client uuid, p_window interval, p_as_of timestamptz default now()) returns int
language sql stable set search_path = public, pg_temp as $$
  select count(*)::int from send_ledger
   where client_id = p_client and lane in ('sequence', 'blast') and sent_at > p_as_of - p_window
$$;
