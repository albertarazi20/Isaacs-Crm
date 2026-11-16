-- Merchant replies, bounces, complaints and unsubscribes: the signals that stop a sequence and put a merchant at the
-- top of the rep's list. Email only — texting is parked (owner, 2026-11-15).

-- "They wrote back and nobody has answered." Set by an inbound merchant email, cleared by the rep's next call/text/email.
alter table clients
  add column reply_waiting_since timestamptz,
  add column reply_waiting_subject text not null default '';
create index clients_reply_waiting_idx on clients (user_id, reply_waiting_since) where reply_waiting_since is not null;

create function public.record_merchant_reply(p_client uuid, p_subject text, p_snippet text, p_from text, p_stop boolean default false)
returns void
language plpgsql set search_path = public, pg_temp as $$
declare c clients;
begin
  select * into c from clients where id = p_client;
  if not found then return; end if;
  update clients set reply_waiting_since = coalesce(reply_waiting_since, now()),
                     reply_waiting_subject = left(coalesce(p_subject, ''), 200),
                     last_contact_at = now()
   where id = p_client;
  perform stop_enrollment(p_client, 'replied');
  update winback_members set status = 'replied' where client_id = p_client and status in ('waiting', 'active');
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, c.id, 'email',
          'Merchant replied' || case when coalesce(p_subject, '') <> '' then ': ' || left(p_subject, 120) else '' end
          || case when coalesce(p_snippet, '') <> '' then ' — ' || left(p_snippet, 240) else '' end
          || case when p_from <> '' then ' (' || lower(p_from) || ')' else '' end);
  if p_stop then perform opt_out(p_client, 'email', 'stop_reply', left(coalesce(p_snippet, ''), 200)); end if;
end $$;

-- The rep's own touch answers the reply. System rows (the reply itself, opt-outs) have no current user and do not.
create function app.activity_clears_reply() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.kind in ('call', 'text', 'email') and app.current_user_id() is not null then
    update clients set reply_waiting_since = null, reply_waiting_subject = ''
     where id = new.client_id and reply_waiting_since is not null;
  end if;
  return new;
end $$;
create trigger activities_clear_reply after insert on activities for each row execute function app.activity_clears_reply();

-- What the provider told us about a sent email.
alter table outbox
  add column delivery_status text check (delivery_status in ('delivered', 'bounced', 'soft_bounced', 'complained')),
  add column delivery_note text not null default '';
create index outbox_provider_idx on outbox (provider, provider_id) where provider_id is not null;

-- A bounce or complaint on one of our emails. Hard bounce: suppress the address, stop the chase, flag the merchant.
-- Complaint: a full opt-out. Returns the merchant, or null when the email was not one of ours.
create function public.record_delivery_event(p_provider text, p_provider_id text, p_event text, p_note text default '')
returns uuid
language plpgsql set search_path = public, pg_temp as $$
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
    insert into suppressions (channel, key_hash, display, reason, note, client_id)
    values ('email', app.suppression_key(o.to_address), lower(o.to_address), 'hard_bounce', left(coalesce(p_note, ''), 200), c.id)
    on conflict (channel, key_hash) do nothing;
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
end $$;

-- Every webhook we accept, once. The unique key is the provider's own event id, so a retry is a no-op.
create table webhook_events (
  id bigint generated always as identity primary key,
  provider text not null,
  event_id text not null,
  type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  handled_at timestamptz,
  result text not null default '',
  unique (provider, event_id)
);

-- Reply alerts to the rep ride the same once-a-day ledger as the other reminders.
alter table reminders_sent drop constraint reminders_sent_kind_check;
alter table reminders_sent add constraint reminders_sent_kind_check
  check (kind in ('digest', 'call', 'new_lead', 'weekly', 'reply'));
