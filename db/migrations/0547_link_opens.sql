-- Hot signals: a merchant who opens their upload link or their application and does not finish is the warmest call a
-- rep has. The public pages record an open only after a real browser has shown the page for a few seconds (a script
-- on the page sends it), so a mail scanner that fetches every link does not count. One row per merchant and link per
-- half hour; the timeline gets one line a day. Written by the system connection only; a rep reads the opens of the
-- merchants they can see.

create table link_opens (
  id bigserial primary key,
  client_id uuid not null references clients (id) on delete cascade,
  kind text not null check (kind in ('upload', 'apply')),
  opened_at timestamptz not null default now()
);
create index link_opens_client_idx on link_opens (client_id, opened_at desc);
create index link_opens_time_idx on link_opens (opened_at desc);

alter table link_opens enable row level security;
create policy link_opens_read on link_opens for select to isaac_app
  using (exists (select 1 from clients c where c.id = client_id));
grant select on link_opens to isaac_app;
