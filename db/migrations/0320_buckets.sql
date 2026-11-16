-- Follow-up buckets and sequences.
--   buckets      — where a lead sits while the shop chases it. System buckets are computed from the stips checklist
--                  (missing application, missing statements…); personal buckets belong to one rep; shared ones to all.
--   templates    — an email (subject + body with {merge_fields}); owned by a rep or shared; manager-approved before
--                  it may send automatically. Rotation variants hang off the same template.
--   bucket_steps — the sequence: on day N send template T. With shop_settings.sequences_enabled = false the engine
--                  sends step 1's template every day instead (the owner's original ask, as a switch).
--   enrollments  — one row per merchant per bucket: when they entered, which step is next and when, why they stopped.
-- The engine (src/lib/buckets) runs daily per merchant: due step → outbox → next step scheduled. Stop rules cancel
-- the enrolment: a reply, a document received, a stage/deal change, opt-out, bounce, or a rep pressing Pause.

create table buckets (
  id uuid primary key default gen_random_uuid(),
  key text,                                   -- system buckets have a key; personal ones null
  name text not null check (btrim(name) <> '' and length(name) <= 60),
  owner_id uuid references app_users (id) on delete cascade,   -- null = shared (everyone), else that rep's own
  -- what puts a merchant here automatically (system buckets); null = only by hand or from lead intake
  rule text check (rule in ('missing_application', 'missing_statements', 'missing_newest_statement', 'missing_id',
                            'ready_for_ops', 'cold', 'manual')),
  sort int not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (key)
);
create unique index buckets_owner_name_key on buckets (coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name)));
create trigger buckets_touch before update on buckets for each row execute function app.touch_updated_at();

insert into buckets (key, name, rule, sort) values
  ('interested',        'Interested',               'manual',                  10),
  ('missing_app',       'Missing application',       'missing_application',     20),
  ('missing_statements','Missing statements',        'missing_statements',      30),
  ('missing_newest',    'Need newest statement',     'missing_newest_statement',40),
  ('missing_id',        'Missing ID / voided check', 'missing_id',              50),
  ('ready_for_ops',     'Ready for ops',             'ready_for_ops',           60),
  ('cold',              'Cold',                      'cold',                    90);

create table templates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid references app_users (id) on delete cascade,   -- null = shared
  name text not null check (btrim(name) <> '' and length(name) <= 80),
  channel text not null default 'email' check (channel in ('email', 'sms')),
  subject text not null default '' check (length(subject) <= 200),
  body text not null check (btrim(body) <> '' and length(body) <= 5000),
  -- a rep-written template needs a manager's OK before the engine will send it on its own
  approved boolean not null default false,
  approved_by uuid references app_users (id) on delete set null,
  approved_at timestamptz,
  archived boolean not null default false,
  created_by uuid references app_users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index templates_owner_idx on templates (owner_id, archived);
create trigger templates_touch before update on templates for each row execute function app.touch_updated_at();

-- A template may have rotation variants: same step, different wording per merchant (anti-spam).
create table template_variants (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references templates (id) on delete cascade,
  subject text not null default '' check (length(subject) <= 200),
  body text not null check (btrim(body) <> '' and length(body) <= 5000),
  sort int not null default 0
);
create index template_variants_tpl_idx on template_variants (template_id, sort);

create table bucket_steps (
  id uuid primary key default gen_random_uuid(),
  bucket_id uuid not null references buckets (id) on delete cascade,
  step_no int not null check (step_no >= 1),
  -- days after entering the bucket (step 1 is usually 0 = the day they enter)
  day_offset int not null check (day_offset >= 0),
  template_id uuid references templates (id) on delete set null,
  -- 'email' sends the template; 'call' creates a call task instead of a fourth email; 'move' moves to another bucket
  action text not null default 'email' check (action in ('email', 'call', 'move_to_cold')),
  unique (bucket_id, step_no)
);

create table enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users (id) on delete cascade,   -- the rep (RLS key)
  client_id uuid not null,
  bucket_id uuid not null references buckets (id) on delete cascade,
  entered_at timestamptz not null default now(),
  -- which step fires next and the calendar day it is due (in the merchant's zone)
  next_step int not null default 1,
  next_due_on date,
  steps_sent int not null default 0,
  paused boolean not null default false,
  stopped_at timestamptz,
  stop_reason text check (stop_reason in ('replied', 'document_received', 'moved', 'deal_submitted', 'opted_out', 'bounced',
                                          'paused', 'sequence_done', 'removed', 'funded', 'dnc')),
  -- the last email on this enrolment, so a reply on that thread can be matched back here
  last_outbox_id uuid references outbox (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (client_id, user_id) references clients (id, user_id) on delete cascade
);
-- one live enrolment per merchant per bucket
create unique index enrollments_live_key on enrollments (client_id, bucket_id) where stopped_at is null;
create index enrollments_due_idx on enrollments (next_due_on) where stopped_at is null and not paused;
create index enrollments_client_idx on enrollments (client_id) where stopped_at is null;

-- grants + RLS
grant select, insert, update, delete on buckets, templates, template_variants, bucket_steps, enrollments to isaac_app;
alter table buckets enable row level security;
alter table templates enable row level security;
alter table template_variants enable row level security;
alter table bucket_steps enable row level security;
alter table enrollments enable row level security;

-- Everyone reads shared buckets/templates and their own; writes: own rows, or a manager for shared and others'.
create policy buckets_read on buckets for select to isaac_app using (owner_id is null or owner_id = app.current_user_id() or app.can_see_all());
create policy buckets_write_own on buckets for all to isaac_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());
create policy buckets_write_manager on buckets for all to isaac_app using (app.can_see_all()) with check (app.can_see_all());

create policy templates_read on templates for select to isaac_app using (owner_id is null or owner_id = app.current_user_id() or app.can_see_all());
create policy templates_write_own on templates for all to isaac_app
  using (owner_id = app.current_user_id()) with check (owner_id = app.current_user_id());
create policy templates_write_manager on templates for all to isaac_app using (app.can_see_all()) with check (app.can_see_all());

create policy template_variants_read on template_variants for select to isaac_app
  using (exists (select 1 from templates t where t.id = template_id));
create policy template_variants_write on template_variants for all to isaac_app
  using (exists (select 1 from templates t where t.id = template_id and (t.owner_id = app.current_user_id() or app.can_see_all())))
  with check (exists (select 1 from templates t where t.id = template_id and (t.owner_id = app.current_user_id() or app.can_see_all())));

create policy bucket_steps_read on bucket_steps for select to isaac_app using (exists (select 1 from buckets b where b.id = bucket_id));
create policy bucket_steps_write on bucket_steps for all to isaac_app
  using (exists (select 1 from buckets b where b.id = bucket_id and (b.owner_id = app.current_user_id() or app.can_see_all())))
  with check (exists (select 1 from buckets b where b.id = bucket_id and (b.owner_id = app.current_user_id() or app.can_see_all())));

create policy enrollments_owner on enrollments for all to isaac_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy enrollments_team on enrollments for all to isaac_app using (app.can_see_all()) with check (app.can_see_all());

-- Only an approved template (or a shared one written by a manager) may be sent by the engine.
create function app.template_may_auto_send(p_template uuid) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select exists (select 1 from templates t where t.id = p_template and not t.archived and (t.approved or t.owner_id is null))
$$;

-- Which system bucket the stips checklist says a merchant belongs in right now. Null = none (nothing is missing,
-- or no checklist exists yet). Order matters: application first, then statements, then ID, then ready.
create function app.stips_bucket(p_client uuid) returns text
language plpgsql stable set search_path = public, pg_temp as $$
declare has_checklist boolean; app_missing boolean; stmt_missing boolean; newest_missing boolean; id_missing boolean;
begin
  select exists (select 1 from stips where client_id = p_client and required) into has_checklist;
  if not has_checklist then return null; end if;
  select exists (select 1 from stips where client_id = p_client and required and kind = 'signed_application' and received_at is null) into app_missing;
  if app_missing then return 'missing_app'; end if;
  select exists (select 1 from stips where client_id = p_client and required and kind = 'bank_statement' and received_at is null
                    and period < date_trunc('month', current_date)::date) into stmt_missing;
  if stmt_missing then return 'missing_statements'; end if;
  select exists (select 1 from stips where client_id = p_client and required and kind = 'bank_statement' and received_at is null) into newest_missing;
  if newest_missing then return 'missing_newest'; end if;
  select exists (select 1 from stips where client_id = p_client and required and kind in ('drivers_license', 'voided_check') and received_at is null) into id_missing;
  if id_missing then return 'missing_id'; end if;
  return 'ready_for_ops';
end $$;

-- Enrol a merchant in a bucket: ends any other live enrolment (one bucket at a time), schedules step 1.
create function public.enroll_in_bucket(p_client uuid, p_bucket uuid, p_reason text default 'moved')
returns enrollments
language plpgsql set search_path = public, pg_temp as $$
declare c clients; e enrollments; first_offset int; today_local date;
begin
  select * into c from clients where id = p_client for update;
  if not found then raise exception 'client not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from buckets where id = p_bucket and active) then
    raise exception 'bucket not found' using errcode = 'P0002';
  end if;
  -- already there: nothing to do
  select * into e from enrollments where client_id = p_client and bucket_id = p_bucket and stopped_at is null;
  if found then return e; end if;
  update enrollments set stopped_at = now(), stop_reason = p_reason
   where client_id = p_client and stopped_at is null;
  -- queued steps of the old bucket must not fire
  update outbox set status = 'cancelled', skip_reason = 'stopped'
   where client_id = p_client and status = 'queued' and lane = 'sequence' and source like 'bucket:%';
  today_local := (now() at time zone app.client_timezone(c))::date;
  select coalesce(min(day_offset), 0) into first_offset from bucket_steps where bucket_id = p_bucket;
  insert into enrollments (user_id, client_id, bucket_id, next_step, next_due_on)
  values (c.user_id, p_client, p_bucket, 1, today_local + first_offset)
  returning * into e;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, p_client, 'system', 'Moved to bucket ' || (select name from buckets where id = p_bucket));
  return e;
end $$;

-- Stop a merchant's live enrolment(s). Idempotent.
create function public.stop_enrollment(p_client uuid, p_reason text)
returns int
language plpgsql set search_path = public, pg_temp as $$
declare n int;
begin
  update enrollments set stopped_at = now(), stop_reason = p_reason
   where client_id = p_client and stopped_at is null;
  get diagnostics n = row_count;
  if n > 0 then
    update outbox set status = 'cancelled', skip_reason = 'stopped'
     where client_id = p_client and status = 'queued' and lane = 'sequence' and source like 'bucket:%';
  end if;
  return n;
end $$;

-- A document arrived (a stip ticked): re-bucket by the checklist. Called by the stips trigger below.
create function app.rebucket_by_stips(p_client uuid) returns void
language plpgsql set search_path = public, pg_temp as $$
declare want text; b uuid; cur uuid;
begin
  want := app.stips_bucket(p_client);
  if want is null then return; end if;
  select id into b from buckets where key = want;
  select bucket_id into cur from enrollments where client_id = p_client and stopped_at is null limit 1;
  -- only move between system buckets; a rep's own bucket is theirs to manage
  if cur is not null and not exists (select 1 from buckets where id = cur and key is not null) then return; end if;
  if cur is distinct from b then perform enroll_in_bucket(p_client, b, 'document_received'); end if;
end $$;

create function app.stips_changed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (new.received_at is distinct from old.received_at or new.required is distinct from old.required) then
    perform app.rebucket_by_stips(new.client_id);
  elsif tg_op = 'INSERT' then
    perform app.rebucket_by_stips(new.client_id);
  end if;
  return new;
end $$;
create trigger stips_rebucket after insert or update on stips for each row execute function app.stips_changed();

-- A deal submitted to ops ends the chase; funded too.
create function app.deal_changed() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then perform stop_enrollment(new.client_id, 'deal_submitted'); end if;
  if tg_op = 'UPDATE' and new.outcome = 'funded' and old.outcome <> 'funded' then perform stop_enrollment(new.client_id, 'funded'); end if;
  return new;
end $$;
create trigger deals_stop_enrollment after insert or update on deals for each row execute function app.deal_changed();

-- A touch logged by a person (a reply they recorded, a call) does not stop the sequence; a merchant REPLY does.
-- Replies arrive through the inbox sync (Phase 3) which calls stop_enrollment(client, 'replied') explicitly.

-- Opt-out and bounce stop everything.
create or replace function public.opt_out(p_client uuid, p_channel text, p_reason text, p_note text default '')
returns void
language plpgsql set search_path = public, pg_temp as $$
declare c clients;
begin
  select * into c from clients where id = p_client;
  if not found then return; end if;
  if p_channel = 'email' then
    update clients set email_opt_out = true where id = p_client;
    if c.email <> '' then
      insert into suppressions (channel, key_hash, display, reason, note, client_id, created_by)
      values ('email', app.suppression_key(c.email), lower(c.email), p_reason, p_note, p_client, app.current_user_id())
      on conflict (channel, key_hash) do nothing;
    end if;
    update outbox set status = 'cancelled', skip_reason = 'suppressed' where client_id = p_client and status = 'queued' and lane in ('sequence', 'blast');
    perform stop_enrollment(p_client, case when p_reason = 'hard_bounce' then 'bounced' else 'opted_out' end);
  elsif p_channel = 'sms' then
    update clients set sms_opt_out = true where id = p_client;
    if c.phone <> '' then
      insert into suppressions (channel, key_hash, display, reason, note, client_id, created_by)
      values ('sms', app.suppression_key(regexp_replace(c.phone, '\D', '', 'g')), c.phone, p_reason, p_note, p_client, app.current_user_id())
      on conflict (channel, key_hash) do nothing;
    end if;
  end if;
  insert into activities (user_id, client_id, kind, body)
  values (c.user_id, c.id, 'system', 'Opted out of ' || p_channel || ' (' || replace(p_reason, '_', ' ') || ')' ||
          case when btrim(coalesce(p_note, '')) <> '' then ': ' || btrim(p_note) else '' end);
end $$;

-- Starter templates and steps for the system buckets (shared, so they may auto-send). Plain, short, one link.
do $$
declare
  t_app uuid; t_app2 uuid; t_app3 uuid; t_stmt uuid; t_stmt2 uuid; t_stmt3 uuid; t_newest uuid; t_id uuid; t_int uuid; t_int2 uuid; t_cold uuid;
  b uuid;
begin
  insert into templates (owner_id, name, subject, body, approved) values
   (null, 'Application — first ask', 'Your application for {business}',
    'Hi {first_name},' || E'\n\n' || 'Here is the application for {business}: {application_link}' || E'\n\n' || 'It takes about five minutes. As soon as it is signed and back I start getting offers.' || E'\n\n' || 'If anything is unclear, reply here and I will help.', true)
   returning id into t_app;
  insert into templates (owner_id, name, subject, body, approved) values
   (null, 'Application — second ask', 'Still need your signed application',
    'Hi {first_name},' || E'\n\n' || 'Quick one: the application for {business} is still waiting on your signature. Here is the link again: {application_link}' || E'\n\n' || 'Is there anything on it you want me to walk through?', true)
   returning id into t_app2;
  insert into templates (owner_id, name, subject, body, approved) values
   (null, 'Application — last ask', 'Should I close your file for now?',
    'Hi {first_name},' || E'\n\n' || 'I have not heard back on the application for {business}. If the timing is off I will set your file aside and check in later. If you still want to move, the link is {application_link}.', true)
   returning id into t_app3;
  insert into templates (owner_id, name, subject, body, approved) values
   (null, 'Statements — first ask', 'Bank statements for {business}',
    'Hi {first_name},' || E'\n\n' || 'To put {business} in front of lenders I need the last months of business bank statements, every page. You can upload them here: {upload_link}' || E'\n\n' || 'The sooner I have them, the sooner offers come back.', true)
   returning id into t_stmt;
  insert into templates (owner_id, name, subject, body, approved) values
   (null, 'Statements — second ask', 'Still missing statements for {business}',
    'Hi {first_name},' || E'\n\n' || 'I am still missing bank statements for {business}. Upload link: {upload_link}' || E'\n\n' || 'If you would rather text them from your phone, reply here and I will send a link by text.', true)
   returning id into t_stmt2;
  insert into templates (owner_id, name, subject, body, approved) values
   (null, 'Statements — last ask', 'Last call on statements',
    'Hi {first_name},' || E'\n\n' || 'Without the statements I cannot get {business} an offer. Here is the link one more time: {upload_link}. If now is not the time, no problem, I will check back in a few weeks.', true)
   returning id into t_stmt3;
  insert into templates (owner_id, name, subject, body, approved) values
   (null, 'Newest statement', 'One more statement for {business}',
    'Hi {first_name},' || E'\n\n' || 'The month turned, so lenders will ask for your newest bank statement before they approve {business}. Upload it here: {upload_link}', true)
   returning id into t_newest;
  insert into templates (owner_id, name, subject, body, approved) values
   (null, 'ID and voided check', 'Two small items for {business}',
    'Hi {first_name},' || E'\n\n' || 'Two quick items to close the file for {business}: a photo of your driver''s license and a voided check. Upload here: {upload_link}', true)
   returning id into t_id;
  insert into templates (owner_id, name, subject, body, approved) values
   (null, 'Interested — check in', 'Funding for {business}',
    'Hi {first_name},' || E'\n\n' || 'Good speaking with you about {business}. Here is the application to get started: {application_link}. It takes five minutes and I can usually have numbers back within a day of the file being complete.', true)
   returning id into t_int;
  insert into templates (owner_id, name, subject, body, approved) values
   (null, 'Interested — follow up', 'Still looking at funding for {business}?',
    'Hi {first_name},' || E'\n\n' || 'Checking in on the funding you were looking at for {business}. If you want numbers, the application is here: {application_link}. If the timing changed, tell me and I will check back later.', true)
   returning id into t_int2;
  insert into templates (owner_id, name, subject, body, approved) values
   (null, 'Cold — monthly nudge', 'Still here if {business} needs capital',
    'Hi {first_name},' || E'\n\n' || 'It has been a while since we spoke about {business}. If funding is on your mind this month I am glad to run fresh numbers. Just reply.', true)
   returning id into t_cold;

  select id into b from buckets where key = 'missing_app';
  insert into bucket_steps (bucket_id, step_no, day_offset, template_id, action) values (b, 1, 0, t_app, 'email'), (b, 2, 1, t_app2, 'email'), (b, 3, 3, t_app3, 'email'), (b, 4, 5, null, 'call'), (b, 5, 14, null, 'move_to_cold');
  select id into b from buckets where key = 'missing_statements';
  insert into bucket_steps (bucket_id, step_no, day_offset, template_id, action) values (b, 1, 0, t_stmt, 'email'), (b, 2, 1, t_stmt2, 'email'), (b, 3, 3, t_stmt3, 'email'), (b, 4, 5, null, 'call'), (b, 5, 14, null, 'move_to_cold');
  select id into b from buckets where key = 'missing_newest';
  insert into bucket_steps (bucket_id, step_no, day_offset, template_id, action) values (b, 1, 0, t_newest, 'email'), (b, 2, 2, t_newest, 'email'), (b, 3, 5, null, 'call');
  select id into b from buckets where key = 'missing_id';
  insert into bucket_steps (bucket_id, step_no, day_offset, template_id, action) values (b, 1, 0, t_id, 'email'), (b, 2, 2, t_id, 'email'), (b, 3, 5, null, 'call');
  select id into b from buckets where key = 'interested';
  insert into bucket_steps (bucket_id, step_no, day_offset, template_id, action) values (b, 1, 0, t_int, 'email'), (b, 2, 2, t_int2, 'email'), (b, 3, 5, null, 'call'), (b, 4, 10, t_int2, 'email'), (b, 5, 21, null, 'move_to_cold');
  select id into b from buckets where key = 'cold';
  insert into bucket_steps (bucket_id, step_no, day_offset, template_id, action) values (b, 1, 30, t_cold, 'email'), (b, 2, 60, t_cold, 'email'), (b, 3, 90, t_cold, 'email');
end $$;
