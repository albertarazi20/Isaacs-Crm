-- 0567: offboarding a rep moves the newer tables too (review finding database-9).
-- offboard_user reassigned the book, but approvals, signed applications, merchant offers and the brain's preparations
-- kept the leaving rep's user_id (only open approvals followed, by a trigger on the card). Reports and exports that
-- group by those columns then credited a disabled login, and the brain kept preparing work for someone who cannot sign
-- in. The ones still working for the leaving rep are failed; the ones for moved cards go to the new owner.

create or replace function public.offboard_user(p_user uuid, p_to uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare rep app_users; heir app_users; n_clients int; n_deals int; n_docs int; n_enrol int; report jsonb; me uuid := app.current_user_id();
begin
  if not app.can_see_all() then raise exception 'only a manager can offboard someone' using errcode = '22023'; end if;
  if p_user = me then raise exception 'you cannot offboard yourself' using errcode = '22023'; end if;
  if p_user = p_to then raise exception 'pick someone else to receive the book' using errcode = '22023'; end if;
  select * into rep from app_users where id = p_user for update;
  if not found then raise exception 'user not found' using errcode = 'P0002'; end if;
  select * into heir from app_users where id = p_to and active;
  if not found then raise exception 'the person receiving the book must be active' using errcode = '22023'; end if;

  set constraints all deferred;
  create temp table moved on commit drop as select id from clients where user_id = p_user;

  -- 1. the login dies now: inactive, and every open session is invalid on its next request
  update app_users set active = false, session_epoch = session_epoch + 1, offboarded_at = now(), offboarded_by = me where id = p_user;
  -- 2. the mailbox connection is cut; queued mail goes out on behalf of the new owner instead
  delete from gmail_connections where user_id = p_user;
  update lead_tokens set revoked_at = now() where user_id = p_user and revoked_at is null;
  delete from mail_sync_state where user_id = p_user;
  update mailboxes set active = false where user_id = p_user;
  update sheet_sources set reader_user_id = null where reader_user_id = p_user;
  update outbox set user_id = p_to, mailbox_id = null where user_id = p_user and status = 'queued';
  -- 3. the book moves, children with it. Commission history stays in the ledger under the leaving rep.
  update clients set user_id = p_to where user_id = p_user;            get diagnostics n_clients = row_count;
  update client_asks set user_id = p_to where user_id = p_user;
  update positions set user_id = p_to where user_id = p_user;
  update competing_offers set user_id = p_to where user_id = p_user;
  update fundings set user_id = p_to where user_id = p_user;
  update stips set user_id = p_to where user_id = p_user;
  update timers set user_id = p_to where user_id = p_user;
  update activities set user_id = p_to where user_id = p_user;
  update submissions set user_id = p_to where user_id = p_user;
  update offers set user_id = p_to where user_id = p_user;
  update trashed_clients set user_id = p_to where user_id = p_user;
  update deals set user_id = p_to where user_id = p_user;              get diagnostics n_deals = row_count;
  update enrollments set user_id = p_to where user_id = p_user;        get diagnostics n_enrol = row_count;
  update winback_members set user_id = p_to where user_id = p_user;
  update documents set user_id = p_to where user_id = p_user;          get diagnostics n_docs = row_count;
  -- the newer tables keep a rep's name too (0567): approvals of every status (only the open ones follow the card by
  -- trigger), signed applications, offers sent to merchants, and the brain's preparations for the moved cards
  update approvals set user_id = p_to where user_id = p_user;
  update applications set user_id = p_to where user_id = p_user;
  update merchant_offers set user_id = p_to where user_id = p_user;
  update brain_preps set status = 'failed', error = 'owner was offboarded'
   where user_id = p_user and status = 'working';
  update brain_preps bp set user_id = p_to
   where bp.user_id = p_user and bp.client_id in (select id from moved)
     and not exists (select 1 from brain_preps x where x.user_id = p_to and x.trigger_key = bp.trigger_key);
  insert into activities (user_id, client_id, kind, body)
  select p_to, m.id, 'system', 'Reassigned from ' || coalesce(nullif(rep.name, ''), rep.email) || ' to ' || coalesce(nullif(heir.name, ''), heir.email) || ' (offboarding)' from moved m;

  -- 4. the 30-day report: what they looked at, copied and took out
  report := jsonb_build_object(
    'user', rep.email, 'to', heir.email,
    'clients_moved', n_clients, 'deals_moved', n_deals, 'documents_moved', n_docs, 'enrollments_moved', n_enrol,
    'last_30_days', jsonb_build_object(
      'contact_copies', (select count(*) from access_log where user_id = p_user and action in ('copy_contact', 'copy_phone', 'copy_email') and at > now() - interval '30 days'),
      'contact_views', (select count(*) from access_log where user_id = p_user and action = 'view_contact' and at > now() - interval '30 days'),
      'contact_changes', (select count(*) from access_log where user_id = p_user and action = 'contact_changed' and at > now() - interval '30 days'),
      'exports', (select count(*) from access_log where user_id = p_user and action in ('export', 'backup') and at > now() - interval '30 days'),
      'document_opens', (select count(*) from document_views where viewer_user_id = p_user and at > now() - interval '30 days'),
      'after_hours_document_opens', (select count(*) from document_views v where v.viewer_user_id = p_user and v.at > now() - interval '30 days'
                                        and extract(hour from v.at at time zone coalesce(rep.timezone, 'UTC')) not between 7 and 20),
      'lenders_sent_to', (select count(distinct s.funder_id) from submissions s where s.client_id in (select id from moved) and s.sent_on > current_date - 30),
      'canaries_touched', (select count(*) from access_log a join clients c on c.id = a.client_id where a.user_id = p_user and c.is_canary and a.at > now() - interval '30 days')
    ));
  insert into access_log (user_id, action, detail) values (me, 'offboard', report::text);
  return report;
end $function$;
