-- Stream 1, S1-14: one monthly nudger for Cold merchants. The Cold bucket's own 30/60/90-day emails (0320) and the
-- win-back cold pool's 0/30/60 steps (0350, src/lib/money/winback.ts) were two nudgers on the same merchant. The
-- bucket keeps no email steps now: it is the parking place, and the win-back cold pool (which enrols every live Cold
-- member nightly) owns the monthly email. Shops that replaced the seeded steps with their own keep theirs.
delete from bucket_steps s
 using buckets b
 where s.bucket_id = b.id and b.key = 'cold' and s.action = 'email'
   and s.template_id in (select id from templates where owner_id is null and name = 'Cold — monthly nudge');

-- A bucket with no steps holds its members without chasing them: enrolling schedules nothing (next_due_on null),
-- so the engine never marks the enrolment finished and the win-back pool keeps seeing a live Cold member.
create or replace function public.enroll_in_bucket(p_client uuid, p_bucket uuid, p_reason text default 'moved')
returns enrollments
language plpgsql set search_path = public, pg_temp as $$
declare c clients; e enrollments; first_offset int; today_local date;
begin
  select * into c from clients where id = p_client for update;
  if not found then raise exception 'client not found' using errcode = 'P0002'; end if;
  if exists (select 1 from trashed_clients where client_id = p_client) then
    raise exception 'That merchant is in the trash — restore it first' using errcode = '22023';
  end if;
  if not exists (select 1 from buckets where id = p_bucket and active) then
    raise exception 'bucket not found' using errcode = 'P0002';
  end if;
  -- already there: nothing to do
  select * into e from enrollments where client_id = p_client and bucket_id = p_bucket and stopped_at is null;
  if found then return e; end if;
  update enrollments set stopped_at = now(), stop_reason = p_reason
   where client_id = p_client and stopped_at is null;
  -- queued steps of the old bucket must not fire
  update outbox set status = 'cancelled', skip_reason = 'stopped'
   where client_id = p_client and status = 'queued' and lane = 'sequence' and source like 'bucket:%';
  today_local := (now() at time zone app.client_timezone(c))::date;
  select min(day_offset) into first_offset from bucket_steps where bucket_id = p_bucket;
  insert into enrollments (user_id, client_id, bucket_id, next_step, next_due_on)
  values (c.user_id, p_client, p_bucket, 1, case when first_offset is null then null else today_local + first_offset end)
  returning * into e;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Moved to bucket ' || (select name from buckets where id = p_bucket));
  return e;
end $$;

-- When the cold pool's last nudge has gone, the merchant's Cold enrolment ends too. refresh_winback_pools re-enrols
-- every live Cold member whose membership is not waiting or active, so without this the pool would start its
-- sequence again the next night and the merchant would get a fourth email the day after the third.
create function app.cold_pool_done() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.pool = 'cold' and new.status = 'stopped' and new.stop_reason = 'sequence_done'
     and (old.status is distinct from new.status) then
    update enrollments e set stopped_at = now(), stop_reason = 'sequence_done'
      from buckets b
     where b.id = e.bucket_id and b.key = 'cold' and e.client_id = new.client_id and e.stopped_at is null;
  end if;
  return new;
end $$;
create trigger winback_cold_done after update of status on winback_members
  for each row execute function app.cold_pool_done();
