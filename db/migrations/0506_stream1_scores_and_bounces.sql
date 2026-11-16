-- Stream 1, S1-7 and S1-8: template scores and the bounce rules.
--   * outbox.template_id — which template an automated email came from, so sent / replied / docs-in / bounce /
--     unsubscribe rates can be counted per template (src/lib/buckets/queries.ts) and a bounce spike can be pinned
--     on the template that caused it.
--   * templates.auto_paused_at — a template that paused itself. template_may_auto_send says no while it is set;
--     a manager's approval clears it (src/lib/buckets/templates.ts).
--   * record_delivery_event — a hard bounce now also opens the rep's "get the right address by phone" task for
--     today (S1-8), and when a template's bounces in the last 7 days reach 10% of at least 20 sends, the template
--     pauses itself, its queued rows are cancelled and every manager gets an alert (S1-7).

alter table outbox add column template_id uuid references templates (id) on delete set null;
create index outbox_template_idx on outbox (template_id, sent_at desc) where template_id is not null;

alter table templates
  add column auto_paused_at timestamptz,
  add column auto_pause_reason text not null default '';

create or replace function app.template_may_auto_send(p_template uuid) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select exists (select 1 from templates t
                  where t.id = p_template and not t.archived and t.auto_paused_at is null
                    and (t.approved or t.owner_id is null))
$$;

CREATE OR REPLACE FUNCTION public.record_delivery_event(p_provider text, p_provider_id text, p_event text, p_note text DEFAULT ''::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare o outbox; c clients; rep app_users; t templates; n_sent int; n_bounced int; m uuid; task_note text;
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
    -- S1-8: the rep gets the right address by phone, today (the rep's day, not the server's)
    select * into rep from app_users where id = c.user_id;
    task_note := 'Email bounced — get the right address by phone';
    insert into timers (user_id, client_id, kind, due_on, note)
    select c.user_id, c.id, 'follow_up', (now() at time zone coalesce(rep.timezone, 'UTC'))::date, task_note
     where not exists (select 1 from timers x where x.client_id = c.id and x.done_at is null and x.note = task_note);
    -- S1-7: a bounce spike on one template pauses that template, not the shop
    if o.template_id is not null then
      select count(*), count(*) filter (where delivery_status = 'bounced') into n_sent, n_bounced
        from outbox where template_id = o.template_id and status = 'sent' and sent_at > now() - interval '7 days';
      if n_sent >= 20 and n_bounced * 100 >= n_sent * 10 then
        select * into t from templates where id = o.template_id and auto_paused_at is null for update;
        if found then
          update templates set auto_paused_at = now(),
                               auto_pause_reason = n_bounced || ' of the last ' || n_sent || ' emails bounced'
           where id = t.id;
          update outbox set status = 'cancelled', skip_reason = 'template_paused'
           where template_id = t.id and status = 'queued';
          for m in select * from app.manager_ids() loop
            insert into user_alerts (user_id, kind, title, body, href, dedupe_key)
            values (m, 'bounce_spike', 'Template paused: ' || t.name,
                    n_bounced || ' of the last ' || n_sent || ' emails from it bounced. Queued sends were cancelled. Check the list, then approve the template again to resume.',
                    '/follow-up', 'bounce_spike:' || t.id || ':' || current_date)
            on conflict do nothing;
          end loop;
        end if;
      end if;
    end if;
  elsif p_event = 'complaint' then
    perform opt_out(c.id, 'email', 'complaint', left(coalesce(p_note, ''), 200));
  elsif p_event = 'soft_bounce' then
    insert into activities (user_id, client_id, kind, body)
    values (c.user_id, c.id, 'system', 'Email delayed (soft bounce): ' || lower(o.to_address) || case when coalesce(p_note, '') <> '' then ' — ' || left(p_note, 160) else '' end);
  end if;
  return c.id;
end $function$;
