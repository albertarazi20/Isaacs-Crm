-- Lead intake. A website form, Zapier or a lead vendor can POST a new merchant to /api/leads with a bearer
-- token; the merchant lands on Today as "call now". The token is shown ONCE when it is made. Only its
-- SHA-256 hash is stored, so a database leak can't be replayed. A token can do exactly one thing: add a
-- merchant to its owner's account.

create table lead_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  label text not null default '',
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  -- one-minute rate window, kept on the row so no extra table or cache is needed
  window_start timestamptz not null default now(),
  window_count int not null default 0
);
create index lead_tokens_user_idx on lead_tokens (user_id);

alter table lead_tokens enable row level security;
create policy lead_tokens_select on lead_tokens for select to isaac_app using (user_id = app.current_user_id());
create policy lead_tokens_insert on lead_tokens for insert to isaac_app with check (user_id = app.current_user_id());
create policy lead_tokens_revoke on lead_tokens for update to isaac_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

-- The app role can list its tokens (never the hash) and revoke one. The server's owner connection checks
-- a presented token and keeps the rate window; the app role can't touch either.
grant select (id, user_id, label, created_at, last_used_at, revoked_at) on lead_tokens to isaac_app;
grant insert (user_id, label, token_hash) on lead_tokens to isaac_app;
grant update (revoked_at) on lead_tokens to isaac_app;
