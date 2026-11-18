-- 0581: four follow-ups to 0580 ("Stop emails for good"). Every statement is safe on a database with rows: functions are
-- replaced in place (owner, grants and search path kept), one function is new, no table is touched.
--
-- 1. app.hand_stopped_only(client): the merchant is opted out ONLY because a person stopped their emails by hand: the
--    hand-stop flag is set and no suppression for them records a wish of their own (unsubscribe, a STOP reply, a
--    complaint, do-not-contact). The app asks it before skipping an "already opted out" merchant, so an unsubscribe, a
--    STOP or a complaint that arrives after a hand stop still runs the opt-out and is recorded as theirs (a manager's
--    "turn emails back on" is then refused). A caller who cannot see the merchant gets false.
-- 2. app.suppress (0580's version): a hard bounce also takes over a hand-stop row, so turning the emails back on can
--    never lift the block on an address that bounced; and a merchant's own wish replaces a bounce row when the merchant
--    is hand-stopped (so their wish is not lost if they later get a new address).
-- 3. apply_reply_tag (0543's version, one line changed): the AI "stop" tag no longer skips a merchant who is opted out
--    only by a hand stop.
-- 4. merge_clients (0561's version, one block added): a hand stop on either card carries over to the merged one (the
--    earlier of the two, and who set it), so the card keeps saying "emails stopped", not "they unsubscribed".

create function app.hand_stopped_only(p_client uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select c.email_opt_out and c.emails_stopped_at is not null
         and not exists (select 1 from suppressions s
                          where s.channel = 'email' and s.reason in ('unsubscribe', 'stop_reply', 'complaint', 'dnc')
                            and (s.client_id = c.id or (btrim(c.email) <> '' and s.key_hash = app.suppression_key(c.email))))
    from clients c
   where c.id = p_client and (app.current_user_id() is null or app.can_touch_client(c.id))
$$;
revoke execute on function app.hand_stopped_only(uuid) from public;
grant execute on function app.hand_stopped_only(uuid) to isaac_app;

create or replace function app.suppress(p_channel text, p_key_hash text, p_display text, p_reason text, p_note text, p_client uuid, p_by uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if app.current_user_id() is not null and not app.can_see_all() then
    if p_client is null or not app.can_touch_client(p_client) then
      raise exception 'merchant not found' using errcode = 'P0002';
    end if;
    if p_by is not null and p_by is distinct from app.current_user_id() then
      raise exception 'a suppression is recorded under your own name' using errcode = '42501';
    end if;
  end if;
  insert into suppressions (channel, key_hash, display, reason, note, client_id, created_by)
  values (p_channel, p_key_hash, p_display, p_reason, coalesce(p_note, ''), p_client, p_by)
  on conflict (channel, key_hash) do update
     set reason = excluded.reason, note = excluded.note
   where (suppressions.reason = 'manual' and excluded.reason in ('unsubscribe', 'stop_reply', 'complaint', 'dnc', 'hard_bounce'))
      or (suppressions.reason = 'hard_bounce' and excluded.reason in ('unsubscribe', 'stop_reply', 'complaint', 'dnc')
          and exists (select 1 from clients c where c.id = suppressions.client_id and c.emails_stopped_at is not null));
end $$;

-- 3, on top of 0543's version: only the 'stop' branch changed.
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
    if not c.email_opt_out or app.hand_stopped_only(c.id) then
      perform opt_out(c.id, 'email', 'stop_reply', left(coalesce(p_quote, ''), 200));
    end if;
  else
    insert into activities (user_id, client_id, kind, body)
    values (c.user_id, c.id, 'system', 'Reply tagged: ' || replace(p_tag, '_', ' ')
            || case when p_supported then '' else ' (the words could not be checked)' end);
  end if;
  return r;
end $$;

-- 4, on top of 0561's version: only the first update of the kept card changed (see the two emails_stopped_ lines).
create or replace function public.merge_clients(p_keep uuid, p_drop uuid)
 RETURNS clients
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  k clients; d clients;
  n_notes int; n_adv int; n_subs int; n_stips int;
  keep_next date; drop_next date; new_status text; summary text;
  leftover record; has_rows boolean;
begin
  if p_keep is null or p_drop is null or p_keep = p_drop then
    raise exception 'Pick two different merchants to merge' using errcode = '22023';
  end if;
  -- runs as the owner so it can move the tables the app role may only read (offers, applications, link opens...), so
  -- the caller is checked here the way row security would have: the signed-in rep's own cards, or a manager
  if not (app.can_touch_client(p_keep) and app.can_touch_client(p_drop)) then
    raise exception 'merchant not found' using errcode = 'P0002';
  end if;
  -- lock both cards, always in id order, so two merges (or a merge and an edit) can't deadlock
  perform 1 from clients where id = least(p_keep, p_drop) for update;
  perform 1 from clients where id = greatest(p_keep, p_drop) for update;
  select * into k from clients where id = p_keep;
  select * into d from clients where id = p_drop;
  if k.id is null or d.id is null then
    raise exception 'merchant not found' using errcode = 'P0002';
  end if;
  if exists (select 1 from trashed_clients where client_id in (p_keep, p_drop)) then
    raise exception 'That merchant is in the trash — restore it first' using errcode = '22023';
  end if;

  -- the kept card fills its blanks from the other, and keeps the earlier application date
  update clients set
      hot = k.hot or d.hot,
      phone2 = case when btrim(k.phone2) = '' then d.phone2 else k.phone2 end,
      email2 = case when btrim(k.email2) = '' then d.email2 else k.email2 end,
      looking_for = case when btrim(k.looking_for) = '' then d.looking_for else k.looking_for end,
      email_opt_out = k.email_opt_out or d.email_opt_out,
      -- a hand stop on either card holds for the merged one, from the earlier of the two (null is ignored by least)
      emails_stopped_at = least(k.emails_stopped_at, d.emails_stopped_at),
      emails_stopped_by = case when d.emails_stopped_at is not null
                                and (k.emails_stopped_at is null or d.emails_stopped_at < k.emails_stopped_at)
                               then d.emails_stopped_by else k.emails_stopped_by end,
      sms_opt_out = k.sms_opt_out or d.sms_opt_out,
      dba = case when btrim(k.dba) = '' then d.dba else k.dba end,
      contact_name = case when btrim(k.contact_name) = '' then d.contact_name else k.contact_name end,
      phone = case when btrim(k.phone) = '' then d.phone else k.phone end,
      email = case when btrim(k.email) = '' then d.email else k.email end,
      industry = case when btrim(k.industry) = '' then d.industry else k.industry end,
      state = case when btrim(k.state) = '' then d.state else k.state end,
      source = case when btrim(k.source) = '' then d.source else k.source end,
      monthly_revenue_cents = coalesce(k.monthly_revenue_cents, d.monthly_revenue_cents),
      time_in_business_months = coalesce(k.time_in_business_months, d.time_in_business_months),
      application_received_on = case
        when k.application_received_on is null then d.application_received_on
        when d.application_received_on is null then k.application_received_on
        else least(k.application_received_on, d.application_received_on) end
   where id = p_keep;

  -- plain moves
  update client_asks set client_id = p_keep where client_id = p_drop;
  update positions set client_id = p_keep where client_id = p_drop;
  update competing_offers set client_id = p_keep where client_id = p_drop;
  update fundings set client_id = p_keep where client_id = p_drop;
  get diagnostics n_adv = row_count;

  -- stips: a received one beats a missing one; otherwise move, unless the kept card already has that stip
  update stips ks set received_at = ds.received_at, doc_key = ds.doc_key
    from stips ds
   where ks.client_id = p_keep and ds.client_id = p_drop and ks.kind = ds.kind
     and coalesce(ks.period, date '0001-01-01') = coalesce(ds.period, date '0001-01-01')
     and ks.received_at is null and ds.received_at is not null;
  update stips ds set client_id = p_keep
   where ds.client_id = p_drop
     and not exists (select 1 from stips ks where ks.client_id = p_keep and ks.kind = ds.kind
                       and coalesce(ks.period, date '0001-01-01') = coalesce(ds.period, date '0001-01-01'));
  get diagnostics n_stips = row_count;

  -- submissions to the same funder on the same day are the same fact: the kept card's copy stays, the other goes
  with moved as (
    update submissions s set client_id = p_keep
     where s.client_id = p_drop
       and not exists (select 1 from submissions x where x.client_id = p_keep and x.funder_id = s.funder_id
                         and x.sent_on = s.sent_on)
    returning s.id)
  select count(*) into n_subs from moved;
  update offers set client_id = p_keep
   where client_id = p_drop and submission_id in (select id from submissions where client_id = p_keep);
  update timers set client_id = p_keep
   where client_id = p_drop and done_at is null and kind = 'chase'
     and submission_id in (select id from submissions where client_id = p_keep);

  -- a booked call survives if the kept card has none
  if d.scheduled_call_at is not null and k.scheduled_call_at is null then
    update clients set scheduled_call_at = d.scheduled_call_at where id = p_keep;
    update timers set client_id = p_keep
     where client_id = p_drop and done_at is null and kind = 'scheduled_call';
  end if;

  -- the history comes with it (stage moves and timer lines belong to the other card's story, so they stay behind)
  insert into activities (user_id, client_id, kind, body, occurred_at, created_at)
  select a.user_id, p_keep, a.kind, a.body, a.occurred_at, a.created_at
    from activities a
   where a.client_id = p_drop and a.kind not in ('stage_change', 'timer');
  get diagnostics n_notes = row_count;

  -- never lose a date: if the other card had something due earlier, the kept card gets a follow-up that day
  select min(due_on) into drop_next from timers where client_id = p_drop and done_at is null;
  select min(due_on) into keep_next from timers where client_id = p_keep and done_at is null;
  if drop_next is not null and (keep_next is null or drop_next < keep_next) then
    if exists (select 1 from timers where client_id = p_keep and done_at is null and kind = 'follow_up') then
      update timers set due_on = drop_next
       where client_id = p_keep and done_at is null and kind = 'follow_up';
    else
      insert into timers (user_id, client_id, kind, due_on, note)
      values (k.user_id, p_keep, 'follow_up', drop_next, 'From the merged card');
    end if;
  end if;

  -- everything else that hangs off the other card moves too (0561): without this, `delete from clients` below would
  -- cascade away its documents, follow-up enrolment, application, approvals, offers and mail history.

  -- one live follow-up enrolment per merchant: the kept card's wins, and the other's is stopped with its queued steps
  if k.brought_in_at is not null or exists (select 1 from enrollments where client_id = p_keep and stopped_at is null) then
    perform stop_enrollment(p_drop, 'removed');
  end if;
  update enrollments set client_id = p_keep where client_id = p_drop;

  -- queued mail that would double up on a copy the kept card already has is cancelled; a sent blast that clashes is
  -- renamed so both records survive. The rest moves.
  update outbox o set status = 'cancelled', skip_reason = 'merged'
   where o.client_id = p_drop and o.status = 'queued' and o.lane in ('sequence', 'blast')
     and exists (select 1 from outbox x where x.client_id = p_keep and x.source = o.source
                    and x.lane in ('sequence', 'blast')
                    and (x.status in ('queued', 'sending') or (x.lane = 'blast' and x.status = 'sent')));
  update outbox o set source = o.source || ':merged:' || o.id
   where o.client_id = p_drop and o.lane in ('sequence', 'blast')
     and (o.status in ('queued', 'sending') or (o.lane = 'blast' and o.status = 'sent'))
     and exists (select 1 from outbox x where x.client_id = p_keep and x.source = o.source
                    and x.lane in ('sequence', 'blast')
                    and (x.status in ('queued', 'sending') or (x.lane = 'blast' and x.status = 'sent')));
  update outbox set client_id = p_keep where client_id = p_drop;

  -- one open approval per merchant: the kept card's wins; the other is closed (its queued emails cancelled), not lost
  if exists (select 1 from approvals where client_id = p_keep and status = 'open') then
    update outbox set status = 'cancelled', skip_reason = 'merged'
     where lane = 'approval' and status = 'queued'
       and app.approval_of(source) in (select id from approvals where client_id = p_drop and status = 'open');
    update approvals set status = 'closed', closed_at = now(), closed_by = app.current_user_id(),
           closed_reason = 'Merged into another card', emails = 'stopped', next_email_at = null, next_step = null
     where client_id = p_drop and status = 'open';
  end if;
  update approvals set client_id = p_keep where client_id = p_drop;

  update winback_members dw set status = 'stopped', stop_reason = 'removed'
   where dw.client_id = p_drop and dw.status in ('waiting', 'active')
     and exists (select 1 from winback_members kw where kw.client_id = p_keep and kw.pool = dw.pool
                    and kw.status in ('waiting', 'active'));
  update winback_members set client_id = p_keep where client_id = p_drop;

  update backdoor_reports r set client_id = p_keep
   where r.client_id = p_drop
     and not exists (select 1 from backdoor_reports x where x.client_id = p_keep and x.reported_on = r.reported_on);

  -- documents: a live file the kept card already has (same bytes) is not a second copy: the other is moved over as
  -- deleted, and whatever pointed at it (a stip, the signed application) now points at the kept card's copy
  update stips s set doc_key = kd.storage_key
    from documents dd join documents kd on kd.client_id = p_keep and kd.sha256 = dd.sha256 and kd.deleted_at is null
   where dd.client_id = p_drop and dd.deleted_at is null and s.doc_key = dd.storage_key
     and s.client_id in (p_keep, p_drop);
  update applications a set document_id = kd.id
    from documents dd join documents kd on kd.client_id = p_keep and kd.sha256 = dd.sha256 and kd.deleted_at is null
   where dd.client_id = p_drop and dd.deleted_at is null and a.document_id = dd.id;
  update documents dd set client_id = p_keep,
         deleted_at = case when dd.deleted_at is null
                             and exists (select 1 from documents kd where kd.client_id = p_keep
                                            and kd.sha256 = dd.sha256 and kd.deleted_at is null)
                           then now() else dd.deleted_at end
   where dd.client_id = p_drop;

  update applications set client_id = p_keep where client_id = p_drop;
  update merchant_offers set client_id = p_keep where client_id = p_drop;
  update upload_sessions set client_id = p_keep where client_id = p_drop;
  update link_opens set client_id = p_keep where client_id = p_drop;
  update reply_tags set client_id = p_keep where client_id = p_drop;
  update inbound_emails set client_id = p_keep where client_id = p_drop;
  update brain_preps set client_id = p_keep where client_id = p_drop;
  update user_alerts set client_id = p_keep where client_id = p_drop;
  update deals set client_id = p_keep where client_id = p_drop;
  update rescue_nudges set client_id = p_keep where client_id = p_drop;
  update send_ledger set client_id = p_keep where client_id = p_drop;
  update suppressions set client_id = p_keep where client_id = p_drop;
  update sheet_rows set client_id = p_keep where client_id = p_drop;

  -- an email opt-out on either card holds for the merged one (the flag is set above): nothing more goes out
  if d.email_opt_out and not k.email_opt_out then
    update outbox set status = 'cancelled', skip_reason = 'suppressed'
     where client_id = p_keep and status = 'queued' and lane in ('sequence', 'blast');
    perform stop_enrollment(p_keep, 'opted_out');
  end if;

  -- a stop wins
  if d.contact_status <> 'ok' and k.contact_status = 'ok' then
    new_status := d.contact_status;
  elsif d.contact_status <> 'ok' and k.contact_status <> d.contact_status then
    new_status := 'dnc';
  end if;

  summary := 'Merged with ' || d.business_name
    || case when btrim(d.phone) <> '' then ' (' || d.phone || ')' else '' end
    || ': ' || n_notes || ' notes, ' || n_adv || ' advances, ' || n_subs || ' submissions, ' || n_stips
    || ' stips moved over';
  insert into activities (user_id, client_id, kind, body) values (k.user_id, p_keep, 'system', summary);

  -- offers that stay behind are deleted with the other card; anything declined only because of them comes back
  perform app.reopen_siblings(o.id) from offers o where o.client_id = p_drop;
  -- safety net: the delete cascades into every table that references the card. If a table (a newer one, say) still
  -- holds rows for it that this function does not know to move, stop here rather than lose them silently.
  for leftover in
    select c.conrelid::regclass::text as tbl
      from pg_constraint c
     where c.contype = 'f' and c.confrelid = 'public.clients'::regclass and c.confdeltype = 'c'
  loop
    if leftover.tbl in ('activities', 'timers', 'stips', 'submissions', 'offers', 'backdoor_reports') then continue; end if;
    execute format('select exists (select 1 from %s where client_id = $1)', leftover.tbl) into has_rows using p_drop;
    if has_rows then
      raise exception 'merge would lose rows in %: ask for this table to be added to merge_clients', leftover.tbl
        using errcode = '55000';
    end if;
  end loop;
  delete from clients where id = p_drop;

  if new_status is not null then
    perform set_contact_status(p_keep, new_status,
      'Carried over from the merged card (' || d.business_name || ')');
  end if;
  perform app.ensure_open_timer(p_keep, 'Merged — next step');

  select * into k from clients where id = p_keep;
  return k;
end $function$;
