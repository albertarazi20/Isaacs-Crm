-- The send engine. Every automated email (bucket reminders, blasts, win-back, intake welcome) goes through ONE
-- outbox with one set of rules, so the cap, the suppression list, the footer and the stop rules apply everywhere:
--   * outbox            — one row per email to send; a worker drains it. Status, lane, provider id, failure reason.
--   * send_ledger       — every email that actually left, by mailbox, for the rolling-24-hour cap.
--   * suppressions      — the shop-wide do-not-contact list: unsubscribes, hard bounces, STOP replies, manual blocks.
--                         Keyed on a hash of the address so a deleted merchant stays suppressed after a re-import.
--   * shop_settings     — one row of shop-wide knobs (the cap, the footer address, sequences on/off, send window).
--   * mailboxes         — the sending identities: a user's Gmail (from gmail_connections) or the shop's Resend domain.
--
-- Lanes (priority): 'intake' (first email to a new lead, never blocked by the cap short of Google's own limit),
-- 'reply' (a person answering a merchant), 'sequence' (bucket steps, win-back), 'blast' (manual bulk). When the
-- mailbox is at its lock, sequence and blast wait for the next window; intake and reply keep a reserved slice.

create table shop_settings (
  id boolean primary key default true check (id),           -- exactly one row
  shop_name text not null default 'Selective Capital',
  -- CAN-SPAM: a real postal address on every automated email. Empty blocks automation from switching on.
  postal_address text not null default '',
  -- the lock per mailbox per rolling 24h (Google Workspace allows 2,000; mail merge 1,500). gmail.com mailboxes get a lower one.
  daily_cap int not null default 1500 check (daily_cap between 50 and 2000),
  amber_at int not null default 1200 check (amber_at between 10 and 2000),
  reserved_for_intake int not null default 150 check (reserved_for_intake between 0 and 500),
  -- sequences that slow down (recommended) or the same template every day
  sequences_enabled boolean not null default true,
  -- the local send window (merchant's time zone), 24h clock
  send_window_start int not null default 9 check (send_window_start between 0 and 23),
  send_window_end int not null default 11 check (send_window_end between 1 and 24),
  send_on_weekends boolean not null default false,
  -- at most this many automated emails to one merchant per rolling 24h / 7 days, across every source
  per_merchant_daily int not null default 1 check (per_merchant_daily between 1 and 5),
  per_merchant_weekly int not null default 3 check (per_merchant_weekly between 1 and 20),
  -- the shop's own sending address for automation (Resend, on a subdomain); empty = send from the rep's Gmail
  automation_from text not null default '',
  automation_reply_to_rep boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into shop_settings default values;
grant select on shop_settings to isaac_app;
grant update on shop_settings to isaac_app;
alter table shop_settings enable row level security;
create policy shop_settings_read on shop_settings for select to isaac_app using (true);
create policy shop_settings_manager_write on shop_settings for update to isaac_app
  using (app.can_see_all()) with check (app.can_see_all());
create trigger shop_settings_touch before update on shop_settings for each row execute function app.touch_updated_at();

-- A mailbox is either a user's connected Gmail or the shop automation sender. The ledger keys on it.
create table mailboxes (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('gmail', 'resend')),
  user_id uuid references app_users (id) on delete cascade,   -- gmail: whose; resend: null (shop-wide)
  address text not null,
  -- gmail.com accounts have Google's 500/day limit; Workspace 2,000. The cap used is least(shop cap, this).
  provider_limit int not null default 2000,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (kind, address)
);
create unique index mailboxes_user_gmail_key on mailboxes (user_id) where kind = 'gmail';
grant select on mailboxes to isaac_app;
alter table mailboxes enable row level security;
create policy mailboxes_read on mailboxes for select to isaac_app using (true);

create table suppressions (
  id uuid primary key default gen_random_uuid(),
  -- sha256 of the lowercased address or E.164 phone: the list survives a deleted merchant and a re-import
  channel text not null check (channel in ('email', 'sms', 'call')),
  key_hash text not null,
  -- kept in clear for the manager's list; null once the merchant row is purged
  display text,
  reason text not null check (reason in ('unsubscribe', 'hard_bounce', 'complaint', 'stop_reply', 'manual', 'dnc')),
  note text not null default '',
  client_id uuid references clients (id) on delete set null,
  created_by uuid references app_users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (channel, key_hash)
);
grant select, insert on suppressions to isaac_app;
grant delete on suppressions to isaac_app;
alter table suppressions enable row level security;
create policy suppressions_read on suppressions for select to isaac_app using (true);
create policy suppressions_insert on suppressions for insert to isaac_app with check (true);
create policy suppressions_manager_delete on suppressions for delete to isaac_app using (app.can_see_all());

create function app.suppression_key(p_value text) returns text
language sql immutable as $$ select encode(sha256(lower(btrim(p_value))::bytea), 'hex') $$;

create function app.is_suppressed(p_channel text, p_value text) returns boolean
language sql stable set search_path = public, pg_temp as $$
  select exists (select 1 from suppressions where channel = p_channel and key_hash = app.suppression_key(p_value))
$$;

-- The outbox. Rows are claimed by the worker with `for update skip locked`, so two workers never send one twice.
create table outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users (id) on delete cascade,   -- the rep it is sent on behalf of
  client_id uuid references clients (id) on delete cascade,
  deal_id uuid references deals (id) on delete set null,
  mailbox_id uuid references mailboxes (id) on delete set null,
  lane text not null check (lane in ('intake', 'reply', 'sequence', 'blast', 'system')),
  -- what produced it, for the activity line and for stop rules ("sequence step 3 of bucket X")
  source text not null default '' ,                     -- 'bucket:<id>:step:<n>' | 'winback:<pool>' | 'blast:<id>' | 'intake' | 'manual'
  to_address text not null,
  subject text not null,
  text_body text not null,
  html_body text,
  reply_to text,
  -- the earliest it may go (the merchant's local send window), and when it must be dropped as stale
  not_before timestamptz not null default now(),
  expires_at timestamptz,
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'skipped', 'failed', 'cancelled')),
  skip_reason text,            -- 'suppressed' | 'cap' | 'per_merchant_cap' | 'stopped' | 'no_address' | 'expired' | 'dnc'
  attempts int not null default 0,
  last_error text,
  provider text,               -- 'gmail' | 'resend'
  provider_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index outbox_queue_idx on outbox (not_before) where status = 'queued';
create index outbox_client_idx on outbox (client_id, created_at desc);
create index outbox_user_idx on outbox (user_id, created_at desc);
grant select, insert, update on outbox to isaac_app;
alter table outbox enable row level security;
create policy outbox_owner on outbox for all to isaac_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
create policy outbox_team on outbox for all to isaac_app using (app.can_see_all()) with check (app.can_see_all());

-- What left, by mailbox, for the rolling cap. Includes mail sent outside the CRM when the inbox sync sees it
-- (source = 'external'), because Google counts everything from the mailbox.
create table send_ledger (
  id bigint generated always as identity primary key,
  mailbox_id uuid not null references mailboxes (id) on delete cascade,
  outbox_id uuid references outbox (id) on delete set null,
  client_id uuid references clients (id) on delete set null,
  lane text not null,
  source text not null default 'crm' check (source in ('crm', 'external')),
  sent_at timestamptz not null default now()
);
create index send_ledger_mailbox_time_idx on send_ledger (mailbox_id, sent_at desc);
create index send_ledger_client_time_idx on send_ledger (client_id, sent_at desc) where client_id is not null;
grant select, insert on send_ledger to isaac_app;
alter table send_ledger enable row level security;
create policy send_ledger_read on send_ledger for select to isaac_app using (true);
create policy send_ledger_insert on send_ledger for insert to isaac_app with check (true);

-- Sent in the last rolling 24h from a mailbox (the number the fuel gauge shows).
create function app.mailbox_sent_24h(p_mailbox uuid) returns int
language sql stable set search_path = public, pg_temp as $$
  select count(*)::int from send_ledger where mailbox_id = p_mailbox and sent_at > now() - interval '24 hours'
$$;

-- Automated emails this merchant got in the last 24h / 7d, across every source.
create function app.merchant_sent(p_client uuid, p_window interval) returns int
language sql stable set search_path = public, pg_temp as $$
  select count(*)::int from send_ledger
   where client_id = p_client and lane in ('sequence', 'blast') and sent_at > now() - p_window
$$;

-- Per-merchant contact preferences: time zone and the "stop" flags per channel, set at intake or by a reply.
alter table clients
  add column timezone text,                                -- IANA; null = derive from state, then area code
  add column timezone_source text check (timezone_source in ('state', 'area_code', 'manual')),
  add column email_opt_out boolean not null default false,
  add column sms_opt_out boolean not null default false,
  add column sms_consent_at timestamptz,
  add column sms_consent_source text not null default '',
  add column email_bounced_at timestamptz,
  add column last_automated_email_at timestamptz,
  add column lead_source_kind text not null default 'unknown'
    check (lead_source_kind in ('own_form', 'referral', 'live_transfer', 'purchased', 'ucc', 'sheet', 'unknown'));

-- Area code → time zone, the fallback when the state is unknown. Only the unambiguous codes; the rest stay null.
create table area_code_tz (code char(3) primary key, tz text not null);
insert into area_code_tz (code, tz) values
 ('201','America/New_York'),('202','America/New_York'),('203','America/New_York'),('205','America/Chicago'),('206','America/Los_Angeles'),
 ('207','America/New_York'),('208','America/Boise'),('209','America/Los_Angeles'),('210','America/Chicago'),('212','America/New_York'),
 ('213','America/Los_Angeles'),('214','America/Chicago'),('215','America/New_York'),('216','America/New_York'),('217','America/Chicago'),
 ('218','America/Chicago'),('219','America/Chicago'),('224','America/Chicago'),('225','America/Chicago'),('228','America/Chicago'),
 ('229','America/New_York'),('231','America/Detroit'),('234','America/New_York'),('239','America/New_York'),('240','America/New_York'),
 ('248','America/Detroit'),('251','America/Chicago'),('252','America/New_York'),('253','America/Los_Angeles'),('254','America/Chicago'),
 ('256','America/Chicago'),('260','America/Indiana/Indianapolis'),('262','America/Chicago'),('267','America/New_York'),('269','America/Detroit'),
 ('270','America/Chicago'),('272','America/New_York'),('276','America/New_York'),('281','America/Chicago'),('301','America/New_York'),
 ('302','America/New_York'),('303','America/Denver'),('304','America/New_York'),('305','America/New_York'),('307','America/Denver'),
 ('308','America/Chicago'),('309','America/Chicago'),('310','America/Los_Angeles'),('312','America/Chicago'),('313','America/Detroit'),
 ('314','America/Chicago'),('315','America/New_York'),('316','America/Chicago'),('317','America/Indiana/Indianapolis'),('318','America/Chicago'),
 ('319','America/Chicago'),('320','America/Chicago'),('321','America/New_York'),('323','America/Los_Angeles'),('325','America/Chicago'),
 ('330','America/New_York'),('331','America/Chicago'),('334','America/Chicago'),('336','America/New_York'),('337','America/Chicago'),
 ('339','America/New_York'),('346','America/Chicago'),('347','America/New_York'),('351','America/New_York'),('352','America/New_York'),
 ('360','America/Los_Angeles'),('361','America/Chicago'),('385','America/Denver'),('386','America/New_York'),('401','America/New_York'),
 ('402','America/Chicago'),('404','America/New_York'),('405','America/Chicago'),('406','America/Denver'),('407','America/New_York'),
 ('408','America/Los_Angeles'),('409','America/Chicago'),('410','America/New_York'),('412','America/New_York'),('413','America/New_York'),
 ('414','America/Chicago'),('415','America/Los_Angeles'),('417','America/Chicago'),('419','America/New_York'),('423','America/New_York'),
 ('424','America/Los_Angeles'),('425','America/Los_Angeles'),('430','America/Chicago'),('432','America/Chicago'),('434','America/New_York'),
 ('435','America/Denver'),('440','America/New_York'),('442','America/Los_Angeles'),('443','America/New_York'),('458','America/Los_Angeles'),
 ('469','America/Chicago'),('470','America/New_York'),('475','America/New_York'),('478','America/New_York'),('479','America/Chicago'),
 ('480','America/Phoenix'),('484','America/New_York'),('501','America/Chicago'),('502','America/New_York'),('503','America/Los_Angeles'),
 ('504','America/Chicago'),('505','America/Denver'),('507','America/Chicago'),('508','America/New_York'),('509','America/Los_Angeles'),
 ('510','America/Los_Angeles'),('512','America/Chicago'),('513','America/New_York'),('515','America/Chicago'),('516','America/New_York'),
 ('517','America/Detroit'),('518','America/New_York'),('520','America/Phoenix'),('530','America/Los_Angeles'),('540','America/New_York'),
 ('541','America/Los_Angeles'),('551','America/New_York'),('559','America/Los_Angeles'),('561','America/New_York'),('562','America/Los_Angeles'),
 ('563','America/Chicago'),('567','America/New_York'),('570','America/New_York'),('571','America/New_York'),('573','America/Chicago'),
 ('574','America/Indiana/Indianapolis'),('580','America/Chicago'),('585','America/New_York'),('586','America/Detroit'),('601','America/Chicago'),
 ('602','America/Phoenix'),('603','America/New_York'),('605','America/Chicago'),('606','America/New_York'),('607','America/New_York'),
 ('608','America/Chicago'),('609','America/New_York'),('610','America/New_York'),('612','America/Chicago'),('614','America/New_York'),
 ('615','America/Chicago'),('616','America/Detroit'),('617','America/New_York'),('618','America/Chicago'),('619','America/Los_Angeles'),
 ('620','America/Chicago'),('623','America/Phoenix'),('626','America/Los_Angeles'),('628','America/Los_Angeles'),('629','America/Chicago'),
 ('630','America/Chicago'),('631','America/New_York'),('636','America/Chicago'),('641','America/Chicago'),('646','America/New_York'),
 ('650','America/Los_Angeles'),('651','America/Chicago'),('657','America/Los_Angeles'),('660','America/Chicago'),('661','America/Los_Angeles'),
 ('662','America/Chicago'),('667','America/New_York'),('669','America/Los_Angeles'),('678','America/New_York'),('680','America/New_York'),
 ('681','America/New_York'),('682','America/Chicago'),('701','America/Chicago'),('702','America/Los_Angeles'),('703','America/New_York'),
 ('704','America/New_York'),('706','America/New_York'),('707','America/Los_Angeles'),('708','America/Chicago'),('712','America/Chicago'),
 ('713','America/Chicago'),('714','America/Los_Angeles'),('715','America/Chicago'),('716','America/New_York'),('717','America/New_York'),
 ('718','America/New_York'),('719','America/Denver'),('720','America/Denver'),('724','America/New_York'),('725','America/Los_Angeles'),
 ('727','America/New_York'),('731','America/Chicago'),('732','America/New_York'),('734','America/Detroit'),('737','America/Chicago'),
 ('740','America/New_York'),('747','America/Los_Angeles'),('754','America/New_York'),('757','America/New_York'),('760','America/Los_Angeles'),
 ('762','America/New_York'),('763','America/Chicago'),('765','America/Indiana/Indianapolis'),('769','America/Chicago'),('770','America/New_York'),
 ('772','America/New_York'),('773','America/Chicago'),('774','America/New_York'),('775','America/Los_Angeles'),('779','America/Chicago'),
 ('781','America/New_York'),('785','America/Chicago'),('786','America/New_York'),('801','America/Denver'),('802','America/New_York'),
 ('803','America/New_York'),('804','America/New_York'),('805','America/Los_Angeles'),('806','America/Chicago'),('808','Pacific/Honolulu'),
 ('810','America/Detroit'),('812','America/Indiana/Indianapolis'),('813','America/New_York'),('814','America/New_York'),('815','America/Chicago'),
 ('816','America/Chicago'),('817','America/Chicago'),('818','America/Los_Angeles'),('828','America/New_York'),('830','America/Chicago'),
 ('831','America/Los_Angeles'),('832','America/Chicago'),('843','America/New_York'),('845','America/New_York'),('847','America/Chicago'),
 ('848','America/New_York'),('850','America/Chicago'),('856','America/New_York'),('857','America/New_York'),('858','America/Los_Angeles'),
 ('859','America/New_York'),('860','America/New_York'),('862','America/New_York'),('863','America/New_York'),('864','America/New_York'),
 ('865','America/New_York'),('870','America/Chicago'),('872','America/Chicago'),('878','America/New_York'),('901','America/Chicago'),
 ('903','America/Chicago'),('904','America/New_York'),('906','America/Detroit'),('907','America/Anchorage'),('908','America/New_York'),
 ('909','America/Los_Angeles'),('910','America/New_York'),('912','America/New_York'),('913','America/Chicago'),('914','America/New_York'),
 ('915','America/Denver'),('916','America/Los_Angeles'),('917','America/New_York'),('918','America/Chicago'),('919','America/New_York'),
 ('920','America/Chicago'),('925','America/Los_Angeles'),('928','America/Phoenix'),('929','America/New_York'),('931','America/Chicago'),
 ('936','America/Chicago'),('937','America/New_York'),('940','America/Chicago'),('941','America/New_York'),('947','America/Detroit'),
 ('949','America/Los_Angeles'),('951','America/Los_Angeles'),('952','America/Chicago'),('954','America/New_York'),('956','America/Chicago'),
 ('959','America/New_York'),('970','America/Denver'),('971','America/Los_Angeles'),('972','America/Chicago'),('973','America/New_York'),
 ('978','America/New_York'),('979','America/Chicago'),('980','America/New_York'),('984','America/New_York'),('985','America/Chicago'),
 ('989','America/Detroit');
grant select on area_code_tz to isaac_app;
alter table area_code_tz enable row level security;
create policy area_code_tz_read on area_code_tz for select to isaac_app using (true);

create table app_state_tz (state char(2) primary key, tz text not null);
insert into app_state_tz values
 ('AL','America/Chicago'),('AK','America/Anchorage'),('AZ','America/Phoenix'),('AR','America/Chicago'),('CA','America/Los_Angeles'),
 ('CO','America/Denver'),('CT','America/New_York'),('DE','America/New_York'),('DC','America/New_York'),('FL','America/New_York'),
 ('GA','America/New_York'),('HI','Pacific/Honolulu'),('ID','America/Boise'),('IL','America/Chicago'),('IN','America/Indiana/Indianapolis'),
 ('IA','America/Chicago'),('KS','America/Chicago'),('KY','America/New_York'),('LA','America/Chicago'),('ME','America/New_York'),
 ('MD','America/New_York'),('MA','America/New_York'),('MI','America/Detroit'),('MN','America/Chicago'),('MS','America/Chicago'),
 ('MO','America/Chicago'),('MT','America/Denver'),('NE','America/Chicago'),('NV','America/Los_Angeles'),('NH','America/New_York'),
 ('NJ','America/New_York'),('NM','America/Denver'),('NY','America/New_York'),('NC','America/New_York'),('ND','America/Chicago'),
 ('OH','America/New_York'),('OK','America/Chicago'),('OR','America/Los_Angeles'),('PA','America/New_York'),('RI','America/New_York'),
 ('SC','America/New_York'),('SD','America/Chicago'),('TN','America/Chicago'),('TX','America/Chicago'),('UT','America/Denver'),
 ('VT','America/New_York'),('VA','America/New_York'),('WA','America/Los_Angeles'),('WV','America/New_York'),('WI','America/Chicago'),
 ('WY','America/Denver');
grant select on app_state_tz to isaac_app;
alter table app_state_tz enable row level security;
create policy app_state_tz_read on app_state_tz for select to isaac_app using (true);

-- The merchant's time zone, decided once per lookup: manual > state > area code > the rep's own zone.
create function app.client_timezone(c clients) returns text
language sql stable set search_path = public, pg_temp as $$
  select coalesce(
    c.timezone,
    (select tz from app_state_tz where state = upper(btrim(c.state))),
    (select tz from area_code_tz where code = substr(regexp_replace(c.phone, '\D', '', 'g'), case when length(regexp_replace(c.phone, '\D', '', 'g')) = 11 then 2 else 1 end, 3)),
    (select timezone from app_users where id = c.user_id),
    'America/New_York')
$$;


-- Unsubscribe tokens: one per (client), used in the footer link and the one-click header. Opaque, not guessable.
-- No pgcrypto needed: two uuids give 256 random bits.
alter table clients add column unsubscribe_token text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
create unique index clients_unsubscribe_token_key on clients (unsubscribe_token);

-- Opt a merchant out of a channel: flags on the row + the shop-wide suppression, in one call (works from a webhook too).
create function public.opt_out(p_client uuid, p_channel text, p_reason text, p_note text default '')
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
    -- anything queued to them is cancelled on the spot
    update outbox set status = 'cancelled', skip_reason = 'suppressed' where client_id = p_client and status = 'queued' and lane in ('sequence', 'blast');
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
