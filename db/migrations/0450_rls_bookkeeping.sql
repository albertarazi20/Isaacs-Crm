-- Row-level security on the last two tables without it. Neither is read by the browser-facing role (isaac_app has no
-- grant on either), but a hosted database flags every public table without RLS, and webhook_events carries provider
-- payloads that can name a merchant. The owner connection (migrations, the webhook route's withSystem) owns both
-- tables and so is not restricted; with no policy, every other role sees nothing.
alter table webhook_events enable row level security;
alter table schema_migrations enable row level security;
