-- Stream 3 trust (docs/AUTOMATION-AUDIT.md S2-12): "the merchant got a backdoor call" keeps a report with the
-- exposure snapshot of that moment (who touched the file, which lenders had it). The per-lender score is reports
-- per hundred files sent (src/lib/trust/queries.ts backdoorScores). One report per merchant per day: opening the
-- panel twice is one report, not two.

create table backdoor_reports (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients (id) on delete cascade,
  reported_by uuid references app_users (id) on delete set null,
  reported_on date not null default current_date,
  note text not null default '',
  exposure jsonb not null default '{}'::jsonb,
  -- the lenders the file had been sent to when the call came: the score is counted against each of them
  lender_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (client_id, reported_on)
);
create index backdoor_reports_client_idx on backdoor_reports (client_id, reported_on desc);
grant select, insert, update on backdoor_reports to isaac_app;
alter table backdoor_reports enable row level security;
create policy backdoor_reports_manager on backdoor_reports for all to isaac_app
  using (app.can_see_all()) with check (app.can_see_all());
