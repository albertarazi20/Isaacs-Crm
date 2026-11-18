-- 0580: "Stop emails for good" (owner, 2026-11-18) and "I sent the first email myself".
--
-- Hard stop: one button on a merchant's page and on Open approvals. Every automated lane (approval emails, bucket
-- sequences, nudges, the intake welcome email, manual blasts) already refuses a merchant with clients.email_opt_out or
-- a suppression on their address; the button sets both, stops the approval sequence and the live bucket enrolment,
-- takes back what is queued, and leaves a timeline note, all in one transaction. Reps stop their own merchants,
-- managers any. A manager turns it back on; nothing restarts by itself.
--
-- First email by hand: the rep sends the first approval email from their own Gmail and tells the CRM when. The CRM
-- records step 1 as sent at that time (approvals.first_sent_at) without putting anything on the outbox, and the engine
-- schedules follow-up 1 its delay after that moment.
--
-- Safe on a database with rows: two nullable columns on each of two tables (no default, no rewrite, no backfill), the
-- indexes for the new foreign keys, one function replaced in place (same owner, grants and search path), two new
-- functions. No existing row is read or changed.

-- 1. The state of a hard stop, readable by the rep who owns the merchant (the suppression list is a manager's).
alter table clients
  add column emails_stopped_at timestamptz,
  add column emails_stopped_by uuid references app_users (id) on delete set null;
create index clients_emails_stopped_by_idx on clients (emails_stopped_by) where emails_stopped_by is not null;

-- 2. The first approval email the rep sent themselves: when, and who recorded it.
alter table approvals
  add column first_sent_at timestamptz,
  add column first_sent_by uuid references app_users (id) on delete set null;
create index approvals_first_sent_by_idx on approvals (first_sent_by) where first_sent_by is not null;

-- 3. A suppression written by hand must never hide the merchant's own wish. The hard stop writes a 'manual' row for the
--    address; if the merchant then unsubscribes, replies stop or complains, the row's reason becomes theirs, so a
--    manager's "turn emails back on" (which only clears a manual row) cannot undo it. This is the 0564 function (its
--    caller checks, owner, grants and search path) with one change: the conflict branch.
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
   where suppressions.reason = 'manual' and excluded.reason in ('unsubscribe', 'stop_reply', 'complaint', 'dnc');
end $$;

-- 4. Stop every automated email to one merchant, for good. Definer: it writes rows a rep's session cannot reach (the
--    suppression list, a queued row under another user_id); app.can_touch_client is the check row security would have
--    made (the rep's own merchant, or a manager). Idempotent. Returns what it did.
--      - a merchant who already opted out themselves keeps that (nothing is flagged, so turning emails back on can
--        never undo their own wish); what is queued and the approval sequence are still wound down
--      - the approval sequence stops with the note 'manual_stop' (a finished one stays finished)
--      - queued mail is cancelled on every lane except 'reply': the rep's own one-off sends (the offer email) are
--        theirs, and the worker still refuses them while the opt-out stands
--      - mail already sent, or in flight ('sending'), is never touched
create function public.stop_merchant_emails(p_client uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c clients;
  me uuid := app.current_user_id();
  v_name text;
  n_out int := 0;
  n_enr int := 0;
  n_app int := 0;
  already_out boolean;
begin
  if not app.can_touch_client(p_client) then raise exception 'client not found' using errcode = 'P0002'; end if;
  select * into c from clients where id = p_client for update;
  if not found then raise exception 'client not found' using errcode = 'P0002'; end if;
  if c.emails_stopped_at is not null then
    return jsonb_build_object('already', true, 'was_opted_out', false, 'cancelled', 0, 'enrollments', 0, 'approvals', 0);
  end if;
  already_out := c.email_opt_out;
  if not already_out then
    update clients set email_opt_out = true, emails_stopped_at = now(), emails_stopped_by = me where id = p_client;
    -- an empty address cannot be suppressed (its hash would match every merchant without one): the flag covers it
    if btrim(c.email) <> '' then
      perform app.suppress('email', app.suppression_key(c.email), lower(btrim(c.email)), 'manual', 'Emails stopped by hand', p_client, me);
    end if;
  end if;
  update approvals set emails = 'stopped', emails_note = 'manual_stop', next_step = null, next_email_at = null
   where client_id = p_client and status = 'open' and emails in ('running', 'paused');
  get diagnostics n_app = row_count;
  update outbox set status = 'cancelled', skip_reason = 'manual_stop'
   where client_id = p_client and status = 'queued' and lane <> 'reply';
  get diagnostics n_out = row_count;
  n_enr := stop_enrollment(p_client, 'opted_out');
  select coalesce(nullif(btrim(u.name), ''), u.email) into v_name from app_users u where u.id = coalesce(me, c.user_id);
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Emails stopped by ' || coalesce(v_name, 'a teammate'));
  return jsonb_build_object('already', false, 'was_opted_out', already_out, 'cancelled', n_out, 'enrollments', n_enr, 'approvals', n_app);
end $$;
revoke execute on function public.stop_merchant_emails(uuid) from public;
grant execute on function public.stop_merchant_emails(uuid) to isaac_app;

-- 5. Turn the emails back on (managers). Clears what the hard stop set, and nothing else: the approval's sequence stays
--    stopped (the note becomes 'reopened', so the row offers "Start the emails" and only a person pressing it restarts
--    anything), the bucket enrolment stays stopped, nothing is queued. Refused when the merchant has also asked not to
--    be emailed (unsubscribed, replied stop, complained): that wish stands.
create function public.resume_merchant_emails(p_client uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c clients;
  me uuid := app.current_user_id();
  v_name text;
  n_app int := 0;
begin
  if not app.can_see_all() then raise exception 'Only a manager can turn emails back on' using errcode = '22023'; end if;
  select * into c from clients where id = p_client for update;
  if not found then raise exception 'client not found' using errcode = 'P0002'; end if;
  if c.emails_stopped_at is null then return jsonb_build_object('changed', false, 'approvals', 0); end if;
  if exists (select 1 from suppressions s
              where s.channel = 'email' and s.reason in ('unsubscribe', 'stop_reply', 'complaint', 'dnc')
                and (s.client_id = p_client or s.key_hash = app.suppression_key(c.email))) then
    raise exception 'This merchant also asked not to be emailed (they unsubscribed, replied stop or complained), so their emails cannot be turned back on'
      using errcode = '22023';
  end if;
  delete from suppressions
   where channel = 'email' and reason = 'manual'
     and (client_id = p_client or (btrim(c.email) <> '' and key_hash = app.suppression_key(c.email)));
  update clients set email_opt_out = false, emails_stopped_at = null, emails_stopped_by = null where id = p_client;
  update approvals set emails_note = 'reopened'
   where client_id = p_client and status = 'open' and emails = 'stopped' and emails_note = 'manual_stop';
  get diagnostics n_app = row_count;
  select coalesce(nullif(btrim(u.name), ''), u.email) into v_name from app_users u where u.id = coalesce(me, c.user_id);
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Emails turned back on by ' || coalesce(v_name, 'a manager'));
  return jsonb_build_object('changed', true, 'approvals', n_app);
end $$;
revoke execute on function public.resume_merchant_emails(uuid) from public;
grant execute on function public.resume_merchant_emails(uuid) to isaac_app;
