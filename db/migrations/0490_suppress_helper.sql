-- 0480 made the suppression list a manager's to read. An INSERT … ON CONFLICT on a table the caller cannot read is
-- refused by row security (the conflict check needs the select policy), so a rep's opt-out broke. The write goes through
-- one owner-side helper; the callers keep running as the caller, so a rep can still only opt out a merchant they can see.
create function app.suppress(p_channel text, p_key_hash text, p_display text, p_reason text, p_note text, p_client uuid, p_by uuid)
returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into suppressions (channel, key_hash, display, reason, note, client_id, created_by)
  values (p_channel, p_key_hash, p_display, p_reason, coalesce(p_note, ''), p_client, p_by)
  on conflict (channel, key_hash) do nothing
$$;
revoke execute on function app.suppress(text, text, text, text, text, uuid, uuid) from public;
grant execute on function app.suppress(text, text, text, text, text, uuid, uuid) to isaac_app;

CREATE OR REPLACE FUNCTION public.opt_out(p_client uuid, p_channel text, p_reason text, p_note text DEFAULT ''::text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare c clients;
begin
  select * into c from clients where id = p_client;
  if not found then return; end if;
  if p_channel = 'email' then
    update clients set email_opt_out = true where id = p_client;
    if c.email <> '' then
      perform app.suppress('email', app.suppression_key(c.email), lower(c.email), p_reason, p_note, p_client, app.current_user_id());
    end if;
    update outbox set status = 'cancelled', skip_reason = 'suppressed' where client_id = p_client and status = 'queued' and lane in ('sequence', 'blast');
    perform stop_enrollment(p_client, case when p_reason = 'hard_bounce' then 'bounced' else 'opted_out' end);
  elsif p_channel = 'sms' then
    update clients set sms_opt_out = true where id = p_client;
    if c.phone <> '' then
      perform app.suppress('sms', app.suppression_key(regexp_replace(c.phone, '\D', '', 'g')), c.phone, p_reason, p_note, p_client, app.current_user_id());
    end if;
  end if;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, c.id, 'system', 'Opted out of ' || p_channel || ' (' || replace(p_reason, '_', ' ') || ')' ||
          case when btrim(coalesce(p_note, '')) <> '' then ': ' || btrim(p_note) else '' end);
end $function$

;

CREATE OR REPLACE FUNCTION public.record_delivery_event(p_provider text, p_provider_id text, p_event text, p_note text DEFAULT ''::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare o outbox; c clients;
begin
  select * into o from outbox where provider = p_provider and provider_id = p_provider_id limit 1;
  if not found then return null; end if;
  update outbox set delivery_status = case p_event when 'delivered' then 'delivered' when 'hard_bounce' then 'bounced'
                                                   when 'soft_bounce' then 'soft_bounced' when 'complaint' then 'complained' end,
                    delivery_note = left(coalesce(p_note, ''), 300)
   where id = o.id;
  if o.client_id is null then return null; end if;
  select * into c from clients where id = o.client_id;
  if not found then return null; end if;
  if p_event = 'hard_bounce' then
    update clients set email_bounced_at = now() where id = c.id;
    perform app.suppress('email', app.suppression_key(o.to_address), lower(o.to_address), 'hard_bounce', left(coalesce(p_note, ''), 200), c.id, null);
    perform stop_enrollment(c.id, 'bounced');
    update outbox set status = 'cancelled', skip_reason = 'suppressed'
     where client_id = c.id and status = 'queued' and lane in ('sequence', 'blast');
    insert into activities (user_id, client_id, kind, body)
    values (c.user_id, c.id, 'system', 'Email bounced: ' || lower(o.to_address) || case when coalesce(p_note, '') <> '' then ' — ' || left(p_note, 160) else '' end);
  elsif p_event = 'complaint' then
    perform opt_out(c.id, 'email', 'complaint', left(coalesce(p_note, ''), 200));
  elsif p_event = 'soft_bounce' then
    insert into activities (user_id, client_id, kind, body)
    values (c.user_id, c.id, 'system', 'Email delayed (soft bounce): ' || lower(o.to_address) || case when coalesce(p_note, '') <> '' then ' — ' || left(p_note, 160) else '' end);
  end if;
  return c.id;
end $function$

;
