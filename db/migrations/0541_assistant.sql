-- The assistant (Claude Opus 5.5) keeps each person's conversations: one row per thread, holding the message list
-- exactly as the API saw it (thinking blocks and tool calls included, unchanged), so a later question continues the
-- same conversation. Only the person who had the conversation can read, change or delete it; a manager cannot read
-- a rep's threads. Every model call is also logged in ai_runs (purpose 'assistant'), which is what the daily cap counts.

create table assistant_threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default app.current_user_id() references app_users (id) on delete cascade,
  title text not null default '' check (char_length(title) <= 200),
  messages jsonb not null default '[]'::jsonb check (jsonb_typeof(messages) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index assistant_threads_user_idx on assistant_threads (user_id, updated_at desc);

alter table assistant_threads enable row level security;
create policy assistant_threads_own on assistant_threads for all to isaac_app
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());
grant select, insert, update, delete on assistant_threads to isaac_app;
