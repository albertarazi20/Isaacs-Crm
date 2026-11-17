-- Third review (2026-11-17, early morning): the nudge after an open, re-bucketing a closed chase, an index.
--   1. A queued nudge is cancelled by the worker when anything happened after it was queued (app.nudge_overtaken):
--      a reply, a call, a text or an email (by hand or automated), a document, a signature, a hand-off, a pause, or
--      the merchant leaving their bucket. Bucket steps had this through their enrolment; a nudge has no enrolment.
--   2. shop_settings.open_nudge_since: switching the nudge on starts its clock. Opens from before (including the ones
--      a signed-in rep made before /api/seen ignored staff) never trigger it.
--   3. A complete file still reaches "Ready to hand off" when the chase is closed (bounced, opted out, do not
--      contact): Ready sends nothing, and it is where the rep's "ready to hand off" alert comes from. Every other move
--      for a closed chase stays refused (0549).
--   4. inbound_emails (client_id, received_at): the per-merchant "last reply" reads were a scan per merchant.

create index if not exists inbound_emails_client_idx on inbound_emails (client_id, received_at desc)
  where client_id is not null;

alter table shop_settings add column open_nudge_since timestamptz;
update shop_settings set open_nudge_since = now() where open_nudge and open_nudge_since is null;

create function app.nudge_overtaken(p_client uuid, p_since timestamptz) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select exists (select 1 from activities a
                  where a.client_id = p_client and a.occurred_at >= p_since and a.kind in ('call', 'text', 'email'))
      or exists (select 1 from documents d
                  where d.client_id = p_client and d.created_at >= p_since and d.deleted_at is null)
      or exists (select 1 from applications ap where ap.client_id = p_client and ap.signed_at >= p_since)
      or exists (select 1 from clients c
                  where c.id = p_client
                    and (c.brought_in_at is not null or c.reply_waiting_since >= p_since))
      or not exists (select 1 from enrollments e
                      where e.client_id = p_client and e.stopped_at is null and not e.paused)
$$;
revoke execute on function app.nudge_overtaken(uuid, timestamptz) from public;
grant execute on function app.nudge_overtaken(uuid, timestamptz) to isaac_app;

create or replace function app.rebucket_by_stips(p_client uuid, p_enrol boolean default true) returns void
language plpgsql set search_path = public, pg_temp as $$
declare want text; b uuid; cur enrollments; e enrollments;
begin
  -- handed off or in the trash: nothing moves (enroll_in_bucket would refuse, and this runs inside triggers)
  if exists (select 1 from clients where id = p_client and brought_in_at is not null)
     or exists (select 1 from trashed_clients where client_id = p_client) then
    return;
  end if;
  want := app.stips_bucket(p_client);
  if want is null then return; end if;
  -- a closed chase is never re-opened; a complete file still goes to Ready, which sends nothing
  if want <> 'ready_for_ops' and app.chase_closed(p_client) then return; end if;
  select id into b from buckets where key = want and active;
  if b is null then return; end if;
  select * into cur from enrollments where client_id = p_client and stopped_at is null
   order by entered_at desc limit 1;
  if cur.id is null and not p_enrol then return; end if;
  if cur.id is not null and not exists (select 1 from buckets where id = cur.bucket_id and key is not null) then
    return;
  end if;
  if cur.bucket_id is not distinct from b then return; end if;
  e := enroll_in_bucket(p_client, b, 'document_received');
  if cur.paused then
    update enrollments set paused = true, resume_on = cur.resume_on,
                           next_due_on = coalesce(cur.resume_on, next_due_on)
     where id = e.id;
  end if;
end $$;
