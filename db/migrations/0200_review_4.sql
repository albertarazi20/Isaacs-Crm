-- 0200: fixes from the fourth review (docs/REVIEW-4.md).
--   C-1  removing the offer the merchant accepted (or its submission) no longer fails: its siblings come back first,
--        and the declined_by/declined_from pair check no longer breaks the ON DELETE SET NULL
--   C-6  restore_rows lists only the columns the file has, so an older backup still restores after a new NOT NULL DEFAULT column
--   C-7  a stale tab can't delete a trashed merchant's advance, submission or offer (direct deletes only; purge cascades pass)
--   C-8  an advance can't have a position above 20 or a commission above its amount, whichever dialog wrote it

alter table offers drop constraint offers_declined_pair;
alter table offers add constraint offers_declined_pair check (declined_by is null or declined_from is not null);

-- the offers that were turned down only because `p_offer` was accepted come back (unless their funder has since said no)
create function app.reopen_siblings(p_offer uuid) returns int
language plpgsql set search_path = public, pg_temp as $$
declare brought_back int;
begin
  with back as (
    update offers x set status = case x.declined_from when 'presented' then 'presented' else 'open' end,
                        declined_by = null, declined_from = null
      from submissions s
     where x.declined_by = p_offer and x.status = 'declined'
       and s.id = x.submission_id and s.status not in ('declined', 'withdrawn')
    returning x.id)
  select count(*) into brought_back from back;
  update offers set declined_by = null, declined_from = null where declined_by = p_offer;
  return brought_back;
end $$;

-- an offer typed wrong: remove it and enter it again. Client first, like every other function.
create function public.remove_offer(p_offer uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare o offers; c clients; cid uuid; fname text;
begin
  select client_id into cid from offers where id = p_offer;
  if not found then
    raise exception 'That offer no longer exists' using errcode = 'P0002';
  end if;
  select * into c from clients where id = cid for update;
  select * into o from offers where id = p_offer for update;
  if not found then
    raise exception 'That offer no longer exists' using errcode = 'P0002';
  end if;
  select f.name into fname from submissions s join funders f on f.id = s.funder_id where s.id = o.submission_id;
  perform app.reopen_siblings(o.id);
  delete from offers where id = o.id;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, c.id, 'system',
          'Removed ' || coalesce(fname, 'a funder') || '''s offer: ' || app.fmt_money(o.amount_cents) || ' at '
          || app.fmt_factor(o.factor_rate) || ' factor');
end $$;

CREATE OR REPLACE FUNCTION public.remove_submission(p_submission uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare s submissions; c clients; cid uuid; fname text;
begin
  select client_id into cid from submissions where id = p_submission;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  select * into c from clients where id = cid for update;
  select * into s from submissions where id = p_submission for update;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  select name into fname from funders where id = s.funder_id;
  perform app.reopen_siblings(o.id) from offers o where o.submission_id = s.id;
  delete from submissions where id = s.id;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, c.id, 'system', 'Removed the submission to ' || fname);
  perform app.ensure_open_timer(c.id, 'Submission removed — next step');
end $function$;

CREATE OR REPLACE FUNCTION public.merge_clients(p_keep uuid, p_drop uuid)
 RETURNS clients
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  k clients; d clients;
  n_notes int; n_adv int; n_subs int; n_stips int;
  keep_next date; drop_next date; new_status text; summary text;
begin
  if p_keep is null or p_drop is null or p_keep = p_drop then
    raise exception 'Pick two different merchants to merge' using errcode = '22023';
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
  delete from clients where id = p_drop;

  if new_status is not null then
    perform set_contact_status(p_keep, new_status,
      'Carried over from the merged card (' || d.business_name || ')');
  end if;
  perform app.ensure_open_timer(p_keep, 'Merged — next step');

  select * into k from clients where id = p_keep;
  return k;
end $function$;

create or replace function app.restore_rows(p_table text, p_rows jsonb) returns int
language plpgsql set search_path = public, pg_temp as $$
declare cols text; n int;
begin
  if p_table not in ('clients', 'trashed_clients', 'client_asks', 'positions', 'competing_offers', 'fundings',
                     'stips', 'funders', 'submissions', 'offers', 'timers', 'activities', 'snippets') then
    raise exception 'not a table a backup can restore into: %', p_table using errcode = '22023';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows must be a list' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    return 0;
  end if;
  -- only the columns the file actually has: a column added since the backup keeps its default instead of getting NULL
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = p_table and is_generated = 'NEVER'
     and (p_rows->0) ? column_name;
  execute format('insert into %I (%s) select %s from jsonb_populate_recordset(null::%I, $1)',
                 p_table, cols, cols, p_table) using p_rows;
  get diagnostics n = row_count;
  return n;
end $$;

-- C-7: a direct delete from a stale tab is refused for a trashed merchant. Purge deletes the same rows by cascade,
-- one trigger level deeper, so it passes.
create function app.refuse_delete_when_trashed() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if pg_trigger_depth() = 1 and exists (select 1 from trashed_clients t where t.client_id = old.client_id) then
    raise exception 'That merchant is in the trash — restore it first' using errcode = '22023';
  end if;
  return old;
end $$;
create trigger fundings_no_delete_in_trash before delete on fundings
  for each row execute function app.refuse_delete_when_trashed();
create trigger submissions_no_delete_in_trash before delete on submissions
  for each row execute function app.refuse_delete_when_trashed();
create trigger offers_no_delete_in_trash before delete on offers
  for each row execute function app.refuse_delete_when_trashed();

-- C-8: the same limits update_funding_terms enforces, on the table itself
alter table fundings add constraint fundings_position_range check (position_no <= 20);
alter table fundings add constraint fundings_commission_not_above_amount
  check (commission_cents is null or commission_cents <= amount_cents);
