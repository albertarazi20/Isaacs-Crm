-- 0593: a bucket can send one reminder every day at a time the shop sets, in each merchant's own time.
-- shop_settings.daily_reminder_minute: minutes after local midnight (600 = 10:00 AM), 6:00 AM to 8:00 PM.
-- buckets.daily_template_id: when set, every live member gets that template once a day (every day but Saturday) until
-- they leave the bucket; the bucket's step list is not used while it is set. Becoming a member of such a bucket makes
-- the first reminder due today (enroll_in_bucket, the 0543 version with that one change).
alter table shop_settings add column if not exists daily_reminder_minute int not null default 600
  check (daily_reminder_minute between 360 and 1200);
alter table buckets add column if not exists daily_template_id uuid references templates (id) on delete set null;

create or replace function public.enroll_in_bucket(p_client uuid, p_bucket uuid, p_reason text default 'moved')
returns enrollments
language plpgsql set search_path = public, pg_temp as $$
declare c clients; e enrollments; first_offset int; today_local date; v_key text; v_name text; v_daily boolean;
begin
  select * into c from clients where id = p_client for update;
  if not found then raise exception 'client not found' using errcode = 'P0002'; end if;
  if exists (select 1 from trashed_clients where client_id = p_client) then
    raise exception 'That merchant is in the trash — restore it first' using errcode = '22023';
  end if;
  if c.brought_in_at is not null then
    raise exception 'That merchant was handed off. Undo the hand-off first.' using errcode = '22023';
  end if;
  select key, name, daily_template_id is not null into v_key, v_name, v_daily from buckets where id = p_bucket and active;
  if not found then raise exception 'bucket not found' using errcode = 'P0002'; end if;
  -- already there: nothing to do
  select * into e from enrollments where client_id = p_client and bucket_id = p_bucket and stopped_at is null;
  if found then return e; end if;
  update enrollments set stopped_at = now(), stop_reason = p_reason
   where client_id = p_client and stopped_at is null;
  -- queued steps of the old bucket must not fire, unless its sequence simply ran out: then they are its last step
  if p_reason <> 'sequence_done' then
    update outbox set status = 'cancelled', skip_reason = 'stopped'
     where client_id = p_client and status = 'queued' and lane = 'sequence' and source like 'bucket:%';
  end if;
  today_local := (now() at time zone app.client_timezone(c))::date;
  select min(day_offset) into first_offset from bucket_steps where bucket_id = p_bucket;
  insert into enrollments (user_id, client_id, bucket_id, next_step, next_due_on)
  values (c.user_id, p_client, p_bucket, 1,
          case when v_daily then today_local when first_offset is null then null else today_local + first_offset end)
  returning * into e;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Moved to bucket ' || v_name);
  -- the file is complete: the rep's cue to hand off, once per merchant
  if v_key = 'ready_for_ops' then
    perform app.alert(c.user_id, 'file_complete', p_client, null,
                      coalesce(nullif(btrim(c.business_name), ''), 'A merchant') || ' is ready to hand off',
                      'Every required document is in. Check the file, then press Hand off.',
                      '/clients/' || p_client::text, 'file_complete:' || p_client::text);
  end if;
  return e;
end $$;
