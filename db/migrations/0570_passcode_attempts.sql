-- A persistent limit on passcode sign-in guesses. The shared passcode is the only thing between the internet and the
-- first manager's account, so guessing must get slower than a person can type and stay slow across restarts and
-- serverless instances (the old one-second sleep per request did neither). One row per client address: every attempt
-- is counted BEFORE the passcode is compared, so a burst of parallel guesses cannot slip past the lock; a successful
-- sign-in deletes the row.
--
-- System-only on purpose, like job_runs and lead_tokens: no merchant data, and the browser-facing role has no business
-- reading or writing it. RLS is on and isaac_app is granted nothing, so any query from that role fails with
-- "permission denied". Only src/lib/system/users.ts touches it, through withSystem(). Not in the JSON backup
-- (throwaway working state).

create table passcode_attempts (
  key text primary key check (btrim(key) <> '' and length(key) <= 128),
  failures integer not null default 0 check (failures >= 0),
  window_start timestamptz not null default now(),
  locked_until timestamptz
);
create index passcode_attempts_window_idx on passcode_attempts (window_start);

alter table passcode_attempts enable row level security;
revoke all on passcode_attempts from isaac_app;
