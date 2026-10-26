-- Saved snippets, email signature and application link.
--
-- Snippets are Isaac's own words for texts and emails ("Send application", "Need statements"…), with merge
-- fields such as {first_name} that the app fills in. They hold no merchant data, but the table still gets
-- row-level security from day one: one user must never read or edit another user's templates.

create table snippets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  title text not null check (btrim(title) <> '' and length(title) <= 80),
  kind text not null check (kind in ('text', 'email')),
  body text not null check (btrim(body) <> '' and length(body) <= 5000),
  sort int not null default 0,
  created_at timestamptz not null default now()
);

-- One snippet per title, per kind, per user ("Win-back" the text and "Win-back" the email can coexist).
create unique index snippets_user_kind_title_key on snippets (user_id, kind, lower(btrim(title)));
create index snippets_user_sort_idx on snippets (user_id, kind, sort, created_at);

alter table snippets enable row level security;
create policy snippets_owner on snippets for all to isaac_app
  using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
grant select, insert, update, delete on snippets to isaac_app;

-- The signature goes on the end of every email sent from the app; the link is what {application_link} becomes.
-- Only these two columns are added to the writable list. notify_email stays unwritable on purpose
-- (see 0001_init.sql): an editable reminder address would let a stolen session redirect the morning digest.
alter table app_users
  add column signature text not null default '' check (length(signature) <= 2000),
  add column application_link text not null default ''
    check (length(application_link) <= 500 and (application_link = '' or application_link ~ '^https?://[^[:space:]]+$'));

grant update (signature, application_link) on app_users to isaac_app;
