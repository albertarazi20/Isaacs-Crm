-- Rate limits on the public token pages (upload, application, offer, "seen" beacons, unsubscribe). These routes need
-- no sign-in, so the only brake on a script hammering them is a counter. A fixed-window counter in Postgres, not in
-- memory, because the app runs on serverless instances that share nothing and restart often: one row per
-- (key, window), bumped by a single atomic upsert (src/lib/system/ratelimit.ts), so parallel requests cannot all slip
-- past a check-then-count gap. The key is the route name plus the client address (or a hash of the link's token);
-- window_start is the start of the fixed window the hit belongs to.
--
-- System-only on purpose, the same pattern as passcode_attempts (0570): no merchant data, and the browser-facing role
-- has no business reading or writing it. RLS is on and isaac_app is granted nothing, so any query from that role fails
-- with "permission denied". Only src/lib/system/ratelimit.ts touches it, through withSystem(). Not in the JSON backup
-- (throwaway working state). Old windows are deleted by the stale-row sweep in src/lib/system/ratelimit.ts, called from the hourly nightly cron.

create table rate_limits (
  key text not null check (btrim(key) <> '' and length(key) <= 160),
  window_start timestamptz not null,
  hits integer not null default 0 check (hits >= 0),
  primary key (key, window_start)
);
create index rate_limits_window_idx on rate_limits (window_start);

alter table rate_limits enable row level security;
revoke all on rate_limits from isaac_app;

