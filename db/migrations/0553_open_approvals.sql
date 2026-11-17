-- Open approvals (owner, 2026-11-17): a merchant who got an offer and has not been pitched yet sits on its own page
-- until a rep pitches it. The rep marks the approval (amount, how long the funder holds it); the shop's HTML approval
-- emails then go out on their own: the first one right away (in the day, merchant's time), and each follow-up a set
-- time after the one before it actually went (the outbox's sent_at is the clock). The emails stop the moment the
-- merchant replies, the rep pitches or closes it, the hold date passes, or the merchant can no longer be emailed.

-- The rep's phone number: the approval emails are a call to action ({{rep_phone}}).
alter table app_users add column phone text not null default '' check (length(phone) <= 40);
-- a rep sets their own (app_users_self_update limits the row; updates are granted column by column)
grant update (phone) on app_users to isaac_app;

alter table shop_settings
  add column approval_emails_on boolean not null default true,
  add column approval_window_start integer not null default 9 check (approval_window_start between 0 and 23),
  add column approval_window_end integer not null default 18 check (approval_window_end between 1 and 24),
  add column approval_weekends boolean not null default false,
  add constraint shop_settings_approval_window_check check (approval_window_start < approval_window_end);

-- The emails, in order: step 1 goes when the approval is marked, every later step `delay_hours` after the step before
-- it was sent. One shop-wide set; managers edit it in Settings. The HTML is the shop's own design and carries its own
-- footer, so it must hold {{unsubscribe_link}} (checked when it is saved).
create table approval_emails (
  step integer primary key check (step between 1 and 6),
  subject text not null default '' check (length(subject) <= 200),
  html text not null default '' check (length(html) <= 200000),
  file_name text not null default '' check (length(file_name) <= 200),
  delay_hours integer not null default 24 check (delay_hours between 0 and 2160),
  updated_at timestamptz not null default now(),
  updated_by uuid references app_users (id) on delete set null,
  check (step = 1 or delay_hours >= 1)
);
insert into approval_emails (step, delay_hours) values (1, 0), (2, 24), (3, 48), (4, 72);
create trigger approval_emails_touch before update on approval_emails
  for each row execute function app.touch_updated_at();

alter table approval_emails enable row level security;
create policy approval_emails_read on approval_emails for select to isaac_app using (true);
create policy approval_emails_write on approval_emails to isaac_app
  using (app.can_see_all()) with check (app.can_see_all());
grant select, insert, update, delete on approval_emails to isaac_app;

create table approvals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id) on delete cascade,
  -- the rep the emails come from (name, phone, mailbox): the merchant's owner when it was marked
  user_id uuid not null references app_users (id) on delete cascade,
  amount_cents bigint not null check (amount_cents > 0 and amount_cents <= 100000000000),
  hold_until date,
  funder text not null default '' check (length(funder) <= 120),
  note text not null default '' check (length(note) <= 2000),
  status text not null default 'open' check (status in ('open', 'pitched', 'closed')),
  emails text not null default 'running' check (emails in ('running', 'paused', 'stopped', 'finished')),
  -- why the emails stopped or are waiting, as a short code (replied, expired, opted_out, no_phone, …)
  emails_note text not null default '' check (length(emails_note) <= 300),
  -- set when the emails start or resume: a failed send from before a Resume does not stop them again
  emails_since timestamptz not null default now(),
  next_step integer,
  next_email_at timestamptz,
  created_by uuid references app_users (id) on delete set null,
  created_at timestamptz not null default now(),
  pitched_at timestamptz,
  pitched_by uuid references app_users (id) on delete set null,
  closed_at timestamptz,
  closed_by uuid references app_users (id) on delete set null,
  closed_reason text not null default '' check (length(closed_reason) <= 300),
  -- what the emails were doing when Pitched or Close stopped them, so an Undo puts them back as they were
  emails_before text check (emails_before in ('running', 'paused', 'stopped', 'finished')),
  emails_note_before text,
  updated_at timestamptz not null default now()
);
create unique index approvals_one_open_idx on approvals (client_id) where status = 'open';
create index approvals_status_idx on approvals (status, created_at desc);
create index approvals_client_idx on approvals (client_id, created_at desc);
create index approvals_user_idx on approvals (user_id);
create index approvals_created_by_idx on approvals (created_by);
create index approvals_pitched_by_idx on approvals (pitched_by);
create index approvals_closed_by_idx on approvals (closed_by);
create trigger approvals_touch before update on approvals
  for each row execute function app.touch_updated_at();

-- A rep sees (and works) the approvals of the merchants they can see.
alter table approvals enable row level security;
create policy approvals_visible on approvals to isaac_app
  using (exists (select 1 from clients c where c.id = client_id))
  with check (exists (select 1 from clients c where c.id = client_id));
grant select, insert, update on approvals to isaac_app;

-- The approval emails ride the outbox on their own lane: the sequence rules (frequency caps, the "approved" claim
-- check, the hand-off cancel) do not apply to them; unsubscribe, suppression, the postal address and the daily cap do.
alter table outbox drop constraint outbox_lane_check;
alter table outbox add constraint outbox_lane_check
  check (lane in ('intake', 'reply', 'sequence', 'blast', 'system', 'approval'));
-- each step of an approval goes once
create unique index outbox_approval_once_idx on outbox (source)
  where lane = 'approval' and status in ('queued', 'sending', 'sent');

-- Why an approval's emails must not go now (null: they may). Read by the engine before it queues a step and by the
-- worker right before it sends one, so a reply that lands between the two still stops the email. Security invoker:
-- the engine and the worker run as the owner and see everything; a rep calling it (the page) sees only their own.
-- A bounce stops it through the suppression list, so a corrected address can be emailed again; a reply counts only
-- when the sync verified it came from the merchant (SPF and DKIM), like everywhere else.
create function app.approval_halt(p_approval uuid) returns text
  language sql stable set search_path = public, pg_temp as $$
  select case
    when a.id is null then 'gone'
    when a.status = 'pitched' then 'pitched'
    when a.status = 'closed' then 'closed'
    when a.emails = 'paused' then 'paused'
    when a.emails = 'finished' then 'finished'
    when a.emails <> 'running' then 'stopped'
    when exists (select 1 from trashed_clients t where t.client_id = c.id) then 'trashed'
    when c.contact_status in ('dnc', 'no_email') then 'dnc'
    when c.email_opt_out then 'opted_out'
    when btrim(c.email) = '' then 'no_email'
    when app.is_suppressed('email', c.email) then
      case when c.email_bounced_at is not null then 'bounced' else 'suppressed' end
    when c.reply_waiting_since >= a.emails_since
      or exists (select 1 from inbound_emails i
                  where i.client_id = c.id and i.kind = 'merchant' and i.received_at >= a.emails_since) then 'replied'
    when a.hold_until is not null
      and a.hold_until < (now() at time zone app.client_timezone(c))::date then 'expired'
    when not (select s.approval_emails_on from shop_settings s) then 'turned_off'
    else null
  end
  from (select 1) one
  left join approvals a on a.id = p_approval
  left join clients c on c.id = a.client_id
$$;
grant execute on function app.approval_halt(uuid) to isaac_app;

-- A merchant who answered since the emails started and has not been called since: the rep's next call. Drives the
-- "Replied, call them now" badge, the replies-first order and the Replied count, whatever state the emails are in (a
-- merchant answering the last follow-up is the usual case). A reply from before the emails (re)started does not count.
create function app.approval_needs_call(p_approval uuid) returns boolean
  language sql stable set search_path = public, pg_temp as $$
  select r.replied_at is not null and (r.called_at is null or r.replied_at > r.called_at)
    from approvals a
    join clients c on c.id = a.client_id
    cross join lateral (
      select greatest(
               (select max(i.received_at) from inbound_emails i
                 where i.client_id = c.id and i.kind = 'merchant' and i.received_at >= a.emails_since),
               case when c.reply_waiting_since >= a.emails_since then c.reply_waiting_since end) as replied_at,
             (select max(x.created_at) from activities x
               where x.client_id = c.id and x.kind = 'call' and x.created_at >= a.emails_since) as called_at
    ) r
   where a.id = p_approval
$$;
grant execute on function app.approval_needs_call(uuid) to isaac_app;

-- A merchant who changes hands (reassigned, or their rep offboarded) takes their open approval along: the emails come
-- from the new rep, and one already queued in the old rep's name is taken back to be filled again.
create function app.approval_follows_owner() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update approvals set user_id = new.user_id where client_id = new.id and status = 'open';
  update outbox set status = 'cancelled', skip_reason = 'owner_changed'
   where client_id = new.id and lane = 'approval' and status = 'queued';
  return new;
end $$;
create trigger clients_approval_owner after update of user_id on clients
  for each row when (old.user_id is distinct from new.user_id)
  execute function app.approval_follows_owner();

-- The source of an approval email is 'approval:<approval id>:step:<n>'.
create function app.approval_of(p_source text) returns uuid
  language sql immutable set search_path = public, pg_temp as $$
  select (regexp_match(p_source, '^approval:([0-9a-f-]{36}):step:[0-9]+$'))[1]::uuid
$$;
grant execute on function app.approval_of(text) to isaac_app;
