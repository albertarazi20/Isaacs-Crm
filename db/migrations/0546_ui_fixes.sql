-- UI bug hunt fixes (2026-11-17). Each one was reproduced against the database first.
--   1. The two "Renewal" templates 0522 seeded make money claims this CRM can no longer back ("about 40% of the way
--      through the advance", "eligible for more funds"). Every shop template whose name starts with "Renewal" is
--      archived: no picker or blast offers an archived template, and app.template_may_auto_send never sends one.
--   1. The alert bell counts only what the app still writes. Alerts of the removed features (deals, lenders, money,
--      win-back, trust: approval_landed, approval_expired, funding_proposed, ask_manager, kickback, stale_deal,
--      late_payout, registration, trust, ...) are marked read, and stamped as emailed so the hourly alert email
--      does not send them either. The live kinds: application_signed (src/lib/docs/apply.ts), file_complete (0543),
--      brought_in (0540), bounce_spike (0506), template_paused (src/lib/alerts/feed.ts lists it).
--   2. undo_hand_off puts the merchant back in the bucket the hand-off took them out of, at the same next step (the
--      sequence does not restart). The follow-up for tomorrow is only for a merchant with no bucket to go back to.
--   5. A two-letter state is stored in capitals: "ny" and "NY" were two different states. The app now saves states
--      trimmed and in capitals (src/lib/data/schemas.ts, src/lib/leads); this fixes the ones already saved.

update templates set archived = true
 where owner_id is null and name like 'Renewal%' and not archived;

update user_alerts set read_at = coalesce(read_at, now()), emailed_at = coalesce(emailed_at, created_at)
 where (read_at is null or emailed_at is null)
   and kind not in ('application_signed', 'file_complete', 'brought_in', 'bounce_spike', 'template_paused');

-- 2, on top of 0540's version: the re-enrolment is new, the rest is unchanged.
create or replace function public.undo_hand_off(p_client uuid) returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare c clients; old enrollments; e enrollments; today_local date;
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

  -- the enrolment this hand-off stopped (hand_off stops it in the same moment it stamps brought_in_at), if its bucket
  -- is still in use and nothing else closed the chase meanwhile (an opt-out, a bounce, do not contact)
  select en.* into old
    from enrollments en join buckets b on b.id = en.bucket_id
   where en.client_id = p_client and en.stop_reason = 'brought_in' and en.stopped_at >= c.brought_in_at and b.active
   order by en.stopped_at desc, en.entered_at desc
   limit 1;
  if found and not app.chase_closed(p_client) then
    e := enroll_in_bucket(p_client, old.bucket_id, 'moved');
    today_local := (now() at time zone app.client_timezone(c))::date;
    -- carry on where it stopped: the same next step on its own day (today when that day passed during the hand-off),
    -- and the same start, so the later steps keep their days
    update enrollments
       set next_step = old.next_step, steps_sent = old.steps_sent, entered_at = old.entered_at,
           next_due_on = case when old.next_due_on is null then null else greatest(old.next_due_on, today_local) end,
           paused = old.paused, resume_on = old.resume_on, last_outbox_id = old.last_outbox_id
     where id = e.id;
    return c.brought_in_at;
  end if;

  -- no bucket to go back to: back on the rep's list with one follow-up for tomorrow, unless one is already open
  if not exists (select 1 from timers where client_id = p_client and done_at is null and kind = 'follow_up') then
    insert into timers (user_id, client_id, kind, due_on, note)
    values (c.user_id, p_client, 'follow_up', current_date + 1, 'Hand-off undone — pick the next step');
  end if;
  return c.brought_in_at;
end $$;
revoke execute on function public.undo_hand_off(uuid) from public;
grant execute on function public.undo_hand_off(uuid) to isaac_app;

update clients set state = upper(btrim(state))
 where btrim(state) ~ '^[A-Za-z]{2}$' and state <> upper(btrim(state));
