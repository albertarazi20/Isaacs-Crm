-- The follow-up system's finish line (docs/FOLLOW-UP-SYSTEM.md, decisions 1 and 3): "Brought in".
--   * clients.brought_in_at / brought_in_by: when the rep handed the merchant off, and who pressed it.
--   * hand_off(client): marks it, ends the chase (enrolment, queued automated mail, open follow-up timers), writes the
--     timeline line and tells the managers once. A second call changes nothing and returns the first time.
--   * undo_hand_off(client): clears the mark and opens one follow-up for tomorrow. It does not re-enrol.
--   * A brought-in merchant never gets automated mail again: a queued sequence or blast row for them is cancelled the
--     moment it is written (the outbox trigger below), and documents arriving later no longer re-bucket them.
--   * "Ready for ops" is shown as "Ready to hand off" (the key stays), and Cold gets its monthly nudge back (0508
--     took the 30/60/90-day emails out when win-back owned them; win-back is gone).

alter table clients
  add column brought_in_at timestamptz,
  add column brought_in_by uuid references app_users (id) on delete set null;
create index clients_brought_in_idx on clients (brought_in_at) where brought_in_at is not null;
create index clients_brought_in_by_idx on clients (brought_in_by) where brought_in_by is not null;

-- a new reason an enrolment ends
alter table enrollments drop constraint enrollments_stop_reason_check;
alter table enrollments add constraint enrollments_stop_reason_check
  check (stop_reason in ('replied', 'document_received', 'moved', 'deal_submitted', 'opted_out', 'bounced', 'paused',
                         'sequence_done', 'removed', 'funded', 'dnc', 'brought_in'));

-- Hand a merchant off. Definer: it closes rows on several tables in one step; app.can_touch_client is the check row
-- security would have made (the rep's own merchant, or a manager).
create function public.hand_off(p_client uuid) returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare c clients; v_at timestamptz; v_by text;
begin
  if not app.can_touch_client(p_client) then raise exception 'client not found' using errcode = 'P0002'; end if;
  select * into c from clients where id = p_client for update;
  if not found then raise exception 'client not found' using errcode = 'P0002'; end if;
  if exists (select 1 from trashed_clients where client_id = p_client) then
    raise exception 'That merchant is in the trash — restore it first' using errcode = '22023';
  end if;
  -- already handed off: the first time stands
  if c.brought_in_at is not null then return c.brought_in_at; end if;

  update clients set brought_in_at = now(), brought_in_by = app.current_user_id(), scheduled_call_at = null
   where id = p_client
  returning brought_in_at into v_at;
  -- the chase ends: the live enrolment and its queued steps (0320), then any other queued automated email
  perform stop_enrollment(p_client, 'brought_in');
  update outbox set status = 'cancelled', skip_reason = 'brought_in'
   where client_id = p_client and status = 'queued' and lane in ('sequence', 'blast');
  update timers set done_at = now(), done_reason = 'completed' where client_id = p_client and done_at is null;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Handed off — brought in');
  select nullif(btrim(u.name), '') into v_by from app_users u where u.id = coalesce(app.current_user_id(), c.user_id);
  perform app.alert_managers('brought_in', p_client, null,
                             c.business_name || ' was brought in',
                             'Handed off' || coalesce(' by ' || v_by, '') || '. The file is complete and out of the follow-up buckets.',
                             '/clients/' || p_client::text, 'brought_in:' || p_client::text);
  return v_at;
end $$;
revoke execute on function public.hand_off(uuid) from public;
grant execute on function public.hand_off(uuid) to isaac_app;

-- Take a hand-off back. Returns the time that was cleared, or null when the merchant was not handed off.
create function public.undo_hand_off(p_client uuid) returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare c clients;
begin
  if not app.can_touch_client(p_client) then raise exception 'client not found' using errcode = 'P0002'; end if;
  select * into c from clients where id = p_client for update;
  if not found then raise exception 'client not found' using errcode = 'P0002'; end if;
  if c.brought_in_at is null then return null; end if;
  if exists (select 1 from trashed_clients where client_id = p_client) then
    raise exception 'That merchant is in the trash — restore it first' using errcode = '22023';
  end if;
  update clients set brought_in_at = null, brought_in_by = null where id = p_client;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Hand-off undone');
  -- back on the rep's list: one follow-up for tomorrow, unless one is already open. Not re-enrolled in a bucket.
  if not exists (select 1 from timers where client_id = p_client and done_at is null and kind = 'follow_up') then
    insert into timers (user_id, client_id, kind, due_on, note)
    values (c.user_id, p_client, 'follow_up', current_date + 1, 'Hand-off undone — pick the next step');
  end if;
  return c.brought_in_at;
end $$;
revoke execute on function public.undo_hand_off(uuid) from public;
grant execute on function public.undo_hand_off(uuid) to isaac_app;

-- A brought-in merchant gets no automated mail. Every way a row becomes 'queued' (written new, or put back by the
-- worker's defer) passes here, so the worker never finds one to send; one-to-one mail (intake, reply) still goes.
create function app.outbox_skips_brought_in() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'queued' and new.lane in ('sequence', 'blast') and new.client_id is not null
     and exists (select 1 from clients c where c.id = new.client_id and c.brought_in_at is not null) then
    new.status := 'cancelled';
    new.skip_reason := 'brought_in';
  end if;
  return new;
end $$;
revoke execute on function app.outbox_skips_brought_in() from public;
grant execute on function app.outbox_skips_brought_in() to isaac_app;
create trigger outbox_brought_in before insert or update of status on outbox
  for each row execute function app.outbox_skips_brought_in();

-- A document that arrives after the hand-off is filed, but it does not put the merchant back in a bucket.
create or replace function app.rebucket_by_stips(p_client uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare want text; b uuid; cur uuid;
begin
  if exists (select 1 from clients where id = p_client and brought_in_at is not null) then return; end if;
  want := app.stips_bucket(p_client);
  if want is null then return; end if;
  select id into b from buckets where key = want;
  select bucket_id into cur from enrollments where client_id = p_client and stopped_at is null limit 1;
  -- only move between system buckets; a rep's own bucket is theirs to manage
  if cur is not null and not exists (select 1 from buckets where id = cur and key is not null) then return; end if;
  if cur is distinct from b then perform enroll_in_bucket(p_client, b, 'document_received'); end if;
end $$;

-- The last system bucket is the rep's cue, not a queue for ops.
update buckets set name = 'Ready to hand off' where key = 'ready_for_ops';

-- Cold's monthly nudge returns: the same three steps 0320 seeded and 0508 removed, only where the bucket has no
-- email step now (a shop that wrote its own keeps them). Members parked there with nothing scheduled get the first.
do $$
declare b uuid; t_cold uuid; base int;
begin
  select id into b from buckets where key = 'cold';
  select id into t_cold from templates where owner_id is null and name = 'Cold — monthly nudge' order by created_at limit 1;
  if b is null or t_cold is null then return; end if;
  if exists (select 1 from bucket_steps where bucket_id = b and action = 'email') then return; end if;
  select coalesce(max(step_no), 0) into base from bucket_steps where bucket_id = b;
  insert into bucket_steps (bucket_id, step_no, day_offset, template_id, action) values
    (b, base + 1, 30, t_cold, 'email'), (b, base + 2, 60, t_cold, 'email'), (b, base + 3, 90, t_cold, 'email');
  update enrollments set next_step = base + 1, next_due_on = greatest(current_date + 1, entered_at::date + 30)
   where bucket_id = b and stopped_at is null and next_due_on is null;
end $$;
