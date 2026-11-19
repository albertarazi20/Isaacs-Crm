-- 0583: a merged-away card's links and addresses are not lost, and a Pause no longer makes the rest of a sequence fire
-- on consecutive days. Safe on a database with rows: one new (empty) table, one new column, two functions replaced in
-- place (owner, grants and search path kept), one new helper.
--
-- 1. client_token_aliases. merge_clients deletes the dropped card, and with it its unsubscribe_token, upload_token and
--    application_token. Every email already sent carries the unsubscribe link ("This link isn't valid" is a compliance
--    problem; the one-click POST must work), and the upload and application links were given to the merchant. The merge
--    now records the dropped card's three tokens here, pointing at the kept card, and the resolvers (replies.ts,
--    upload.ts, apply.ts, linkSignals.ts) look here when no live card owns the token. System-only, like session_activity:
--    row security on, the app role granted nothing, read and written through the owner connection / security definer.
-- 2. merge_clients (0581's version): the dropped card's phone and email, when they differ from the kept card's, go to the
--    kept card's phone2/email2 when those are free (they used to be dropped, so duplicate checks and inbound mail lost
--    the merchant); anything that still has no slot is named in the merge note; tokens go to the table above.
-- 3. A Pause leaves next_due_on and entered_at where they were, so a long Pause ended with the remaining steps all
--    overdue and sent on consecutive days (the engine schedules max(tomorrow, entered_at + offset)). enrollments gets
--    paused_at, stamped when a person pauses (set_enrollment_paused); the resume (that function, or the engine lifting a
--    dated pause) moves next_due_on and entered_at forward by the whole days of the pause, so the day_offset spacing
--    between steps is kept. A pause that set its own dates ("not now": next_due_on = the revive day) has no paused_at
--    and is left alone.

create table if not exists client_token_aliases (
  token text primary key check (btrim(token) <> ''),
  kind text not null check (kind in ('unsubscribe', 'upload', 'application')),
  client_id uuid not null references clients (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists client_token_aliases_client_idx on client_token_aliases (client_id);
alter table client_token_aliases enable row level security;
revoke all on client_token_aliases from isaac_app;

create or replace function app.phone_key(p text) returns text
language sql immutable as $$ select right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10) $$;
revoke execute on function app.phone_key(text) from public;
grant execute on function app.phone_key(text) to isaac_app;

-- A rep resetting a merchant's upload link (rotateUploadToken) also ends the links the merchant kept from a merged-away
-- card. The app role may not touch the table, so this one door does it, for a merchant the caller may touch.
create or replace function app.clear_client_token_aliases(p_client uuid, p_kind text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not app.can_touch_client(p_client) then raise exception 'merchant not found' using errcode = 'P0002'; end if;
  delete from client_token_aliases where client_id = p_client and kind = p_kind;
end $$;
revoke execute on function app.clear_client_token_aliases(uuid, text) from public;
grant execute on function app.clear_client_token_aliases(uuid, text) to isaac_app;

alter table enrollments add column if not exists paused_at timestamptz;

create or replace function app.enrollment_resume_shift() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare days int;
begin
  if old.paused and not new.paused then
    if old.paused_at is not null then
      days := greatest(0, floor(extract(epoch from (now() - old.paused_at)) / 86400))::int;
      if days > 0 then
        if new.next_due_on is not null and new.next_due_on is not distinct from old.next_due_on then
          new.next_due_on := new.next_due_on + days;
        end if;
        if new.entered_at is not distinct from old.entered_at then
          new.entered_at := new.entered_at + make_interval(days => days);
        end if;
      end if;
    end if;
    new.paused_at := null;
  end if;
  return new;
end $$;
drop trigger if exists enrollments_resume_shift on enrollments;
create trigger enrollments_resume_shift before update on enrollments
  for each row execute function app.enrollment_resume_shift();

create or replace function public.set_enrollment_paused(p_client uuid, p_paused boolean)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; c clients;
begin
  if not app.can_touch_client(p_client) then raise exception 'client not found' using errcode = 'P0002'; end if;
  select * into c from clients where id = p_client;
  if not found then raise exception 'client not found' using errcode = 'P0002'; end if;
  update enrollments set paused = p_paused, resume_on = case when p_paused then resume_on else null end,
                         paused_at = case when p_paused then now() else paused_at end
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

-- 2, on top of 0581's version (see the notes above for what changed)
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
  kphone text; kemail text; new_phone2 text; new_email2 text; unkept text[] := '{}';
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

  -- A DIFFERENT phone or email on the other card is not lost: it goes to the kept card's second slot when that is free,
  -- so inbound mail and duplicate checks still find the merchant by it (0583). The other card's own second number or
  -- address comes next if its main one is the same as the kept card's. Whatever still has no slot is named in the note.
  kphone := case when btrim(k.phone) = '' then d.phone else k.phone end;
  kemail := case when btrim(k.email) = '' then d.email else k.email end;
  new_phone2 := k.phone2;
  if btrim(k.phone2) = '' then
    select v.p into new_phone2 from (values (1, d.phone), (2, d.phone2)) v(o, p)
     where btrim(v.p) <> '' and app.phone_key(v.p) <> app.phone_key(kphone)
     order by v.o limit 1;
    new_phone2 := coalesce(new_phone2, k.phone2);
  end if;
  new_email2 := k.email2;
  if btrim(k.email2) = '' then
    select v.e into new_email2 from (values (1, d.email), (2, d.email2)) v(o, e)
     where btrim(v.e) <> '' and lower(btrim(v.e)) <> lower(btrim(kemail))
     order by v.o limit 1;
    new_email2 := coalesce(new_email2, k.email2);
  end if;
  select coalesce(array_agg(x.what), '{}') into unkept from (
    select 'phone ' || p as what from unnest(array[d.phone, d.phone2]) p
     where btrim(p) <> '' and app.phone_key(p) <> app.phone_key(kphone)
       and app.phone_key(p) <> app.phone_key(new_phone2) and app.phone_key(p) <> app.phone_key(k.phone2)
    union all
    select 'email ' || e from unnest(array[d.email, d.email2]) e
     where btrim(e) <> '' and lower(btrim(e)) <> lower(btrim(kemail))
       and lower(btrim(e)) <> lower(btrim(new_email2)) and lower(btrim(e)) <> lower(btrim(k.email2))
  ) x;

  -- the kept card fills its blanks from the other, and keeps the earlier application date
  update clients set
      hot = k.hot or d.hot,
      phone2 = new_phone2,
      email2 = new_email2,
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
    || ' stips moved over'
    || case when cardinality(unkept) > 0 then '. Not kept (no free slot): ' || array_to_string(unkept, ', ') else '' end;
  insert into activities (user_id, client_id, kind, body) values (k.user_id, p_keep, 'system', summary);

  -- The other card's three links keep working (0583): every email already sent carries its unsubscribe link (the law
  -- says it must work), and the upload and application links were handed to the merchant. They now open the kept card.
  -- Links the other card had itself inherited from an earlier merge move over with it.
  update client_token_aliases set client_id = p_keep where client_id = p_drop;
  insert into client_token_aliases (token, kind, client_id)
  values (d.unsubscribe_token, 'unsubscribe', p_keep), (d.upload_token, 'upload', p_keep),
         (d.application_token, 'application', p_keep)
  on conflict (token) do nothing;

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
