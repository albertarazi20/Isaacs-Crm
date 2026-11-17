-- 0544: the checklist follows the files, and the statement months are the ones that exist.
--   * A relabelled or deleted document un-ticks the stip it backed (stips.doc_key = documents.storage_key), unless
--     another live file of the same kind and month still backs it; the merchant is then re-bucketed. A relabel still
--     ticks the new label's box (relabel_document -> app.file_document, 0370).
--   * Re-bucketing leaves trashed merchants alone (enroll_in_bucket refuses them) as well as brought-in ones (0540).
--   * "Need newest statement" is read from the checklist, not the calendar: every older required month is in and
--     only the newest required month is missing. The old rule compared with the current month, and the newest month
--     a checklist asks for is always a past month, so the bucket never filled.
--   * The statement clock (0510) ran over open deals, which no longer exist, and nothing called it. It now runs over
--     the merchants being chased for documents, from the nightly job.

-- 1. Un-filing: the boxes a document backed, after it was deleted or relabelled. Returns how many were un-ticked.
create or replace function app.unfile_document(d documents, p_why text) returns int
language plpgsql set search_path = public, pg_temp as $$
declare s record; other text; n int := 0;
begin
  for s in select id, kind, period, user_id from stips where client_id = d.client_id and doc_key = d.storage_key loop
    select o.storage_key into other from documents o
     where o.client_id = d.client_id and o.id <> d.id and o.deleted_at is null and o.kind = s.kind
       and o.scan_status not in ('infected', 'rejected')
       and (s.kind <> 'bank_statement' or o.period is not distinct from s.period)
     order by o.created_at desc limit 1;
    if other is not null then
      update stips set doc_key = other where id = s.id;
    else
      update stips set received_at = null, doc_key = null where id = s.id and received_at is not null;
      if found then
        n := n + 1;
        insert into activities (user_id, client_id, kind, body)
        values (s.user_id, d.client_id, 'system',
                'Stip marked missing: ' || app.document_label(s.kind, s.period) || ' — ' || d.filename || ' ' || p_why);
      end if;
    end if;
  end loop;
  return n;
end $$;
revoke execute on function app.unfile_document(documents, text) from public;
grant execute on function app.unfile_document(documents, text) to isaac_app;

create or replace function app.document_unfiled() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if app.unfile_document(old, case when new.deleted_at is not null then 'was deleted' else 'was relabelled' end) > 0 then
    perform app.rebucket_by_stips(old.client_id);
  end if;
  return new;
end $$;
revoke execute on function app.document_unfiled() from public;
grant execute on function app.document_unfiled() to isaac_app;
drop trigger if exists documents_unfiled on documents;
create trigger documents_unfiled after update of kind, period, deleted_at on documents
  for each row
  when (old.deleted_at is null and (new.deleted_at is not null or new.kind is distinct from old.kind
                                    or new.period is distinct from old.period))
  execute function app.document_unfiled();

-- 2. Re-bucketing: brought-in (0540) and trashed merchants stay where they are.
create or replace function app.rebucket_by_stips(p_client uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare want text; b uuid; cur uuid;
begin
  if exists (select 1 from clients where id = p_client and brought_in_at is not null) then return; end if;
  if exists (select 1 from trashed_clients where client_id = p_client) then return; end if;
  want := app.stips_bucket(p_client);
  if want is null then return; end if;
  select id into b from buckets where key = want;
  select bucket_id into cur from enrollments where client_id = p_client and stopped_at is null limit 1;
  -- only move between system buckets; a rep's own bucket is theirs to manage
  if cur is not null and not exists (select 1 from buckets where id = cur and key is not null) then return; end if;
  if cur is distinct from b then perform enroll_in_bucket(p_client, b, 'document_received'); end if;
end $$;

-- 3. Which checklist bucket. Application first, then older statements, then the newest month, then ID, then ready.
create or replace function app.stips_bucket(p_client uuid) returns text
language plpgsql stable set search_path = public, pg_temp as $$
declare newest date; has_older boolean;
begin
  if not exists (select 1 from stips where client_id = p_client and required) then return null; end if;
  if exists (select 1 from stips where client_id = p_client and required and kind = 'signed_application'
                and received_at is null) then
    return 'missing_app';
  end if;
  select max(period) into newest from stips where client_id = p_client and required and kind = 'bank_statement';
  select exists (select 1 from stips where client_id = p_client and required and kind = 'bank_statement'
                    and period < newest) into has_older;
  -- an older month is missing, or the only month asked for is: "missing statements"
  if exists (select 1 from stips where client_id = p_client and required and kind = 'bank_statement'
                and received_at is null and (period is null or period < newest or not has_older)) then
    return 'missing_statements';
  end if;
  -- the older months are in and the newest is not
  if exists (select 1 from stips where client_id = p_client and required and kind = 'bank_statement'
                and received_at is null) then
    return 'missing_newest';
  end if;
  if exists (select 1 from stips where client_id = p_client and required and kind in ('drivers_license', 'voided_check')
                and received_at is null) then
    return 'missing_id';
  end if;
  return 'ready_for_ops';
end $$;

-- 4. The statement clock, nightly. A merchant being chased for documents (live and not paused in a checklist bucket,
-- not brought in, not trashed) whose checklist stops short of the newest month a lender expects
-- (app.expected_statement_month, the 5th; src/lib/docs/freshness.ts expectedMonth) gets the months after its newest
-- required one, at most the four a file needs, each once, and is re-bucketed. Merchants in Cold, in a rep's own
-- bucket, paused or no longer enrolled (they replied, opted out, finished) are left alone; the rule reads the
-- checklist, not the date, so they catch up the first night they are back in a checklist bucket.
create or replace function public.request_new_month_statements(p_today date default current_date)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; want date; m date; n int := 0; added text[];
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
    n := n + 1;
    insert into activities (user_id, client_id, kind, body)
    values (r.user_id, r.client_id, 'system',
            'The month turned: asked for the ' || array_to_string(added, ', ') ||
            case when cardinality(added) = 1 then ' statement' else ' statements' end);
    perform app.rebucket_by_stips(r.client_id);
  end loop;
  return n;
end $$;
revoke execute on function public.request_new_month_statements(date) from public;
grant execute on function public.request_new_month_statements(date) to isaac_app;
