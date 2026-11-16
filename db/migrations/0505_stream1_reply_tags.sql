-- Stream 1, S1-6: merchant replies tagged by Claude (plan §5.5). The inbox sync stores a merchant's reply in
-- inbound_emails and stops the chase; the classifier (src/lib/ai/classifyReply.ts, driven by
-- src/lib/messaging/replyTags.ts) then says what the reply was, and apply_reply_tag turns the tag into state:
--   not_now      → clients.revive_on; the enrolment is kept, paused, with resume_on = that date, and the bucket engine
--                  re-opens it on the day (src/lib/buckets/engine.ts) from step 1;
--   wrong_person → clients.wrong_person_at and a follow-up for the rep today: find the right contact;
--   stop         → the existing opt-out path (the regex in the sync catches the obvious ones; this catches the rest);
--   interested / sending_docs / other → the tag is kept and the timeline says so.
-- reply_tags is the tagging state: one row per email, so the driver never classifies an email twice.

alter table clients
  add column revive_on date,
  add column wrong_person_at timestamptz;

create table reply_tags (
  id uuid primary key default gen_random_uuid(),
  email_id uuid not null unique references inbound_emails (id) on delete cascade,
  client_id uuid references clients (id) on delete cascade,
  tag text not null check (tag in ('interested', 'sending_docs', 'not_now', 'stop', 'wrong_person', 'other')),
  confidence numeric(3,2) not null check (confidence between 0 and 1),
  -- the merchant's words the tag rests on; supported = code found them in the email (an unsupported tag is stored as 'other')
  quote text not null default '',
  supported boolean not null default true,
  revive_on date,
  model text not null default '',
  created_at timestamptz not null default now()
);
create index reply_tags_client_idx on reply_tags (client_id, created_at desc);
grant select on reply_tags to isaac_app;
alter table reply_tags enable row level security;
create policy reply_tags_read on reply_tags for select to isaac_app
  using (app.can_see_all() or exists (select 1 from clients c where c.id = client_id and c.user_id = app.current_user_id()));

create function public.apply_reply_tag(p_email uuid, p_tag text, p_confidence numeric, p_quote text, p_supported boolean,
                                       p_model text, p_revive_days int default null)
returns reply_tags
language plpgsql security definer set search_path = public, pg_temp as $$
declare e inbound_emails; c clients; r reply_tags; rep app_users; b uuid; live uuid; tz text; revive date; task_note text;
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
    select id into live from enrollments where client_id = c.id and stopped_at is null order by entered_at desc limit 1;
    if live is not null then
      update enrollments set paused = true, resume_on = revive, next_step = 1, steps_sent = 0, next_due_on = revive,
                             entered_at = (revive::timestamp at time zone tz)
       where id = live;
    else
      -- the bucket the reply stopped: the chase picks up there again on the day, from step 1
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
    values (c.user_id, c.id, 'system', 'Merchant said not now — follow-up emails paused until ' || to_char(revive, 'FMMon FMDD, YYYY'));
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
    if not c.email_opt_out then
      perform opt_out(c.id, 'email', 'stop_reply', left(coalesce(p_quote, ''), 200));
    end if;
  else
    insert into activities (user_id, client_id, kind, body)
    values (c.user_id, c.id, 'system', 'Reply tagged: ' || replace(p_tag, '_', ' ')
            || case when p_supported then '' else ' (the words could not be checked)' end);
  end if;
  return r;
end $$;
revoke execute on function public.apply_reply_tag(uuid, text, numeric, text, boolean, text, int) from public;
grant execute on function public.apply_reply_tag(uuid, text, numeric, text, boolean, text, int) to isaac_app;
