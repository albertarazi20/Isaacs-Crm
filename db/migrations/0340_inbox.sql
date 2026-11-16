-- The lender inbox. Lender replies reach the CRM through a manager's connected Google account (gmail.readonly)
-- and are stored here, matched to a deal by code, read by the AI, and turned into status updates:
--   inbound_emails    — every message the sync pulled (headers, text, attachment names). Treated as hostile data.
--   proposed_updates  — what the AI thinks an email means. Low-stakes ones apply at once; money ones wait for a click.
--   ai_runs           — every extraction: model, prompt version, input hash, output, cost, who confirmed. The audit.
--   mail_sync_state   — per mailbox: the Gmail historyId cursor and when it last synced.
-- CRM-sent lender email carries [D-1042] in the subject and the Gmail thread id is kept on the submission, so a
-- reply is matched exactly; the AI never decides which deal an email belongs to.

alter table submissions
  add column gmail_thread_id text,
  add column gmail_message_id text,          -- RFC Message-ID of the submission email we sent
  add column sent_via text check (sent_via in ('crm', 'manual'));
create index submissions_thread_idx on submissions (gmail_thread_id) where gmail_thread_id is not null;

create table mail_sync_state (
  user_id uuid primary key references app_users (id) on delete cascade,
  history_id text,
  last_synced_at timestamptz,
  last_error text,
  messages_seen int not null default 0
);
grant select on mail_sync_state to isaac_app;
alter table mail_sync_state enable row level security;
create policy mail_sync_state_read on mail_sync_state for select to isaac_app using (user_id = app.current_user_id() or app.can_see_all());

create table inbound_emails (
  id uuid primary key default gen_random_uuid(),
  mailbox_user_id uuid not null references app_users (id) on delete cascade,  -- whose inbox it came from
  gmail_id text not null,
  gmail_thread_id text,
  message_id text,                 -- RFC Message-ID header
  in_reply_to text,
  references_ids text[] not null default '{}',
  from_address text not null default '',
  from_name text not null default '',
  to_addresses text[] not null default '{}',
  subject text not null default '',
  snippet text not null default '',
  text_body text not null default '',
  attachment_names text[] not null default '{}',
  received_at timestamptz not null,
  -- sender authentication, read from Gmail's Authentication-Results header when present
  spf_pass boolean,
  dkim_pass boolean,
  -- matching
  deal_id uuid references deals (id) on delete set null,
  submission_id uuid references submissions (id) on delete set null,
  client_id uuid references clients (id) on delete set null,
  funder_id uuid references funders (id) on delete set null,
  matched_by text check (matched_by in ('thread', 'reply_headers', 'deal_token', 'funder_name', 'merchant_reply', 'manual', 'none')),
  -- what happened to it
  kind text not null default 'unknown' check (kind in ('lender', 'merchant', 'other', 'unknown')),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (mailbox_user_id, gmail_id)
);
create index inbound_emails_thread_idx on inbound_emails (gmail_thread_id);
create index inbound_emails_deal_idx on inbound_emails (deal_id, received_at desc) where deal_id is not null;
create index inbound_emails_unprocessed_idx on inbound_emails (received_at) where processed_at is null;
grant select, update on inbound_emails to isaac_app;
alter table inbound_emails enable row level security;
-- a rep sees the emails on their own deals; ops the ops queue's; managers all
create policy inbound_emails_read on inbound_emails for select to isaac_app
  using (app.can_see_all()
         or exists (select 1 from deals d where d.id = deal_id and d.user_id = app.current_user_id())
         or (client_id is not null and app.is_ops_deal(client_id)));
create policy inbound_emails_manager_write on inbound_emails for update to isaac_app
  using (app.can_see_all()) with check (app.can_see_all());

create table proposed_updates (
  id uuid primary key default gen_random_uuid(),
  email_id uuid references inbound_emails (id) on delete cascade,
  deal_id uuid not null references deals (id) on delete cascade,
  submission_id uuid references submissions (id) on delete set null,
  -- the fixed event vocabulary the reader picks from
  event text not null check (event in (
    'submitted', 'info_requested', 'approved', 'revised', 'declined', 'docs_out', 'contracts_in', 'bv_done',
    'stip_requested', 'funding_call_done', 'funded', 'killed', 'no_change', 'merchant_replied')),
  -- the structured payload (offer terms, decline reason, stips list), as the reader returned it
  payload jsonb not null default '{}'::jsonb,
  -- a quote from the email for each fact, checked by code to exist in the text
  evidence jsonb not null default '[]'::jsonb,
  confidence numeric(3,2) not null check (confidence between 0 and 1),
  -- auto: applied by a rule; proposed: waits for a manager; applied; rejected
  status text not null default 'proposed' check (status in ('auto', 'proposed', 'applied', 'rejected')),
  summary text not null default '',           -- one line for the Activity tab: "Pearl approved $45k at 1.35"
  next_step text not null default '',         -- the reader's suggestion for the rep
  decided_by uuid references app_users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index proposed_updates_tray_idx on proposed_updates (created_at desc) where status = 'proposed';
create index proposed_updates_deal_idx on proposed_updates (deal_id, created_at desc);
grant select, update on proposed_updates to isaac_app;
alter table proposed_updates enable row level security;
create policy proposed_updates_read on proposed_updates for select to isaac_app
  using (app.can_see_all() or exists (select 1 from deals d where d.id = deal_id and d.user_id = app.current_user_id()));
create policy proposed_updates_manager_write on proposed_updates for update to isaac_app
  using (app.can_see_all()) with check (app.can_see_all());

create table ai_runs (
  id uuid primary key default gen_random_uuid(),
  purpose text not null,                      -- 'read_lender_email' | 'draft_winback' | 'summarise_deal' | ...
  model text not null,
  prompt_version text not null,
  input_hash text not null,
  input_tokens int,
  output_tokens int,
  cost_cents numeric(10,4),
  output jsonb,
  error text,
  email_id uuid references inbound_emails (id) on delete set null,
  deal_id uuid references deals (id) on delete set null,
  created_at timestamptz not null default now()
);
create index ai_runs_time_idx on ai_runs (created_at desc);
grant select on ai_runs to isaac_app;
alter table ai_runs enable row level security;
create policy ai_runs_manager_read on ai_runs for select to isaac_app using (app.can_see_all());

-- Shop-wide AI knobs: a daily spend cap and a kill switch. Money and merchant-facing status always wait for a click.
alter table shop_settings
  add column ai_enabled boolean not null default true,
  add column ai_model text not null default 'claude-opus-5-5',
  add column ai_daily_cap_cents int not null default 2000,
  add column ai_auto_apply_low_stakes boolean not null default true;

-- Spend today, for the cap.
create function app.ai_spent_today_cents() returns numeric
language sql stable set search_path = public, pg_temp as $$
  select coalesce(sum(cost_cents), 0) from ai_runs where created_at > now() - interval '24 hours'
$$;

-- Apply a proposed update: the one place a lender status is written from an email. Manager-only for money.
create function public.apply_proposed_update(p_update uuid)
returns proposed_updates
language plpgsql set search_path = public, pg_temp as $$
declare u proposed_updates; s submissions; d deals; off_id uuid;
begin
  select * into u from proposed_updates where id = p_update for update;
  if not found then raise exception 'update not found' using errcode = 'P0002'; end if;
  if u.status in ('applied', 'rejected') then return u; end if;
  select * into d from deals where id = u.deal_id for update;
  if u.submission_id is not null then
    select * into s from submissions where id = u.submission_id for update;
  end if;

  if u.event in ('info_requested', 'stip_requested') and s.id is not null then
    perform set_submission_status(s.id, 'stips_requested', null, coalesce(u.payload->>'note', ''));
  elsif u.event = 'declined' and s.id is not null then
    perform set_submission_status(s.id, 'declined', nullif(u.payload->>'decline_reason', ''), coalesce(u.payload->>'note', ''));
  elsif u.event in ('approved', 'revised') and s.id is not null then
    if (u.payload->>'amount_cents') is not null and (u.payload->>'factor_rate') is not null then
      select id into off_id from record_offer(s.id, jsonb_build_object(
        'amount_cents', (u.payload->>'amount_cents')::bigint,
        'factor_rate', (u.payload->>'factor_rate')::numeric,
        'payment_cents', nullif(u.payload->>'payment_cents', '')::bigint,
        'frequency', nullif(u.payload->>'frequency', ''),
        'term_days', nullif(u.payload->>'term_days', '')::int,
        'position_no', nullif(u.payload->>'position_no', '')::int,
        'fees_cents', nullif(u.payload->>'fees_cents', '')::bigint,
        'note', coalesce(u.payload->>'note', '')));
      if u.event = 'revised' then update submissions set status = 'revised' where id = s.id; end if;
      if (u.payload->>'expires_on') is not null then
        update submissions set approval_expires_on = (u.payload->>'expires_on')::date where id = s.id;
      end if;
    else
      perform set_submission_status(s.id, 'approved', null, coalesce(u.payload->>'note', ''));
    end if;
  elsif u.event = 'docs_out' and s.id is not null then
    perform set_submission_status(s.id, 'contracts_out');
  elsif u.event = 'contracts_in' and s.id is not null then
    perform set_submission_status(s.id, 'contracts_in');
  elsif u.event in ('bv_done', 'funding_call_done') and s.id is not null then
    perform set_submission_status(s.id, 'funding_call', null, coalesce(u.payload->>'note', ''));
  elsif u.event = 'funded' and s.id is not null then
    -- the FUND flow writes the money; here the lender row moves and the deal is flagged for the manager
    perform set_submission_status(s.id, 'funded');
    update deals set blocker = 'Lender says funded — confirm the terms with FUND' where id = d.id;
  elsif u.event = 'killed' and s.id is not null then
    perform set_submission_status(s.id, 'withdrawn', null, coalesce(u.payload->>'note', ''));
  elsif u.event = 'merchant_replied' then
    perform stop_enrollment(d.client_id, 'replied');
  end if;

  if s.id is not null then
    update submissions set source = 'email', source_ref = (select gmail_id from inbound_emails where id = u.email_id) where id = s.id;
  end if;
  update proposed_updates set status = 'applied', decided_by = app.current_user_id(), decided_at = now() where id = u.id returning * into u;
  return u;
end $$;
