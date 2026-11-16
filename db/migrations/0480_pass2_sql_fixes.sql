-- Fixes from the second manual pass (docs/ISSUES.md, P2-*) that live in SQL. The patched functions are the live
-- definitions re-created whole, so each one reads as the current source of truth.

-- P2-41: ops send files to lenders and record answers; those functions insert chase/follow-up timers and offers under
-- the rep's user_id. Ops could only read both tables. Same scope as the other ops policies: deals in their queue.
drop policy timers_ops on timers;
create policy timers_ops on timers for all to isaac_app
  using (app.is_ops_deal(client_id)) with check (app.is_ops_deal(client_id));
drop policy offers_ops on offers;
create policy offers_ops on offers for all to isaac_app
  using (app.is_ops_deal(client_id)) with check (app.is_ops_deal(client_id));

-- P2-27: once a manager has confirmed a funding its money is frozen for everyone but a manager. A trigger rather than
-- a check in update_funding_terms, so every path (the Earnings page, a stale tab, a future function) hits the same wall.
-- The owner connection (jobs, migrations) sets no app.user_id and is not restricted.
create function app.guard_confirmed_funding() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if old.confirmed_at is not null and app.current_user_id() is not null and not app.can_see_all() and (
       new.amount_cents is distinct from old.amount_cents
    or new.factor_rate is distinct from old.factor_rate
    or new.sell_rate is distinct from old.sell_rate
    or new.buy_rate is distinct from old.buy_rate
    or new.points is distinct from old.points
    or new.psf_cents is distinct from old.psf_cents
    or new.commission_cents is distinct from old.commission_cents
    or new.commission_received_cents is distinct from old.commission_received_cents
    or new.commission_received_on is distinct from old.commission_received_on
    or new.rep_cut_cents is distinct from old.rep_cut_cents
    or new.house_cut_cents is distinct from old.house_cut_cents
    or new.funded_on is distinct from old.funded_on
    or new.confirmed_at is distinct from old.confirmed_at
    or new.confirmed_by is distinct from old.confirmed_by) then
    raise exception 'This funding is confirmed — only a manager can change its money' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger fundings_guard_confirmed before update on fundings
  for each row execute function app.guard_confirmed_funding();

-- P2-46: "caps the PSF at %2.00" → "caps the PSF at 2.00% of the advance".
CREATE OR REPLACE FUNCTION public.propose_funding(p_client uuid, p_terms jsonb)
 RETURNS fundings
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare c clients; d deals; f fundings; fd funders; v_points numeric; v_amount bigint; v_psf bigint; v_sell numeric; v_buy numeric; tmr jsonb;
begin
  select * into c from clients where id = p_client for update;
  if not found then raise exception 'client not found' using errcode = 'P0002'; end if;
  select * into d from deals where client_id = p_client and outcome = 'open' order by created_at desc limit 1 for update;
  v_amount := (p_terms->>'amount_cents')::bigint;
  v_sell := nullif(p_terms->>'sell_rate', '')::numeric;
  v_buy := nullif(p_terms->>'buy_rate', '')::numeric;
  v_psf := coalesce(nullif(p_terms->>'psf_cents', '')::bigint, 0);
  v_points := coalesce(nullif(p_terms->>'points', '')::numeric,
                       case when v_sell is not null and v_buy is not null then round((v_sell - v_buy) * 100, 2) end);
  if (p_terms->>'funder_id') is not null then
    select * into fd from funders where id = (p_terms->>'funder_id')::uuid;
    if fd.max_upsell_points is not null and v_points is not null and v_points > fd.max_upsell_points then
      raise exception '% caps points at % — you entered %', fd.name, fd.max_upsell_points, v_points using errcode = '22023';
    end if;
    if fd.psf_cap_pct is not null and v_amount > 0 and v_psf * 100.0 / v_amount > fd.psf_cap_pct then
      raise exception '% caps the PSF at %', fd.name, fd.psf_cap_pct::text || '% of the advance' using errcode = '22023';
    end if;
  end if;
  if v_psf > 0 and (p_terms->>'psf_collected_at') = 'before_closing' then
    raise exception 'A PSF cannot be collected before closing' using errcode = '22023';
  end if;
  -- the existing record_funding writes the row, timers and stage move; then the new columns are filled in
  tmr := coalesce(p_terms->'timers', '[]'::jsonb);
  select * into f from record_funding(p_client, jsonb_build_object(
    'funded_on', coalesce(p_terms->>'funded_on', current_date::text),
    'funder_name', coalesce(fd.name, p_terms->>'funder_name', ''),
    'amount_cents', v_amount,
    'factor_rate', coalesce(v_sell, (p_terms->>'factor_rate')::numeric),
    'payment_cents', (p_terms->>'payment_cents')::bigint,
    'frequency', p_terms->>'frequency',
    'position_no', coalesce((p_terms->>'position_no')::int, 1),
    'term_days', nullif(p_terms->>'term_days', '')::int,
    'commission_cents', case when v_points is not null then round(v_amount * v_points / 100)::bigint + v_psf end,
    'note', coalesce(p_terms->>'note', '')), tmr);
  update fundings set
      sell_rate = coalesce(v_sell, factor_rate), buy_rate = v_buy, points = v_points, psf_cents = v_psf,
      psf_collected_at = coalesce(nullif(p_terms->>'psf_collected_at', ''), 'at_closing'),
      funder_id = fd.id, deal_id = d.id, proposed_by = app.current_user_id(),
      clawback_until = funded_on + coalesce(fd.clawback_days, 30),
      renewal_warm_on = app.paydown_date(amount_cents, factor_rate, payment_cents, frequency, funded_on, 40),
      renewal_eligible_on = app.paydown_date(amount_cents, factor_rate, payment_cents, frequency, funded_on, coalesce(fd.renewal_paydown_pct, 50))
   where id = f.id returning * into f;
  return f;
end $function$

;

-- P2-42: sending to lenders marks the deal sent in the same transaction, so the board's lanes and the deal header
-- follow the lender rows instead of waiting for a second button.
CREATE OR REPLACE FUNCTION public.create_submissions(p_client uuid, p_funder_ids uuid[], p_sent_on date DEFAULT NULL::date, p_note text DEFAULT ''::text)
 RETURNS SETOF submissions
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  c clients;
  sent date := coalesce(p_sent_on, app.local_today());
  ids uuid[];
  new_ids uuid[];
  names text;
  v_note text := btrim(coalesce(p_note, ''));
begin
  select * into c from clients where id = p_client for update;
  if not found then
    raise exception 'client not found' using errcode = 'P0002';
  end if;
  select coalesce(array_agg(distinct x), '{}') into ids from unnest(p_funder_ids) x where x is not null;
  if cardinality(ids) = 0 then
    raise exception 'pick at least one funder' using errcode = '22023';
  end if;
  if cardinality(ids) > 50 then
    raise exception 'send to 50 funders or fewer at a time' using errcode = '22023';
  end if;
  -- ±1 day of slack: the database clock is UTC, Isaac's calendar is not.
  if sent > app.local_today() + 1 then
    raise exception 'the sent date % is in the future', sent using errcode = '22023';
  end if;
  if sent < app.local_today() - 365 then
    raise exception 'the sent date % is more than a year ago', sent using errcode = '22023';
  end if;
  -- RLS hides other users' funders, so a foreign id is simply "not found".
  if (select count(*) from funders where id = any(ids)) <> cardinality(ids) then
    raise exception 'funder not found' using errcode = 'P0002';
  end if;
  select string_agg(name, ', ' order by lower(name)) into names from funders where id = any(ids) and not active;
  if names is not null then
    raise exception '% is archived — restore it on the Funders page first', names using errcode = '22023';
  end if;
  select string_agg(f.name, ', ' order by lower(f.name)) into names
    from submissions s join funders f on f.id = s.funder_id
   where s.client_id = p_client and s.funder_id = any(ids) and s.sent_on = sent;
  if names is not null then
    raise exception 'Already sent to % on %', names, to_char(sent, 'FMMon FMDD') using errcode = '22023';
  end if;

  with ins as (
    insert into submissions (user_id, client_id, funder_id, sent_on, note)
    select c.user_id, p_client, f.id, sent, v_note from funders f where f.id = any(ids)
    returning id
  )
  select array_agg(id) into new_ids from ins;

  select string_agg(f.name, ', ' order by lower(f.name)) into names from funders f where f.id = any(ids);
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Submitted to ' || names || case when v_note <> '' then ' — ' || v_note else '' end);

  -- Application in / Collecting stips -> Submitted to funders. This closes every open timer, so the
  -- chase timers are created AFTER it.
  if c.stage in ('application_in', 'stips') then
    perform app.move_keeping_chase(p_client, 'submitted',
      jsonb_build_array(jsonb_build_object('kind', 'follow_up', 'due_on', app.add_business_days(app.local_today(), 1), 'note', '')),
      '');
  end if;

  insert into timers (user_id, client_id, kind, due_on, note, submission_id)
  select c.user_id, p_client, 'chase', app.add_business_days(sent, 1), 'Ask ' || f.name || ' for a decision', s.id
    from submissions s join funders f on f.id = s.funder_id
   where s.id = any(new_ids)
   order by lower(f.name);

  -- the lenders have the file: the deal leaves the ops queue (P2-42)
  update deals set ops_status = 'sent', sent_at = coalesce(sent_at, now()), blocker = ''
   where client_id = p_client and outcome = 'open' and ops_status in ('queued', 'kicked_back');

  return query
    select s.* from submissions s join funders f on f.id = s.funder_id
     where s.id = any(new_ids) order by lower(f.name);
end $function$

;

-- P2-30: adding an email that already exists changes that user's role; bump the session epoch so a live session
-- cannot keep the old role for days.
CREATE OR REPLACE FUNCTION public.add_team_member(p_email text, p_name text, p_role text)
 RETURNS app_users
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare u app_users;
begin
  if not app.can_see_all() then raise exception 'only a manager can add people' using errcode = '22023'; end if;
  if p_role not in ('rep', 'ops', 'manager') then raise exception 'role must be rep, ops or manager' using errcode = '22023'; end if;
  if p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'that is not an email address' using errcode = '22023'; end if;
  insert into app_users (email, name, role, invited_by) values (lower(btrim(p_email)), btrim(p_name), p_role, app.current_user_id())
  on conflict (email) do update set session_epoch = app_users.session_epoch + case when app_users.role <> excluded.role or not app_users.active then 1 else 0 end,
                                   active = true, role = excluded.role, name = case when excluded.name <> '' then excluded.name else app_users.name end,
                                   invited_by = excluded.invited_by, offboarded_at = null, offboarded_by = null
  returning * into u;
  insert into access_log (user_id, action, detail) values (app.current_user_id(), 'team_change', 'added ' || u.email || ' as ' || u.role);
  return u;
end $function$

;

-- P2-25: a disabled or offboarded account's lead-intake tokens stop working with the login.
CREATE OR REPLACE FUNCTION public.set_team_member(p_user uuid, p_role text, p_active boolean)
 RETURNS app_users
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare u app_users; me uuid := app.current_user_id();
begin
  if not app.can_see_all() then raise exception 'only a manager can change the team' using errcode = '22023'; end if;
  if p_role not in ('rep', 'ops', 'manager') then raise exception 'role must be rep, ops or manager' using errcode = '22023'; end if;
  if p_user = me and (p_role <> 'manager' or not p_active) then raise exception 'you cannot demote or disable yourself' using errcode = '22023'; end if;
  update app_users set role = p_role, active = p_active,
         session_epoch = case when not p_active or role <> p_role then session_epoch + 1 else session_epoch end
   where id = p_user returning * into u;
  if not found then raise exception 'user not found' using errcode = 'P0002'; end if;
  if not p_active then
    update lead_tokens set revoked_at = now() where user_id = p_user and revoked_at is null;
  end if;
  insert into access_log (user_id, action, detail) values (me, 'team_change', u.email || ' → ' || u.role || case when u.active then '' else ' (disabled)' end);
  return u;
end $function$

;

CREATE OR REPLACE FUNCTION public.offboard_user(p_user uuid, p_to uuid)
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
end $function$

;

-- P2-36: audit rows can only be written as yourself; the send ledger is the worker's (owner connection) alone.
drop policy document_views_write on document_views;
create policy document_views_write on document_views for insert to isaac_app
  with check (viewer_user_id = app.current_user_id() and exists (select 1 from documents d where d.id = document_id));
drop policy send_ledger_insert on send_ledger;
revoke insert on send_ledger from isaac_app;
drop policy suppressions_insert on suppressions;
create policy suppressions_insert on suppressions for insert to isaac_app
  with check (created_by = app.current_user_id() or app.can_see_all());

-- P2-37: the clear addresses on the suppression list are a manager's to read; everyone else asks the question
-- through app.is_suppressed, which now answers as the owner.
drop policy suppressions_read on suppressions;
create policy suppressions_read on suppressions for select to isaac_app using (app.can_see_all());
alter function app.is_suppressed(text, text) security definer;
revoke execute on function app.is_suppressed(text, text) from public;
grant execute on function app.is_suppressed(text, text) to isaac_app;
