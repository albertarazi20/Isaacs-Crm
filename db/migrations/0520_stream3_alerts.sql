-- Stream 3 (docs/AUTOMATION-AUDIT.md S3-2, S3-7, S3-8, S3-9): the knobs the alert generators and the retention sweep
-- read, the policy a person accepts once, one helper every generator writes alerts through, and the one alert that
-- is a trigger (ops kicked a file back). The generators themselves live in src/lib/system/alerts.ts.

alter table shop_settings
  add column stale_deal_days int not null default 3 check (stale_deal_days between 1 and 60),
  add column document_retention_days int not null default 730 check (document_retention_days between 30 and 3650),
  -- the win-back first line Claude drafts: 'auto' merges it as drafted, 'review' waits for a manager's OK
  add column winback_opener_mode text not null default 'review' check (winback_opener_mode in ('auto', 'review'));

-- Plan §14.7: the anti-backdoor policy, accepted once per person. The first-login gate page is for the design phase;
-- the column and the function are what it will call.
alter table app_users add column policy_accepted_at timestamptz;

create function public.accept_policy() returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := app.current_user_id(); v_at timestamptz;
begin
  if me is null then raise exception 'sign in first' using errcode = '22023'; end if;
  update app_users set policy_accepted_at = coalesce(policy_accepted_at, now()) where id = me
  returning policy_accepted_at into v_at;
  if not found then raise exception 'user not found' using errcode = 'P0002'; end if;
  return v_at;
end $$;
revoke execute on function public.accept_policy() from public;
grant execute on function public.accept_policy() to isaac_app;

-- One alert row, once: the dedupe key makes a repeat a no-op. True when a row was written. Definer: anyone may write a
-- row for anyone (the insert policy says so), but ON CONFLICT would also apply the reader's SELECT policy to the new
-- row, and ops writing the rep's alert is exactly the case this exists for.
create function app.alert(p_user uuid, p_kind text, p_client uuid, p_deal uuid, p_title text, p_body text, p_href text, p_dedupe text)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if p_user is null then return false; end if;
  insert into user_alerts (user_id, kind, client_id, deal_id, title, body, href, dedupe_key)
  values (p_user, p_kind, p_client, p_deal, left(p_title, 200), left(coalesce(p_body, ''), 1000), coalesce(p_href, ''), p_dedupe)
  on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke execute on function app.alert(uuid, text, uuid, uuid, text, text, text, text) from public;
grant execute on function app.alert(uuid, text, uuid, uuid, text, text, text, text) to isaac_app;

-- Every manager hears the same thing: one row each.
create function app.alert_managers(p_kind text, p_client uuid, p_deal uuid, p_title text, p_body text, p_href text, p_dedupe text)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare m uuid; n int := 0;
begin
  for m in select app.manager_ids() loop
    if app.alert(m, p_kind, p_client, p_deal, p_title, p_body, p_href, p_dedupe) then n := n + 1; end if;
  end loop;
  return n;
end $$;
revoke execute on function app.alert_managers(text, uuid, uuid, text, text, text, text) from public;
grant execute on function app.alert_managers(text, uuid, uuid, text, text, text, text) to isaac_app;

-- Ops kicked a file back: the rep hears about it at once (S3-2 'kickback'). Fires under whoever kicked it back; the
-- user_alerts insert policy lets anyone write a row for anyone.
create function app.deal_kicked_back() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare biz text;
begin
  if new.ops_status = 'kicked_back' and old.ops_status is distinct from 'kicked_back' then
    select business_name into biz from clients where id = new.client_id;
    perform app.alert(new.user_id, 'kickback', new.client_id, new.id,
      'Ops kicked back ' || coalesce(biz, 'D-' || new.number) || ': ' || replace(coalesce(new.kickback_reason, 'other'), '_', ' '),
      new.kickback_note, '/deals/' || new.id, 'kickback:' || new.id || ':' || new.kickback_count);
  end if;
  return new;
end $$;
create trigger deals_kickback_alert after update of ops_status on deals for each row execute function app.deal_kicked_back();
