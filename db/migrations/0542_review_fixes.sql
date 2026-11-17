-- Fixes from the security review of 2026-11-17.
--
-- 1. The AI daily cap counted only the runs the caller could read. ai_runs is readable by managers only, so for a rep
--    the day's spend always read 0 and a rep was never stopped by the cap. The spend is shop-wide: it is summed with
--    the owner's rights. The function returns one number and takes no input.
create or replace function app.ai_spent_today_cents() returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(cost_cents), 0) from ai_runs where created_at > now() - interval '24 hours'
$$;
revoke execute on function app.ai_spent_today_cents() from public;
grant execute on function app.ai_spent_today_cents() to isaac_app;

-- 2. A rep could read only the emails tied to their own deals; deals are gone, so a merchant's replies (which carry
--    client_id and no deal) were visible to managers only. A rep now reads the emails of the merchants they can see:
--    the inner select runs under the rep's own row security on clients.
drop policy inbound_emails_read on inbound_emails;
create policy inbound_emails_read on inbound_emails for select to isaac_app
  using (app.can_see_all()
         or exists (select 1 from deals d where d.id = deal_id and d.user_id = app.current_user_id())
         or (client_id is not null and app.is_ops_deal(client_id))
         or (client_id is not null and exists (select 1 from clients c where c.id = client_id)));
