-- "Log out everywhere". A session token carries the epoch it was issued under; bumping this number
-- makes every older token invalid on its next request. The app role can read it (it can already read
-- its own app_users row) but has no UPDATE grant on it, so only the server's owner connection bumps it.
alter table app_users add column session_epoch integer not null default 0;
