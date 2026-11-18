-- 0561: merging two cards for one merchant no longer deletes the second card's documents, follow-up enrolment,
-- application, approvals, merchant offers, upload links, link opens, reply tags and mail history (review finding
-- database-1). merge_clients moved only nine tables and then ran `delete from clients`, which cascades into every other
-- table that references the card. Now everything moves to the kept card (duplicates are resolved, not dropped), and a
-- guard refuses the merge if a table it does not know about still holds rows for the other card.
-- It runs as the owner (several of those tables are read-only for the app role) after checking the caller the way row
-- security did: the signed-in rep's own cards, or a manager. It also carries the second phone and email, what the
-- merchant is looking for, and any opt-out over to the kept card.
-- access_log is an append-only audit trail (the app role may only select and insert): it is not rewritten here, its
-- rows simply stop pointing at the other card once it is gone (the foreign key is on delete set null). The merge
-- itself is recorded as an activity on the kept card below.

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
