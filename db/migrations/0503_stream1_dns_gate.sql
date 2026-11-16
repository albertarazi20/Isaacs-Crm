-- Stream 1, S1-4: the DNS gate before automation. A manager runs the SPF / DKIM / DMARC check on the automation
-- domain from Settings → Email (src/lib/send/dns.ts; the result is stored here). The outbox worker uses the Resend
-- branch only while dns_ok is true; otherwise automated mail waits with last_error = 'dns_not_verified', the way it
-- waits for a postal address. Re-running the check overwrites the result; a domain change clears it.
alter table shop_settings
  add column dns_ok boolean not null default false,
  add column dns_checked_at timestamptz,
  add column dns_result jsonb not null default '{}'::jsonb;

create function app.dns_result_clears_on_domain_change() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.automation_from is distinct from old.automation_from then
    new.dns_ok := false;
    new.dns_checked_at := null;
    new.dns_result := '{}'::jsonb;
  end if;
  return new;
end $$;
create trigger shop_settings_dns_reset before update of automation_from on shop_settings
  for each row execute function app.dns_result_clears_on_domain_change();
