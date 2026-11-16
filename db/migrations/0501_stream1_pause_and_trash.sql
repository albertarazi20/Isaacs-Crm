-- Stream 1, S1-2: Pause and Delete reach the outbox.
--   * trash_client ends the merchant's live enrolment and win-back membership and cancels every queued email to them,
--     whatever the lane. The worker also refuses a trashed merchant's row it finds later (belt and braces).
--   * enroll_in_bucket refuses a merchant in the trash: nothing re-opens a chase on a deleted lead.
--   * set_enrollment_paused is the one way to pause or resume: the enrolment flag, and the queued bucket emails are
--     held (not_before pushed, last_error 'paused') or released (not_before now) with it. The worker re-checks the
--     flag right before sending, so a pause between the engine queuing a step and the window opening still holds it.

create or replace function public.trash_client(p_client uuid)
returns void
language plpgsql set search_path = public, pg_temp as $$
declare c clients;
begin
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from trashed_clients where client_id = p_client) then
    return;
  end if;
  -- now() is the transaction's start, so the closed timers and the trash row share one timestamp.
  update timers set done_at = now(), done_reason = 'cancelled' where client_id = p_client and done_at is null;
  update clients set scheduled_call_at = null where id = p_client;
  -- a deleted merchant gets no more mail: the chase ends and every queued email is cancelled
  update enrollments set stopped_at = now(), stop_reason = 'removed' where client_id = p_client and stopped_at is null;
  update winback_members set status = 'stopped', stop_reason = 'trashed'
   where client_id = p_client and status in ('waiting', 'active');
  update outbox set status = 'cancelled', skip_reason = 'trashed' where client_id = p_client and status = 'queued';
  insert into trashed_clients (client_id, user_id, trashed_at) values (p_client, c.user_id, now());
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Moved to trash');
end $$;

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
  select coalesce(min(day_offset), 0) into first_offset from bucket_steps where bucket_id = p_bucket;
  insert into enrollments (user_id, client_id, bucket_id, next_step, next_due_on)
  values (c.user_id, p_client, p_bucket, 1, today_local + first_offset)
  returning * into e;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Moved to bucket ' || (select name from buckets where id = p_bucket));
  return e;
end $$;

-- A pause with a date on it: the engine resumes the enrolment by itself on that day (a merchant's "not now until
-- January", S1-6). Null = paused by hand until someone resumes it.
alter table enrollments add column resume_on date;
create index enrollments_resume_idx on enrollments (resume_on) where stopped_at is null and paused and resume_on is not null;

-- May the caller act on this merchant? The owner connection (jobs) and managers always; a rep on their own book.
-- The security-definer functions below read past row security, so this is the check row security would have made.
create function app.can_touch_client(p_client uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.current_user_id() is null or app.can_see_all()
      or exists (select 1 from clients c where c.id = p_client and c.user_id = app.current_user_id())
$$;
revoke execute on function app.can_touch_client(uuid) from public;
grant execute on function app.can_touch_client(uuid) to isaac_app;

-- Pause or resume a merchant's live enrolment. Returns how many enrolments changed.
create function public.set_enrollment_paused(p_client uuid, p_paused boolean)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; c clients;
begin
  if not app.can_touch_client(p_client) then raise exception 'client not found' using errcode = 'P0002'; end if;
  select * into c from clients where id = p_client;
  if not found then raise exception 'client not found' using errcode = 'P0002'; end if;
  update enrollments set paused = p_paused, resume_on = case when p_paused then resume_on else null end
   where client_id = p_client and stopped_at is null and paused is distinct from p_paused;
  get diagnostics n = row_count;
  if n = 0 then return 0; end if;
  if p_paused then
    update outbox set not_before = greatest(not_before, now() + interval '1 hour'), last_error = 'paused'
     where client_id = p_client and status = 'queued' and lane = 'sequence' and source like 'bucket:%';
    insert into activities (user_id, client_id, kind, body) values (c.user_id, c.id, 'system', 'Follow-up emails paused');
  else
    update outbox set not_before = now(), last_error = null
     where client_id = p_client and status = 'queued' and lane = 'sequence' and source like 'bucket:%' and last_error = 'paused';
    insert into activities (user_id, client_id, kind, body) values (c.user_id, c.id, 'system', 'Follow-up emails resumed');
  end if;
  return n;
end $$;
revoke execute on function public.set_enrollment_paused(uuid, boolean) from public;
grant execute on function public.set_enrollment_paused(uuid, boolean) to isaac_app;
