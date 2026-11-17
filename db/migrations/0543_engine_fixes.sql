-- Follow-up engine fixes (bug hunt, 2026-11-17). Each one was reproduced against the database first.
--   *  4. A "not now" reply never re-opens the chase for a merchant whose chase is over for good: handed off, opted
--         out, the address suppressed (a bounce lands there), do-not-contact, or in the trash (app.chase_closed).
--   *  5. enroll_in_bucket refuses a handed-off merchant: "Undo the hand-off first".
--   *  6, 11. One pending copy of an automated email per merchant: a partial unique index on outbox (client_id,
--         source) for queued and sending sequence and blast rows, and for sent blast rows too (a blast's source
--         carries its day, so pressing Blast twice is the same row). src/lib/send/enqueue.ts inserts with
--         ON CONFLICT DO NOTHING; the engine also locks each enrolment and re-checks it before acting.
--         Sent sequence rows are left out on purpose: step 1 repeats daily with sequences off, and a "not now"
--         revive or a second stay in the same bucket sends step 1 again, all under the same source.
--   *  9. A sequence that runs out moves the merchant to Cold (src/lib/buckets/engine.ts calls enroll_in_bucket with
--         'sequence_done'); enrolling for that reason no longer cancels the old bucket's queued mail, because that
--         mail is the sequence's own last step on its way.
--   * 13. Entering "Ready to hand off" (key ready_for_ops) tells the rep once: a 'file_complete' alert
--         (docs/FOLLOW-UP-SYSTEM.md, decision 1).

-- Is the chase over for good? True when no automated follow-up may start again for this merchant.
create function app.chase_closed(p_client uuid) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    (select c.brought_in_at is not null or c.email_opt_out or c.contact_status = 'dnc'
            or app.is_suppressed('email', c.email)
            or exists (select 1 from trashed_clients tc where tc.client_id = c.id)
       from clients c where c.id = p_client),
    true)
$$;
revoke execute on function app.chase_closed(uuid) from public;
grant execute on function app.chase_closed(uuid) to isaac_app;

-- 5 and 13 (and 9's exception), on top of 0508's version.
create or replace function public.enroll_in_bucket(p_client uuid, p_bucket uuid, p_reason text default 'moved')
returns enrollments
language plpgsql set search_path = public, pg_temp as $$
declare c clients; e enrollments; first_offset int; today_local date; v_key text; v_name text;
begin
  select * into c from clients where id = p_client for update;
  if not found then raise exception 'client not found' using errcode = 'P0002'; end if;
  if exists (select 1 from trashed_clients where client_id = p_client) then
    raise exception 'That merchant is in the trash — restore it first' using errcode = '22023';
  end if;
  if c.brought_in_at is not null then
    raise exception 'That merchant was handed off. Undo the hand-off first.' using errcode = '22023';
  end if;
  select key, name into v_key, v_name from buckets where id = p_bucket and active;
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
  values (c.user_id, p_client, p_bucket, 1, case when first_offset is null then null else today_local + first_offset end)
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

-- 4, on top of 0505's version: only the not_now branch changed.
create or replace function public.apply_reply_tag(p_email uuid, p_tag text, p_confidence numeric, p_quote text,
                                                  p_supported boolean, p_model text, p_revive_days int default null)
returns reply_tags
language plpgsql security definer set search_path = public, pg_temp as $$
declare e inbound_emails; c clients; r reply_tags; rep app_users; b uuid; live uuid; tz text; revive date; task_note text;
        closed boolean;
begin
  select * into e from inbound_emails where id = p_email;
  if not found then raise exception 'email not found' using errcode = 'P0002'; end if;
  if e.client_id is null then raise exception 'that email is not from a merchant' using errcode = '22023'; end if;
  if not app.can_touch_client(e.client_id) then raise exception 'client not found' using errcode = 'P0002'; end if;
  select * into c from clients where id = e.client_id for update;
  if not found then raise exception 'client not found' using errcode = 'P0002'; end if;
  tz := app.client_timezone(c);
  if p_tag = 'not_now' then
    revive := (now() at time zone tz)::date + greatest(1, least(coalesce(p_revive_days, 30), 180));
  end if;
  insert into reply_tags (email_id, client_id, tag, confidence, quote, supported, revive_on, model)
  values (p_email, c.id, p_tag, p_confidence, left(coalesce(p_quote, ''), 300), p_supported, revive, coalesce(p_model, ''))
  on conflict (email_id) do update
    set tag = excluded.tag, confidence = excluded.confidence, quote = excluded.quote, supported = excluded.supported,
        revive_on = excluded.revive_on, model = excluded.model
  returning * into r;

  if p_tag = 'not_now' then
    update clients set revive_on = revive where id = c.id;
    closed := app.chase_closed(c.id);
    select id into live from enrollments where client_id = c.id and stopped_at is null order by entered_at desc limit 1;
    if live is not null then
      update enrollments set paused = true, resume_on = revive, next_step = 1, steps_sent = 0, next_due_on = revive,
                             entered_at = (revive::timestamp at time zone tz)
       where id = live;
    elsif not closed then
      -- the bucket the reply stopped: the chase picks up there again on the day, from step 1 (never for a merchant
      -- whose chase is over: the hand-off, an opt-out or a bounce stopped it, not this reply)
      select bucket_id into b from enrollments e2 join buckets bk on bk.id = e2.bucket_id
       where e2.client_id = c.id and bk.active order by e2.stopped_at desc nulls first, e2.entered_at desc limit 1;
      if b is not null then
        insert into enrollments (user_id, client_id, bucket_id, next_step, next_due_on, paused, resume_on, entered_at)
        values (c.user_id, c.id, b, 1, revive, true, revive, (revive::timestamp at time zone tz));
      end if;
    end if;
    update outbox set status = 'cancelled', skip_reason = 'stopped'
     where client_id = c.id and status = 'queued' and lane in ('sequence', 'blast');
    insert into activities (user_id, client_id, kind, body)
    values (c.user_id, c.id, 'system',
            case when live is null and c.brought_in_at is not null
                   then 'Merchant said not now — already handed off, so no follow-up emails were scheduled'
                 when live is null and closed
                   then 'Merchant said not now — no follow-up emails were scheduled (opted out, address bounced or do not contact)'
                 else 'Merchant said not now — follow-up emails paused until ' || to_char(revive, 'FMMon FMDD, YYYY') end);
  elsif p_tag = 'wrong_person' then
    update clients set wrong_person_at = now() where id = c.id;
    perform stop_enrollment(c.id, 'removed');
    update outbox set status = 'cancelled', skip_reason = 'stopped'
     where client_id = c.id and status = 'queued' and lane in ('sequence', 'blast');
    select * into rep from app_users where id = c.user_id;
    task_note := 'Wrong person on the email — find the right contact';
    insert into timers (user_id, client_id, kind, due_on, note)
    select c.user_id, c.id, 'follow_up', (now() at time zone coalesce(rep.timezone, 'UTC'))::date, task_note
     where not exists (select 1 from timers x where x.client_id = c.id and x.done_at is null and x.note = task_note);
    insert into activities (user_id, client_id, kind, body)
    values (c.user_id, c.id, 'system', 'Merchant replied: wrong person — flagged; find the right contact');
  elsif p_tag = 'stop' then
    if not c.email_opt_out then
      perform opt_out(c.id, 'email', 'stop_reply', left(coalesce(p_quote, ''), 200));
    end if;
  else
    insert into activities (user_id, client_id, kind, body)
    values (c.user_id, c.id, 'system', 'Reply tagged: ' || replace(p_tag, '_', ' ')
            || case when p_supported then '' else ' (the words could not be checked)' end);
  end if;
  return r;
end $$;
revoke execute on function public.apply_reply_tag(uuid, text, numeric, text, boolean, text, int) from public;
grant execute on function public.apply_reply_tag(uuid, text, numeric, text, boolean, text, int) to isaac_app;

-- 6 and 11. Duplicates already on the table first, so the index can be built: an extra queued copy is cancelled; an
-- extra copy already on its way or sent keeps its history under a marked source.
with ranked as (
  select id, status,
         row_number() over (partition by client_id, source
                            order by (status = 'sent') desc, (status = 'sending') desc, created_at, id) as n
    from outbox
   where client_id is not null and lane in ('sequence', 'blast')
     and (status in ('queued', 'sending') or (lane = 'blast' and status = 'sent'))
)
update outbox o
   set status = case when r.status = 'queued' then 'cancelled' else o.status end,
       skip_reason = case when r.status = 'queued' then 'duplicate' else o.skip_reason end,
       source = case when r.status = 'queued' then o.source else o.source || ':dup:' || o.id::text end
  from ranked r
 where r.id = o.id and r.n > 1;

create unique index outbox_one_copy_idx on outbox (client_id, source)
  where lane in ('sequence', 'blast') and (status in ('queued', 'sending') or (lane = 'blast' and status = 'sent'));
