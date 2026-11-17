-- Second review of the follow-up engine (2026-11-17). Each finding was read against the code first.
--   1. undo_hand_off re-checks the checklist after putting the merchant back: documents that came in (or were
--      removed) while the file was handed off move them to the right bucket.
--   2. undo_hand_off resumes AT the step the hand-off cancelled (the engine had already counted it as sent).
--   3. Re-bucketing never re-opens a closed chase (app.chase_closed: handed off, opted out, bounced, do not contact,
--      trash), keeps a "not now" pause when it moves a merchant, moves only into an active bucket, and a box that is
--      UN-ticked (a file deleted, relabelled or rejected) never enrols a merchant who has no live bucket: replied,
--      removed or finished merchants stay with the person handling them.
--   4. A file the safety scan rejects un-ticks the box it backed, like a deleted one.
--   5. The statement clock slides the window: each month it asks for, the oldest month still missing drops off, so a
--      checklist keeps its size and a merchant is never chased for a statement no lender wants any more.

-- 3. The one re-bucketing rule. p_enrol: may a merchant with no live bucket be put in one (true when a box is ticked
-- or a checklist is first written; false when one is un-ticked).
drop function if exists app.rebucket_by_stips(uuid);
create function app.rebucket_by_stips(p_client uuid, p_enrol boolean default true) returns void
language plpgsql set search_path = public, pg_temp as $$
declare want text; b uuid; cur enrollments; e enrollments;
begin
  if app.chase_closed(p_client) then return; end if;
  want := app.stips_bucket(p_client);
  if want is null then return; end if;
  select id into b from buckets where key = want and active;
  if b is null then return; end if;
  select * into cur from enrollments where client_id = p_client and stopped_at is null
   order by entered_at desc limit 1;
  if cur.id is null and not p_enrol then return; end if;
  -- only move between system buckets; a rep's own bucket is theirs to manage
  if cur.id is not null and not exists (select 1 from buckets where id = cur.bucket_id and key is not null) then
    return;
  end if;
  if cur.bucket_id is not distinct from b then return; end if;
  e := enroll_in_bucket(p_client, b, 'document_received');
  -- a "not now" (or a rep's) pause holds in the new bucket
  if cur.paused then
    update enrollments set paused = true, resume_on = cur.resume_on,
                           next_due_on = coalesce(cur.resume_on, next_due_on)
     where id = e.id;
  end if;
end $$;

create or replace function app.stips_changed() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and (new.received_at is distinct from old.received_at or new.required is distinct from old.required) then
    perform app.rebucket_by_stips(new.client_id, new.received_at is not null or not new.required);
  elsif tg_op = 'INSERT' then
    perform app.rebucket_by_stips(new.client_id, true);
  end if;
  return new;
end $$;

-- 4. Un-filing also follows the safety scan.
create or replace function app.document_unfiled() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if app.unfile_document(old, case when new.deleted_at is not null then 'was deleted'
                                   when new.scan_status in ('infected', 'rejected') then 'failed the safety check'
                                   else 'was relabelled' end) > 0 then
    perform app.rebucket_by_stips(old.client_id, false);
  end if;
  return new;
end $$;
drop trigger if exists documents_unfiled on documents;
create trigger documents_unfiled after update of kind, period, deleted_at, scan_status on documents
  for each row
  when (old.deleted_at is null and (new.deleted_at is not null or new.kind is distinct from old.kind
                                    or new.period is distinct from old.period
                                    or (new.scan_status in ('infected', 'rejected')
                                        and old.scan_status not in ('infected', 'rejected'))))
  execute function app.document_unfiled();

-- 1 and 2, on top of 0546's version.
create or replace function public.undo_hand_off(p_client uuid) returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare c clients; old enrollments; e enrollments; today_local date; lost_step text;
        v_step int; v_sent int; v_due date; v_last uuid;
begin
  if not app.can_touch_client(p_client) then raise exception 'client not found' using errcode = 'P0002'; end if;
  select * into c from clients where id = p_client for update;
  if not found then raise exception 'client not found' using errcode = 'P0002'; end if;
  if c.brought_in_at is null then return null; end if;
  if exists (select 1 from trashed_clients where client_id = p_client) then
    raise exception 'That merchant is in the trash — restore it first' using errcode = '22023';
  end if;
  -- cleared first: enroll_in_bucket refuses a handed-off merchant (0543)
  update clients set brought_in_at = null, brought_in_by = null where id = p_client;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Hand-off undone');

  select en.* into old
    from enrollments en join buckets b on b.id = en.bucket_id
   where en.client_id = p_client and en.stop_reason = 'brought_in' and en.stopped_at >= c.brought_in_at and b.active
   order by en.stopped_at desc, en.entered_at desc
   limit 1;
  if found and not app.chase_closed(p_client) then
    e := enroll_in_bucket(p_client, old.bucket_id, 'moved');
    today_local := (now() at time zone app.client_timezone(c))::date;
    v_step := old.next_step; v_sent := old.steps_sent; v_due := old.next_due_on; v_last := old.last_outbox_id;
    -- the step queued just before the hand-off and cancelled by it never went: it is due again today
    select substring(o.source from ':step:([0-9]+)$') into lost_step
      from outbox o where o.id = old.last_outbox_id and o.status = 'cancelled';
    if lost_step is not null then
      v_step := lost_step::int; v_sent := greatest(old.steps_sent - 1, 0); v_due := today_local; v_last := null;
    end if;
    update enrollments
       set next_step = v_step, steps_sent = v_sent, entered_at = old.entered_at,
           next_due_on = case when v_due is null then null else greatest(v_due, today_local) end,
           paused = old.paused, resume_on = old.resume_on, last_outbox_id = v_last
     where id = e.id;
    -- documents may have come in (or gone) while the file was handed off
    perform app.rebucket_by_stips(p_client, false);
    return c.brought_in_at;
  end if;

  if not exists (select 1 from timers where client_id = p_client and done_at is null and kind = 'follow_up') then
    insert into timers (user_id, client_id, kind, due_on, note)
    values (c.user_id, p_client, 'follow_up', current_date + 1, 'Hand-off undone — pick the next step');
  end if;
  return c.brought_in_at;
end $$;
revoke execute on function public.undo_hand_off(uuid) from public;
grant execute on function public.undo_hand_off(uuid) to isaac_app;

-- 5, on top of 0544's version: the window slides.
create or replace function public.request_new_month_statements(p_today date default current_date)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; want date; m date; n int := 0; added text[]; size_before int; extra int;
begin
  if app.current_user_id() is not null and not app.can_see_all() then
    raise exception 'only a manager can run the statement clock' using errcode = '22023';
  end if;
  want := app.expected_statement_month(p_today, 5);
  for r in
    select c.id as client_id, c.user_id,
           (select max(st.period) from stips st
             where st.client_id = c.id and st.required and st.kind = 'bank_statement') as newest
      from clients c
     where c.brought_in_at is null
       and not exists (select 1 from trashed_clients tc where tc.client_id = c.id)
       and exists (select 1 from enrollments e join buckets b on b.id = e.bucket_id
                    where e.client_id = c.id and e.stopped_at is null and not e.paused
                      and b.key in ('missing_app', 'missing_statements', 'missing_newest', 'missing_id', 'ready_for_ops'))
     order by c.created_at
  loop
    if r.newest is null or r.newest >= want then continue; end if;
    select count(*) into size_before from stips
     where client_id = r.client_id and required and kind = 'bank_statement';
    added := '{}';
    m := greatest((r.newest + interval '1 month')::date, (want - interval '3 months')::date);
    while m <= want loop
      insert into stips (user_id, client_id, kind, period, required)
      values (r.user_id, r.client_id, 'bank_statement', m, true)
      on conflict (client_id, kind, coalesce(period, date '0001-01-01')) do update set required = true
        where not stips.required;
      if found then added := added || to_char(m, 'FMMonth YYYY'); end if;
      m := (m + interval '1 month')::date;
    end loop;
    if cardinality(added) = 0 then continue; end if;
    -- the checklist keeps its size: the oldest months still missing drop off, one for each month asked for
    extra := (select count(*) from stips where client_id = r.client_id and required and kind = 'bank_statement')
             - greatest(size_before, 4);
    if extra > 0 then
      update stips set required = false
       where id in (select id from stips
                     where client_id = r.client_id and required and kind = 'bank_statement' and received_at is null
                       and period < (want - interval '3 months')::date
                     order by period limit extra);
    end if;
    n := n + 1;
    insert into activities (user_id, client_id, kind, body)
    values (r.user_id, r.client_id, 'system',
            'The month turned: asked for the ' || array_to_string(added, ', ') ||
            case when cardinality(added) = 1 then ' statement' else ' statements' end);
    perform app.rebucket_by_stips(r.client_id, true);
  end loop;
  return n;
end $$;
revoke execute on function public.request_new_month_statements(date) from public;
grant execute on function public.request_new_month_statements(date) to isaac_app;
