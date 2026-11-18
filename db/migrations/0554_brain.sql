-- The brain (0554). Three things:
--   1. The assistant uses the model chosen in Settings → AI (default Sonnet 5.5; it was fixed to Opus 5.5 in code).
--   2. A house-rules box ("playbook") a manager writes once; the assistant reads it with every conversation.
--   3. Background preparation: a job looks at each rep's "Do this now" list and has the assistant prepare the next
--      step for every new item (a reply drafted, a nudge written, the file checked), so the rep only reads and clicks.
--      Nothing is sent or changed by it: the result is an ordinary assistant conversation with buttons, exactly what the
--      rep would have got by asking. One row per rep per trigger (brain_preps) remembers what was prepared.

alter table shop_settings
  add column brain_on boolean not null default false,
  add column brain_daily_per_rep int not null default 15 check (brain_daily_per_rep between 1 and 100),
  add column playbook text not null default '' check (char_length(playbook) <= 4000);

alter table shop_settings alter column ai_model set default 'claude-sonnet-5-5';
update shop_settings set ai_model = 'claude-sonnet-5-5' where ai_model = 'claude-opus-5-5';

create table brain_preps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users (id) on delete cascade,
  -- null for the daily plan
  client_id uuid references clients (id) on delete cascade,
  kind text not null check (kind in ('reply', 'opened', 'upload', 'ready', 'overdue', 'call_now', 'plan')),
  -- what put it on the list ("reply:<merchant>:<time>", "plan:<day>"): one preparation per rep per trigger
  trigger_key text not null,
  thread_id uuid references assistant_threads (id) on delete set null,
  status text not null default 'working' check (status in ('working', 'ready', 'failed')),
  -- the first lines of what the assistant concluded, for the list
  summary text not null default '' check (char_length(summary) <= 600),
  actions int not null default 0,
  attempts int not null default 0,
  error text check (char_length(error) <= 300),
  -- a run takes the preparation for a few minutes so two overlapping runs never write the same conversation
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  seen_at timestamptz,
  unique (user_id, trigger_key)
);
create index brain_preps_user_idx on brain_preps (user_id, created_at desc);
create index brain_preps_client_idx on brain_preps (client_id) where client_id is not null;
create index brain_preps_working_idx on brain_preps (created_at) where status = 'working';

alter table brain_preps enable row level security;
create policy brain_preps_own_read on brain_preps for select to isaac_app using (user_id = app.current_user_id());
create policy brain_preps_own_seen on brain_preps for update to isaac_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
grant select on brain_preps to isaac_app;
-- a rep may only mark their own preparation as read; everything else is written by the job
grant update (seen_at) on brain_preps to isaac_app;
