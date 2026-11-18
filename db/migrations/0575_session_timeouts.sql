-- Session timeouts. A sign-in cookie is a signed token, and a signed token cannot know the person walked away from
-- the desk. So every sign-in also writes one row here (the session id inside the token, the user, the last time the
-- session was used), and the server refuses a session whose row says it has been idle too long, whatever the cookie's
-- own expiry says. The idle window rolls forward on use, at most once every few minutes (src/lib/auth/session.ts holds
-- the numbers; src/lib/system/sessions.ts does the one-statement check and roll). The absolute 7-day lifetime needs no
-- column: it is the token's own signed issue time.
--
-- One row per sign-in, not per user, so a phone left on a desk is not kept alive by the laptop in use. A user that is
-- deleted takes their rows with them; "log out everywhere" (session_epoch) still works on its own and is checked
-- separately. System-only, the same pattern as passcode_attempts (0570): RLS on, isaac_app granted nothing, touched
-- only through withSystem(). Not in the JSON backup (throwaway working state). Rows older than the absolute lifetime
-- are removed by the sweep in src/lib/system/sessions.ts, called from the hourly nightly cron.

create table session_activity (
  sid text primary key check (btrim(sid) <> '' and length(sid) <= 64),
  user_id uuid not null references app_users (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index session_activity_user_idx on session_activity (user_id);
create index session_activity_seen_idx on session_activity (last_seen_at);

alter table session_activity enable row level security;
revoke all on session_activity from isaac_app;
